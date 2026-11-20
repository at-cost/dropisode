import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleEpisode, mixArgs } from "../src/assemble";
import { addEpisode, addScene, addShot, createProject, findEpisode, findShot } from "../src/edit";
import { gainTo, hasAudio, measureLoudness, mediaDuration, runFfmpeg } from "../src/ffmpeg";
import { drain, setup } from "./helpers";

async function scene() {
  const t = setup();
  // Drafts that speak, as the live catalog makes them.
  (t.catalog.config.defaults as { draftAudio: boolean }).draftAudio = true;
  const project = createProject({ name: "Sound" });
  const ep = addEpisode(project, { title: "Ep" });
  const sc = addScene(ep, { heading: "EXT. CHURCHYARD - DAY, RAIN" });
  const talk = addShot(sc, { description: "Celeste speaks.", durationS: 4, dialogue: [{ castId: null, text: "We are getting married." }] });
  const look = addShot(sc, { description: "Nora looks up.", durationS: 4 });
  t.store.create(project);
  return { ...t, projectId: project.id, episodeId: ep.id, sceneId: sc.id, talk: talk.id, look: look.id };
}

describe("sound pass", () => {
  it("lifts the voices out of a clip that speaks, and leaves silent clips alone", async () => {
    const t = await scene();
    // A video model that speaks (the test catalog's draft model is silent).
    for (const id of [t.talk, t.look]) await t.studio.generateTake(t.projectId, id, "draft", { video: "vid-final" });
    await drain(t.studio, t.projectId, 40);
    const p = await t.store.get(t.projectId);
    expect(findShot(p, t.talk).shot.takes[0]!.voiceMediaId).toBeTruthy();
    expect(findShot(p, t.look).shot.takes[0]!.voiceMediaId).toBeUndefined();
    expect(t.mock.submitted.filter((x) => x.job.purpose === "isolate")).toHaveLength(1);
  });

  it("a shot with no lines keeps its sound effects, voices taken out, under the scene's background", async () => {
    const t = await scene();
    // The test catalog's final model makes sound; the draft model is silent.
    for (const id of [t.talk, t.look]) await t.studio.generateTake(t.projectId, id, "draft", { video: "vid-final" });
    await drain(t.studio, t.projectId, 40);
    // No background yet: no effects either (the edit wouldn't use them, so nobody pays for them).
    expect(findShot(await t.store.get(t.projectId), t.look).shot.takes[0]!.effectsMediaId).toBeUndefined();
    await t.studio.generateSound(t.projectId, t.episodeId);
    await drain(t.studio, t.projectId, 40);
    const p = await t.store.get(t.projectId);
    // The talking shot gets its voice lifted out, the silent one its effects: never both, never the wrong one.
    expect(findShot(p, t.talk).shot.takes[0]!.voiceMediaId).toBeTruthy();
    expect(findShot(p, t.talk).shot.takes[0]!.effectsMediaId).toBeUndefined();
    expect(findShot(p, t.look).shot.takes[0]!.effectsMediaId).toBeTruthy();
    expect(t.mock.submitted.filter((x) => x.job.purpose === "effects")).toHaveLength(1);
    const res = await assembleEpisode({ projects: t.store, media: t.store }, t.projectId, t.episodeId, {
      source: "rough",
      outDir: join(t.root, "fx"),
    });
    // The silent shot's file carries sound (its effects), not silence under the bed.
    const lookFile = res.shots.find((s) => s.shotId === t.look)!.file;
    const wav = join(t.root, "look.wav");
    await runFfmpeg(["-y", "-i", lookFile, "-vn", wav]);
    expect((await measureLoudness(wav))?.i ?? -99).toBeGreaterThan(-60);
  });

  it("with no effects model, a shot with no lines keeps its own clip sound under the background", async () => {
    const t = await scene();
    delete (t.catalog.config.defaults as { effectsIsolation?: string }).effectsIsolation;
    for (const id of [t.talk, t.look]) await t.studio.generateTake(t.projectId, id, "draft", { video: "vid-final" });
    await drain(t.studio, t.projectId, 40);
    // Only the voice of the talking shot is priced and separated.
    const est = t.studio.estimateSound(await t.store.get(t.projectId), t.episodeId);
    expect(est.separation).toBeNull(); // already lifted when the take landed
    await t.studio.generateSound(t.projectId, t.episodeId);
    await drain(t.studio, t.projectId, 40);
    expect(t.mock.submitted.filter((x) => x.job.purpose === "effects")).toHaveLength(0);
    const res = await assembleEpisode({ projects: t.store, media: t.store }, t.projectId, t.episodeId, {
      source: "rough",
      outDir: join(t.root, "nofx"),
    });
    const lookFile = res.shots.find((s) => s.shotId === t.look)!.file;
    const wav = join(t.root, "look-nofx.wav");
    await runFfmpeg(["-y", "-i", lookFile, "-vn", wav]);
    expect((await measureLoudness(wav))?.i ?? -99).toBeGreaterThan(-60);
  });

  it("audio shorter than the isolation model accepts is padded up to its minimum, and priced so", async () => {
    const t = await scene();
    const iso = t.catalog.get(t.catalog.config.defaults.voiceIsolation!);
    (iso.input as { minMediaS?: number }).minMediaS = 4.6;
    await t.studio.generateTake(t.projectId, t.talk, "draft", { video: "vid-final" });
    await drain(t.studio, t.projectId, 40);
    const sent = t.mock.submitted.find((x) => x.job.purpose === "isolate")!;
    expect(sent.input.durationS).toBeGreaterThanOrEqual(5);
  });

  it("makes music for the episode and a background for each scene, then mixes them under the cut", async () => {
    const t = await scene();
    for (const id of [t.talk, t.look]) await t.studio.generateTake(t.projectId, id, "draft");
    await t.studio.generateSound(t.projectId, t.episodeId);
    await drain(t.studio, t.projectId, 40);
    const ep = findEpisode(await t.store.get(t.projectId), t.episodeId);
    expect(ep.music?.status).toBe("done");
    expect(ep.scenes[0]!.ambience?.status).toBe("done");
    expect(ep.music?.prompt).toMatch(/Instrumental/);
    expect(ep.scenes[0]!.ambience?.prompt).toMatch(/CHURCHYARD/);
    const res = await assembleEpisode({ projects: t.store, media: t.store }, t.projectId, t.episodeId, {
      source: "rough",
      outDir: join(t.root, "rough"),
    });
    expect(res.soundBeds).toBe(2);
    expect(await hasAudio(res.episodeFile)).toBe(true);
    expect(await mediaDuration(res.episodeFile)).toBeCloseTo(8, 0);
    // The sound runs to the end of the picture: the mix once closed about three seconds early, losing the last line.
    const audioOnly = join(t.root, "rough-audio.m4a");
    await runFfmpeg(["-y", "-i", res.episodeFile, "-vn", "-c:a", "copy", audioOnly]);
    expect(await mediaDuration(audioOnly)).toBeGreaterThan(res.durationS - 0.2);
    // One loudness for every episode, and the background is heard from the first second.
    const whole = await measureLoudness(res.episodeFile);
    expect(whole?.i).toBeGreaterThan(-18);
    expect(whole?.i).toBeLessThan(-14);
    const opening = join(t.root, "opening.m4a");
    await runFfmpeg(["-y", "-i", res.episodeFile, "-t", "2", "-vn", "-c:a", "aac", opening]);
    expect((await measureLoudness(opening))?.i).toBeGreaterThan(-30);
  });

  it("an episode with no talking, only background, still comes out at the episode's loudness", async () => {
    const t = await scene();
    await t.store.mutate(t.projectId, (p) => {
      for (const id of [t.talk, t.look]) {
        const sh = findShot(p, id).shot;
        sh.audio = "none";
        sh.dialogue = [];
      }
    });
    for (const id of [t.talk, t.look]) await t.studio.generateTake(t.projectId, id, "draft");
    await t.studio.generateSound(t.projectId, t.episodeId);
    await drain(t.studio, t.projectId, 40);
    await t.store.mutate(t.projectId, (p) => {
      findEpisode(p, t.episodeId).music = null;
    });
    const res = await assembleEpisode({ projects: t.store, media: t.store }, t.projectId, t.episodeId, {
      source: "rough",
      outDir: join(t.root, "quiet"),
    });
    expect(res.soundBeds).toBe(1);
    const whole = await measureLoudness(res.episodeFile);
    expect(whole?.i).toBeGreaterThan(-18);
    expect(whole?.i).toBeLessThan(-14);
  });

  it("a shot with a target picture still gets its sound effects separated", async () => {
    const t = await scene();
    // A model that both makes sound and ends on a target picture, like Seedance 2.5.
    t.catalog.get("vid-final").input.endImage = "end_image_url";
    await t.store.mutate(t.projectId, (p) => {
      findShot(p, t.look).shot.endPicture = "Nora is on her feet at the gate.";
    });
    // The scene already has its background, so the effects are separated as soon as the take is in.
    await t.studio.generateSound(t.projectId, t.episodeId);
    await drain(t.studio, t.projectId, 40);
    await t.studio.generateTake(t.projectId, t.look, "draft", { video: "vid-final" });
    await drain(t.studio, t.projectId, 40);
    const take = findShot(await t.store.get(t.projectId), t.look).shot.takes[0]!;
    expect(take.endFrameMediaId).toBeTruthy();
    expect(take.effectsMediaId).toBeTruthy();
    expect(take.effectsMediaId).not.toBe(take.endFrameMediaId);
  });

  it("the sound price includes separating the takes made before it, and drops once they are", async () => {
    const t = await scene();
    for (const id of [t.talk, t.look]) await t.studio.generateTake(t.projectId, id, "draft", { video: "vid-final" });
    await drain(t.studio, t.projectId, 40);
    const before = t.studio.estimateSound(await t.store.get(t.projectId), t.episodeId);
    // The talking shot's voice was lifted out when its take came in; the silent shot still waits for its effects.
    expect(before.separation?.providerCostMicro ?? 0).toBeGreaterThan(0);
    await t.studio.generateSound(t.projectId, t.episodeId);
    await drain(t.studio, t.projectId, 40);
    expect(t.studio.estimateSound(await t.store.get(t.projectId), t.episodeId).separation).toBeNull();
  });

  it("a background is heard from its first second, as loud as in the middle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-bed-"));
    try {
      const j = join(dir, "joined.mp4");
      const bed = join(dir, "bed.wav");
      const out = join(dir, "mixed.mp4");
      await runFfmpeg([
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=180x320:r=24:d=8",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-t",
        "8",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        j,
      ]);
      await runFfmpeg(["-f", "lavfi", "-i", "anoisesrc=d=10:c=pink:a=0.05", "-ac", "2", bed]);
      const gainDb = gainTo(-34, await measureLoudness(bed));
      await runFfmpeg(mixArgs(j, [{ path: bed, start: 0, len: 8, gainDb }], undefined, 8, out));
      const window = async (from: number) => {
        const f = join(dir, `w${from}.wav`);
        await runFfmpeg(["-ss", String(from), "-t", "2", "-i", out, "-vn", f]);
        return (await measureLoudness(f))?.i ?? -99;
      };
      const [start, middle] = [await window(0.5), await window(4)];
      expect(middle).toBeGreaterThan(-40);
      expect(Math.abs(start - middle)).toBeLessThan(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("making the sound also lifts the voices out of clips made before it", async () => {
    const t = await scene();
    (t.catalog.config.defaults as { voiceIsolation?: string }).voiceIsolation = undefined;
    await t.studio.generateTake(t.projectId, t.talk, "draft", { video: "vid-final" });
    await drain(t.studio, t.projectId, 40);
    expect(findShot(await t.store.get(t.projectId), t.talk).shot.takes[0]!.voiceMediaId).toBeUndefined();
    (t.catalog.config.defaults as { voiceIsolation?: string }).voiceIsolation = "demucs-vocals";
    await t.studio.generateSound(t.projectId, t.episodeId);
    await drain(t.studio, t.projectId, 40);
    expect(findShot(await t.store.get(t.projectId), t.talk).shot.takes[0]!.voiceMediaId).toBeTruthy();
  });

  it("prices the sound up front: music by the started minute, a 22 s looping background per scene", async () => {
    const t = await scene();
    const e = t.studio.estimateSound(await t.store.get(t.projectId), t.episodeId);
    expect(e.music!.units).toBe(60);
    expect(e.ambience!.units).toBe(22);
  });
});
