/**
 * Makes a real studio project the public demo: copies it into apps/hosted/demo/ with each shot's chosen take,
 * the cast pictures and the finished episode, small enough for the repo. The cost log is kept whole, failed and
 * discarded tries included: it is what the project really cost.
 *
 *   cd apps/hosted && npx tsx scripts/demo-from-project.ts ~/Dropisode/prj_xxx 2026-11-16T02-25-18-089Z-rough
 *
 * The second argument is the export folder (in the project's exports/) whose episode.mp4 the demo plays.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type MediaRef, mediaDuration, parseProject, runFfmpeg } from "@reel/core";
import { EXPORT_FILES } from "../src/site/demo";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../demo");
const [src, exportId] = process.argv.slice(2);
if (!src || !exportId) throw new Error("Usage: demo-from-project.ts <project folder> <export folder name>");
const exportDir = join(src, "exports", exportId);
if (!existsSync(join(exportDir, "episode.mp4"))) throw new Error(`No episode.mp4 in ${exportDir}`);

const project = parseProject(JSON.parse(readFileSync(join(src, "project.json"), "utf8")));
const episode = project.episodes[0];
if (!episode) throw new Error("The project has no episode");

// The chosen take of each shot is the one the page shows.
const keep = new Set<string>();
for (const c of project.cast) for (const id of c.refImageIds.slice(0, 1)) keep.add(id);
for (const sc of episode.scenes) {
  if (sc.master?.mediaId) keep.add(sc.master.mediaId);
  for (const shot of sc.shots) {
    // Every try stays listed (the page counts them); only the chosen take's pictures and clip are copied.
    const take = shot.takes.find((t) => t.id === shot.selectedTakeId) ?? shot.takes.filter((t) => t.status === "done").at(-1);
    if (take) {
      shot.selectedTakeId = take.id;
      for (const id of [take.frameMediaId, take.videoMediaId, take.endFrameMediaId]) if (id) keep.add(id);
    }
  }
}
for (const c of project.cast) c.refImageIds = c.refImageIds.slice(0, 1);
project.episodes = [episode];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "media"), { recursive: true });
mkdirSync(join(OUT, "exports"), { recursive: true });

// Pictures become small JPEGs and clips small MP4s; the file name keeps its id so the project still points at it.
const media: MediaRef[] = [];
for (const m of project.media) {
  if (!keep.has(m.id) || m.hidden) continue;
  const from = join(src, m.path);
  if (!existsSync(from)) continue;
  const stem = m.path.slice("media/".length).replace(/\.[^.]+$/, "");
  if (m.contentType.startsWith("image/")) {
    const path = `media/${stem}.jpg`;
    await runFfmpeg(["-i", from, "-vf", "scale='min(720,iw)':-2", "-q:v", "5", join(OUT, path)]);
    media.push({ ...m, path, contentType: "image/jpeg" });
  } else if (m.contentType.startsWith("video/")) {
    const path = `media/${stem}.mp4`;
    await runFfmpeg(["-i", from, "-vf", "scale=360:-2", "-c:v", "libx264", "-preset", "veryslow", "-crf", "32", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", join(OUT, path)]);
    media.push({ ...m, path, contentType: "video/mp4" });
  }
}
project.media = media;
writeFileSync(join(OUT, "project.json"), JSON.stringify(project, null, 2));

// The finished episode at full size, compressed for the web.
await runFfmpeg(["-i", join(exportDir, "episode.mp4"), "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", join(OUT, "exports", "episode.mp4")]);
for (const f of EXPORT_FILES) if (f !== "episode.mp4" && existsSync(join(exportDir, f))) cpSync(join(exportDir, f), join(OUT, "exports", f));

writeFileSync(
  join(OUT, "demo.json"),
  `${JSON.stringify(
    {
      _readme: "Read by the /demo page. Made from a real studio project by scripts/demo-from-project.ts.",
      placeholder: false,
      builtAt: new Date().toISOString(),
      episodeId: episode.id,
      episodeDurationS: Math.round((await mediaDuration(join(OUT, "exports", "episode.mp4"))) * 10) / 10,
      subtitlesBurned: false,
    },
    null,
    2,
  )}\n`,
);
console.log(`Demo: ${project.name}, ${media.length} media files, episode from ${exportId}`);
