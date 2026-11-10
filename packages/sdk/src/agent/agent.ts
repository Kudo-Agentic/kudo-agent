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
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { clip, limits, runLog, type RunLog } from "./log.js";
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

function agentOptions(session: AgentSession, log: RunLog): Options {
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

    // Claude Code's own diagnostics: API errors, retries, a failed plugin load.
    stderr: (data) => {
      for (const line of data.split("\n")) if (line.trim()) log.error(`stderr: ${clip(line, limits.MAX_OUTPUT)}`);
    },
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

/** The text of a tool result, which the SDK gives as a string or as content blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
    .join("");
}

/**
 * Logs one message from the run: each command or skill the agent starts, the
 * output of any that fails, and (at debug) everything else.
 */
function logMessage(message: SDKMessage, log: RunLog, commands: Map<string, string>): void {
  if (message.type === "system" && message.subtype === "init") {
    log.debug(`session ${message.session_id}, model ${message.model}, tools ${message.tools.join(", ")}`);
    return;
  }

  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text" && block.text.trim()) log.debug(`says: ${clip(block.text, limits.MAX_OUTPUT)}`);
      if (block.type !== "tool_use") continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      const what =
        block.name === "Bash"
          ? `$ ${clip(String(input.command ?? ""), limits.MAX_COMMAND)}`
          : block.name === "Skill"
            ? `skill ${String(input.skill ?? input.command ?? "")}`
            : `${block.name} ${clip(JSON.stringify(input), limits.MAX_COMMAND)}`;
      commands.set(block.id, what);
      log.info(what);
    }
    return;
  }

  if (message.type === "user" && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (typeof block !== "object" || block.type !== "tool_result") continue;
      const output = clip(resultText(block.content), limits.MAX_OUTPUT);
      const what = commands.get(block.tool_use_id) ?? block.tool_use_id;
      if (block.is_error) log.error(`failed: ${what}\n${output}`);
      else log.debug(`output of ${what}\n${output}`);
    }
  }
}

/** The run's closing line, and an error for anything but success. */
function finish(result: SDKResultMessage, log: RunLog): AgentRunError | undefined {
  const stats = `${(result.duration_ms / 1000).toFixed(1)}s, ${result.num_turns} turns, $${result.total_cost_usd.toFixed(4)}`;
  for (const denial of result.permission_denials ?? []) {
    log.error(`denied tool ${denial.tool_name}: ${clip(JSON.stringify(denial.tool_input), limits.MAX_COMMAND)}`);
  }
  if (result.subtype === "success") {
    log.info(`done (${stats})`);
    return undefined;
  }
  const errors = result.errors?.length ? `: ${result.errors.join("; ")}` : "";
  log.error(`ended ${result.subtype} (${stats})${errors}`);
  return new AgentRunError(`Agent run ended: ${result.subtype}${errors}`);
}

/**
 * Runs one task to completion and returns everything the agent said.
 * `label` names what started it (a job's name, or `message`) in the log.
 *
 * Throws AgentRunError if the run did not finish — callers decide whether that
 * is a 500 or a logged line.
 */
export async function runAgent(prompt: string, session: AgentSession, label = "run"): Promise<string> {
  const log = runLog(label);
  const options = agentOptions(session, log);
  const said: string[] = [];
  const commands = new Map<string, string>();

  log.info(`started: ${clip(prompt.split("\n")[0] ?? "", 120)}`);
  try {
    for await (const message of query({ prompt, options })) {
      logMessage(message, log, commands);
      if (message.type === "assistant") said.push(proseOf(message));
      if (message.type === "result") {
        const error = finish(message, log);
        if (error) throw error;
        return said.join("").trim();
      }
    }
  } catch (error) {
    if (!(error instanceof AgentRunError)) {
      log.error(`crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
    throw error;
  }

  log.error("ended without a result");
  throw new AgentRunError("Agent run ended without a result.");
}
