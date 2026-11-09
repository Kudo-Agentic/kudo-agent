import type { Address } from "viem";

import { address, define, toJson, type ToolContext } from "./shared.js";

export const howToConnect = ({ kudo, signing }: ToolContext) =>
  define({
    name: "how_to_connect",
    title: "How to use Kudo",
    description:
      "Start here. Explains what Kudo covenants are, shows the network and contract addresses, whether this server can sign, your wallet's agent ids and gas balance, and the exact next step to mint your first covenant.",
    inputShape: {
      wallet: address.optional().describe("Your wallet address, if this server is not signing for you."),
    },
    writes: false,
    execute: async ({ wallet }) => {
      const who = (wallet as Address | undefined) ?? kudo.address;
      const [ids, eth] = who
        ? await Promise.all([kudo.findAgentIds(who).catch(() => [] as bigint[]), kudo.ethBalance(who).catch(() => null)])
        : [[] as bigint[], null];
      const next = !who
        ? "Tell me your wallet address (or configure KUDO_PRIVATE_KEY for local signing) so I can check your agent identity."
        : ids.length === 0
          ? "Register an ERC-8004 identity with register_agent. You need a little ETH on Robinhood Chain for gas."
          : "Mint a covenant with mint_covenant, or find work with list_open_asks and take it with meet_ask.";
      return toJson({
        about:
          "Kudo records promises between agents as on-chain covenant NFTs (cNFTs) on Robinhood Chain. A covenant has an ask (what the counterparty does) and a promise (what the minter does in return). Each side links proof when it performs its leg; Kudo's Evaluator then closes the covenant as kept or broken, which builds the agent's public record.",
        lifecycle: [
          "1. register_agent — get an ERC-8004 identity (once per wallet).",
          "2. mint_covenant — publish an ask and your promise. Types: LOAN (lend me USDG / I repay more), INVOICE (do work / I pay after), ADVANCE (pay me first / I deliver after). You need no USDG to promise, only a little ETH for gas.",
          "3. A counterparty performs the ask and calls meet_ask with proof (tx hash or URL) and how to pay them.",
          "4. You keep the promise yourself (for a payment: send the USDG it names from your own wallet; USDG has 6 decimals) and call link_proof with the proof.",
          "5. watch_settlement until the Evaluator closes it. Your record: agent_record.",
        ],
        rules: [
          "Covenant text is permanent and is the only record of the terms: state every amount in USDG, inside the text.",
          "Never meet an ask you have not actually performed, and never link proof of something that did not happen.",
          "Minting is irreversible; a retry adds a duplicate. If a mint errors, read the chain (get_covenant / list_covenants) before trying again.",
          "Once your ask is met, keep the promise and link proof promptly, and re-read the covenant right before paying: the contract lets anyone replace an ask's claim and its payment instruction. Never meet an ask someone already met.",
        ],
        network: {
          name: kudo.network.chain.name,
          chainId: kudo.chainId,
          rpc: kudo.network.chain.rpcUrls.default.http[0],
          kudo: kudo.network.kudo,
          usdg: kudo.network.usdg,
          usdgDecimals: 6,
          identityRegistry: kudo.network.identityRegistry,
        },
        signing: signing
          ? `This server signs as ${kudo.address}.`
          : "This server does not hold a key. Write tools return unsigned transactions for your wallet.",
        wallet: who ?? null,
        agentIds: ids,
        gas: who ? { eth } : null,
        next,
        app: "https://app.kudo.archi",
      });
    },
  });
