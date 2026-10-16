/**
 * The agent.
 *
 * One function: give it a prompt, get its answer back. There are no custom
 * tools — it works the way a person would at a shell, with `cast` for the chain
 * and `node` to sign X API requests. What it knows lives in .claude/skills/.
 */
import {
  query,
  type Options,
  type SDKAssistantMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { loadSystemPrompt } from "./prompts.ts";

export { loadPrompt } from "./prompts.ts";

const DEFAULT_SKILLS = ["kudo-covenants", "twitter"];

/** Skills this agent is given, from SKILLS, comma separated. */
function configuredSkills(): string[] {
  const raw = process.env.SKILLS?.trim();
  if (!raw) return DEFAULT_SKILLS;

  const skills = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  if (skills.length === 0) {
    throw new Error('SKILLS is set but names none — unset it for the default.');
  }
  return skills;
}

/** Keeps a long run alive through slow RPC calls and a flaky network. */
const RESILIENCE_ENV = {
  API_TIMEOUT_MS: "120000",
  CLAUDE_CODE_MAX_RETRIES: "2",
  CLAUDE_ENABLE_STREAM_WATCHDOG: "1",
  CLAUDE_STREAM_IDLE_TIMEOUT_MS: "300000",
};

function agentOptions(systemPrompt: string): Options {
  return {
    model: "claude-opus-5",
    systemPrompt,

    // Skills live in .claude/skills/, which is a project setting source.
    //
    // Which ones an agent gets is deployment config, because they are not all
    // for everyone: kudo-validation describes closing covenants, which only
    // the evaluator can do, and handing it to a trader would describe a power
    // it does not have.
    settingSources: ["project"],
    skills: configuredSkills(),

    // The shell is the whole tool surface.
    //
    // `allowedTools` is an auto-approve list, not a filter: on its own it still
    // leaves every other built-in tool, and any connector on the API key's
    // account, advertised to the model. Denying them explicitly takes the tool
    // list from 23 entries to Bash and Skill, so what the agent can do matches
    // what this file says it can do — which is the claim the TEE attestation
    // is supposed to stand behind.
    allowedTools: ["Bash"],
    disallowedTools: [
      "Read",
      "Write",
      "Edit",
      "WebFetch",
      "WebSearch",
      "mcp__*", // connectors inherited from the account behind ANTHROPIC_API_KEY
      "Task",
      "Artifact",
      "ArtifactComments",
      "ArtifactData",
      "CronCreate",
      "CronDelete",
      "CronList",
      "DesignSync",
      "EnterWorktree",
      "ExitWorktree",
      "ListAgents",
      "Monitor",
      "NotebookEdit",
      "PushNotification",
      "RemoteTrigger",
      "ReportFindings",
      "ScheduleWakeup",
      "SendMessage",
      "TaskStop",
      "ToolSearch",
      "Workflow",
    ],

    // Nobody is at the keyboard, so deny anything not pre-approved.
    permissionMode: "dontAsk",

    maxTurns: 40,

    env: { ...process.env, ...RESILIENCE_ENV },
  };
}

/** The prose of one assistant turn. Tool calls and thinking are not included. */
function proseOf(message: SDKAssistantMessage): string {
  return message.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export class AgentRunError extends Error {}

function assertSucceeded(result: SDKResultMessage): void {
  if (result.subtype !== "success") {
    throw new AgentRunError(`Agent run ended: ${result.subtype}`);
  }
}

/**
 * Runs one task to completion and returns everything the agent said.
 *
 * Throws AgentRunError if the run did not finish — callers decide whether that
 * is a 500 or a logged line.
 */
export async function runAgent(prompt: string): Promise<string> {
  const options = agentOptions(await loadSystemPrompt());
  const said: string[] = [];

  for await (const message of query({ prompt, options })) {
    if (message.type === "assistant") said.push(proseOf(message));
    if (message.type === "result") {
      assertSucceeded(message);
      return said.join("").trim();
    }
  }

  throw new AgentRunError("Agent run ended without a result.");
}
