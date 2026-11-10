import { z } from "zod";
import { COVENANT_TYPES, KudoError } from "@kudo-dev/sdk";

import { address, agentIdField, define, toJson, type ToolContext } from "./shared.js";

export const mintCovenant = ({ kudo, signing, unsigned, agentIdOf }: ToolContext) =>
  define({
    name: "mint_covenant",
    title: "Mint a covenant",
    description:
      "Kudo mintCovenant: publishes an ask and your promise as a covenant NFT. PERMANENT: the text cannot be edited and a retry adds a duplicate. Write the ask addressed to the counterparty with a reason, and the promise as an ordinary sentence; put every amount inside the text with its token (USDG, WETH, …), and spell durations as words. Types: LOAN (lend me tokens, I repay more), INVOICE (do the work, I pay after), ADVANCE (pay me first, I deliver after). You need no tokens to promise, only ETH for gas.",
    inputShape: {
      type: z.enum(COVENANT_TYPES),
      ask: z
        .string()
        .min(3)
        .max(500)
        .describe('What the counterparty does, e.g. "Write a 300-word explainer of ERC-8004 and publish it on IPFS."'),
      promise: z
        .string()
        .min(3)
        .max(500)
        .describe('What you do in return, e.g. "I\'ll pay 5 USDG within one hour of the link going up."'),
      agentId: agentIdField.optional(),
      from: address
        .optional()
        .describe("Unsigned mode: your wallet, to check you own agentId and dry-run the mint as you before you sign."),
    },
    writes: true,
    execute: async ({ type, ask, promise, agentId, from }) => {
      const input = { type, ask, promise, agentId: await agentIdOf(agentId, from) };
      if (!signing) {
        const tx = kudo.buildMintCovenant(input);
        if (from) {
          const owner = (await kudo.getAgent(input.agentId)).owner;
          if (owner.toLowerCase() !== from.toLowerCase()) {
            throw new KudoError("NOT_AGENT_OWNER", `Agent ${input.agentId} belongs to ${owner}, not ${from}.`);
          }
        }
        return unsigned(tx, "The new covenant id is the nftId of the CovenantMinted event in the receipt.", from);
      }
      const { hash, covenantId, url } = await kudo.mintCovenant(input);
      return toJson({
        signed: true,
        covenantId,
        hash,
        url,
        explorer: kudo.txUrl(hash),
        next: "Share the url. When a counterparty meets the ask, keep your promise and call set_promise_settlement_data.",
      });
    },
  });
