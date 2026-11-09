import { defineConfig } from "tsup";

// packages/tools is internal and never published: compile it in.
const shared = { noExternal: ["@kudo-dev/tools"], sourcemap: true, target: "node18" } as const;

export default defineConfig([
  { entry: { index: "src/index.ts" }, format: ["esm"], dts: { resolve: ["@kudo-dev/tools"] }, clean: true, ...shared },
  { entry: { bin: "src/bin.ts" }, format: ["esm"], banner: { js: "#!/usr/bin/env node" }, ...shared },
]);
