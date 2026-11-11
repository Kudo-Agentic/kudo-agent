import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import { findRegistrationBy } from "../src/index.js";

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address;
const AGENT = "0x00000000000000000000000000000000000000aa" as Address;

/** A chain at block 100 where AGENT registered the given ids at the given blocks. */
function chain(registrations: Array<{ id: bigint; block: bigint }>) {
  const windows: Array<[bigint, bigint]> = [];
  const client = {
    getBlockNumber: async () => 100n,
    getLogs: async ({ args, fromBlock, toBlock }: { args: { owner: Address }; fromBlock: bigint; toBlock: bigint }) => {
      windows.push([fromBlock, toBlock]);
      return registrations
        .filter((r) => args.owner === AGENT && r.block >= fromBlock && r.block <= toBlock)
        .map((r) => ({ args: { agentId: r.id } }));
    },
  };
  return { client: client as never, windows };
}

describe("findRegistrationBy", () => {
  it("finds the id however many windows back, newest first", async () => {
    const { client, windows } = chain([{ id: 5n, block: 12n }, { id: 9n, block: 15n }]);
    expect(await findRegistrationBy(client, REGISTRY, AGENT, 30n)).toBe(9n);
    expect(windows).toEqual([[71n, 100n], [41n, 70n], [11n, 40n]]);
  });

  it("stops at fromBlock, so a launched agent scans one window", async () => {
    const { client, windows } = chain([]);
    expect(await findRegistrationBy(client, REGISTRY, AGENT, 1000n, 90n)).toBeUndefined();
    expect(windows).toEqual([[90n, 100n]]);
  });

  it("walks to genesis without fromBlock and reports none", async () => {
    const { client, windows } = chain([]);
    expect(await findRegistrationBy(client, REGISTRY, AGENT, 60n)).toBeUndefined();
    expect(windows).toEqual([[41n, 100n], [0n, 40n]]);
  });
});
