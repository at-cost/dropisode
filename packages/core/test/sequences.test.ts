import { describe, expect, it } from "vitest";
import { addCast, addEpisode, addScene, addShot, createProject, findShot, mergeWithNext, splitShot, updateShot } from "../src/edit";
import { Project } from "../src/project";
import { parseSequenceBoard, storyboardPrompt, videoPrompt } from "../src/prompts";
import { MockProvider, mockLlm } from "../src/providers/mock";
import type { ProviderInput } from "../src/providers/types";
import {
  constraintsBlock,
  fitPrompt,
  finishWrittenPrompt,
  keepsStructure,
  parseReview,
  refreshConstraints,
  sequencePrompt,
  writerPrompt,
} from "../src/writer";
import { drain, setup, testCatalog } from "./helpers";
import { PENGUIN, PLAN, SEAL, ctx, kungFuShot } from "./kungfu";

/** Dashes built from code points: this file holds none itself. */
const EM = String.fromCodePoint(0x2014);
const DASHES = new RegExp(`[${EM}${String.fromCodePoint(0x2013)}]`);

describe("the sequence prompt writer", () => {
  it("builds the full structure: logline, plate, characters, timecoded shots with hard cuts, camera law, grade and sound, counts", () => {
    const p = sequencePrompt(ctx({ references: ["PENGUIN", "SEAL"], imageToken: "@Image{n}" }));
    const order = [
      "References: @Image1 is PENGUIN, @Image2 is SEAL",
      "A small rockhopper penguin acrobatically dodges",
      "PLATE: Open Southern Ocean",
      "PENGUIN is a small wild rockhopper penguin",
      "SEAL is a huge grey bull seal",
      "0.00-3.00: MWS, worm's-eye angle, camera at the ice edge, 24mm lens, locked camera.",
      "3.00-6.00:",
      "6.00-9.00:",
      "9.00-11.00:",
      "CAMERA LAW:",
      "GRADE AND AUDIO:",
      "CONSTRAINTS:",
    ];
    let at = -1;
    for (const part of order) {
      const i = p.indexOf(part);
      expect(i, part).toBeGreaterThan(at);
      at = i;
    }
    expect(p.match(/Hard cut\./g)).toHaveLength(3);
    expect(p.match(/End with /g)).toHaveLength(4);
    expect(p).toMatch(/Real size: 45 cm tall\./);
    expect(p).toMatch(/Correct real anatomy: two stubby flippers/);
    expect(p).toMatch(/PENGUIN screen-left, SEAL screen-right; every camera stays on the same side/);
    expect(p).toMatch(/24fps motion with a 180-degree shutter/);
    expect(p).toMatch(/Anti-default: avoid centred eye-level coverage/);
    expect(p).toMatch(/Diegetic sound only: low Southern Ocean wash, tail whip with a sharp crack/);
    expect(p).toMatch(/No music, no score, no bgm\./);
    expect(p).not.toMatch(/drifts slowly|breathe, blink/);
    expect(p).not.toMatch(DASHES);
  });

  it("puts the counts and constraints in deterministically, and counts a cast member who isn't in the shot as zero", () => {
    const c = constraintsBlock(ctx());
    expect(c).toMatch(/^CONSTRAINTS: /);
    expect(c).toMatch(/Count of penguins in frame: one\. Count of seals in frame: one\. Count of ice floes in frame: one\./);
    expect(c).toMatch(/Cut count: three\. Shot count: four\./);
    expect(c).toMatch(/Character positions: PENGUIN screen-left, SEAL screen-right\./);
    expect(c).toMatch(/Whitelist of visible subjects: one southern rockhopper penguin, one adult male grey seal/);
    expect(c).toMatch(/no split screen/);
    expect(c).toMatch(/No on-screen text, no subtitles, no captions/);
    expect(c).toMatch(/No music, no score, no bgm/);
    // Without scene counts, every character in the shot is counted as one.
    const bare = constraintsBlock(ctx({ scene: { ...PLAN, counts: [], whitelist: [] } }));
    expect(bare).toMatch(/Count of PENGUIN in frame: one\. Count of SEAL in frame: one\./);
    expect(bare).toMatch(/Whitelist of visible subjects: one Penguin, one Seal/);
    // Slow motion is stated for the whole generation.
    const slow = constraintsBlock(ctx({ shot: { ...kungFuShot(), slowMotion: true } }));
    expect(slow).toMatch(/Slow motion for the whole generation/);
    expect(sequencePrompt(ctx({ shot: { ...kungFuShot(), slowMotion: true } }))).toMatch(/entire generation has a 120fps slow-motion feel/);
  });

  it("keeps the writer's prose but always replaces any counts it wrote with ours, and strips em dashes", () => {
    const shot = kungFuShot();
    const llm = [
      `A penguin dodges a seal ${EM} then gets knocked off the ice.`,
      "PLATE: grey sea.",
      ...shot.beats.flatMap((b, i) => [
        `${b.startS.toFixed(2)}-${b.endS.toFixed(2)}: shot ${i + 1}. End with something.`,
        ...(i < 3 ? ["Hard cut."] : []),
      ]),
      "CAMERA LAW: low.",
      "GRADE AND AUDIO: grey. No music, no score, no bgm.",
      "Count of penguins in frame: two.",
      "CONSTRAINTS: Count of seals in frame: three.",
    ].join("\n\n");
    const { prompt, fellBack } = finishWrittenPrompt(llm, ctx({ references: ["PENGUIN", "SEAL"], imageToken: "@Image{n}" }));
    expect(fellBack).toBe(false);
    expect(prompt).toMatch(/^References: @Image1 is PENGUIN/);
    expect(prompt).toMatch(/dodges a seal, then gets knocked/);
    expect(prompt).not.toMatch(/in frame: two|in frame: three/);
    expect(prompt.match(/CONSTRAINTS:/g)).toHaveLength(1);
    expect(prompt.endsWith(constraintsBlock(ctx()))).toBe(true);
    expect(prompt).not.toMatch(DASHES);
  });

  it("falls back to the plan's own prompt when the writer loses the timecodes or the cuts", () => {
    const { prompt, fellBack } = finishWrittenPrompt("A lovely clip of a penguin and a seal fighting on the ice, very cinematic.", ctx());
    expect(fellBack).toBe(true);
    expect(prompt).toBe(sequencePrompt(ctx()));
    expect(keepsStructure(prompt, kungFuShot())).toBe(true);
  });

  it("asks the writer for the structure, with a model-specific guide and the plan as the draft", () => {
    const cat = testCatalog();
    const seq = writerPrompt(ctx(), cat.get("vid-seq"));
    expect(seq.system).toMatch(/Seedance 2\.5/);
    expect(seq.prompt).toMatch(/Put "Hard cut\." on its own line between shots/);
    expect(seq.prompt).toMatch(/Do not write counts or a CONSTRAINTS paragraph/);
    expect(seq.prompt).toMatch(/DRAFT START[\s\S]*0\.00-3\.00[\s\S]*DRAFT END/);
    // The draft carries no counts: they are added after.
    expect(seq.prompt).not.toMatch(/Count of penguins/);
    // Other models get the generic guide.
    expect(writerPrompt(ctx(), cat.get("vid-final")).system).toMatch(/image-to-video model/);
  });

  it("puts fresh counts and the reference line back into an edited prompt", () => {
    const edited = `${sequencePrompt(ctx())}\n\nExtra note from the creator.`.replace(/\n\nCONSTRAINTS:[\s\S]*?(?=\n\nExtra)/, "");
    const scene = { ...PLAN, counts: [{ what: "penguins", n: 1 }] };
    const out = refreshConstraints(edited, ctx({ scene, references: ["PENGUIN"], imageToken: "@Image{n}" }));
    expect(out).toMatch(/^References: @Image1 is PENGUIN\./);
    expect(out).toMatch(/Extra note from the creator\.\n\nCONSTRAINTS: Count of penguins in frame: one\./);
    expect(out).not.toMatch(/Count of seals/);
  });
});

