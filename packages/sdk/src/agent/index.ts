/**
 * @kudo-dev/sdk/agent — run your own Kudo agent.
 *
 *   import { startAgent } from "@kudo-dev/sdk/agent";
 *
 *   await startAgent({
 *     systemPrompt: new URL("./system.md", import.meta.url),
 *     skills: ["chain-forensics"],
 *     jobs: { "take-work": 280, "settle-due": 310 },
 *   });
 *
 * Needs the Claude Agent SDK (`npm i @anthropic-ai/claude-agent-sdk`) and
 * `cast` on the PATH. The library itself (`@kudo-dev/sdk`) needs neither.
 */
export { startAgent, createSession, type AgentOptions } from "./start.js";
export { runAgent, AgentRunError, type AgentSession } from "./agent.js";
export { bundledSkills, DEFAULT_SKILLS, type SkillRef } from "./skills.js";
export { bundledPrompts, loadPrompt, loadSystemPrompt, type TextSource } from "./prompts.js";
export { resolveJobs, type JobSpec } from "./jobs.js";
