# kudo-agent

The Kudo covenant agent, built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).
Replaces the ElizaOS agent in `kudo-x402-agent/`.

**No custom tools.** The agent works at a shell the way a person would: `cast`
for the chain, `node` to sign X API requests. Everything it knows about the
protocol lives in one skill file.

```
.claude/skills/kudo-covenants/SKILL.md   the protocol: commands, struct layout,
                                         who signs what, revert selectors
.claude/skills/twitter/SKILL.md          posting to X: OAuth 1.0a signing with
                                         no deps, and what each 403 means
agents/_common.md                        what every agent is told
agents/<slug>/system.md                  who that one agent is - AGENT picks it
prompts/settle-due.txt                   what the settler asks each round
src/main.ts                              the one entry point: server + settler
src/agent/                               runAgent(prompt)
src/server/                              the HTTP endpoint
src/cron.ts                              the settlement loop
src/tee.ts                               reads the Phala app id at startup
Dockerfile                               node + cast + curl
```

Two skills, because they are independent: the covenant protocol does not care
how a tweet gets posted, and posting a tweet does not care about covenants.
They meet at one point — a tweet URL is what settles a covenant leg.

## Running it

One process, one entry point. `src/main.ts` starts the HTTP endpoint and the
settlement loop together — the shape a Phala CVM deploys.

```bash
cp .env.example .env     # fill in ANTHROPIC_API_KEY and PRIVATE_KEY
npm install
npm run dev
```

Point it at **testnet** before mainnet. `.env` ships set to testnet; the
mainnet block is commented out below it.

| Endpoint | Does |
|---|---|
| `POST /message` | `{"message": "..."}` → `{"response": "..."}` — one agent run |
| `GET /identity` | name, `agentId`, `teeId`, and where to verify the TEE |
| `GET /health` | liveness |

```bash
curl -s localhost:3000/message -H 'content-type: application/json' \
  -d '{"message":"What covenants are open?"}'
```

A run can take minutes, so `/message` disables the socket timeout. There is no
queue: a second request starts a second run.

## The settler

`src/cron.ts` sends `prompts/settle-due.txt` on an interval. Each round the
agent lists its covenants and finds the ones whose promise is due, then keeps
each promise according to what it says: pay the ETH and attest with the
transaction hash, or post the tweet and attest with its URL. Either way the
proof is written only after the thing it attests demonstrably happened. Rounds
never overlap, and a failed round is logged and skipped rather than stopping
the loop.

A round also runs immediately at startup, so every process start costs one
model call regardless of the interval.

`TICK_INTERVAL_SECONDS` sets the interval (default 300, minimum 10).

Prompts are files so an operational run is reviewable and version controlled
rather than retyped at a shell. Changing what the settler does each round means
editing `prompts/settle-due.txt`.

## Docker

```bash
docker compose up -d
```

`docker-compose.yml` is the file Phala hashes and publishes, so it pins the
image **by digest** rather than by tag: a tag can be repointed at different
bytes later, which would make the attestation report prove nothing about the
code. Push your build and replace the digest before deploying. Secrets are
`${VARS}` declared in the Phala dashboard, never values in the file.

## Verifying what is running

In a Phala CVM the agent reads its app id from `/var/run/dstack.sock` at
startup, registers it as `teeId` metadata on its ERC-8004 identity, and serves
it from `GET /identity`. The app id is the last path segment of the agent's
Phala Trust Center report:

```
https://trust.phala.com/app/<teeId>
```

That page is the point of publishing the id. Anyone holding a covenant against
this agent can open it and see — checked independently of the agent, which has
every incentive to lie — that the code runs on genuine Intel TDX hardware, on
an unmodified dstack OS, from the compose file and image digest the report
names. The digest is what ties the report back to the skills and prompts in
this repository.

Outside a TEE there is no app id. The agent still runs; `teeId` and
`attestation` come back `null`, and it registers its name alone.

## How cast gets there

Baked into the image from `ghcr.io/foundry-rs/foundry`, not installed at
runtime. An agent that bootstraps its own toolchain fails slowly and mid-task,
and in a TEE it weakens what attestation tells you about the image. The build
runs `cast --version` so a broken copy fails the build rather than the first
covenant.

Pin the Foundry tag. Flags drift between nightlies — this session hit a build
where `cast estimate` rejected `--rpc-url` in the position the docs showed.

## What the agent can and cannot do

Allowed: `Bash` and `Skill`, and nothing else. Note that `allowedTools` alone
would not achieve that — it is an auto-approve list, not a filter, and leaves
every other built-in tool plus any connector on the API key's account visible
to the model. They are denied by name in `disallowedTools`, which takes the
tool list from 23 entries to 3. `permissionMode: "dontAsk"` then denies anything
not pre-approved, because no human is at the keyboard.

It holds `AGENT_ROLE`, so it can mint and attest its own promises. It does
**not** hold `EVALUATOR_CONTRACT_ROLE`, so it cannot close covenants — that
stays with the validator key.

## Known limits of this PoC

**The key is in the environment and the agent has a shell**, so the agent can
read its own key. Covenant asks are written by counterparties and the agent
reads them from chain, which makes on-chain text an untrusted input path. Fine
for a proof of concept; before anything real, either move writes behind typed
tools or put the key behind a signer that enforces amount and recipient policy.

**Shell output is not schema-validated.** A typed tool would compute a
repayment amount in code; here the model composes the whole `cast send`. The
skill file compensates by stating amounts in ETH and keeping one numeral per
promise, but that is a convention, not an enforcement.

**Settlement rounds cost a model call each.** The loop wakes on a timer and
asks the agent to look, rather than waking on a chain event. A plain, model-free
watcher that only prompts the agent when a covenant is actually due would be
cheaper; this is the simple version.
