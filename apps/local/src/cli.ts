#!/usr/bin/env node
/**
 * npx reel-studio [--dir <projects folder>] [--port 4320] [--no-open] [--mock]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { FFMPEG_MISSING, findFfmpeg } from "@reel/core";
import { defaultConfigPath } from "./config";
import { createLocalApp } from "./server";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Reel studio (local)

  npx reel-studio [options]

  --dir <path>   where projects are kept (default ~/Reel)
  --port <n>     port on 127.0.0.1 (default 4320)
  --no-open      don't open the browser
  --mock         no fal.ai key, no cost: placeholder clips, for trying the workflow
  --config <f>   config file (default below; --mock uses one inside the projects folder)

Your fal.ai key is saved in ${defaultConfigPath()} (only you can read it).`);
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const webCandidates = [join(here, "web"), resolve(here, "../../../packages/studio/dist/web")];
const webDir = webCandidates.find((d) => existsSync(join(d, "index.html")));
const port = Number(flag("port") ?? process.env.PORT ?? 4320);
const projectsDir = resolve(flag("dir") ?? process.env.REEL_DIR ?? join(homedir(), "Reel"));

const ff = findFfmpeg();
if (!ff) console.warn(`\n  ${FFMPEG_MISSING}\n  You can still write, storyboard and generate; assembling an episode needs ffmpeg.\n`);
else if (!ff.subtitles) console.warn("  Your ffmpeg can't burn in subtitles (no libass); episodes will come with a separate .srt file.");

const mock = args.includes("--mock");
const configPath = resolve(flag("config") ?? (mock ? join(projectsDir, ".reel-mock-config.json") : defaultConfigPath()));
const local = createLocalApp({ projectsDir, configPath, webDir, provider: mock ? "mock" : "fal", port });
serve({ fetch: local.app.fetch, hostname: "127.0.0.1", port }, () => {
  const url = `http://localhost:${port}`;
  console.log(
    `\n  Reel is running at ${url}\n  Projects: ${projectsDir}${args.includes("--mock") ? "\n  Mock mode: placeholder clips, nothing is spent." : ""}\n  Stop with Ctrl+C.\n`,
  );
  if (!args.includes("--no-open")) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(cmd, cmdArgs, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  }
});
