import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { DSTACK_KEY_PATH, Kudo, KudoError, dstackPrivateKey, networks, type KudoOptions, type NetworkKey } from "@kudo-dev/sdk";

/**
 * The environment variables @kudo-dev/mcp and @kudo-dev/plugin-kudo read.
 *
 * | Variable           | Meaning                                                    |
 * |--------------------|------------------------------------------------------------|
 * | KUDO_PRIVATE_KEY   | signs locally. Leave unset for read-only / unsigned mode.  |
 * | KUDO_AGENT_ID      | your ERC-8004 id; the default for mint                     |
 * | KUDO_NETWORK       | `robinhood` (the default, and the only network)            |
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

/**
 * Where the signing key comes from.
 *
 * - `env` (default): `KUDO_PRIVATE_KEY`.
 * - `dstack`: derived inside a Phala TEE by dstack, from `KUDO_DSTACK_KEY_PATH`
 *   (default `kudo/agent`, the path the Kudo skill uses) over
 *   `KUDO_DSTACK_SOCKET` (default `/var/run/dstack.sock`). `KUDO_PRIVATE_KEY`
 *   is ignored, and a missing socket is an error rather than a silent fallback
 *   to some other key.
 */
export type KeySource = "env" | "dstack";

export interface KudoKeyEnv extends KudoEnv {
  KUDO_KEY_SOURCE?: string;
  KUDO_DSTACK_KEY_PATH?: string;
  KUDO_DSTACK_SOCKET?: string;
}

/** Like kudoFromEnv, with the key taken from dstack when KUDO_KEY_SOURCE=dstack. */
export async function kudoFromEnvWithKeySource(
  env: KudoKeyEnv = (globalThis as { process?: { env: KudoKeyEnv } }).process?.env ?? {},
  options: Omit<KudoOptions, "walletClient" | "network" | "rpcUrl"> = {},
): Promise<{ kudo: Kudo; agentId?: bigint; keySource: KeySource; warnings: string[] }> {
  const raw = (env.KUDO_KEY_SOURCE?.trim().toLowerCase() || "env") as KeySource;
  if (raw !== "env" && raw !== "dstack") {
    throw new KudoError("INVALID_INPUT", `KUDO_KEY_SOURCE must be "env" or "dstack", got "${env.KUDO_KEY_SOURCE}".`);
  }
  const warnings: string[] = [];
  if (raw === "env") return { ...kudoFromEnv(env, options), keySource: "env", warnings };

  if (env.KUDO_PRIVATE_KEY?.trim()) {
    warnings.push("KUDO_PRIVATE_KEY is set but ignored: KUDO_KEY_SOURCE=dstack takes the key from the TEE.");
  }
  const key = await dstackPrivateKey(env.KUDO_DSTACK_KEY_PATH?.trim() || DSTACK_KEY_PATH, {
    socket: env.KUDO_DSTACK_SOCKET?.trim() || undefined,
  });
  return { ...kudoFromEnv({ ...env, KUDO_PRIVATE_KEY: key }, options), keySource: "dstack", warnings };
}
