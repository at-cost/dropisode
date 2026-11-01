import { describe, expect, it } from "vitest";
import { addCast, createProject } from "../src/edit";
import { framePrompt, sceneTargetSeconds, scriptSpeakerFor, scriptSpeakers, storyboardPrompt } from "../src/prompts";
import { MockProvider } from "../src/providers/mock";
import type { ProviderInput } from "../src/providers/types";
import { setup } from "./helpers";

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

  it("carries continues and on-screen text onto the shots, and asks for longer flowing shots", async () => {
    let prompt = "";
    const mock = new MockProvider({
      llm: (purpose: string, input: ProviderInput) => {
        if (purpose !== "storyboard") return "{}";
        prompt = input.prompt ?? "";
        return JSON.stringify({
          shots: [
            { description: "A blank card in her hands.", duration: 10, continues: true, onScreenText: "Nora Ashby, 1992 to 2026" },
            { description: "She looks up.", duration: 10, continues: true },
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
    // The first shot of a scene has nothing to continue from.
    expect(shots.map((s) => s.continueFromPrevious)).toEqual([false, true]);
    expect(shots[0]!.onScreenText).toBe("Nora Ashby, 1992 to 2026");
    expect(prompt).toMatch(/Prefer fewer, longer shots/);
    expect(prompt).toMatch(/"continues": true/);
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
