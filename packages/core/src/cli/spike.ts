/**
 * Phase 1 spike: idea → script → cast → 6-shot, 30-second episode → MP4, with
 * a cost log you can check against fal's dashboard (request ids included).
 *
 *   FAL_KEY=... pnpm spike "A courier finds a letter addressed to herself" --tier draft
 *   pnpm spike "..." --provider mock          (no key, no cost)
 *
 * Options: --tier draft|final (default draft), --out <dir> (default ./projects),
 * --yes (skip the price confirmation).
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { assembleEpisode } from "../assemble";
import { Catalog } from "../catalog";
import { createProject, updateShot } from "../edit";
import { FolderStore } from "../folderStore";
import { FalProvider } from "../providers/fal";
import { MockProvider } from "../providers/mock";
import type { Provider } from "../providers/types";
import { Studio } from "../studio";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const idea =
  args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ??
  "A courier finds a letter addressed to herself, dated tomorrow.";
const tier = (flag("tier", "draft") as "draft" | "final") ?? "draft";
const providerName = flag("provider", process.env.FAL_KEY ? "fal" : "mock")!;
const outRoot = resolve(flag("out", "projects")!);
const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(4)}`;

async function main() {
  const catalog = Catalog.load();
  let provider: Provider;
  if (providerName === "fal") {
    if (!process.env.FAL_KEY) throw new Error("Set FAL_KEY to your fal.ai key, or use --provider mock");
    provider = new FalProvider({ key: process.env.FAL_KEY, catalog });
  } else {
    provider = new MockProvider();
  }
  const store = new FolderStore(outRoot);
  const studio = new Studio({ projects: store, media: store, jobs: store.jobs, provider, catalog });
  const d = catalog.defaultsFor(tier);
  const image = catalog.get(d.image);
  const video = catalog.get(d.video);

  // Price first: an upper bound before anything is spent.
  const llm =
    studio.estimateScript(idea, 30).providerCostMicro +
    studio.llmEstimate({ system: "", prompt: "x".repeat(6000), maxTokens: 3000 }).providerCostMicro;
  const cast = studio.estimateCastImage().providerCostMicro * 4;
  console.log(`Provider: ${provider.id}. Tier: ${tier} (${image.label} + ${video.label}).`);
  console.log(`Estimate: script ${usd(llm)}, up to 4 cast images ${usd(cast)}, 6 shots priced after the storyboard.`);
  if (provider.id !== "mock" && !args.includes("--yes")) await confirm("Continue?");

  const project = createProject({ name: idea.slice(0, 60), idea });
  store.create(project);
  console.log(`Project folder: ${store.dir(project.id)}`);

  console.log("Writing the script...");
  const episodeId = await studio.writeScript(project.id, { idea, targetSeconds: 30 });
  let p = await store.get(project.id);
  const scene = p.episodes[0]!.scenes[0]!;
  console.log(`Script: "${p.episodes[0]!.title}", ${p.episodes[0]!.scenes.length} scene(s), cast: ${p.cast.map((c) => c.name).join(", ")}`);

  console.log("Storyboarding...");
  await studio.storyboard(project.id, scene.id, { targetSeconds: 30 });
  // The spike is exactly 6 shots: keep the first 6, one scene.
  await store.mutate(project.id, (proj) => {
    const ep = proj.episodes[0]!;
    ep.scenes = [ep.scenes.find((s) => s.id === scene.id)!];
    ep.scenes[0]!.shots = ep.scenes[0]!.shots.slice(0, 6);
    for (const s of ep.scenes[0]!.shots) updateShot(proj, s.id, { durationS: 5, approved: true });
  });
  p = await store.get(project.id);
  const shots = p.episodes[0]!.scenes[0]!.shots;
  const shotTotal = shots.reduce((a, s) => a + studio.estimateTake(p, s.id, tier).providerCostMicro, 0);
  console.log(
    `${shots.length} shots. Cast images ${usd(studio.estimateCastImage().providerCostMicro * p.cast.length)}, shots ${usd(shotTotal)}.`,
  );
  if (provider.id !== "mock" && !args.includes("--yes")) await confirm("Generate?");

  console.log("Cast reference images...");
  for (const c of p.cast) await studio.generateCastImage(project.id, c.id);
  await settle(studio, project.id);

  console.log("Shots (first frame, then image-to-video)...");
  for (const s of shots) await studio.generateTake(project.id, s.id, tier);
  await settle(studio, project.id);

  const outDir = join(store.dir(project.id), "exports", `spike-${Date.now()}`);
  const res = await assembleEpisode({ projects: store, media: store }, project.id, episodeId, {
    source: tier === "final" ? "final" : "rough",
    outDir,
  });
  p = await store.get(project.id);

  console.log("\nCost log (provider cost, no markup):");
  const jobs = new Map((await Promise.all(p.costLog.map((l) => store.jobs.get(l.jobId)))).filter(Boolean).map((j) => [j!.id, j!]));
  const rows = p.costLog.map((l) => [
    l.at,
    l.purpose,
    l.model,
    catalog.get(l.model).endpoint,
    jobs.get(l.jobId)?.requestId ?? "",
    l.units,
    l.unit,
    usd(l.providerCostMicro),
    l.status,
    l.note,
  ]);
  for (const r of rows)
    console.log(
      `  ${String(r[1]).padEnd(12)} ${String(r[2]).padEnd(22)} ${String(r[5]).padStart(6)} ${String(r[6]).padEnd(8)} ${String(r[7]).padStart(10)}  ${r[8]}`,
    );
  const total = p.costLog.reduce((a, l) => a + l.providerCostMicro, 0);
  console.log(`  Total: ${usd(total)} (${p.costLog.length} requests)`);
  const csv = [["at", "purpose", "model", "endpoint", "fal_request_id", "units", "unit", "cost_usd", "status", "note"], ...rows]
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  writeFileSync(join(outDir, "cost-log.csv"), csv);
  console.log(
    `\nEpisode: ${res.episodeFile} (${res.durationS.toFixed(1)} s${res.skipped.length ? `, ${res.skipped.length} shots skipped` : ""})`,
  );
  console.log(`Cost log: ${join(outDir, "cost-log.csv")}`);
  for (const w of res.warnings) console.log(`Note: ${w}`);
}

async function settle(studio: Studio, projectId: string) {
  for (;;) {
    const open = await studio.runner.deps.jobs.listUnfinished(projectId);
    if (open.length === 0) return;
    await studio.tick(projectId);
    await new Promise((r) => setTimeout(r, studio.runner.deps.provider.id === "mock" ? 0 : 3000));
  }
}

async function confirm(q: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${q} [y/N] `);
  rl.close();
  if (!/^y/i.test(a)) process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