describe("sequences storyboard", () => {
  it("asks for sequences of several shots, the world, real sizes and anatomy, screen sides, sounds and counts", () => {
    const p = storyboardPrompt({
      sceneScript: PLAN.script,
      heading: PLAN.heading,
      cast: [PENGUIN, SEAL],
      durations: Array.from({ length: 27 }, (_, i) => i + 4),
      targetSeconds: 45,
      cutting: "sequences",
    });
    expect(p.prompt).toMatch(/Each sequence is ONE generation of 6 to 15 seconds holding 2 to 4 shots/);
    expect(p.prompt).toMatch(/Every cut changes both the shot size and the angle/);
    expect(p.prompt).toMatch(/lens in millimetres/);
    expect(p.prompt).toMatch(/"endsWith" is the state it leaves/);
    expect(p.prompt).toMatch(/carries on from the previous sequence's last "endsWith", not from the scene's opening staging/);
    expect(p.prompt).toMatch(/specific diegetic "sounds"/);
    expect(p.prompt).toMatch(/"plate"/);
    expect(p.prompt).toMatch(/real size in numbers/);
    expect(p.prompt).toMatch(/never human hands, arms or poses/);
    expect(p.prompt).toMatch(/side of the screen/);
    expect(p.prompt).toMatch(/"counts"/);
    expect(p.prompt).toMatch(/"whitelist"/);
    expect(p.prompt).not.toMatch(DASHES);
  });

  it("re-times beats back to back from zero and reads the plan", () => {
    const plan = parseSequenceBoard(
      JSON.stringify({
        staging: "Both in the water.",
        plate: "One floe.",
        grade: "Grey.",
        characters: [{ name: "Penguin", size: "45 cm tall", anatomy: "flippers", acting: "crest lifts", side: "left" }],
        counts: [
          { what: "penguins", n: 1 },
          { what: "bad", n: -1 },
        ],
        whitelist: ["one penguin"],
        sequences: [
          {
            logline: "Fight.",
            start: "On the floe.",
            cast: ["Penguin"],
            sounds: ["splash"],
            beats: [
              { from: 2, to: 5, size: "WS", action: "a", endsWith: "x" },
              { start: 4, end: 6, size: "CU", action: "b", endState: "y" },
            ],
          },
          { logline: "No beats: dropped.", beats: [] },
        ],
      }),
    );
    expect(plan.sequences).toHaveLength(1);
    expect(plan.sequences[0]!.beats.map((b) => [b.startS, b.endS])).toEqual([
      [0, 3],
      [3, 5],
    ]);
    expect(plan.sequences[0]!.beats[0]!.endState).toBe("x");
    expect(plan.counts).toEqual([{ what: "penguins", n: 1 }]);
    expect(plan.castNotes[0]!.side).toBe("left");
  });
});

