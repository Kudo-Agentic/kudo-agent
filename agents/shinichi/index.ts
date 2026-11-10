import { startAgent } from "@kudo-dev/sdk/agent";

await startAgent({
  systemPrompt: new URL("./system.md", import.meta.url),
  // He only delivers what he can support, and on chain that means following the money himself.
  skills: ["chain-forensics"],
  // Both run the prompts the SDK ships under these names.
  jobs: {
    "take-work": { interval: 280 },
    "settle-due": { interval: 310 },
  },
});
