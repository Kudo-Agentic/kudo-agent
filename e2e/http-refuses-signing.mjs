// Starts `kudo-mcp --http` as a process WITH KUDO_PRIVATE_KEY set and checks
// that it still never signs: /health says so, the write tools return unsigned
// transactions, and the key's account sends nothing on the fork.
//   node http-refuses-signing.mjs [path/to/kudo-mcp bin]   (fork on :8545)
// The installed-package suite passes the bin from the npm tarball.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const BIN = process.argv[2] ?? fileURLToPath(new URL("../packages/mcp/dist/bin.js", import.meta.url));
const RPC = "http://127.0.0.1:8545";
const PORT = 3399;
const rpc = (m, p) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }).then((r) => r.json());
const ok = (c, m) => { if (!c) { server.kill(); throw new Error("FAIL: " + m); } console.log("  ✓", m); };

const key = generatePrivateKey();
const me = privateKeyToAccount(key).address;
await rpc("hardhat_setBalance", [me, "0xDE0B6B3A7640000"]);
const nonce = async () => (await rpc("eth_getTransactionCount", [me, "latest"])).result;
const before = await nonce();

const server = spawn(BIN.endsWith(".js") ? "node" : BIN, BIN.endsWith(".js") ? [BIN, "--http", "--port", String(PORT)] : ["--http", "--port", String(PORT)], {
  env: { ...process.env, KUDO_PRIVATE_KEY: key, KUDO_AGENT_ID: "1", KUDO_RPC_URL: RPC },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
server.stderr.on("data", (d) => (stderr += d));
for (let i = 0; i < 50; i++) {
  try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
}

console.log("kudo-mcp --http with KUDO_PRIVATE_KEY set");
ok(/ignored: the HTTP server never signs/.test(stderr), "warns that the key is ignored");
const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
ok(health.signing === false, "/health reports signing: false");

let id = 0;
const call = async (method, params) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  return (await r.json()).result;
};
await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
const names = (await call("tools/list", {})).tools.map((t) => t.name);
ok(names.includes("send_signed_transaction") && !names.some((n) => /pay|transfer/.test(n)), "unsigned tool set: broadcast offered, nothing moves tokens");
for (const [name, args] of [
  ["register_agent", { name: "Should Not Sign" }],
  ["mint_covenant", { type: "LOAN", ask: "Lend me 1 USDG for gas.", promise: "I'll repay 1.1 USDG within one day." }],
  ["meet_ask", { id: 108, proof: "https://ipfs.io/ipfs/x" }],
  ["link_proof", { id: 108, proof: "0xabc" }],
]) {
  const r = await call("tools/call", { name, arguments: args });
  const out = JSON.parse(r.content[0].text);
  ok(out.signed === false || out.code === "ALREADY_MET", `${name}: ${out.signed === false ? "unsigned transaction returned" : `refused (${out.code})`}, nothing signed`);
}
ok((await nonce()) === before, `the key's account sent no transaction (nonce still ${parseInt(before, 16)})`);
server.kill();
console.log("http mode refuses to sign: all checks passed");
