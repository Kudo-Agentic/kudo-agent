import { identityRegistryAbi, kudoAbi, reputationRegistryAbi } from "@kudo-dev/sdk";
import { encodeFunctionData, erc20Abi } from "viem";
import { describe, expect, it } from "vitest";

import { createSponsorHandler, sponsorOptionsFromEnv } from "../src/index.js";
import { agent, KEY, mintCall, net, POLICY, prepareBody, registerCall, SECRET, setup, signAll, stranger } from "./helpers.js";

const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });

describe("rules at prepare", () => {
  it("prepares an allowed mint and returns both hashes on the first call", async () => {
    const t = setup();
    const { status, body } = await json(await t.post("prepare", prepareBody(agent.address, mintCall(7n))));
    expect(status).toBe(200);
    expect(body.toSign.map((s: { kind: string }) => s.kind)).toEqual(["authorization", "userOperation"]);
    expect(body.toSign[0]).toMatchObject({ delegate: "0x69007702764179f14f51cdce752f4f775d74e139", chainId: 4663, nonce: 0 });
    expect(body.call).toEqual(mintCall(7n));
    // The policy is sent on prepare.
    expect(t.alchemy.calls[0]!.params[0]).toMatchObject({ capabilities: { paymasterService: { policyId: POLICY } }, chainId: "0x1237" });
  });

  it("asks for no authorization once the address is delegated", async () => {
    const t = setup({}, { delegated: new Set([agent.address.toLowerCase()]) });
    const { body } = await json(await t.post("prepare", prepareBody(agent.address, mintCall(7n))));
    expect(body.toSign.map((s: { kind: string }) => s.kind)).toEqual(["userOperation"]);
  });

  it("allows a settlement call from an agent with an identity", async () => {
    const t = setup();
    const data = encodeFunctionData({ abi: kudoAbi, functionName: "setPromiseSettlementData", args: [12n, "0xpaymenthash"] });
    expect((await t.post("prepare", prepareBody(agent.address, { to: net.kudo, data }))).status).toBe(200);
  });

  it("allows register without an identity", async () => {
    const t = setup({}, {}, { identities: new Map() });
    expect((await t.post("prepare", prepareBody(stranger.address, registerCall()))).status).toBe(200);
  });

  const refused = async (t: ReturnType<typeof setup>, from: `0x${string}`, call: { to: `0x${string}`; data: `0x${string}` }) => {
    const r = await json(await t.post("prepare", prepareBody(from, call)));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("not_allowed");
    expect(t.alchemy.calls).toHaveLength(0); // nothing reached Alchemy
    return r.body.reason as string;
  };

  it("refuses a USDG transfer", async () => {
    const t = setup();
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [stranger.address, 5_000_000n] });
    expect(await refused(t, agent.address, { to: net.usdg, data })).toMatch(/token transfers never are/);
  });

  it("refuses a contract outside the allowlist", async () => {
    const t = setup();
    expect(await refused(t, agent.address, { to: stranger.address, data: mintCall(7n).data })).toMatch(/not a contract the relay sponsors/);
  });

  it("refuses calldata that does not decode", async () => {
    const t = setup();
    expect(await refused(t, agent.address, { to: net.kudo, data: "0x12345678deadbeef" })).toMatch(/does not decode/);
  });

  it("refuses a Kudo function that is not sponsored", async () => {
    const t = setup();
    const data = encodeFunctionData({ abi: kudoAbi, functionName: "transferFrom", args: [agent.address, stranger.address, 1n] });
    expect(await refused(t, agent.address, { to: net.kudo, data })).toMatch(/Kudo.transferFrom is not sponsored/);
  });

  it("refuses every Reputation Registry call for now", async () => {
    const t = setup();
    const data = encodeFunctionData({ abi: reputationRegistryAbi, functionName: "getClients", args: [7n] });
    expect(await refused(t, agent.address, { to: net.reputationRegistry!, data })).toMatch(/is not sponsored/);
  });

  it("refuses a sender with no identity", async () => {
    const t = setup({}, {}, { identities: new Map() });
    const data = encodeFunctionData({ abi: kudoAbi, functionName: "setAskSettlementData", args: [1n, "ipfs://proof", "pay: 0x0"] });
    expect(await refused(t, stranger.address, { to: net.kudo, data })).toMatch(/owns no ERC-8004 identity/);
  });

  it("refuses minting under someone else's agentId", async () => {
    const t = setup({}, {}, { identities: new Map([[stranger.address.toLowerCase(), 1n]]) });
    expect(await refused(t, stranger.address, mintCall(7n))).toMatch(/agent 7 is not owned by/);
  });

  it("refuses an agentId that does not exist", async () => {
    const t = setup();
    expect(await refused(t, agent.address, mintCall(999n))).toMatch(/agent 999 is not owned/);
  });

  it("refuses setMetadata on someone else's agentId", async () => {
    const t = setup({}, {}, { identities: new Map([[stranger.address.toLowerCase(), 1n]]) });
    const data = encodeFunctionData({ abi: identityRegistryAbi, functionName: "setMetadata", args: [7n, "name", "0x41"] });
    expect(await refused(t, stranger.address, { to: net.identityRegistry, data })).toMatch(/not owned/);
  });

  it("rejects bad input with 400 and a wrong chain", async () => {
    const t = setup();
    expect((await t.post("prepare", { ...prepareBody(agent.address, mintCall(7n)), chainId: 1 })).status).toBe(400);
    expect((await t.post("prepare", { chainId: 4663, from: "nope", call: mintCall(7n) })).status).toBe(400);
    expect((await t.post("prepare", { ...prepareBody(agent.address, mintCall(7n)), call: { ...mintCall(7n), value: "1" } })).status).toBe(400);
  });

  it("reports an RPC outage as 502 with nothing sent", async () => {
    const t = setup({}, {}, { rpcDown: true });
    const r = await json(await t.post("prepare", prepareBody(agent.address, mintCall(7n))));
    expect(r).toMatchObject({ status: 502, body: { error: "upstream_unavailable" } });
    expect(t.alchemy.calls).toHaveLength(0);
  });

  it("refuses when the policy would not sponsor, and an untrusted delegate", async () => {
    let t = setup({}, { sponsored: false });
    expect(await json(await t.post("prepare", prepareBody(agent.address, mintCall(7n))))).toMatchObject({ status: 403, body: { error: "not_allowed" } });
    t = setup({}, { delegate: "0x000000000000000000000000000000000000dead" });
    expect(await json(await t.post("prepare", prepareBody(agent.address, mintCall(7n))))).toMatchObject({ status: 502, body: { error: "upstream_invalid" } });
  });
});

