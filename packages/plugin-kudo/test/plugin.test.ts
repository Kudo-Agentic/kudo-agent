import type { IAgentRuntime, Memory } from "@elizaos/core";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getKudo, kudoPlugin, kudoProvider } from "../src/index.js";

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
    const rt = runtime({ KUDO_PRIVATE_KEY: "0x" + "11".repeat(32) }, '{"type":"GIFT","ask":"Lend me 2000 USDG","promise":"I will repay 2100 USDG","agentId":1}');
    const callback = vi.fn(async (_c: { text?: string }) => []);
    const result = await action("MINT_COVENANT").handler(rt, message("mint a big loan"), undefined, undefined, callback);
    expect(result).toMatchObject({ success: false });
    expect(callback.mock.calls[0]?.[0].text).toMatch(/LOAN|INVOICE|ADVANCE/);
  });

  it("retries once with the large model when the small model's arguments fail validation", async () => {
    // As in an e2e run: the small model returned no id or proof for MEET_ASK.
    const calls: string[] = [];
    const rt = {
      getSetting: (k: string) => ({ KUDO_PRIVATE_KEY: "0x" + "33".repeat(32) })[k as "KUDO_PRIVATE_KEY"] ?? null,
      useModel: vi.fn(async (type: string, p: { prompt: string }) => {
        calls.push(type);
        return type === "TEXT_SMALL" ? "{}" : (expect(p.prompt).toMatch(/rejected: .*id/), '{"type":"GIFT","ask":"a b c","promise":"d e f","agentId":1}');
      }),
    } as unknown as IAgentRuntime;
    const callback = vi.fn(async (_c: { text?: string }) => []);
    await action("MINT_COVENANT").handler(rt, message("mint"), undefined, undefined, callback);
    expect(calls).toEqual(["TEXT_SMALL", "TEXT_LARGE"]);
    // The retry's arguments were validated too (GIFT is refused), and nothing more was tried.
    expect(callback.mock.calls[0]?.[0].text).toMatch(/LOAN|INVOICE|ADVANCE/);
  });

  it("names Eliza actions, not MCP tools, in the status hint", async () => {
    const callback = vi.fn(async (_c: { text?: string }) => []);
    const rt = runtime({});
    const tool = action("KUDO_STATUS");
    const r = await tool.handler(rt, message("status"), undefined, undefined, callback);
    expect(r).toMatchObject({ success: true });
    expect(callback.mock.calls[0]?.[0].text).not.toMatch(/register_agent|mint_covenant|list_open_asks/);
  });

  it("shows earlier action results from the same turn to the next action", async () => {
    let prompt = "";
    const rt = {
      getSetting: (k: string) => ({ KUDO_PRIVATE_KEY: "0x" + "22".repeat(32) })[k as "KUDO_PRIVATE_KEY"] ?? null,
      useModel: vi.fn(async (_t: unknown, p: { prompt: string }) => {
        prompt = p.prompt;
        return "{}";
      }),
    } as unknown as IAgentRuntime;
    const previousResults = [{ success: true, data: { result: { id: "115", promiseDetail: "pay: 0x09977Cb96F040522E33d69656b087f910dC3385c" } } }];
    await action("LINK_PROOF").handler(rt, message("link the payment for what you owe"), undefined, { actionContext: { previousResults } }, vi.fn(async () => []));
    expect(prompt).toContain("pay: 0x09977Cb96F040522E33d69656b087f910dC3385c");
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

describe("KUDO_KEY_SOURCE", () => {
  const DSTACK_KEY = "0x" + "ab".repeat(32);
  const ENV_KEY = "0x" + "11".repeat(32);
  const socket = join(mkdtempSync(join(tmpdir(), "dstack-")), "dstack.sock");
  let server: Server;
  let asked: { path?: string } = {};

  beforeAll(async () => {
    // Stand-in for Phala's dstack guest agent.
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d)).on("end", () => {
        if (req.url === "/GetKey") {
          asked = JSON.parse(body);
          return res.end(JSON.stringify({ key: DSTACK_KEY.slice(2), signature_chain: [] }));
        }
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(socket, r));
  });
  afterAll(() => server.close());

  it("defaults to KUDO_PRIVATE_KEY", async () => {
    const { kudo, keySource } = await getKudo(runtime({ KUDO_PRIVATE_KEY: ENV_KEY }));
    expect(keySource).toBe("env");
    expect(kudo.address).toBe(privateKeyToAccount(ENV_KEY as `0x${string}`).address);
  });

  it("uses the dstack key when set to dstack, ignoring KUDO_PRIVATE_KEY", async () => {
    const { kudo, keySource } = await getKudo(runtime({ KUDO_KEY_SOURCE: "dstack", KUDO_DSTACK_SOCKET: socket, KUDO_PRIVATE_KEY: ENV_KEY }));
    expect(keySource).toBe("dstack");
    expect(kudo.address).toBe(privateKeyToAccount(DSTACK_KEY as `0x${string}`).address);
    expect(asked.path).toBe("kudo/agent");
  });

  it("derives from a custom path", async () => {
    await getKudo(runtime({ KUDO_KEY_SOURCE: "dstack", KUDO_DSTACK_SOCKET: socket, KUDO_DSTACK_KEY_PATH: "my/agent" }));
    expect(asked.path).toBe("my/agent");
  });

  it("refuses to start without a dstack socket instead of falling back", async () => {
    const rt = runtime({ KUDO_KEY_SOURCE: "dstack", KUDO_DSTACK_SOCKET: join(tmpdir(), "no-such.sock"), KUDO_PRIVATE_KEY: ENV_KEY });
    await expect(kudoPlugin.init!({}, rt)).rejects.toThrow(/Cannot reach dstack/);
    expect(await action("MINT_COVENANT").validate(rt, message("mint"))).toBe(false);
  });

  it("rejects an unknown source", async () => {
    await expect(getKudo(runtime({ KUDO_KEY_SOURCE: "tee" }))).rejects.toThrow(/"env" or "dstack"/);
  });
});
