import { defineConfig } from "tsup";

// Bundles the workspace packages (core, studio) into one CLI; npm dependencies stay external.
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  noExternal: [/^@reel\//],
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
