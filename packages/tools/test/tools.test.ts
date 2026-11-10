import { readdirSync } from "node:fs";
import { createKudo } from "@kudo-dev/sdk";
import { createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { AgentIds, kudoTools, runTool } from "../src/index.js";
import { toolContext } from "../src/shared.js";

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
    const set = kudoTools({ kudo }).find((t) => t.name === "set_metadata")!;
    expect(await runTool(set, { key: "teeId", value: "f4d96bf40bd123e04de1ad947d16bc9ad137c97a", agentId: 5 })).toMatchObject({
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
    const mint = kudoTools({ kudo }).find((t) => t.name === "mint_covenant")!;
    const out = await runTool(mint, { type: "LOAN", ask: "Lend me 5 USDG for gas.", promise: "I'll repay 5.1 USDG within one day.", agentId: 5 });
    expect(out.ok).toBe(true);
    expect((out as { result: unknown }).result).toMatchObject({ signed: false, unsignedTransaction: { value: "0", chainId: 4663 } });
  });
});

describe("agent id", () => {
  const me = "0x8AF5d198744Ba668689ea90946796a088e00DA33";
  /** A Kudo stand-in: `registered` maps a wallet to the id it registered. */
  const fake = (registered: Record<string, bigint>, address?: string, owned: Record<string, bigint[]> = {}) => {
    const lookups: string[] = [];
    const base = createKudo();
    const k = Object.create(base) as typeof base;
    Object.defineProperty(k, "address", { get: () => address });
    k.findRegisteredAgentId = async (wallet) => {
      lookups.push(wallet!.toLowerCase());
      return registered[wallet!.toLowerCase()];
    };
    k.findAgentIds = async (wallet) => owned[wallet!.toLowerCase()] ?? [];
    return { k, lookups };
  };

  it("shares one lookup between callers asking at once", async () => {
    const { k, lookups } = fake({ [me.toLowerCase()]: 4n }, me);
    const ids = new AgentIds(k);
    expect(await Promise.all([ids.of(), ids.of(me), ids.of()])).toEqual([4n, 4n, 4n]);
    expect(lookups).toHaveLength(1);
  });

  it("acts as `from` in unsigned mode even when the client has a wallet", async () => {
    const caller = "0x4902Dbca318a6d5B09f2383003C79aC41ED62CEd";
    const { k } = fake({ [me.toLowerCase()]: 1n, [caller.toLowerCase()]: 2n }, me);
    const { agentIdOf } = toolContext({ kudo: k, mode: "unsigned" });
    expect(await agentIdOf(undefined, caller)).toBe(2n);
    expect(await agentIdOf(undefined)).toBe(1n);
  });

  it("never tells a wallet that owns a transferred id to register", async () => {
    const { k } = fake({}, me, { [me.toLowerCase()]: [42n] });
    const { agentIdOf } = toolContext({ kudo: k, mode: "unsigned" });
    await expect(agentIdOf(undefined)).rejects.toThrow(/owns agent 42 but did not register it itself: pass it as agentId/);
  });

  it("is found from the wallet's own registration, once, and an explicit id wins", async () => {
    const { k, lookups } = fake({ [me.toLowerCase()]: 23347n }, me);
    const ids = new AgentIds(k);
    expect(await ids.of()).toBe(23347n);
    expect(await ids.of(me)).toBe(23347n);
    expect(lookups).toEqual([me.toLowerCase()]); // looked up once, then remembered

    const { agentIdOf } = toolContext({ kudo: k, agentIds: ids, mode: "unsigned" });
    expect(await agentIdOf(undefined)).toBe(23347n);
    expect(await agentIdOf("12")).toBe(12n);
  });

  it("uses `from` without a key, and says so when neither is there", async () => {
    const { k } = fake({ [me.toLowerCase()]: 7n });
    const { agentIdOf } = toolContext({ kudo: k });
    expect(await agentIdOf(undefined, me)).toBe(7n);
    await expect(agentIdOf(undefined)).rejects.toThrow(/pass agentId or your wallet as from/);
  });

  it("tells a wallet with no identity to register, and does not remember the miss", async () => {
    const registered: Record<string, bigint> = {};
    const { k, lookups } = fake(registered, me);
    const ids = new AgentIds(k);
    const { agentIdOf } = toolContext({ kudo: k, agentIds: ids, mode: "unsigned" });
    await expect(agentIdOf(undefined)).rejects.toThrow(/has not registered an agent identity yet\. Call register first/);
    registered[me.toLowerCase()] = 99n; // registered elsewhere
    expect(await agentIdOf(undefined)).toBe(99n);
    expect(lookups).toHaveLength(2);
  });

  it("is remembered when register creates it, so the next mint uses it without a lookup", async () => {
    const { k, lookups } = fake({}, me);
    const ids = new AgentIds(k);
    ids.remember(me, 23348n);
    const mint = kudoTools({ kudo: k, agentIds: ids, mode: "unsigned" }).find((t) => t.name === "mint_covenant")!;
    const out = await runTool(mint, { type: "LOAN", ask: "Lend me 5 USDG for gas.", promise: "I'll repay 5.1 USDG within one day." });
    expect(out.ok).toBe(true);
    expect(lookups).toEqual([]);
  });
});