/** A project with a penguin and a seal (with pictures), one action scene, storyboarded into sequences. */
async function actionProject(o: { review?: (n: number) => string; start?: "references" | "first-frame" } = {}) {
  let reviews = 0;
  const board = {
    staging: PLAN.staging,
    plate: PLAN.plate,
    grade: PLAN.grade,
    characters: PLAN.castNotes,
    counts: PLAN.counts,
    whitelist: PLAN.whitelist,
    sequences: [
      {
        logline: kungFuShot().logline,
        start: kungFuShot().startState,
        cast: ["Penguin", "Seal"],
        sounds: kungFuShot().sounds,
        beats: kungFuShot().beats.map(({ startS, endS, endState, ...b }) => ({ ...b, from: startS, to: endS, endsWith: endState })),
      },
      {
        logline: "The seal grins.",
        start: "The seal alone on the floe.",
        cast: ["Seal"],
        sounds: ["one smug huff"],
        beats: [
          {
            from: 0,
            to: 2.5,
            size: "CU",
            angle: "low",
            height: "at the ice",
            lens: "85mm",
            movement: "locked",
            action: "The seal grins.",
            endsWith: "grin held",
          },
          {
            from: 2.5,
            to: 5.2,
            size: "EWS",
            angle: "top-down",
            height: "20 m up",
            lens: "24mm",
            movement: "crane",
            action: "The floe alone.",
            endsWith: "floe",
          },
        ],
      },
    ],
  };
  const mock = new MockProvider({
    llm: (purpose: string, input: ProviderInput) => {
      if (purpose === "storyboard") return JSON.stringify(board);
      if (purpose === "review") return o.review ? o.review(++reviews) : JSON.stringify({ pass: true, problems: [], fixedPrompt: "" });
      return mockLlm(purpose, input);
    },
  });
  const t = setup({ mock });
  const project = createProject({ name: "Out by a Whisker" });
  project.models = { draftVideo: "vid-seq", finalVideo: "vid-seq" };
  const penguin = addCast(project, { kind: "character", name: "Penguin", description: PENGUIN.description });
  const seal = addCast(project, { kind: "character", name: "Seal", description: SEAL.description });
  const ep = addEpisode(project, { title: "Kung fu" });
  const scene = addScene(ep, { heading: PLAN.heading, script: PLAN.script });
  scene.cutting = "sequences";
  scene.start = o.start ?? "references";
  t.store.create(project);
  for (const c of [penguin, seal]) await t.studio.generateCastImage(project.id, c.id);
  await drain(t.studio, project.id);
  return { ...t, projectId: project.id, sceneId: scene.id };
}

