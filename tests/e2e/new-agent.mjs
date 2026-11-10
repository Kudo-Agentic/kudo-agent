// A brand-new agent through each front end, against the local fork: it has no
// ERC-8004 identity and no KUDO_AGENT_ID anywhere. It registers with the front
// end's own register tool or action, and must then mint under that id without
// being told it, and find it again after a restart. Run through ./run.sh.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKudo, robinhood } from "@kudo-dev/sdk";
import { getKudo, kudoPlugin } from "@kudo-dev/plugin-kudo";

const MCP = fileURLToPath(new URL("../../packages/mcp/dist/bin.js", import.meta.url));
const RPC = "http://127.0.0.1:8545";
const rpc = (m, p) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }).then((r) => r.json());
const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const reader = createKudo({ rpcUrl: RPC });

/** A funded wallet that owns no identity. */
async function newWallet() {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  await rpc("hardhat_setBalance", [account.address, "0xDE0B6B3A7640000"]);
  ok((await reader.findAgentIds(account.address)).length === 0, `${account.address.slice(0, 10)}… owns no identity`);
  return { key, account };
}
const text = (r) => JSON.parse(r.content[0].text);
async function mcp(env) {
  const c = new Client({ name: "e2e-new-agent", version: "0" });
  // No KUDO_AGENT_ID: the server has to find the id itself.
  await c.connect(new StdioClientTransport({ command: "node", args: [MCP], env: { PATH: process.env.PATH, KUDO_RPC_URL: RPC, ...env } }));
  return c;
}
const LOAN = { type: "LOAN", ask: "Lend me 2 USDG for gas.", promise: "I'll repay 2.1 USDG within one day." };
const minter = async (covenantId) => (await reader.getCovenant(covenantId)).agentId.toString();

console.log("MCP stdio (signing): register, then mint with no agentId");
{
  const { key, account } = await newWallet();
  let c = await mcp({ KUDO_PRIVATE_KEY: key });
  const before = await c.callTool({ name: "mint_covenant", arguments: LOAN });
  ok(before.isError && /Call register first/.test(before.content[0].text), "mint before registering is refused, nothing sent");
  const reg = text(await c.callTool({ name: "register", arguments: { name: "New Agent" } }));
  ok(reg.signed && reg.agentId, `register: agent ${reg.agentId}`);
  const owner = (await reader.getAgent(reg.agentId)).owner;
  ok(owner === account.address, "the new identity belongs to the signing wallet");
  const m = text(await c.callTool({ name: "mint_covenant", arguments: LOAN }));
  ok(m.signed && (await minter(m.covenantId)) === reg.agentId, `mint_covenant minted ${m.covenantId} under agent ${reg.agentId}`);
  const w = text(await c.callTool({ name: "get_wallet", arguments: {} }));
  ok(w.agentIds.includes(reg.agentId), "get_wallet lists it");
  await c.close();

  c = await mcp({ KUDO_PRIVATE_KEY: key });
  const again = text(await c.callTool({ name: "mint_covenant", arguments: LOAN }));
  ok(again.signed && (await minter(again.covenantId)) === reg.agentId, `after a restart, minted ${again.covenantId} under agent ${reg.agentId}`);
  await c.close();
}

console.log("MCP stdio (unsigned): the wallet sends register itself, then mints with only `from`");
{
  const { account } = await newWallet();
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const send = async (t) => {
    const hash = await wallet.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value) });
    const receipt = await reader.publicClient.waitForTransactionReceipt({ hash });
    ok(receipt.status === "success", `own wallet sent ${hash.slice(0, 10)}`);
    return receipt;
  };
  const c = await mcp({});
  const reg = text(await c.callTool({ name: "register", arguments: { name: "New Unsigned Agent", from: account.address } }));
  ok(reg.signed === false, "register returns an unsigned transaction");
  await send(reg.unsignedTransaction);
  const id = (await reader.findRegisteredAgentId(account.address)).toString();
  const m = text(await c.callTool({ name: "mint_covenant", arguments: { ...LOAN, from: account.address } }));
  ok(m.signed === false && m.simulated.startsWith("ok"), `mint_covenant with only from: dry-run ok as ${account.address.slice(0, 10)}…`);
  const covenantId = reader.mintedId(await send(m.unsignedTransaction));
  ok((await minter(covenantId)) === id, `minted ${covenantId} under agent ${id}, the one that wallet registered`);
  await c.close();
}

console.log("ElizaOS plugin (signing): REGISTER_KUDO_AGENT, then MINT_COVENANT");
{
  const { key, account } = await newWallet();
  let reply = "{}";
  const runtime = {
    agentId: crypto.randomUUID(),
    getSetting: (k) => ({ KUDO_PRIVATE_KEY: key, KUDO_RPC_URL: RPC })[k] ?? null,
    useModel: async () => reply,
  };
  const run = async (name, message) => {
    let said = "";
    const res = await kudoPlugin.actions.find((a) => a.name === name).handler(runtime, { content: { text: message } }, undefined, undefined, async (m) => { said = m.text; return []; });
    return { res, said: said.trim() };
  };
  // The id the plugin's tools and its provider share. (Not the provider itself: it also lists
  // every covenant, which on an unwarmed fork is too slow. It is checked against mainnet.)
  const known = async () => (await (await getKudo(runtime)).agentIds.of())?.toString();

  ok((await known()) === undefined, "the plugin finds no identity yet");
  reply = JSON.stringify(LOAN);
  const early = await run("MINT_COVENANT", "mint a loan");
  ok(/REGISTER_KUDO_AGENT/.test(early.said), `MINT_COVENANT before registering: "${early.said}"`);

  reply = JSON.stringify({ name: "New Eliza Agent" });
  const reg = await run("REGISTER_KUDO_AGENT", "register yourself on Kudo as New Eliza Agent");
  const id = reg.said.match(/Registered as agent (\d+)/)?.[1];
  ok(id && (await reader.getAgent(id)).owner === account.address, `REGISTER_KUDO_AGENT: "${reg.said}"`);
  ok((await known()) === id, `the plugin now knows agent ${id}`);

  reply = JSON.stringify(LOAN);
  const mint = await run("MINT_COVENANT", "mint a loan");
  const covenant = mint.said.match(/Minted covenant (\d+)/)?.[1];
  ok(covenant && (await minter(covenant)) === id, `MINT_COVENANT: "${mint.said}", under agent ${id}`);
}

console.log("new agents: all checks passed");
process.exit(0);
