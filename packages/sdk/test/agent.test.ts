import { mkdtemp, readFile, readdir, readlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { bundledPrompts, loadPrompt, loadSystemPrompt } from "../src/agent/prompts.js";
import { resolveJobs } from "../src/agent/jobs.js";
import { assembleSkills, bundledSkills, DEFAULT_SKILLS } from "../src/agent/skills.js";

describe("skills", () => {
  it("ships the public kudo skill and every agent skill", async () => {
    expect(await bundledSkills()).toEqual(["chain-forensics", "kudo", "kudo-runtime", "kudo-validation", "twitter"]);
  });

  it("gives every agent the defaults, plus exactly the extras it asks for", async () => {
    const plain = await assembleSkills();
    expect(plain.names).toEqual(DEFAULT_SKILLS.map((s) => `kudo:${s}`));
    expect((await readdir(join(plain.path, "skills"))).sort()).toEqual([...DEFAULT_SKILLS].sort());

    const evaluator = await assembleSkills(["kudo-validation"]);
    expect(evaluator.names).toContain("kudo:kudo-validation");
    expect(plain.names).not.toContain("kudo:kudo-validation");
    const manifest = JSON.parse(await readFile(join(evaluator.path, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("kudo");
  });

  it("takes a skill folder of the agent's own by path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "own-skill-"));
    const own = join(dir, "my-skill");
    await mkdir(own);
    await writeFile(join(own, "SKILL.md"), "---\nname: my-skill\ndescription: test\n---\n");
    const plugin = await assembleSkills([own]);
    expect(plugin.names).toContain("kudo:my-skill");
    expect(await readlink(join(plugin.path, "skills", "my-skill"))).toBe(own);
  });

  it("refuses an unknown skill before anything starts", async () => {
    await expect(assembleSkills(["no-such-skill"])).rejects.toThrow(/No bundled skill "no-such-skill"/);
  });
});

describe("prompts", () => {
  it("puts common.md first and the agent's own system prompt last", async () => {
    const prompt = await loadSystemPrompt("# You are Test\n\nA test agent.");
    expect(prompt.startsWith("# Working on Kudo")).toBe(true);
    expect(prompt.endsWith("A test agent.")).toBe(true);
  });

  it("reads a system prompt from a file URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persona-"));
    await writeFile(join(dir, "system.md"), "# You are Filed");
    expect(await loadSystemPrompt(new URL(`file://${join(dir, "system.md")}`))).toMatch(/# You are Filed$/);
  });

  it("looks up the agent's own prompts first, then the bundled ones", async () => {
    expect(await bundledPrompts()).toEqual(["settle-due", "take-work"]);
    expect(await loadPrompt("validate", { validate: "Judge the covenants." })).toBe("Judge the covenants.");
    expect(await loadPrompt("settle-due")).toMatch(/Settle every covenant/);
    expect(await loadPrompt("settle-due", { "settle-due": "mine" })).toBe("mine");
    await expect(loadPrompt("validate")).rejects.toThrow(/No prompt "validate"/);
  });
});

describe("jobs", () => {
  it("uses the agent's jobs unless JOBS or TICK_INTERVAL_SECONDS=0 overrides them", () => {
    expect(resolveJobs({ validate: 180 }, {})).toEqual([{ prompt: "validate", intervalSeconds: 180 }]);
    expect(resolveJobs(undefined, {})).toEqual([{ prompt: "settle-due", intervalSeconds: 300 }]);
    expect(resolveJobs({ validate: 180 }, { JOBS: "take-work:60, settle-due:90" })).toEqual([
      { prompt: "take-work", intervalSeconds: 60 },
      { prompt: "settle-due", intervalSeconds: 90 },
    ]);
    expect(resolveJobs({ validate: 180 }, { TICK_INTERVAL_SECONDS: "0" })).toEqual([]);
    expect(() => resolveJobs({ validate: 5 }, {})).toThrow(/seconds >= 10/);
  });
});

describe("the library", () => {
  it("never loads the agent code or the Agent SDK", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/agent\//);
    expect(source).not.toMatch(/claude-agent-sdk/);
  });
});
