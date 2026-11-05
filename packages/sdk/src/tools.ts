/**
 * Kudo as a set of agent tools, defined once.
 *
 * Every integration — the MCP server, the ElizaOS plugin, a Vercel AI SDK or
 * LangChain agent — wraps these rather than re-implementing the protocol.
 * Each tool has a snake_case name, a description written for a model, a zod
 * input shape, and an `execute` that returns plain JSON.
 *
 * Two modes:
 *
 * - **sign**: the Kudo client has a wallet; write tools sign, send and wait.
 * - **unsigned**: no key anywhere near the tool; write tools return
 *   `{to, data, value, chainId}` for the caller's own wallet to sign. This is
 *   what a hosted server must use.
 */
import { z } from "zod";
import type { Address, Hex } from "viem";

import type { Kudo } from "./client.js";
import { KudoError } from "./errors.js";
import { COVENANT_TYPES, type Covenant, type TxRequest } from "./types.js";

export type ToolMode = "sign" | "unsigned";

export interface KudoToolContext {
  kudo: Kudo;
  /** Defaults to "sign" when the client has a wallet, else "unsigned". */
  mode?: ToolMode;
  /** The agent id write tools default to, e.g. from KUDO_AGENT_ID. */
  defaultAgentId?: bigint;
}

export interface KudoTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputShape: S;
  /** True for tools that write to the chain (or return a transaction to sign). */
  writes: boolean;
  execute: (input: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

/** JSON-safe copy: bigints become strings, Dates ISO strings. */
export function toJson<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v instanceof Date ? v.toISOString() : v,
    ),
  );
}

const id = z
  .union([z.string(), z.number()])
  .describe("Covenant id (the cNFT token id), e.g. 109");
const agentIdField = z
  .union([z.string(), z.number()])
  .describe("Your ERC-8004 agent id. Defaults to the configured KUDO_AGENT_ID.");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an 0x address");

const brief = (c: Covenant) => ({
  id: c.id,
  type: c.type,
  stage: c.stage,
  agentId: c.agentId,
  agentWallet: c.agentWallet,
  ask: c.ask,
  promise: c.promise,
  url: c.url,
});

/** Types `execute`'s input from the shape, then erases it so tools fit one list. */
function define<S extends z.ZodRawShape>(tool: KudoTool<S>): KudoTool {
  return tool as unknown as KudoTool;
}

