/**
 * startAgent: everything needed to run a Kudo agent.
 *
 * Starts the HTTP endpoint and the scheduled jobs, and stops both cleanly when
 * asked. The agent supplies who it is (its system prompt) and anything beyond
 * the defaults (extra skills, its own task prompts, its job schedule); the
 * chain, the key and the API key come from the environment (see .env.example).
 *
 *   SHUTDOWN_GRACE_SECONDS   how long a run may finish in on shutdown (default 120)
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAgent, type AgentSession } from "./agent.js";
import { requireEnvironment, warnIfTwitterIncomplete, warnIfUnregistered } from "./config.js";
import { resolveJobs, startJobs } from "./jobs.js";
import { loadPrompt, loadSystemPrompt, type TextSource } from "./prompts.js";
import { startServer } from "./server/index.js";
import { assembleSkills, type SkillRef } from "./skills.js";
import { resolveTeeIdentity } from "./tee.js";

export interface AgentOptions {
  /** Who this agent is: the text, or a path / file: URL to it (e.g. `new URL("./system.md", import.meta.url)`). */
  systemPrompt: TextSource;
  /**
   * Skills beyond the defaults (`kudo`, `kudo-runtime`, `twitter`): the name of
   * one this package ships (`chain-forensics`, `kudo-validation`) or a path /
   * file: URL to a skill folder of your own.
   */
  skills?: SkillRef[];
  /** Task prompts of this agent's own, by name, added to the bundled `take-work` and `settle-due`. */
  prompts?: Record<string, TextSource>;
  /** Task prompt name → seconds between runs. Default `{ "settle-due": 300 }`; JOBS overrides it. */
  jobs?: Record<string, number>;
  /** HTTP port. Default PORT, else 3000. */
  port?: number;
  /** Claude model id. Default `claude-opus-5`. */
  model?: string;
  /** Working directory for the agent's shell. Default: the system prompt file's folder, else the current one. */
  cwd?: string;
}

/**
 * Must stay below the orchestrator's stop grace period, or the process is
 * SIGKILLed first and the graceful path never runs.
 */
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_SECONDS?.trim() || 120) * 1000;

/**
 * Resolves the Phala app id and puts it in the environment, where the agent
 * picks it up and registers it as `teeId` metadata on its ERC-8004 identity.
 */
async function announceTee(): Promise<void> {
  const tee = await resolveTeeIdentity();

  if (!tee) {
    console.log("no TEE app id — running without attestation");
    return;
  }

  process.env.TEE_ID = tee.teeId;
  process.env.TEE_TRUST_URL = tee.trustCenterUrl;
  process.env.TEE_ID_SOURCE = tee.source;

  if (tee.source === "dstack") {
    console.log(`attestation: ${tee.trustCenterUrl}`);
    return;
  }

  // A mocked id resolves to a real report for somebody else's app. Say so, or
  // a local run reads exactly like an attested one.
  console.log(`TEE_ID set by hand: ${tee.trustCenterUrl}`);
  console.log("  that report is NOT this process — local stand-in, attests nothing");
}

function defaultCwd(source: TextSource): string {
  if (source instanceof URL) return dirname(fileURLToPath(source));
  return process.cwd();
}

/** The fixed parts of a run: system prompt, skills, working directory, model. */
export async function createSession(options: AgentOptions): Promise<AgentSession> {
  const skills = await assembleSkills(options.skills);
  return {
    systemPrompt: await loadSystemPrompt(options.systemPrompt),
    skills,
    cwd: resolve(options.cwd ?? defaultCwd(options.systemPrompt)),
    model: options.model ?? "claude-opus-5",
  };
}

/** Starts the agent: the HTTP endpoint and its scheduled jobs. Resolves once both are running. */
export async function startAgent(options: AgentOptions): Promise<void> {
  requireEnvironment();
  warnIfTwitterIncomplete();
  warnIfUnregistered();
  await announceTee();

  const session = await createSession(options);
  console.log(`skills: ${session.skills.names.join(", ")}`);

  const jobs = resolveJobs(options.jobs);
  // Fail now, not at the first tick, if a job names a prompt this agent lacks.
  for (const job of jobs) await loadPrompt(job.prompt, options.prompts);

  const run = (prompt: string) => runAgent(prompt, session);
  const runJob = async (name: string) => run(await loadPrompt(name, options.prompts));

  const server = startServer(run, options.port);
  const scheduled = startJobs(jobs, runJob);

  let shuttingDown = false;

  /**
   * Stop accepting work, then let any run in flight finish rather than being
   * killed between a payment and its attestation — but not forever.
   */
  function shutdown(): void {
    if (shuttingDown) {
      console.log("second signal — exiting now");
      process.exit(130);
    }
    shuttingDown = true;

    console.log(`shutting down (up to ${SHUTDOWN_GRACE_MS / 1000}s for the current run)`);
    server.close();
    scheduled.stop();

    // .unref() so a pending timer cannot keep the process alive on its own.
    const deadline = new Promise<"timeout">((resolveTimeout) =>
      setTimeout(() => resolveTimeout("timeout"), SHUTDOWN_GRACE_MS).unref(),
    );

    void Promise.race([scheduled.whenIdle(), deadline]).then((outcome) => {
      if (outcome === "timeout") console.error("run did not finish in time — exiting anyway");
      process.exit(0);
    });
  }

  process.on("SIGTERM", shutdown); // orchestrator stopping the container
  process.on("SIGINT", shutdown); // Ctrl-C
}
