/** Environment checks, run once at startup so failures are loud and early. */
import { availableAgents } from "./agent/prompts.ts";

const REQUIRED = [
  "AGENT",
  "ANTHROPIC_API_KEY",
  "PRIVATE_KEY",
  "RPC_URL",
  "KUDO",
  "IDENTITY_REGISTRY",
] as const;

const TWITTER = [
  "TWITTER_API_KEY",
  "TWITTER_API_SECRET_KEY",
  "TWITTER_ACCESS_TOKEN",
  "TWITTER_ACCESS_TOKEN_SECRET",
  "TWITTER_HANDLE",
] as const;

const unset = (keys: readonly string[]) =>
  keys.filter((key) => !process.env[key]?.trim());

/** Exits if the agent cannot run at all. */
export function requireEnvironment(): void {
  const missing = unset(REQUIRED);
  if (missing.length === 0) return;

  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  console.error("See .env.example");
  process.exit(1);
}

/**
 * Exits if `AGENT` does not name a directory in agents/.
 *
 * Checked at startup rather than on the first run, because every CVM runs this
 * same image and `AGENT` is the only thing that decides which agent it is. A
 * typo there would otherwise surface as a prompt-loading failure mid-covenant,
 * by which point it has already taken a slot in the schedule.
 */
export async function requireKnownAgent(): Promise<void> {
  const slug = process.env.AGENT!.trim().toLowerCase();
  const known = await availableAgents();

  if (known.includes(slug)) {
    console.log(`running as ${slug}`);
    return;
  }

  console.error(`AGENT="${slug}" has no directory in agents/.`);
  console.error(`Available: ${known.join(", ")}`);
  process.exit(1);
}

/**
 * An agent that has never registered has no `AGENT_ID` yet — it gets one by
 * calling the registry. So this warns rather than exiting: without an id the
 * agent cannot mint, but registering is the one thing it still can do.
 */
export function warnIfUnregistered(): void {
  if (process.env.AGENT_ID?.trim()) return;

  console.error(
    "Warning: AGENT_ID is unset — this agent has no ERC-8004 identity. " +
      "Ask it to register, then record the id in .env.",
  );
}

/**
 * Warns about a half-configured X account rather than exiting: most prompts
 * never tweet. All five or none — with some set, requests go out unsigned and
 * X answers 403 "Authenticating with Unknown", which reads like a permissions
 * problem and is not.
 */
export function warnIfTwitterIncomplete(): void {
  const missing = unset(TWITTER);
  if (missing.length === 0 || missing.length === TWITTER.length) return;

  console.error(
    `Warning: X credentials are partially set (missing ${missing.join(", ")}). ` +
      "Posting will fail with 403 Unsupported Authentication.",
  );
}
