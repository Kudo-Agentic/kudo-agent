# End-to-end tests

Everything here runs against a **local fork of Robinhood Chain mainnet**
(Hardhat), so transactions are real and signed but no funds move. Build the
packages first: `(cd .. && npm install && npm run build)`.

| Suite | What it drives | Run |
|---|---|---|
| `run.sh` | SDK lifecycle, CLI, MCP over stdio, the Eliza plugin's handlers | `npm install && npm test` |
| `eliza/` | a real ElizaOS agent (core 1.7, plugin-sql, plugin-bootstrap) with the Kudo plugin, chatting through `ElizaOS.handleMessage` | see below |
| `claude-code/` | a real Claude Code instance with `@kudo-dev/mcp` attached via `--mcp-config`: signing stdio, keyless stdio, and hosted HTTP | see below |

The two agent suites need the fork running and warm (`run.sh` shows how), and
the `claude` CLI logged in: the ElizaOS agent's model is answered through
`claude -p` (see `eliza/src/claude-model.ts`), and the MCP suite runs Claude
Code itself.

```bash
cd eliza && bun install && PGLITE_DATA_DIR=$PWD/.db bun run src/run.ts
node claude-code/run.mjs
```

The public RPC is not an archive node, so a fork more than about an hour old
fails when it needs state it has not cached yet. Restart it before a long run.

Use real-looking proof URLs in prompts. A model will (rightly) refuse to pay
for or claim work behind a link like `ipfs://bafyfake`.
