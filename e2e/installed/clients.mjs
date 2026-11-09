// Each MCP client config on /connect (Claude Desktop/Cursor/Windsurf JSON and
// Codex TOML), parsed as written and started exactly as the client would:
// command + args + env, then an MCP initialize and tools/list over stdio.
//   node clients.mjs <key> <agentId> <rpc>    (cwd: the clean install dir)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseToml } from "smol-toml";
import { fill, snippet } from "./snippets.mjs";

const [key, agentId, rpc] = process.argv.slice(2);
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) fail++; };

async function start(label, server) {
  const client = new Client({ name: label, version: "0" });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...process.env, ...server.env, KUDO_RPC_URL: rpc },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const hc = JSON.parse((await client.callTool({ name: "how_to_connect", arguments: {} })).content[0].text);
    ok(tools.includes("mint_covenant") && !tools.some((n) => /pay|transfer/.test(n)), `${label}: started with ${tools.length} tools, none moves tokens`);
    ok(hc.signing.includes("signs as") && hc.network.chainId === 4663, `${label}: signing with the configured key on chain ${hc.network.chainId}`);
  } catch (e) {
    ok(false, `${label}: ${e.message} ${stderr.slice(0, 300)}`);
  } finally {
    await client.close().catch(() => {});
  }
}

const json = JSON.parse(fill(snippet("mcp-json"), { key, agentId }));
ok(json.mcpServers?.kudo?.command === "npx", "Claude Desktop/Cursor/Windsurf JSON parses");
await start("Desktop/Cursor JSON", json.mcpServers.kudo);

const toml = parseToml(fill(snippet("mcp-codex"), { key, agentId }));
ok(toml.mcp_servers?.kudo?.command === "npx", "Codex config.toml parses");
await start("Codex TOML", toml.mcp_servers.kudo);

// The page's placeholders, unfilled: what a user who pastes without editing sees.
const raw = JSON.parse(snippet("mcp-json")).mcpServers.kudo;
const t = new StdioClientTransport({ command: raw.command, args: raw.args, env: { ...process.env, ...raw.env, KUDO_RPC_URL: rpc }, stderr: "pipe" });
let err = ""; t.stderr?.on("data", (d) => (err += d));
const c = new Client({ name: "raw", version: "0" });
await c.connect(t).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
console.log(`  (unedited placeholders: ${/must be a 32-byte hex/.test(err) ? "the server refuses to start: \"KUDO_PRIVATE_KEY must be a 32-byte hex private key\"" : `server said: ${err.slice(0, 160) || "nothing"}`})`);
await c.close().catch(() => {});
process.exit(fail ? 1 : 0);
