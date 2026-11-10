/**
 * Scheduled jobs.
 *
 * A job is one task prompt on one interval. An agent runs as many as it has
 * work of different kinds — Shinichi takes work on one tick and settles what
 * he owes on another — and each prompt stays focused on a single job rather
 * than growing branches for everything the agent might need to do.
 *
 * The agent passes its jobs to startAgent, each a name with an interval and,
 * optionally, its prompt; without one, the bundled prompt of that name is used.
 * Two environment variables override the schedule, so a deployment can change
 * it without a new image:
 *
 *   JOBS                    comma-separated <name>:<seconds>, e.g. "take-work:280,settle-due:310"
 *   TICK_INTERVAL_SECONDS   0 runs no jobs at all (something else owns this agent's work)
 *
 * A job JOBS names keeps the prompt the agent gave it.
 */
import { redact } from "./log.js";
import type { TextSource } from "./prompts.js";

/** One scheduled job, as an agent passes it to startAgent. */
export interface AgentJob {
  /** Seconds between runs, at least ten. */
  interval: number;
  /** The task prompt: text, a path or a file: URL. Default: the bundled prompt of the job's name. */
  prompt?: TextSource;
}

const DEFAULT_JOBS: Record<string, AgentJob> = { "settle-due": { interval: 300 } };
const MIN_INTERVAL_SECONDS = 10;

export interface JobSpec {
  name: string;
  intervalSeconds: number;
  /** The job's own prompt; undefined means the bundled one named `name`. */
  prompt?: TextSource;
}

export interface Jobs {
  stop(): void;
  /** Resolves once every run in flight has finished. */
  whenIdle(): Promise<void>;
}

const log = (job: string, message: string) =>
  console.log(`${new Date().toISOString().slice(11, 19)} ${job}: ${redact(message)}`);

function spec(name: string, seconds: number, prompt: TextSource | undefined, source: string): JobSpec {
  if (!name || !Number.isFinite(seconds) || seconds < MIN_INTERVAL_SECONDS) {
    throw new Error(`${source}: "${name}:${seconds}" is not <name>:<seconds> with seconds >= ${MIN_INTERVAL_SECONDS}.`);
  }
  return prompt === undefined ? { name, intervalSeconds: seconds } : { name, intervalSeconds: seconds, prompt };
}

/** The jobs to run: JOBS if set, none if TICK_INTERVAL_SECONDS is 0, else the agent's own. */
export function resolveJobs(
  own: Record<string, AgentJob> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): JobSpec[] {
  const raw = env.JOBS?.trim();
  if (raw) {
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [name = "", seconds = ""] = entry.split(":").map((part) => part.trim());
        return spec(name, Number(seconds), own?.[name]?.prompt, "JOBS");
      });
  }
  if (env.TICK_INTERVAL_SECONDS?.trim() === "0") return [];
  return Object.entries(own ?? DEFAULT_JOBS).map(([name, job]) => spec(name, Number(job?.interval), job?.prompt, "jobs"));
}

/**
 * One agent run at a time, across every job in this process.
 *
 * Jobs keep separate schedules but share one key, and two runs signing from it
 * at once produce a nonce error that loses both transactions. Rather than
 * coordinating schedules so they never coincide — which they eventually would
 * anyway — a run waits for whatever is already going.
 */
let lock: Promise<void> = Promise.resolve();

export function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = lock.then(work, work);
  lock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Resolves once every run started or queued through `exclusive` so far has finished. */
export function whenRunsIdle(): Promise<void> {
  return lock;
}

/** Runs one job on its interval until stopped. `run` does one round of it. */
function startJob(job: JobSpec, run: (job: JobSpec) => Promise<string>): Jobs {
  let running = true;
  let inFlight: Promise<unknown> = Promise.resolve();

  async function once(): Promise<void> {
    try {
      const answer = await exclusive(() => run(job));
      log(job.name, answer || "(no response)");
    } catch (error) {
      // A failed run costs one round, not the schedule.
      log(job.name, `failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function loop(): Promise<void> {
    log(job.name, `every ${job.intervalSeconds}s`);
    while (running) {
      inFlight = once();
      await inFlight;

      // Interruptible, so stopping does not sit out the whole interval.
      const until = Date.now() + job.intervalSeconds * 1000;
      while (running && Date.now() < until) {
        await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
      }
    }
    log(job.name, "stopped");
  }

  const finished = loop();

  return {
    stop() {
      running = false;
    },
    async whenIdle() {
      await inFlight;
      await finished;
    },
  };
}

/** Starts every job and returns a handle covering all of them. */
export function startJobs(jobs: JobSpec[], run: (job: JobSpec) => Promise<string>): Jobs {
  if (jobs.length === 0) {
    console.log("no scheduled jobs — something else owns this agent's work");
    return { stop() {}, async whenIdle() {} };
  }

  const started = jobs.map((job) => startJob(job, run));

  return {
    stop: () => started.forEach((job) => job.stop()),
    whenIdle: async () => {
      await Promise.all(started.map((job) => job.whenIdle()));
    },
  };
}
