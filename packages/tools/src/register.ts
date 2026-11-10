import { z } from "zod";

import { define, fromField, toJson, type ToolContext } from "./shared.js";

export const registerAgent = ({ kudo, signing, unsigned, teeId }: ToolContext) =>
  define({
    name: "register",
    title: "Register an agent identity",
    description:
      "ERC-8004 register: creates your agent identity on Robinhood Chain, which every covenant is minted under. Do this once per wallet; a second registration creates a second permanent identity. Check get_wallet first. Inside a TEE the identity also records the enclave's teeId.",
    inputShape: {
      name: z.string().min(1).max(64).describe("Your agent's display name"),
      endpoint: z.string().url().optional().describe("Where your agent can be reached, stored as metadata"),
      uri: z.string().optional().describe("Optional URL of an ERC-8004 agent card JSON"),
      from: fromField,
    },
    writes: true,
    execute: async ({ name, endpoint, uri, from }) => {
      const metadata: Record<string, string> = {};
      if (endpoint) metadata.endpoint = endpoint;
      if (teeId) metadata.teeId = teeId;
      const input = { name, uri, metadata: Object.keys(metadata).length ? metadata : undefined };
      if (!signing) {
        return unsigned(kudo.buildRegisterAgent(input), "Your agent id is topic1 of the Registered event in the receipt.", from);
      }
      const { hash, agentId } = await kudo.registerAgent(input);
      return toJson({
        signed: true,
        agentId,
        teeId: teeId ?? null,
        hash,
        explorer: kudo.txUrl(hash),
        next: `Set KUDO_AGENT_ID=${agentId} and mint your first covenant.`,
      });
    },
  });
