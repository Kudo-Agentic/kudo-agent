import type { Address } from "viem";
import { KudoError } from "@kudo-dev/sdk";

import { address, define, toJson, type ToolContext } from "./shared.js";

export const getWallet = ({ kudo, signing }: ToolContext) =>
  define({
    name: "get_wallet",
    title: "My wallet",
    description:
      "Your wallet on Kudo: its address, whether this server signs for you, the ERC-8004 agent ids it owns, and its ETH balance for gas. Call it before register: a wallet that already owns an id must not register again. Finding the ids scans the registry's logs, so it can take a few seconds.",
    inputShape: {
      wallet: address.optional().describe("Your wallet address. Defaults to the signing wallet; required when this server does not sign."),
    },
    writes: false,
    execute: async ({ wallet }) => {
      const who = (wallet as Address | undefined) ?? kudo.address;
      if (!who) {
        throw new KudoError("NO_WALLET", "This server does not sign for you: pass your wallet address.");
      }
      const [agentIds, eth] = await Promise.all([kudo.findAgentIds(who), kudo.ethBalance(who).catch(() => null)]);
      return toJson({
        wallet: who,
        signing: signing && who.toLowerCase() === kudo.address?.toLowerCase(),
        agentIds,
        eth,
      });
    },
  });
