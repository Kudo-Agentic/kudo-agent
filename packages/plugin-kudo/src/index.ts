/**
 * @kudo-dev/plugin-kudo — Kudo covenants for ElizaOS agents.
 *
 *   bun add @kudo-dev/plugin-kudo
 *
 *   // character
 *   plugins: ["@kudo-dev/plugin-kudo"]
 *   settings: { secrets: { KUDO_PRIVATE_KEY: "0x…", KUDO_AGENT_ID: "123" } }
 *
 * Every action wraps one tool from the shared Kudo tool list (packages/tools,
 * compiled into this package), so the Eliza plugin and the MCP server behave
 * identically. Arguments are pulled
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
import { dstackAppId, type Kudo } from "@kudo-dev/sdk";
import { kudoFromEnv, kudoFromEnvWithKeySource, kudoTools, runTool, toolJsonSchema, type KeySource, type KudoTool } from "@kudo-dev/tools";

const SETTINGS = [
  "KUDO_KEY_SOURCE",
  "KUDO_PRIVATE_KEY",
  "KUDO_DSTACK_KEY_PATH",
  "KUDO_DSTACK_SOCKET",
  "KUDO_AGENT_ID",
  "KUDO_RPC_URL",
] as const;

/** What getKudo resolves to. */
export interface KudoRuntimeState {
  kudo: Kudo;
  agentId?: bigint;
  /** Where the signing key came from: KUDO_PRIVATE_KEY ("env") or the TEE ("dstack"). */
  keySource: "env" | "dstack";
  /** The enclave's Phala app id, when the key came from dstack. */
  teeId?: string;
}

interface KudoState extends KudoRuntimeState {
  keySource: KeySource;
  tools: Map<string, KudoTool>;
}

const states = new WeakMap<IAgentRuntime, Promise<KudoState>>();

/**
 * The Kudo client for a runtime, built once from its settings.
 *
 * `KUDO_KEY_SOURCE` picks the signing key: `env` (default) uses
 * `KUDO_PRIVATE_KEY`; `dstack` derives it inside a Phala TEE, so the key
 * never exists outside the enclave. Choosing `dstack` where there is no
 * dstack socket fails rather than falling back to another key.
 */
export function getKudo(runtime: IAgentRuntime): Promise<KudoRuntimeState> {
  return kudoState(runtime);
}

function kudoState(runtime: IAgentRuntime): Promise<KudoState> {
  let state = states.get(runtime);
  if (state) return state;
  const env: Record<string, string> = {};
  for (const key of SETTINGS) {
    const value = runtime.getSetting(key);
    if (value !== null && value !== undefined && String(value).trim()) env[key] = String(value);
  }
  state = kudoFromEnvWithKeySource(env).then(async ({ kudo, agentId, keySource, warnings }) => {
    for (const w of warnings) logger.warn(`[kudo] ${w}`);
    // Inside a TEE the identity records the enclave's own app id. Only read it
    // when the key itself came from dstack, so the two always describe the
    // same enclave.
    const teeId =
      keySource === "dstack" ? await dstackAppId({ socket: env.KUDO_DSTACK_SOCKET?.trim() || undefined }) : undefined;
    const tools = new Map(
      kudoTools({ kudo, defaultAgentId: agentId, teeId, mode: kudo.walletClient ? "sign" : "unsigned" }).map((t) => [t.name, t]),
    );
    return { kudo, agentId, keySource, teeId, tools };
  });
  // A failed build is not cached, so fixing a setting and retrying works.
  state.catch(() => states.delete(runtime));
  states.set(runtime, state);
  return state;
}

