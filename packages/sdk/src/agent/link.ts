/**
 * Being linked to an identity someone else registered.
 *
 * A developer can register their running agent from their own wallet (e.g.
 * app.kudo.archi/register) and then link the agent's key as the identity's
 * agentWallet, which is what lets it mint covenants and settle promises. The
 * registry takes that link only from the owner, with an EIP-712
 * AgentWalletSet signature from the agent's key, so the agent serves its
 * consent at GET /wallet-link and the owner sends it.
 *
 *   GET /wallet-link?agentId=<id>&owner=<address>
 *     -> { agentId, newWallet, owner, deadline, signature }
 *
 * It signs only when `owner` holds the identity now, and not while this agent
 * already acts for a different identity. After signing it watches for the
 * owner's transaction and adopts the id as AGENT_ID the moment it lands; after
 * a restart, agent-id.ts finds the link on chain.
 *
 *   KUDO_SELF_REGISTER=false   never register an identity of its own: run
 *                              nothing until an owner links this wallet.
 */
import { createPublicClient, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { identityRegistryAbi } from "../abi/registries.js";
import { networks } from "../networks.js";

/** The registry rejects a deadline more than 5 minutes out; leave the owner time to confirm. */
const LINK_DEADLINE_SECONDS = 240n;
const WATCH_EVERY_MS = 5_000;
const WATCH_FOR_MS = 10 * 60_000;

export interface WalletLink {
  agentId: string;
  newWallet: Address;
  owner: Address;
  deadline: string;
  signature: Hex;
}

/** A refusal GET /wallet-link reports with its own status. */
export class LinkRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A run refused because this agent waits to be linked and has no identity yet. */
export class NotLinkedYet extends Error {}

/** True when this agent should wait to be linked instead of registering itself. */
export function waitsToBeLinked(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KUDO_SELF_REGISTER?.trim().toLowerCase() === "false";
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function chain(env: NodeJS.ProcessEnv) {
  return {
    account: privateKeyToAccount(env.PRIVATE_KEY!.trim() as Hex),
    client: createPublicClient({ chain: networks.robinhood.chain, transport: http(env.RPC_URL!.trim()) }),
    registry: env.IDENTITY_REGISTRY!.trim() as Address,
  };
}

const watching = new Set<string>();

/** Polls until agentWallet(id) is this wallet, then sets AGENT_ID. Gives up after ten minutes. */
function watchForLink(id: bigint, env: NodeJS.ProcessEnv): void {
  const key = id.toString();
  if (watching.has(key)) return;
  watching.add(key);
  const { account, client, registry } = chain(env);
  const until = Date.now() + WATCH_FOR_MS;

  const tick = async (): Promise<void> => {
    try {
      const wallet = await client.readContract({ address: registry, abi: identityRegistryAbi, functionName: "getAgentWallet", args: [id] });
      if (same(wallet, account.address)) {
        env.AGENT_ID = key;
        console.log(`linked: AGENT_ID ${key}, its owner set this wallet as its agent wallet`);
        watching.delete(key);
        return;
      }
    } catch {
      // A missed read costs one tick.
    }
    if (Date.now() < until) setTimeout(() => void tick(), WATCH_EVERY_MS).unref();
    else watching.delete(key);
  };
  void tick();
}

/** This agent's signed consent to be linked to `agentId`, for `owner` to send. */
export async function signWalletLink(
  query: { agentId?: string | null; owner?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): Promise<WalletLink> {
  const idText = query.agentId?.trim() ?? "";
  const owner = query.owner?.trim() ?? "";
  if (!/^\d+$/.test(idText)) throw new LinkRefused(400, "agentId must be a number.");
  if (!isAddress(owner)) throw new LinkRefused(400, "owner must be an address.");
  const agentId = BigInt(idText);
  const { account, client, registry } = chain(env);
  const read = <T>(functionName: "ownerOf" | "getAgentWallet", id: bigint) =>
    client.readContract({ address: registry, abi: identityRegistryAbi, functionName, args: [id] }) as Promise<T>;

  // One identity per agent: refuse while it acts for another.
  const current = env.AGENT_ID?.trim();
  if (current && current !== idText) {
    const wallet = await read<Address>("getAgentWallet", BigInt(current)).catch(() => undefined);
    if (wallet && same(wallet, account.address)) {
      throw new LinkRefused(409, `This agent already acts for identity ${current}.`);
    }
  }

  let holder: Address;
  try {
    holder = await read<Address>("ownerOf", agentId);
  } catch {
    throw new LinkRefused(404, `There is no identity ${idText}.`);
  }
  if (!same(holder, owner)) throw new LinkRefused(409, `Identity ${idText} is held by ${holder}, not ${owner}.`);
  if (same(await read<Address>("getAgentWallet", agentId), account.address)) {
    watchForLink(agentId, env); // adopt it if this process has not yet
    throw new LinkRefused(409, `This wallet is already identity ${idText}'s agent wallet.`);
  }

  // The registry checks the deadline against block time, so take it from there.
  const { timestamp } = await client.getBlock();
  const deadline = timestamp + LINK_DEADLINE_SECONDS;
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

  watchForLink(agentId, env);
  return { agentId: idText, newWallet: account.address, owner: holder, deadline: deadline.toString(), signature };
}
