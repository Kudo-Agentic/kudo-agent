#!/usr/bin/env node
/**
 * Sends one contract call from this agent's own address with its gas paid by
 * Kudo's sponsorship relay, and says by its exit code whether falling back to
 * a plain `cast send` is safe.
 *
 *   node sponsored-send.mjs <to> <calldata>
 *   node sponsored-send.mjs $KUDO "$(cast calldata 'mintCovenant(uint256,string,string,string)' …)"
 *
 * Environment:
 *   PRIVATE_KEY        this agent's signing key (it never leaves this process)
 *   RPC_URL            Robinhood Chain RPC
 *   KUDO_SPONSOR_URL   the relay, e.g. https://…/sponsor. Unset: exit 2 at once.
 *
 * Exit codes — what to do next:
 *   0  sent and succeeded. Prints {"status":"success","transactionHash":"0x…"}.
 *   2  NOTHING WAS SENT (no relay configured, sponsorship ended or refused,
 *      relay unreachable). Safe to send the same call with plain `cast send`.
 *   1  sent, and the call failed on chain. Do not retry: a plain send would
 *      fail the same way. Read the error.
 *   3  sent, outcome unknown. NEVER resend. Read the chain (the covenant, the
 *      transfer) or check the printed callId's status first.
 *
 * The relay holds the Alchemy key; this script holds the agent's key. The
 * relay asks Alchemy to build the operation and passes back hashes; this
 * script checks them before signing anything:
 *   - a 7702 delegation may only name Alchemy's two published accounts
 *     (signing one hands this address's code to that contract),
 *   - the authorization's chain is this chain, and its hash is recomputed here,
 *   - the call the relay echoes is exactly the call requested.
 * Signing goes through `cast`, so this needs no npm dependency.
 */
import { execFileSync } from "node:child_process";

const TRUSTED_DELEGATES = new Set([
  "0x69007702764179f14f51cdce752f4f775d74e139", // Modular Account v2, v1.0.0
  "0x77021100bd87b7008e5e1989d0eb38555d0d0000", // Modular Account v2, v1.1.0
]);
const POLL_MS = 2000;
const TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 30_000;

const SENT_OK = 0;
const SENT_FAILED = 1;
const NOT_SENT = 2;
const SENT_UNKNOWN = 3;

// A failed `cast` call's error repeats its command line, key included.
const redact = (text) => {
  const key = process.env.PRIVATE_KEY?.trim();
  return key ? text.split(key).join("[PRIVATE_KEY]") : text;
};

function exit(code, message, extra) {
  const stream = code === SENT_OK ? process.stdout : process.stderr;
  stream.write(redact(`${message}\n`));
  if (extra !== undefined) process.stderr.write(redact(`${typeof extra === "string" ? extra : JSON.stringify(extra, null, 2)}\n`));
  process.exit(code);
}
const notSent = (reason, extra) => exit(NOT_SENT, `sponsored-send: not sent (${reason}) — safe to fall back to cast send`, extra);

// An unexpected error (a bad key, cast missing) must not report "sent": before
// /send is called nothing can have been sent, and after it, nothing is known.
let sendAttempted = false;
const crashed = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (!sendAttempted) notSent(`error before sending: ${message}`);
  exit(SENT_UNKNOWN, `sponsored-send: error after sending (${message}) — do NOT resend; read the chain first`);
};
process.on("uncaughtException", crashed);
process.on("unhandledRejection", crashed);

// --- input -------------------------------------------------------------------

const [to, data] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{40}$/.test(to ?? "")) notSent("first argument must be the target address");
if (!/^0x([0-9a-fA-F]{2})*$/.test(data ?? "")) notSent("second argument must be 0x-prefixed calldata");

const RELAY = process.env.KUDO_SPONSOR_URL?.trim().replace(/\/+$/, "");
if (!RELAY) notSent("KUDO_SPONSOR_URL is not set: gas is not sponsored here");
for (const name of ["PRIVATE_KEY", "RPC_URL"]) {
  if (!process.env[name]?.trim()) notSent(`${name} is not set`);
}

