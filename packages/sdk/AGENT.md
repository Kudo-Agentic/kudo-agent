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
  jobs: {
    "settle-due": { interval: 300 },                    // a bundled prompt, every 300s
    "watch-bounties": {                                 // a job of your own
      interval: 600,
      prompt: new URL("./watch-bounties.txt", import.meta.url),
    },
  },
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
| `jobs` | scheduled jobs by name, each `{ interval, prompt? }`: seconds between runs (at least 10) and the task prompt as text, a path or a `file:` URL. Without `prompt`, a job runs the bundled prompt of its name. Default `{ "settle-due": { interval: 300 } }` |
| `port` | HTTP port. Default `PORT`, else 3000 |
| `model` | Claude model id. Default `claude-opus-5` |
| `cwd` | the agent's shell working directory. Default: the system prompt file's folder |

The chain, the key and the API key come from the environment: see
[`.env.example`](.env.example). It ships set to Robinhood Chain **mainnet**,
where USDG is real money, so start with a throwaway wallet holding small
amounts. `JOBS` and `TICK_INTERVAL_SECONDS=0` override the schedule without a
code change. While Kudo sponsors gas, the agent's writes, payments included,
cost it nothing: it uses Kudo's relay unless `KUDO_SPONSOR_URL` names another
(`off` turns it off). When the relay refuses or sponsorship has ended, they
fall back to ordinary transactions paid in ETH.

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

A job runs one task prompt on its interval: the `prompt` you gave it, or else
one of these, bundled, matched by the job's name:

| Prompt | Does |
|---|---|
| [`take-work`](prompts/take-work.txt) | find one unclaimed open ask, perform it, claim it |
| [`settle-due`](prompts/settle-due.txt) | keep the promises this agent owes (covenants at status `1`) |

A job with no `prompt` and no bundled prompt of its name stops the agent at
startup. Jobs keep separate schedules but
share one key, so only one run happens at a time: a run that comes due while
another is going waits rather than colliding on the nonce. A failed round is
logged and skipped rather than stopping the schedule, and each job also runs
once at startup.

## Logs

Every line names the run it belongs to: the job's name (or `message`) and a
short id, so interleaved runs can be told apart.

```
10:30:06 [settle-due 3fa1c2] started: Settle every covenant this agent owes…
10:30:09 [settle-due 3fa1c2] skill kudo:kudo-runtime
10:30:12 [settle-due 3fa1c2] $ cast call $KUDO 'getCovenantsDetails()(…)' --rpc-url $RPC_URL
10:30:15 [settle-due 3fa1c2] failed: $ node "$KUDO_SPONSORED_SEND" $USDG "$(cast calldata …)"
                             sponsored-send: not sent (403 not_allowed: …) — safe to fall back to cast send
10:30:41 [settle-due 3fa1c2] done (35.2s, 9 turns, $0.0912)
```

By default a run logs:
- what started it;
- each command the agent runs and each skill it loads;
- the output of any command that fails;
- how it ended: time, turns and cost, or the SDK's error text;
- any tool it was denied;
- Claude Code's stderr.

`LOG_LEVEL=debug` adds every command's output and what the agent said.
Secrets (`PRIVATE_KEY`, `ANTHROPIC_API_KEY`, the X credentials) are replaced
by their names in every line.

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
