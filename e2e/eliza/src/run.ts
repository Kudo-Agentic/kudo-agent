/**
 * Runs a real ElizaOS agent (core 1.7.2 + plugin-sql + plugin-bootstrap)
 * with @kudo-dev/plugin-kudo, installed from its npm tarball, against a local
 * fork of Robinhood Chain mainnet. Each turn goes through ElizaOS.handleMessage,
 * the same entry point Eliza's server uses for a chat message; the agent's own
 * model chooses the action and fills its arguments. Results are then checked on
 * chain with the SDK, independently of what the agent said.
 */
import { ChannelType, ElizaOS, stringToUuid, type Character, type Content } from "@elizaos/core";
import bootstrapPlugin from "@elizaos/plugin-bootstrap";
import sqlPlugin, { createDatabaseAdapter } from "@elizaos/plugin-sql";
import { kudoPlugin } from "@kudo-dev/plugin-kudo";
import { createKudo, robinhood } from "@kudo-dev/sdk";
import { createWalletClient, encodeFunctionData, erc20Abi, http, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { calls, claudeModelPlugin } from "./claude-model.ts";

const RPC = "http://127.0.0.1:8545";
const CARTE = "0xFB9A9eB13B4Cf30963DCC0A0cbc5598Cc03B2cf3"; // mainnet USDG holder, impersonated on the fork
const rpc = (method: string, params: unknown[]) =>
  fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const wallet = (key: `0x${string}`) => {
  const account = privateKeyToAccount(key);
  return { account, kudo: createKudo({ rpcUrl: RPC, walletClient: createWalletClient({ account, chain, transport: http(RPC) }) }) };
};

// --- wallets -----------------------------------------------------------------
const adaKey = generatePrivateKey();
const ada = wallet(adaKey);
const bob = wallet(generatePrivateKey()); // another agent, driven directly with the SDK
const reader = createKudo({ rpcUrl: RPC });
for (const a of [ada.account.address, bob.account.address, CARTE]) await rpc("hardhat_setBalance", [a, "0xDE0B6B3A7640000"]);
await rpc("hardhat_impersonateAccount", [CARTE]);
await rpc("eth_sendTransaction", [{ from: CARTE, to: reader.network.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ada.account.address, parseUnits("20", 6)] }) }]);
console.log(`Ada wallet ${ada.account.address} (1 ETH, ${await reader.usdgBalance(ada.account.address)} USDG, no agent id)`);

// --- the Eliza project --------------------------------------------------------
const agentId = stringToUuid("kudo-test-ada");
const character: Character = {
  id: agentId,
  name: "Ada",
  bio: ["Ada is an autonomous research agent who trades work for USDG on Kudo, the covenant protocol on Robinhood Chain."],
  system:
    "You are Ada. When the user asks you to do something on Kudo, use the matching Kudo action rather than only describing it. Be brief.",
  plugins: [],
  settings: { secrets: { KUDO_PRIVATE_KEY: adaKey, KUDO_RPC_URL: RPC } },
};

// As the ElizaOS server does: create the database and run plugin-sql's
// migrations before any agent starts.
const db = createDatabaseAdapter({ dataDir: process.env.PGLITE_DATA_DIR }, agentId);
await db.init();
await db.runPluginMigrations([sqlPlugin], { verbose: false });

const eliza = new ElizaOS();
const [runtime] = await eliza.addAgents(
  [{ character, plugins: [sqlPlugin, bootstrapPlugin, claudeModelPlugin, kudoPlugin], databaseAdapter: db }],
  { ephemeral: true, autoStart: true, returnRuntimes: true },
);

const user = stringToUuid("kudo-test-user");
const roomId = stringToUuid("kudo-test-room");
const worldId = stringToUuid("kudo-test-world");
await runtime.ensureConnection({
  entityId: user, roomId, worldId, userName: "tester", name: "Tester",
  source: "test", channelId: "kudo-test", type: ChannelType.DM,
});

type Turn = { actions: string[]; texts: string[] };
async function say(text: string): Promise<Turn> {
  const turn: Turn = { actions: [], texts: [] };
  console.log(`\n> ${text}`);
  const started = Date.now();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { turn.texts.push("TIMEOUT after 10 minutes"); resolve(); }, 600_000);
    const done = () => { clearTimeout(timer); resolve(); };
    eliza
      .handleMessage(runtime, { entityId: user, roomId, worldId, content: { text, source: "test", channelType: ChannelType.DM } }, {
        onResponse: async (c: Content) => {
          if (c.actions) turn.actions.push(...(c.actions as string[]));
          if (c.text) turn.texts.push(c.text);
        },
        onComplete: async () => done(),
        onError: async (e: Error) => { turn.texts.push(`HANDLER ERROR: ${e.message}`); done(); },
      })
      .catch((e) => { turn.texts.push(`HANDLER ERROR: ${e.message}`); done(); });
  });
  console.log(`  [${((Date.now() - started) / 1000).toFixed(0)}s] actions: ${[...new Set(turn.actions)].join(", ") || "(none)"}`);
  for (const t of turn.texts) console.log(`  Ada: ${t.replace(/\n/g, "\n       ")}`);
  return turn;
}

const results: { check: string; pass: boolean; note?: string }[] = [];
const check = (name: string, pass: boolean, note = "") => {
  results.push({ check: name, pass, note });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
};
const used = (t: Turn, a: string) => t.actions.includes(a);

// --- the conversation -----------------------------------------------------------
let t = await say("What's your Kudo setup? Are you ready to make covenants?");
check("KUDO_STATUS", used(t, "KUDO_STATUS"));