describe("sequences in the studio", () => {
  it("storyboards an action scene into sequences, writes each prompt (logged), and skips the master still when it starts from pictures", async () => {
    const t = await actionProject();
    const before = await t.store.get(t.projectId);
    const est = t.studio.estimateStoryboard(before, t.sceneId);
    const boardOnly = t.studio.llmEstimate(
      storyboardPrompt({
        sceneScript: PLAN.script,
        heading: PLAN.heading,
        cast: before.cast,
        durations: t.catalog.get("vid-seq").durations,
        targetSeconds: 65,
        cutting: "sequences",
      }),
    );
    // The estimate includes the writes (about one per 10 seconds), not just the plan.
    expect(est.providerCostMicro).toBeGreaterThan(boardOnly.providerCostMicro);
    await t.studio.storyboard(t.projectId, t.sceneId);
    const p = await t.store.get(t.projectId);
    const sc = p.episodes[0]!.scenes[0]!;
    expect(sc.plate).toMatch(/2\.5 metres/);
    expect(sc.counts).toHaveLength(3);
    expect(sc.castNotes.map((n) => n.side)).toEqual(["left", "right"]);
    expect(sc.shots).toHaveLength(2);
    expect(sc.shots[0]!.beats).toHaveLength(4);
    expect(sc.shots[0]!.durationS).toBe(11);
    // 5.2 s of beats renders as a 6 s clip: the last beat runs to the end of it.
    expect(sc.shots[1]!.durationS).toBe(6);
    expect(sc.shots[1]!.beats.at(-1)!.endS).toBe(6);
    for (const sh of sc.shots) {
      expect(sh.writtenPrompt).toMatch(/Hard cut\./);
      expect(sh.writtenPrompt).toMatch(/CONSTRAINTS: Count of penguins in frame: one/);
      expect(sh.writtenFor).toBe("vid-seq");
    }
    expect(sc.shots[0]!.writtenPrompt).toMatch(/^References: @Image1 is PENGUIN, @Image2 is SEAL\./);
    expect(sc.master).toBeNull();
    expect(p.costLog.map((l) => l.purpose).filter((x) => x !== "cast_image")).toEqual(["storyboard", "write", "write"]);
    expect(p.costLog.filter((l) => l.purpose === "write").every((l) => l.shotId && l.status === "charged")).toBe(true);
  });

  it("makes a sequence from the cast pictures in one generation, sends the written prompt verbatim, then checks it (priced and logged)", async () => {
    const t = await actionProject();
    await t.studio.storyboard(t.projectId, t.sceneId);
    let p = await t.store.get(t.projectId);
    const shot = p.episodes[0]!.scenes[0]!.shots[0]!;
    const est = t.studio.estimateTake(p, shot.id, "draft");
    expect(est.byReference).toBe(true);
    expect(est.frame.providerCostMicro).toBe(0);
    expect(est.write).toBeNull();
    expect(est.review).not.toBeNull();
    expect(est.providerCostMicro).toBe(est.video.providerCostMicro + est.review!.providerCostMicro);
    await t.studio.generateTake(t.projectId, shot.id, "draft");
    await drain(t.studio, t.projectId, 40);
    const video = t.mock.submitted.find((x) => x.job.purpose === "video")!;
    expect(t.mock.submitted.some((x) => x.job.purpose === "frame" && x.job.refs.shotId === shot.id)).toBe(false);
    expect(video.input.prompt).toBe(shot.writtenPrompt);
    expect(video.input.images?.map((i) => i.name)).toEqual(["Penguin.png", "Seal.png"]);
    expect(video.input.image).toBeUndefined();
    expect(video.input.durationS).toBe(11);
    const review = t.mock.submitted.find((x) => x.job.purpose === "review")!;
    expect(review.input.images).toHaveLength(1);
    expect(review.input.images![0]!.contentType).toBe("image/jpeg");
    expect(review.input.prompt).toMatch(/contact sheet of a 11\.0 s clip/);
    expect(review.input.prompt).toMatch(/Shot 2, 3\.00-6\.00 s: MCU/);
    p = await t.store.get(t.projectId);
    const take = findShot(p, shot.id).shot.takes[0]!;
    expect(take.byReference).toBe(true);
    expect(take.frameMediaId).toBeTruthy(); // a stand-in from the clip, for the cards
    expect(take.prompt).toBe(shot.writtenPrompt);
    expect(take.review).toMatchObject({ status: "done", pass: true });
    const lines = p.costLog.filter((l) => l.shotId === shot.id).map((l) => l.purpose);
    expect(lines).toEqual(["write", "video", "review"]);
  });

  it("a failed check offers a retake with the corrected prompt at its price; the automatic retake runs at most once per shot", async () => {
    const fail = (n: number) =>
      JSON.stringify({
        pass: false,
        problems: [{ at: 4.5, text: `Two penguins on the floe (check ${n})` }, "The seal is a harbour seal"],
        fixedPrompt: `${kungFuShot().logline} ${EM} Count of penguins in frame: two.\n\n0.00-3.00: fixed.\n\nHard cut.\n\n3.00-6.00: fixed.\n\nHard cut.\n\n6.00-9.00: fixed.\n\nHard cut.\n\n9.00-11.00: fixed.`,
      });
    const t = await actionProject({ review: fail });
    await t.studio.storyboard(t.projectId, t.sceneId);
    await t.store.mutate(t.projectId, (p) => {
      p.episodes[0]!.scenes[0]!.autoRetake = true;
    });
    let p = await t.store.get(t.projectId);
    const shotId = p.episodes[0]!.scenes[0]!.shots[0]!.id;
    await t.studio.generateTake(t.projectId, shotId, "draft");
    await drain(t.studio, t.projectId, 60);
    p = await t.store.get(t.projectId);
    const shot = findShot(p, shotId).shot;
    // The first take failed its check, so one automatic retake ran; that one failed too, and nothing more ran.
    expect(shot.takes).toHaveLength(2);
    const [first, second] = shot.takes;
    expect(first!.review).toMatchObject({ status: "done", pass: false });
    expect(first!.review!.problems[0]).toEqual({ atS: 4.5, text: "Two penguins on the floe (check 1)" });
    expect(first!.review!.problems[1]).toEqual({ atS: null, text: "The seal is a harbour seal" });
    expect(second).toMatchObject({ retakeOf: first!.id, autoRetake: true });
    // The retake sent the corrected prompt, with our counts put back and no dashes.
    expect(second!.prompt).toMatch(/0\.00-3\.00: fixed\./);
    expect(second!.prompt).toMatch(/CONSTRAINTS: Count of penguins in frame: one\./);
    expect(second!.prompt).not.toMatch(/in frame: two/);
    expect(second!.prompt).not.toMatch(DASHES);
    expect(shot.writtenPrompt).toBe(second!.prompt);
    // "Retake with fix" is priced: the take again, with nothing to write first.
    const r = t.studio.estimateRetake(p, shotId, second!.id);
    expect(r.write).toBeNull();
    expect(r.providerCostMicro).toBe(r.video.providerCostMicro + r.review!.providerCostMicro);
    // By hand, it can still be asked for.
    await t.studio.retakeWithFix(t.projectId, shotId, second!.id);
    await drain(t.studio, t.projectId, 60);
    p = await t.store.get(t.projectId);
    expect(findShot(p, shotId).shot.takes).toHaveLength(3);
    expect(findShot(p, shotId).shot.takes[2]!.autoRetake).toBeUndefined();
    expect(p.costLog.filter((l) => l.purpose === "review")).toHaveLength(3);
  });

  it("starts from a first frame of the first beat when the scene asks for it", async () => {
    const t = await actionProject({ start: "first-frame" });
    await t.studio.storyboard(t.projectId, t.sceneId);
    let p = await t.store.get(t.projectId);
    // A first-frame scene gets its master still.
    expect(p.episodes[0]!.scenes[0]!.master?.status).toBe("running");
    await drain(t.studio, t.projectId, 40);
    p = await t.store.get(t.projectId);
    const shot = p.episodes[0]!.scenes[0]!.shots[1]!;
    expect(t.studio.estimateTake(p, shot.id, "draft").byReference).toBe(false);
    await t.studio.generateTake(t.projectId, shot.id, "draft");
    await drain(t.studio, t.projectId, 40);
    const frame = t.mock.submitted.filter((x) => x.job.purpose === "frame").at(-1)!;
    expect(frame.input.prompt).toMatch(/Shot: The seal alone on the floe\. The seal grins\./);
    expect(frame.input.prompt).toMatch(/Where everyone is at this moment: The seal alone on the floe\./);
    expect(frame.input.prompt).toMatch(/Count of penguins in frame: one\./);
    const video = t.mock.submitted.filter((x) => x.job.purpose === "video").at(-1)!;
    expect(video.input.images).toBeUndefined();
    expect(video.input.prompt).not.toMatch(/^References:/);
    expect(video.input.prompt).toMatch(/Hard cut\./);
  });

  it("editing the beats marks the written prompt out of date; the next take rewrites it first, and its price says so", async () => {
    const t = await actionProject();
    await t.studio.storyboard(t.projectId, t.sceneId);
    let p = await t.store.get(t.projectId);
    const shot = p.episodes[0]!.scenes[0]!.shots[1]!;
    await t.store.mutate(t.projectId, (x) => {
      updateShot(x, shot.id, { beats: shot.beats.map((b, i) => (i === 0 ? { ...b, action: "The seal grins wider." } : b)) });
    });
    p = await t.store.get(t.projectId);
    expect(findShot(p, shot.id).shot.promptStale).toBe(true);
    const est = t.studio.estimateTake(p, shot.id, "draft");
    expect(est.write).not.toBeNull();
    expect(est.providerCostMicro).toBe(est.video.providerCostMicro + est.write!.providerCostMicro + est.review!.providerCostMicro);
    await t.studio.generateTake(t.projectId, shot.id, "draft");
    p = await t.store.get(t.projectId);
    const after = findShot(p, shot.id).shot;
    expect(after.promptStale).toBe(false);
    expect(after.writtenPrompt).toMatch(/The seal grins wider\./);
    // Saving the creator's own words keeps them and clears the warning.
    await t.store.mutate(t.projectId, (x) => {
      updateShot(x, shot.id, { beats: after.beats.map((b, i) => (i === 1 ? { ...b, lens: "35mm" } : b)) });
      updateShot(x, shot.id, { writtenPrompt: "My own prompt." });
    });
    p = await t.store.get(t.projectId);
    expect(findShot(p, shot.id).shot).toMatchObject({ writtenPrompt: "My own prompt.", promptStale: false });
  });

  it("a sequence can't be split, and merging two sequences joins their shots in time", () => {
    const project = createProject({ name: "x" });
    const scene = addScene(addEpisode(project, { title: "e" }), { heading: "h" });
    const a = addShot(scene, { description: "a", durationS: 11, beats: kungFuShot().beats });
    addShot(scene, { description: "b", durationS: 4, beats: [{ ...kungFuShot().beats[0]!, startS: 0, endS: 4 }] });
    expect(() => splitShot(project, a.id)).toThrow(/sequence/);
    const merged = mergeWithNext(project, a.id);
    expect(merged.beats.map((b) => [b.startS, b.endS]).at(-1)).toEqual([11, 15]);
    expect(merged.durationS).toBe(15);
  });
});

