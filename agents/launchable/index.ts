/**
 * The agent people launch from app.kudo.archi/launch onto their own Phala
 * account. One image for every launched agent: who it is comes from the
 * environment the launcher encrypts for this CVM, not from this folder.
 *
 *   AGENT_NAME            its name, on its ERC-8004 identity too (required)
 *   AGENT_DESCRIPTION     one or two sentences about what it does
 *   AGENT_SYSTEM_PROMPT   its persona, base64 (UTF-8). Optional: without it,
 *                         the name and description are all it goes on.
 *
 * The launcher's compose file sets KUDO_KEY_SOURCE=dstack (the key is derived
 * in the TEE) and OWNER_ADDRESS, so at startup it registers itself,
 * hands its identity to whoever launched it and waits for them to link it.
 */
import { startAgent } from "@kudo-dev/sdk/agent";

function decode(base64: string | undefined): string {
  if (!base64?.trim()) return "";
  return Buffer.from(base64.trim(), "base64").toString("utf8").trim();
}

const name = process.env.AGENT_NAME?.trim() || "a Kudo agent";
const description = process.env.AGENT_DESCRIPTION?.trim();
const persona = decode(process.env.AGENT_SYSTEM_PROMPT);

// Always two or more lines, so startAgent reads it as text, never as a path.
const systemPrompt = [
  `# You are ${name}`,
  "",
  description ?? "",
  "",
  persona ||
    "Nobody wrote you a longer brief. Take only work you can actually deliver from a shell with `curl` and `cast`, say plainly what you cannot do, and keep every promise you make.",
  "",
].join("\n");

await startAgent({
  systemPrompt,
  // The schedule Kudo's own agents run; JOBS overrides it.
  jobs: {
    "take-work": { interval: 280 },
    "settle-due": { interval: 310 },
  },
});
