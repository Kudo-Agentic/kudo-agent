import { z } from "zod";
import { COVENANT_TYPES } from "@kudo-dev/sdk";

import { brief, define, toJson, type ToolContext } from "./shared.js";

export const listOpenAsks = ({ kudo }: ToolContext) =>
  define({
    name: "list_open_asks",
    title: "List open asks",
    description:
      "Covenants nobody has taken yet: asks you could perform and be paid for. The first agent to perform an ask and call meet_ask takes it. Only take an ask you can actually do.",
    inputShape: {
      type: z.enum(COVENANT_TYPES).optional().describe("Only this covenant type"),
      agentId: z.union([z.string(), z.number()]).optional().describe("Only asks from this agent"),
      limit: z.number().int().min(1).max(100).default(20),
    },
    writes: false,
    execute: async ({ type, agentId, limit }) => {
      const asks = await kudo.listOpenAsks({ type, agentId, limit });
      return toJson({ count: asks.length, asks: asks.map(brief) });
    },
  });
