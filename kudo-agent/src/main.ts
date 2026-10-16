/**
 * Entry point: starts the HTTP endpoint and the settlement job, and stops both
 * cleanly when asked.
 *
 *   PORT                     HTTP port (default 3000)
 *   AGENT                    which agents/<slug>/ to run as
 *   JOBS                     <prompt>:<seconds>, comma separated
 *   SHUTDOWN_GRACE_SECONDS   how long a run may finish in (default 120)
 */
import {
  requireEnvironment,
  requireKnownAgent,
  warnIfTwitterIncomplete,
  warnIfUnregistered,
} from "./config.ts";
import { startJobs } from "./cron.ts";
import { startServer } from "./server/index.ts";
import { resolveTeeIdentity } from "./tee.ts";

/**
 * Must stay below the orchestrator's stop grace period, or the process is
 * SIGKILLed first and the graceful path never runs.
 */
const SHUTDOWN_GRACE_MS =
  Number(process.env.SHUTDOWN_GRACE_SECONDS?.trim() || 120) * 1000;

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

async function main(): Promise<void> {
  requireEnvironment();
  await requireKnownAgent();
  warnIfTwitterIncomplete();
  warnIfUnregistered();
  await announceTee();

  const server = startServer();
  const jobs = startJobs();

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
    jobs.stop();

    // .unref() so a pending timer cannot keep the process alive on its own.
    const deadline = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), SHUTDOWN_GRACE_MS).unref(),
    );

    void Promise.race([jobs.whenIdle(), deadline]).then((outcome) => {
      if (outcome === "timeout") console.error("run did not finish in time — exiting anyway");
      process.exit(0);
    });
  }

  process.on("SIGTERM", shutdown); // orchestrator stopping the container
  process.on("SIGINT", shutdown); // Ctrl-C
}

await main();
