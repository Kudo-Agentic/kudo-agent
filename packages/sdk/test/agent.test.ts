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

  it("refuses a prompt path that names no file rather than using the path as text", async () => {
    await expect(loadSystemPrompt("./sytem.md")).rejects.toThrow(/does not exist/);
    await expect(loadPrompt("validate", "validte.txt")).rejects.toThrow(/does not exist/);
    expect(await loadPrompt("validate", "Judge.")).toBe("Judge.");
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

describe("AGENT_ID", () => {
  it("is set from the id a new agent wrote after registering", async () => {
    const { prepareAgentIdFile, syncAgentId } = await import("../src/agent/agent-id.js");
    const env: NodeJS.ProcessEnv = {};
    const file = await prepareAgentIdFile(env);
    expect(env.KUDO_AGENT_ID_FILE).toBe(file);

    expect(await syncAgentId(env)).toBeUndefined(); // not registered yet
    expect(env.AGENT_ID).toBeUndefined();

    await writeFile(file, "23346\n");
    expect(await syncAgentId(env)).toBe("23346");
    expect(env.AGENT_ID).toBe("23346");
    expect(await syncAgentId(env)).toBeUndefined(); // unchanged, nothing to report

    await writeFile(file, "not an id");
    expect(await syncAgentId(env)).toBeUndefined();
    expect(env.AGENT_ID).toBe("23346");
  });

  it("is found from the wallet's Registered events, newest first, skipping ids it no longer owns", async () => {
    const { findRegisteredAgentId } = await import("../src/client.js");
    const me = "0x8AF5d198744Ba668689ea90946796a088e00DA33";
    const other = "0x4902Dbca318a6d5B09f2383003C79aC41ED62CEd";
    const owners: Record<string, string> = { "7": me, "9": other };
    const windows: Array<[bigint, bigint]> = [];
    const client = {
      readContract: async ({ functionName, args }: { functionName: string; args: [unknown] }) =>
        functionName === "balanceOf" ? 1n : owners[String(args[0])],
      getBlockNumber: async () => 25n,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        windows.push([fromBlock, toBlock]);
        // id 7 registered in block 3, id 9 (since transferred away) in block 4.
        return fromBlock <= 3n ? [{ args: { agentId: 7n } }, { args: { agentId: 9n } }] : [];
      },
    };
    expect(await findRegisteredAgentId(client as never, me, me, 10n)).toBe(7n);
    expect(windows).toEqual([[16n, 25n], [6n, 15n], [0n, 5n]]);

    const none = { ...client, readContract: async () => 0n };
    expect(await findRegisteredAgentId(none as never, me, me, 10n)).toBeUndefined();
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
