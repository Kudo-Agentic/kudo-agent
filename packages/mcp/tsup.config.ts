import { defineConfig } from "tsup";

export default defineConfig([
  { entry: { index: "src/index.ts" }, format: ["esm"], dts: true, clean: true, sourcemap: true, target: "node18" },
  { entry: { bin: "src/bin.ts" }, format: ["esm"], banner: { js: "#!/usr/bin/env node" }, sourcemap: true, target: "node18" },
]);
