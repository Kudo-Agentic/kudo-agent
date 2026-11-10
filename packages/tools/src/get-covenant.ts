import { covenantId, define, toJson, type ToolContext } from "./shared.js";

export const getCovenant = ({ kudo }: ToolContext) =>
  define({
    name: "get_covenant",
    title: "Read a covenant",
    description: "Reads one covenant in full: its ask, promise, both proofs, the payment instruction and its stage.",
    inputShape: { id: covenantId },
    writes: false,
    execute: async ({ id }) => toJson(await kudo.getCovenant(id)),
  });
