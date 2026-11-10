import { createKudo, networks, type Kudo } from "@kudo-dev/sdk";
import { isAddress, parseAbiItem, parseEventLogs, recoverAddress, type Address, type Hex, type Log } from "viem";

import { createAlchemyRpc, type AlchemyRpc, type UpstreamFailure } from "./alchemy.js";
import { capKey, MemoryCapStore, type CapStore } from "./caps.js";
import { inspectPrepared, signedRequest, TRUSTED_DELEGATES } from "./prepared.js";
import { allowedTargets, checkCall, type SponsoredCall } from "./rules.js";
import { signTicket, verifyTicket, type Ticket } from "./token.js";

/** Robinhood Chain mainnet: the only chain the relay sponsors on. */
export const SPONSOR_CHAIN_ID = networks.robinhood.chain.id;

export interface SponsorOptions {
  /** From the Alchemy RPC URL. Without it (or the policy id or secret) the relay is not configured. */
  alchemyApiKey?: string;
  /** The Gas Manager policy that pays. */
  policyId?: string;
  /** HMAC key for the stateless prepare→send id. Use 32+ random bytes. */
  secret?: string;
  /** For the ownership reads. Default: Robinhood mainnet on `rpcUrl`, or the public RPC. */
  kudo?: Kudo;
  rpcUrl?: string;
  /** Sponsored sends per sender per UTC day, counted at /send. Default 20. */
  dailyCap?: number;
  /** Requests per minute per client IP, on every endpoint. Default 60; 0 disables. */
  rateLimitPerMinute?: number;
  /** Origins allowed to call from a browser. Default "*". */
  allowedOrigins?: string[];
  /** Where the daily cap is counted. Default in memory (per process). */
  capStore?: CapStore;
  /** Mount point. Default "/sponsor". */
  basePath?: string;
  /** How long a prepared id stays valid. Default 5 minutes. */
  ticketTtlMs?: number;
  /** For tests: Alchemy's fetch, its base URL, the per-request timeout and the clock. */
  fetch?: typeof fetch;
  alchemyBaseUrl?: string;
  upstreamTimeoutMs?: number;
  now?: () => number;
}

export type SponsorHandler = (request: Request, clientIp?: string) => Promise<Response>;

const MAX_BODY = 256 * 1024;
const HEX = /^0x([0-9a-fA-F]{2})*$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const CALL_ID = /^[0-9A-Za-z_:-]{1,1024}$/;

const USER_OPERATION_EVENT = parseAbiItem(
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
);

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly reason?: string,
  ) {
    super(reason ?? error);
  }
}

/**
 * The relay as a web-standard handler: `POST {base}/prepare`, `POST
 * {base}/send`, `GET {base}/status/:callId`, `GET {base}/health`. Mount it in
 * Node (see `serveSponsor`), a Next.js or Vercel route, or a Worker.
 *
 * The relay holds the Alchemy key and policy and never sees an agent's key:
 * the agent signs the hashes /prepare returns and posts the signatures to
 * /send. Every rule is checked at both steps.
 */
