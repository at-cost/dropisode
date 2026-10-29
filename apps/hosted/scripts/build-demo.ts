/**
 * Builds the public demo project into apps/hosted/demo/ with the mock provider:
 * placeholder clips made locally by ffmpeg, nothing spent. The cost log is
 * priced at the catalog's real fal list prices, so the totals are what the same
 * project would cost on fal.
 *
 *   cd apps/hosted && npx tsx scripts/build-demo.ts
 *
 * After the first paid test run, replace demo/ with the real project instead
 * (project.json, media/, exports/) and set "placeholder": false in demo/demo.json.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Catalog, FolderStore, MockProvider, Studio, assembleEpisode, createProject, runFfmpeg, updateShot } from "@reel/core";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../demo");
const IDEA = "A courier finds a letter addressed to herself, dated tomorrow.";

async function settle(studio: Studio, projectId: string) {
  for (let i = 0; i < 500; i++) {
    const open = await studio.runner.deps.jobs.listUnfinished(projectId);
    if (open.length === 0) return;
    await studio.tick(projectId);
  }
  throw new Error("Jobs did not settle");
}

/** Smaller copy of a clip for the web: the demo folder should stay a few MB. */
async function shrink(src: string, dst: string) {
  await runFfmpeg([
    "-y",
    "-i",
    src,
    "-vf",
    "scale=360:640",
    "-c:v",
    "libx264",
    "-preset",
    "veryslow",
    "-crf",
    "34",
    "-c:a",
    "aac",
    "-b:a",
    "48k",
    "-movflags",
    "+faststart",
    dst,
  ]);
}

function folderBytes(dir: string): number {
  let n = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const s = statSync(p);
    n += s.isDirectory() ? folderBytes(p) : s.size;
  }
  return n;
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), "reel-demo-"));
  const catalog = Catalog.load();
  const store = new FolderStore(work);
  const studio = new Studio({ projects: store, media: store, jobs: store.jobs, provider: new MockProvider(), catalog });

  const project = createProject({ id: "demo", name: "The Letter", idea: IDEA, aspect: "9:16" });
  store.create(project);
  const episodeId = await studio.writeScript(project.id, { idea: IDEA, targetSeconds: 30, episodeTitle: "Episode 1: The Letter" });
  let p = await store.get(project.id);
  const scene = p.episodes[0]!.scenes[0]!;

  for (const c of p.cast) await studio.generateCastImage(project.id, c.id);
  await settle(studio, project.id);

  await studio.storyboard(project.id, scene.id, { targetSeconds: 30 });
  await store.mutate(project.id, (proj) => {
    const ep = proj.episodes[0]!;
    ep.scenes = [ep.scenes.find((s) => s.id === scene.id)!];
    ep.scenes[0]!.shots = ep.scenes[0]!.shots.slice(0, 6);
    for (const s of ep.scenes[0]!.shots) updateShot(proj, s.id, { durationS: 5 });
  });
  p = await store.get(project.id);
  const shots = p.episodes[0]!.scenes[0]!.shots;

  // Drafts: one each, a second try on two shots (a creator rarely keeps every first draft).
  for (const s of shots) await studio.generateTake(project.id, s.id, "draft");
  await settle(studio, project.id);
  for (const s of [shots[1]!, shots[5]!]) await studio.generateTake(project.id, s.id, "draft");
  await settle(studio, project.id);

  // Approve every shot, then one final each.
  await store.mutate(project.id, (proj) => {
    for (const s of shots) updateShot(proj, s.id, { approved: true });
  });
  for (const s of shots) await studio.generateTake(project.id, s.id, "final");
  await settle(studio, project.id);

  const exportDir = join(work, "export");
  const res = await assembleEpisode({ projects: store, media: store }, project.id, episodeId, { source: "final", outDir: exportDir });
  if (res.skipped.length) throw new Error(`Shots skipped: ${JSON.stringify(res.skipped)}`);

  // Copy into apps/hosted/demo: project.json, media (videos shrunk), the episode and its edit files.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "media"), { recursive: true });
  mkdirSync(join(OUT, "exports"), { recursive: true });
  const dir = store.dir(project.id);
  p = await store.get(project.id);
  for (const m of p.media) {
    const src = join(dir, m.path);
    const dst = join(OUT, m.path);
    if (m.contentType === "video/mp4") await shrink(src, dst);
    else copyFileSync(src, dst);
    m.bytes = statSync(dst).size;
  }
  writeFileSync(join(OUT, "project.json"), JSON.stringify(p, null, 2));
  await shrink(res.episodeFile, join(OUT, "exports", "episode.mp4"));
  for (const f of ["subtitles.srt", "edit-list.edl", "edit-list.json"])
    if (existsSync(join(exportDir, f))) cpSync(join(exportDir, f), join(OUT, "exports", f));
  writeFileSync(
    join(OUT, "demo.json"),
    JSON.stringify(
      {
        _readme:
          "Read by the /demo page. placeholder: true while the clips come from the mock provider; set false when this folder holds the real paid test run.",
        placeholder: true,
        builtAt: new Date().toISOString(),
        episodeId,
        episodeDurationS: Math.round(res.durationS * 10) / 10,
        subtitlesBurned: res.subtitlesBurned,
      },
      null,
      2,
    ),
  );
  rmSync(work, { recursive: true, force: true });
  console.log(
    `Demo written to ${OUT}: ${(folderBytes(OUT) / 1024 / 1024).toFixed(2)} MB, ${p.costLog.length} cost lines, ${res.durationS.toFixed(1)} s episode.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
