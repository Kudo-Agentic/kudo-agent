import { defineConfig } from "tsup";

const shared = { sourcemap: true, target: "node18" } as const;

export default defineConfig([
  { entry: { index: "src/index.ts" }, format: ["esm"], dts: true, clean: true, ...shared },
  { entry: { bin: "src/bin.ts" }, format: ["esm"], banner: { js: "#!/usr/bin/env node" }, ...shared },
]);
