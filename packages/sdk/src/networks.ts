import { defineChain, type Address, type Chain } from "viem";

/**
 * Everything the SDK needs to know about one deployment.
 *
 * `statuses` is the contract's status enum in order. The current mainnet
 * contract restored MINTED, so its `0` is Minted; older deployments started
 * at Ongoing. Getting this wrong reads every open covenant as finished.
 */
export interface KudoNetwork {
  key: string;
  chain: Chain;
  kudo: Address;
  usdg: Address;
  identityRegistry: Address;
  reputationRegistry?: Address;
  statuses: readonly CovenantStatus[];
  /** Where a covenant card can be opened, `{id}` replaced. */
  covenantUrl?: string;
  explorerUrl: string;
  /** Widest block range the RPC accepts in one `eth_getLogs`. */
  maxLogRange: bigint;
}

export type CovenantStatus = "MINTED" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

export const robinhood: Chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11" },
  },
});

export const robinhoodTestnet: Chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" },
  },
  testnet: true,
});

export const networks = {
  /** Robinhood Chain mainnet, where app.kudo.archi reads and writes. */
  robinhood: {
    key: "robinhood",
    chain: robinhood,
    kudo: "0x1930D0FEaB14b024353bF22adE03Db989aD640C7",
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    statuses: ["MINTED", "IN_PROGRESS", "COMPLETED", "FAILED"],
    covenantUrl: "https://app.kudo.archi/share/{id}",
    explorerUrl: "https://robinhoodchain.blockscout.com",
    maxLogRange: 10_000_000n,
  },
  /** Robinhood Chain testnet. USDG here is a mock with an open mint. */
  "robinhood-testnet": {
    key: "robinhood-testnet",
    chain: robinhoodTestnet,
    kudo: "0x7021279517a7b301b8d10eD9c3b9F73C101146f1",
    usdg: "0xc44DB72f7d3185b6AAA7907434592EB7689D0100",
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    statuses: ["IN_PROGRESS", "COMPLETED", "FAILED"],
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
    maxLogRange: 10_000_000n,
  },
} as const satisfies Record<string, KudoNetwork>;

export type NetworkKey = keyof typeof networks;

/** Resolves a key or a full config, with any field overridden. */
export function resolveNetwork(
  network: NetworkKey | KudoNetwork = "robinhood",
  overrides: Partial<KudoNetwork> = {},
): KudoNetwork {
  const base = typeof network === "string" ? networks[network] : network;
  if (!base) {
    throw new Error(
      `Unknown Kudo network "${String(network)}". Known: ${Object.keys(networks).join(", ")}`,
    );
  }
  return { ...base, ...overrides };
}
