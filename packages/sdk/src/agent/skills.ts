/**
 * The skills an agent is given.
 *
 * Every agent gets `kudo` (the public skill: every contract call),
 * `kudo-runtime` (this runtime's environment, USDG payments, tweet legs) and
 * `twitter`. An agent adds more by name — a skill this package ships, such as
 * `kudo-validation` or `chain-forensics` — or by path, for a skill folder of
 * its own.
 *
 * The Agent SDK loads skills from a plugin directory. Rather than hand it every
 * skill this package ships and filter afterwards, the runtime assembles a
 * plugin holding exactly this agent's skills, so a skill it was not given is
 * never loaded at all: `kudo-validation` describes closing covenants, which
 * only the evaluator can do, and handing it to a trader would describe a power
 * it does not have.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SKILLS_DIR } from "./paths.js";

export const DEFAULT_SKILLS = ["kudo", "kudo-runtime", "twitter"];

/** Plugin name; the SDK lists its skills as `kudo:<skill>`. */
const PLUGIN_NAME = "kudo";

/** A bundled skill's name, or a path (or file: URL) to a skill folder with a SKILL.md. */
export type SkillRef = string | URL;

/** Skills this package ships. */
export async function bundledSkills(): Promise<string[]> {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name).sort();
}

function resolveSkill(ref: SkillRef): { name: string; dir: string } {
  const isPath = ref instanceof URL || isAbsolute(ref) || ref.startsWith(".");
  const dir = ref instanceof URL ? fileURLToPath(ref) : isPath ? resolve(ref) : join(SKILLS_DIR, ref);
  if (!existsSync(join(dir, "SKILL.md"))) {
    throw new Error(
      isPath
        ? `Skill folder ${dir} has no SKILL.md.`
        : `No bundled skill "${ref}". Bundled: see ${SKILLS_DIR}, or pass a path to your own skill folder.`,
    );
  }
  return { name: basename(dir), dir };
}

export interface SkillPlugin {
  /** The plugin directory to pass to the Agent SDK. */
  path: string;
  /** The skills' names as the SDK lists them, `kudo:<skill>`. */
  names: string[];
}

/** Builds the plugin holding the defaults plus `extra`, in a fresh temp directory. */
export async function assembleSkills(extra: SkillRef[] = []): Promise<SkillPlugin> {
  const skills = new Map<string, string>();
  for (const ref of [...DEFAULT_SKILLS, ...extra]) {
    const { name, dir } = resolveSkill(ref);
    const existing = skills.get(name);
    if (existing && existing !== dir) throw new Error(`Two skills are named "${name}": ${existing} and ${dir}.`);
    skills.set(name, dir);
  }

  const root = await mkdtemp(join(tmpdir(), "kudo-agent-skills-"));
  await mkdir(join(root, ".claude-plugin"));
  await writeFile(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: PLUGIN_NAME, description: "Kudo agent skills", version: "0.0.0" }),
  );
  await mkdir(join(root, "skills"));
  for (const [name, dir] of skills) await symlink(dir, join(root, "skills", name), "dir");

  return { path: root, names: [...skills.keys()].map((name) => `${PLUGIN_NAME}:${name}`) };
}
