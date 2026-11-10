# kudo-agents

Three things in one repo:

- **Root `*.json`**: off-chain ERC-8004 agent files. Each file's raw GitHub URL
  on `main` is an agent's on-chain `tokenURI`.
- **`kudo-agent/`**: the covenant agent service, on the Claude Agent SDK. It
  runs in a Phala TEE.
- **Agent onboarding**: `skills/kudo/SKILL.md` (the public skill; app.kudo.archi
  links to its raw URL on `main`) and the npm workspace in `packages/`.

## Commands

```bash
cd kudo-agent
npm ci
npx tsc --noEmit    # typecheck
npm run dev         # HTTP server + settlement loop; needs .env (copy .env.example)
docker compose up -d
```

kudo-agent has no test suite. The Stop hook (`.claude/hooks/stop-check.sh`)
checks that every agent JSON parses, that kudo-agent typechecks, that no skill
names a wrong or legacy contract address, and, when `packages/` changed, that
the packages typecheck and their unit tests pass, before a turn may end.

## Packages

```bash
npm ci                    # at the repo root: the workspace
npm run typecheck         # builds packages/sdk first, then tsc in each package
npm test                  # unit tests (offline)
npm run build
npm run check:addresses   # skills and packages name only the current contracts
cd e2e && npm ci && ./run.sh            # signed e2e on a local mainnet fork
```

| Package | npm | |
|---|---|---|
| `packages/sdk` | `@kudo-dev/sdk` | plain library for the Kudo contract and the ERC-8004 registries |
| `packages/tools` | private, never published | the agent tools, one file each; compiled into mcp and plugin-kudo |
| `packages/mcp` | `@kudo-dev/mcp` | MCP server, stdio and Streamable HTTP (HTTP never signs) |
| `packages/plugin-kudo` | `@kudo-dev/plugin-kudo` | ElizaOS plugin |

Publish order: sdk, mcp, plugin-kudo. The e2e suites in `e2e/` are described
in `e2e/README.md`.

## Architecture

`kudo-agent/src/main.ts` starts the HTTP server (`src/server`: `/message`,
`/identity`, `/health`) and the settler (`src/cron.ts`). The settler sends
`prompts/settle-due.txt` on an interval. `src/agent` runs one Agent SDK query
with only Bash and Skill allowed. The agent drives `cast` and `curl` at a
shell; what it knows about the protocol is in `.claude/skills/*/SKILL.md`. The
system prompt is `agents/_common.md` plus `agents/<AGENT>/system.md`. The
`AGENT` env var picks the persona; the image is identical for every agent.
`src/tee.ts` reads the Phala app id that ends up as `teeId`.

## Rules

1. Never rename, move or delete a root `*.json`: the URL is on-chain. Edit it
   in place, or repoint with `setAgentUri`.
2. In `kudo-agent/`, do not add custom tools. Put protocol knowledge in a skill
   file and agent behaviour in prompts.
3. Shared rules live once, in `agents/_common.md`. A prompt that only one
   agent may run lives in that agent's directory.
4. `docker-compose.yml` pins the image by digest, never by tag, and holds no
   secret values (`${VARS}` only).
5. Mainnet only: the testnet Kudo is an older contract version the skills no
   longer support. Test on a local mainnet fork (`e2e/`), then with a throwaway
   wallet and small amounts. Never commit a `.env` or a private key.
6. The packages and `skills/kudo` only talk to Kudo and the ERC-8004
   registries: no tool or step moves tokens. An agent pays from its own wallet
   and links the transaction hash.
7. `packages/tools` has one file per tool. Add a tool as a new file and list it
   in `packages/tools/src/index.ts`.
