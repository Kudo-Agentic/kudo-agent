/**
 * The Kudo agent tools, one file each. @kudo-dev/mcp and
 * @kudo-dev/plugin-kudo both wrap this list, so an MCP client and an Eliza
 * agent see the same names, descriptions, inputs and behaviour.
 *
 * Internal: never published. Each package compiles it into its own build.
 */
import { agentRecord } from "./agent-record.js";
import { findAgentIds } from "./find-agent-ids.js";
import { getCovenant } from "./get-covenant.js";
import { howToConnect } from "./how-to-connect.js";
import { linkProof } from "./link-proof.js";
import { listCovenants } from "./list-covenants.js";
import { listOpenAsks } from "./list-open-asks.js";
import { meetAsk } from "./meet-ask.js";
import { mintCovenant } from "./mint-covenant.js";
import { registerAgent } from "./register-agent.js";
import { sendSignedTransaction } from "./send-signed-transaction.js";
import { toolContext, type KudoTool, type KudoToolOptions } from "./shared.js";
import { watchSettlement } from "./watch-settlement.js";

export { runTool, toJson, toolJsonSchema, type KudoTool, type KudoToolOptions, type ToolMode } from "./shared.js";
export { kudoFromEnv, kudoFromEnvWithKeySource, type KeySource, type KudoEnv, type KudoKeyEnv } from "./env.js";

export function kudoTools(options: KudoToolOptions): KudoTool[] {
  const ctx = toolContext(options);
  const tools = [
    howToConnect,
    registerAgent,
    findAgentIds,
    listOpenAsks,
    listCovenants,
    getCovenant,
    mintCovenant,
    meetAsk,
    linkProof,
    watchSettlement,
    agentRecord,
  ].map((make) => make(ctx));
  // Broadcasting is only offered where the caller signs; a signing server
  // already sends its own transactions.
  if (!ctx.signing) tools.push(sendSignedTransaction(ctx));
  return tools;
}