/** Eliza action names for each tool, and what a user might say instead. */
const ACTIONS: Record<string, { name: string; similes: string[]; example: [string, string] }> = {
  get_wallet: {
    name: "GET_KUDO_WALLET",
    similes: ["GET_KUDO_ACCOUNT", "KUDO_STATUS", "KUDO_SETUP", "CHECK_KUDO", "FIND_KUDO_AGENT_IDS", "MY_AGENT_ID"],
    example: ["What's your Kudo agent id, and can you sign?", "Checking my Kudo account."],
  },
  register: {
    name: "REGISTER_KUDO_AGENT",
    similes: ["REGISTER_AGENT", "CREATE_AGENT_IDENTITY", "ERC8004_REGISTER"],
    example: ["Register yourself on Kudo as 'Ada'.", "Registering an ERC-8004 identity named Ada."],
  },
  set_metadata: {
    name: "SET_KUDO_AGENT_METADATA",
    similes: ["UPDATE_KUDO_AGENT", "UPDATE_AGENT_METADATA", "SET_TEE_ID", "UPDATE_KUDO_ENDPOINT"],
    example: ["Update your Kudo endpoint to https://ada.example/agent.", "Updating the endpoint on my ERC-8004 identity."],
  },
  get_covenants_details: {
    name: "GET_COVENANTS_DETAILS",
    similes: ["LIST_COVENANTS", "MY_COVENANTS", "KUDO_COVENANTS", "FIND_KUDO_WORK", "LIST_OPEN_ASKS", "KUDO_JOBS"],
    example: ["Any open asks on Kudo you could take?", "Checking Kudo for open asks."],
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
  set_ask_settlement_data: {
    name: "SET_ASK_SETTLEMENT_DATA",
    similes: ["CLAIM_ASK", "MEET_ASK", "TAKE_ASK", "CLAIM_COVENANT", "SETTLE_ASK"],
    example: ["I published the report at https://ipfs.io/ipfs/bafy… for covenant 109, pay me at 0xabc…", "Recording that the ask of covenant 109 was met."],
  },
  set_promise_settlement_data: {
    name: "SET_PROMISE_SETTLEMENT_DATA",
    similes: ["PROVE_PROMISE_KEPT", "LINK_PROOF", "PROVE_PROMISE", "SETTLE_PROMISE", "ATTEST_PROMISE"],
    example: ["You paid for covenant 108 in tx 0xe476…; link it.", "Linking the payment as proof for covenant 108."],
  },
  get_agent: {
    name: "GET_KUDO_AGENT",
    similes: ["GET_KUDO_REPUTATION", "KUDO_AGENT_RECORD", "AGENT_REPUTATION", "KEPT_VS_BROKEN"],
    example: ["What's agent 20380's record?", "Reading agent 20380's covenant record."],
  },
};

/** What earlier actions in this same turn returned, so a chain like GET_COVENANT → SET_PROMISE_SETTLEMENT_DATA can use it. */
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
        const { kudo } = await getKudo(runtime);
        return !tool.writes || !!kudo.walletClient;
      } catch {
        return false;
      }
    },
    handler: async (runtime, message, state, options, callback) => {
      const { tools } = await kudoState(runtime);
      const current = tools.get(tool.name) ?? tool;

      let args: Record<string, unknown> = {};
      const prompt = extractionPrompt(current, message, state, options);
      if (!noArgs) {
        const raw = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
        args = parseJSONObjectFromText(String(raw)) ?? {};
      }

      let out = await runTool(current, args);
      // The small model sometimes returns no arguments or the wrong keys.
      // Bad input is refused before anything is sent, so one retry with the
      // large model, shown the validation error, is safe.
      if (!out.ok && out.code === "INVALID_INPUT" && !noArgs) {
        const retry = `${prompt}\n\nA previous answer was ${JSON.stringify(args)}, which was rejected: ${out.error}. Answer again with ONLY a corrected JSON object.`;
        const raw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: retry });
        args = parseJSONObjectFromText(String(raw)) ?? {};
        out = await runTool(current, args);
      }
      if (!out.ok) {
        logger.warn(`[kudo] ${tool.name} failed: ${out.error}`);
        await callback?.({ text: `Kudo ${meta.name} failed: ${elizaNames(out.error)}`, actions: [meta.name] });
        return { success: false, error: out.error, data: { args } };
      }

      const result = out.result as Record<string, unknown>;
      const summary = summarize(tool.name, result, args);
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
  // Tool names can be a single word (`register`), so match the known names
  // exactly rather than anything snake_case.
  const names = Object.keys(ACTIONS).sort((a, b) => b.length - a.length);
  return text.replace(new RegExp(`\\b(${names.join("|")})\\b`, "g"), (tool) => ACTIONS[tool]!.name);
}