const cast = (args) =>
  execFileSync("cast", args, { encoding: "utf8", env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" } }).trim();
const castWithKey = (args) => cast([...args, "--private-key", process.env.PRIVATE_KEY]);

const from = castWithKey(["wallet", "address"]);
const chainId = Number(cast(["chain-id", "--rpc-url", process.env.RPC_URL]));

// --- relay requests ----------------------------------------------------------

/** One relay request. `{ ok, status, body }`, or `{ ok: false, network: true }` if it never answered. */
async function relay(method, path, body) {
  try {
    const res = await fetch(`${RELAY}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch (error) {
    return { ok: false, network: true, error: error instanceof Error ? error.message : String(error) };
  }
}

// --- RLP, for recomputing the EIP-7702 authorization hash ourselves ---------

const hexBytes = (h) => {
  const hex = h.replace(/^0x/, "");
  return Buffer.from(hex.padStart(hex.length + (hex.length % 2), "0"), "hex");
};
const intBytes = (n) => {
  let h = BigInt(n).toString(16);
  if (h === "0") return Buffer.alloc(0);
  if (h.length % 2) h = "0" + h;
  return Buffer.from(h, "hex");
};
const rlpLength = (len, offset) => {
  if (len < 56) return Buffer.from([offset + len]);
  const l = intBytes(len);
  return Buffer.concat([Buffer.from([offset + 55 + l.length]), l]);
};
const rlpItem = (b) => (b.length === 1 && b[0] < 0x80 ? b : Buffer.concat([rlpLength(b.length, 0x80), b]));
const rlpList = (items) => {
  const body = Buffer.concat(items.map(rlpItem));
  return Buffer.concat([rlpLength(body.length, 0xc0), body]);
};

/** keccak256(0x05 || rlp([chain_id, address, nonce])), per EIP-7702. */
function authorizationHash(authChainId, address, nonce) {
  const payload = Buffer.concat([Buffer.from([0x05]), rlpList([intBytes(authChainId), hexBytes(address), intBytes(nonce)])]);
  return cast(["keccak", "0x" + payload.toString("hex")]).toLowerCase();
}

const signRaw = (hash) => castWithKey(["wallet", "sign", "--no-hash", hash]);

// --- 1. prepare --------------------------------------------------------------

const prepared = await relay("POST", "/prepare", { chainId, from, call: { to, data } });
if (!prepared.ok) {
  // Nothing is sent at prepare: every failure here leaves the chain untouched.
  const reason = prepared.network
    ? `relay unreachable: ${prepared.error}`
    : `${prepared.status} ${prepared.body?.error ?? ""}: ${prepared.body?.reason ?? ""}`.trim();
  notSent(reason);
}

const { id, call, toSign } = prepared.body ?? {};
if (!id || !Array.isArray(toSign)) notSent("relay reply has no id or toSign", prepared.body);

// --- 2. check, then sign ----------------------------------------------------

if (call?.to?.toLowerCase() !== to.toLowerCase() || (call?.data ?? "0x").toLowerCase() !== data.toLowerCase()) {
  notSent("relay prepared a different call than the one requested — refusing to sign", { requested: { to, data }, prepared: call });
}

const signatures = {};
for (const item of toSign) {
  if (item.kind === "authorization") {
    const delegate = String(item.delegate ?? "").toLowerCase();
    if (!TRUSTED_DELEGATES.has(delegate)) notSent(`refusing to sign a 7702 delegation to ${item.delegate}`, item);
    if (Number(item.chainId) !== chainId) notSent(`authorization is for chain ${item.chainId}, not ${chainId}`, item);
    const expected = authorizationHash(chainId, delegate, Number(item.nonce));
    if (expected !== String(item.hash).toLowerCase()) {
      notSent("authorization hash does not match the one computed here — refusing to sign", { expected, item });
    }
    signatures.authorization = signRaw(expected);
  } else if (item.kind === "userOperation") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(item.hash ?? "")) notSent("user operation hash is not 32 bytes", item);
    signatures.userOperation = signRaw(item.hash);
  } else {
    notSent(`relay asked to sign an unknown kind "${item.kind}" — refusing`, item);
  }
}
if (!signatures.userOperation) notSent("relay asked for no user operation signature", toSign);

// --- 3. send -------------------------------------------------------------------

sendAttempted = true;
const sent = await relay("POST", "/send", { id, signatures });
if (!sent.ok) {
  // A refusal the relay states (bad signature, expired, cap, policy) means it
  // never submitted. Anything else — no answer, a timeout, a 5xx — may have
  // reached Alchemy, so it is not safe to send again.
  const refused = !sent.network && [400, 403, 410, 429, 503].includes(sent.status);
  if (refused) notSent(`${sent.status} ${sent.body?.error ?? ""}: ${sent.body?.reason ?? ""}`.trim());
  exit(
    SENT_UNKNOWN,
    `sponsored-send: may have been sent (${sent.network ? sent.error : `${sent.status} ${sent.body?.error ?? ""}`}) — do NOT resend; read the chain first`,
  );
}
const callId = sent.body?.callId;
if (!callId) exit(SENT_UNKNOWN, "sponsored-send: relay accepted the send but returned no callId — do NOT resend; read the chain first", sent.body);
process.stderr.write(`sponsored-send: sent, callId ${callId}\n`);

// --- 4. wait -----------------------------------------------------------------

const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline) {
  const s = await relay("GET", `/status/${encodeURIComponent(callId)}`);
  const status = s.ok ? s.body?.status : undefined;
  if (status === "success") {
    // A bundle can land with receipt status 1 while the call inside reverted.
    if (s.body.callSucceeded === false) {
      exit(SENT_FAILED, `sponsored-send: mined in ${s.body.transactionHash} but the call reverted — do not retry`, s.body);
    }
    exit(SENT_OK, JSON.stringify({ status: "success", transactionHash: s.body.transactionHash, callId }));
  }
  if (status === "failed") exit(SENT_FAILED, "sponsored-send: the sponsored call failed — do not retry", s.body);
  await new Promise((r) => setTimeout(r, POLL_MS));
}
exit(SENT_UNKNOWN, `sponsored-send: no final status for callId ${callId} after ${TIMEOUT_MS / 1000}s — do NOT resend; read the chain first`);
