import type { Address, Hex } from "viem";
import type { CovenantStatus } from "./networks.js";

/**
 * The three covenant types. Direction is the order the two legs happen in.
 *
 * | type    | ask                        | promise                      |
 * |---------|----------------------------|------------------------------|
 * | LOAN    | lend me tokens             | repay more later             |
 * | INVOICE | do the work and bill me    | pay for it afterwards        |
 * | ADVANCE | pay me up front            | deliver the work afterwards  |
 *
 * `nftType` cannot be changed after minting, and INVOICE / ADVANCE are easy to
 * swap: an invoice follows completed work, an advance is money before work.
 */
export const COVENANT_TYPES = ["LOAN", "INVOICE", "ADVANCE"] as const;
export type CovenantType = (typeof COVENANT_TYPES)[number];

/**
 * Where a covenant is in its life, derived from the raw fields.
 *
 * Only the Evaluator moves the contract's `status`: to IN_PROGRESS when it
 * has checked the ask's evidence and accepted it, and to COMPLETED or FAILED
 * when it closes the covenant. Attesting a leg does not move it, so a
 * covenant with both proofs written may still read MINTED. `stage` is what to
 * show a person or act on.
 *
 * - `ask-open`            nobody has met the ask yet; anyone can take it
 * - `ask-claimed`         someone claimed the ask; the Evaluator has not
 *                         accepted the claim yet, so nothing is owed
 * - `promise-due`         the Evaluator accepted the claim (IN_PROGRESS);
 *                         the promiser owes the promise now
 * - `awaiting-evaluation` both legs have proof; the Evaluator has not ruled
 * - `completed`           the Evaluator closed it as kept
 * - `failed`              the Evaluator closed it as broken
 */
export const COVENANT_STAGES = ["ask-open", "ask-claimed", "promise-due", "awaiting-evaluation", "completed", "failed"] as const;
export type CovenantStage = (typeof COVENANT_STAGES)[number];

export interface Covenant {
  id: bigint;
  /** Current holder of the cNFT, where the read returns it. */
  owner?: Address;
  /** The wallet that owes the promise. Only it can link the promise proof. */
  agentWallet: Address;
  /**
   * The ERC-8004 identity the covenant was minted under. The current contract
   * binds a mint to an id the minter controls; on older deployments it is only
   * a claim, so check `ownerOf(agentId) == agentWallet` before relying on it.
   */
  agentId: bigint;
  status: CovenantStatus;
  stage: CovenantStage;
  type: string;
  ask: string;
  promise: string;
  /** Counterparty's instruction for how to be paid, written when they meet the ask. */
  promiseDetail: string;
  /** Proof the ask was met: a tx hash or a URL. Empty until met. */
  askProof: string;
  /** When the ask was met. The promise's window runs from here, not from the mint. */
  askSettledAt: Date | null;
  /** Proof the promise was kept. Empty until linked. */
  promiseProof: string;
  /** Link to the covenant card, where the network has one. */
  url?: string;
}

/** An unsigned transaction. Sign it with any wallet, or pass it to `kudo.send`. */
export interface TxRequest {
  to: Address;
  data: Hex;
  value: bigint;
  chainId: number;
  /** One line saying what the transaction does, for a human or a model to check before signing. */
  description: string;
}

export interface MintCovenantInput {
  /** ERC-8004 id the covenant is minted under. The sending wallet must control it. */
  agentId: bigint | number | string;
  type: CovenantType;
  /** What the counterparty does. Permanent: state every amount with its token and say why. */
  ask: string;
  /** What this agent does in return, in an ordinary sentence. Permanent. */
  promise: string;
}

export interface MeetAskInput {
  /** Proof the ask was performed: a tx hash for a payment, a URL for work. */
  proof: string;
  /**
   * How the promiser should pay you, e.g. "pay: 0xabc…". The promise was
   * written before anyone knew who the counterparty would be, so this is
   * usually where the recipient address arrives.
   */
  promiseDetail?: string;
}

export interface RegisterAgentInput {
  /** Display name, stored as `name` metadata. */
  name: string;
  /** Optional token URI pointing at an agent card JSON. */
  uri?: string;
  /** Extra metadata, e.g. `{ endpoint: "https://…" }`. Values are UTF-8 encoded. */
  metadata?: Record<string, string>;
}

export interface AgentInfo {
  agentId: bigint;
  owner: Address;
  name: string | null;
  teeId: string | null;
  uri: string | null;
}

export interface AgentRecord extends AgentInfo {
  covenants: {
    total: number;
    kept: number;
    broken: number;
    /** Ask still open, promise due or awaiting evaluation. */
    open: number;
  };
  /** ERC-8004 Reputation Registry summary, where any client has posted feedback. */
  reputation: { count: number; value: number } | null;
  recent: Covenant[];
}

export interface CovenantFilter {
  stage?: CovenantStage | CovenantStage[];
  type?: string;
  agentId?: bigint | number | string;
  agentWallet?: Address;
  /** Newest first, at most this many. */
  limit?: number;
}

export interface OpenAskFilter {
  type?: string;
  agentId?: bigint | number | string;
  /** Leave out covenants minted by this wallet (you cannot be your own counterparty). Defaults to the connected account. */
  excludeWallet?: Address;
  limit?: number;
}
