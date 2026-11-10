/**
 * Read-only checks against Robinhood Chain mainnet. Nothing is signed.
 * Run with: KUDO_LIVE=1 npm test
 */
import { describe, expect, it } from "vitest";

import { createKudo } from "../src/index.js";

const live = process.env.KUDO_LIVE === "1";
const kudo = createKudo({ rpcUrl: process.env.KUDO_RPC_URL });
// Carte, one of Kudo's own agents: owns id 20380 and has minted covenants.
const CARTE = "0xFB9A9eB13B4Cf30963DCC0A0cbc5598Cc03B2cf3" as const;

describe.skipIf(!live)("mainnet reads", () => {
  it("reads a covenant", async () => {
    const c = await kudo.getCovenant(107);
    expect(c.agentWallet).toBe(CARTE);
    expect(c.type).toBe("INVOICE");
    expect(c.url).toBe("https://app.kudo.archi/share/107");
  }, 30_000);

  it("lists open asks, newest first, none already met", async () => {
    const asks = await kudo.listOpenAsks({ limit: 5 });
    for (const a of asks) {
      expect(a.stage).toBe("ask-open");
      expect(a.askSettledAt).toBeNull();
    }
    const ids = asks.map((a) => a.id);
    expect([...ids].sort((a, b) => (a < b ? 1 : -1))).toEqual(ids);
  }, 30_000);

  it("finds a wallet's agent id and its record", async () => {
    expect(await kudo.findAgentIds(CARTE)).toContain(20380n);
    const r = await kudo.agentRecord(20380);
    expect(r.name).toBe("Carte");
    expect(r.covenants.total).toBeGreaterThan(0);
  }, 120_000);

  it("dry-runs a mint as the owner, and names the revert for anyone else", async () => {
    const tx = kudo.buildMintCovenant({ agentId: 20380, type: "LOAN", ask: "Lend me 5 USDG for gas.", promise: "I'll repay 5.1 USDG within one day." });
    await expect(kudo.simulate(tx, CARTE)).resolves.toBeUndefined();
    await expect(kudo.simulate(tx, "0x09977Cb96F040522E33d69656b087f910dC3385c")).rejects.toThrow(/NotAuthorizedForAgent/);
  }, 30_000);

  it("reads the new covenant id out of a real mint receipt", async () => {
    const receipt = await kudo.publicClient.getTransactionReceipt({
      hash: "0x17b483149726335413f709011cbf0fcdfd4839d8c08534ef6c53e5080f43da44",
    });
    expect(kudo.mintedId(receipt)).toBe(109n);
  }, 30_000);
});
