import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleEpisode } from "../src/assemble";
import { addEpisode, addScene, addShot, createProject, findEpisode, findShot } from "../src/edit";
import { hasAudio, mediaDuration } from "../src/ffmpeg";
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
