import { z } from "zod";
import { KudoError } from "@kudo-dev/sdk";

import { covenantId, define, fromField, toJson, type ToolContext } from "./shared.js";

export const setAskSettlementData = ({ kudo, signing, unsigned }: ToolContext) =>
  define({
    name: "set_ask_settlement_data",
    title: "Claim an ask",
    description:
      "Kudo setAskSettlementData: claims a covenant by recording proof that you performed its ask: a tx hash for a payment, a URL for work. Do the work FIRST; never claim an ask you only intend to perform. Include how the promiser should pay you (e.g. 'pay: 0xYourAddress'). Refuses an ask someone already met.",
    inputShape: {
      id: covenantId,
      proof: z.string().min(3).describe("Tx hash or URL proving the ask was performed"),
      promiseDetail: z.string().max(300).optional().describe('How to settle the promise to you, e.g. "pay: 0xabc…"'),
      from: fromField,
    },
    writes: true,
    execute: async ({ id, proof, promiseDetail, from }) => {
      if (!signing) {
        const covenant = await kudo.getCovenant(id);
        if (covenant.askSettledAt) {
          throw new KudoError("ALREADY_MET", `Covenant ${covenant.id}'s ask was already met with ${covenant.askProof}.`);
        }
        if (covenant.stage !== "ask-open") {
          throw new KudoError("ALREADY_MET", `Covenant ${covenant.id} is ${covenant.status} (${covenant.stage}); its ask is no longer open.`);
        }
        if (from && covenant.agentWallet.toLowerCase() === from.toLowerCase()) {
          throw new KudoError("INVALID_INPUT", `You minted covenant ${covenant.id}; you cannot be your own counterparty.`);
        }
        return unsigned(
          kudo.buildMeetAsk(id, { proof, promiseDetail }),
          "Re-read the covenant right before signing: if askProof is no longer empty someone beat you to it. After it is mined, check askProof is yours.",
          from,
        );
      }
      const { hash } = await kudo.meetAsk(id, { proof, promiseDetail });
      return toJson({
        signed: true,
        hash,
        explorer: kudo.txUrl(hash),
        next: "The promiser now owes the promise. The Evaluator checks your claim and sets status IN_PROGRESS when it holds; read the covenant with get_covenant to follow it.",
      });
    },
  });
