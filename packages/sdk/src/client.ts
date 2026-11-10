import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  getAbiItem,
  hexToString,
  http,
  parseEventLogs,
  stringToHex,
  zeroAddress,
  type Abi,
  type Account,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";

import { kudoAbi } from "./abi/kudo.js";
import { identityRegistryAbi, reputationRegistryAbi } from "./abi/registries.js";
import { KudoError, toKudoError } from "./errors.js";
import { resolveNetwork, type KudoNetwork, type NetworkKey } from "./networks.js";
import {
  COVENANT_TYPES,
  type AgentInfo,
  type AgentRecord,
  type Covenant,
  type CovenantFilter,
  type CovenantStage,
  type CovenantType,
  type MeetAskInput,
  type MintCovenantInput,
  type OpenAskFilter,
  type RegisterAgentInput,
  type TxRequest,
} from "./types.js";

export interface KudoOptions {
  /** A network key (`"robinhood"`) or a full config. Defaults to Robinhood mainnet. */
  network?: NetworkKey | KudoNetwork;
  /** Override any address or setting of the network. */
  overrides?: Partial<KudoNetwork>;
  /** RPC URL. Defaults to the chain's public endpoint. */
  rpcUrl?: string;
  /** Bring your own viem public client instead of `rpcUrl`. */
  publicClient?: PublicClient;
  /**
   * A viem wallet client with an account, for signing. The SDK never stores or
   * asks for a key: leave this out and use the `build*` methods to get
   * unsigned transactions for any signer.
   */
  walletClient?: WalletClient;
}

type RawCovenant = {
  agentWallet: Address;
  agentId: bigint;
  status: number;
  nftType: string;
  ask: string;
  covenantPromise: string;
  promiseDetail: string;
  askSettlementData: string;
  askSettledAt: bigint;
  promiseSettlementData: string;
};

const toBigInt = (value: bigint | number | string, what: string): bigint => {
  try {
    const n = BigInt(value);
    if (n < 0n) throw new Error();
    return n;
  } catch {
    throw new KudoError("INVALID_INPUT", `${what} must be a non-negative integer, got "${value}".`);
  }
};

export class Kudo {
  readonly network: KudoNetwork;
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient;

  constructor(options: KudoOptions = {}) {
    this.network = resolveNetwork(options.network, options.overrides);
    this.publicClient =
      options.publicClient ??
      (createPublicClient({
        chain: this.network.chain,
        transport: http(options.rpcUrl ?? this.network.chain.rpcUrls.default.http[0]),
      }) as PublicClient);
    this.walletClient = options.walletClient;
  }

  /** The connected account's address, if a wallet client was given. */
  get address(): Address | undefined {
    return this.walletClient?.account?.address;
  }

  get chainId(): number {
    return this.network.chain.id;
  }

  /* ------------------------------------------------------------------ reads */

  /** One covenant by id. */
  async getCovenant(id: bigint | number | string): Promise<Covenant> {
    const nftId = toBigInt(id, "Covenant id");
    try {
      const raw = (await this.publicClient.readContract({
        address: this.network.kudo,
        abi: kudoAbi,
        functionName: "getCovenant",
        args: [nftId],
      })) as RawCovenant;
      if (raw.agentWallet === zeroAddress) {
        throw new KudoError("NOT_FOUND", `Covenant ${nftId} does not exist.`);
      }
      return this.toCovenant(nftId, raw);
    } catch (error) {
      if (error instanceof KudoError) throw error;
      throw new KudoError("NOT_FOUND", `Covenant ${nftId} could not be read.`, { cause: error });
    }
  }

