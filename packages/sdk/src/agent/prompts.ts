/**
 * Prompts live on disk as plain text, so an operational instruction is a file
 * in version control rather than a string buried in code.
 *
 * The system prompt is assembled from two parts:
 *
 *   prompts/common.md     (this package) what every Kudo agent is told - the
 *                         covenant model, the honesty rules, how to work at
 *                         the shell
 *   the agent's own       who this one is, and nothing else - passed to
 *   system prompt         startAgent as `systemPrompt`
 *
 * A job's task prompt is the one the agent gave that job, else this package's
 * prompt of the same name (take-work, settle-due). A prompt that only one agent
 * should run is given only by that agent, so another agent configured to run
 * it fails at startup rather than attempting something it has no business
 * doing — `validate` belongs to the validator, who alone holds the evaluator
 * role.
 */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PROMPTS_DIR } from "./paths.js";

const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/i;

/** Text, or a path / file: URL to read it from. */
export type TextSource = string | URL;

async function read(source: TextSource): Promise<string> {
  if (source instanceof URL) return readFile(fileURLToPath(source), "utf8");
  // A one-line string naming an existing file is a path; anything else is the text itself.
  if (!source.includes("\n") && existsSync(source)) return readFile(source, "utf8");
  return source;
}

/**
 * The agent's standing instructions: the shared base, then its character.
 *
 * Order matters. The character comes last so that where the two touch - voice,
 * register, what it will and will not claim - the specific one is what the
 * model read most recently.
 */
export async function loadSystemPrompt(character: TextSource): Promise<string> {
  const common = await readFile(join(PROMPTS_DIR, "common.md"), "utf8");
  return `${common.trim()}\n\n---\n\n${(await read(character)).trim()}`;
}

/** Task prompts this package ships. */
export async function bundledPrompts(): Promise<string[]> {
  return (await readdir(PROMPTS_DIR))
    .filter((f) => f.endsWith(".txt"))
    .map((f) => f.replace(/\.txt$/, ""))
    .sort();
}

/** A job's task prompt: its own if it has one, else this package's prompt of that name. */
export async function loadPrompt(name: string, own?: TextSource): Promise<string> {
  if (own !== undefined) return (await read(own)).trim();
  if (!SAFE_NAME.test(name)) {
    throw new Error(`Invalid prompt name "${name}" — use letters, digits and dashes.`);
  }
  try {
    return (await readFile(join(PROMPTS_DIR, `${name}.txt`), "utf8")).trim();
  } catch {
    throw new Error(
      `Job "${name}" has no prompt and none is bundled under that name. Give it a \`prompt\`, or use one of: ${(await bundledPrompts()).join(", ")}.`,
    );
  }
}