describe("old projects and ordinary shots", () => {
  it("reads a project saved before sequences: shots, scenes and takes get empty defaults", () => {
    const old = {
      format: 1,
      id: "prj_old",
      name: "Old",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      episodes: [
        {
          id: "ep",
          title: "E",
          scenes: [
            {
              id: "sc",
              heading: "INT. ROOM",
              shots: [
                {
                  id: "sh",
                  description: "Nora looks up.",
                  durationS: 5,
                  takes: [
                    { id: "tk", tier: "draft", imageModel: "a", videoModel: "b", status: "done", createdAt: "2026-10-01T00:00:00.000Z" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const p = Project.parse(old);
    const sc = p.episodes[0]!.scenes[0]!;
    expect(sc).toMatchObject({
      cutting: "cuts",
      plate: "",
      counts: [],
      castNotes: [],
      whitelist: [],
      start: "references",
      autoRetake: false,
    });
    expect(sc.shots[0]).toMatchObject({
      beats: [],
      logline: "",
      startState: "",
      sounds: [],
      slowMotion: false,
      writtenPrompt: "",
      promptStale: false,
    });
    expect(sc.shots[0]!.takes[0]!.review).toBeUndefined();
  });

  it("an ordinary shot keeps working as before: template prompt, a first frame, no write and no automatic check", async () => {
    const t = setup();
    const project = createProject({ name: "Plain" });
    const nora = addCast(project, { kind: "character", name: "NORA", description: "red hair" });
    const scene = addScene(addEpisode(project, { title: "e" }), { heading: "INT. ROOM" });
    const shot = addShot(scene, {
      description: "Nora sprints for the door.",
      camera: "handheld, following",
      castIds: [nora.id],
      durationS: 5,
    });
    t.store.create(project);
    const p = await t.store.get(project.id);
    const est = t.studio.estimateTake(p, shot.id, "draft");
    expect(est).toMatchObject({ write: null, review: null, byReference: false });
    await t.studio.generateTake(project.id, shot.id, "draft");
    await drain(t.studio, project.id);
    const video = t.mock.submitted.find((x) => x.job.purpose === "video")!;
    expect(video.input.prompt).toMatch(/^Nora sprints for the door\. Camera: handheld, following\./);
    expect(video.input.prompt).toMatch(/Exactly one of each: NORA; nobody is doubled\./);
    expect(video.input.prompt).not.toMatch(/drifts slowly|breathes, blinks/);
    expect(t.mock.submitted.some((x) => x.job.purpose === "review")).toBe(false);
    const after = await t.store.get(project.id);
    expect(after.costLog.map((l) => l.purpose)).toEqual(["frame", "video"]);
    expect(findShot(after, shot.id).shot.takes[0]!.prompt).toBe(video.input.prompt);
  });

  it("only a quiet talking shot is told to breathe and blink, and nobody is told to drift the camera", () => {
    const base = {
      id: "s",
      castIds: ["n"],
      dialogue: [{ id: "l", castId: "n", text: "Hello." }],
      durationS: 4,
      audio: "native" as const,
      approved: false,
      takes: [],
      continueFromPrevious: false,
      endPicture: "",
      onScreenText: "",
      cutaway: null,
      joinIn: "cut" as const,
      joinS: 0.5,
      move: "none" as const,
      camera: "",
    };
    const cast = [{ id: "n", kind: "character" as const, name: "NORA", description: "red hair", refImageIds: [] }];
    const talk = videoPrompt({ shot: { ...base, description: "Nora talks quietly." }, cast, nativeAudio: true });
    expect(talk).toMatch(/breathes, blinks and reacts/);
    const fight = videoPrompt({ shot: { ...base, description: "Nora kicks the door while shouting." }, cast, nativeAudio: true });
    expect(fight).not.toMatch(/breathes/);
    expect(`${talk}${fight}`).not.toMatch(/drifts slowly/);
  });
});

describe("the check's answer", () => {
  it("reads fenced JSON, plain-string problems and a missing verdict; refuses an answer with no JSON", () => {
    expect(parseReview('```json\n{"pass":true,"problems":[],"fixedPrompt":"ignored on a pass"}\n```')).toEqual({
      pass: true,
      problems: [],
      fixedPrompt: "",
    });
    const r = parseReview(`Here: {"problems":["two seals", {"at":3.04,"text":"split screen"}], "fixedPrompt":"Fix ${EM} it."}`);
    expect(r.pass).toBe(false);
    expect(r.problems).toEqual([
      { atS: null, text: "two seals" },
      { atS: 3, text: "split screen" },
    ]);
    expect(r.fixedPrompt).toBe("Fix, it.");
    expect(parseReview('{"pass":true,"problems":[{"at":1,"text":"small grain"}]}').pass).toBe(true);
    expect(() => parseReview("Looks fine to me.")).toThrow(/no JSON/);
  });
});

describe("money safety of checks and retakes", () => {
  it("a prompt cut to the stored length keeps its counts and constraints", () => {
    const long = `${"x".repeat(13_000)}\n\n${constraintsBlock(ctx())}`;
    const out = fitPrompt(long);
    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out.endsWith(constraintsBlock(ctx()))).toBe(true);
  });

  it("two presses of Check start one paid check, not two", async () => {
    const t = await actionProject();
    await t.studio.storyboard(t.projectId, t.sceneId);
    const p = await t.store.get(t.projectId);
    const shot = p.episodes[0]!.scenes[0]!.shots[1]!;
    await t.studio.generateTake(t.projectId, shot.id, "draft");
    await drain(t.studio, t.projectId, 40);
    const takeId = findShot(await t.store.get(t.projectId), shot.id).shot.takes[0]!.id;
    const before = t.mock.submitted.filter((x) => x.job.purpose === "review").length;
    await Promise.all([
      t.studio.reviewTake(t.projectId, shot.id, takeId, { again: true }),
      t.studio.reviewTake(t.projectId, shot.id, takeId, { again: true }),
    ]);
    expect(t.mock.submitted.filter((x) => x.job.purpose === "review").length).toBe(before + 1);
  });
});
