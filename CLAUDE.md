# kudo-agent

Two parts:

- **`packages/`**: everything needed to use Kudo or run a Kudo agent.
  `@kudo-dev/sdk` is the library and, at `@kudo-dev/sdk/agent`, `startAgent`:
  the runtime (on the Claude Agent SDK), its task prompts (`prompts/`) and every
  skill, including the public `kudo` skill (`skills/kudo/SKILL.md`; app.kudo.archi
  links to its raw URL on `main`). Also the MCP server and the ElizaOS plugin.
- **`agents/`**: Kudo's own two agents, each a few lines that call `startAgent`
  with its system prompt, extra skills and jobs: `shinichi` and `megure` (the
  evaluator). Each also holds its off-chain ERC-8004 file (`identity.json`).

Plus `tests/e2e/`, signed suites on a local mainnet fork.

## Commands

```bash
npm ci                    # at the repo root: the whole workspace, both agents included
npm run typecheck         # builds packages/sdk first, then tsc in each workspace
npm test                  # unit tests (offline)
npm run build
npm run check:addresses   # skills, prompts and packages name only the current contracts
cd agents/shinichi && npx tsx --env-file=.env index.ts   # run an agent; needs .env
cd tests/e2e && npm ci && ./run.sh                       # signed e2e on a local mainnet fork
```

The agents have no test suite. The Stop hook (`.claude/hooks/stop-check.sh`)
checks that every identity and agent-card JSON parses, that no skill names a
wrong or legacy contract address, that the workspace typechecks, and, when
`packages/` changed, that the unit tests pass, before a turn may end.

| Workspace | npm | |
|---|---|---|
| `packages/sdk` | `@kudo-dev/sdk` | library for the Kudo contract and the ERC-8004 registries; `startAgent` at `@kudo-dev/sdk/agent` |
| `packages/tools` | private, never published | the agent tools, one file each; compiled into mcp and plugin-kudo |
| `packages/mcp` | `@kudo-dev/mcp` | MCP server, stdio and Streamable HTTP (HTTP never signs) |
| `packages/plugin-kudo` | `@kudo-dev/plugin-kudo` | ElizaOS plugin |
| `agents/shinichi`, `agents/megure` | private | Kudo's own agents |

Publish order: sdk, mcp, plugin-kudo. On merge to `main`,
`.github/workflows/publish.yml` stages (`npm stage publish`, stage-only
`NPM_ACCESS_TOKEN`) any package whose `version` is not on npm yet; PRs run it
as a dry run. A maintainer then runs `npm stage approve` with 2FA. The e2e
suites are described in `tests/e2e/README.md`.

## Architecture

`startAgent` (`packages/sdk/src/agent/start.ts`) starts the HTTP server
(`server/`: `/message`, `/identity`, `/health`) and the scheduled jobs
(`jobs.ts`), each a task prompt on an interval. `agent.ts` runs one Agent SDK
query with only Bash and Skill allowed and no project or user settings. The
agent drives `cast` and `curl` at a shell; what it knows about the protocol is
in its skills, which `skills.ts` loads as one plugin holding exactly that
agent's skills: always `kudo`, `kudo-runtime` and `twitter`, plus the agent's
extras. The system prompt is `packages/sdk/prompts/common.md` plus the agent's
own. `tee.ts` reads the Phala app id that ends up as `teeId`. One image per
agent: `docker build -f packages/sdk/Dockerfile --build-arg AGENT=agents/<name> .`.
The library (`packages/sdk/src/index.ts`) never imports `src/agent/`; the Agent
SDK is an optional peer dependency.

## Rules

1. Once an agent's ERC-8004 `tokenURI` points at its `agents/<name>/identity.json`
   raw URL, never rename, move or delete that file: edit it in place, or repoint
   with `setAgentUri`.
2. The agent runtime has no custom tools. Put protocol knowledge in a skill
   file and agent behaviour in prompts. Protocol facts belong in the public
   `kudo` skill; `kudo-runtime` holds only what is specific to the runtime.
3. Shared rules live once, in `packages/sdk/prompts/common.md`. A prompt that
   only one agent may run lives in that agent's folder and is passed to
   `startAgent` as one of its `prompts`.
4. `packages/sdk/docker-compose.yml` pins the image by digest, never by tag,
   and holds no secret values (`${VARS}` only).
5. Mainnet only: the testnet Kudo is an older contract version the skills no
   longer support. Test on a local mainnet fork (`tests/e2e/`), then with a
   throwaway wallet and small amounts. Never commit a `.env` or a private key.
6. The packages and the public `kudo` skill only talk to Kudo and the ERC-8004
   registries: no tool or step moves tokens. An agent pays from its own wallet
   and links the transaction hash.
7. `packages/tools` has one file per tool. Add a tool as a new file and list it
   in `packages/tools/src/index.ts`.
