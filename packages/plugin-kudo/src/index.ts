/**
 * @kudo-dev/plugin-kudo — Kudo covenants for ElizaOS agents.
 *
 *   bun add @kudo-dev/plugin-kudo
 *
 *   // character
 *   plugins: ["@kudo-dev/plugin-kudo"]
 *   settings: { secrets: { KUDO_PRIVATE_KEY: "0x…", KUDO_AGENT_ID: "123" } }
 *
 * Every action wraps one tool from `@kudo-dev/sdk/tools`, so the Eliza
 * plugin, the MCP server and the CLI behave identically. Arguments are pulled
 * from the conversation with the runtime's small model, validated by the
 * tool's own schema, and then executed.
 *
 * Without KUDO_PRIVATE_KEY the plugin is read-only: write actions do not
 * validate, so the agent is never offered an action it cannot perform.
 */
import {
  ModelType,
  logger,
  parseJSONObjectFromText,
  type Action,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type Plugin,
  type Provider,
  type State,
} from "@elizaos/core";
import { kudoFromEnv, type Kudo } from "@kudo-dev/sdk";
import { kudoTools, runTool, toolJsonSchema, type KudoTool } from "@kudo-dev/sdk/tools";

const SETTINGS = ["KUDO_PRIVATE_KEY", "KUDO_AGENT_ID", "KUDO_NETWORK", "KUDO_RPC_URL"] as const;

interface KudoState {
  kudo: Kudo;
  agentId?: bigint;
  tools: Map<string, KudoTool>;
}

const states = new WeakMap<IAgentRuntime, KudoState>();

/** The Kudo client for a runtime, built once from its settings. */
export function getKudo(runtime: IAgentRuntime): KudoState {
  let state = states.get(runtime);
  if (state) return state;
  const env: Record<string, string> = {};
  for (const key of SETTINGS) {
    const value = runtime.getSetting(key);
    if (value !== null && value !== undefined && String(value).trim()) env[key] = String(value);
  }
  const { kudo, agentId } = kudoFromEnv(env);
  const tools = new Map(
    kudoTools({ kudo, defaultAgentId: agentId, mode: kudo.walletClient ? "sign" : "unsigned" }).map((t) => [t.name, t]),
  );
  state = { kudo, agentId, tools };
  states.set(runtime, state);
  return state;
}

/** Eliza action names for each tool, and what a user might say instead. */
const ACTIONS: Record<string, { name: string; similes: string[]; example: [string, string] }> = {
  how_to_connect: {
    name: "KUDO_STATUS",
    similes: ["KUDO_HOW_TO_CONNECT", "KUDO_SETUP", "CHECK_KUDO"],
    example: ["How do I get started on Kudo?", "Let me check your Kudo setup."],
  },
  register_agent: {
    name: "REGISTER_KUDO_AGENT",
    similes: ["REGISTER_AGENT", "CREATE_AGENT_IDENTITY", "ERC8004_REGISTER"],
    example: ["Register yourself on Kudo as 'Ada'.", "Registering an ERC-8004 identity named Ada."],
  },
  find_agent_ids: {
    name: "FIND_KUDO_AGENT_IDS",
    similes: ["FIND_AGENT_ID", "MY_AGENT_ID"],
    example: ["What's your Kudo agent id?", "Looking up the agent ids this wallet owns."],
  },
  list_open_asks: {
    name: "LIST_OPEN_ASKS",
    similes: ["FIND_KUDO_WORK", "OPEN_COVENANTS", "KUDO_JOBS"],
    example: ["Any open asks on Kudo you could take?", "Checking Kudo for open asks."],
  },
  list_covenants: {
    name: "LIST_COVENANTS",
    similes: ["MY_COVENANTS", "KUDO_COVENANTS"],
    example: ["Show your recent covenants.", "Listing covenants."],
  },
  get_covenant: {
    name: "GET_COVENANT",
    similes: ["READ_COVENANT", "COVENANT_STATUS"],
    example: ["What's the status of covenant 109?", "Reading covenant 109."],
  },
  mint_covenant: {
    name: "MINT_COVENANT",
    similes: ["CREATE_COVENANT", "MAKE_PROMISE", "POST_ASK", "KUDO_MINT"],
    example: [
      "Mint a covenant: someone writes a 300-word ERC-8004 explainer on IPFS and you pay 5 USDG within an hour.",
      "Minting an INVOICE covenant for the explainer.",
    ],
  },
  meet_ask: {
    name: "MEET_ASK",
    similes: ["TAKE_ASK", "CLAIM_COVENANT", "SETTLE_ASK"],
    example: ["I published the report at https://ipfs.io/ipfs/bafy… for covenant 109, pay me at 0xabc…", "Recording that the ask of covenant 109 was met."],
  },
  link_proof: {
    name: "LINK_PROOF",
    similes: ["PROVE_PROMISE", "SETTLE_PROMISE", "ATTEST_PROMISE"],
    example: ["You paid for covenant 108 in tx 0xe476…; link it.", "Linking the payment as proof for covenant 108."],
  },
  pay_usdg: {
    name: "PAY_USDG",
    similes: ["SEND_USDG", "TRANSFER_USDG"],
    example: ["Pay 100 USDG to 0xaaa4…", "Sending 100 USDG."],
  },
  watch_settlement: {
    name: "WATCH_COVENANT",
    similes: ["WATCH_SETTLEMENT", "WAIT_FOR_COVENANT"],
    example: ["Tell me when covenant 109 moves.", "Watching covenant 109."],
  },
  agent_record: {
    name: "KUDO_AGENT_RECORD",
    similes: ["AGENT_REPUTATION", "KEPT_VS_BROKEN"],
    example: ["What's agent 20380's record?", "Reading agent 20380's covenant record."],
  },
};

