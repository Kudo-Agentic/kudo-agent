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

  it("offers the same nine tools with or without a wallet, and none broadcasts", () => {
    const unsigned = kudoTools({ kudo }).map((t) => t.name);
    expect(kudoTools({ kudo: signer }).map((t) => t.name)).toEqual(unsigned);
    expect(unsigned).toEqual([
      "get_wallet",
      "register",
      "set_metadata",
      "get_covenants_details",
      "get_covenant",
      "mint_covenant",
      "set_ask_settlement_data",
      "set_promise_settlement_data",
      "get_agent",
    ]);
  });

  it("get_wallet needs a wallet when the server does not sign", async () => {
    const account = kudoTools({ kudo }).find((t) => t.name === "get_wallet")!;
    expect(await runTool(account, {})).toMatchObject({ ok: false, code: "NO_WALLET" });
  });

  it("validates input and reports errors without throwing", async () => {
    const mint = kudoTools({ kudo }).find((t) => t.name === "mint_covenant")!;
    expect((await runTool(mint, { type: "GIFT", ask: "x", promise: "y" })).ok).toBe(false);
    const noId = await runTool(mint, { type: "LOAN", ask: "Lend me 5 USDG", promise: "I'll repay 5.1 USDG" });
    expect(noId).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("never writes a teeId outside a TEE, and records the enclave's own id inside one", async () => {
    const set = kudoTools({ kudo, defaultAgentId: 5n }).find((t) => t.name === "set_metadata")!;
    expect(await runTool(set, { key: "teeId", value: "f4d96bf40bd123e04de1ad947d16bc9ad137c97a" })).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
      error: expect.stringMatching(/not running in a TEE/),
    });

    const register = kudoTools({ kudo, teeId: "0xABCDEF12" }).find((t) => t.name === "register")!;
    const out = (await runTool(register, { name: "Ada" })) as { ok: true; result: { unsignedTransaction: { data: string } } };
    expect(out.ok).toBe(true);
    const data = out.result.unsignedTransaction.data.toLowerCase();
    expect(data).toContain(Buffer.from("teeId").toString("hex").toLowerCase());
    expect(data).toContain(Buffer.from("abcdef12").toString("hex"));
  });

  it("reports a non-numeric agentId as INVALID_INPUT", async () => {
    const mint = kudoTools({ kudo }).find((t) => t.name === "mint_covenant")!;
    const out = await runTool(mint, { type: "LOAN", ask: "Lend me 5 USDG", promise: "I'll repay 5.1 USDG", agentId: "agent 20380" });
    expect(out).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("returns an unsigned transaction for a mint", async () => {
    const mint = kudoTools({ kudo, defaultAgentId: 5n }).find((t) => t.name === "mint_covenant")!;
    const out = await runTool(mint, { type: "LOAN", ask: "Lend me 5 USDG for gas.", promise: "I'll repay 5.1 USDG within one day." });
    expect(out.ok).toBe(true);
    expect((out as { result: unknown }).result).toMatchObject({ signed: false, unsignedTransaction: { value: "0", chainId: 4663 } });
  });
});
