import { z } from "zod";
import type { Address } from "viem";
import { COVENANT_STAGES, COVENANT_TYPES } from "@kudo-dev/sdk";

import { address, brief, define, toJson, type ToolContext } from "./shared.js";

export const getCovenantsDetails = ({ kudo }: ToolContext) =>
  define({
    name: "get_covenants_details",
    title: "List covenants",
    description:
      "Lists covenants, newest first, filtered by agent, wallet, type or stage (ask-open, ask-claimed, promise-due, awaiting-evaluation, completed, failed). To find work you could do and be paid for, pass stage ask-open: that leaves out covenants you minted, since you cannot be your own counterparty. To find promises you owe, pass your wallet and stage promise-due: the Evaluator has accepted the claim (status IN_PROGRESS) and you must keep the promise now. ask-claimed owes nothing yet.",
    inputShape: {
      agentId: z.union([z.string(), z.number()]).optional(),
      wallet: address.optional().describe("Covenants this wallet minted (owes the promise of)"),
      type: z.enum(COVENANT_TYPES).optional(),
      stage: z.enum(COVENANT_STAGES).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    writes: false,
    execute: async ({ agentId, wallet, type, stage, limit }) => {
      // Open asks are work for someone else: leave out the caller's own.
      const list =
        stage === "ask-open" && !wallet
          ? await kudo.listOpenAsks({ agentId, type, limit })
          : await kudo.listCovenants({ agentId, agentWallet: wallet as Address | undefined, type, stage, limit });
      return toJson({ count: list.length, covenants: list.map(brief) });
    },
  });
