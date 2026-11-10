import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  // packages/tools is internal and never published: compile it in.
  dts: { resolve: ["@kudo-dev/tools"] },
  noExternal: ["@kudo-dev/tools"],
  clean: true,
  sourcemap: true,
  target: "node18",
  external: ["@elizaos/core"],
});