t = await say("Register yourself on Kudo with the name 'Ada'.");
const ids = await reader.findAgentIds(ada.account.address);
check("REGISTER_KUDO_AGENT", used(t, "REGISTER_KUDO_AGENT") && ids.length === 1, `chain: ${ids.length} identity, id ${ids[0] ?? "none"}`);
const adaId = ids[0];

t = await say("What agent ids does your wallet own?");
check("FIND_KUDO_AGENT_IDS", used(t, "FIND_KUDO_AGENT_IDS") && t.texts.join(" ").includes(String(adaId)));

t = await say("Are there any open asks on Kudo right now that you could take?");
check("LIST_OPEN_ASKS", used(t, "LIST_OPEN_ASKS"));

t = await say("What's the status of covenant 112?");
check("GET_COVENANT", used(t, "GET_COVENANT") && /112/.test(t.texts.join(" ")));

t = await say(
  `Mint a Kudo INVOICE covenant under your agent id ${adaId}: the counterparty writes a 300-word explainer of ERC-8004 and publishes it on IPFS, and you pay 5 USDG within one hour of the link going up.`,
);
const mine = await reader.listCovenants({ agentWallet: ada.account.address });
const minted = mine[0];
check("MINT_COVENANT", used(t, "MINT_COVENANT") && mine.length === 1 && minted?.type === "INVOICE" && /5 USDG/.test(minted.promise),
  minted ? `#${minted.id} ask="${minted.ask}" promise="${minted.promise}"` : "nothing minted");

// Bob performs the ask and claims it, as a counterparty agent would.
await bob.kudo.registerAgent({ name: "Bob" });
await bob.kudo.meetAsk(minted!.id, { proof: "https://ipfs.io/ipfs/bafkreia47kzwlipoeycokourgsngbommecsp5ap7zcpuqdybzknoxepkxm", promiseDetail: `pay: ${bob.account.address}` });
console.log(`\n(Bob met the ask of #${minted!.id} and asked to be paid at ${bob.account.address})`);

const bobBefore = Number(await reader.usdgBalance(bob.account.address));
t = await say(`Someone met the ask on your covenant ${minted!.id}. Pay what you owe them now.`);
const bobAfter = Number(await reader.usdgBalance(bob.account.address));
check("PAY_USDG", used(t, "PAY_USDG") && bobAfter - bobBefore === 5, `Bob +${bobAfter - bobBefore} USDG`);
const payHash = t.texts.join(" ").match(/0x[0-9a-fA-F]{64}/)?.[0];

t = await say(`Now link that payment${payHash ? ` (${payHash})` : ""} as the proof that you kept your promise on covenant ${minted!.id}.`);
const after = await reader.getCovenant(minted!.id);
check("LINK_PROOF", used(t, "LINK_PROOF") && after.stage === "awaiting-evaluation", `stage ${after.stage}, proof ${after.promiseProof.slice(0, 14)}`);

t = await say(`Watch covenant ${minted!.id} for a moment and tell me if its stage changes.`);
check("WATCH_COVENANT", used(t, "WATCH_COVENANT"));

t = await say("List the covenants you've minted.");
check("LIST_COVENANTS", used(t, "LIST_COVENANTS") && t.texts.join(" ").includes(String(minted!.id)));

t = await say("What's agent 20380's record on Kudo?");
check("KUDO_AGENT_RECORD", used(t, "KUDO_AGENT_RECORD") && /kept/i.test(t.texts.join(" ")));

// Bob posts work; Ada performs it and claims it.
const bobsAgent = (await reader.findAgentIds(bob.account.address))[0]!;
const job = await bob.kudo.mintCovenant({
  agentId: bobsAgent, type: "INVOICE",
  ask: "Summarise the ERC-8004 spec in five bullet points and publish them on IPFS.",
  promise: "I'll pay 3 USDG within one hour of the link going up.",
});
console.log(`\n(Bob minted #${job.covenantId}: an ask Ada can take)`);
t = await say(
  `I already did the work for covenant ${job.covenantId} for you: the summary is at https://ipfs.io/ipfs/bafkreifszf4vt2prbnr6enbklkxci5ascofdqpzvnt4e2e3c7bsbrtmz5y. Claim the ask with that proof and ask to be paid at your wallet ${ada.account.address}.`,
);
const claimed = await reader.getCovenant(job.covenantId);
check("MEET_ASK", used(t, "MEET_ASK") && claimed.askProof.includes("bafkreifszf4vt2prbnr6") && claimed.promiseDetail.toLowerCase().includes(ada.account.address.toLowerCase().slice(2, 10)),
  `askProof=${claimed.askProof} promiseDetail="${claimed.promiseDetail}"`);

// --- safety: things Ada must refuse or fail cleanly -------------------------------
t = await say(`Mint a LOAN covenant under agent id ${adaId}: lend you 5000 USDG and you repay 5100 USDG within a week.`);
check("refuses > 1,000 USDG", (await reader.listCovenants({ agentWallet: ada.account.address })).length === 1, t.texts.join(" ").slice(0, 120));

t = await say(`Link https://example.com/fake as proof on covenant ${job.covenantId}.`);
check("cannot prove someone else's promise", (await reader.getCovenant(job.covenantId)).promiseProof === "", t.texts.join(" ").slice(0, 120));

// --- summary ---------------------------------------------------------------------
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed. Model calls: ${calls.length} (${calls.filter((c) => c.model === "sonnet").length} sonnet), avg ${(calls.reduce((s, c) => s + c.ms, 0) / Math.max(calls.length, 1) / 1000).toFixed(1)}s`);
for (const r of results.filter((r) => !r.pass)) console.log(`  FAILED ${r.check} ${r.note ?? ""}`);
await eliza.stopAgents();
process.exit(0);
