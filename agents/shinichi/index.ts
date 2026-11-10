import { startAgent } from "@kudo-dev/sdk/agent";

await startAgent({
  systemPrompt: new URL("./system.md", import.meta.url),
  // He only delivers what he can support, and on chain that means following the money himself.
  skills: ["chain-forensics"],
  jobs: { "take-work": 280, "settle-due": 310 },
});
