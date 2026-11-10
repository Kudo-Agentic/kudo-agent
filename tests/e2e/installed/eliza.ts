// The /connect ElizaOS route, as installed: `bun add @kudo-dev/plugin-kudo`
// (run by run.sh, verbatim), then a real ElizaOS runtime whose character is
// the page's character JSON. Each plugin it names is loaded by that name from
// node_modules. Two chat turns: register, then mint; both checked on chain.
//   bun eliza.ts <key> <rpc>    (cwd: the clean bun dir)
import { ChannelType, ElizaOS, stringToUuid, type Character, type Content, type Plugin } from "@elizaos/core";
import sqlPlugin, { createDatabaseAdapter } from "@elizaos/plugin-sql";
import { createKudo } from "@kudo-dev/sdk";

import { claudeModelPlugin } from "./claude-model.ts";
import { fill, snippet } from "./snippets.mjs";

const [key, rpc] = process.argv.slice(2);
let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) fail++; };

const fromPage = JSON.parse(fill(snippet("eliza-character"), { key, agentId: "" }));
// No agent id yet, as the page's note describes; the agent registers itself.
delete fromPage.settings.secrets.KUDO_AGENT_ID;
const plugins: Plugin[] = [];
for (const name of fromPage.plugins as string[]) {
  const mod = await import(name);
  plugins.push((mod.default ?? Object.values(mod).find((v: any) => v?.name && v?.actions)) as Plugin);
}
ok(plugins.every(Boolean) && plugins.some((p) => p.name === "kudo"), `character plugins load by name: ${fromPage.plugins.join(", ")}`);

const agentId = stringToUuid("installed-ada");
const character: Character = {
  id: agentId,
  name: "Ada",
  bio: ["Ada trades work for USDG on Kudo, the covenant protocol on Robinhood Chain."],
  system: "You are Ada. When asked to do something on Kudo, use the matching Kudo action. Be brief.",
  plugins: [],
  settings: { ...fromPage.settings, secrets: { ...fromPage.settings.secrets, KUDO_RPC_URL: rpc } },
};
const db = createDatabaseAdapter({ dataDir: process.env.PGLITE_DATA_DIR }, agentId);
await db.init();
await db.runPluginMigrations([sqlPlugin], { verbose: false });
const eliza = new ElizaOS();
const [runtime] = await eliza.addAgents([{ character, plugins: [sqlPlugin, ...plugins, claudeModelPlugin], databaseAdapter: db }], { ephemeral: true, autoStart: true, returnRuntimes: true });
const user = stringToUuid("u"), roomId = stringToUuid("r"), worldId = stringToUuid("w");
await runtime.ensureConnection({ entityId: user, roomId, worldId, userName: "t", name: "T", source: "test", channelId: "c", type: ChannelType.DM });
const say = (text: string) =>
  new Promise<string[]>((resolve) => {
    const actions: string[] = [];
    const timer = setTimeout(() => resolve(actions), 600_000);
    eliza.handleMessage(runtime, { entityId: user, roomId, worldId, content: { text, source: "test", channelType: ChannelType.DM } }, {
      onResponse: async (c: Content) => { if (c.actions) actions.push(...(c.actions as string[])); },
      onComplete: async () => { clearTimeout(timer); resolve(actions); },
      onError: async () => { clearTimeout(timer); resolve(actions); },
    }).catch(() => resolve(actions));
  });

const reader = createKudo({ rpcUrl: rpc });
const me = (await import("viem/accounts")).privateKeyToAccount(key as `0x${string}`).address;
// The wallet already holds an identity (run.sh registered it), so the agent should find it, not register again.
let a = await say("Register yourself on Kudo with the name 'Installed Ada', unless you already have an identity.");
const ids = await reader.findAgentIds(me);
ok(ids.length === 1, `no second identity: the agent used its existing one (actions: ${a.join(", ")}; chain: id ${ids[0]})`);
const before = (await reader.listCovenants({ agentWallet: me })).length;
a = await say(`Mint a Kudo INVOICE covenant under your agent id ${ids[0]}: the counterparty writes a 200-word note on ERC-8004 and publishes it on IPFS; you pay 2 USDG within one hour of the link going up.`);
const mine = await reader.listCovenants({ agentWallet: me });
ok(mine.length === before + 1 && /2 USDG/.test(mine[0].promise), `MINT_COVENANT via the installed plugin (actions: ${a.join(", ")}; chain: ${mine[0] ? `#${mine[0].id} "${mine[0].promise}"` : "nothing"})`);
await eliza.stopAgents();
process.exit(fail ? 1 : 0);
