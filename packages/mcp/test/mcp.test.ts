import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKudo } from "@kudo-dev/sdk";
import { createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { createKudoMcpHandler, createKudoMcpServer } from "../src/index.js";

async function connect(server: ReturnType<typeof createKudoMcpServer>) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

describe("stdio-style server", () => {
  it("lists the Kudo tools with read-only hints", async () => {
    const client = await connect(createKudoMcpServer({ kudo: createKudo() }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["how_to_connect", "register_agent", "list_open_asks", "get_covenant", "mint_covenant", "meet_ask", "link_proof", "watch_settlement", "agent_record", "send_signed_transaction"]));
    expect(tools.find((t) => t.name === "get_covenant")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "mint_covenant")?.annotations?.readOnlyHint).toBe(false);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("first_covenant");
  });

  it("returns an unsigned mint without a key", async () => {
    const client = await connect(createKudoMcpServer({ kudo: createKudo(), defaultAgentId: 1n }));
    const r = await client.callTool({ name: "mint_covenant", arguments: { type: "LOAN", ask: "Lend me 5 USDG for gas.", promise: "I'll repay 5.1 USDG within one day." } });
    expect(r.isError).toBe(false);
    expect(text(r)).toMatchObject({ signed: false, unsignedTransaction: { chainId: 4663 } });
  });

  it("reports bad input as a tool error, not a crash", async () => {
    const client = await connect(createKudoMcpServer({ kudo: createKudo() }));
    const r = await client.callTool({ name: "mint_covenant", arguments: { type: "GIFT", ask: "Lend me 2000 USDG", promise: "I'll repay 2100 USDG", agentId: 1 } });
    expect(r.isError).toBe(true);
    expect((r as { content: { text: string }[] }).content[0]!.text).toMatch(/LOAN|INVOICE|ADVANCE/);
  });

  it("in signing mode has no broadcast tool", async () => {
    const walletClient = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), transport: http("http://127.0.0.1:1") });
    const client = await connect(createKudoMcpServer({ kudo: createKudo({ walletClient }) }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("send_signed_transaction");
  });
});

describe("HTTP handler", () => {
  it("refuses to serve a signing client", () => {
    const walletClient = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), transport: http("http://127.0.0.1:1") });
    expect(() => createKudoMcpHandler({ kudo: createKudo({ walletClient }) })).toThrow(/Refusing/);
  });

  it("answers initialize and tools/list statelessly, and rate limits", async () => {
    const handle = createKudoMcpHandler({ kudo: createKudo(), rateLimitPerMinute: 3 });
    const post = (body: unknown) =>
      handle(
        new Request("http://x/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
          body: JSON.stringify(body),
        }),
        "1.2.3.4",
      );
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    expect(init.status).toBe(200);
    expect((await init.json()).result.serverInfo.name).toBe("kudo");
    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    expect((await list.json()).result.tools.length).toBeGreaterThan(8);
    await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    expect((await post({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })).status).toBe(429);
  });
});
