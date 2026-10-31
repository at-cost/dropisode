import { defineConfig } from "vitest/config";

/** The browser journey test (pnpm e2e). Separate from the unit tests because it needs the built studio UI. */
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    globalSetup: ["test/globalSetup.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
