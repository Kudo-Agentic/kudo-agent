import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts", tools: "src/tools.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "es2022",
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    target: "node18",
    sourcemap: true,
  },
]);
