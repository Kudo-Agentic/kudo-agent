// Full covenant lifecycle with real signatures against a local fork of
// Robinhood Chain mainnet: register, mint, meet ask, pay USDG, link proof,
// and every guard rail. Run through ./run.sh.
import { createWalletClient, http, erc20Abi, parseUnits, formatUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKudo, robinhood } from "@kudo-dev/sdk";

const RPC = "http://127.0.0.1:8545";
const CARTE = "0xFB9A9eB13B4Cf30963DCC0A0cbc5598Cc03B2cf3";
const rpc = (method, params) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());
const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const mk = (key) => { const account = privateKeyToAccount(key); return { account, kudo: createKudo({ rpcUrl: RPC, walletClient: createWalletClient({ account, chain, transport: http(RPC) }) }) }; };
const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };
const expectErr = async (p, code, m) => { try { await p; throw new Error("FAIL (no error): " + m); } catch (e) { if (e.message.startsWith("FAIL")) throw e; ok(e.code === code, `${m} → ${e.code}: ${e.message.slice(0, 90)}`); } };

const A = mk(generatePrivateKey()), B = mk(generatePrivateKey());
for (const w of [A, B]) await rpc("hardhat_setBalance", [w.account.address, "0xDE0B6B3A7640000"]);
await rpc("hardhat_impersonateAccount", [CARTE]);
await rpc("hardhat_setBalance", [CARTE, "0xDE0B6B3A7640000"]);

console.log("register");
const { agentId, hash: regHash } = await A.kudo.registerAgent({ name: "ForkTest Ada", metadata: { endpoint: "https://ada.example" } });
const info = await A.kudo.getAgent(agentId);
ok(info.owner === A.account.address && info.name === "ForkTest Ada", `agent ${agentId} owned by A, named (${regHash.slice(0,10)})`);
await expectErr(A.kudo.registerAgent({ name: "again" }), "ALREADY_REGISTERED", "second registration refused");

console.log("mint");
const ask = "Write a 300-word ERC-8004 explainer and publish it on IPFS.";
const promise = "I'll pay 5 USDG within one hour of the link going up.";
const { covenantId, url } = await A.kudo.mintCovenant({ agentId, type: "INVOICE", ask, promise });
let c = await A.kudo.getCovenant(covenantId);
ok(c.ask === ask && c.promise === promise && c.type === "INVOICE" && c.agentId === agentId && c.stage === "ask-open", `covenant ${covenantId} minted, text intact, ask-open (${url})`);
ok((await B.kudo.listOpenAsks()).some(x => x.id === covenantId), "shows up in B's open asks");
ok(!(await A.kudo.listOpenAsks()).some(x => x.id === covenantId), "hidden from A's own open asks");
await expectErr(B.kudo.mintCovenant({ agentId, type: "LOAN", ask: "Lend me 5 USDG", promise: "I'll repay 5.1 USDG" }), "NOT_AGENT_OWNER", "B cannot mint under A's id");

console.log("meet ask");
await expectErr(A.kudo.meetAsk(covenantId, { proof: "https://x" }), "INVALID_INPUT", "A cannot meet own ask");
await B.kudo.meetAsk(covenantId, { proof: "https://ipfs.io/ipfs/bafyforktest", promiseDetail: `pay: ${B.account.address}` });
c = await A.kudo.getCovenant(covenantId);
ok(c.stage === "promise-due" && c.askProof.includes("bafyforktest") && c.promiseDetail.includes(B.account.address), "B met the ask; promise-due with B's pay address");
await expectErr(B.kudo.meetAsk(covenantId, { proof: "https://y" }), "ALREADY_MET", "second meet refused");

console.log("pay + prove");
// fund A with 10 USDG from an unlocked mainnet holder
const usdg = A.kudo.network.usdg;
const fund = await rpc("eth_sendTransaction", [{ from: CARTE, to: usdg, data: (await import("viem")).encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [A.account.address, parseUnits("10", 6)] }) }]);
if (fund.error) console.log(fund.error); ok(!fund.error, "funded A with 10 USDG from a forked holder");
const before = await B.kudo.usdgBalance(B.account.address);
const { hash: payHash } = await A.kudo.payUsdg({ to: B.account.address, amount: "5" });
ok(Number(await B.kudo.usdgBalance(B.account.address)) - Number(before) === 5, `B received 5 USDG (${payHash.slice(0,10)})`);
await expectErr(B.kudo.linkProof(covenantId, payHash), "NOT_PROMISER", "B cannot link A's promise");
try { await A.kudo.payUsdg({ to: B.account.address, amount: "1000" }); throw new Error("FAIL: overspend sent"); } catch (e) { if (e.message.startsWith("FAIL")) throw e; ok(Number(await A.kudo.usdgBalance()) === 5, `overspend stopped before sending (${e.code}); A still holds 5 USDG`); }
const watching = A.kudo.watchSettlement(covenantId, { until: ["awaiting-evaluation"], intervalMs: 500, timeoutMs: 60000 });
await A.kudo.linkProof(covenantId, payHash);
c = await watching;
ok(c.stage === "awaiting-evaluation" && c.promiseProof === payHash, "A linked proof; watchSettlement saw awaiting-evaluation");

const rec = await A.kudo.agentRecord(agentId);
ok(rec.covenants.total === 1 && rec.covenants.open === 1, "agentRecord counts it");