/** A short line for the chat; the full result is in the action's data. */
function summarize(tool: string, r: Record<string, unknown>, args: Record<string, unknown> = {}): string {
  const link = (r.url as string) || (r.explorer as string) || "";
  switch (tool) {
    case "mint_covenant":
      return r.signed ? `Minted covenant ${r.covenantId}. ${link}` : `Prepared the mint transaction; it needs to be signed.`;
    case "register":
      return r.signed ? `Registered as agent ${r.agentId}. ${link}` : `Prepared the registration transaction; it needs to be signed.`;
    case "set_metadata":
      return r.changed === false
        ? String(r.note ?? "Nothing to change.")
        : r.signed
          ? `Updated ${args.key} on agent ${r.agentId}. ${link}`
          : `Prepared the metadata transaction; it needs to be signed.`;
    case "set_ask_settlement_data":
      return r.signed ? `Claimed the ask of covenant ${args.id} with proof ${args.proof}. ${link}` : `Prepared the transaction; it needs to be signed.`;
    case "set_promise_settlement_data":
      return r.signed ? `Recorded ${args.proof} as proof the promise of covenant ${args.id} was kept. ${link}` : `Prepared the transaction; it needs to be signed.`;
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
    case "get_agent": {
      const c = r.covenants as { kept: number; broken: number; open: number };
      return `${r.name ?? `Agent ${r.agentId}`}: ${c.kept} kept, ${c.broken} broken, ${c.open} open.`;
    }
    case "get_covenants_details": {
      const list = (r.covenants as { id: string; type: string; stage: string; ask: string; promise: string }[]) ?? [];
      return list.length
        ? `Covenants:\n${list.map((c) => `#${c.id} ${c.type} (${c.stage}): ${c.ask} → ${c.promise}`).join("\n")}`
        : "No covenants found.";
    }
    case "get_wallet": {
      const ids = (r.agentIds as string[]) ?? [];
      return [
        `Wallet ${r.wallet}${r.signing ? " (I sign for it)" : ""}, ${r.eth ?? "unknown"} ETH for gas.`,
        ids.length
          ? `It owns Kudo agent id${ids.length > 1 ? "s" : ""} ${ids.join(", ")}.`
          : `It owns no Kudo agent id yet: register with ${ACTIONS.register!.name}.`,
      ].join(" ");
    }
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
      const { kudo, agentId } = await getKudo(runtime);
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

function createKudoActions(runtimeTools?: KudoTool[]): Action[] {
  // Actions only need each tool's name, description and schema up front;
  // the runtime's own client is resolved inside the handler.
  const tools =
    runtimeTools ??
    kudoTools({ kudo: kudoFromEnv({}).kudo, mode: "sign" });
  return tools.map(toAction);
}

export const kudoPlugin: Plugin = {
  name: "kudo",
  description: "Kudo covenants on Robinhood Chain: register an ERC-8004 identity, mint covenants, take open asks, link proof and read agent records.",
  config: Object.fromEntries(SETTINGS.map((k) => [k, process.env[k] ?? null])),
  init: async (_config, runtime) => {
    const { kudo, agentId, keySource } = await getKudo(runtime);
    logger.info(
      `[kudo] ${kudo.network.chain.name}: ${kudo.address ? `signing as ${kudo.address} (key from ${keySource === "dstack" ? "the TEE via dstack" : "KUDO_PRIVATE_KEY"})` : "read-only"}${agentId !== undefined ? `, agent ${agentId}` : ""}`,
    );
  },
  actions: createKudoActions(),
  providers: [kudoProvider],
};

export default kudoPlugin;
