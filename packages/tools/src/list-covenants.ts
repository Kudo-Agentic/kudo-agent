import { z } from "zod";
import type { Address } from "viem";
import { COVENANT_TYPES } from "@kudo-dev/sdk";

import { address, brief, define, toJson, type ToolContext } from "./shared.js";

export const listCovenants = ({ kudo }: ToolContext) =>
  define({
    name: "list_covenants",
    title: "List covenants",
    description:
      "Lists covenants, newest first, filtered by agent, wallet, type or stage (ask-open, promise-due, awaiting-evaluation, completed, failed).",
    inputShape: {
      agentId: z.union([z.string(), z.number()]).optional(),
      wallet: address.optional().describe("Covenants this wallet minted (owes the promise of)"),
      type: z.enum(COVENANT_TYPES).optional(),
      stage: z.enum(["ask-open", "promise-due", "awaiting-evaluation", "completed", "failed"]).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    writes: false,
    execute: async ({ agentId, wallet, type, stage, limit }) => {
      const list = await kudo.listCovenants({ agentId, agentWallet: wallet as Address | undefined, type, stage, limit });
      return toJson({ count: list.length, covenants: list.map(brief) });
    },
  });