export function createSponsorHandler(options: SponsorOptions = {}): SponsorHandler {
  const kudo = options.kudo ?? createKudo({ rpcUrl: options.rpcUrl });
  const now = options.now ?? Date.now;
  const base = (options.basePath ?? "/sponsor").replace(/\/+$/, "");
  const ttl = options.ticketTtlMs ?? 5 * 60_000;
  const dailyCap = options.dailyCap ?? 20;
  const limit = options.rateLimitPerMinute ?? 60;
  const origins = options.allowedOrigins ?? ["*"];
  const caps = options.capStore ?? new MemoryCapStore();
  const hits = new Map<string, { count: number; reset: number }>();

  const configured = !!(options.alchemyApiKey && options.policyId && options.secret);
  const rpc: AlchemyRpc | undefined = configured
    ? createAlchemyRpc({ apiKey: options.alchemyApiKey!, baseUrl: options.alchemyBaseUrl, fetch: options.fetch, timeoutMs: options.upstreamTimeoutMs })
    : undefined;
  // Sent on both prepare and send: on Robinhood Chain the policy pays as a
  // bundler sponsorship, and the bundler rejects the send without it.
  const capabilities = { paymasterService: { policyId: options.policyId } };
  const chainHex = `0x${SPONSOR_CHAIN_ID.toString(16)}`;

  const cors = (request: Request): Record<string, string> => {
    const origin = request.headers.get("origin") ?? "";
    const allow = origins.includes("*") ? "*" : origins.includes(origin) ? origin : "";
    return allow
      ? { "access-control-allow-origin": allow, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" }
      : {};
  };

  const readJson = async (request: Request): Promise<Record<string, unknown>> => {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new HttpError(400, "invalid", "body too large");
    try {
      const body = JSON.parse(text);
      if (body && typeof body === "object" && !Array.isArray(body)) return body;
    } catch {
      // fall through
    }
    throw new HttpError(400, "invalid", "body must be a JSON object");
  };

  const upstreamError = (failure: UpstreamFailure, where: "prepare" | "send" | "status"): HttpError => {
    if (failure.kind === "unknown") {
      return new HttpError(504, "unknown", `${failure.reason}. The call may have been sent: check /status or the chain before doing anything else, and never resend it as a plain transaction.`);
    }
    if (failure.kind === "rejected") return new HttpError(502, "upstream_rejected", `${failure.reason}${where === "status" ? "" : "; nothing was sent"}`);
    return new HttpError(502, "upstream_unavailable", `${failure.reason}${where === "status" ? "" : "; nothing was sent"}`);
  };

  const enforce = async (from: Address, call: SponsoredCall) => {
    const rule = await checkCall(kudo, from, call);
    if (!rule.ok) throw new HttpError(rule.status, rule.error, rule.reason);
  };

  const requireConfigured = () => {
    if (!rpc) throw new HttpError(503, "not_configured", "the relay has no Alchemy key, policy or secret; nothing was sent");
    return rpc;
  };

  async function prepare(request: Request) {
    const alchemy = requireConfigured();
    const body = await readJson(request);
    if (body.chainId !== SPONSOR_CHAIN_ID) throw new HttpError(400, "invalid", `chainId must be ${SPONSOR_CHAIN_ID}`);
    const from = body.from;
    if (typeof from !== "string" || !isAddress(from, { strict: false })) throw new HttpError(400, "invalid", "from must be an address");
    const raw = body.call as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object" || typeof raw.to !== "string" || !isAddress(raw.to, { strict: false })) {
      throw new HttpError(400, "invalid", "call.to must be an address");
    }
    if (typeof raw.data !== "string" || !HEX.test(raw.data) || raw.data.length < 10) throw new HttpError(400, "invalid", "call.data must be 0x-prefixed calldata");
    if (raw.value !== undefined && raw.value !== 0 && raw.value !== "0" && raw.value !== "0x0") {
      throw new HttpError(400, "invalid", "sponsored calls carry no value");
    }
    const call: SponsoredCall = { to: raw.to as Address, data: raw.data as Hex };

    await enforce(from as Address, call);

    const prepared = await alchemy<unknown>("wallet_prepareCalls", [{ calls: [call], from, chainId: chainHex, capabilities }]);
    if (!prepared.ok) throw upstreamError(prepared, "prepare");
    const inspected = inspectPrepared(prepared.result, from as Address, call, SPONSOR_CHAIN_ID);
    if (!inspected.ok) {
      throw new HttpError(inspected.error === "not_allowed" ? 403 : 502, inspected.error, `${inspected.reason}; nothing was sent`);
    }

    const expiresAt = now() + ttl;
    const ticket: Ticket = { v: 1, from: from as Address, call, prepared: prepared.result, expiresAt };
    return Response.json({ id: signTicket(ticket, options.secret!), expiresAt: new Date(expiresAt).toISOString(), call, toSign: inspected.toSign });
  }

  async function send(request: Request) {
    const alchemy = requireConfigured();
    const body = await readJson(request);
    const ticket = verifyTicket(body.id, options.secret!);
    if (!ticket) throw new HttpError(400, "invalid", "id is not one this relay issued, or was changed");
    if (now() > ticket.expiresAt) throw new HttpError(410, "expired", "the prepared call expired; prepare it again");

    const signatures = body.signatures as Record<string, unknown> | undefined;
    if (!signatures || typeof signatures !== "object") throw new HttpError(400, "invalid", "signatures is required");

    // Everything below comes from the signed ticket; the client only adds signatures.
    const { from, call } = ticket;
    await enforce(from, call);
    const inspected = inspectPrepared(ticket.prepared, from, call, SPONSOR_CHAIN_ID);
    if (!inspected.ok) throw new HttpError(inspected.error === "not_allowed" ? 403 : 502, inspected.error, inspected.reason);

    const sigs: { authorization?: Hex; userOperation: Hex } = { userOperation: "0x" };
    for (const item of inspected.toSign) {
      const signature = signatures[item.kind];
      if (typeof signature !== "string" || !SIGNATURE.test(signature)) {
        throw new HttpError(400, "invalid", `signatures.${item.kind} must be a 65-byte hex signature`);
      }
      let signer: Address | undefined;
      try {
        signer = await recoverAddress({ hash: item.hash, signature: signature as Hex });
      } catch {
        signer = undefined;
      }
      if (signer?.toLowerCase() !== from.toLowerCase()) {
        throw new HttpError(400, "bad_signature", `signatures.${item.kind} was not made by ${from} over ${item.hash}`);
      }
      sigs[item.kind] = signature as Hex;
    }
    if (signatures.authorization !== undefined && !inspected.split.authorization) {
      throw new HttpError(400, "invalid", "this call needs no authorization signature");
    }

    // Counted here, not at prepare, so preparing in someone else's name costs them nothing.
    const key = capKey(from, now());
    if (!(await caps.take(key, dailyCap))) throw new HttpError(429, "cap_reached", `${from} has used its ${dailyCap} sponsored sends for today (UTC)`);

    const sent = await alchemy<{ id?: string; preparedCallIds?: string[] }>(
      "wallet_sendPreparedCalls",
      [{ ...signedRequest(inspected.split, sigs), capabilities }],
      { mayHaveSent: true },
    );
    if (!sent.ok) {
      if (sent.kind !== "unknown") await caps.release(key);
      throw upstreamError(sent, "send");
    }
    const callId = sent.result.id ?? sent.result.preparedCallIds?.[0];
    if (!callId) throw new HttpError(504, "unknown", "Alchemy accepted the call but returned no call id. It may have been sent: check the chain before doing anything else.");
    return Response.json({ callId });
  }

  async function status(callId: string) {
    const alchemy = requireConfigured();
    if (!CALL_ID.test(callId)) throw new HttpError(400, "invalid", "not a call id");
    const result = await alchemy<{ status?: number | string; receipts?: { status?: unknown; transactionHash?: Hex; logs?: unknown[] }[] }>(
      "wallet_getCallsStatus",
      [callId],
    );
    if (!result.ok) throw upstreamError(result, "status");
    const code = Number(result.result.status);
    const receipt = result.result.receipts?.[0];
    const landed = !!receipt && (receipt.status === "0x1" || receipt.status === 1 || receipt.status === "success");

    // EIP-5792: 1xx pending, 200 confirmed, 4xx off-chain failure, 5xx reverted, 600 partially reverted.
    let state: "pending" | "success" | "failed";
    if (code < 200 && !receipt) state = "pending";
    else if (landed) state = "success";
    else state = "failed";

    // A bundle can land with receipt status 1 while the call inside reverted:
    // the EntryPoint's UserOperationEvent says whether the call itself worked.
    let callSucceeded = state === "success" && code === 200;
    if (callSucceeded && Array.isArray(receipt?.logs)) {
      const events = parseEventLogs({ abi: [USER_OPERATION_EVENT], logs: receipt.logs as Log[], strict: false });
      if (events.some((e) => e.args.success === false)) callSucceeded = false;
    }
    return Response.json({ status: state, ...(receipt?.transactionHash ? { transactionHash: receipt.transactionHash } : {}), callSucceeded });
  }

  function health() {
    return Response.json({
      chainId: SPONSOR_CHAIN_ID,
      configured,
      allowed: allowedTargets(kudo.network).map((t) => ({ contract: t.contract, name: t.name, functions: t.functions })),
      trustedDelegates: TRUSTED_DELEGATES,
    });
  }

  return async (request, clientIp = "unknown") => {
    const headers = cors(request);
    const reply = (response: Response) => {
      for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
      return response;
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    if (limit > 0) {
      const t = now();
      const entry = hits.get(clientIp);
      if (!entry || entry.reset < t) hits.set(clientIp, { count: 1, reset: t + 60_000 });
      else if (++entry.count > limit) {
        return reply(Response.json({ error: "rate_limited", reason: "too many requests from this address; try again in a minute" }, { status: 429, headers: { "retry-after": "60" } }));
      }
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    try {
      if (request.method === "POST" && path === `${base}/prepare`) return reply(await prepare(request));
      if (request.method === "POST" && path === `${base}/send`) return reply(await send(request));
      if (request.method === "GET" && path.startsWith(`${base}/status/`)) {
        return reply(await status(decodeURIComponent(path.slice(base.length + "/status/".length))));
      }
      if (request.method === "GET" && (path === `${base}/health` || path === base)) return reply(health());
      return reply(Response.json({ error: "not_found", reason: `the relay serves ${base}/prepare, /send, /status/:callId and /health` }, { status: 404 }));
    } catch (error) {
      if (error instanceof HttpError) return reply(Response.json({ error: error.error, ...(error.reason ? { reason: error.reason } : {}) }, { status: error.status }));
      // Never echo an unexpected error: it could carry a URL with the key.
      return reply(Response.json({ error: "internal", reason: "unexpected relay error" }, { status: 500 }));
    }
  };
}