describe("send", () => {
  const prepared = async (t: ReturnType<typeof setup>, call = mintCall(7n)) => (await t.post("prepare", prepareBody(agent.address, call))).json();

  it("sends with valid signatures, repeating the policy", async () => {
    const t = setup();
    const r = await json(await t.post("send", await signAll(await prepared(t))));
    expect(r).toEqual({ status: 200, body: { callId: `0x${"ab".repeat(32)}` } });
    const send = t.alchemy.calls.find((c) => c.method === "wallet_sendPreparedCalls")!;
    expect(send.params[0]).toMatchObject({ type: "array", capabilities: { paymasterService: { policyId: POLICY } } });
    const [auth, op] = (send.params[0] as { data: Record<string, any>[] }).data;
    expect(auth).toMatchObject({ type: "authorization", signature: { type: "secp256k1" } });
    expect(auth!.signatureRequest).toBeUndefined();
    expect(op).toMatchObject({ type: "user-operation-v070", signature: { type: "secp256k1" } });
    expect(op!.feePayment).toBeUndefined();
  });

  it("rejects a tampered id", async () => {
    const t = setup();
    const body = await signAll(await prepared(t));
    const [payload, tag] = body.id.split(".");
    const forged = JSON.parse(Buffer.from(payload!, "base64url").toString());
    forged.call = { to: net.usdg, data: "0xa9059cbb" };
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${tag}`;
    expect(await json(await t.post("send", { ...body, id: tampered }))).toMatchObject({ status: 400, body: { error: "invalid" } });
    // A flipped tag character is caught too.
    const flipped = `${payload}.${tag!.slice(0, -2)}${tag!.at(-2) === "A" ? "B" : "A"}${tag!.at(-1)}`;
    expect((await t.post("send", { ...body, id: flipped })).status).toBe(400);
    expect(t.alchemy.calls.filter((c) => c.method === "wallet_sendPreparedCalls")).toHaveLength(0);
  });

  it("rejects an expired id with 410", async () => {
    const t = setup();
    const body = await signAll(await prepared(t));
    t.advance(5 * 60_000 + 1);
    expect(await json(await t.post("send", body))).toMatchObject({ status: 410, body: { error: "expired" } });
  });

  it("rejects signatures from the wrong signer", async () => {
    const t = setup();
    const r = await json(await t.post("send", await signAll(await prepared(t), stranger)));
    expect(r).toMatchObject({ status: 400, body: { error: "bad_signature" } });
    expect(t.alchemy.calls.filter((c) => c.method === "wallet_sendPreparedCalls")).toHaveLength(0);
  });

  it("rejects a missing authorization signature on the first call", async () => {
    const t = setup();
    const body = await signAll(await prepared(t));
    delete body.signatures.authorization;
    expect((await t.post("send", body)).status).toBe(400);
  });

  it("re-checks the rules at send: an identity sold in between is refused", async () => {
    const t = setup();
    const body = await signAll(await prepared(t));
    t.chain.owners.set(7n, stranger.address);
    expect(await json(await t.post("send", body))).toMatchObject({ status: 403, body: { error: "not_allowed" } });
  });

  it("counts the daily cap at send, not at prepare", async () => {
    const t = setup({ dailyCap: 1 });
    // A stranger preparing in the agent's name many times uses up nothing.
    for (let i = 0; i < 5; i++) expect((await t.post("prepare", prepareBody(agent.address, mintCall(7n)), "6.6.6.6")).status).toBe(200);
    const first = await signAll(await prepared(t));
    const second = await signAll(await prepared(t));
    expect((await t.post("send", first)).status).toBe(200);
    expect(await json(await t.post("send", second))).toMatchObject({ status: 429, body: { error: "cap_reached" } });
    // A new UTC day resets it.
    t.advance(24 * 60 * 60_000);
    expect((await t.post("send", await signAll(await prepared(t)))).status).toBe(200);
  });

  it("gives the allowance back when Alchemy definitely refused", async () => {
    const t = setup({ dailyCap: 1 }, { send: "rpcError" });
    expect(await json(await t.post("send", await signAll(await prepared(t))))).toMatchObject({ status: 502, body: { error: "upstream_rejected" } });
    t.alchemy.send = "ok";
    expect((await t.post("send", await signAll(await prepared(t)))).status).toBe(200);
  });

  for (const behaviour of ["throw", "timeout", "http500"] as const) {
    it(`replies 504 unknown when the send fails ambiguously (${behaviour}) and keeps it counted`, async () => {
      const t = setup({ dailyCap: 1 }, { send: behaviour });
      const r = await json(await t.post("send", await signAll(await prepared(t))));
      expect(r.status).toBe(504);
      expect(r.body.error).toBe("unknown");
      expect(r.body.reason).toMatch(/may have been sent/);
      expect(r.body.reason).toMatch(/never resend it as a plain transaction/);
      expect(JSON.stringify(r.body)).not.toContain(KEY);
      t.alchemy.send = "ok";
      expect((await t.post("send", await signAll(await prepared(t)))).status).toBe(429);
    });
  }
});

describe("status", () => {
  const receipt = (status: string, logs: unknown[] = []) => ({ status, transactionHash: `0x${"cd".repeat(32)}`, logs });

  it("reports pending, success and a reverted inner call separately", async () => {
    const t = setup({}, { status: { status: 100 } });
    expect(await json(await t.get("status/0xabc"))).toMatchObject({ status: 200, body: { status: "pending", callSucceeded: false } });

    t.alchemy.status = { status: 200, receipts: [receipt("0x1")] };
    expect((await json(await t.get("status/0xabc"))).body).toEqual({ status: "success", transactionHash: `0x${"cd".repeat(32)}`, callSucceeded: true });

    // Bundle mined with status 1, the call inside reverted (EIP-5792 600).
    t.alchemy.status = { status: 600, receipts: [receipt("0x1")] };
    expect((await json(await t.get("status/0xabc"))).body).toMatchObject({ status: "success", callSucceeded: false });

    t.alchemy.status = { status: 500, receipts: [receipt("0x0")] };
    expect((await json(await t.get("status/0xabc"))).body).toMatchObject({ status: "failed", callSucceeded: false });
  });

  it("trusts the EntryPoint's UserOperationEvent over a 200", async () => {
    const { encodeAbiParameters, keccak256, toHex, pad } = await import("viem");
    const topic0 = keccak256(toHex("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)"));
    const log = {
      address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
      topics: [topic0, `0x${"11".repeat(32)}`, pad(agent.address), pad("0x0000000000000000000000000000000000000000")],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [0n, false, 1n, 1n]),
    };
    const t = setup({}, { status: { status: 200, receipts: [receipt("0x1", [log])] } });
    expect((await json(await t.get("status/0xabc"))).body).toMatchObject({ status: "success", callSucceeded: false });
  });
});

describe("health and configuration", () => {
  it("never leaks the key, policy or secret", async () => {
    const t = setup();
    const r = await json(await t.get("health"));
    expect(r.body).toMatchObject({ chainId: 4663, configured: true });
    expect(r.body.allowed.find((a: { name: string }) => a.name === "Kudo").functions).toEqual(["mintCovenant", "setAskSettlementData", "setPromiseSettlementData"]);
    expect(r.body.trustedDelegates).toHaveLength(2);
    const text = JSON.stringify(r.body);
    for (const secret of [KEY, POLICY, SECRET]) expect(text).not.toContain(secret);
  });

  it("is not configured without the Alchemy settings, and refuses to prepare", async () => {
    const handle = createSponsorHandler({ ...sponsorOptionsFromEnv({}), rateLimitPerMinute: 0 });
    expect((await (await handle(new Request("https://r/sponsor/health"))).json()).configured).toBe(false);
    const r = await handle(new Request("https://r/sponsor/prepare", { method: "POST", body: JSON.stringify(prepareBody(agent.address, registerCall())) }));
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("not_configured");
  });

  it("reads the environment", () => {
    expect(
      sponsorOptionsFromEnv({ ALCHEMY_API_KEY: "k", ALCHEMY_POLICY_ID: "p", SPONSOR_SECRET: "s", SPONSOR_DAILY_CAP: "5", SPONSOR_RATE_LIMIT: "10", SPONSOR_ALLOWED_ORIGINS: "https://a, https://b" }),
    ).toMatchObject({ alchemyApiKey: "k", policyId: "p", secret: "s", dailyCap: 5, rateLimitPerMinute: 10, allowedOrigins: ["https://a", "https://b"] });
    expect(() => sponsorOptionsFromEnv({ SPONSOR_DAILY_CAP: "lots" })).toThrow(/SPONSOR_DAILY_CAP/);
  });

  it("rate-limits every endpoint per IP", async () => {
    const t = setup({ rateLimitPerMinute: 2 });
    expect((await t.get("health")).status).toBe(200);
    expect((await t.get("health")).status).toBe(200);
    expect(await json(await t.get("health"))).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect((await t.get("health", "2.2.2.2")).status).toBe(200);
    t.advance(60_001);
    expect((await t.get("health")).status).toBe(200);
  });

  it("does not leak the key when Alchemy errors at prepare", async () => {
    const t = setup({ fetch: (async () => { throw new TypeError(`fetch failed for https://api.g.alchemy.com/v2/${KEY}`); }) as typeof fetch });
    const r = await json(await t.post("prepare", prepareBody(agent.address, mintCall(7n))));
    expect(r).toMatchObject({ status: 502, body: { error: "upstream_unavailable" } });
    expect(JSON.stringify(r.body)).not.toContain(KEY);
  });
});
