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

  it("runs a job's own prompt, else the bundled one of its name", async () => {
    expect(await bundledPrompts()).toEqual(["settle-due", "take-work"]);
    expect(await loadPrompt("validate", "Judge the covenants.")).toBe("Judge the covenants.");
    expect(await loadPrompt("settle-due")).toMatch(/Settle every covenant/);
    expect(await loadPrompt("settle-due", "mine")).toBe("mine");
    const file = new URL("../prompts/take-work.txt", import.meta.url);
    expect(await loadPrompt("anything", file)).toBe((await readFile(file, "utf8")).trim());
    await expect(loadPrompt("validate")).rejects.toThrow(/Job "validate" has no prompt/);
  });
});

describe("jobs", () => {
  it("uses the agent's jobs unless JOBS or TICK_INTERVAL_SECONDS=0 overrides them", () => {
    const validate = { interval: 180, prompt: "Judge." };
    expect(resolveJobs({ validate }, {})).toEqual([{ name: "validate", intervalSeconds: 180, prompt: "Judge." }]);
    expect(resolveJobs({ "take-work": { interval: 60 } }, {})).toEqual([{ name: "take-work", intervalSeconds: 60 }]);
    expect(resolveJobs(undefined, {})).toEqual([{ name: "settle-due", intervalSeconds: 300 }]);
    // JOBS changes the schedule; a job it names keeps the prompt the agent gave it.
    expect(resolveJobs({ validate }, { JOBS: "validate:60, settle-due:90" })).toEqual([
      { name: "validate", intervalSeconds: 60, prompt: "Judge." },
      { name: "settle-due", intervalSeconds: 90 },
    ]);
    expect(resolveJobs({ validate }, { TICK_INTERVAL_SECONDS: "0" })).toEqual([]);
    expect(() => resolveJobs({ validate: { interval: 5 } }, {})).toThrow(/seconds >= 10/);
  });
});

describe("the library", () => {
  it("never loads the agent code or the Agent SDK", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/agent\//);
    expect(source).not.toMatch(/claude-agent-sdk/);
  });
});

describe("logging", () => {
  it("never writes a secret, with or without its 0x prefix", async () => {
    const { redact } = await import("../src/agent/log.js");
    const key = "0x" + "ab".repeat(32);
    const env = { PRIVATE_KEY: key, ANTHROPIC_API_KEY: "sk-ant-secret-value" };
    expect(redact(`cast wallet address --private-key ${key}`, env)).toBe("cast wallet address --private-key [PRIVATE_KEY]");
    expect(redact(`key ${key.slice(2)} and sk-ant-secret-value`, env)).toBe("key [PRIVATE_KEY] and [ANTHROPIC_API_KEY]");
    expect(redact("nothing secret here", {})).toBe("nothing secret here");
  });
});
