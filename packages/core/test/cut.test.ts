import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FPS, assembleEpisode, mixArgs, takeInS } from "../src/assemble";
import { dissolveFrames, framesTo, keptFrames, latestInS, planCut } from "../src/cut";
import { addEpisode, addScene, addShot, createProject, findEpisode, findShot, updateShot } from "../src/edit";
import { mediaDuration, requireFfmpeg } from "../src/ffmpeg";
import { analyseClip, analyseDiffs, frameAt } from "../src/motion";
import { drain, setup } from "./helpers";

/** Frames of picture in a file, counted by decoding it. */
function videoFrames(file: string): Promise<number> {
  return new Promise((resolve, reject) =>
    execFile(requireFfmpeg().path, ["-hide_banner", "-i", file, "-map", "0:v", "-f", "null", "-"], (err, _o, stderr) => {
      const all = [...String(stderr).matchAll(/frame=\s*(\d+)/g)];
      if (err || !all.length) reject(err ?? new Error("no frame count"));
      else resolve(Number(all[all.length - 1]![1]));
    }),
  );
}

async function three() {
  const t = setup();
  const project = createProject({ name: "Cut" });
  const ep = addEpisode(project, { title: "Ep" });
  const sc = addScene(ep, { heading: "INT. LIVING ROOM - DUSK" });
  const ids = [1, 2, 3].map((n) => addShot(sc, { description: `Shot ${n}.`, durationS: 4 }).id);
  t.store.create(project);
  for (const id of ids) await t.studio.generateTake(project.id, id, "draft");
  await drain(t.studio, project.id, 60);
  const rough = (name: string) =>
    assembleEpisode({ projects: t.store, media: t.store }, project.id, ep.id, { source: "rough", outDir: join(t.root, name) });
  return { ...t, projectId: project.id, episodeId: ep.id, ids, rough };
}

