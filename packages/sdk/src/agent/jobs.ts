/**
 * Scheduled jobs.
 *
 * A job is one task prompt on one interval. An agent runs as many as it has
 * work of different kinds — Shinichi takes work on one tick and settles what
 * he owes on another — and each prompt stays focused on a single job rather
 * than growing branches for everything the agent might need to do.
 *
 * The agent passes its jobs to startAgent. Two environment variables override
 * them, so a deployment can change the schedule without a new image:
 *
 *   JOBS                    comma-separated <prompt>:<seconds>, e.g. "take-work:280,settle-due:310"
 *   TICK_INTERVAL_SECONDS   0 runs no jobs at all (something else owns this agent's work)
 */
const DEFAULT_JOBS: Record<string, number> = { "settle-due": 300 };
const MIN_INTERVAL_SECONDS = 10;

export interface JobSpec {
  prompt: string;
  intervalSeconds: number;
}

export interface Jobs {
  stop(): void;
  /** Resolves once every run in flight has finished. */
  whenIdle(): Promise<void>;
}

const log = (job: string, message: string) =>
  console.log(`${new Date().toISOString().slice(11, 19)} ${job}: ${message}`);

function spec(prompt: string, seconds: number, source: string): JobSpec {
  if (!prompt || !Number.isFinite(seconds) || seconds < MIN_INTERVAL_SECONDS) {
    throw new Error(`${source}: "${prompt}:${seconds}" is not <prompt>:<seconds> with seconds >= ${MIN_INTERVAL_SECONDS}.`);
  }
  return { prompt, intervalSeconds: seconds };
}

/** The jobs to run: JOBS if set, none if TICK_INTERVAL_SECONDS is 0, else the agent's own. */
export function resolveJobs(
  own: Record<string, number> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): JobSpec[] {
  const raw = env.JOBS?.trim();
  if (raw) {
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [prompt = "", seconds = ""] = entry.split(":").map((part) => part.trim());
        return spec(prompt, Number(seconds), "JOBS");
      });
  }
  if (env.TICK_INTERVAL_SECONDS?.trim() === "0") return [];
  return Object.entries(own ?? DEFAULT_JOBS).map(([prompt, seconds]) => spec(prompt, seconds, "jobs"));
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

/** Runs one job on its interval until stopped. `run` does one round of it. */
function startJob(job: JobSpec, run: (prompt: string) => Promise<string>): Jobs {
  let running = true;
  let inFlight: Promise<unknown> = Promise.resolve();

  async function once(): Promise<void> {
    try {
      const answer = await exclusive(() => run(job.prompt));
      log(job.prompt, answer || "(no response)");
    } catch (error) {
      // A failed run costs one round, not the schedule.
      log(job.prompt, `failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function loop(): Promise<void> {
    log(job.prompt, `every ${job.intervalSeconds}s`);
    while (running) {
      inFlight = once();
      await inFlight;

      // Interruptible, so stopping does not sit out the whole interval.
      const until = Date.now() + job.intervalSeconds * 1000;
      while (running && Date.now() < until) {
        await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
      }
    }
    log(job.prompt, "stopped");
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
export function startJobs(jobs: JobSpec[], run: (prompt: string) => Promise<string>): Jobs {
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
