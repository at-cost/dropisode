import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleEpisode, toAss } from "../src/assemble";
import { addEpisode, addScene, addShot, createProject, findShot, updateShot } from "../src/edit";
import { drain, setup } from "./helpers";

async function twoShots(opts: { continues?: boolean; text?: string } = {}) {
  const t = setup();
  const project = createProject({ name: "Chain" });
  const ep = addEpisode(project, { title: "Ep" });
  const sc = addScene(ep, { heading: "EXT. CHURCHYARD - DAY" });
  const a = addShot(sc, { description: "Nora on the bench.", durationS: 5, onScreenText: opts.text ?? "" });
  const b = addShot(sc, { description: "She stands and walks off.", durationS: 5, continueFromPrevious: opts.continues ?? true });
  t.store.create(project);
  return { ...t, projectId: project.id, episodeId: ep.id, a: a.id, b: b.id };
}

const shotOf = async (t: Awaited<ReturnType<typeof twoShots>>, id: string) => findShot(await t.store.get(t.projectId), id).shot;

describe("continue from the previous shot", () => {
  it("starts from the previous clip's last frame: no image job, and the estimate has no frame cost", async () => {
    const t = await twoShots();
    await t.studio.generateTake(t.projectId, t.a, "draft");
    await drain(t.studio, t.projectId);
    const p = await t.store.get(t.projectId);
    expect(t.studio.estimateTake(p, t.b, "draft").frame.providerCostMicro).toBe(0);
    const before = t.mock.submitted.length;
    await t.studio.generateTake(t.projectId, t.b, "draft");
    await drain(t.studio, t.projectId);
    const sent = t.mock.submitted.slice(before).map((x) => x.job.purpose);
    expect(sent).toEqual(["video"]);
    const b = await shotOf(t, t.b);
    const take = b.takes[0]!;
    expect(take.status).toBe("done");
    const frame = (await t.store.get(t.projectId)).media.find((m) => m.id === take.frameMediaId)!;
    expect(frame.source).toMatch(/^chain_/);
    expect(frame.contentType).toBe("image/jpeg");
  });

  it("a continued draft started alongside the previous one waits for it, as 'draft all' does", async () => {
    const t = await twoShots();
    await t.studio.generateTake(t.projectId, t.a, "draft");
    const waiting = await t.studio.generateTake(t.projectId, t.b, "draft");
    expect(waiting.status).toBe("queued");
    await drain(t.studio, t.projectId, 40);
    const take = (await shotOf(t, t.b)).takes[0]!;
    expect(take.status).toBe("done");
    expect((await t.store.get(t.projectId)).media.find((m) => m.id === take.frameMediaId)!.source).toMatch(/^chain_/);
  });

  it("asks for a draft of the previous shot first", async () => {
    const t = await twoShots();
    await expect(t.studio.generateTake(t.projectId, t.b, "draft")).rejects.toThrow(/make a draft of that shot first/);
    expect((await shotOf(t, t.b)).takes).toHaveLength(0);
  });

  it("a continued final waits for the previous final, then starts from it", async () => {
    const t = await twoShots();
    for (const id of [t.a, t.b]) await t.studio.generateTake(t.projectId, id, "draft").then(() => drain(t.studio, t.projectId));
    await t.store.mutate(t.projectId, (p) => {
      updateShot(p, t.a, { approved: true });
      updateShot(p, t.b, { approved: true });
    });
    // Before the previous shot's final exists, the continued one can't start.
    await expect(t.studio.generateTake(t.projectId, t.b, "final")).rejects.toThrow(/make that shot's final first/);
    await t.studio.generateTake(t.projectId, t.a, "final");
    const waiting = await t.studio.generateTake(t.projectId, t.b, "final");
    expect(waiting.status).toBe("queued");
    expect((await shotOf(t, t.b)).takes.at(-1)!.waitsForShotId).toBe(t.a);
    await drain(t.studio, t.projectId, 40);
    const b = await shotOf(t, t.b);
    const final = b.takes.at(-1)!;
    expect(final.tier).toBe("final");
    expect(final.status).toBe("done");
    expect(final.waitsForShotId).toBeUndefined();
    const aFinal = (await shotOf(t, t.a)).takes.find((x) => x.tier === "final")!;
    const frame = (await t.store.get(t.projectId)).media.find((m) => m.id === final.frameMediaId)!;
    expect(frame.source).toBe(`chain_${aFinal.id}`);
  });
});

describe("on-screen text", () => {
  it("is drawn over its shot when the episode is assembled", async () => {
    const t = await twoShots({ continues: false, text: "Nora Ashby, 1992 to 2026" });
    for (const id of [t.a, t.b]) await t.studio.generateTake(t.projectId, id, "draft");
    await drain(t.studio, t.projectId);
    const outDir = join(t.root, "rough");
    const res = await assembleEpisode({ projects: t.store, media: t.store }, t.projectId, t.episodeId, { source: "rough", outDir });
    expect(res.overlaysBurned).toBe(1);
    expect(existsSync(res.episodeFile)).toBe(true);
  });

  it("writes a centred, boxed ASS event per item, with braces and newlines made safe", () => {
    const ass = toAss([{ start: 0.2, end: 4.9, text: "Line {one}\nLine two" }], 720, 1280);
    expect(ass).toMatch(/PlayResX: 720/);
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.20,0:00:04\.90,Card,,0,0,0,,\{\\fad\(250,250\)\}Line one\\NLine two/);
  });

  it("editing on-screen text keeps a shot's approval; turning on Continue clears it", async () => {
    const t = await twoShots({ continues: false });
    await t.store.mutate(t.projectId, (p) => {
      updateShot(p, t.b, { approved: true });
      updateShot(p, t.b, { onScreenText: "2 October" });
    });
    expect((await shotOf(t, t.b)).approved).toBe(true);
    await t.store.mutate(t.projectId, (p) => updateShot(p, t.b, { continueFromPrevious: true }));
    expect((await shotOf(t, t.b)).approved).toBe(false);
  });
});
