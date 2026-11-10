import { hashAuthorization } from "viem/utils";
import type { Address, Hex } from "viem";

import type { SponsoredCall } from "./rules.js";

/**
 * The only 7702 delegates Alchemy's Wallet API uses (Modular Account v2,
 * SemiModularAccount7702). A delegation hands the agent's address to that
 * contract's code, so the relay refuses to pass on anything else to sign, and
 * the client must check again before it signs.
 */
export const TRUSTED_DELEGATES = [
  "0x69007702764179f14f51cdce752f4f775d74e139", // v1.0.0
  "0x77021100bd87b7008e5e1989d0eb38555d0d0000", // v1.1.0
] as const;

/** What the agent signs, each a raw 32-byte hash (no EIP-191 prefix). */
export type ToSign =
  | { kind: "authorization"; delegate: Address; chainId: number; nonce: number; hash: Hex }
  | { kind: "userOperation"; hash: Hex };

interface PreparedItem {
  type?: string;
  chainId?: string | number;
  data?: { address?: string; nonce?: string | number; sender?: string } & Record<string, unknown>;
  signatureRequest?: { rawPayload?: string } & Record<string, unknown>;
  feePayment?: { sponsored?: boolean } & Record<string, unknown>;
  details?: { data?: { calls?: { to?: string; data?: string }[] } };
  [key: string]: unknown;
}

interface Split {
  authorization?: PreparedItem;
  userOperation: PreparedItem;
  /** The items of a type "array" result, in Alchemy's order; undefined for a single user operation. */
  order?: PreparedItem[];
}

export type Inspected =
  | { ok: true; toSign: ToSign[]; split: Split }
  | { ok: false; error: "not_allowed" | "upstream_invalid"; reason: string };

const HASH = /^0x[0-9a-fA-F]{64}$/;

function split(prepared: unknown): Split | string {
  const p = prepared as { type?: string; data?: PreparedItem[] } & PreparedItem;
  if (p?.type === "array" && Array.isArray(p.data)) {
    const auths = p.data.filter((i) => i?.type === "authorization");
    const ops = p.data.filter((i) => typeof i?.type === "string" && i.type.startsWith("user-operation"));
    if (ops.length !== 1 || auths.length > 1 || auths.length + ops.length !== p.data.length) {
      return "expected one user operation and at most one authorization";
    }
    return { authorization: auths[0], userOperation: ops[0]!, order: p.data };
  }
  if (typeof p?.type === "string" && p.type.startsWith("user-operation")) return { userOperation: p };
  return `unexpected prepared call type ${String(p?.type)}`;
}

/**
 * Checks a wallet_prepareCalls result before anything is signed: it carries
 * exactly our call from our sender, the policy pays for it, and any 7702
 * authorization is to a trusted delegate on this chain with the hash we
 * compute ourselves. Run at prepare and again at send.
 */
export function inspectPrepared(prepared: unknown, from: Address, call: SponsoredCall, chainId: number): Inspected {
  const parts = split(prepared);
  if (typeof parts === "string") return { ok: false, error: "upstream_invalid", reason: parts };
  const { authorization, userOperation } = parts;
  const toSign: ToSign[] = [];

  if (authorization) {
    const delegate = String(authorization.data?.address ?? "").toLowerCase() as Address;
    if (!(TRUSTED_DELEGATES as readonly string[]).includes(delegate)) {
      return { ok: false, error: "upstream_invalid", reason: `authorization delegates to ${delegate || "nothing"}, not a trusted delegate` };
    }
    // Exactly this chain: an authorization for chain 0 would be valid on every chain.
    const authChain = Number(authorization.chainId);
    if (authChain !== chainId) return { ok: false, error: "upstream_invalid", reason: `authorization is for chain ${authChain}, not ${chainId}` };
    const nonce = Number(authorization.data?.nonce);
    if (!Number.isSafeInteger(nonce) || nonce < 0) return { ok: false, error: "upstream_invalid", reason: "authorization has no valid nonce" };
    const hash = hashAuthorization({ contractAddress: delegate, chainId, nonce });
    if (String(authorization.signatureRequest?.rawPayload ?? "").toLowerCase() !== hash.toLowerCase()) {
      return { ok: false, error: "upstream_invalid", reason: "authorization payload does not match the hash computed locally" };
    }
    toSign.push({ kind: "authorization", delegate, chainId, nonce, hash });
  }

  if (Number(userOperation.chainId ?? chainId) !== chainId) {
    return { ok: false, error: "upstream_invalid", reason: "user operation is for another chain" };
  }
  const sender = userOperation.data?.sender;
  if (sender !== undefined && String(sender).toLowerCase() !== from.toLowerCase()) {
    return { ok: false, error: "upstream_invalid", reason: "user operation is not from the requested sender" };
  }
  const calls = userOperation.details?.data?.calls;
  if (
    calls &&
    !(calls.length === 1 &&
      String(calls[0]?.to ?? "").toLowerCase() === call.to.toLowerCase() &&
      String(calls[0]?.data ?? "0x").toLowerCase() === call.data.toLowerCase())
  ) {
    return { ok: false, error: "upstream_invalid", reason: "prepared user operation does not carry the requested call" };
  }
  const raw = userOperation.signatureRequest?.rawPayload;
  if (typeof raw !== "string" || !HASH.test(raw)) return { ok: false, error: "upstream_invalid", reason: "user operation has no 32-byte hash to sign" };
  if (userOperation.feePayment?.sponsored !== true) {
    return { ok: false, error: "not_allowed", reason: "the gas policy did not sponsor this call" };
  }
  toSign.push({ kind: "userOperation", hash: raw as Hex });
  return { ok: true, toSign, split: parts };
}

const secp = (data: Hex) => ({ type: "secp256k1", data });

/** The wallet_sendPreparedCalls request body for these signatures, without capabilities. */
export function signedRequest(parts: Split, signatures: { authorization?: Hex; userOperation: Hex }): Record<string, unknown> {
  const { signatureRequest: _op, feePayment: _fee, ...op } = parts.userOperation;
  const signedOp = { ...op, signature: secp(signatures.userOperation) };
  if (!parts.order) return signedOp;
  const data = parts.order.map((item) => {
    if (item !== parts.authorization) return signedOp;
    const { signatureRequest: _auth, ...auth } = item;
    return { ...auth, signature: secp(signatures.authorization!) };
  });
  return { type: "array", data };
}
