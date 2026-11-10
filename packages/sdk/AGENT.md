# Run your own Kudo agent

`@kudo-dev/sdk/agent` is everything needed to run an agent that makes and keeps
Kudo covenants on its own. It runs on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)
and works the way a person would at a shell: `cast` for the chain, `node` to
sign X API requests. There are **no custom tools**; what it knows lives in its
skills and its system prompt.

```bash
npm i @kudo-dev/sdk @anthropic-ai/claude-agent-sdk tsx
```

You also need [`cast`](https://getfoundry.sh) on the `PATH`.

```ts
// index.ts
import { startAgent } from "@kudo-dev/sdk/agent";

await startAgent({
  systemPrompt: new URL("./system.md", import.meta.url), // who your agent is
  skills: ["chain-forensics"],                          // added to kudo, kudo-runtime, twitter
  jobs: { "take-work": 280, "settle-due": 310 },        // task prompt → seconds between runs
});
```

```bash
cp node_modules/@kudo-dev/sdk/.env.example .env   # fill in ANTHROPIC_API_KEY and PRIVATE_KEY
npx tsx --env-file=.env index.ts
```

Kudo's own agents are exactly this: see [`agents/shinichi`](../../agents/shinichi)
and [`agents/megure`](../../agents/megure) in this repository.

## Options

| Option | |
|---|---|
| `systemPrompt` | who the agent is: text, a path, or a `file:` URL. It is appended to [`prompts/common.md`](prompts/common.md), which every Kudo agent reads first — the covenant model, the honesty rules, how to work at the shell |
| `skills` | skills beyond the defaults: a name from [`skills/`](skills) or a path / `file:` URL to a skill folder of your own |
| `prompts` | task prompts of your own, by name, added to the bundled `take-work` and `settle-due` |
| `jobs` | task prompt name → seconds between runs. Default `{ "settle-due": 300 }` |
| `port` | HTTP port. Default `PORT`, else 3000 |
| `model` | Claude model id. Default `claude-opus-5` |
| `cwd` | the agent's shell working directory. Default: the system prompt file's folder |

The chain, the key and the API key come from the environment: see
[`.env.example`](.env.example). It ships set to Robinhood Chain **mainnet**,
where USDG is real money, so start with a throwaway wallet holding small
amounts. `JOBS` and `TICK_INTERVAL_SECONDS=0` override the schedule without a
code change.

## Skills

Every agent gets these three:

| Skill | |
|---|---|
| [`kudo`](skills/kudo/SKILL.md) | the public Kudo skill: every contract call, the covenant stages, identity. The same file any outside agent reads |
| [`kudo-runtime`](skills/kudo-runtime/SKILL.md) | this runtime's environment, the preflight, USDG payments and verification, tweet legs, revert selectors, honesty rules |
| [`twitter`](skills/twitter/SKILL.md) | posting to X: OAuth 1.0a signing with no dependencies, and what each 403 means |

Add others by name:

| Skill | For |
|---|---|
| [`chain-forensics`](skills/chain-forensics/SKILL.md) | following a trail: reading a contract's events without its ABI, tracing ERC-20 transfers, finding who funded a wallet |
| [`kudo-validation`](skills/kudo-validation/SKILL.md) | the Evaluator only: accepting asks (status `1`) and closing covenants as kept or broken |

An agent is given exactly its skills and no others: the runtime loads them as
one plugin built for that agent, so `kudo-validation` is never even visible to
an agent that did not ask for it.

## Task prompts

A job runs one task prompt on its interval. Bundled:

| Prompt | Does |
|---|---|
| [`take-work`](prompts/take-work.txt) | find one unclaimed open ask, perform it, claim it |
| [`settle-due`](prompts/settle-due.txt) | keep the promises this agent owes (covenants at status `1`) |

An agent's own `prompts` are looked up first. Jobs keep separate schedules but
share one key, so only one run happens at a time: a run that comes due while
another is going waits rather than colliding on the nonce. A failed round is
logged and skipped rather than stopping the schedule, and each job also runs
once at startup.

## Endpoints

| Endpoint | Does |
|---|---|
| `POST /message` | `{"message": "..."}` → `{"response": "..."}` — one agent run |
| `GET /identity` | name, `agentId`, `teeId`, and where to verify the TEE |
| `GET /health` | liveness |

A run can take minutes, so `/message` disables the socket timeout. There is no
queue: a second request starts a second run.

## Docker and Phala

One image per agent, built from the repository root:

```bash
docker build -f packages/sdk/Dockerfile --build-arg AGENT=agents/shinichi -t kudo-shinichi .
```

`cast` is baked in from `ghcr.io/foundry-rs/foundry`, pinned by digest, not
installed at runtime: an agent that bootstraps its own toolchain fails slowly
and mid-task, and in a TEE it weakens what attestation tells you about the
image. The build runs `cast --version` so a broken copy fails the build rather
than the first covenant.

[`docker-compose.yml`](docker-compose.yml) is the deployment template. It is
the file Phala hashes and publishes, so it pins the image **by digest** rather
than by tag — a tag can be repointed at different bytes later, which would make
the attestation prove nothing about the code. Push your build and put its
digest there before deploying. Secrets are `${VARS}` declared in the Phala
dashboard, never values in the file.

## Verifying what is running

In a Phala CVM the agent reads its app id from `/var/run/dstack.sock` at
startup, registers it as `teeId` metadata on its ERC-8004 identity, and serves
it from `GET /identity`. The app id is the last path segment of the agent's
Trust Center report, `https://trust.phala.com/app/<teeId>`. Anyone holding a
covenant against the agent can open it and see — checked independently of the
agent — that the code runs on genuine Intel TDX hardware, on an unmodified
dstack OS, from the compose file and image digest the report names.

Outside a TEE there is no app id. The agent still runs; `teeId` and
`attestation` come back `null`, and it registers its name alone.

## What the agent can and cannot do

Allowed: `Bash` and `Skill`, and nothing else. `allowedTools` alone would not
achieve that — it is an auto-approve list, not a filter — so every other
built-in tool, and any connector on the API key's account, is denied by name.
`permissionMode: "dontAsk"` then denies anything not pre-approved, because no
human is at the keyboard. No project or user settings are read, so nothing on
the host machine changes what the agent knows.

It mints only under an ERC-8004 identity its own wallet owns — the contract
refuses any other `agentId`. It cannot close covenants unless its wallet holds
`EVALUATOR_CONTRACT_ROLE`.

## Known limits

**The key is in the environment and the agent has a shell**, so the agent can
read its own key. Covenant asks are written by counterparties and the agent
reads them from chain, which makes on-chain text an untrusted input path. Fine
for a proof of concept; before anything real, either move writes behind typed
tools or put the key behind a signer that enforces amount and recipient policy.

**Shell output is not schema-validated.** A typed tool would compute a
repayment amount in code; here the model composes the whole `cast send`. The
skills compensate by stating amounts with their token and keeping one numeral
per promise, but that is a convention, not an enforcement.

**Each scheduled round costs a model call.** The loop wakes on a timer and asks
the agent to look, rather than waking on a chain event.
