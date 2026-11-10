/**
 * Attaches @kudo-dev/mcp to a real Claude Code instance via --mcp-config
 * (the in-repo build, or KUDO_MCP_BIN, e.g. the bin of an installed tarball), against a local fork of Robinhood Chain
 * mainnet, and checks every result on chain with the SDK.
 *
 *   A. stdio, signing (KUDO_PRIVATE_KEY): the full conversation
 *   B. stdio, no key: Claude prepares, our wallet signs, Claude broadcasts
 *   C. Streamable HTTP (--http), the hosted mode
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createWalletClient, encodeFunctionData, erc20Abi, http, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKudo, robinhood } from "@kudo-dev/sdk";
import { acceptAsk } from "../validator.mjs";

const RPC = "http://127.0.0.1:8545";
const BIN = process.env.KUDO_MCP_BIN ?? new URL("../../../packages/mcp/dist/bin.js", import.meta.url).pathname;
const CARTE = "0xFB9A9eB13B4Cf30963DCC0A0cbc5598Cc03B2cf3";
const rpc = (m, p) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }).then((r) => r.json());
const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const wallet = (key) => { const account = privateKeyToAccount(key); return { key, account, client: createWalletClient({ account, chain, transport: http(RPC) }), kudo: createKudo({ rpcUrl: RPC, walletClient: createWalletClient({ account, chain, transport: http(RPC) }) }) }; };
const reader = createKudo({ rpcUrl: RPC });
const DIR = mkdtempSync(join(tmpdir(), "kudo-claude-"));

const me = wallet(generatePrivateKey());
const bob = wallet(generatePrivateKey());
for (const a of [me.account.address, bob.account.address, CARTE]) await rpc("hardhat_setBalance", [a, "0xDE0B6B3A7640000"]);
await rpc("hardhat_impersonateAccount", [CARTE]);
await rpc("eth_sendTransaction", [{ from: CARTE, to: reader.network.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [me.account.address, parseUnits("20", 6)] }) }]);
const usdgOf = async (who) => Number(await reader.publicClient.readContract({ address: reader.network.usdg, abi: erc20Abi, functionName: "balanceOf", args: [who] })) / 1e6;
console.log(`signer ${me.account.address}: 1 ETH, ${await usdgOf(me.account.address)} USDG, no agent id`);

const config = (name, server) => { const f = join(DIR, `${name}.json`); writeFileSync(f, JSON.stringify({ mcpServers: { kudo: server } })); return f; };
const signingCfg = config("signing", { command: "node", args: [BIN], env: { KUDO_PRIVATE_KEY: me.key, KUDO_RPC_URL: RPC } });
const unsignedCfg = config("unsigned", { command: "node", args: [BIN], env: { KUDO_RPC_URL: RPC } });
const httpCfg = config("http", { type: "http", url: "http://127.0.0.1:3333/mcp" });

/** One Claude Code turn; the session continues across turns of a scenario. */
function ask(cfg, session, prompt, first) {
  const args = ["-p", "--model", "sonnet", "--output-format", "stream-json", "--verbose", "--mcp-config", cfg, "--strict-mcp-config",
    "--allowedTools", "mcp__kudo", "--tools", "", ...(first ? ["--session-id", session] : ["--resume", session])];
  console.log(`\n> ${prompt}`);
  const started = Date.now();
  const r = spawnSync("claude", args, { input: prompt, cwd: DIR, encoding: "utf8", timeout: 900_000, maxBuffer: 64 << 20 });
  const tools = [], results = [];
  let text = "";
  for (const line of (r.stdout || "").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "assistant") for (const c of e.message?.content ?? []) if (c.type === "tool_use") tools.push(c.name.replace("mcp__kudo__", ""));
    if (e.type === "user") for (const c of e.message?.content ?? []) if (c.type === "tool_result") results.push(typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join(""));
    if (e.type === "result") text = e.result ?? "";
  }
  if (r.status !== 0 && !text) text = `CLAUDE EXIT ${r.status}: ${(r.stderr || "").slice(0, 300)}`;
  console.log(`  [${((Date.now() - started) / 1000).toFixed(0)}s] tools: ${tools.join(", ") || "(none)"}`);
  console.log(`  Claude: ${text.slice(0, 600).replace(/\n/g, "\n          ")}`);
  return { tools, results, text };
}

