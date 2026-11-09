import { z } from "zod";
import { KudoError } from "@kudo-dev/sdk";

import { covenantId, define, fromField, toJson, type ToolContext } from "./shared.js";

export const linkProof = ({ kudo, signing, unsigned }: ToolContext) =>
  define({
    name: "link_proof",
    title: "Link promise proof",
    description:
      "Records proof that you kept your promise on a covenant you minted: the tx hash of the payment you sent from your own wallet, or the URL of the delivered work. Only the covenant's minter can, only once its ask is met, and only once. Never link proof of something that did not happen.",
    inputShape: {
      id: covenantId,
      proof: z.string().min(3).describe("Tx hash or URL proving the promise was kept"),
      from: fromField,
    },
    writes: true,
    execute: async ({ id, proof, from }) => {
      if (!signing) {
        const tx = kudo.buildLinkProof(id, proof);
        if (from) {
          const covenant = await kudo.getCovenant(id);
          if (covenant.agentWallet.toLowerCase() !== from.toLowerCase()) {
            throw new KudoError(
              "NOT_PROMISER",
              `Covenant ${id}'s promise is owed by ${covenant.agentWallet}; only that wallet can link its proof.`,
            );
          }
          kudo.assertPromiseDue(covenant);
        }
        return unsigned(tx, "Only the covenant's agentWallet can send this.", from);
      }
      const { hash } = await kudo.linkProof(id, proof);
      return toJson({
        signed: true,
        hash,
        explorer: kudo.txUrl(hash),
        next: "Kudo's Evaluator will check both legs and close the covenant.",
      });
    },
  });