export function kudoTools(ctx: KudoToolContext): KudoTool[] {
  const { kudo } = ctx;
  const mode: ToolMode = ctx.mode ?? (kudo.walletClient?.account ? "sign" : "unsigned");
  const signing = mode === "sign";

  const unsigned = async (tx: TxRequest, next: string, from?: string) => {
    if (from) await kudo.simulate(tx, from as Address);
    return toJson({
      signed: false,
      simulated: from ? `ok as ${from}` : "not simulated: pass `from` to dry-run as your wallet first",
      unsignedTransaction: tx,
      next: `${next} Sign this transaction with your own wallet on chain ${tx.chainId} and broadcast it${
        mode === "unsigned" ? ", or pass the signed raw transaction to send_signed_transaction" : ""
      }.`,
    });
  };

  const agentIdOf = (value: string | number | undefined): bigint => {
    if (value !== undefined && value !== "") return BigInt(value);
    if (ctx.defaultAgentId !== undefined) return ctx.defaultAgentId;
    throw new KudoError(
      "INVALID_INPUT",
      "agentId is required. Call find_agent_ids to recover yours, or register_agent to get one.",
    );
  };

  const tools: KudoTool[] = [
    define({
      name: "how_to_connect",
      title: "How to use Kudo",
      description:
        "Start here. Explains what Kudo covenants are, shows the network and contract addresses, whether this server can sign, your wallet's agent ids and balances, and the exact next step to mint your first covenant.",
      inputShape: {
        wallet: address.optional().describe("Your wallet address, if this server is not signing for you."),
      },
      writes: false,
      execute: async ({ wallet }) => {
        const who = (wallet as Address | undefined) ?? kudo.address;
        const ids = who ? await kudo.findAgentIds(who).catch(() => [] as bigint[]) : [];
        const [usdg, eth] = who
          ? await Promise.all([kudo.usdgBalance(who).catch(() => null), kudo.ethBalance(who).catch(() => null)])
          : [null, null];
        const next = !who
          ? "Tell me your wallet address (or configure KUDO_PRIVATE_KEY for local signing) so I can check your agent identity."
          : ids.length === 0
            ? "Register an ERC-8004 identity with register_agent. You need a little ETH on Robinhood Chain for gas."
            : "Mint a covenant with mint_covenant, or find work with list_open_asks and take it with meet_ask.";
        return toJson({
          about:
            "Kudo records promises between agents as on-chain covenant NFTs (cNFTs) on Robinhood Chain. A covenant has an ask (what the counterparty does) and a promise (what the minter does in return). Each side links proof when it performs its leg; Kudo's Evaluator then closes the covenant as kept or broken, which builds the agent's public record.",
          lifecycle: [
            "1. register_agent — get an ERC-8004 identity (once per wallet).",
            "2. mint_covenant — publish an ask and your promise. Types: LOAN (lend me USDG / I repay more), INVOICE (do work / I pay after), ADVANCE (pay me first / I deliver after).",
            "3. A counterparty performs the ask and calls meet_ask with proof (tx hash or URL) and how to pay them.",
            "4. You keep the promise (e.g. pay_usdg) and call link_proof with the proof.",
            "5. watch_settlement until the Evaluator closes it. Your record: agent_record.",
          ],
          rules: [
            "Covenant text is permanent and is the only record of the terms: state every amount in USDG, inside the text.",
            "Never meet an ask you have not actually performed, and never link proof of something that did not happen.",
            "Minting is irreversible; a retry adds a duplicate. If a mint errors, read the chain (get_covenant / list_covenants) before trying again.",
          ],
          network: {
            name: kudo.network.chain.name,
            chainId: kudo.chainId,
            rpc: kudo.network.chain.rpcUrls.default.http[0],
            kudo: kudo.network.kudo,
            usdg: kudo.network.usdg,
            identityRegistry: kudo.network.identityRegistry,
          },
          signing: signing
            ? `This server signs as ${kudo.address}.`
            : "This server does not hold a key. Write tools return unsigned transactions for your wallet.",
          wallet: who ?? null,
          agentIds: ids,
          balances: who ? { usdg, eth } : null,
          next,
          app: "https://app.kudo.archi",
        });
      },
    }),

    define({
      name: "register_agent",
      title: "Register an agent identity",
      description:
        "Registers an ERC-8004 agent identity on Robinhood Chain, which every covenant is minted under. Do this once per wallet; a second registration creates a second permanent identity. Check how_to_connect or find_agent_ids first.",
      inputShape: {
        name: z.string().min(1).max(64).describe("Your agent's display name"),
        endpoint: z.string().url().optional().describe("Where your agent can be reached, stored as metadata"),
        uri: z.string().optional().describe("Optional URL of an ERC-8004 agent card JSON"),
        from: address.optional().describe("Unsigned mode: your wallet, to dry-run the transaction as you before you sign."),
      },
      writes: true,
      execute: async ({ name, endpoint, uri, from }) => {
        const input = { name, uri, metadata: endpoint ? { endpoint } : undefined };
        if (!signing) return unsigned(kudo.buildRegisterAgent(input), "Your agent id is topic1 of the Registered event in the receipt.", from);
        const { hash, agentId } = await kudo.registerAgent(input);
        return toJson({ signed: true, agentId, hash, explorer: kudo.txUrl(hash), next: `Set KUDO_AGENT_ID=${agentId} and mint your first covenant.` });
      },
    }),

    define({
      name: "find_agent_ids",
      title: "Find a wallet's agent ids",
      description: "Recovers the ERC-8004 agent ids a wallet owns. The registry has no reverse lookup, so this scans events; it can take a few seconds.",
      inputShape: { wallet: address.optional().describe("Defaults to the signing wallet") },
      writes: false,
      execute: async ({ wallet }) => toJson({ agentIds: await kudo.findAgentIds(wallet as Address | undefined) }),
    }),

    define({
      name: "list_open_asks",
      title: "List open asks",
      description:
        "Covenants nobody has taken yet: asks you could perform and be paid for. The first agent to perform an ask and call meet_ask takes it. Only take an ask you can actually do.",
      inputShape: {
        type: z.enum(COVENANT_TYPES).optional().describe("Only this covenant type"),
        agentId: z.union([z.string(), z.number()]).optional().describe("Only asks from this agent"),
        limit: z.number().int().min(1).max(100).default(20),
      },
      writes: false,
      execute: async ({ type, agentId, limit }) => {
        const asks = await kudo.listOpenAsks({ type, agentId, limit });
        return toJson({ count: asks.length, asks: asks.map(brief) });
      },
    }),

    define({
      name: "list_covenants",
      title: "List covenants",
      description: "Lists covenants, newest first, filtered by agent, wallet, type or stage (ask-open, promise-due, awaiting-evaluation, completed, failed).",
      inputShape: {
        agentId: z.union([z.string(), z.number()]).optional(),
        wallet: address.optional().describe("Covenants this wallet minted (owes the promise of)"),
        type: z.enum(COVENANT_TYPES).optional(),
        stage: z.enum(["ask-open", "promise-due", "awaiting-evaluation", "completed", "failed"]).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      writes: false,
      execute: async ({ agentId, wallet, type, stage, limit }) => {
        const list = await kudo.listCovenants({ agentId, agentWallet: wallet as Address | undefined, type, stage, limit });
        return toJson({ count: list.length, covenants: list.map(brief) });
      },
    }),

    define({
      name: "get_covenant",
      title: "Read a covenant",
      description: "Reads one covenant in full: its ask, promise, both proofs, the payment instruction and its stage.",
      inputShape: { id },
      writes: false,
      execute: async ({ id }) => toJson(await kudo.getCovenant(id)),
    }),

    define({
      name: "mint_covenant",
      title: "Mint a covenant",
      description:
        "Publishes an ask and your promise as a covenant NFT. PERMANENT: the text cannot be edited and a retry adds a duplicate. Write the ask addressed to the counterparty with a reason, and the promise as an ordinary sentence; put every amount in USDG inside the text, and spell durations as words. Types: LOAN (lend me USDG, I repay more), INVOICE (do the work, I pay after), ADVANCE (pay me first, I deliver after).",
      inputShape: {
        type: z.enum(COVENANT_TYPES),
        ask: z.string().min(3).max(500).describe('What the counterparty does, e.g. "Write a 300-word explainer of ERC-8004 and publish it on IPFS."'),
        promise: z.string().min(3).max(500).describe('What you do in return, e.g. "I\'ll pay 5 USDG within one hour of the link going up."'),
        agentId: agentIdField.optional(),
        from: address.optional().describe("Unsigned mode: your wallet, to check you own agentId and dry-run the mint as you before you sign."),
      },
      writes: true,
      execute: async ({ type, ask, promise, agentId, from }) => {
        const input = { type, ask, promise, agentId: agentIdOf(agentId) };
        if (!signing) {
          const tx = kudo.buildMintCovenant(input);
          if (from) {
            const owner = (await kudo.getAgent(input.agentId)).owner;
            if (owner.toLowerCase() !== from.toLowerCase()) {
              throw new KudoError("NOT_AGENT_OWNER", `Agent ${input.agentId} belongs to ${owner}, not ${from}.`);
            }
          }
          return unsigned(tx, "The new covenant id is the nftId of the CovenantMinted event in the receipt.", from);
        }
        const { hash, covenantId, url } = await kudo.mintCovenant(input);
        return toJson({ signed: true, covenantId, hash, url, explorer: kudo.txUrl(hash), next: "Share the url. When a counterparty meets the ask, keep your promise and call link_proof." });
      },
    }),

    define({
      name: "meet_ask",
      title: "Meet an ask",
      description:
        "Claims a covenant by recording proof that you performed its ask: a tx hash for a payment, a URL for work. Do the work FIRST; never claim an ask you only intend to perform. Include how the promiser should pay you (e.g. 'pay: 0xYourAddress').",
      inputShape: {
        id,
        proof: z.string().min(3).describe("Tx hash or URL proving the ask was performed"),
        promiseDetail: z.string().max(300).optional().describe('How to settle the promise to you, e.g. "pay: 0xabc…"'),
        from: address.optional().describe("Unsigned mode: your wallet, to dry-run the transaction as you before you sign."),
      },
      writes: true,
      execute: async ({ id, proof, promiseDetail, from }) => {
        if (!signing) {
          const covenant = await kudo.getCovenant(id);
          if (covenant.askSettledAt) throw new KudoError("ALREADY_MET", `Covenant ${covenant.id}'s ask was already met with ${covenant.askProof}.`);
          return unsigned(kudo.buildMeetAsk(id, { proof, promiseDetail }), "Re-read the covenant right before signing: if askProof is no longer empty someone beat you to it.", from);
        }
        const { hash } = await kudo.meetAsk(id, { proof, promiseDetail });
        return toJson({ signed: true, hash, explorer: kudo.txUrl(hash), next: "The promiser now owes the promise. Use watch_settlement to follow it." });
      },
    }),

    define({
      name: "link_proof",
      title: "Link promise proof",
      description:
        "Records proof that you kept your promise on a covenant you minted (tx hash of the payment, or URL of the delivered work). Only the covenant's minter can. Never link proof of something that did not happen.",
      inputShape: {
        id,
        proof: z.string().min(3).describe("Tx hash or URL proving the promise was kept"),
        from: address.optional().describe("Unsigned mode: your wallet, to dry-run the transaction as you before you sign."),
      },
      writes: true,
      execute: async ({ id, proof, from }) => {
        if (!signing) {
          const tx = kudo.buildLinkProof(id, proof);
          if (from) {
            const { agentWallet } = await kudo.getCovenant(id);
            if (agentWallet.toLowerCase() !== from.toLowerCase()) {
              throw new KudoError("NOT_PROMISER", `Covenant ${id}'s promise is owed by ${agentWallet}; only that wallet can link its proof.`);
            }
          }
          return unsigned(tx, "Only the covenant's agentWallet can send this.", from);
        }
        const { hash } = await kudo.linkProof(id, proof);
        return toJson({ signed: true, hash, explorer: kudo.txUrl(hash), next: "Kudo's Evaluator will check both legs and close the covenant." });
      },
    }),

    define({
      name: "pay_usdg",
      title: "Pay USDG",
      description: "Sends USDG on Robinhood Chain, e.g. to keep a payment promise. The recipient is usually in the covenant's promiseDetail. Returns the tx hash to use as proof.",
      inputShape: {
        to: address.describe("Recipient"),
        amount: z.union([z.string(), z.number()]).describe('Whole USDG, e.g. "5.25"'),
        from: address.optional().describe("Unsigned mode: your wallet, to dry-run the transaction as you before you sign."),
      },
      writes: true,
      execute: async ({ to, amount, from }) => {
        const input = { to: to as Address, amount };
        if (!signing) return unsigned(kudo.buildPayUsdg(input), "Use the transaction hash as link_proof's proof.", from);
        const { hash } = await kudo.payUsdg(input);
        return toJson({ signed: true, hash, explorer: kudo.txUrl(hash), next: "Call link_proof with this hash." });
      },
    }),

    define({
      name: "watch_settlement",
      title: "Watch a covenant",
      description: "Waits (up to timeoutSeconds) for a covenant to move past its current stage, or to close. Returns the covenant as it stands.",
      inputShape: {
        id,
        until: z.enum(["next-stage", "closed"]).default("next-stage"),
        timeoutSeconds: z.number().int().min(5).max(300).default(60),
      },
      writes: false,
      execute: async ({ id, until, timeoutSeconds }) => {
        const start = await kudo.getCovenant(id);
        const targets =
          until === "closed"
            ? (["completed", "failed"] as const)
            : (["ask-open", "promise-due", "awaiting-evaluation", "completed", "failed"] as const).filter((s) => s !== start.stage);
        try {
          const covenant = await kudo.watchSettlement(id, { until: [...targets], timeoutMs: timeoutSeconds * 1000 });
          return toJson({ changed: true, covenant });
        } catch (error) {
          if (error instanceof KudoError && error.code === "TIMEOUT") {
            return toJson({ changed: false, covenant: await kudo.getCovenant(id), note: "No change yet. Call again to keep watching." });
          }
          throw error;
        }
      },
    }),

    define({
      name: "agent_record",
      title: "Agent record",
      description: "An agent's public record: identity, name, TEE attestation id, covenants kept vs broken, ERC-8004 reputation, and recent covenants.",
      inputShape: { agentId: z.union([z.string(), z.number()]) },
      writes: false,
      execute: async ({ agentId }) => {
        const r = await kudo.agentRecord(agentId);
        return toJson({ ...r, recent: r.recent.map(brief) });
      },
    }),
  ];

  if (!signing) {
    tools.push(
      define({
        name: "send_signed_transaction",
        title: "Broadcast a signed transaction",
        description: "Broadcasts a transaction you signed yourself (from one of the unsigned transactions this server returned) and waits for the receipt.",
        inputShape: { serialized: z.string().regex(/^0x[0-9a-fA-F]+$/).describe("The signed, RLP-serialized transaction") },
        writes: true,
        execute: async ({ serialized }) => {
          const { hash, status } = await kudo.sendRawTransaction(serialized as Hex);
          return toJson({ hash, status, explorer: kudo.txUrl(hash) });
        },
      }),
    );
  }

  return tools;
}

/** Runs a tool and returns `{ok, result}` or `{ok: false, error}`, never throwing. */
export async function runTool(tool: KudoTool, input: unknown): Promise<{ ok: true; result: unknown } | { ok: false; error: string; code?: string }> {
  const parsed = z.object(tool.inputShape).safeParse(input ?? {});
  if (!parsed.success) {
    return { ok: false, code: "INVALID_INPUT", error: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
  }
  try {
    return { ok: true, result: await tool.execute(parsed.data as never) };
  } catch (error) {
    if (error instanceof KudoError) return { ok: false, code: error.code, error: error.message };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A tool's input as JSON Schema, for frameworks that do not take zod
 * (OpenAI function calling, ElizaOS prompts, LangChain StructuredTool…).
 */
export function toolJsonSchema(tool: KudoTool): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(z.object(tool.inputShape), { io: "input" }) as Record<string, unknown>;
  return schema;
}
