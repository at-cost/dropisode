// Copies the built studio UI and the prices config next to the CLI bundle.
import { cpSync, existsSync, mkdirSync } from "node:fs";
const web = new URL("../../../packages/studio/dist/web", import.meta.url);
if (!existsSync(web)) throw new Error("Build the studio UI first: pnpm --filter @reel/studio build");
cpSync(web, new URL("../dist/web", import.meta.url), { recursive: true });
mkdirSync(new URL("../config", import.meta.url), { recursive: true });
cpSync(new URL("../../../packages/core/config/prices.json", import.meta.url), new URL("../dist/config/prices.json", import.meta.url));
// The npm page shows the repository's README; the licence travels with the package.
cpSync(new URL("../../../README.md", import.meta.url), new URL("../README.md", import.meta.url));
cpSync(new URL("../../../LICENSE", import.meta.url), new URL("../LICENSE", import.meta.url));
