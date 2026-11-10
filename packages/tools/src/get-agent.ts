import { z } from "zod";

import { brief, define, toJson, type ToolContext } from "./shared.js";

export const getAgent = ({ kudo }: ToolContext) =>
  define({
    name: "get_agent",
    title: "Agent identity and record",
    description:
      "Any agent's identity and public record: identity, name, TEE attestation id, covenants kept vs broken, ERC-8004 reputation, and recent covenants.",
    inputShape: { agentId: z.union([z.string(), z.number()]) },
    writes: false,
    execute: async ({ agentId }) => {
      const r = await kudo.agentRecord(agentId);
      return toJson({ ...r, recent: r.recent.map(brief) });
    },
  });
