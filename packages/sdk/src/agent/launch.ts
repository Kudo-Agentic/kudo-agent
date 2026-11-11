/**
 * A launched agent: one someone started from app.kudo.archi on their own Phala
 * account. It registers its own ERC-8004 identity, hands the NFT to the person
 * who launched it, and waits for them to link its wallet back.
 *
 *   OWNER_ADDRESS        who launched it, and who ends up owning the identity.
 *                        Setting it is what makes this a launched agent.
 *   LAUNCH_FROM_BLOCK    the block it was launched at, so finding its own
 *                        registration after a restart is one log query, not a
 *                        walk back to genesis. Optional.
 *   AGENT_NAME, AGENT_DESCRIPTION, AGENT_ENDPOINT   what goes on the identity.
 *
 * The order is forced by the registry:
 *   - register() can only mint to the caller, so the agent mints to itself;
 *   - setMetadata is owner-only, so everything goes in at register time;
 *   - a transfer clears agentWallet, and only the new owner may set it again,
 *     with a signature from the wallet (GET /wallet-link serves that).
 *
 *   booting → registering → transferring → awaiting_link → ready
 *                  ↘ needs_gas (the sponsor refused and there is no ETH)
 *
 * Every step re-reads the chain first, so a restart picks up where the last
 * run stopped and never registers twice.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  isAddress,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { identityRegistryAbi } from "../abi/registries.js";
import { findRegistrationBy } from "../client.js";
import { networks } from "../networks.js";
import { redact } from "./log.js";

export type LaunchStage =
  | "booting"
  | "registering"
  | "needs_gas"
  | "transferring"
  | "awaiting_link"
  | "ready"
  | "error";

export interface LaunchState {
  stage: LaunchStage;
  /** The agent's own address, the one it asks to be linked as agentWallet. */
  wallet: Address;
  /** OWNER_ADDRESS: who the identity goes to. */
  owner: Address;
  agentId: string | null;
  /** True once getAgentWallet(agentId) is this wallet. */
  linked: boolean;
  /** The last thing that went wrong, if the current step is retrying. */
  error: string | null;
}

/** What GET /wallet-link returns: the arguments of setAgentWallet, ready to send. */
export interface WalletLink {
  agentId: string;
  newWallet: Address;
  owner: Address;
  deadline: string;
  signature: Hex;
}

/** A refusal GET /wallet-link reports with its own status. */
export class LinkRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

class NeedsGas extends Error {}

/** The registry rejects a deadline more than 5 minutes out; leave room for the user to confirm. */
const LINK_DEADLINE_SECONDS = 240n;
const POLL_MS = 5_000;
const RETRY_MS = 15_000;
/** After a send whose outcome is unknown, how long to wait for it to show up before sending again. */
const UNKNOWN_SEND_GRACE_MS = 180_000;

let state: LaunchState | undefined;
let context: { account: PrivateKeyAccount; client: PublicClient; registry: Address } | undefined;

/** True when OWNER_ADDRESS is set: this agent hands its identity to someone. */
export function isLaunched(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OWNER_ADDRESS?.trim());
}

