#!/usr/bin/env node
/**
 * Keeps this agent's ERC-8004 registration file saying where it is reached:
 * an "agent" service whose endpoint is AGENT_ENDPOINT. Kudo's agent profile
 * reads that service to offer visitors a chat, sent to its POST /chat.
 *
 *   node registration-file.mjs
 *
 * Reads the identity's tokenURI and prints one JSON line:
 *   {"status":"current"}               nothing to do
 *   {"status":"update","uri":"data:…"} send setAgentURI(AGENT_ID, uri)
 *   {"status":"skip","reason":"…"}     nothing to do, and why
 *
 * It sends nothing itself. Only an inline data: file is rewritten: one hosted
 * at a URL or on IPFS is the owner's to edit, and so is an identity this
 * wallet no longer owns (setAgentURI would revert). Every other field and
 * service in the file is kept as it was.
 *
 * Environment: AGENT_ENDPOINT, AGENT_ID, AGENT_NAME, IDENTITY_REGISTRY,
 * RPC_URL, PRIVATE_KEY (only to find this wallet's address), TEE_ID_SOURCE.
 * Uses `cast`, so it needs no npm dependency.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
export const AGENT_SERVICE = "agent";

/** The JSON inside a data: URI, or null for anything else. */
export function decodeDataUri(uri) {
  if (!uri.startsWith("data:")) return null;
  const comma = uri.indexOf(",");
  if (comma < 0) return null;
  const meta = uri.slice(5, comma);
  const body = uri.slice(comma + 1);
  try {
    const text = meta.endsWith(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
    const file = JSON.parse(text);
    return file && typeof file === "object" && !Array.isArray(file) ? file : null;
  } catch {
    return null;
  }
}

export const encodeDataUri = (file) =>
  `data:application/json;base64,${Buffer.from(JSON.stringify(file), "utf8").toString("base64")}`;

/**
 * What to do about the file behind `uri`, given where the agent is reached.
 * Pure, so it can be tested without a chain.
 */
export function nextRegistration(uri, { endpoint, name, agentId, chainId, registry, attested }) {
  const current = uri.trim();
  let file;
  if (!current) {
    file = {
      type: REGISTRATION_TYPE,
      name: name || `Agent ${agentId}`,
      description: "",
      image: "",
      services: [],
      x402Support: false,
      active: true,
      registrations: [],
      supportedTrust: attested ? ["reputation", "tee-attestation"] : ["reputation"],
    };
  } else {
    file = decodeDataUri(current);
    if (!file) {
      return { status: "skip", reason: "the registration file is hosted, not inline; its owner edits it" };
    }
  }

  const services = Array.isArray(file.services) ? file.services : [];
  const others = services.filter((service) => service?.name !== AGENT_SERVICE);
  const listed = services.find((service) => service?.name === AGENT_SERVICE)?.endpoint;

  const registryId = `eip155:${chainId}:${registry}`;
  const registrations = Array.isArray(file.registrations) ? file.registrations : [];
  const registered = registrations.some(
    (entry) => String(entry?.agentId) === String(agentId) && String(entry?.agentRegistry).toLowerCase() === registryId.toLowerCase(),
  );

  if (current && listed === endpoint && registered) return { status: "current" };

  const next = {
    ...file,
    services: [{ name: AGENT_SERVICE, endpoint }, ...others],
    registrations: registered ? registrations : [...registrations, { agentId: Number(agentId), agentRegistry: registryId }],
  };
  return { status: "update", uri: encodeDataUri(next) };
}

const cast = (...args) => execFileSync("cast", args, { encoding: "utf8" }).trim();

/** `cast call` prints a string return quoted. */
const unquote = (text) => (text.startsWith('"') ? JSON.parse(text) : text);

function main() {
  const env = (key) => process.env[key]?.trim() ?? "";
  const print = (result) => process.stdout.write(`${JSON.stringify(result)}\n`);

  const endpoint = env("AGENT_ENDPOINT");
  if (!endpoint) return print({ status: "skip", reason: "AGENT_ENDPOINT is not set" });
  if (!/^https:\/\/[^\s]+$/.test(endpoint)) return print({ status: "skip", reason: "AGENT_ENDPOINT must be an https:// URL" });
  const agentId = env("AGENT_ID");
  if (!/^\d+$/.test(agentId)) return print({ status: "skip", reason: "AGENT_ID is not known yet; register first" });

  const rpc = ["--rpc-url", env("RPC_URL")];
  const registry = env("IDENTITY_REGISTRY");
  try {
    const owner = cast("call", registry, "ownerOf(uint256)(address)", agentId, ...rpc);
    const me = cast("wallet", "address", "--private-key", env("PRIVATE_KEY"));
    if (owner.toLowerCase() !== me.toLowerCase()) {
      return print({ status: "skip", reason: `identity ${agentId} is owned by ${owner}, who sets its file` });
    }
    const uri = unquote(cast("call", registry, "tokenURI(uint256)(string)", agentId, ...rpc));
    const chainId = cast("chain-id", ...rpc);
    print(
      nextRegistration(uri, {
        endpoint,
        name: env("AGENT_NAME"),
        agentId,
        chainId,
        registry,
        attested: env("TEE_ID_SOURCE") === "dstack",
      }),
    );
  } catch (error) {
    const key = env("PRIVATE_KEY");
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`registration-file: ${key ? message.split(key).join("[PRIVATE_KEY]") : message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
