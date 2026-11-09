import { readdirSync } from "node:fs";
import { createKudo } from "@kudo-dev/sdk";
import { createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { kudoTools, runTool } from "../src/index.js";

const kudo = createKudo();
const signer = createKudo({
  walletClient: createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), transport: http("http://127.0.0.1:1") }),
});

describe("tool list", () => {
  it("has one file per tool, and every file is in the list", () => {
    const files = readdirSync(new URL("../src", import.meta.url))
      .filter((f) => !["index.ts", "shared.ts", "env.ts"].includes(f))
      .map((f) => f.replace(/\.ts$/, "").replace(/-/g, "_"))
      .sort();
    expect(kudoTools({ kudo }).map((t) => t.name).sort()).toEqual(files);
  });

  it("only touches Kudo: no tool moves tokens", () => {
    for (const k of [kudo, signer]) {
      const names = kudoTools({ kudo: k }).map((t) => t.name);
      expect(names.some((n) => /pay|transfer|send_usdg/.test(n))).toBe(false);
    }
  });

  it("is unsigned without a wallet and offers broadcast; signing mode does not", () => {
    expect(kudoTools({ kudo }).map((t) => t.name)).toContain("send_signed_transaction");
    expect(kudoTools({ kudo: signer }).map((t) => t.name)).not.toContain("send_signed_transaction");
  });

  it("validates input and reports errors without throwing", async () => {
    const mint = kudoTools({ kudo }).find((t) => t.name === "mint_covenant")!;
    expect((await runTool(mint, { type: "GIFT", ask: "x", promise: "y" })).ok).toBe(false);
    const noId = await runTool(mint, { type: "LOAN", ask: "Lend me 5 USDG", promise: "I'll repay 5.1 USDG" });
    expect(noId).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("returns an unsigned transaction for a mint", async () => {
    const mint = kudoTools({ kudo, defaultAgentId: 5n }).find((t) => t.name === "mint_covenant")!;
    const out = await runTool(mint, { type: "LOAN", ask: "Lend me 5 USDG for gas.", promise: "I'll repay 5.1 USDG within one day." });
    expect(out.ok).toBe(true);
    expect((out as { result: unknown }).result).toMatchObject({ signed: false, unsignedTransaction: { value: "0", chainId: 4663 } });
  });
});
