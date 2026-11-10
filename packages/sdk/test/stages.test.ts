import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";

import { createKudo } from "../src/index.js";

const MINTER = "0x00000000000000000000000000000000000000aa" as Address;
const raw = (status: number, askSettledAt: bigint, promiseProof = "") => ({
  agentWallet: MINTER,
  agentId: 1n,
  status,
  nftType: "INVOICE",
  ask: "a",
  covenantPromise: "p",
  promiseDetail: "",
  askSettlementData: askSettledAt ? "https://ipfs.io/ipfs/x" : "",
  askSettledAt,
  promiseSettlementData: promiseProof,
});

// 1: open. 2: accepted by the Evaluator with no claim on record. 3: claimed. 4: accepted and proven.
const covenants = new Map([
  [1n, raw(0, 0n)],
  [2n, raw(1, 0n)],
  [3n, raw(0, 1_700_000_000n)],
  [4n, raw(1, 1_700_000_000n, "0xpaid")],
]);
const client = {
  readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
    if (functionName === "getCovenant") return covenants.get(args![0] as bigint);
    if (functionName === "getCovenantsDetails") {
      return [...covenants].map(([nftId, covenantData]) => ({ nftId, owner: MINTER, covenantData }));
    }
    throw new Error(`unexpected ${functionName}`);
  },
} as unknown as PublicClient;
const kudo = createKudo({ publicClient: client });

describe("stage and status IN_PROGRESS", () => {
  it("makes a promise due only at IN_PROGRESS; a bare claim is ask-claimed", async () => {
    expect((await kudo.getCovenant(2n)).stage).toBe("promise-due");
    expect((await kudo.getCovenant(3n)).stage).toBe("ask-claimed");
    expect((await kudo.getCovenant(4n)).stage).toBe("awaiting-evaluation");
  });

  it("never lists an IN_PROGRESS covenant as an open ask", async () => {
    const open = await kudo.listOpenAsks({ excludeWallet: "0x00000000000000000000000000000000000000bb" });
    expect(open.map((c) => c.id)).toEqual([1n]);
  });

  it("counts only IN_PROGRESS covenants among the promises owed", async () => {
    const owed = await kudo.listCovenants({ agentWallet: MINTER, stage: "promise-due" });
    expect(owed.map((c) => c.id)).toEqual([2n]);
  });
});
