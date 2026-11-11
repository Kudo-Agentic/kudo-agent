/**
 * startAgent: everything needed to run a Kudo agent.
 *
 * Starts the HTTP endpoint and the scheduled jobs, and stops both cleanly when
 * asked. The agent supplies who it is (its system prompt) and anything beyond
 * the defaults (extra skills, its own task prompts, its job schedule); the
 * chain, the key and the API key come from the environment (see .env.example).
 *
 *   SHUTDOWN_GRACE_SECONDS   how long a run may finish in on shutdown (default 120)
 *   KUDO_KEY_SOURCE          "env" (PRIVATE_KEY) or "dstack" (derived in the TEE); see key.ts
 *   OWNER_ADDRESS            set for an agent launched for someone: it registers
 *                            itself, hands them the identity and waits to be
 *                            linked before any job runs; see launch.ts
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAgent, type AgentSession } from "./agent.js";
import { prepareAgentIdFile, resolveAgentId, syncAgentId } from "./agent-id.js";
import { requireEnvironment, warnIfTwitterIncomplete } from "./config.js";
import { exclusive, resolveJobs, startJobs, whenRunsIdle, type AgentJob, type JobSpec } from "./jobs.js";
import { resolveSigningKey } from "./key.js";
import { isLaunched, runLaunch } from "./launch.js";
import { loadPrompt, loadSystemPrompt, type TextSource } from "./prompts.js";
import { startServer } from "./server/index.js";
import { SKILLS_DIR } from "./paths.js";
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
  /**
   * Scheduled jobs by name, each `{ interval, prompt? }`: seconds between runs
   * and the task prompt (text, a path or a file: URL). A job without a prompt
   * runs the bundled one of its name (`take-work`, `settle-due`). Default
   * `{ "settle-due": { interval: 300 } }`; JOBS overrides the schedule.
   */
  jobs?: Record<string, AgentJob>;
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
  // A one-line string naming an existing file is a path (as prompts.ts reads it).
  if (!source.includes("\n") && existsSync(source)) return dirname(resolve(source));
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
  const keySource = await resolveSigningKey();
  requireEnvironment();
  warnIfTwitterIncomplete();
  if (keySource === "dstack") console.log("signing key: derived in the TEE (dstack)");
  const launched = isLaunched();
  // AGENT_ID comes from the registry, never from the environment (agent-id.ts).
  // A launched agent finds it itself: its identity has moved to its owner, so
  // the "registered and still owned" lookup would miss it.
  if (!launched) await resolveAgentId();
  await announceTee();
  // The kudo skill's sponsored-send script, which every write tries first.
  process.env.KUDO_SPONSORED_SEND = join(SKILLS_DIR, "kudo", "sponsored-send.mjs");

  const session = await createSession(options);
  console.log(`skills: ${session.skills.names.join(", ")}`);

  const jobs = resolveJobs(options.jobs);
  // Fail now, not at the first tick, if a job has no prompt to run.
  for (const job of jobs) await loadPrompt(job.name, job.prompt);

  // Where a new agent writes its id after registering; every run starts from it.
  await prepareAgentIdFile();
  const beforeRun = async () => {
    const recorded = await syncAgentId();
    if (recorded) console.log(`AGENT_ID ${recorded}, as the agent recorded it after registering`);
  };

  // Through the same lock as the jobs: a message run signs from the same key.
  const run = (prompt: string) =>
    exclusive(async () => {
      await beforeRun();
      return runAgent(prompt, session, "message");
    });
  // Read on every run, so an edited prompt file takes effect at the next tick.
  const runJob = async (job: JobSpec) => {
    await beforeRun();
    return runAgent(await loadPrompt(job.name, job.prompt), session, job.name);
  };

  const server = startServer(run, options.port);
  let scheduled: ReturnType<typeof startJobs> | undefined;

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
    scheduled?.stop();

    // .unref() so a pending timer cannot keep the process alive on its own.
    const deadline = new Promise<"timeout">((resolveTimeout) =>
      setTimeout(() => resolveTimeout("timeout"), SHUTDOWN_GRACE_MS).unref(),
    );

    // Jobs, and any /message run in flight or already queued behind the lock.
    const idle = Promise.all([scheduled?.whenIdle(), whenRunsIdle()]);
    void Promise.race([idle, deadline]).then((outcome) => {
      if (outcome === "timeout") console.error("run did not finish in time — exiting anyway");
      process.exit(0);
    });
  }

  process.on("SIGTERM", shutdown); // orchestrator stopping the container
  process.on("SIGINT", shutdown); // Ctrl-C

  // A launched agent registers, hands over its identity and waits to be
  // linked first: until then it cannot act for that identity. /identity and
  // /wallet-link answer meanwhile; /message says it is not ready.
  if (launched) await runLaunch();
  if (!shuttingDown) scheduled = startJobs(jobs, runJob);
}