/** What earlier actions in this same turn returned, so a chain like GET_COVENANT → PAY_USDG can use it. */
function earlierResults(options?: HandlerOptions): string {
  const previous = options?.actionContext?.previousResults ?? [];
  return previous
    .map((r) => {
      const result = (r.data as { result?: unknown } | undefined)?.result;
      return result ? JSON.stringify(result).slice(0, 3000) : (r.text ?? "");
    })
    .filter(Boolean)
    .join("\n");
}

function extractionPrompt(tool: KudoTool, message: Memory, state?: State, options?: HandlerOptions): string {
  const recent = typeof state?.text === "string" ? state.text.slice(-4000) : "";
  const earlier = earlierResults(options);
  return `You are filling in the arguments for the "${tool.name}" tool.

Tool: ${tool.description}

JSON Schema of the arguments:
${JSON.stringify(toolJsonSchema(tool), null, 2)}

Recent conversation:
${recent}
${earlier ? `\nResults of the actions already taken for this message (use these facts, e.g. a payee address in promiseDetail or a transaction hash):\n${earlier}\n` : ""}
Latest message:
${message.content.text ?? ""}

Reply with ONLY a JSON object of the arguments. Use only facts stated in the conversation; leave out optional fields you do not know. Never invent a transaction hash, URL, address or amount.`;
}

function toAction(tool: KudoTool): Action {
  const meta = ACTIONS[tool.name] ?? { name: tool.name.toUpperCase(), similes: [], example: ["", ""] };
  const noArgs = Object.keys(tool.inputShape).length === 0;

  return {
    name: meta.name,
    similes: meta.similes,
    description: `Kudo: ${tool.description}`,
    validate: async (runtime) => {
      try {
        const { kudo } = getKudo(runtime);
        return !tool.writes || !!kudo.walletClient;
      } catch {
        return false;
      }
    },
    handler: async (runtime, message, state, options, callback) => {
      const { tools } = getKudo(runtime);
      const current = tools.get(tool.name) ?? tool;

      let args: Record<string, unknown> = {};
      if (!noArgs) {
        const raw = await runtime.useModel(ModelType.TEXT_SMALL, { prompt: extractionPrompt(current, message, state, options) });
        args = parseJSONObjectFromText(String(raw)) ?? {};
      }

      const out = await runTool(current, args);
      if (!out.ok) {
        logger.warn(`[kudo] ${tool.name} failed: ${out.error}`);
        await callback?.({ text: `Kudo ${tool.name} failed: ${out.error}`, actions: [meta.name] });
        return { success: false, error: out.error, data: { args } };
      }

      const result = out.result as Record<string, unknown>;
      const summary = summarize(tool.name, result);
      await callback?.({ text: summary, actions: [meta.name], source: message.content.source });
      return { success: true, text: summary, data: { args, result } };
    },
    examples: [
      [
        { name: "{{user1}}", content: { text: meta.example[0] } },
        { name: "{{agentName}}", content: { text: meta.example[1], actions: [meta.name] } },
      ],
    ],
  };
}

/** Swaps the SDK's tool names in a hint for this plugin's action names. */
function elizaNames(text: string): string {
  return text.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (tool) => ACTIONS[tool]?.name ?? tool);
}

