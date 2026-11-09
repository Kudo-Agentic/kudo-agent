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

/** What a tool file is given to build its tool. */
export interface ToolContext {
  kudo: Kudo;
  mode: ToolMode;
  signing: boolean;
  /** The unsigned-mode answer for a write: the transaction plus what to do next. */
  unsigned: (tx: TxRequest, next: string, from?: string) => Promise<unknown>;
  /** The agent id to act as: the input's, else the configured default. */
  agentIdOf: (value: string | number | undefined) => bigint;
}

export function toolContext(options: KudoToolOptions): ToolContext {
  const { kudo } = options;
  const mode: ToolMode = options.mode ?? (kudo.walletClient?.account ? "sign" : "unsigned");
  return {
    kudo,
    mode,
    signing: mode === "sign",
    unsigned: async (tx, next, from) => {
      if (from) await kudo.simulate(tx, from as Address);
      return toJson({
        signed: false,
        simulated: from ? `ok as ${from}` : "not simulated: pass `from` to dry-run as your wallet first",
        unsignedTransaction: tx,
        next: `${next} Sign this transaction with your own wallet on chain ${tx.chainId} and broadcast it${
          mode === "unsigned" ? ", or pass the signed raw transaction to send_signed_transaction" : ""
        }.`,
      });
    },
    agentIdOf: (value) => {
      if (value !== undefined && value !== "") {
        try {
          const id = BigInt(value);
          if (id >= 0n) return id;
        } catch {
          /* reported below */
        }
        throw new KudoError("INVALID_INPUT", `agentId must be a non-negative integer, got "${value}".`);
      }
      if (options.defaultAgentId !== undefined) return options.defaultAgentId;
      throw new KudoError(
        "INVALID_INPUT",
        "agentId is required. Call find_agent_ids to recover yours, or register_agent to get one.",
      );
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
  .describe("Your ERC-8004 agent id. Defaults to the configured KUDO_AGENT_ID.");
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
