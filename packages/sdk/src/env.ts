import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { Kudo, type KudoOptions } from "./client.js";
import { KudoError } from "./errors.js";
import { networks, type NetworkKey } from "./networks.js";

/**
 * The environment variables every Kudo integration reads.
 *
 * | Variable           | Meaning                                                    |
 * |--------------------|------------------------------------------------------------|
 * | KUDO_PRIVATE_KEY   | signs locally. Leave unset for read-only / unsigned mode.  |
 * | KUDO_AGENT_ID      | your ERC-8004 id; the default for mint                     |
 * | KUDO_NETWORK       | `robinhood` (default) or `robinhood-testnet`               |
 * | KUDO_RPC_URL       | RPC override                                               |
 */
export interface KudoEnv {
  KUDO_PRIVATE_KEY?: string;
  KUDO_AGENT_ID?: string;
  KUDO_NETWORK?: string;
  KUDO_RPC_URL?: string;
}

export function kudoFromEnv(
  env: KudoEnv = (globalThis as { process?: { env: KudoEnv } }).process?.env ?? {},
  options: Omit<KudoOptions, "walletClient" | "network" | "rpcUrl"> & { ignoreKey?: boolean } = {},
): { kudo: Kudo; agentId?: bigint } {
  const networkKey = (env.KUDO_NETWORK?.trim() || "robinhood") as NetworkKey;
  if (!(networkKey in networks)) {
    throw new KudoError("INVALID_INPUT", `KUDO_NETWORK="${networkKey}" is not one of ${Object.keys(networks).join(", ")}.`);
  }
  const network = networks[networkKey];
  const rpcUrl = env.KUDO_RPC_URL?.trim() || network.chain.rpcUrls.default.http[0];

  let walletClient: KudoOptions["walletClient"];
  const raw = env.KUDO_PRIVATE_KEY?.trim();
  if (raw && !options.ignoreKey) {
    const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new KudoError("INVALID_INPUT", "KUDO_PRIVATE_KEY must be a 32-byte hex private key.");
    }
    walletClient = createWalletClient({ account: privateKeyToAccount(key), chain: network.chain, transport: http(rpcUrl) });
  }

  const id = env.KUDO_AGENT_ID?.trim();
  let agentId: bigint | undefined;
  if (id) {
    try {
      agentId = BigInt(id);
    } catch {
      throw new KudoError("INVALID_INPUT", `KUDO_AGENT_ID must be a number, got "${id}".`);
    }
  }
  return { kudo: new Kudo({ ...options, network: networkKey, rpcUrl, walletClient }), agentId };
}
