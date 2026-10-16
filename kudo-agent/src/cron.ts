/**
 * Scheduled jobs.
 *
 * A job is one prompt on one interval. An agent runs as many as it has work
 * of different kinds — Shinichi takes work on one tick and settles what he owes
 * on another — and each prompt stays focused on a single job rather than
 * growing branches for everything the agent might need to do.
 *
 *   JOBS   comma-separated <prompt>:<seconds>, e.g. "take-work:280,settle-due:310"
 *
 * Legacy single-job config still works:
 *
 *   SETTLE_PROMPT           prompt to run (default settle-due)
 *   TICK_INTERVAL_SECONDS   seconds between runs (default 300, 0 disables)
 */
import { loadPrompt, runAgent } from "./agent/index.ts";

const DEFAULT_PROMPT = "settle-due";
const DEFAULT_INTERVAL_SECONDS = 300;
const MIN_INTERVAL_SECONDS = 10;
const DISABLED = 0;

export interface JobSpec {
  prompt: string;
  intervalSeconds: number;
}

export interface Job {
  stop(): void;
  /** Resolves once every run in flight has finished. */
  whenIdle(): Promise<void>;
}

const log = (job: string, message: string) =>
  console.log(`${new Date().toISOString().slice(11, 19)} ${job}: ${message}`);

/**
 * One agent run at a time, across every job in this process.
 *
 * Jobs keep separate schedules but share one key, and two runs signing from it
 * at once produce a nonce error that loses both transactions. Rather than
 * coordinating schedules so they never coincide — which they eventually would
 * anyway — a run waits for whatever is already going.
 */
let lock: Promise<void> = Promise.resolve();

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = lock.then(work, work);
  lock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Parses JOBS, falling back to the single-job variables. */
export function configuredJobs(): JobSpec[] {
  const raw = process.env.JOBS?.trim();

  if (!raw) {
    const seconds = legacyInterval();
    if (seconds === DISABLED) return [];
    return [
      {
        prompt: process.env.SETTLE_PROMPT?.trim() || DEFAULT_PROMPT,
        intervalSeconds: seconds,
      },
    ];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [prompt, seconds] = entry.split(":").map((part) => part.trim());
      const parsed = Number(seconds);

      if (!prompt || !Number.isFinite(parsed) || parsed < MIN_INTERVAL_SECONDS) {
        throw new Error(
          `JOBS entry "${entry}" is not <prompt>:<seconds> with seconds >= ${MIN_INTERVAL_SECONDS}.`,
        );
      }
      return { prompt, intervalSeconds: parsed };
    });
}

function legacyInterval(): number {
  const raw = process.env.TICK_INTERVAL_SECONDS?.trim();
  if (!raw) return DEFAULT_INTERVAL_SECONDS;

  const parsed = Number(raw);
  if (parsed === DISABLED) return DISABLED;

  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_SECONDS) {
    console.error(
      `TICK_INTERVAL_SECONDS="${raw}" is not a number of at least ` +
        `${MIN_INTERVAL_SECONDS}; using ${DEFAULT_INTERVAL_SECONDS}s.`,
    );
    return DEFAULT_INTERVAL_SECONDS;
  }
  return parsed;
}

/** Runs one prompt on one interval until stopped. */
function startJob(spec: JobSpec): Job {
  let running = true;
  let inFlight: Promise<unknown> = Promise.resolve();

  async function once(): Promise<void> {
    try {
      const prompt = await loadPrompt(spec.prompt);
      const answer = await exclusive(() => runAgent(prompt));
      log(spec.prompt, answer || "(no response)");
    } catch (error) {
      // A failed run costs one round, not the schedule.
      log(spec.prompt, `failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function loop(): Promise<void> {
    log(spec.prompt, `every ${spec.intervalSeconds}s`);
    while (running) {
      inFlight = once();
      await inFlight;

      // Interruptible, so stopping does not sit out the whole interval.
      const until = Date.now() + spec.intervalSeconds * 1000;
      while (running && Date.now() < until) {
        await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
      }
    }
    log(spec.prompt, "stopped");
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

/** Starts every configured job and returns a handle covering all of them. */
export function startJobs(specs: JobSpec[] = configuredJobs()): Job {
  if (specs.length === 0) {
    console.log("no scheduled jobs — something else owns this agent's work");
    return { stop() {}, async whenIdle() {} };
  }

  const jobs = specs.map(startJob);

  return {
    stop: () => jobs.forEach((job) => job.stop()),
    whenIdle: async () => {
      await Promise.all(jobs.map((job) => job.whenIdle()));
    },
  };
}
