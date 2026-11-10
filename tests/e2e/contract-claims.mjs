// Records what the deployed Kudo contract itself allows around claims, on a
// mainnet fork. Not a pass/fail test of our code: the output goes in the PR.
//   node contract-claims.mjs   (fork on :8545)
import { createPublicClient, createWalletClient, http, parseEventLogs } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { kudoAbi, identityRegistryAbi, robinhood } from "@kudo-dev/sdk";
const RPC = "http://127.0.0.1:8545", K = "0x1930D0FEaB14b024353bF22adE03Db989aD640C7", REG = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const rpc = (method, params) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
const w = async () => { const a = privateKeyToAccount(generatePrivateKey()); await rpc("hardhat_setBalance", [a.address, "0x2386F26FC10000"]); return createWalletClient({ account: a, chain, transport: http(RPC) }); };
const send = async (wc, args) => { try { const h = await wc.writeContract({ address: K, abi: kudoAbi, ...args }); const r = await pub.waitForTransactionReceipt({ hash: h }); return r.status; } catch (e) { return "REVERT " + (e.shortMessage ?? e.message).split("\n")[0]; } };
const settled = (id) => pub.readContract({ address: K, abi: kudoAbi, functionName: "isAskSettled", args: [id] });
const proof = async (id) => (await pub.readContract({ address: K, abi: kudoAbi, functionName: "getCovenant", args: [id] })).askSettlementData;
const time = async (s) => { await rpc("evm_increaseTime", [s]); await rpc("evm_mine", []); };
const M = await w(), B = await w(), E = await w();
const reg = await M.writeContract({ address: REG, abi: identityRegistryAbi, functionName: "register", args: ["", []] });
const agentId = parseEventLogs({ abi: identityRegistryAbi, eventName: "Registered", logs: (await pub.waitForTransactionReceipt({ hash: reg })).logs })[0].args.agentId;
await send(M, { functionName: "mintCovenant", args: [agentId, "p", "a", "LOAN"] });
const id = (await pub.readContract({ address: K, abi: kudoAbi, functionName: "getTotalCovenants" })) - 1n;
console.log("cooldown", await pub.readContract({ address: K, abi: kudoAbi, functionName: "getAskCooldown" }), "covenant", id);
console.log("minted:          isAskSettled", await settled(id));
console.log("bob claims:     ", await send(B, { functionName: "setAskSettlementData", args: [id, "bob", "pay: bob"] }), "isAskSettled", await settled(id));
await time(60); console.log("+60s:            isAskSettled", await settled(id));
await time(61); console.log("+121s:           isAskSettled", await settled(id));
console.log("eve overwrites: ", await send(E, { functionName: "setAskSettlementData", args: [id, "eve", "pay: eve"] }), "proof", await proof(id), "isAskSettled", await settled(id));
console.log("promise proof:  ", await send(M, { functionName: "setPromiseSettlementData", args: [id, "0xpaid"] }), "isAskSettled", await settled(id));
await time(121); console.log("+121s:           isAskSettled", await settled(id));
console.log("bob after that: ", await send(B, { functionName: "setAskSettlementData", args: [id, "bob-late", "pay: bob"] }), "proof", await proof(id));
