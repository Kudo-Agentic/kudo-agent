/**
 * A model provider for this test project: Eliza's text models are answered
 * by the local Claude Code CLI (`claude -p`), because the network policy
 * here blocks api.openai.com and no Anthropic API key is set. Embeddings are
 * a deterministic hash: memory search quality is not under test.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelType, type Plugin } from "@elizaos/core";

const EMPTY_DIR = mkdtempSync(join(tmpdir(), "claude-model-"));
export const calls: { model: string; ms: number }[] = [];

function claude(prompt: string, model: "haiku" | "sonnet"): Promise<string> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--model", model,
        "--output-format", "text",
        "--strict-mcp-config",
        "--tools", "",
        "--system-prompt",
        "You are the language model behind an ElizaOS agent. Follow the prompt's instructions exactly and output only what it asks for, in the format it asks for.",
      ],
      { cwd: EMPTY_DIR, env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      calls.push({ model, ms: Date.now() - start });
      if (code === 0) resolve(out.trim());
      else reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
}

function embed(text: string): number[] {
  const v = new Array(384).fill(0);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % 384] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const asObject = async (prompt: string, model: "haiku" | "sonnet") => {
  const text = await claude(`${prompt}\n\nRespond with a single JSON object only.`, model);
  const match = text.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : {};
};

export const claudeModelPlugin: Plugin = {
  name: "claude-cli-model",
  description: "Text models via the local Claude Code CLI (test harness only)",
  priority: 100,
  models: {
    [ModelType.TEXT_SMALL]: async (_rt, p: { prompt: string }) => claude(p.prompt, "haiku"),
    [ModelType.TEXT_LARGE]: async (_rt, p: { prompt: string }) => claude(p.prompt, "sonnet"),
    [ModelType.OBJECT_SMALL]: async (_rt, p: { prompt: string }) => asObject(p.prompt, "haiku"),
    [ModelType.OBJECT_LARGE]: async (_rt, p: { prompt: string }) => asObject(p.prompt, "sonnet"),
    [ModelType.TEXT_EMBEDDING]: async (_rt, p: { text?: string } | string | null) =>
      embed(typeof p === "string" ? p : (p?.text ?? "")),
  } as Plugin["models"],
};
