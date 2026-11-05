import { decodeFunctionData, erc20Abi, hexToString } from "viem";
import { describe, expect, it } from "vitest";

import { createKudo, identityRegistryAbi, kudoAbi, KudoError } from "../src/index.js";
import { kudoTools, runTool } from "../src/tools.js";

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

  it("pay USDG uses six decimals", () => {
    const tx = kudo.buildPayUsdg({ to: "0x09977Cb96F040522E33d69656b087f910dC3385c", amount: "5.25" });
    const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(args?.[1]).toBe(5_250_000n);
    expect(tx.to).toBe(kudo.network.usdg);
    expect(() => kudo.buildPayUsdg({ to: "0x123" as never, amount: 1 })).toThrow(/not an address/);
    expect(() => kudo.buildPayUsdg({ to: "0x09977Cb96F040522E33d69656b087f910dC3385c", amount: 0 })).toThrow(/more than zero/);
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


describe("tools", () => {
  it("is unsigned without a wallet, and offers broadcast", () => {
    const names = kudoTools({ kudo }).map((t) => t.name);
    expect(names).toContain("send_signed_transaction");
    expect(names).toEqual(expect.arrayContaining(["how_to_connect", "mint_covenant", "meet_ask", "link_proof", "list_open_asks", "agent_record"]));
  });

  it("validates input and reports errors without throwing", async () => {
    const mint = kudoTools({ kudo }).find((t) => t.name === "mint_covenant")!;
    const bad = await runTool(mint, { type: "GIFT", ask: "x", promise: "y" });
    expect(bad.ok).toBe(false);
    const noId = await runTool(mint, { type: "LOAN", ask: "Lend me 5 USDG", promise: "I'll repay 5.1 USDG" });
    expect(noId).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("returns an unsigned transaction for a mint", async () => {
    const mint = kudoTools({ kudo, defaultAgentId: 5n }).find((t) => t.name === "mint_covenant")!;
    const out = await runTool(mint, { type: "LOAN", ask: "Lend me 5 USDG for gas.", promise: "I'll repay 5.1 USDG within one day." });
    expect(out.ok).toBe(true);
    expect((out as { result: { signed: boolean; unsignedTransaction: { value: string } } }).result).toMatchObject({
      signed: false,
      unsignedTransaction: { value: "0", chainId: 4663 },
    });
  });
});
