import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";

import { createKudo } from "../src/index.js";

const ME = "0x00000000000000000000000000000000000000aa" as Address;
const OTHER = "0x00000000000000000000000000000000000000bb" as Address;

/** A stand-in public client: ids 1 (registered, still mine), 2 (registered, given away), 7 (sent to me). */
function fakeClient(owners: Record<string, Address>) {
  const calls: string[] = [];
  const client = {
    getBlockNumber: async () => 100n,
    getLogs: async ({ event, args }: { event: { name: string }; args: Record<string, Address> }) => {
      calls.push(event.name);
      if (event.name === "Registered" && args.owner === ME) return [{ args: { agentId: 1n } }, { args: { agentId: 2n } }];
      if (event.name === "Transfer" && args.to === ME) return [{ args: { tokenId: 7n } }];
      return [];
    },
    readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      if (functionName === "balanceOf") return BigInt(Object.values(owners).filter((o) => o === ME).length);
      if (functionName === "ownerOf") return owners[String(args[0])] ?? OTHER;
      throw new Error(`unexpected ${functionName}`);
    },
  };
  return { client: client as unknown as PublicClient, calls };
}

describe("findAgentIds", () => {
  it("finds ids registered by the wallet and ids transferred to it, and drops ids it gave away", async () => {
    const { client, calls } = fakeClient({ "1": ME, "2": OTHER, "7": ME });
    const ids = await createKudo({ publicClient: client }).findAgentIds(ME);
    expect(ids).toEqual([1n, 7n]);
    expect(calls).toContain("Transfer");
  });

  it("returns nothing without scanning when the wallet owns no id", async () => {
    const { client, calls } = fakeClient({});
    expect(await createKudo({ publicClient: client }).findAgentIds(ME)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
