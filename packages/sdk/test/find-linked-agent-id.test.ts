import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import { findLinkedAgentId } from "../src/index.js";

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address;
const AGENT = "0x00000000000000000000000000000000000000aa" as Address;
const OTHER = "0x00000000000000000000000000000000000000bb" as Address;

/**
 * A chain at block 100 with agentWallet records { id, block, wallet }, the
 * current agentWallet of each id, and an RPC that refuses windows wider than
 * `maxWindow` blocks.
 */
function chain(records: Array<{ id: bigint; block: bigint; wallet: Address }>, current: Record<string, Address>, maxWindow = 1000n) {
  const windows: Array<[bigint, bigint]> = [];
  const client = {
    getBlockNumber: async () => 100n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock + 1n > maxWindow) throw new Error("query returned more than 10000 results");
      windows.push([fromBlock, toBlock]);
      return records
        .filter((r) => r.block >= fromBlock && r.block <= toBlock)
        .map((r) => ({ args: { agentId: r.id, metadataValue: r.wallet.toLowerCase() } }));
    },
    readContract: async ({ args }: { args: [bigint] }) => current[String(args[0])] ?? "0x0000000000000000000000000000000000000000",
  };
  return { client: client as never, windows };
}

describe("findLinkedAgentId", () => {
  it("finds the identity whose agent wallet this is, newest first", async () => {
    const { client } = chain(
      [
        { id: 5n, block: 20n, wallet: AGENT },
        { id: 9n, block: 60n, wallet: OTHER },
      ],
      { "5": AGENT, "9": OTHER },
    );
    expect(await findLinkedAgentId(client, REGISTRY, AGENT, 1000n)).toBe(5n);
  });

  it("skips a link that was later undone, by transfer or relink", async () => {
    const { client } = chain(
      [
        { id: 5n, block: 20n, wallet: AGENT },
        { id: 7n, block: 80n, wallet: AGENT },
      ],
      { "5": AGENT, "7": OTHER },
    );
    expect(await findLinkedAgentId(client, REGISTRY, AGENT, 1000n)).toBe(5n);
  });

  it("halves a window the RPC refuses, then walks on", async () => {
    const { client, windows } = chain([{ id: 3n, block: 10n, wallet: AGENT }], { "3": AGENT }, 40n);
    expect(await findLinkedAgentId(client, REGISTRY, AGENT, 100n)).toBe(3n);
    expect(windows.every(([from, to]) => to - from + 1n <= 40n)).toBe(true);
  });

  it("reports none for a wallet nobody linked", async () => {
    const { client } = chain([{ id: 5n, block: 20n, wallet: OTHER }], { "5": OTHER });
    expect(await findLinkedAgentId(client, REGISTRY, AGENT, 1000n)).toBeUndefined();
  });
});
