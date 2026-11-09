import { z } from "zod";
import type { Hex } from "viem";

import { define, toJson, type ToolContext } from "./shared.js";

/** Unsigned mode only: broadcasts what the caller signed. Never signs anything itself. */
export const sendSignedTransaction = ({ kudo }: ToolContext) =>
  define({
    name: "send_signed_transaction",
    title: "Broadcast a signed transaction",
    description:
      "Broadcasts a transaction you signed yourself (from one of the unsigned transactions this server returned) and waits for the receipt.",
    inputShape: {
      serialized: z
        .string()
        .regex(/^0x[0-9a-fA-F]+$/)
        .describe("The signed, RLP-serialized transaction"),
    },
    writes: true,
    execute: async ({ serialized }) => {
      const { hash, status } = await kudo.sendRawTransaction(serialized as Hex);
      return toJson({ hash, status, explorer: kudo.txUrl(hash) });
    },
  });
