/**
 * What every tool file shares: the tool type, the context a tool is built
 * from, input fields used by more than one tool, and the helpers that turn
 * results into plain JSON.
 */
import { z } from "zod";
import type { Address } from "viem";
import { KudoError, type Covenant, type Kudo, type TxRequest } from "@kudo-dev/sdk";

/**
 * - **sign**: the Kudo client has a wallet; write tools sign, send and wait.
 * - **unsigned**: no key anywhere near the tool; write tools return
 *   `{to, data, value, chainId}` for the caller's own wallet to sign. This is
 *   what a hosted server must use.
 */
export type ToolMode = "sign" | "unsigned";

export interface KudoToolOptions {
  kudo: Kudo;
  /** Defaults to "sign" when the client has a wallet, else "unsigned". */
  mode?: ToolMode;
  /**
   * Finds the agent id write tools act as when none is passed. Share one
   * between kudoTools and anything else that needs the id (the ElizaOS
   * provider), so a registration is seen by both. Default: a new AgentIds.
   */
  agentIds?: AgentIds;
  /**
   * The Phala app id of the TEE this agent runs in, read from dstack. Only a
   * process inside that enclave may pass it: it is what register and
   * set_metadata write as `teeId`, and nothing else may be.
   */
  teeId?: string;
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

/** What a tool file is given to build its tool. */
export interface ToolContext {
  kudo: Kudo;
  mode: ToolMode;
  signing: boolean;
  /** The enclave's own app id, when this process runs in a TEE. */
  teeId?: string;
  /** The unsigned-mode answer for a write: the transaction plus what to do next. */
  unsigned: (tx: TxRequest, next: string, from?: string) => Promise<unknown>;
  /** The agent id to act as: the input's, else the one the wallet registered. */
  agentIdOf: (value: string | number | undefined, from?: string) => Promise<bigint>;
  /** Finds and remembers each wallet's id. */
  agentIds: AgentIds;
}

/**
 * Each wallet's ERC-8004 id, found rather than configured: the identity the
 * wallet registered, from the registry's `Registered` events
 * (`Kudo.findRegisteredAgentId`). Looked up on first use and kept; `register`
 * records the id it creates.
 */
export class AgentIds {
  private readonly known = new Map<string, bigint>();

  constructor(private readonly kudo: Kudo) {}

  /** The id `wallet` (default: the signing wallet) registered, or undefined if it has none yet. */
  async of(wallet?: string): Promise<bigint | undefined> {
    const who = (wallet ?? this.kudo.address)?.toLowerCase();
    if (!who) return undefined;
    const cached = this.known.get(who);
    if (cached !== undefined) return cached;
    // Not cached when absent: a registration made elsewhere is found next time.
    const found = await this.kudo.findRegisteredAgentId(who as Address);
    if (found !== undefined) this.known.set(who, found);
    return found;
  }

  /** Records the id a wallet just registered. */
  remember(wallet: string, id: bigint): void {
    this.known.set(wallet.toLowerCase(), id);
  }
}

export function toolContext(options: KudoToolOptions): ToolContext {
  const { kudo } = options;
  const mode: ToolMode = options.mode ?? (kudo.walletClient?.account ? "sign" : "unsigned");
  const agentIds = options.agentIds ?? new AgentIds(kudo);
  return {
    kudo,
    mode,
    signing: mode === "sign",
    teeId: options.teeId?.replace(/^0x/i, "").toLowerCase() || undefined,
    unsigned: async (tx, next, from) => {
      if (from) await kudo.simulate(tx, from as Address);
      return toJson({
        signed: false,
        simulated: from ? `ok as ${from}` : "not simulated: pass `from` to dry-run as your wallet first",
        unsignedTransaction: tx,
        next: `${next} Sign and send this transaction with your own wallet (e.g. viem or ethers sendTransaction) on chain ${tx.chainId}.`,
      });
    },
    agentIds,
    agentIdOf: async (value, from) => {
      if (value !== undefined && value !== "") {
        try {
          const id = BigInt(value);
          if (id >= 0n) return id;
        } catch {
          /* reported below */
        }
        throw new KudoError("INVALID_INPUT", `agentId must be a non-negative integer, got "${value}".`);
      }
      const wallet = kudo.address ?? from;
      if (!wallet) {
        throw new KudoError("INVALID_INPUT", "agentId is required: this server does not sign, so pass agentId or your wallet as from.");
      }
      const id = await agentIds.of(wallet);
      if (id !== undefined) return id;
      throw new KudoError("INVALID_INPUT", `${wallet} has not registered an agent identity yet. Call register first.`);
    },
  };
}

/** Types `execute`'s input from the shape, then erases it so tools fit one list. */
export function define<S extends z.ZodRawShape>(tool: KudoTool<S>): KudoTool {
  return tool as unknown as KudoTool;
}

/** JSON-safe copy: bigints become strings, Dates ISO strings. */
export function toJson<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v instanceof Date ? v.toISOString() : v,
    ),
  );
}

export const covenantId = z
  .union([z.string(), z.number()])
  .describe("Covenant id (the cNFT token id), e.g. 109");
export const agentIdField = z
  .union([z.string(), z.number()])
  .describe("Your ERC-8004 agent id. Leave out to use the one your wallet registered.");
export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an 0x address");
export const fromField = address
  .optional()
  .describe("Unsigned mode: your wallet, to dry-run the transaction as you before you sign.");

/** The fields of a covenant a list needs. */
export const brief = (c: Covenant) => ({
  id: c.id,
  type: c.type,
  stage: c.stage,
  agentId: c.agentId,
  agentWallet: c.agentWallet,
  ask: c.ask,
  promise: c.promise,
  url: c.url,
});

/** Runs a tool and returns `{ok, result}` or `{ok: false, error}`, never throwing. */
export async function runTool(
  tool: KudoTool,
  input: unknown,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string; code?: string }> {
  const parsed = z.object(tool.inputShape).safeParse(input ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      error: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
    };
  }
  try {
    return { ok: true, result: await tool.execute(parsed.data as never) };
  } catch (error) {
    if (error instanceof KudoError) return { ok: false, code: error.code, error: error.message };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A tool's input as JSON Schema, for prompts that do not take zod (ElizaOS). */
export function toolJsonSchema(tool: KudoTool): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(z.object(tool.inputShape), { io: "input" }) as Record<
    string,
    unknown
  >;
  return schema;
}
