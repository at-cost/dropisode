import { describe, expect, it } from "vitest";
import { addCast, createProject } from "../src/edit";
import { framePrompt, sceneTargetSeconds, scriptSpeakerFor, scriptSpeakers, storyboardPrompt, videoPrompt } from "../src/prompts";
import { MockProvider } from "../src/providers/mock";
import type { ProviderInput } from "../src/providers/types";
import { drain, setup } from "./helpers";

const SCRIPT = `TITLE: Test
CAST:
- NORA (character): woman, hooded
- CELESTE (character): woman, gloves

SCENE 1. EXT. CHURCHYARD - DAY, RAIN
Close-up: rain on an order of service.
TWO GIRLS (V.O., faint, a memory): If you're out there, Nora... ready or not.
NORA (V.O.): That's me. Six weeks dead.
CELESTE (V.O.): Julian and I are getting married.`;

describe("storyboard", () => {
  it("keeps the script's speakers: someone outside the cast is the narrator, never a cast member", async () => {
    let prompt = "";
    const mock = new MockProvider({
      llm: (purpose: string, input: ProviderInput) => {
        if (purpose !== "storyboard") return "{}";
        prompt = input.prompt ?? "";
        // The model gets the speakers wrong, as it did in production.
        return JSON.stringify({
          shots: [
            {
              description: "Rain on a card.",
              dialogue: [{ speaker: "CELESTE", text: "If you're out there, Nora... ready or not." }],
              duration: 10,
            },
            { description: "Nora from behind.", dialogue: [{ speaker: "CELESTE", text: "That's me. Six weeks dead." }], duration: 10 },
            {
              description: "Celeste from behind.",
              dialogue: [{ speaker: "CELESTE", text: "Julian and I are getting married." }],
              duration: 10,
            },
          ],
        });
      },
    });
    const t = setup({ mock });
    const project = createProject({ name: "Speakers" });
    t.store.create(project);
    await t.studio.importScript(project.id, { script: SCRIPT });
    const p = await t.store.get(project.id);
    const scene = p.episodes[0]!.scenes[0]!;
    await t.studio.storyboard(project.id, scene.id);
    const after = await t.store.get(project.id);
    const name = (id: string | null) => (id ? after.cast.find((c) => c.id === id)!.name : null);
    const lines = after.episodes[0]!.scenes[0]!.shots.map((s) => name(s.dialogue[0]!.castId));
    expect(lines).toEqual([null, "NORA", "CELESTE"]);
    // With no length asked for, a one-scene episode aims for a full episode.
    expect(prompt).toMatch(/totalling about 65 seconds/);
    expect(prompt).toMatch(/set speaker to null/);
    expect(prompt).toMatch(/on-screen text quoted exactly/);
  });

  it("cuts like a short drama: talking faces, cutaways over the line, V.O. as voice-over, no on-screen text", async () => {
    let prompt = "";
    const mock = new MockProvider({
      llm: (purpose: string, input: ProviderInput) => {
        if (purpose !== "storyboard") return "{}";
        prompt = input.prompt ?? "";
        return JSON.stringify({
          shots: [
            // A cutaway can't open a scene: nothing is speaking before it.
            { description: "Rain on the card.", duration: 4, cutaway: { at: 1, length: 2 }, onScreenText: "Nora Ashby" },
            { description: "Nora under her hood.", duration: 4, dialogue: [{ speaker: "NORA", text: "That's me. Six weeks dead." }] },
            {
              description: "Celeste faces the mourners.",
              duration: 6,
              dialogue: [{ speaker: "CELESTE", text: "Julian and I are getting married." }],
              voiceOver: false,
            },
            { description: "Nora's face drops.", duration: 4, cutaway: { at: 2.5, length: 2 } },
            { description: "Ring close-up.", duration: 4, continues: true },
          ],
        });
      },
    });
    const t = setup({ mock });
    const project = createProject({ name: "Flow" });
    t.store.create(project);
    await t.studio.importScript(project.id, { script: SCRIPT });
    const scene = (await t.store.get(project.id)).episodes[0]!.scenes[0]!;
    await t.studio.storyboard(project.id, scene.id);
    const shots = (await t.store.get(project.id)).episodes[0]!.scenes[0]!.shots;
    expect(shots.map((s) => s.cutaway)).toEqual([null, null, null, { atS: 2.5, lengthS: 2 }, null]);
    // The script marks every one of these V.O., so they're voice-overs, not lines spoken on camera.
    expect(shots.map((s) => s.audio)).toEqual(["native", "tts", "tts", "native", "native"]);
    expect(shots.every((s) => s.onScreenText === "")).toBe(true);
    expect(shots.map((s) => s.continueFromPrevious)).toEqual([false, false, false, false, true]);
    expect(prompt).toMatch(/picture changes every 2 to 4 seconds/);
    expect(prompt).toMatch(/"cutaway"/);
    expect(prompt).not.toMatch(/onScreenText/);
  });

  it("fixes the staging at storyboarding and holds the scene still and every frame to it", async () => {
    const mock = new MockProvider({
      llm: (purpose: string) =>
        purpose === "storyboard"
          ? JSON.stringify({
              staging:
                "NORA sits alone on the last bench at the very back, hood up, unnoticed. CELESTE stands at the front facing the mourners.",
              shots: [{ description: "Nora under the yew.", camera: "close-up", cast: ["NORA"], duration: 4 }],
            })
          : "{}",
    });
    const t = setup({ mock });
    const project = createProject({ name: "Staging" });
    t.store.create(project);
    await t.studio.importScript(project.id, { script: SCRIPT });
    const scene = (await t.store.get(project.id)).episodes[0]!.scenes[0]!;
    await t.studio.storyboard(project.id, scene.id);
    const sc = (await t.store.get(project.id)).episodes[0]!.scenes[0]!;
    expect(sc.staging).toMatch(/last bench at the very back/);
    await drain(t.studio, project.id, 40);
    await t.studio.generateTake(project.id, sc.shots[0]!.id, "draft");
    const master = t.mock.submitted.find((x) => x.job.purpose === "scene_master")!;
    expect(master.input.prompt).toMatch(/Staging, keep to it exactly.*last bench at the very back/);
    const frame = t.mock.submitted.find((x) => x.job.purpose === "frame")!;
    expect(frame.input.prompt).toMatch(/Where everyone is in this scene.*unnoticed/);
    expect(frame.input.prompt).toMatch(/The only recognisable people in this frame: NORA/);
  });

  it("close shots put the place soft behind the people; wide shots use the place's picture", () => {
    const place = { id: "l", name: "CHURCHYARD", kind: "location", description: "rainy churchyard", status: "ready" } as never;
    const base = {
      id: "s",
      description: "Nora looks up.",
      castIds: [],
      dialogue: [],
      durationS: 4,
      audio: "native" as const,
      approved: false,
      takes: [],
      continueFromPrevious: false,
      onScreenText: "",
      cutaway: null,
    };
    const close = framePrompt({ shot: { ...base, camera: "close-up" }, cast: [], location: place, aspect: "9:16" });
    expect(close).toMatch(/soft and out of focus/);
    const wide = framePrompt({ shot: { ...base, camera: "wide, static" }, cast: [], location: place, aspect: "9:16" });
    expect(wide).toMatch(/Wide shot/);
    expect(wide).toMatch(/setting's reference image/);
  });

  it("the first frame of a speaking shot shows the speaker's face, never their back", () => {
    const cast = [{ id: "c1", name: "CELESTE", kind: "character", description: "", status: "ready" }] as never;
    const shot = {
      id: "s",
      description: "Celeste faces the mourners.",
      camera: "",
      castIds: ["c1"],
      dialogue: [{ id: "l", castId: "c1", text: "We're getting married." }],
      durationS: 4,
      audio: "native" as const,
      approved: false,
      takes: [],
      continueFromPrevious: false,
      onScreenText: "",
      cutaway: null,
    };
    expect(framePrompt({ shot, cast, aspect: "9:16" })).toMatch(
      /CELESTE is speaking in this shot: their face turned towards the camera.*never looking straight into the lens/,
    );
    expect(framePrompt({ shot, cast, aspect: "9:16", voiceOver: true })).not.toMatch(/is speaking in this shot/);
  });

  it("close shots get no location picture and a prompt that sets their scale and keeps people out of a pasted backdrop", async () => {
    const t = setup();
    const project = createProject({ name: "Refs" });
    t.store.create(project);
    await t.studio.importScript(project.id, { script: SCRIPT });
    const p0 = await t.store.get(project.id);
    const nora = p0.cast.find((c) => c.name === "NORA")!;
    for (const c of p0.cast) await t.studio.generateCastImage(project.id, c.id);
    await drain(t.studio, project.id, 40);
    const sc = (await t.store.get(project.id)).episodes[0]!.scenes[0]!;
    const loc = (await t.store.get(project.id)).cast.find((c) => c.kind === "location");
    const { addShot } = await import("../src/edit");
    const ids: string[] = [];
    await t.store.mutate(project.id, (p) => {
      const scene = p.episodes[0]!.scenes[0]!;
      if (loc) scene.locationId = loc.id;
      const castIds = [nora.id, ...(loc ? [loc.id] : [])];
      ids.push(addShot(scene, { description: "Nora looks up.", camera: "close-up, static", castIds, durationS: 4 }).id);
      ids.push(addShot(scene, { description: "The churchyard in rain.", camera: "wide, static", castIds, durationS: 4 }).id);
    });
    void sc;
    const before = t.mock.submitted.length;
    for (const id of ids) await t.studio.generateTake(project.id, id, "draft");
    const frames = t.mock.submitted.slice(before).filter((x) => x.job.purpose === "frame");
    const names = frames.map((f) => (f.input.images ?? []).map((i) => i.name.split(".")[0]));
    expect(names[0]).toEqual(["NORA"]);
    if (loc) expect(names[1]).toContain(loc.name);
    expect(frames[0]!.input.prompt).toMatch(/Close-up: head and shoulders/);
    expect(frames[0]!.input.prompt).toMatch(/Never a cut-out pasted onto a background/);
    if (loc) expect(frames[0]!.input.prompt).toMatch(/soft and out of focus/);
  });

  it("a speaking shot gets its lines spoken on camera; a voice-over shot gets room sound only", () => {
    const cast = [{ id: "c1", name: "CELESTE", kind: "character" as const, description: "", status: "ready" as const }];
    const shot = {
      id: "s",
      description: "Celeste faces the mourners.",
      camera: "",
      castIds: ["c1"],
      dialogue: [{ id: "l", castId: "c1", text: "We're getting married." }],
      durationS: 4,
      audio: "native" as const,
      approved: false,
      takes: [],
      continueFromPrevious: false,
      onScreenText: "",
      cutaway: null,
    };
    expect(videoPrompt({ shot, cast: cast as never, nativeAudio: true })).toMatch(/CELESTE says: "We're getting married."/);
    const vo = videoPrompt({ shot, cast: cast as never, nativeAudio: true, speak: false });
    expect(vo).not.toMatch(/says/);
    expect(vo).toMatch(/Nobody speaks/);
  });

  it("tells the storyboard nobody may be seen speaking when the video is silent", () => {
    const base = { sceneScript: "x", heading: "h", cast: [], durations: [5] };
    expect(storyboardPrompt({ ...base, silentVideo: true }).prompt).toMatch(/nobody may be seen speaking/);
    expect(storyboardPrompt({ ...base, silentVideo: false }).prompt).not.toMatch(/nobody may be seen speaking/);
  });

  it("keeps described text in frames, and closes mouths under a voice-over", () => {
    const p = createProject({ name: "f" });
    const nora = addCast(p, { kind: "character", name: "NORA", description: "hooded" });
    const shot = {
      id: "s",
      description: 'A card printed "Nora Ashby".',
      camera: "",
      castIds: [nora.id],
      dialogue: [],
      durationS: 5,
      audio: "native",
      takes: [],
      approved: false,
    } as never;
    const frame = framePrompt({ shot, cast: [nora], aspect: "9:16", voiceOver: true });
    expect(frame).not.toMatch(/No text/);
    expect(frame).toMatch(/Show only text the shot itself describes/);
    expect(frame).toMatch(/every mouth is closed/);
  });

  it("matches lines to the script's speakers and shares the episode length by scene", () => {
    const s = scriptSpeakers(SCRIPT);
    expect(scriptSpeakerFor(s, "If you're out there, Nora... ready or not")).toBe("TWO GIRLS");
    expect(scriptSpeakerFor(s, "a line nobody wrote")).toBeUndefined();
    expect(sceneTargetSeconds("a".repeat(100), ["a".repeat(100)])).toBe(65);
    expect(sceneTargetSeconds("a".repeat(100), ["a".repeat(100), "a".repeat(300)])).toBe(16);
  });
});
