# kudo-agents

Kudo's agents, and the packages that let **anyone else's** agent use Kudo.

## Use Kudo from your agent

Pick whichever fits; they all do the same thing.

| You have | Use |
|---|---|
| Any agent that reads skill files (Claude Code, OpenClaw, Hermes…) | [`skills/kudo/SKILL.md`](skills/kudo/SKILL.md); agents fetch `https://raw.githubusercontent.com/Kudo-Dev-tech/kudo-agents/main/skills/kudo/SKILL.md` |
| An MCP client (Claude, Cursor, Codex…) | `npx -y @kudo-dev/mcp` — [packages/mcp](packages/mcp) |
| An ElizaOS agent | `@kudo-dev/plugin-kudo` — [packages/plugin-kudo](packages/plugin-kudo) |
| Your own TypeScript integration | `@kudo-dev/sdk`, a plain library — [packages/sdk](packages/sdk) |

```bash
claude mcp add kudo -- npx -y @kudo-dev/mcp
```

None of them moves tokens: when a promise is a payment, the agent pays from its
own wallet and links the transaction hash.

The packages are an npm workspace at the repository root. `packages/tools`
holds the agent tools (one file each) that the MCP server and the ElizaOS
plugin share; it is private and compiled into both, never published.

```bash
npm install
npm run build     # sdk first, then mcp and plugin-kudo
npm test          # KUDO_LIVE=1 npm test adds read-only mainnet checks
npm run check:addresses               # skills and packages name only current contracts
(cd e2e && npm install && npm test)   # signed end-to-end run on a local mainnet fork
```

Merging to `main` publishes automatically (`.github/workflows/publish.yml`):
every package whose `version` is not on npm yet goes out, in order, since the
other two depend on the SDK. Bump `version` in the PR to release. By hand,
with your 2FA code:

```bash
npm publish --access public -w @kudo-dev/sdk
npm publish --access public -w @kudo-dev/mcp
npm publish --access public -w @kudo-dev/plugin-kudo
```

`skills/kudo/SKILL.md` is the only copy of the skill: app.kudo.archi/connect
and llms.txt link to its raw URL on `main`.

## Agent identities

Off-chain agent data for Kudo's ERC-8004 identities. One JSON per agent; the
raw URL of that file is the `tokenURI` passed to `register()` on the
ERC-8004 `IdentityRegistry`.

```
https://raw.githubusercontent.com/Kudo-Dev-tech/kudo-agents/main/<slug>.json
```

| Agent | File |
| --- | --- |
| Shinichi | [`shinichi.json`](shinichi.json) |
| Megure (Kudo Evaluator) | [`megure-evaluator.json`](megure-evaluator.json) |

## Adding one

Add `<slug>.json` at the repository root and register its raw URL as the
agent's `tokenURI`. The file must be valid JSON and must stay reachable at
that URL once registered: the URI is written on-chain, so moving or renaming
the file breaks the identity rather than updating it. To change where an
identity points, call `setAgentUri(agentId, newUri)`.
