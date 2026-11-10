/**
 * The agent.
 *
 * One function: give it a prompt, get its answer back. There are no custom
 * tools — it works the way a person would at a shell, with `cast` for the chain
 * and `node` to sign X API requests. What it knows lives in its skills (see
 * skills.ts) and its system prompt (see prompts.ts).
 */
import {
  query,
  type Options,
  type SDKAssistantMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { SkillPlugin } from "./skills.js";

/** What one agent runs with, fixed at startup. */
export interface AgentSession {
  /** common.md followed by the agent's own system prompt. */
  systemPrompt: string;
  /** The plugin holding exactly this agent's skills. */
  skills: SkillPlugin;
  /** Working directory for the shell: the agent's own folder. */
  cwd: string;
  /** Claude model id. */
  model: string;
}

/** Keeps a long run alive through slow RPC calls and a flaky network. */
const RESILIENCE_ENV = {
  API_TIMEOUT_MS: "120000",
  CLAUDE_CODE_MAX_RETRIES: "2",
  CLAUDE_ENABLE_STREAM_WATCHDOG: "1",
  CLAUDE_STREAM_IDLE_TIMEOUT_MS: "300000",
};

function agentOptions(session: AgentSession): Options {
  return {
    model: session.model,
    systemPrompt: session.systemPrompt,
    cwd: session.cwd,

    // Skills come only from the plugin assembled for this agent (skills.ts),
    // and no project or user settings are read, so nothing else on the machine
    // changes what the agent knows.
    settingSources: [],
    plugins: [{ type: "local", path: session.skills.path }],
    skills: session.skills.names,

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
export async function runAgent(prompt: string, session: AgentSession): Promise<string> {
  const options = agentOptions(session);
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
