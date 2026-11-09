import { z } from "zod";
import { parseTransaction, type Hex } from "viem";
import { KudoError } from "@kudo-dev/sdk";

import { define, toJson, type ToolContext } from "./shared.js";

/**
 * Unsigned mode only: broadcasts what the caller signed. Never signs anything
 * itself, and only relays calls to Kudo and the ERC-8004 registries on this
 * chain, so it cannot be used to move tokens (CLAUDE.md rule 6).
 */
export const sendSignedTransaction = ({ kudo }: ToolContext) =>
  define({
    name: "send_signed_transaction",
    title: "Broadcast a signed transaction",
    description:
      "Broadcasts a transaction you signed yourself (from one of the unsigned transactions this server returned) and waits for the receipt. Only calls to the Kudo contract or the ERC-8004 registries are relayed.",
    inputShape: {
      serialized: z
        .string()
        .regex(/^0x[0-9a-fA-F]+$/)
        .describe("The signed, RLP-serialized transaction"),
    },
    writes: true,
    execute: async ({ serialized }) => {
      let tx: ReturnType<typeof parseTransaction>;
      try {
        tx = parseTransaction(serialized as Hex);
      } catch {
        throw new KudoError("INVALID_INPUT", "serialized is not a signed, RLP-serialized transaction.");
      }
      if (tx.chainId !== kudo.chainId) {
        throw new KudoError("INVALID_INPUT", `The transaction is for chain ${tx.chainId ?? "none"}, not ${kudo.chainId}.`);
      }
      const { kudo: kudoAddress, identityRegistry, reputationRegistry } = kudo.network;
      const allowed = [kudoAddress, identityRegistry, reputationRegistry].filter(Boolean).map((a) => a!.toLowerCase());
      if (!tx.to || !allowed.includes(tx.to.toLowerCase())) {
        throw new KudoError(
          "INVALID_INPUT",
          `This server only relays calls to Kudo (${kudoAddress}) or the ERC-8004 registries, not to ${tx.to ?? "a contract creation"}. Broadcast other transactions from your own wallet.`,
        );
      }
      if (tx.value && tx.value > 0n) {
        throw new KudoError("INVALID_INPUT", "This server does not relay transactions that send ETH.");
      }
      const { hash, status } = await kudo.sendRawTransaction(serialized as Hex);
      return toJson({ hash, status, explorer: kudo.txUrl(hash) });
    },
  });
