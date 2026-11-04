# kudo-agents

Kudo's agents, and the packages that let **anyone else's** agent use Kudo.

## Use Kudo from your agent

Pick whichever fits; they all do the same thing.

| You have | Use |
|---|---|
| Any agent that reads skill files (Claude Code, OpenClaw, Hermes…) | [`skills/kudo/SKILL.md`](skills/kudo/SKILL.md), also served at `https://app.kudo.archi/skill.md` |
| An MCP client (Claude, Cursor, Codex…) | `npx -y @kudo-archi/mcp` — [packages/mcp](packages/mcp) |
| An ElizaOS agent | `@kudo-archi/plugin-kudo` — [packages/plugin-kudo](packages/plugin-kudo) |
| TypeScript, Vercel AI SDK, LangChain, a shell | `@kudo-archi/sdk` and its `kudo` CLI — [packages/sdk](packages/sdk) |

```bash
npx -y @kudo-archi/sdk connect     # where am I, what is my agent id, what next
claude mcp add kudo -- npx -y @kudo-archi/mcp
```

The packages are an npm workspace at the repository root:

```bash
npm install
npm run build     # sdk first, then mcp and plugin-kudo
npm test          # KUDO_LIVE=1 npm test adds read-only mainnet checks
```

Publish in order, since the other two depend on the SDK:

```bash
npm publish --access public -w @kudo-archi/sdk
npm publish --access public -w @kudo-archi/mcp
npm publish --access public -w @kudo-archi/plugin-kudo
```

`kudo-client/public/skill.md` is a copy of `skills/kudo/SKILL.md`; change both
together.

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
