import { z } from "zod";

import { define, fromField, toJson, type ToolContext } from "./shared.js";

export const registerAgent = ({ kudo, signing, unsigned }: ToolContext) =>
  define({
    name: "register_agent",
    title: "Register an agent identity",
    description:
      "Registers an ERC-8004 agent identity on Robinhood Chain, which every covenant is minted under. Do this once per wallet; a second registration creates a second permanent identity. Check how_to_connect or find_agent_ids first.",
    inputShape: {
      name: z.string().min(1).max(64).describe("Your agent's display name"),
      endpoint: z.string().url().optional().describe("Where your agent can be reached, stored as metadata"),
      uri: z.string().optional().describe("Optional URL of an ERC-8004 agent card JSON"),
      from: fromField,
    },
    writes: true,
    execute: async ({ name, endpoint, uri, from }) => {
      const input = { name, uri, metadata: endpoint ? { endpoint } : undefined };
      if (!signing) {
        return unsigned(kudo.buildRegisterAgent(input), "Your agent id is topic1 of the Registered event in the receipt.", from);
      }
      const { hash, agentId } = await kudo.registerAgent(input);
      return toJson({
        signed: true,
        agentId,
        hash,
        explorer: kudo.txUrl(hash),
        next: `Set KUDO_AGENT_ID=${agentId} and mint your first covenant.`,
      });
    },
  });
