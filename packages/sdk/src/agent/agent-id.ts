/**
 * The agent's ERC-8004 id, which the runtime sets as AGENT_ID. Nobody sets it
 * by hand: a value already in the environment is discarded.
 *
 *   At startup   the runtime reads the registry's `Registered` events for this
 *                agent's wallet and sets AGENT_ID from them.
 *   A new agent  has none, so AGENT_ID stays empty. At its first run the agent
 *                registers and writes the new id to KUDO_AGENT_ID_FILE, and
 *                before every run the runtime sets AGENT_ID from that file.
 *
 * Every shell the agent runs is a fresh child of this process, so the file is
 * how the agent hands the id back.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { findRegisteredAgentId } from "../client.js";
import { networks } from "../networks.js";

const ID = /^\d+$/;

/** Sets AGENT_ID from this wallet's `Registered` events, discarding any value already set. */
export async function resolveAgentId(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  delete env.AGENT_ID;
  const owner = privateKeyToAccount(env.PRIVATE_KEY!.trim() as `0x${string}`).address;
  const client = createPublicClient({ transport: http(env.RPC_URL!.trim()) });
  const registry = env.IDENTITY_REGISTRY!.trim() as Address;
  const id = await findRegisteredAgentId(client, registry, owner, networks.robinhood.maxLogRange);

  if (id === undefined) {
    console.log(`no ERC-8004 identity registered by ${owner} — the agent registers one at its first run`);
    return;
  }
  env.AGENT_ID = id.toString();
  console.log(`AGENT_ID ${env.AGENT_ID}, registered by ${owner}`);
}

/** Creates the empty file a new agent writes its id to, and names it in KUDO_AGENT_ID_FILE. */
export async function prepareAgentIdFile(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "kudo-agent-id-")), "agent-id");
  env.KUDO_AGENT_ID_FILE = file;
  return file;
}

/**
 * Sets AGENT_ID from the id the agent wrote after registering, if it wrote
 * one. Returns the id when it changed AGENT_ID, so the change can be logged.
 */
export async function syncAgentId(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const file = env.KUDO_AGENT_ID_FILE;
  if (!file) return undefined;

  let recorded: string;
  try {
    recorded = (await readFile(file, "utf8")).trim();
  } catch {
    return undefined; // nothing written yet
  }
  if (!ID.test(recorded)) {
    if (recorded) console.error(`Ignoring ${file}: "${recorded.slice(0, 40)}" is not an agent id.`);
    return undefined;
  }

  const previous = env.AGENT_ID?.trim();
  env.AGENT_ID = recorded;
  return previous === recorded ? undefined : recorded;
}
