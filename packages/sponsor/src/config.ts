import type { SponsorOptions } from "./handler.js";

const int = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};

/**
 * Reads the relay's settings from the environment:
 * ALCHEMY_API_KEY, ALCHEMY_POLICY_ID, SPONSOR_SECRET, RPC_URL,
 * SPONSOR_DAILY_CAP, SPONSOR_RATE_LIMIT, SPONSOR_ALLOWED_ORIGINS
 * (comma-separated). None of them is ever logged or returned.
 */
export function sponsorOptionsFromEnv(env: Record<string, string | undefined> = process.env): SponsorOptions {
  const trimmed = (name: string) => env[name]?.trim() || undefined;
  return {
    alchemyApiKey: trimmed("ALCHEMY_API_KEY"),
    policyId: trimmed("ALCHEMY_POLICY_ID"),
    secret: trimmed("SPONSOR_SECRET"),
    rpcUrl: trimmed("RPC_URL"),
    dailyCap: int(env.SPONSOR_DAILY_CAP, "SPONSOR_DAILY_CAP"),
    rateLimitPerMinute: int(env.SPONSOR_RATE_LIMIT, "SPONSOR_RATE_LIMIT"),
    allowedOrigins: trimmed("SPONSOR_ALLOWED_ORIGINS")?.split(",").map((o) => o.trim()).filter(Boolean),
  };
}
