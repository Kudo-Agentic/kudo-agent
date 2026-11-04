/**
 * `kudo` — the SDK's tools from a shell, so any agent that can run a command
 * can use Kudo with nothing but `npx @kudo-archi/sdk`.
 *
 * Output is always JSON on stdout; errors are JSON on stderr with exit code 1.
 */
import { parseArgs } from "node:util";

import { kudoFromEnv } from "./env.js";
import { kudoTools, runTool } from "./tools.js";

const HELP = `kudo — Kudo covenants on Robinhood Chain

Usage: npx @kudo-archi/sdk <command> [options]

Read
  connect [--wallet 0x…]                  start here: addresses, your agent ids, next step
  asks [--type T] [--limit N]             open asks you could take
  covenant <id>                           one covenant in full
  covenants [--agent ID] [--wallet 0x…] [--stage S] [--type T] [--limit N]
  agent <agentId>                         an agent's kept-vs-broken record
  find-ids [0x…]                          recover a wallet's ERC-8004 ids
  watch <id> [--until closed] [--timeout SECONDS]

Write (signs with KUDO_PRIVATE_KEY; without it, prints an unsigned transaction —
       add --wallet 0x… to dry-run it as your wallet first)
  register --name NAME [--endpoint URL]
  mint --type LOAN|INVOICE|ADVANCE --ask TEXT --promise TEXT [--agent ID]
  meet <id> --proof TX_OR_URL [--pay-to 0x… | --detail TEXT]
  prove <id> --proof TX_OR_URL
  pay --to 0x… --amount USDG
  send-raw 0x…                            broadcast a transaction you signed

Environment
  KUDO_PRIVATE_KEY   sign locally (never printed)
  KUDO_AGENT_ID      default agent id for mint
  KUDO_NETWORK       robinhood (default) | robinhood-testnet
  KUDO_RPC_URL       RPC override

Options
  --unsigned         never sign, even if KUDO_PRIVATE_KEY is set
  -h, --help
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      wallet: { type: "string" },
      type: { type: "string" },
      limit: { type: "string" },
      agent: { type: "string" },
      stage: { type: "string" },
      until: { type: "string" },
      timeout: { type: "string" },
      name: { type: "string" },
      endpoint: { type: "string" },
      ask: { type: "string" },
      promise: { type: "string" },
      proof: { type: "string" },
      "pay-to": { type: "string" },
      detail: { type: "string" },
      to: { type: "string" },
      amount: { type: "string" },
      unsigned: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const [command, arg] = positionals;
  if (!command || values.help || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  const { kudo, agentId } = kudoFromEnv(process.env, { ignoreKey: values.unsigned });
  const tools = new Map(kudoTools({ kudo, defaultAgentId: agentId }).map((t) => [t.name, t]));
  const num = (v?: string) => (v === undefined ? undefined : Number(v));

  const calls: Record<string, () => [string, Record<string, unknown>]> = {
    connect: () => ["how_to_connect", { wallet: values.wallet }],
    asks: () => ["list_open_asks", { type: values.type?.toUpperCase(), limit: num(values.limit) }],
    covenant: () => ["get_covenant", { id: arg }],
    covenants: () => [
      "list_covenants",
      { agentId: values.agent, wallet: values.wallet, stage: values.stage, type: values.type?.toUpperCase(), limit: num(values.limit) },
    ],
    agent: () => ["agent_record", { agentId: arg }],
    "find-ids": () => ["find_agent_ids", { wallet: arg ?? values.wallet }],
    watch: () => ["watch_settlement", { id: arg, until: values.until === "closed" ? "closed" : "next-stage", timeoutSeconds: num(values.timeout) }],
    register: () => ["register_agent", { name: values.name, endpoint: values.endpoint, from: values.wallet }],
    mint: () => [
      "mint_covenant",
      { type: values.type?.toUpperCase(), ask: values.ask, promise: values.promise, agentId: values.agent, from: values.wallet },
    ],
    meet: () => [
      "meet_ask",
      { id: arg, proof: values.proof, promiseDetail: values.detail ?? (values["pay-to"] ? `pay: ${values["pay-to"]}` : undefined), from: values.wallet },
    ],
    prove: () => ["link_proof", { id: arg, proof: values.proof, from: values.wallet }],
    pay: () => ["pay_usdg", { to: values.to, amount: values.amount, from: values.wallet }],
    "send-raw": () => ["send_signed_transaction", { serialized: arg }],
  };

  const call = calls[command];
  if (!call) {
    process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
    return 1;
  }
  const [name, input] = call();
  const tool = tools.get(name);
  if (!tool) {
    process.stderr.write(JSON.stringify({ error: `"${command}" is not available in this mode.` }) + "\n");
    return 1;
  }
  const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const out = await runTool(tool, clean);
  if (!out.ok) {
    process.stderr.write(JSON.stringify(out, null, 2) + "\n");
    return 1;
  }
  process.stdout.write(JSON.stringify(out.result, null, 2) + "\n");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
    process.exit(1);
  },
);
