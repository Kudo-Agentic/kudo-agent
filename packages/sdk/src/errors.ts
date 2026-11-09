import { BaseError, ContractFunctionRevertedError, type Hex } from "viem";

/**
 * Revert selectors seen on Kudo deployments, with what each means in practice.
 * Matched by selector because not every error is in the ABI the SDK carries.
 */
export const REVERTS: Record<string, { name: string; hint: string }> = {
  "0x468381ac": {
    name: "NotAuthorizedForAgent",
    hint: "The sending wallet does not control that ERC-8004 agent id. Mint under an id this wallet owns (see findAgentIds / registerAgent).",
  },
  "0xef67f5d8": {
    name: "AccessForbidden",
    hint: "The caller is not allowed: on mint the wallet lacks AGENT_ROLE (only when mint access control is on); on linkProof the caller is not the covenant's agentWallet.",
  },
  "0xe2517d3f": {
    name: "AccessControlUnauthorizedAccount",
    hint: "An onlyRole function refused this account. Closing a covenant is the Evaluator's job, not the agent's.",
  },
  "0x613970e0": {
    name: "InvalidParameter",
    hint: "The contract rejected an argument, such as an empty string or a zero address.",
  },
  "0x356680b7": {
    name: "InsufficientFunds",
    hint: "The wallet does not hold enough of the token for this transfer.",
  },
  "0xe450d38c": {
    name: "ERC20InsufficientBalance",
    hint: "The wallet does not hold enough of this token for the transfer.",
  },
  "0xf480469b": {
    name: "ConditionIsNotMet",
    hint: "This selector belongs to an older Kudo deployment. You are probably pointing at the wrong contract.",
  },
};

export type KudoErrorCode =
  | "NO_WALLET"
  | "INVALID_INPUT"
  | "NOT_AGENT_OWNER"
  | "ALREADY_MET"
  | "ASK_NOT_MET"
  | "ALREADY_PROVEN"
  | "NOT_PROMISER"
  | "ALREADY_REGISTERED"
  | "REVERTED"
  | "TX_FAILED"
  | "TIMEOUT"
  | "NOT_FOUND";

export class KudoError extends Error {
  readonly code: KudoErrorCode;
  readonly revert?: { selector?: Hex; name?: string; hint?: string };

  constructor(
    code: KudoErrorCode,
    message: string,
    options: { cause?: unknown; revert?: KudoError["revert"] } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "KudoError";
    this.code = code;
    this.revert = options.revert;
  }
}

/** Turns a viem error into a KudoError that names the revert and what to do about it. */
export function toKudoError(error: unknown, action: string): KudoError {
  if (error instanceof KudoError) return error;

  let selector: Hex | undefined;
  let name: string | undefined;

  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      name = reverted.data?.errorName;
      selector = reverted.signature ?? (reverted.raw?.slice(0, 10) as Hex | undefined);
    } else {
      // A raw eth_call (as in simulate) surfaces the revert bytes as `data`
      // on a RawContractError somewhere down the cause chain.
      const raw = error.walk((e) => typeof (e as { data?: unknown }).data === "string") as
        | { data?: string }
        | null;
      if (raw?.data && /^0x[0-9a-fA-F]{8}/.test(raw.data)) selector = raw.data.slice(0, 10) as Hex;
    }
  }

  const text = error instanceof Error ? error.message : String(error);
  if (!selector) {
    selector = Object.keys(REVERTS).find((s) => text.toLowerCase().includes(s)) as
      | Hex
      | undefined;
  }

  const known = selector ? REVERTS[selector.toLowerCase()] : undefined;
  name = name ?? known?.name;

  if (name || selector) {
    return new KudoError(
      "REVERTED",
      `${action} reverted${name ? ` with ${name}` : ""}${known ? `: ${known.hint}` : "."}`,
      { cause: error, revert: { selector, name, hint: known?.hint } },
    );
  }

  const short = error instanceof BaseError ? error.shortMessage : text;
  return new KudoError("TX_FAILED", `${action} failed: ${short}`, { cause: error });
}
