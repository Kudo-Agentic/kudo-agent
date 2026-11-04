import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { kudoPlugin, kudoProvider } from "../src/index.js";

const runtime = (settings: Record<string, string>, modelReply = "{}") =>
  ({
    getSetting: (k: string) => settings[k] ?? null,
    useModel: vi.fn(async () => modelReply),
  }) as unknown as IAgentRuntime;

const message = (text: string) => ({ content: { text, source: "test" } }) as unknown as Memory;
const action = (name: string) => kudoPlugin.actions!.find((a) => a.name === name)!;

describe("kudoPlugin", () => {
  it("exposes the core actions and a provider", () => {
    const names = kudoPlugin.actions!.map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(["MINT_COVENANT", "LINK_PROOF", "LIST_OPEN_ASKS", "MEET_ASK", "GET_COVENANT", "REGISTER_KUDO_AGENT"]));
    expect(kudoPlugin.providers?.[0]?.name).toBe("KUDO");
  });

  it("hides write actions without a key, keeps reads", async () => {
    const rt = runtime({});
    expect(await action("MINT_COVENANT").validate(rt, message("mint"))).toBe(false);
    expect(await action("GET_COVENANT").validate(rt, message("read"))).toBe(true);
    const keyed = runtime({ KUDO_PRIVATE_KEY: "0x" + "11".repeat(32) });
    expect(await action("MINT_COVENANT").validate(keyed, message("mint"))).toBe(true);
  });

  it("extracts arguments with the model and reports tool errors through the callback", async () => {
    const rt = runtime({ KUDO_PRIVATE_KEY: "0x" + "11".repeat(32) }, '{"type":"LOAN","ask":"Lend me 2000 USDG","promise":"I will repay 2100 USDG","agentId":1}');
    const callback = vi.fn(async (_c: { text?: string }) => []);
    const result = await action("MINT_COVENANT").handler(rt, message("mint a big loan"), undefined, undefined, callback);
    expect(result).toMatchObject({ success: false });
    expect(callback.mock.calls[0]?.[0].text).toMatch(/at most 1000/);
  });

  it("provider explains read-only mode", async () => {
    const out = await kudoProvider.get(runtime({}), message(""), {} as never);
    expect(out.text).toMatch(/read-only/);
  });
});

describe.skipIf(process.env.KUDO_LIVE !== "1")("live", () => {
  it("reads a covenant through GET_COVENANT", async () => {
    const rt = runtime({}, '{"id": 108}');
    const callback = vi.fn(async (_c: { text?: string }) => []);
    const r = await action("GET_COVENANT").handler(rt, message("status of covenant 108?"), undefined, undefined, callback);
    expect(r).toMatchObject({ success: true });
    expect(callback.mock.calls[0]?.[0].text).toMatch(/Covenant 108 \(INVOICE\) is completed/);
  }, 30_000);
});
