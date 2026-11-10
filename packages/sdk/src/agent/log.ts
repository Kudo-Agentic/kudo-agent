/**
 * Logging for agent runs, written so a failed run can be diagnosed from the
 * log alone: which job or message started it, every command the agent ran,
 * the output of any that failed, and how the run ended.
 *
 *   LOG_LEVEL=info    (default) runs, commands, skills, failures, outcomes
 *   LOG_LEVEL=debug   also every command's output and what the agent said
 *
 * Every line passes through `redact`, because a failed `cast` call repeats
 * its whole command line, `--private-key` included.
 */
import { randomBytes } from "node:crypto";

/** Environment variables whose values must never reach a log. */
const SECRETS = [
  "PRIVATE_KEY",
  "ANTHROPIC_API_KEY",
  "TWITTER_API_KEY",
  "TWITTER_API_SECRET_KEY",
  "TWITTER_ACCESS_TOKEN",
  "TWITTER_ACCESS_TOKEN_SECRET",
] as const;

/** Output kept per command; enough for an error message, not a whole receipt. */
const MAX_OUTPUT = 1500;
const MAX_COMMAND = 400;

export const debugEnabled = (env: NodeJS.ProcessEnv = process.env) => env.LOG_LEVEL?.trim().toLowerCase() === "debug";

/** Replaces every secret's value (with or without a 0x prefix) by its name. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const name of SECRETS) {
    const value = env[name]?.trim();
    if (!value || value.length < 8) continue;
    const forms = new Set([value, value.replace(/^0x/i, "")]);
    for (const form of forms) if (form.length >= 8) out = out.split(form).join(`[${name}]`);
  }
  return out;
}

export function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}… (${flat.length - max} more chars)`;
}

const time = () => new Date().toISOString().slice(11, 19);

export interface RunLog {
  info(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** A logger for one run: every line carries the time, the run's id and what started it. */
export function runLog(label: string): RunLog {
  const tag = `[${label} ${randomBytes(3).toString("hex")}]`;
  const line = (message: string) => `${time()} ${tag} ${redact(message)}`;
  return {
    info: (message) => console.log(line(message)),
    error: (message) => console.error(line(message)),
    debug: (message) => {
      if (debugEnabled()) console.log(line(message));
    },
  };
}

export const limits = { MAX_OUTPUT, MAX_COMMAND };
