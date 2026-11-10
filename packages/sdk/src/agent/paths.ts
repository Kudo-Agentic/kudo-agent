/**
 * Where the SDK package's own files are: the bundled task prompts and skills.
 *
 * The code runs from src/ in the workspace and from dist/ once published, so
 * walk up to the package's own package.json rather than assume a depth.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findPackageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (name === "@kudo-dev/sdk") return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Cannot find the @kudo-dev/sdk package directory.");
    dir = parent;
  }
}

export const PACKAGE_DIR = findPackageDir();
/** common.md and the task prompts every agent can run. */
export const PROMPTS_DIR = join(PACKAGE_DIR, "prompts");
/** The skills this package ships, one folder each. */
export const SKILLS_DIR = join(PACKAGE_DIR, "skills");
