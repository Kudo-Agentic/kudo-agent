// The write path through each front end, with real signatures against the
// local fork: the MCP server (signing, and unsigned with the caller's own wallet sending)
// and the ElizaOS plugin. Run through ./run.sh.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKudo, robinhood } from "@kudo-dev/sdk";
import { kudoPlugin } from "@kudo-dev/plugin-kudo";
import { acceptAsk } from "./validator.mjs";

const MCP = fileURLToPath(new URL("../packages/mcp/dist/bin.js", import.meta.url));
const RPC = "http://127.0.0.1:8545";
const rpc = (m, p) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }).then((r) => r.json());
const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };

const key = generatePrivateKey();
const acct = privateKeyToAccount(key);
await rpc("hardhat_setBalance", [acct.address, "0xDE0B6B3A7640000"]);
const env = { ...process.env, KUDO_RPC_URL: RPC, KUDO_PRIVATE_KEY: key };
const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const sdk = createKudo({ rpcUrl: RPC, walletClient: createWalletClient({ account: acct, chain, transport: http(RPC) }) });

console.log("SDK (signing)");
const { agentId } = await sdk.registerAgent({ name: "Fork Agent" });
const reg = { agentId: agentId.toString() };
ok(reg.agentId, `registered agent ${reg.agentId}`);
env.KUDO_AGENT_ID = reg.agentId;
const minted = await sdk.mintCovenant({ agentId, type: "ADVANCE", ask: "Pay me 3 USDG up front for a logo.", promise: "I'll deliver the logo as a PNG on IPFS within one day." });
const mint = { covenantId: minted.covenantId.toString() };
ok(mint.covenantId, `minted covenant ${mint.covenantId}`);
// A counterparty meets the ask and the validator accepts it, so the promise is due and set_promise_settlement_data below is allowed.
const payer = privateKeyToAccount(generatePrivateKey());
await rpc("hardhat_setBalance", [payer.address, "0xDE0B6B3A7640000"]);
await createKudo({ rpcUrl: RPC, walletClient: createWalletClient({ account: payer, chain, transport: http(RPC) }) }).meetAsk(mint.covenantId, { proof: "0x" + "12".repeat(32) });
await acceptAsk(RPC, mint.covenantId);

console.log("MCP stdio (signing)");
const c = new Client({ name: "e2e", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: [MCP], env }));
const tools = (await c.listTools()).tools.map((t) => t.name);
ok(!tools.some((n) => /pay|transfer/.test(n)), `no tool moves tokens (${tools.length} tools)`);
const hc = JSON.parse((await c.callTool({ name: "get_wallet", arguments: {} })).content[0].text);
ok(hc.signing === true && hc.wallet === acct.address && hc.agentIds.includes(reg.agentId), "get_wallet sees the signer and its agent id");
const mm = await c.callTool({ name: "mint_covenant", arguments: { type: "LOAN", ask: "Lend me 2 USDG for gas.", promise: "I'll repay 2.1 USDG within one day." } });
const mr = JSON.parse(mm.content[0].text);
ok(!mm.isError && mr.signed && mr.covenantId, `mint_covenant signed covenant ${mr.covenantId}`);
await c.close();

console.log("ElizaOS plugin (signing)");
const runtime = {
  getSetting: (k) => ({ KUDO_PRIVATE_KEY: key, KUDO_AGENT_ID: reg.agentId, KUDO_RPC_URL: RPC })[k] ?? null,
  useModel: async () => JSON.stringify({ type: "INVOICE", ask: "Review my README and open a PR with fixes.", promise: "I'll pay 4 USDG within one day of the PR." }),
};
const action = kudoPlugin.actions.find((a) => a.name === "MINT_COVENANT");
ok(await action.validate(runtime, { content: { text: "" } }), "MINT_COVENANT validates with a key");
let said = "";
const res = await action.handler(runtime, { content: { text: "mint an invoice for a README review, 4 USDG" } }, undefined, undefined, async (m) => { said = m.text; return []; });
ok(res.success && /Minted covenant \d+/.test(said), `handler: "${said.trim()}"`);
const prov = await kudoPlugin.providers[0].get(runtime, { content: {} }, {});
ok(prov.text.includes(acct.address), "KUDO provider reports the signer");

console.log("MCP unsigned → own wallet signs and sends");
const envU = { ...env };
delete envU.KUDO_PRIVATE_KEY;
const u = new Client({ name: "e2e-unsigned", version: "0" });
await u.connect(new StdioClientTransport({ command: "node", args: [MCP], env: envU }));
const ur = JSON.parse((await u.callTool({ name: "set_promise_settlement_data", arguments: { id: mint.covenantId, proof: "https://ipfs.io/ipfs/bafylogo", from: acct.address } })).content[0].text);
ok(ur.signed === false && ur.simulated.startsWith("ok"), "unsigned set_promise_settlement_data, dry-run ok as owner");
const w = createWalletClient({ account: acct, chain: { ...robinhood, rpcUrls: { default: { http: [RPC] } } }, transport: http(RPC) });
const t = ur.unsignedTransaction;
const signed = await w.signTransaction(await w.prepareTransactionRequest({ to: t.to, data: t.data, value: BigInt(t.value) }));
const hash = await w.sendRawTransaction({ serializedTransaction: signed });
const receipt = await sdk.publicClient.waitForTransactionReceipt({ hash });
ok(receipt.status === "success", `own wallet sent ${hash.slice(0, 10)}`);
ok(!(await u.listTools()).tools.some((x) => /send|broadcast/.test(x.name)), "no broadcast tool in unsigned mode");
const cov = JSON.parse((await u.callTool({ name: "get_covenant", arguments: { id: mint.covenantId } })).content[0].text);
ok(cov.promiseProof === "https://ipfs.io/ipfs/bafylogo", "proof is on chain");
await u.close();
