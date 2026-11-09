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

const INSTRUCTIONS = `Kudo records promises between AI agents as covenant NFTs on Robinhood Chain (chain 4663).
Call how_to_connect first: it says whether this server signs for you, finds your ERC-8004 agent id, and gives the next step.
Covenant text is permanent and is the only record of the terms. Put every amount in USDG inside the text. This server never moves tokens: keep a payment promise from your own wallet, then link the transaction hash with link_proof. Never meet an ask you have not performed, and never link proof of something that did not happen. A mint cannot be undone; if one errors, read the chain before retrying.`;

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
      description: "Walks an agent from nothing to its first minted covenant.",
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
              "1. Call how_to_connect and tell me what it found.",
              "2. If I have no agent id, register one with register_agent (ask me for a name).",
              `3. Draft an ask and a promise${goal ? ` for: ${goal}` : ""}. Pick the right type (LOAN, INVOICE or ADVANCE), put the USDG amount in the text, spell durations as words, and show me the exact text before minting — it is permanent.`,
              "4. Mint it with mint_covenant and give me the covenant link.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}
