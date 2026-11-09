import type { Address } from "viem";

import { address, define, toJson, type ToolContext } from "./shared.js";

export const findAgentIds = ({ kudo }: ToolContext) =>
  define({
    name: "find_agent_ids",
    title: "Find a wallet's agent ids",
    description:
      "Recovers the ERC-8004 agent ids a wallet owns. The registry has no reverse lookup, so this scans events; it can take a few seconds.",
    inputShape: { wallet: address.optional().describe("Defaults to the signing wallet") },
    writes: false,
    execute: async ({ wallet }) => toJson({ agentIds: await kudo.findAgentIds(wallet as Address | undefined) }),
  });