/** A short line for the chat; the full result is in the action's data. */
function summarize(tool: string, r: Record<string, unknown>): string {
  const link = (r.url as string) || (r.explorer as string) || "";
  switch (tool) {
    case "mint_covenant":
      return r.signed ? `Minted covenant ${r.covenantId}. ${link}` : `Prepared the mint transaction; it needs to be signed.`;
    case "register_agent":
      return r.signed ? `Registered as agent ${r.agentId}. ${link}` : `Prepared the registration transaction; it needs to be signed.`;
    case "meet_ask":
    case "link_proof":
    case "pay_usdg":
      return r.signed ? `Done: ${link}` : `Prepared the transaction; it needs to be signed.`;
    case "list_open_asks": {
      const asks = (r.asks as { id: string; type: string; ask: string; promise: string }[]) ?? [];
      return asks.length
        ? `Open asks on Kudo:\n${asks.map((a) => `#${a.id} ${a.type}: ${a.ask} → ${a.promise}`).join("\n")}`
        : "No open asks on Kudo right now.";
    }
    case "get_covenant":
      return [
        `Covenant ${r.id} (${r.type}) is ${r.stage}. Ask: ${r.ask} Promise: ${r.promise}`,
        r.promiseDetail ? `Payment instruction from the counterparty: ${r.promiseDetail}` : "",
        r.askProof ? `Ask proof: ${r.askProof}` : "",
        r.promiseProof ? `Promise proof: ${r.promiseProof}` : "",
        String(r.url ?? ""),
      ]
        .filter(Boolean)
        .join("\n");
    case "agent_record": {
      const c = r.covenants as { kept: number; broken: number; open: number };
      return `${r.name ?? `Agent ${r.agentId}`}: ${c.kept} kept, ${c.broken} broken, ${c.open} open.`;
    }
    case "how_to_connect":
      return elizaNames(String(r.next ?? ""));
    default:
      return "```json\n" + JSON.stringify(r, null, 2).slice(0, 3000) + "\n```";
  }
}

/** Puts the agent's Kudo identity and anything it owes into context. */
export const kudoProvider: Provider = {
  name: "KUDO",
  description: "The agent's Kudo identity and the covenant promises it currently owes",
  // Not dynamic: an agent has to see what it owes without being asked, or
  // it cannot keep a promise unprompted.
  get: async (runtime) => {
    try {
      const { kudo, agentId } = getKudo(runtime);
      if (!kudo.address) {
        return { text: "Kudo: read-only (no KUDO_PRIVATE_KEY). The agent can read covenants but cannot mint or settle." };
      }
      const owed = await kudo.listCovenants({ agentWallet: kudo.address, stage: "promise-due", limit: 5 });
      const lines = [
        `Kudo: signing as ${kudo.address}${agentId !== undefined ? `, ERC-8004 agent ${agentId}` : " (no KUDO_AGENT_ID set — find or register one before minting)"}.`,
        owed.length
          ? `Promises you owe now:\n${owed.map((c) => `- #${c.id}: ${c.promise} (pay per: ${c.promiseDetail || "not given"})`).join("\n")}`
          : "You owe no Kudo promises right now.",
      ];
      return { text: lines.join("\n"), data: { owed: owed.map((c) => c.id.toString()) } };
    } catch (error) {
      return { text: `Kudo: unavailable (${error instanceof Error ? error.message : String(error)}).` };
    }
  },
};

export function createKudoActions(runtimeTools?: KudoTool[]): Action[] {
  // Actions only need each tool's name, description and schema up front;
  // the runtime's own client is resolved inside the handler.
  const tools =
    runtimeTools ??
    kudoTools({ kudo: kudoFromEnv({}).kudo, mode: "sign" }).filter((t) => t.name !== "send_signed_transaction");
  return tools.map(toAction);
}

export const kudoPlugin: Plugin = {
  name: "kudo",
  description: "Kudo covenants on Robinhood Chain: register an ERC-8004 identity, mint covenants, take open asks, link proof and read agent records.",
  config: Object.fromEntries(SETTINGS.map((k) => [k, process.env[k] ?? null])),
  init: async (_config, runtime) => {
    const { kudo, agentId } = getKudo(runtime);
    logger.info(
      `[kudo] ${kudo.network.chain.name}: ${kudo.address ? `signing as ${kudo.address}` : "read-only"}${agentId !== undefined ? `, agent ${agentId}` : ""}`,
    );
  },
  actions: createKudoActions(),
  providers: [kudoProvider],
};

export default kudoPlugin;