describe("the cut", () => {
  it("a start point takes time off the front of a take, and off the episode", async () => {
    const t = await three();
    const whole = await t.rough("a");
    await t.store.mutate(t.projectId, (p) => {
      findShot(p, t.ids[1]!).shot.takes[0]!.inS = 1;
    });
    const cut = await t.rough("b");
    expect(cut.shots[1]!.durationS).toBeCloseTo(whole.shots[1]!.durationS - 1, 1);
    expect(cut.durationS).toBeCloseTo(whole.durationS - 1, 1);
    expect(await mediaDuration(cut.episodeFile)).toBeCloseTo(whole.durationS - 1, 0);
  });

  it("a start point that would leave under half a second is ignored", () => {
    expect(takeInS({ inS: 3.8 }, 4)).toBe(0);
    expect(takeInS({ inS: 1 }, 4)).toBe(1);
    expect(takeInS({}, 4)).toBe(0);
  });

  it("a dissolve overlaps two shots, so the episode is shorter by its length and later shots start earlier", async () => {
    const t = await three();
    const whole = await t.rough("a");
    await t.store.mutate(t.projectId, (p) => updateShot(p, t.ids[1]!, { joinIn: "dissolve", joinS: 0.5 }));
    const cut = await t.rough("b");
    expect(cut.shots[1]!.dissolveS).toBeCloseTo(0.5, 2);
    expect(cut.shots[1]!.startS).toBeCloseTo(whole.shots[1]!.startS - 0.5, 2);
    expect(cut.shots[2]!.startS).toBeCloseTo(whole.shots[2]!.startS - 0.5, 2);
    expect(await mediaDuration(cut.episodeFile)).toBeCloseTo(whole.durationS - 0.5, 1);
    // The first shot has nothing to dissolve from.
    await t.store.mutate(t.projectId, (p) => updateShot(p, t.ids[0]!, { joinIn: "dissolve" }));
    expect((await t.rough("c")).shots[0]!.dissolveS).toBeUndefined();
  });

  it("a dissolve fades the whole way: no frame inside it snaps to the next shot", async () => {
    const t = await three();
    const jumpsNear = async (file: string, at: number) =>
      (await analyseClip(new Uint8Array(readFileSync(file)))).jumps.filter((j) => Math.abs(j - at) < 1.2);
    // A straight cut between two different clips is a one-frame jump; that is what a broken dissolve looks like too.
    const cut = await t.rough("a");
    expect(await jumpsNear(cut.episodeFile, cut.shots[1]!.startS)).not.toHaveLength(0);
    await t.store.mutate(t.projectId, (p) => updateShot(p, t.ids[1]!, { joinIn: "dissolve", joinS: 1 }));
    const soft = await t.rough("b");
    expect(await jumpsNear(soft.episodeFile, soft.shots[1]!.startS + 0.5)).toHaveLength(0);
  });

  it("two dissolves in a row, a slow push-in and fades at both ends still make one episode of the right length", async () => {
    const t = await three();
    const whole = await t.rough("a");
    await t.store.mutate(t.projectId, (p) => {
      updateShot(p, t.ids[1]!, { joinIn: "dissolve", joinS: 0.4, move: "push-in" });
      updateShot(p, t.ids[2]!, { joinIn: "dissolve", joinS: 0.4, move: "pull-out" });
      const ep = findEpisode(p, t.episodeId);
      ep.fadeInS = 0.5;
      ep.fadeOutS = 1;
    });
    const cut = await t.rough("b");
    expect(await mediaDuration(cut.episodeFile)).toBeCloseTo(whole.durationS - (2 * framesTo(0.4)) / FPS, 1);
    expect(cut.shots).toHaveLength(3);
  });

  it("changing a join or a move keeps the shot approved: the clip itself is untouched", async () => {
    const t = await three();
    await t.store.mutate(t.projectId, (p) => {
      updateShot(p, t.ids[1]!, { approved: true });
      updateShot(p, t.ids[1]!, { joinIn: "dissolve", move: "push-in" });
    });
    expect(findShot(await t.store.get(t.projectId), t.ids[1]!).shot.approved).toBe(true);
  });

  it("music leading: the clips' own sound sits far behind and the music is not dipped", () => {
    const lead = mixArgs("in.mp4", [], "music.mp3", 30, "out.mp4", "music").join(" ");
    expect(lead).toMatch(/volume=-24dB/);
    expect(lead).not.toMatch(/sidechaincompress/);
    const under = mixArgs("in.mp4", [], "music.mp3", 30, "out.mp4").join(" ");
    expect(under).toMatch(/sidechaincompress/);
    // Nothing to lead with: the voices stay as they were.
    expect(mixArgs("in.mp4", [{ path: "bed.mp3", start: 0, len: 30 }], undefined, 30, "out.mp4", "music").join(" ")).not.toMatch(/-24dB/);
  });

  it("the plan the Cut panel shows is the cut the assembly makes, to the frame", async () => {
    const t = await three();
    // A fourth shot laid over the third as a cutaway, and a fifth that dissolves in.
    await t.store.mutate(t.projectId, (p) => {
      const sc = findEpisode(p, t.episodeId).scenes[0]!;
      addShot(sc, { description: "Her face.", durationS: 4, cutaway: { atS: 1, lengthS: 1.5 } });
      addShot(sc, { description: "The door.", durationS: 4 });
    });
    const p0 = await t.store.get(t.projectId);
    const extra = findEpisode(p0, t.episodeId)
      .scenes[0]!.shots.slice(3)
      .map((s) => s.id);
    for (const id of extra) await t.studio.generateTake(t.projectId, id, "draft");
    await drain(t.studio, t.projectId, 60);
    await t.store.mutate(t.projectId, (p) => {
      const take = (id: string) => findShot(p, id).shot.takes[0]!;
      take(t.ids[0]!).inS = 0.4;
      take(t.ids[0]!).outS = 3.7;
      // An end point that floats put a hair under a whole frame (4.1 * 30 = 122.99999... at 30 fps).
      take(t.ids[1]!).outS = 4.1;
      take(t.ids[1]!).inS = 1 / FPS;
      updateShot(p, t.ids[1]!, { joinIn: "dissolve", joinS: 0.7 });
      updateShot(p, extra[1]!, { joinIn: "dissolve", joinS: 2 });
      // Fades make the last pass re-encode, where a stray frame once crept in.
      findEpisode(p, t.episodeId).fadeInS = 0.5;
      findEpisode(p, t.episodeId).fadeOutS = 1;
    });
    const plan = planCut(findEpisode(await t.store.get(t.projectId), t.episodeId), "rough");
    const cut = await t.rough("plan");
    expect(cut.shots.map((s) => s.shotId)).toEqual(plan.shots.filter((s) => !s.overShotId).map((s) => s.shot.id));
    expect(plan.shots.find((s) => s.shot.id === extra[0])?.overShotId).toBe(t.ids[2]);
    expect(cut.cutaways).toBe(1);
    const planned = plan.shots.filter((s) => !s.overShotId);
    cut.shots.forEach((s, i) => {
      expect(s.startS).toBe(planned[i]!.startF / FPS);
      expect(s.durationS).toBe(planned[i]!.lengthF / FPS);
      expect(s.dissolveS ?? 0).toBe(planned[i]!.dissolveF / FPS);
    });
    expect(planned[1]!.lengthF).toBe(framesTo(4.1) - 1); // less the one-frame start
    expect(cut.durationS).toBe(plan.totalF / FPS);
    // The file itself: exactly that many frames of picture; the sound track can run a few ms long.
    expect(await videoFrames(cut.episodeFile)).toBe(plan.totalF);
    expect(Math.abs((await mediaDuration(cut.episodeFile)) - cut.durationS)).toBeLessThan(1.5 / FPS);
    // The edit list carries the start point and the dissolves.
    const edl = readFileSync(join(cut.dir, "edit-list.edl"), "utf8");
    expect(edl).toMatch(/^002 {2}SHOT001 {2}V {5}C {8}(\S+) \1 /m);
    expect(edl).toMatch(new RegExp(`^002 {2}SHOT002 {2}V {5}D {4}${String(framesTo(0.7)).padStart(3, "0")} `, "m"));
    expect(edl).toMatch(new RegExp(`\\* SOURCE: \\S+ FROM 00:00:00:${String(Math.round(0.4 * FPS)).padStart(2, "0")}`));
    const json = JSON.parse(readFileSync(join(cut.dir, "edit-list.json"), "utf8"));
    expect(json.shots[0].inS).toBeCloseTo(Math.round(0.4 * FPS) / FPS, 5);
    expect(json.shots[1].dissolveS).toBeCloseTo(framesTo(0.7) / FPS, 5);
  });

  it("frames are counted the same way everywhere, and dissolves never take more than half a shot", () => {
    // Every whole frame, written as seconds, counts back to itself: floats never lose one (4.1 * 30 = 122.99999...).
    for (let f = 1; f <= 600; f++) expect(framesTo(f / FPS)).toBe(f);
    expect(framesTo(4.1 - 1 / FPS)).toBe(framesTo(4.1) - 1);
    expect(dissolveFrames(2, 30, 90)).toBe(15);
    expect(dissolveFrames(0.5, 200, 200)).toBe(FPS / 2);
    expect(dissolveFrames(0.5, 4, 200)).toBe(0);
  });

  it("exactly half a second is kept, at every end point, whatever the floats do", () => {
    // Half a second exactly (1.5 - 1.0, or 1.4 - 0.9 which is 0.49999... in floats): the start point must still hold.
    expect(takeInS({ inS: 1 }, 1.5)).toBeCloseTo(1, 9);
    const half = FPS / 2;
    for (let f = half; f <= 300; f++) {
      const out = f / FPS;
      expect(takeInS({ inS: latestInS(out) }, out) * FPS).toBeCloseTo(f - half, 6);
      const { inF, outF } = keptFrames({ id: "t", status: "done", tier: "draft", inS: latestInS(out), outS: out }, { durationS: 10 });
      expect(outF - inF).toBe(half);
    }
    expect(latestInS(0.4)).toBe(0);
  });

  it("a start point does not move where the next shot continues from: that is the end point", async () => {
    const t = setup();
    const project = createProject({ name: "Chain" });
    const sc = addScene(addEpisode(project, { title: "Ep" }), { heading: "INT. ROOM" });
    const a = addShot(sc, { description: "A.", durationS: 5 }).id;
    const b = addShot(sc, { description: "B.", durationS: 5, continueFromPrevious: true }).id;
    t.store.create(project);
    await t.studio.generateTake(project.id, a, "draft");
    await drain(t.studio, project.id, 40);
    await t.store.mutate(project.id, (p) => {
      const take = findShot(p, a).shot.takes[0]!;
      take.inS = 1;
      take.outS = 3;
    });
    await t.studio.generateTake(project.id, b, "draft");
    await drain(t.studio, project.id, 40);
    const p = await t.store.get(project.id);
    const source = findShot(p, a).shot.takes[0]!;
    const chained = p.media.find((m) => m.source === `chain_${source.id}`)!;
    const clip = await t.store.read(project.id, p.media.find((m) => m.id === source.videoMediaId)!);
    expect(Buffer.from(await t.store.read(project.id, chained)).equals(Buffer.from(await frameAt(clip, 3)))).toBe(true);
  });

  it("a clip that holds its first frame is given a start point where it begins to move", () => {
    const fps = 24;
    const held = [...Array(8).fill(0.05), ...Array(112).fill(6)];
    expect(analyseDiffs(held, fps, 5).suggestedInS).toBeCloseTo(8 / fps, 2);
    expect(analyseDiffs(Array(120).fill(6), fps, 5).suggestedInS).toBeUndefined();
    // A clip that is still throughout is meant to be still.
    expect(analyseDiffs(Array(120).fill(0.05), fps, 5).suggestedInS).toBeUndefined();
  });
});
