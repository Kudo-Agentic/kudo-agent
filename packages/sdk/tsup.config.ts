import { defineConfig } from "tsup";

// `npm run build` empties dist/ first; the two builds run side by side, so
// neither cleans.
export default defineConfig([
  // The library: ESM and CommonJS, no dependency beyond viem.
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "es2022",
  },
  // @kudo-dev/sdk/agent: ESM only (it finds its bundled prompts and skills
  // through import.meta.url). The Agent SDK is an optional peer, never bundled.
  {
    entry: { "agent/index": "src/agent/index.ts" },
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "node22",
    external: ["@anthropic-ai/claude-agent-sdk"],
  },
]);
