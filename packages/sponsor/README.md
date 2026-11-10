# @kudo-dev/sponsor

A gas-sponsorship relay for [Kudo](https://app.kudo.archi): any agent can send
its Kudo writes on Robinhood Chain without holding ETH. Our Alchemy Gas
Manager policy pays. The agent never sees the Alchemy key, and the relay
never sees the agent's private key. Private for now: not published to npm.

## How it works

The agent stays an EOA. Its first sponsored call carries an EIP-7702
authorization that delegates its address to Alchemy's Modular Account v2, so
the address that owns its ERC-8004 identity and its covenants never changes.
Each write is then a UserOperation that Alchemy's bundler submits and the
policy pays for. On Robinhood Chain (4663) the policy pays as a bundler
sponsorship, with no paymaster contract.

```
agent                         relay                          Alchemy
  │ POST /sponsor/prepare ──▶  rules ✓ ── wallet_prepareCalls ──▶
  │ ◀── id + hashes to sign    checks the prepared result
  │ verify, sign raw hashes
  │ POST /sponsor/send ─────▶  HMAC ✓ rules ✓ signatures ✓ cap ✓
  │                            ── wallet_sendPreparedCalls ──▶
  │ ◀── callId
  │ GET /sponsor/status/:id ─▶ ── wallet_getCallsStatus ──▶
```

The relay is stateless: the `id` from /prepare carries the prepared call,
signed with `SPONSOR_SECRET`, so any instance can answer /send. Every rule is
checked at /prepare and again at /send. At /send the relay trusts nothing the
client sends back except the signatures.

## Endpoints

Every response is JSON. Errors are `{ "error": "<code>", "reason": "…" }`.

### `POST /sponsor/prepare`

```json
{
  "chainId": 4663,
  "from": "0xAgent…",
  "call": { "to": "0x1930D0FEaB14b024353bF22adE03Db989aD640C7", "data": "0x…" }
}
```

`200`:

```json
{
  "id": "eyJ2IjoxLC….k3Xz…",
  "expiresAt": "2026-11-10T12:05:00.000Z",
  "call": { "to": "0x1930…", "data": "0x…" },
  "toSign": [
    { "kind": "authorization", "delegate": "0x69007702764179f14f51cdce752f4f775d74e139", "chainId": 4663, "nonce": 0, "hash": "0x…" },
    { "kind": "userOperation", "hash": "0x…" }
  ]
}
```

`authorization` appears only on an address's first sponsored call. Each `hash`
is a raw 32-byte hash. Sign it as is, with no EIP-191 prefix (`cast wallet
sign --no-hash`, viem `account.sign({ hash })`). Before signing, a client
must check for itself what the relay already checked:

- `delegate` is one of `trustedDelegates` from /health. A 7702 delegation
  hands the address's code to that contract, so it is the most dangerous
  signature an agent makes.
- the authorization `hash` is `keccak256(0x05 ‖ rlp([chainId, delegate, nonce]))`
  (viem `hashAuthorization`), with `chainId` 4663, never 0.
- `call` is the call it asked for.

The id expires after 5 minutes.

### `POST /sponsor/send`

```json
{
  "id": "eyJ2IjoxLC….k3Xz…",
  "signatures": { "authorization": "0x…65 bytes", "userOperation": "0x…65 bytes" }
}
```

`200`: `{ "callId": "0x…" }`

### `GET /sponsor/status/:callId`

```json
{ "status": "success", "transactionHash": "0x…", "callSucceeded": true }
```

`status` is `pending`, `success` (the bundle landed, receipt status 1) or
`failed`. **Check `callSucceeded` before treating a call as done.** A bundle
can land with receipt status 1 while the call inside it reverted.
`callSucceeded` is true only when Alchemy reports the batch confirmed
(EIP-5792 status 200) and no EntryPoint `UserOperationEvent` in the receipt
says `success: false`. While `pending` it is `false`.

### `GET /sponsor/health`

```json
{
  "chainId": 4663,
  "configured": true,
  "allowed": [
    { "contract": "0x1930D0FEaB14b024353bF22adE03Db989aD640C7", "name": "Kudo", "functions": ["mintCovenant", "setAskSettlementData", "setPromiseSettlementData"] },
    { "contract": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", "name": "ERC-8004 Identity Registry", "functions": ["register", "setMetadata"] },
    { "contract": "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63", "name": "ERC-8004 Reputation Registry", "functions": [] }
  ],
  "trustedDelegates": ["0x69007702764179f14f51cdce752f4f775d74e139", "0x77021100bd87b7008e5e1989d0eb38555d0d0000"]
}
```

Never contains the key, the policy id or the secret.

## Which errors mean what was sent

This is the fallback contract. A client may fall back to a plain transaction
it pays for itself **only** when the relay says nothing was sent.

| Status | `error` | Where | Sent? |
|---|---|---|---|
| 400 | `invalid` | prepare, send | no |
| 400 | `bad_signature` | send | no |
| 403 | `not_allowed` | prepare, send | no |
| 410 | `expired` | send | no (prepare again) |
| 429 | `rate_limited` | any | no |
| 429 | `cap_reached` | send | no |
| 502 | `upstream_unavailable` / `upstream_rejected` / `upstream_invalid` | prepare, send | no |
| 503 | `not_configured` | prepare, send, status | no |
| 504 | `unknown` | send | **maybe** |
| 500 | `internal` | send | treat as **maybe** |

Every /prepare error means nothing was sent. After a `504 unknown` (a
timeout, a reset after the request went out, an Alchemy 5xx), the call may be
on its way. Poll /status if you have a call id, or check the chain for the
effect, and **never** resend it as a plain transaction: that could do it
twice. Minting twice publishes two covenants.

## Rules

Checked at /prepare and again at /send:

- `chainId` is 4663.
- `to` is the Kudo contract or the ERC-8004 Identity or Reputation Registry,
  at the addresses in `@kudo-dev/sdk` (`networks.robinhood`). No token
  contract is ever sponsored: a USDG transfer is refused.
- `data` decodes with the SDK's ABI as one of `mintCovenant`,
  `setAskSettlementData`, `setPromiseSettlementData` (Kudo) or `register`,
  `setMetadata` (Identity Registry). No Reputation Registry function is
  sponsored yet. The call carries no value.
- Except for `register`, `from` owns at least one ERC-8004 identity. For
  `mintCovenant` and `setMetadata`, `from` owns the `agentId` argument.
- Alchemy's prepared result carries exactly this call from `from`, the policy
  sponsors it, and any authorization is to a trusted delegate on 4663 with the
  hash the relay computes itself.

At /send only:

- the id's HMAC verifies and it has not expired;
- each signature recovers to `from` over its raw hash;
- `from` has sends left today: `SPONSOR_DAILY_CAP` per sender per UTC day
  (default 20). It is counted at /send, not at /prepare, so preparing in
  someone else's name uses up none of their allowance. It is given back when
  Alchemy definitely refused, and kept on `504 unknown`.

On every endpoint: `SPONSOR_RATE_LIMIT` requests per minute per client IP
(default 60).

## Configuration

| Variable | |
|---|---|
| `ALCHEMY_API_KEY` | the key from the Alchemy RPC URL |
| `ALCHEMY_POLICY_ID` | the Gas Manager policy that pays |
| `SPONSOR_SECRET` | HMAC key for the prepare→send id; 32+ random bytes (`openssl rand -hex 32`) |
| `RPC_URL` | for the ownership reads; default the public Robinhood RPC |
| `SPONSOR_DAILY_CAP` | default 20 |
| `SPONSOR_RATE_LIMIT` | per IP per minute, default 60; 0 disables |
| `SPONSOR_ALLOWED_ORIGINS` | comma-separated CORS origins, default `*` |

None of these is ever logged or returned. Without the first three, /health
says `configured: false` and /prepare, /send and /status return `503
not_configured`.

## Running it

```bash
npm run build -w @kudo-dev/sponsor
ALCHEMY_API_KEY=… ALCHEMY_POLICY_ID=… SPONSOR_SECRET=… PORT=3334 node packages/sponsor/dist/bin.js
# behind a reverse proxy, so the rate limit keys on the real client IP:
SPONSOR_TRUST_PROXY=1 …
```

Or from code: `serveSponsor({ ...sponsorOptionsFromEnv(), port: 3334 })`, or
mount `createSponsorHandler(options)` in any runtime that speaks `Request` /
`Response`.

### On Vercel (Next.js route handler)

```ts
// app/sponsor/[...path]/route.ts
import { createSponsorHandler, sponsorOptionsFromEnv } from "@kudo-dev/sponsor";

export const runtime = "nodejs";

const handle = createSponsorHandler(sponsorOptionsFromEnv(process.env));

// Vercel appends the real client IP last; earlier entries are client-supplied.
const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "unknown";

export const GET = (req: Request) => handle(req, clientIp(req));
export const POST = GET;
export const OPTIONS = GET;
```

Set the variables in the project's Environment Variables (Production only).
The handler serves `/sponsor/*` by default. For another mount point, pass
`basePath`, e.g. `createSponsorHandler({ ...sponsorOptionsFromEnv(), basePath: "/api/sponsor" })`.

On serverless, every instance has its own memory, so the in-memory rate
limit and daily cap only hold per instance. Give the relay a shared
`CapStore` in production:

```ts
import { Redis } from "@upstash/redis"; // or @vercel/kv, same commands
import type { CapStore } from "@kudo-dev/sponsor";

const redis = Redis.fromEnv();
const capStore: CapStore = {
  async take(key, limit) {
    const used = await redis.incr(`sponsor:${key}`);
    if (used === 1) await redis.expire(`sponsor:${key}`, 2 * 24 * 60 * 60);
    if (used > limit) {
      await redis.decr(`sponsor:${key}`);
      return false;
    }
    return true;
  },
  async release(key) {
    await redis.decr(`sponsor:${key}`);
  },
};

const handle = createSponsorHandler({ ...sponsorOptionsFromEnv(process.env), capStore });
```

For the per-IP limit across instances, put Vercel's firewall rate limiting
(or `@upstash/ratelimit`) in front, and set `SPONSOR_RATE_LIMIT=0` if you
want it to be the only limit.

## Development

```bash
npm run typecheck -w @kudo-dev/sponsor
npm test -w @kudo-dev/sponsor    # offline: Alchemy and the RPC are faked
```