/** The current state, or undefined for an agent that was not launched. */
export function launchState(): LaunchState | undefined {
  return state && { ...state };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** viem errors run to dozens of lines (calldata included); the first line of shortMessage says it. */
const message = (error: unknown) => {
  const text = (error as { shortMessage?: string })?.shortMessage ?? (error instanceof Error ? error.message : String(error));
  return redact(text.split("\n")[0]!.trim());
};
const isInsufficientFunds = (error: unknown) =>
  /insufficient funds|exceeds the balance/i.test(`${(error as { shortMessage?: string })?.shortMessage ?? ""} ${error instanceof Error ? error.message : ""}`);

function setStage(stage: LaunchStage, error: string | null = null): void {
  if (!state) return;
  if (state.stage !== stage) console.log(`launch: ${stage}${error ? ` (${error})` : ""}`);
  state.stage = stage;
  state.error = error;
}

/** The ERC-8004 registration file, inline as a data: URI so it needs no host. */
export function registrationUri(env: NodeJS.ProcessEnv = process.env): string {
  const endpoint = env.AGENT_ENDPOINT?.trim();
  const file = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: env.AGENT_NAME?.trim(),
    description: env.AGENT_DESCRIPTION?.trim() || "",
    ...(endpoint ? { endpoints: [{ name: "kudo", endpoint }] } : {}),
    ...(env.TEE_ID?.trim() ? { supportedTrust: ["tee-attestation"] } : {}),
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(file)).toString("base64")}`;
}

function registerCalldata(env: NodeJS.ProcessEnv): Hex {
  const metadata = Object.entries({
    name: env.AGENT_NAME?.trim(),
    teeId: env.TEE_ID?.trim(),
    endpoint: env.AGENT_ENDPOINT?.trim(),
  })
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([metadataKey, value]) => ({ metadataKey, metadataValue: stringToHex(value) }));
  return encodeFunctionData({
    abi: identityRegistryAbi,
    functionName: "register",
    args: [registrationUri(env), metadata],
  });
}

type SendOutcome = "sent" | "unknown";

/**
 * One call from the agent's own address: through the gas sponsor first (the
 * same script every other write uses), else a plain transaction if the agent
 * has the ETH for it.
 */
async function send(to: Address, data: Hex, env: NodeJS.ProcessEnv): Promise<SendOutcome> {
  const script = env.KUDO_SPONSORED_SEND;
  if (script && existsSync(script) && env.KUDO_SPONSOR_URL?.trim().toLowerCase() !== "off") {
    const code = await new Promise<number>((resolve) => {
      execFile(process.execPath, [script, to, data], { env }, (error, stdout, stderr) => {
        const exitCode = error ? Number((error as { code?: unknown }).code ?? 1) : 0;
        const output = redact(`${stdout}${stderr}`).trim();
        if (output) console.log(`launch: ${output.split("\n").at(-1)}`);
        resolve(Number.isFinite(exitCode) ? exitCode : 1);
      });
    });
    if (code === 0) return "sent";
    if (code === 1) throw new Error("the sponsored transaction reverted");
    if (code === 3) return "unknown";
    // 2: nothing was sent, so paying our own gas is safe.
  }

  const { account, client } = context!;
  const wallet = createWalletClient({ account, chain: networks.robinhood.chain, transport: http(env.RPC_URL!.trim()) });
  const needsGas = new NeedsGas(`needs gas: send a little ETH to ${account.address}`);
  // What the send will actually reserve is gas × maxFeePerGas, not the current
  // gas price: checking against the price passes and then the send fails.
  const [gas, fees, balance] = await Promise.all([
    client.estimateGas({ account, to, data }),
    client.estimateFeesPerGas(),
    client.getBalance({ address: account.address }),
  ]);
  if (balance < gas * fees.maxFeePerGas) throw needsGas;
  let hash: Hex;
  try {
    hash = await wallet.sendTransaction({ account, to, data, gas, ...fees, chain: networks.robinhood.chain });
  } catch (error) {
    if (isInsufficientFunds(error)) throw needsGas;
    throw error;
  }
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return "sent";
}

/**
 * Registers, hands over and waits for the link. Resolves with the agent id once
 * the owner has linked this wallet; sets AGENT_ID along the way.
 */
export async function runLaunch(env: NodeJS.ProcessEnv = process.env): Promise<bigint> {
  const owner = env.OWNER_ADDRESS!.trim();
  if (!isAddress(owner)) {
    console.error(`OWNER_ADDRESS is not an address: "${owner}"`);
    process.exit(1);
  }
  if (!env.AGENT_NAME?.trim()) {
    console.error("A launched agent needs AGENT_NAME: it is the name on its ERC-8004 identity.");
    process.exit(1);
  }

  const account = privateKeyToAccount(env.PRIVATE_KEY!.trim() as Hex);
  const client = createPublicClient({ chain: networks.robinhood.chain, transport: http(env.RPC_URL!.trim()) }) as PublicClient;
  const registry = env.IDENTITY_REGISTRY!.trim() as Address;
  const fromBlock = /^\d+$/.test(env.LAUNCH_FROM_BLOCK?.trim() ?? "") ? BigInt(env.LAUNCH_FROM_BLOCK!.trim()) : 0n;
  context = { account, client, registry };
  state = { stage: "booting", wallet: account.address, owner: owner as Address, agentId: null, linked: false, error: null };
  console.log(`launch: agent wallet ${account.address}, owner ${owner}`);

  let unknownSendUntil = 0;
  /** Sends one step's call. Shown as `stage`, except that needs_gas stays up until a send goes through. */
  const sendStep = async (stage: LaunchStage, data: Hex) => {
    if (state!.stage !== "needs_gas") setStage(stage);
    if (Date.now() < unknownSendUntil) return; // an earlier send may still land
    if ((await send(registry, data, env)) === "unknown") unknownSendUntil = Date.now() + UNKNOWN_SEND_GRACE_MS;
    setStage(stage);
  };

  for (;;) {
    try {
      const id =
        state.agentId !== null
          ? BigInt(state.agentId)
          : await findRegistrationBy(client, registry, account.address, networks.robinhood.maxLogRange, fromBlock);

      if (id === undefined) {
        await sendStep("registering", registerCalldata(env));
        continue;
      }
      if (state.agentId === null) console.log(`launch: AGENT_ID ${id}`);
      state.agentId = id.toString();
      env.AGENT_ID = state.agentId;
      unknownSendUntil = 0;

      const holder = await client.readContract({ address: registry, abi: identityRegistryAbi, functionName: "ownerOf", args: [id] });
      if (same(holder, account.address)) {
        await sendStep(
          "transferring",
          encodeFunctionData({ abi: identityRegistryAbi, functionName: "transferFrom", args: [account.address, owner as Address, id] }),
        );
        continue;
      }
      if (!same(holder, owner)) {
        // Someone moved it on. Linking is now the new holder's call, not ours.
        setStage("error", `identity ${id} is owned by ${holder}, not OWNER_ADDRESS ${owner}`);
        await sleep(RETRY_MS * 4);
        continue;
      }

      const agentWallet = await client.readContract({ address: registry, abi: identityRegistryAbi, functionName: "getAgentWallet", args: [id] });
      if (same(agentWallet, account.address)) {
        state.linked = true;
        setStage("ready");
        return id;
      }
      setStage("awaiting_link");
      await sleep(POLL_MS);
    } catch (error) {
      if (error instanceof NeedsGas) setStage("needs_gas", error.message);
      else {
        state.error = message(error);
        console.error(`launch: ${state.stage} failed, retrying: ${state.error}`);
      }
      await sleep(RETRY_MS);
    }
  }
}

/**
 * The owner's consent to link this wallet, signed by it: the arguments of
 * setAgentWallet. Only for OWNER_ADDRESS, and only once they hold the identity.
 * The deadline comes from the chain's clock, not ours.
 */
export async function walletLink(): Promise<WalletLink> {
  if (!state || !context) throw new LinkRefused(404, "This agent was not launched with an owner.");
  if (state.agentId === null) throw new LinkRefused(409, `Not registered yet (stage: ${state.stage}).`);
  if (state.linked) throw new LinkRefused(409, "Already linked.");

  const { account, client, registry } = context;
  const agentId = BigInt(state.agentId);
  const [holder, block] = await Promise.all([
    client.readContract({ address: registry, abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] }),
    client.getBlock(),
  ]);
  if (!same(holder, state.owner)) {
    throw new LinkRefused(409, `Identity ${agentId} is held by ${holder}, not ${state.owner}. It has not been handed over yet.`);
  }

  const deadline = block.timestamp + LINK_DEADLINE_SECONDS;
  const signature = await account.signTypedData({
    domain: { name: "ERC8004IdentityRegistry", version: "1", chainId: networks.robinhood.chain.id, verifyingContract: registry },
    types: {
      AgentWalletSet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "owner", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "AgentWalletSet",
    message: { agentId, newWallet: account.address, owner: holder, deadline },
  });
  return { agentId: agentId.toString(), newWallet: account.address, owner: holder, deadline: deadline.toString(), signature };
}

