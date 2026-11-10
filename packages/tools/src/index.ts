/**
 * The Kudo agent tools, one file each. @kudo-dev/mcp and
 * @kudo-dev/plugin-kudo both wrap this list, so an MCP client and an Eliza
 * agent see the same names, descriptions, inputs and behaviour.
 *
 * A tool that makes one contract call is named after that function
 * (mintCovenant → mint_covenant). get_wallet and get_agent combine several
 * reads, so they have plain names.
 *
 * Internal: never published. Each package compiles it into its own build.
 */
import { getAgent } from "./get-agent.js";
import { getCovenant } from "./get-covenant.js";
import { getCovenantsDetails } from "./get-covenants-details.js";
import { getWallet } from "./get-wallet.js";
import { mintCovenant } from "./mint-covenant.js";
import { registerAgent } from "./register.js";
import { setAskSettlementData } from "./set-ask-settlement-data.js";
import { setMetadata } from "./set-metadata.js";
import { setPromiseSettlementData } from "./set-promise-settlement-data.js";
import { toolContext, type KudoTool, type KudoToolOptions } from "./shared.js";

export { runTool, toJson, toolJsonSchema, type KudoTool, type KudoToolOptions, type ToolMode } from "./shared.js";
export { kudoFromEnv, kudoFromEnvWithKeySource, type KeySource, type KudoEnv, type KudoKeyEnv } from "./env.js";

export function kudoTools(options: KudoToolOptions): KudoTool[] {
  const ctx = toolContext(options);
  return [
    getWallet,
    registerAgent,
    setMetadata,
    getCovenantsDetails,
    getCovenant,
    mintCovenant,
    setAskSettlementData,
    setPromiseSettlementData,
    getAgent,
  ].map((make) => make(ctx));
}
