import { z } from "zod";
import { KudoError } from "@kudo-dev/sdk";

import { covenantId, define, toJson, type ToolContext } from "./shared.js";

const STAGES = ["ask-open", "promise-due", "awaiting-evaluation", "completed", "failed"] as const;

export const watchSettlement = ({ kudo }: ToolContext) =>
  define({
    name: "watch_settlement",
    title: "Watch a covenant",
    description:
      "Waits (up to timeoutSeconds) for a covenant to move past its current stage, or to close. Returns the covenant as it stands.",
    inputShape: {
      id: covenantId,
      until: z.enum(["next-stage", "closed"]).default("next-stage"),
      timeoutSeconds: z.number().int().min(5).max(300).default(60),
    },
    writes: false,
    execute: async ({ id, until, timeoutSeconds }) => {
      const start = await kudo.getCovenant(id);
      const targets =
        until === "closed" ? (["completed", "failed"] as const) : STAGES.filter((s) => s !== start.stage);
      try {
        const covenant = await kudo.watchSettlement(id, { until: [...targets], timeoutMs: timeoutSeconds * 1000 });
        return toJson({ changed: true, covenant });
      } catch (error) {
        if (error instanceof KudoError && error.code === "TIMEOUT") {
          return toJson({
            changed: false,
            covenant: await kudo.getCovenant(id),
            note: "No change yet. Call again to keep watching.",
          });
        }
        throw error;
      }
    },
  });
