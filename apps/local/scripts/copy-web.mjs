// Copies the built studio UI and the prices config next to the CLI bundle.
import { cpSync, existsSync, mkdirSync } from "node:fs";
const web = new URL("../../../packages/studio/dist/web", import.meta.url);
if (!existsSync(web)) throw new Error("Build the studio UI first: pnpm --filter @reel/studio build");
cpSync(web, new URL("../dist/web", import.meta.url), { recursive: true });
mkdirSync(new URL("../config", import.meta.url), { recursive: true });
cpSync(new URL("../../../packages/core/config/prices.json", import.meta.url), new URL("../dist/config/prices.json", import.meta.url));
