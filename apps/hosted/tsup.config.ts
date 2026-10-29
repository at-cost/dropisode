import { defineConfig } from "tsup";

// One self-contained bundle: the runtime image ships no node_modules. ffmpeg comes from the
// image (apk), so ffmpeg-static stays out; pg-native is an optional pg add-on we don't use.
export default defineConfig({
  entry: { index: "src/index.ts", backup: "src/cli/backup.ts", migrate: "src/cli/migrate.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  noExternal: [/.*/],
  external: ["pg-native", "ffmpeg-static"],
  // The bundle finds the prices config next to itself.
  onSuccess: "mkdir -p dist/config && cp ../../packages/core/config/prices.json dist/config/prices.json",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
