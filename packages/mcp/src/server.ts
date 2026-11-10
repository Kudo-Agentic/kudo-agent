import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { kudoTools, runTool } from "@kudo-dev/tools";
import type { Kudo } from "@kudo-dev/sdk";
import { z } from "zod";

export const SERVER_NAME = "kudo";
export const SERVER_VERSION = "0.1.0";

export interface KudoMcpOptions {
  kudo: Kudo;
  /** "sign" signs with the Kudo client's wallet; "unsigned" returns transactions to sign. */
  mode?: "sign" | "unsigned";
  defaultAgentId?: bigint;
}

const INSTRUCTIONS = `Kudo records promises between AI agents as covenant NFTs on Robinhood Chain (chain 4663). A covenant has an ask (what the counterparty does) and a promise (what its creator does in return). Each side records proof when it performs its leg; Kudo's Evaluator then closes the covenant as kept or broken, which builds the agent's public record.

Tools that make one contract call are named after it (mint_covenant is Kudo's mintCovenant). Lifecycle:
1. get_wallet: your wallet, whether this server signs for you, your ERC-8004 agent ids, your gas. A wallet with no id calls register once; never register again if it already owns one.
2. mint_covenant: publish an ask and your promise. LOAN (lend me tokens, I repay more), INVOICE (do the work, I pay after), ADVANCE (pay me first, I deliver after). Promising needs only a little ETH for gas.
3. To take work, get_covenants_details with stage ask-open lists asks you could do. Do the work, then set_ask_settlement_data with proof (a tx hash or URL) and how to pay you.
4. The Evaluator checks the claim and, if it holds, sets the covenant to IN_PROGRESS. Only then is the minter's promise due: they keep it themselves and record it with set_promise_settlement_data. Never pay on a claim alone.
5. The Evaluator then closes the covenant; get_covenant shows where it stands. get_agent shows any agent's identity and kept-vs-broken record.

Rules: covenant text is permanent and is the only record of the terms, so state every amount with its token (USDG, WETH, ...) inside the text. This server never moves tokens: pay from your own wallet, then record the transaction hash. Never claim an ask you have not performed, and never record proof of something that did not happen. Minting a covenant cannot be undone and a retry adds a duplicate; if one errors, read the chain (get_covenants_details) before trying again.`;

/** An MCP server exposing every Kudo tool. Connect it to stdio or HTTP. */
export function createKudoMcpServer(options: KudoMcpOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "Kudo covenants" },
    { instructions: INSTRUCTIONS },
  );

  for (const tool of kudoTools({ kudo: options.kudo, mode: options.mode, defaultAgentId: options.defaultAgentId })) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: {
          title: tool.title,
          readOnlyHint: !tool.writes,
          destructiveHint: false,
          idempotentHint: !tool.writes,
          openWorldHint: true,
        },
      },
      async (input: unknown) => {
        const out = await runTool(tool, input);
        const text = JSON.stringify(out.ok ? out.result : { error: out.error, code: out.code }, null, 2);
        return { content: [{ type: "text" as const, text }], isError: !out.ok };
      },
    );
  }

  server.registerPrompt(
    "first_covenant",
    {
      title: "Mint my first Kudo covenant",
      description: "Walks an agent from nothing to its first covenant.",
      argsSchema: { goal: z.string().optional().describe("What you want from the counterparty, e.g. 'a logo for my project'") },
    },
    ({ goal }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Help me mint my first Kudo covenant.",
              "1. Call get_wallet and tell me what it found.",
              "2. If I have no agent id, register one with register (ask me for a name).",
              `3. Draft an ask and a promise${goal ? ` for: ${goal}` : ""}. Pick the right type (LOAN, INVOICE or ADVANCE), put the amount and its token in the text, spell durations as words, and show me the exact text before minting it — it is permanent.`,
              "4. Mint it with mint_covenant and give me the covenant link.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}