  /** Every covenant on the contract, newest first, filtered. */
  async listCovenants(filter: CovenantFilter = {}): Promise<Covenant[]> {
    const details = (await this.publicClient.readContract({
      address: this.network.kudo,
      abi: kudoAbi,
      functionName: "getCovenantsDetails",
    })) as readonly { nftId: bigint; owner: Address; covenantData: RawCovenant }[];

    const stages = filter.stage
      ? new Set(Array.isArray(filter.stage) ? filter.stage : [filter.stage])
      : undefined;
    const agentId = filter.agentId !== undefined ? toBigInt(filter.agentId, "agentId") : undefined;
    const wallet = filter.agentWallet?.toLowerCase();
    const type = filter.type?.toUpperCase();

    const out = details
      .map((d) => this.toCovenant(d.nftId, d.covenantData, d.owner))
      .filter(
        (c) =>
          (!stages || stages.has(c.stage)) &&
          (agentId === undefined || c.agentId === agentId) &&
          (!wallet || c.agentWallet.toLowerCase() === wallet) &&
          (!type || c.type.toUpperCase() === type),
      )
      .sort((a, b) => (a.id < b.id ? 1 : -1));

    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  /**
   * Covenants whose ask nobody has met yet: work you can perform and be paid
   * (or repaid) for. First to meet the ask takes it.
   */
  async listOpenAsks(filter: OpenAskFilter = {}): Promise<Covenant[]> {
    const exclude = (filter.excludeWallet ?? this.address)?.toLowerCase();
    const open = await this.listCovenants({
      stage: "ask-open",
      type: filter.type,
      agentId: filter.agentId,
    });
    const mine = (c: Covenant) => !!exclude && c.agentWallet.toLowerCase() === exclude;
    const out = open.filter((c) => !mine(c));
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  /** Identity facts for one ERC-8004 id. */
  async getAgent(agentId: bigint | number | string): Promise<AgentInfo> {
    const id = toBigInt(agentId, "agentId");
    const registry = this.network.identityRegistry;
    let owner: Address;
    try {
      owner = await this.publicClient.readContract({
        address: registry,
        abi: identityRegistryAbi,
        functionName: "ownerOf",
        args: [id],
      });
    } catch (error) {
      throw new KudoError("NOT_FOUND", `Agent ${id} is not registered on ${this.network.chain.name}.`, {
        cause: error,
      });
    }
    const meta = async (key: string) => {
      try {
        const bytes = await this.publicClient.readContract({
          address: registry,
          abi: identityRegistryAbi,
          functionName: "getMetadata",
          args: [id, key],
        });
        return bytes && bytes !== "0x" ? hexToString(bytes) : null;
      } catch {
        return null;
      }
    };
    const uri = await this.publicClient
      .readContract({ address: registry, abi: identityRegistryAbi, functionName: "tokenURI", args: [id] })
      .then((u) => u || null)
      .catch(() => null);
    const [name, teeId] = await Promise.all([meta("name"), meta("teeId")]);
    return { agentId: id, owner, name, teeId, uri };
  }

  /** An agent's identity plus its kept-vs-broken covenant record. */
  async agentRecord(agentId: bigint | number | string): Promise<AgentRecord> {
    const info = await this.getAgent(agentId);
    const all = await this.listCovenants({ agentId: info.agentId });
    // An id on a covenant is only meaningful when the wallet that minted it
    // owns the id; on older deployments anyone could write any number.
    const covenants = all.filter((c) => c.agentWallet.toLowerCase() === info.owner.toLowerCase());
    const count = (stage: CovenantStage) => covenants.filter((c) => c.stage === stage).length;
    return {
      ...info,
      covenants: {
        total: covenants.length,
        kept: count("completed"),
        broken: count("failed"),
        open: covenants.length - count("completed") - count("failed"),
      },
      reputation: await this.reputation(info.agentId),
      recent: covenants.slice(0, 10),
    };
  }

  private async reputation(agentId: bigint): Promise<AgentRecord["reputation"]> {
    const registry = this.network.reputationRegistry;
    if (!registry) return null;
    try {
      const clients = await this.publicClient.readContract({
        address: registry,
        abi: reputationRegistryAbi,
        functionName: "getClients",
        args: [agentId],
      });
      if (!clients.length) return null;
      const [count, value, decimals] = await this.publicClient.readContract({
        address: registry,
        abi: reputationRegistryAbi,
        functionName: "getSummary",
        args: [agentId, clients, "", ""],
      });
      return { count: Number(count), value: Number(value) / 10 ** decimals };
    } catch {
      return null;
    }
  }

  /**
   * The ERC-8004 ids a wallet owns, oldest first.
   *
   * The registry has no reverse lookup, so this reads `Registered` events
   * filtered on `owner` and `Transfer` events filtered on `to` (ids sent to
   * the wallet), walking back one RPC-sized window at a time until it has
   * found as many currently owned ids as `balanceOf` says exist.
   */
  async findAgentIds(wallet?: Address, options: { maxWindows?: number } = {}): Promise<bigint[]> {
    const owner = wallet ?? this.address;
    if (!owner) throw new KudoError("NO_WALLET", "Pass a wallet address or connect a wallet.");
    const registry = this.network.identityRegistry;

    const balance = await this.publicClient.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: "balanceOf",
      args: [owner],
    });
    if (balance === 0n) return [];

    const registered = getAbiItem({ abi: identityRegistryAbi, name: "Registered" });
    const transfer = getAbiItem({ abi: identityRegistryAbi, name: "Transfer" });
    // Registered names the first owner and Transfer a past recipient; either
    // may since have moved the id on, so every candidate is checked once.
    const checked = new Map<bigint, boolean>();
    const owns = (id: bigint) =>
      this.publicClient
        .readContract({ address: registry, abi: identityRegistryAbi, functionName: "ownerOf", args: [id] })
        .then((o) => o.toLowerCase() === owner.toLowerCase())
        .catch(() => false);
    const ownedCount = () => BigInt([...checked.values()].filter(Boolean).length);

    const range = this.network.maxLogRange;
    let to = await this.publicClient.getBlockNumber();
    for (let i = 0; i < (options.maxWindows ?? 20) && to >= 0n; i++) {
      const from = to > range ? to - range + 1n : 0n;
      const [minted, received] = await Promise.all([
        this.publicClient.getLogs({ address: registry, event: registered, args: { owner }, fromBlock: from, toBlock: to }),
        this.publicClient.getLogs({ address: registry, event: transfer, args: { to: owner }, fromBlock: from, toBlock: to }),
      ]);
      const candidates = new Set<bigint>();
      for (const log of minted) if (log.args.agentId !== undefined) candidates.add(log.args.agentId);
      for (const log of received) if (log.args.tokenId !== undefined) candidates.add(log.args.tokenId);
      const fresh = [...candidates].filter((id) => !checked.has(id));
      const results = await Promise.all(fresh.map(owns));
      fresh.forEach((id, j) => checked.set(id, results[j]!));
      if (ownedCount() >= balance || from === 0n) break;
      to = from - 1n;
    }

    return [...checked].filter(([, owned]) => owned).map(([id]) => id).sort((a, b) => (a < b ? -1 : 1));
  }

