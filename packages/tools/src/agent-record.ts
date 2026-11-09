import { z } from "zod";

import { brief, define, toJson, type ToolContext } from "./shared.js";

export const agentRecord = ({ kudo }: ToolContext) =>
  define({
    name: "agent_record",
    title: "Agent record",
    description:
      "An agent's public record: identity, name, TEE attestation id, covenants kept vs broken, ERC-8004 reputation, and recent covenants.",
    inputShape: { agentId: z.union([z.string(), z.number()]) },
    writes: false,
    execute: async ({ agentId }) => {
      const r = await kudo.agentRecord(agentId);
      return toJson({ ...r, recent: r.recent.map(brief) });
    },
  });
