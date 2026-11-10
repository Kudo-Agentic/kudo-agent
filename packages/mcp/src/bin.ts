/**
 * kudo-mcp — Kudo's MCP server.
 *
 *   npx -y @kudo-dev/mcp            stdio, for Claude Code / Desktop, Cursor, Codex
 *   npx -y @kudo-dev/mcp --http     Streamable HTTP on $PORT (default 3333), never signs
 *
 * Stdio signs with KUDO_PRIVATE_KEY when it is set; otherwise every write tool
 * returns an unsigned transaction for your own wallet.
 */
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { kudoFromEnv } from "@kudo-dev/tools";

import { serveHttp } from "./http.js";
import { createKudoMcpServer } from "./server.js";

const { values } = parseArgs({
  options: {
    http: { type: "boolean" },
    port: { type: "string" },
    host: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`kudo-mcp — Kudo covenants over MCP

  npx -y @kudo-dev/mcp              stdio (default)
  npx -y @kudo-dev/mcp --http       Streamable HTTP at /mcp, unsigned only

Env: KUDO_PRIVATE_KEY (stdio only), KUDO_AGENT_ID, KUDO_RPC_URL,
     PORT, KUDO_MCP_RATE_LIMIT (per IP per minute), KUDO_MCP_ALLOWED_ORIGINS,
     KUDO_MCP_TRUST_PROXY=1 (behind a reverse proxy)`);
  process.exit(0);
}

if (values.http) {
  if (process.env.KUDO_PRIVATE_KEY) {
    console.error("KUDO_PRIVATE_KEY is set but ignored: the HTTP server never signs. Use stdio for local signing.");
  }
  const { kudo, agentId } = kudoFromEnv(process.env, { ignoreKey: true });
  const port = Number(values.port ?? process.env.PORT ?? 3333);
  serveHttp({
    kudo,
    mode: "unsigned",
    defaultAgentId: agentId,
    port,
    host: values.host,
    rateLimitPerMinute: process.env.KUDO_MCP_RATE_LIMIT ? Number(process.env.KUDO_MCP_RATE_LIMIT) : undefined,
    allowedOrigins: process.env.KUDO_MCP_ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
    trustProxy: process.env.KUDO_MCP_TRUST_PROXY === "1",
  });
  console.error(`kudo-mcp: Streamable HTTP on :${port}/mcp (${kudo.network.chain.name}, unsigned)`);
} else {
  const { kudo, agentId } = kudoFromEnv(process.env);
  const server = createKudoMcpServer({ kudo, defaultAgentId: agentId });
  await server.connect(new StdioServerTransport());
  console.error(
    `kudo-mcp: stdio on ${kudo.network.chain.name}, ${kudo.address ? `signing as ${kudo.address}` : "unsigned (no KUDO_PRIVATE_KEY)"}`,
  );
}
