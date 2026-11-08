import { describe, expect, it } from "vitest";
import {
  addCast,
  addEpisode,
  addScene,
  addShot,
  createProject,
  mergeWithNext,
  moveShot,
  removeCast,
  splitShot,
  updateShot,
} from "../src/edit";
import { parseProject } from "../src/project";
import { parseScript, parseStoryboard, scriptDialogue } from "../src/prompts";

function sample() {
  const p = createProject({ name: "Test" });
  const maya = addCast(p, { kind: "character", name: "Maya", description: "yellow jacket" });
  const ep = addEpisode(p, { title: "Ep 1" });
  const sc = addScene(ep, { heading: "INT. SHOP - NIGHT" });
  const a = addShot(sc, {
    description: "A",
    castIds: [maya.id],
    dialogue: [
      { castId: maya.id, text: "one" },
      { castId: null, text: "two" },
    ],
    durationS: 6,
  });
  const b = addShot(sc, { description: "B", durationS: 5 });
  return { p, maya, ep, sc, a, b };
}

describe("shot edits", () => {
  it("splits a shot, dividing dialogue, and clears approval", () => {
    const { p, a, sc } = sample();
    a.approved = true;
    const [x, y] = splitShot(p, a.id, 2);
    expect(sc.shots.map((s) => s.id)).toEqual([x.id, y.id, sc.shots[2]!.id]);
    expect([x.durationS, y.durationS]).toEqual([2, 4]);
    expect(x.dialogue.map((l) => l.text)).toEqual(["one"]);
    expect(y.dialogue.map((l) => l.text)).toEqual(["two"]);
    expect(x.approved).toBe(false);
    expect(parseProject(p)).toBeTruthy();
  });

  it("merges with the next shot", () => {
    const { p, a, sc } = sample();
    const m = mergeWithNext(p, a.id);
    expect(sc.shots).toHaveLength(1);
    expect(m.durationS).toBe(11);
    expect(m.description).toBe("A\nB");
  });

  it("reorders across scenes", () => {
    const { p, ep, a } = sample();
    const sc2 = addScene(ep, { heading: "EXT. STREET" });
    moveShot(p, a.id, sc2.id, 0);
    expect(sc2.shots[0]!.id).toBe(a.id);
  });

  it("editing what a shot shows unapproves it; approving alone doesn't", () => {
    const { p, a } = sample();
    updateShot(p, a.id, { approved: true });
    expect(a.approved).toBe(true);
    updateShot(p, a.id, { description: "changed" });
    expect(a.approved).toBe(false);
  });

  it("keeps a TTS take only while the line is unchanged", () => {
    const { p, a } = sample();
    a.dialogue[0]!.ttsMediaId = "m_1";
    a.dialogue[1]!.ttsMediaId = "m_2";
    updateShot(p, a.id, {
      dialogue: [
        { id: a.dialogue[0]!.id, castId: a.dialogue[0]!.castId, text: "one" },
        { id: a.dialogue[1]!.id, castId: null, text: "changed" },
      ],
    });
    expect(a.dialogue[0]!.ttsMediaId).toBe("m_1");
    expect(a.dialogue[1]!.ttsMediaId).toBeUndefined();
  });

  it("removing a cast member unlinks it everywhere", () => {
    const { p, maya, a } = sample();
    removeCast(p, maya.id);
    expect(a.castIds).toEqual([]);
    expect(a.dialogue[0]!.castId).toBeNull();
  });
});

describe("parsers", () => {
  it("reads the script format", () => {
    const s = parseScript(
      "TITLE: The Letter\n\nCAST:\n- MAYA (character): courier, yellow jacket\n- SHOP (location): corner shop\n\nSCENE 1. INT. SHOP - NIGHT\nMaya enters.\nMAYA: Hello.\n\nSCENE 2. EXT. STREET - NIGHT\nRain.",
    );
    expect(s.title).toBe("The Letter");
    expect(s.cast).toEqual([
      { name: "MAYA", kind: "character", description: "courier, yellow jacket" },
      { name: "SHOP", kind: "location", description: "corner shop" },
    ]);
    expect(s.scenes.map((x) => x.heading)).toEqual(["INT. SHOP - NIGHT", "EXT. STREET - NIGHT"]);
    expect(scriptDialogue(s.scenes[0]!.text)).toEqual([{ speaker: "MAYA", text: "Hello." }]);
  });

  it("treats a script with no headings as one scene", () => {
    expect(parseScript("Just some action.").scenes).toHaveLength(1);
  });

  it("reads storyboard JSON inside code fences and drops junk", () => {
    const shots = parseStoryboard('Here:\n```json\n{"shots":[{"description":"x","duration":99,"cast":["A",3]},{"nope":1}]}\n```');
    expect(shots).toEqual([
      {
        description: "x",
        camera: "",
        cast: ["A"],
        dialogue: [],
        duration: 30,
        continues: false,
        endPicture: "",
        onScreenText: "",
        voiceOver: false,
        cutaway: null,
      },
    ]);
  });
});
