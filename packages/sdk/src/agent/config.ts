/** Environment checks, run once at startup so failures are loud and early. */

const REQUIRED = [
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
  console.error("See .env.example in @kudo-dev/sdk.");
  process.exit(1);
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