const out = [];
const check = (name, pass, note = "") => { out.push({ name, pass, note }); console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`); };

// ---------------------------------------------------------------- A. signing
console.log("\n=== A. stdio, signing ===");
const A = randomUUID();
let t = ask(signingCfg, A, "You have Kudo MCP tools. What's my Kudo setup — is this server signing for me, and do I have an agent id?", true);
check("get_wallet", t.tools.includes("get_wallet"));
t = ask(signingCfg, A, "Register me on Kudo with the name 'Claude Tester'.");
const ids = await reader.findAgentIds(me.account.address);
check("register", t.tools.includes("register") && ids.length === 1, `chain: id ${ids[0]}`);
const myId = ids[0];
t = ask(signingCfg, A, "Double-check: which agent ids does my wallet own?");
check("get_wallet (ids)", t.tools.includes("get_wallet"), t.text.includes(String(myId)) ? "mentions id" : "id not in reply");
t = ask(signingCfg, A, "Show me the open asks on Kudo.");
check("open asks via get_covenants_details", t.tools.includes("get_covenants_details"));
t = ask(signingCfg, A, "What's the status of covenant 112?");
check("get_covenant", t.tools.includes("get_covenant"));
t = ask(signingCfg, A, `Mint an INVOICE covenant under my agent ${myId}: the counterparty writes a 300-word ERC-8004 explainer and publishes it on IPFS; I pay 5 USDG within one hour of the link going up. Don't ask me to confirm the wording, just mint it.`);
const mine = await reader.listCovenants({ agentWallet: me.account.address });
check("mint_covenant", t.tools.includes("mint_covenant") && mine.length === 1 && /5 USDG/.test(mine[0]?.promise ?? ""), mine[0] ? `#${mine[0].id} "${mine[0].promise}"` : "nothing minted");
const cov = mine[0];

await bob.kudo.registerAgent({ name: "Bob" });
await bob.kudo.meetAsk(cov.id, { proof: "https://ipfs.io/ipfs/bafkreia47kzwlipoeycokourgsngbommecsp5ap7zcpuqdybzknoxepkxm", promiseDetail: `pay: ${bob.account.address}` });
await acceptAsk(RPC, cov.id);
console.log(`\n(Bob met the ask of #${cov.id}, pay to ${bob.account.address}; the validator accepted it)`);

// The server never moves tokens: the user pays from their own wallet, then
// asks Claude to link the payment.
const before = await usdgOf(bob.account.address);
const payHash = await me.client.writeContract({ address: reader.network.usdg, abi: erc20Abi, functionName: "transfer", args: [bob.account.address, parseUnits("5", 6)] });
await reader.publicClient.waitForTransactionReceipt({ hash: payHash });
console.log(`\n(I paid Bob ${(await usdgOf(bob.account.address)) - before} USDG myself in ${payHash})`);
t = ask(signingCfg, A, `Someone met the ask on covenant ${cov.id}. I paid them the 5 USDG I owed from my own wallet in transaction ${payHash}. Link that payment as the proof that I kept my promise.`);
const proved = await reader.getCovenant(cov.id);
check("no payment tool offered", !t.tools.some((n) => /pay|transfer/.test(n)), `tools: ${t.tools.join(", ")}`);
check("set_promise_settlement_data", t.tools.includes("set_promise_settlement_data") && proved.stage === "awaiting-evaluation" && proved.promiseProof === payHash, `stage ${proved.stage}`);
t = ask(signingCfg, A, "List the covenants I've minted.");
check("get_covenants_details", t.tools.includes("get_covenants_details"));
t = ask(signingCfg, A, "What's agent 20380's record?");
check("get_agent", t.tools.includes("get_agent"));

const bobId = (await reader.findAgentIds(bob.account.address))[0];
const job = await bob.kudo.mintCovenant({ agentId: bobId, type: "INVOICE", ask: "Summarise the ERC-8004 spec in five bullets on IPFS.", promise: "I'll pay 3 USDG within one hour of the link going up." });
console.log(`\n(Bob minted #${job.covenantId})`);
t = ask(signingCfg, A, `I've done the work for covenant ${job.covenantId}: https://ipfs.io/ipfs/bafkreifszf4vt2prbnr6enbklkxci5ascofdqpzvnt4e2e3c7bsbrtmz5y. Claim it and ask to be paid at my wallet ${me.account.address}.`);
const claimed = await reader.getCovenant(job.covenantId);
check("set_ask_settlement_data", t.tools.includes("set_ask_settlement_data") && claimed.askProof.includes("bafkreifszf4vt2prbnr6"), `promiseDetail="${claimed.promiseDetail}"`);
t = ask(signingCfg, A, `Link https://example.com/fake as the promise proof on covenant ${job.covenantId}.`);
check("cannot prove another's promise", (await reader.getCovenant(job.covenantId)).promiseProof === "", t.text.slice(0, 100));

// ------------------------------------------------------- B. no key, own wallet signs
console.log("\n=== B. stdio, no key ===");
const B = randomUUID();
t = ask(unsignedCfg, B, `Prepare a LOAN covenant for my agent ${bobId} from my wallet ${bob.account.address}: lend me 2 USDG for gas, I'll repay 2.1 USDG within one day. I'll sign it myself. Reply with only the unsigned transaction JSON.`, true);
const prepared = t.results.map((r) => { try { return JSON.parse(r); } catch { return null; } }).find((r) => r?.unsignedTransaction);
check("unsigned mint returned and dry-run", !!prepared && prepared.signed === false && String(prepared.simulated).startsWith("ok"), prepared?.simulated);
if (prepared) {
  const u = prepared.unsignedTransaction;
  // The server never broadcasts: Bob's own wallet signs and sends what Claude prepared.
  const countBefore = (await reader.listCovenants({ agentWallet: bob.account.address })).length;
  const hash = await bob.client.sendTransaction({ to: u.to, data: u.data, value: BigInt(u.value) });
  await reader.publicClient.waitForTransactionReceipt({ hash });
  const countAfter = (await reader.listCovenants({ agentWallet: bob.account.address })).length;
  check("own wallet sends the prepared transaction", countAfter === countBefore + 1, `Bob's covenants ${countBefore} → ${countAfter}`);
}

// ---------------------------------------------------------------- C. hosted HTTP
console.log("\n=== C. Streamable HTTP ===");
const server = spawn("node", [BIN, "--http"], { env: { ...process.env, PORT: "3333", KUDO_RPC_URL: RPC, KUDO_PRIVATE_KEY: me.key }, stdio: ["ignore", "ignore", "pipe"] });
let serverLog = ""; server.stderr.on("data", (d) => (serverLog += d));
for (let i = 0; i < 30; i++) { try { await fetch("http://127.0.0.1:3333/health"); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
check("HTTP server ignores the key", /ignored/.test(serverLog), serverLog.split("\n")[0]);
const C = randomUUID();
t = ask(httpCfg, C, `Using Kudo: read covenant ${cov.id}, then prepare (don't sign) a set_promise_settlement_data of https://example.com/x on it from wallet ${me.account.address}. Is the server signing?`, true);
check("HTTP read + unsigned write", t.tools.includes("get_covenant") && t.tools.includes("set_promise_settlement_data") && (await reader.getCovenant(cov.id)).promiseProof !== "https://example.com/x", `tools: ${t.tools.join(", ")}`);
server.kill();

const passed = out.filter((r) => r.pass).length;
console.log(`\n${passed}/${out.length} checks passed`);
for (const r of out.filter((r) => !r.pass)) console.log(`  FAILED ${r.name} ${r.note}`);
process.exit(passed === out.length ? 0 : 1);
