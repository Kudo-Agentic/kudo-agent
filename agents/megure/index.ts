import { startAgent } from "@kudo-dev/sdk/agent";

await startAgent({
  systemPrompt: new URL("./system.md", import.meta.url),
  // Accepting asks and closing covenants is the evaluator's alone.
  skills: ["kudo-validation"],
  prompts: { validate: new URL("./validate.txt", import.meta.url) },
  jobs: { validate: 180 },
});
