import { decodeFunctionData, hexToString } from "viem";
import { describe, expect, it } from "vitest";

import { createKudo, identityRegistryAbi, kudoAbi, KudoError } from "../src/index.js";
import type { Covenant } from "../src/index.js";

const kudo = createKudo();

describe("buildMintCovenant", () => {
  it("encodes promise before ask, as the contract expects", () => {
    const tx = kudo.buildMintCovenant({
      agentId: 42,
      type: "invoice" as never,
      ask: "Write the explainer.",
      promise: "I'll pay 5 USDG within one hour.",
    });
    const { functionName, args } = decodeFunctionData({ abi: kudoAbi, data: tx.data });
    expect(functionName).toBe("mintCovenant");
    expect(args).toEqual([42n, "I'll pay 5 USDG within one hour.", "Write the explainer.", "INVOICE"]);
    expect(tx.to).toBe(kudo.network.kudo);
    expect(tx.chainId).toBe(4663);
    expect(tx.value).toBe(0n);
  });

  it("refuses unknown types and empty text, and allows any amount", () => {
    const base = { agentId: 1, ask: "Lend me 5 USDG", promise: "I'll repay 5.1 USDG" };
    expect(() => kudo.buildMintCovenant({ ...base, type: "GIFT" as never })).toThrow(KudoError);
    expect(() => kudo.buildMintCovenant({ ...base, type: "LOAN", ask: "  " })).toThrow(/ask is required/);
    expect(() => kudo.buildMintCovenant({ ...base, type: "LOAN", ask: "Lend me 50,000 USDG", promise: "I'll repay 51,000 USDG" })).not.toThrow();
    expect(() => kudo.buildMintCovenant({ ...base, type: "LOAN", agentId: -1 })).toThrow(/non-negative/);
  });

});

describe("other builders", () => {
  it("meet ask carries proof and payment instruction", () => {
    const tx = kudo.buildMeetAsk(7, { proof: "https://ipfs.io/ipfs/x", promiseDetail: "pay: 0xabc" });
    const { functionName, args } = decodeFunctionData({ abi: kudoAbi, data: tx.data });
    expect(functionName).toBe("setAskSettlementData");
    expect(args).toEqual([7n, "https://ipfs.io/ipfs/x", "pay: 0xabc"]);
  });

  it("link proof", () => {
    const { functionName, args } = decodeFunctionData({ abi: kudoAbi, data: kudo.buildLinkProof("9", "0xdead").data });
    expect(functionName).toBe("setPromiseSettlementData");
    expect(args).toEqual([9n, "0xdead"]);
  });

  it("register writes name and extra metadata as UTF-8", () => {
    const tx = kudo.buildRegisterAgent({ name: "Ada", metadata: { endpoint: "https://ada.example" } });
    const { args } = decodeFunctionData({ abi: identityRegistryAbi, data: tx.data });
    const meta = args?.[1] as readonly { metadataKey: string; metadataValue: `0x${string}` }[];
    expect(meta.map((m) => [m.metadataKey, hexToString(m.metadataValue)])).toEqual([
      ["name", "Ada"],
      ["endpoint", "https://ada.example"],
    ]);
  });
});


describe("assertPromiseDue", () => {
  const base = {
    id: 1n,
    agentWallet: "0x09977Cb96F040522E33d69656b087f910dC3385c",
    agentId: 1n,
    status: "IN_PROGRESS",
    stage: "promise-due",
    type: "INVOICE",
    ask: "a",
    promise: "p",
    promiseDetail: "pay: 0xabc",
    askProof: "https://ipfs.io/ipfs/x",
    askSettledAt: new Date(),
    promiseProof: "",
  } as Covenant;

  it("passes when the Evaluator accepted the ask and no promise proof is linked", () => {
    expect(() => kudo.assertPromiseDue(base)).not.toThrow();
  });
  it("refuses before the ask is met", () => {
    expect(() => kudo.assertPromiseDue({ ...base, status: "MINTED", stage: "ask-open", askSettledAt: null, askProof: "" })).toThrow(/not been met/);
  });
  it("refuses a claim the Evaluator has not accepted yet, so nobody pays on a bare claim", () => {
    expect(() => kudo.assertPromiseDue({ ...base, status: "MINTED", stage: "ask-claimed" })).toThrow(/not accepted it yet/);
  });
  it("refuses a second proof, so nobody pays twice", () => {
    expect(() => kudo.assertPromiseDue({ ...base, stage: "awaiting-evaluation", promiseProof: "0xdead" })).toThrow(/already has promise proof/);
  });
  it("passes when the Evaluator marked it IN_PROGRESS, even with no claim on record", () => {
    expect(() => kudo.assertPromiseDue({ ...base, status: "IN_PROGRESS", askSettledAt: null, askProof: "" })).not.toThrow();
  });
  it("refuses a closed covenant", () => {
    expect(() => kudo.assertPromiseDue({ ...base, stage: "completed", status: "COMPLETED" })).toThrow(/already closed/);
  });
});

describe("the library", () => {
  it("has no payment method and only the current mainnet contract", async () => {
    expect((kudo as unknown as Record<string, unknown>).payUsdg).toBeUndefined();
    expect((kudo as unknown as Record<string, unknown>).buildPayUsdg).toBeUndefined();
    const { networks } = await import("../src/index.js");
    expect(Object.keys(networks)).toEqual(["robinhood"]);
    expect(networks.robinhood.kudo).toBe("0x1930D0FEaB14b024353bF22adE03Db989aD640C7");
  });
});
