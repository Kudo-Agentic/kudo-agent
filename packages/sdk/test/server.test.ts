import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { visitorOptions, VISITOR_RULES } from "../src/agent/agent.js";
import { runLog } from "../src/agent/log.js";
import { chat, chatGate, message } from "../src/agent/server/handlers.js";
// @ts-expect-error: a plain .mjs script shipped with the kudo skill
import { decodeDataUri, encodeDataUri, nextRegistration } from "../skills/kudo/registration-file.mjs";

let server: Server | undefined;
afterEach(() => server?.close());

/** Serves one handler on a random port and returns its URL. */
async function serve(handle: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handle);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("POST /message", () => {
  it("is open without MESSAGE_TOKEN", async () => {
    const url = await serve((req, res) => void message(req, res, async (p) => `ran: ${p}`));
    const response = await post(url, { message: "hi" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response: "ran: hi" });
  });

  it("needs the bearer token when MESSAGE_TOKEN is set, and never runs without it", async () => {
    let runs = 0;
    const url = await serve((req, res) => void message(req, res, async () => `run ${++runs}`, "s3cret"));
    expect((await post(url, { message: "hi" })).status).toBe(401);
    expect((await post(url, { message: "hi" }, { authorization: "Bearer wrong!" })).status).toBe(401);
    expect((await post(url, { message: "hi" }, { authorization: "s3cret" })).status).toBe(401);
    expect(runs).toBe(0);
    const ok = await post(url, { message: "hi" }, { authorization: "Bearer s3cret" });
    expect(ok.status).toBe(200);
    expect(runs).toBe(1);
  });
});

describe("POST /chat", () => {
  it("answers a visitor", async () => {
    const url = await serve((req, res) => void chat(req, res, async (p) => `said: ${p}`, chatGate(2)));
    const response = await post(url, { message: "who are you?" });
    expect(await response.json()).toEqual({ response: "said: who are you?" });
  });

  it("turns away chats over the limit with 429, and frees the slot after", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const gate = chatGate(1);
    const url = await serve(
      (req, res) =>
        void chat(
          req,
          res,
          async (p) => {
            if (p === "first") await held;
            return p;
          },
          gate,
        ),
    );
    const first = post(url, { message: "first" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await post(url, { message: "second" })).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    expect((await post(url, { message: "third" })).status).toBe(200);
  });

  it("refuses an empty or oversized message", async () => {
    const url = await serve((req, res) => void chat(req, res, async (p) => p, chatGate(2)));
    expect((await post(url, {})).status).toBe(400);
    expect((await post(url, { message: "x".repeat(16_001) })).status).toBe(413);
  });
});

describe("visitor chat run", () => {
  it("has no tools, no skills, one turn, and no key in its environment", () => {
    process.env.PRIVATE_KEY = "0xkey";
    process.env.TWITTER_API_KEY = "tw";
    try {
      const options = visitorOptions(
        { systemPrompt: "# You are Test", skills: { path: "/tmp/x", names: ["kudo:kudo"] }, cwd: "/tmp", model: "m" },
        runLog("test"),
      );
      expect(options.tools).toEqual([]);
      expect(options.allowedTools).toEqual([]);
      expect(options.plugins).toBeUndefined();
      expect(options.skills).toBeUndefined();
      expect(options.maxTurns).toBe(1);
      expect(options.env?.PRIVATE_KEY).toBeUndefined();
      expect(options.env?.TWITTER_API_KEY).toBeUndefined();
      expect(options.systemPrompt).toBe(`# You are Test\n\n${VISITOR_RULES}`);
    } finally {
      delete process.env.PRIVATE_KEY;
      delete process.env.TWITTER_API_KEY;
    }
  });
});

describe("registration-file.mjs", () => {
  const where = {
    endpoint: "https://agent.example",
    name: "Ada",
    agentId: "42",
    chainId: "4663",
    registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    attested: true,
  };

  it("writes a whole file for an identity with no URI", () => {
    const next = nextRegistration("", where);
    expect(next.status).toBe("update");
    const file = decodeDataUri(next.uri);
    expect(file.name).toBe("Ada");
    expect(file.services).toEqual([{ name: "agent", endpoint: "https://agent.example" }]);
    expect(file.registrations).toEqual([{ agentId: 42, agentRegistry: `eip155:4663:${where.registry}` }]);
    expect(file.supportedTrust).toEqual(["reputation", "tee-attestation"]);
  });

  it("adds the agent service to an inline file, keeping everything else", () => {
    const uri = encodeDataUri({ name: "Ada", description: "Kept.", services: [{ name: "X", endpoint: "https://x.com/ada" }] });
    const file = decodeDataUri(nextRegistration(uri, where).uri);
    expect(file.description).toBe("Kept.");
    expect(file.services).toEqual([
      { name: "agent", endpoint: "https://agent.example" },
      { name: "X", endpoint: "https://x.com/ada" },
    ]);
  });

  it("replaces a stale agent URL, and says current once it matches", () => {
    const stale = encodeDataUri({ services: [{ name: "agent", endpoint: "https://old.example" }] });
    const updated = nextRegistration(stale, where);
    expect(decodeDataUri(updated.uri).services).toEqual([{ name: "agent", endpoint: "https://agent.example" }]);
    expect(nextRegistration(updated.uri, where)).toEqual({ status: "current" });
  });

  it("leaves a hosted file to its owner", () => {
    expect(nextRegistration("ipfs://bafy", where).status).toBe("skip");
    expect(nextRegistration("https://ada.example/agent.json", where).status).toBe("skip");
  });
});
