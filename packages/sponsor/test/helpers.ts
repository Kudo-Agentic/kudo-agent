import { createKudo, identityRegistryAbi, kudoAbi, networks } from "@kudo-dev/sdk";
import { ContractFunctionRevertedError, encodeFunctionData, keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashAuthorization } from "viem/utils";

import { createSponsorHandler, MemoryCapStore, type SponsorOptions } from "../src/index.js";

export const net = networks.robinhood;
export const KEY = "alchemy-test-key-DO-NOT-LEAK";
export const POLICY = "policy-test-id-DO-NOT-LEAK";
export const SECRET = "sponsor-test-secret-0123456789abcdef-DO-NOT-LEAK";
export const DELEGATE = "0x69007702764179f14f51cdce752f4f775d74e139";

export const agent = privateKeyToAccount(generatePrivateKey());
export const stranger = privateKeyToAccount(generatePrivateKey());

/** On-chain state the fake RPC answers from. */
export interface ChainState {
  identities: Map<string, bigint>; // owner (lowercase) -> balance
  owners: Map<bigint, Address>; // agentId -> owner
  rpcDown?: boolean;
}

export function fakeKudo(state: ChainState) {
  const publicClient = {
    async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
      if (state.rpcDown) throw new Error("connect ECONNREFUSED");
      if (functionName === "balanceOf") return state.identities.get(String(args[0]).toLowerCase()) ?? 0n;
      if (functionName === "ownerOf") {
        const owner = state.owners.get(args[0] as bigint);
        if (!owner) throw new ContractFunctionRevertedError({ abi: identityRegistryAbi, functionName: "ownerOf" });
        return owner;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  } as unknown as PublicClient;
  return createKudo({ publicClient });
}

export type SendBehaviour = "ok" | "throw" | "http500" | "rpcError" | "timeout";

export interface AlchemyState {
  delegated: Set<string>; // senders that already have the 7702 delegation
  sponsored: boolean;
  delegate: string;
  send: SendBehaviour;
  calls: { method: string; params: unknown[]; url: string }[];
  status?: unknown;
}

let n = 0;

/** A fetch that plays Alchemy's Wallet API, shaped like the real responses sponsored-send.mjs handles. */
export function fakeAlchemy(state: AlchemyState): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    state.calls.push({ method, params, url: String(url) });
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });

    if (method === "wallet_prepareCalls") {
      const { from, calls, chainId } = params[0];
      const op = {
        type: "user-operation-v070",
        chainId,
        data: { sender: from, callData: "0xdeadbeef" },
        signatureRequest: { type: "personal_sign", rawPayload: keccak256(toHex(`op-${n++}`)) },
        feePayment: { sponsored: state.sponsored, tokenAddress: "0x0000000000000000000000000000000000000000", maxAmount: "0x0" },
        details: { type: "user-operation", data: { calls } },
      };
      if (state.delegated.has(from.toLowerCase())) return ok(op);
      const auth = {
        type: "authorization",
        chainId,
        data: { address: state.delegate, nonce: "0x0" },
        signatureRequest: {
          type: "eip7702Auth",
          rawPayload: hashAuthorization({ contractAddress: state.delegate as Address, chainId: Number(chainId), nonce: 0 }),
        },
      };
      return ok({ type: "array", data: [auth, op] });
    }
    if (method === "wallet_sendPreparedCalls") {
      if (state.send === "throw") throw new TypeError("fetch failed: socket hang up");
      if (state.send === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      if (state.send === "http500") return new Response("upstream error", { status: 500 });
      if (state.send === "rpcError") return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid signature" } });
      return ok({ preparedCallIds: [`0x${"ab".repeat(32)}`] });
    }
    if (method === "wallet_getCallsStatus") return ok(state.status);
    throw new Error(`unexpected method ${method}`);
  }) as typeof fetch;
}

export function setup(overrides: Partial<SponsorOptions> = {}, alchemy: Partial<AlchemyState> = {}, chain: Partial<ChainState> = {}) {
  const chainState: ChainState = {
    identities: new Map([[agent.address.toLowerCase(), 1n]]),
    owners: new Map([[7n, agent.address]]),
    ...chain,
  };
  const alchemyState: AlchemyState = { delegated: new Set(), sponsored: true, delegate: DELEGATE, send: "ok", calls: [], ...alchemy };
  let clock = Date.UTC(2026, 10, 10, 12);
  const caps = new MemoryCapStore();
  const handle = createSponsorHandler({
    alchemyApiKey: KEY,
    policyId: POLICY,
    secret: SECRET,
    kudo: fakeKudo(chainState),
    fetch: fakeAlchemy(alchemyState),
    capStore: caps,
    rateLimitPerMinute: 0,
    now: () => clock,
    ...overrides,
  });
  const post = (path: string, body: unknown, ip = "1.1.1.1") =>
    handle(new Request(`https://relay.test/sponsor/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), ip);
  const get = (path: string, ip = "1.1.1.1") => handle(new Request(`https://relay.test/sponsor/${path}`), ip);
  return {
    handle,
    post,
    get,
    chain: chainState,
    alchemy: alchemyState,
    caps,
    advance: (ms: number) => (clock += ms),
  };
}

export const mintCall = (agentId: bigint) => ({
  to: net.kudo,
  data: encodeFunctionData({ abi: kudoAbi, functionName: "mintCovenant", args: [agentId, "I'll pay 5 USDG within one hour.", "Write an explainer.", "INVOICE"] }),
});

export const registerCall = () => ({
  to: net.identityRegistry,
  data: encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: ["", []] }),
});

export const prepareBody = (from: Address, call: { to: Address; data: Hex }) => ({ chainId: 4663, from, call });

type Prepared = { id: string; toSign: { kind: "authorization" | "userOperation"; hash: Hex }[] };

/** Signs every hash /prepare returned, as an agent would. */
export async function signAll(prepared: Prepared, signer = agent) {
  const signatures: Record<string, Hex> = {};
  for (const item of prepared.toSign) signatures[item.kind] = await signer.sign({ hash: item.hash });
  return { id: prepared.id, signatures };
}