  /** ETH balance (gas) as a decimal string. */
  async ethBalance(wallet?: Address): Promise<string> {
    const who = wallet ?? this.address;
    if (!who) throw new KudoError("NO_WALLET", "Pass a wallet address or connect a wallet.");
    return formatUnits(await this.publicClient.getBalance({ address: who }), 18);
  }

  /**
   * The contract's ask cooldown setting, in seconds. Note: on the current
   * mainnet contract it does not stop a second `setAskSettlementData` from
   * replacing an earlier claim (tested on a fork), so never rely on it to
   * protect a claim; `meetAsk` checks before and after instead.
   */
  async getAskCooldown(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.network.kudo,
      abi: kudoAbi,
      functionName: "getAskCooldown",
    })) as bigint;
  }

  /**
   * Throws unless a covenant is waiting for its promise proof: the Evaluator
   * has accepted the claim on its ask (status IN_PROGRESS) and no promise
   * proof is linked yet. A claim alone does not make the promise due, and
   * linking twice replaces the first proof.
   */
  assertPromiseDue(covenant: Covenant): void {
    if (covenant.stage === "completed" || covenant.stage === "failed") {
      throw new KudoError("INVALID_INPUT", `Covenant ${covenant.id} is already closed as ${covenant.stage}.`);
    }
    if (covenant.promiseProof) {
      throw new KudoError("ALREADY_PROVEN", `Covenant ${covenant.id} already has promise proof ${covenant.promiseProof}. Do not pay or link again.`);
    }
    if (covenant.status !== "IN_PROGRESS") {
      throw new KudoError(
        "ASK_NOT_MET",
        covenant.askSettledAt
          ? `Covenant ${covenant.id}'s ask has been claimed but the Evaluator has not accepted it yet (status ${covenant.status}), so nothing is owed. Do not pay; wait for status IN_PROGRESS.`
          : `Covenant ${covenant.id}'s ask has not been met yet, so there is no promise to keep.`,
      );
    }
  }

  /* --------------------------------------------------------------- builders */

  /** Encodes any call on a Kudo or registry contract as an unsigned transaction. */
  buildTx<
    const abi extends Abi,
    functionName extends ContractFunctionName<abi, "nonpayable" | "payable">,
  >(call: {
    address: Address;
    abi: abi;
    functionName: functionName;
    args: ContractFunctionArgs<abi, "nonpayable" | "payable", functionName>;
    value?: bigint;
    description: string;
  }): TxRequest {
    return {
      to: call.address,
      data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as never),
      value: call.value ?? 0n,
      chainId: this.chainId,
      description: call.description,
    };
  }

  /** The mint transaction. Validates the text first; does not check ownership (see `mintCovenant`). */
  buildMintCovenant(input: MintCovenantInput): TxRequest {
    const agentId = toBigInt(input.agentId, "agentId");
    const type = String(input.type).toUpperCase() as CovenantType;
    if (!COVENANT_TYPES.includes(type)) {
      throw new KudoError(
        "INVALID_INPUT",
        `type must be one of ${COVENANT_TYPES.join(", ")}; got "${input.type}". Work on account is an INVOICE; money up front for later work is an ADVANCE.`,
      );
    }
    const ask = input.ask?.trim();
    const promise = input.promise?.trim();
    if (!ask) throw new KudoError("INVALID_INPUT", "ask is required: what the counterparty does.");
    if (!promise) throw new KudoError("INVALID_INPUT", "promise is required: what you do in return.");
    return this.buildTx({
      address: this.network.kudo,
      abi: kudoAbi,
      functionName: "mintCovenant",
      // The contract takes the promise before the ask.
      args: [agentId, promise, ask, type],
      description: `Mint a ${type} covenant under agent ${agentId}. Ask: "${ask}". Promise: "${promise}".`,
    });
  }

  /** The transaction a counterparty sends after performing a covenant's ask. */
  buildMeetAsk(id: bigint | number | string, input: MeetAskInput): TxRequest {
    const nftId = toBigInt(id, "Covenant id");
    const proof = input.proof?.trim();
    if (!proof) throw new KudoError("INVALID_INPUT", "proof is required: a tx hash or a URL showing the ask was met.");
    return this.buildTx({
      address: this.network.kudo,
      abi: kudoAbi,
      functionName: "setAskSettlementData",
      args: [nftId, proof, input.promiseDetail?.trim() ?? ""],
      description: `Meet the ask of covenant ${nftId} with proof ${proof}${input.promiseDetail ? ` and payment instruction "${input.promiseDetail}"` : ""}.`,
    });
  }

  /** The transaction the promiser sends after keeping the promise. */
  buildLinkProof(id: bigint | number | string, proof: string): TxRequest {
    const nftId = toBigInt(id, "Covenant id");
    const value = proof?.trim();
    if (!value) throw new KudoError("INVALID_INPUT", "proof is required: a tx hash or a URL showing the promise was kept.");
    return this.buildTx({
      address: this.network.kudo,
      abi: kudoAbi,
      functionName: "setPromiseSettlementData",
      args: [nftId, value],
      description: `Link proof ${value} that the promise of covenant ${nftId} was kept.`,
    });
  }

  /** Registers a new ERC-8004 identity owned by the signer. */
  buildRegisterAgent(input: RegisterAgentInput): TxRequest {
    const name = input.name?.trim();
    if (!name) throw new KudoError("INVALID_INPUT", "name is required.");
    const metadata = Object.entries({ name, ...(input.metadata ?? {}) }).map(([metadataKey, value]) => ({
      metadataKey,
      metadataValue: stringToHex(value),
    }));
    return this.buildTx({
      address: this.network.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "register",
      args: [input.uri ?? "", metadata],
      description: `Register an ERC-8004 agent identity named "${name}".`,
    });
  }

  /** Sets one metadata entry (e.g. `teeId`, `endpoint`, `name`) on an ERC-8004 identity. */
  buildSetAgentMetadata(agentId: bigint | number | string, key: string, value: string): TxRequest {
    const id = toBigInt(agentId, "agentId");
    const k = key?.trim();
    if (!k) throw new KudoError("INVALID_INPUT", "key is required.");
    return this.buildTx({
      address: this.network.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "setMetadata",
      args: [id, k, stringToHex(value ?? "")],
      description: `Set "${k}" to "${value}" on agent ${id}.`,
    });
  }

  /* ------------------------------------------------------------------ sends */

  private requireWallet(): { wallet: WalletClient; account: Account } {
    const wallet = this.walletClient;
    const account = wallet?.account;
    if (!wallet || !account) {
      throw new KudoError(
        "NO_WALLET",
        "This needs a signer. Pass a viem walletClient with an account to createKudo, or use the build* method and sign the transaction yourself.",
      );
    }
    return { wallet, account };
  }

  /**
   * Simulates, signs, sends and waits for one transaction. Throws a KudoError
   * naming the revert if the simulation or the receipt fails.
   */
  async send(tx: TxRequest): Promise<TransactionReceipt> {
    const { wallet, account } = this.requireWallet();
    await this.simulate(tx, account.address);
    let hash: Hex;
    try {
      hash = await wallet.sendTransaction({
        account,
        chain: this.network.chain,
        to: tx.to,
        data: tx.data,
        value: tx.value,
      });
    } catch (error) {
      throw toKudoError(error, tx.description);
    }
    // One send at a time per key: blocks here come every ~0.2s and a second
    // send before the receipt lands collides on the nonce.
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new KudoError("TX_FAILED", `${tx.description} — transaction ${hash} reverted.`);
    }
    return receipt;
  }

  /**
   * Dry-runs a transaction as `from` without signing anything. Throws a
   * KudoError naming the revert, so a bad mint costs nothing.
   */
  async simulate(tx: TxRequest, from: Address): Promise<void> {
    try {
      await this.publicClient.call({ account: from, to: tx.to, data: tx.data, value: tx.value });
    } catch (error) {
      throw toKudoError(error, tx.description);
    }
  }

  /** Broadcasts a transaction someone already signed. For agents that sign offline. */
  async sendRawTransaction(serialized: Hex): Promise<{ hash: Hex; status: "success" | "reverted" }> {
    try {
      const hash = await this.publicClient.sendRawTransaction({ serializedTransaction: serialized });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      return { hash, status: receipt.status };
    } catch (error) {
      throw toKudoError(error, "Broadcasting the signed transaction");
    }
  }

  /**
   * Mints a covenant and returns its id.
   *
   * Checks first that the signer owns `agentId`: the contract refuses a mint
   * under an id the caller does not control, and a mint is permanent — a
   * second attempt adds a duplicate rather than replacing the first.
   */
  async mintCovenant(input: MintCovenantInput): Promise<{ hash: Hex; covenantId: bigint; url?: string }> {
    const { account } = this.requireWallet();
    const tx = this.buildMintCovenant(input);
    const agentId = toBigInt(input.agentId, "agentId");
    const owner = await this.getAgent(agentId).then((a) => a.owner);
    if (owner.toLowerCase() !== account.address.toLowerCase()) {
      throw new KudoError(
        "NOT_AGENT_OWNER",
        `Agent ${agentId} belongs to ${owner}, not ${account.address}. Mint under an id this wallet owns.`,
      );
    }
    const receipt = await this.send(tx);
    const covenantId = this.mintedId(receipt);
    return { hash: receipt.transactionHash, covenantId, url: this.covenantUrl(covenantId) };
  }

  /** Reads the new covenant id out of a mint receipt. */
  mintedId(receipt: TransactionReceipt): bigint {
    const kudo = this.network.kudo.toLowerCase();
    const minted = parseEventLogs({ abi: kudoAbi, eventName: "CovenantMinted", logs: receipt.logs }).find(
      (l) => l.address.toLowerCase() === kudo,
    );
    if (minted) return (minted.args as { nftId: bigint }).nftId;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== kudo) continue;
      try {
        const e = decodeEventLog({ abi: kudoAbi, data: log.data, topics: log.topics });
        if (e.eventName === "Transfer" && (e.args as { from: Address }).from === zeroAddress) {
          return (e.args as unknown as { tokenId: bigint }).tokenId;
        }
      } catch {
        /* not one of ours */
      }
    }
    throw new KudoError("NOT_FOUND", `Transaction ${receipt.transactionHash} minted no covenant.`);
  }

  /**
   * Meets a covenant's ask: you did the work (or sent the money), now record
   * the proof. Refuses if someone already met it — attesting over them would
   * overwrite their claim (the contract does not prevent that) and restart
   * the promiser's clock. After mining it re-reads the
   * covenant and throws ALREADY_MET if the proof on chain is not yours.
   */
  async meetAsk(id: bigint | number | string, input: MeetAskInput): Promise<{ hash: Hex }> {
    const { account } = this.requireWallet();
    const tx = this.buildMeetAsk(id, input);
    const covenant = await this.getCovenant(id);
    if (covenant.askSettledAt) {
      throw new KudoError("ALREADY_MET", `Covenant ${covenant.id}'s ask was already met at ${covenant.askSettledAt.toISOString()} with ${covenant.askProof}.`);
    }
    if (covenant.stage !== "ask-open") {
      throw new KudoError("ALREADY_MET", `Covenant ${covenant.id} is ${covenant.status} (${covenant.stage}); its ask is no longer open.`);
    }
    if (covenant.agentWallet.toLowerCase() === account.address.toLowerCase()) {
      throw new KudoError("INVALID_INPUT", `You minted covenant ${covenant.id}; you cannot be your own counterparty.`);
    }
    const receipt = await this.send(tx);
    // Another agent may have met it between the read above and this block.
    const after = await this.getCovenant(id);
    if (after.askProof !== input.proof.trim()) {
      throw new KudoError(
        "ALREADY_MET",
        `Transaction ${receipt.transactionHash} was mined, but covenant ${after.id}'s ask now carries ${after.askProof}, not your proof: another agent met it first.`,
      );
    }
    return { hash: receipt.transactionHash };
  }

  /**
   * Links proof that you kept your promise. Only the covenant's agentWallet
   * may, only once its ask is met, and only once.
   */
  async linkProof(id: bigint | number | string, proof: string): Promise<{ hash: Hex }> {
    const { account } = this.requireWallet();
    const tx = this.buildLinkProof(id, proof);
    const covenant = await this.getCovenant(id);
    if (covenant.agentWallet.toLowerCase() !== account.address.toLowerCase()) {
      throw new KudoError("NOT_PROMISER", `Covenant ${covenant.id}'s promise is owed by ${covenant.agentWallet}; only that wallet can link its proof.`);
    }
    this.assertPromiseDue(covenant);
    const receipt = await this.send(tx);
    return { hash: receipt.transactionHash };
  }

  /**
   * Registers an ERC-8004 identity and returns its id. Refuses if the wallet
   * already has one, because a second registration cannot be undone; pass
   * `allowAnother` to register anyway.
   */
  async registerAgent(input: RegisterAgentInput & { allowAnother?: boolean }): Promise<{ hash: Hex; agentId: bigint }> {
    const { account } = this.requireWallet();
    const tx = this.buildRegisterAgent(input);
    if (!input.allowAnother) {
      const balance = await this.publicClient.readContract({
        address: this.network.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "balanceOf",
        args: [account.address],
      });
      if (balance > 0n) {
        throw new KudoError(
          "ALREADY_REGISTERED",
          `${account.address} already owns ${balance} agent identit${balance === 1n ? "y" : "ies"}. Use findAgentIds() to recover the id.`,
        );
      }
    }
    const receipt = await this.send(tx);
    const registered = parseEventLogs({ abi: identityRegistryAbi, eventName: "Registered", logs: receipt.logs })[0];
    if (!registered) throw new KudoError("NOT_FOUND", `Transaction ${receipt.transactionHash} registered no identity.`);
    return { hash: receipt.transactionHash, agentId: registered.args.agentId };
  }

  /**
   * Sets one metadata entry on an identity this wallet owns. Refuses an id
   * owned by anyone else before anything is signed.
   */
  async setAgentMetadata(agentId: bigint | number | string, key: string, value: string): Promise<{ hash: Hex }> {
    const { account } = this.requireWallet();
    const tx = this.buildSetAgentMetadata(agentId, key, value);
    const id = toBigInt(agentId, "agentId");
    const owner = (await this.getAgent(id)).owner;
    if (owner.toLowerCase() !== account.address.toLowerCase()) {
      throw new KudoError("NOT_AGENT_OWNER", `Agent ${id} belongs to ${owner}, not ${account.address}.`);
    }
    const receipt = await this.send(tx);
    return { hash: receipt.transactionHash };
  }

  /**
   * Resolves when a covenant reaches `until` (default: closed, i.e. completed
   * or failed). Polls, so it works on any RPC.
   */
  async watchSettlement(
    id: bigint | number | string,
    options: {
      until?: CovenantStage[];
      intervalMs?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
      onChange?: (covenant: Covenant) => void;
    } = {},
  ): Promise<Covenant> {
    const until = new Set(options.until ?? ["completed", "failed"]);
    const interval = options.intervalMs ?? 5_000;
    const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : Infinity;
    let last: CovenantStage | undefined;
    for (;;) {
      if (options.signal?.aborted) throw new KudoError("TIMEOUT", "Watching was cancelled.");
      const covenant = await this.getCovenant(id);
      if (covenant.stage !== last) {
        last = covenant.stage;
        options.onChange?.(covenant);
      }
      if (until.has(covenant.stage)) return covenant;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new KudoError("TIMEOUT", `Covenant ${covenant.id} is still ${covenant.stage}.`);
      }
      // Sleep until the next poll or the deadline, whichever is first, so the
      // last read lands at the deadline; an abort wakes the sleep at once.
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(interval, remaining));
        options.signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  /* ---------------------------------------------------------------- helpers */

  covenantUrl(id: bigint): string | undefined {
    return this.network.covenantUrl?.replace("{id}", id.toString());
  }

  txUrl(hash: Hex): string {
    return `${this.network.explorerUrl}/tx/${hash}`;
  }

  private toCovenant(id: bigint, raw: RawCovenant, owner?: Address): Covenant {
    const status = this.network.statuses[raw.status] ?? "MINTED";
    const askSettledAt = raw.askSettledAt > 0n ? new Date(Number(raw.askSettledAt) * 1000) : null;
    // Only the Evaluator makes a promise due, by setting IN_PROGRESS once it
    // has accepted the claim on the ask. A claim alone is "ask-claimed".
    const stage: CovenantStage =
      status === "FAILED"
        ? "failed"
        : status === "COMPLETED"
          ? "completed"
          : raw.promiseSettlementData
            ? "awaiting-evaluation"
            : status === "IN_PROGRESS"
              ? "promise-due"
              : askSettledAt
                ? "ask-claimed"
                : "ask-open";
    return {
      id,
      owner,
      agentWallet: raw.agentWallet,
      agentId: raw.agentId,
      status,
      stage,
      type: raw.nftType,
      ask: raw.ask,
      promise: raw.covenantPromise,
      promiseDetail: raw.promiseDetail,
      askProof: raw.askSettlementData,
      askSettledAt,
      promiseProof: raw.promiseSettlementData,
      url: this.covenantUrl(id),
    };
  }
}

/** Creates a Kudo client. With no options it reads Robinhood Chain mainnet. */
export function createKudo(options: KudoOptions = {}): Kudo {
  return new Kudo(options);
}
