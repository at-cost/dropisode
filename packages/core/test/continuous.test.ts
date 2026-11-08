import { describe, expect, it } from "vitest";
import { addEpisode, addScene, addShot, createProject, findShot, updateShot } from "../src/edit";
import { storyboardPrompt, videoPrompt } from "../src/prompts";
import { drain, setup } from "./helpers";

async function scene(o: { endPicture?: string; continues?: boolean } = {}) {
  const t = setup();
  // The fixture's draft video model takes a last frame, like Omni 1.2 and Seedance 2.5.
  t.catalog.get("vid-draft").input.endImage = "end_image_url";
  const project = createProject({ name: "Continuous" });
  const sc = addScene(addEpisode(project, { title: "Ep" }), { heading: "INT. LIVING ROOM - DUSK" });
  const a = addShot(sc, { description: "They sway in the living room.", durationS: 5 });
  const b = addShot(sc, {
    description: "She spins and they are young in a 1962 dance hall.",
    durationS: 5,
    continueFromPrevious: o.continues ?? false,
    endPicture: o.endPicture ?? "",
  });
  t.store.create(project);
  return { ...t, projectId: project.id, a: a.id, b: b.id };
}

describe("continuous takes", () => {
  it("a shot with a target picture makes it from its own first frame, then sends it to the video model as the last frame", async () => {
    const t = await scene({ endPicture: "the same couple young, mid-twirl in a 1962 dance hall" });
    const p = await t.store.get(t.projectId);
    const est = t.studio.estimateTake(p, t.b, "draft");
    expect(est.endFrame).not.toBeNull();
    expect(est.providerCostMicro).toBe(est.frame.providerCostMicro + est.endFrame!.providerCostMicro + est.video.providerCostMicro);
    await t.studio.generateTake(t.projectId, t.b, "draft");
    await drain(t.studio, t.projectId, 40);
    const order = t.mock.submitted.map((x) => x.job.purpose);
    expect(order.indexOf("end_frame")).toBeGreaterThan(order.indexOf("frame"));
    expect(order.indexOf("video")).toBeGreaterThan(order.indexOf("end_frame"));
    const end = t.mock.submitted.find((x) => x.job.purpose === "end_frame")!;
    expect(end.input.prompt).toMatch(/same camera position/);
    expect(end.input.images?.[0]?.name).toMatch(/^START\./);
    const video = t.mock.submitted.find((x) => x.job.purpose === "video")!;
    expect(video.input.endImage).toBeDefined();
    expect(video.input.prompt).toMatch(/By the end of the shot: the same couple young/);
    const take = findShot(await t.store.get(t.projectId), t.b).shot.takes[0]!;
    expect(take.status).toBe("done");
    expect(take.endFrameMediaId).toBeDefined();
  });

  it("no target picture: no extra picture, no last frame sent", async () => {
    const t = await scene();
    expect(t.studio.estimateTake(await t.store.get(t.projectId), t.b, "draft").endFrame).toBeNull();
    await t.studio.generateTake(t.projectId, t.b, "draft");
    await drain(t.studio, t.projectId, 40);
    expect(t.mock.submitted.some((x) => x.job.purpose === "end_frame")).toBe(false);
    expect(t.mock.submitted.find((x) => x.job.purpose === "video")!.input.endImage).toBeUndefined();
  });

  it("measures every finished take, and a shot that continues starts from the previous take's end point", async () => {
    const t = await scene({ continues: true });
    await t.studio.generateTake(t.projectId, t.a, "draft");
    await drain(t.studio, t.projectId, 40);
    const first = findShot(await t.store.get(t.projectId), t.a).shot.takes[0]!;
    expect(first.analysis?.motion.length).toBeGreaterThan(0);
    expect(first.analysis?.jumps).toEqual([]);
    // The user ends the first clip early: the next shot must start there, and the edit must end there.
    await t.store.mutate(t.projectId, (p) => {
      findShot(p, t.a).shot.takes[0]!.outS = 2;
    });
    await t.studio.generateTake(t.projectId, t.b, "draft");
    await drain(t.studio, t.projectId, 40);
    const next = findShot(await t.store.get(t.projectId), t.b).shot.takes[0]!;
    expect(next.status).toBe("done");
    expect(t.mock.submitted.filter((x) => x.job.purpose === "frame")).toHaveLength(1);
  });

  it("the continuous storyboard asks for long chained takes, motion to the end, targets hidden in movement", () => {
    const p = storyboardPrompt({ sceneScript: "x", heading: "INT. ROOM", cast: [], durations: [5, 10, 15], cutting: "continuous" }).prompt;
    expect(p).toMatch(/few long, continuous takes/);
    expect(p).toMatch(/never repeat an action the previous shot already finished/);
    expect(p).toMatch(/never ask it to slow down, settle, hold or freeze/);
    expect(p).toMatch(/"endPicture"/);
    expect(p).not.toMatch(/"cutaway":/);
    const cuts = storyboardPrompt({ sceneScript: "x", heading: "INT. ROOM", cast: [], durations: [4], cutting: "cuts" }).prompt;
    expect(cuts).toMatch(/every 2 to 4 seconds/);
  });

  it("a shot without a target is not told to keep moving through its end", () => {
    const base = {
      id: "s",
      castIds: [],
      dialogue: [],
      durationS: 5,
      audio: "native" as const,
      approved: false,
      takes: [],
      continueFromPrevious: false,
      onScreenText: "",
      cutaway: null,
      camera: "",
    };
    expect(videoPrompt({ shot: { ...base, description: "x", endPicture: "" }, cast: [], nativeAudio: true })).not.toMatch(
      /By the end of the shot/,
    );
  });

  it("splitting a trimmed shot ends its takes at the split, and the target moves to the second half", async () => {
    const t = await scene({ endPicture: "young in the dance hall" });
    await t.store.mutate(t.projectId, (p) => {
      const sh = findShot(p, t.b).shot;
      sh.durationS = 10;
      sh.takes.push({
        id: "tk",
        tier: "draft",
        imageModel: "img-cheap",
        videoModel: "vid-draft",
        status: "done",
        outS: 8.1,
        createdAt: "",
      });
    });
    const { splitShot } = await import("../src/edit");
    await t.store.mutate(t.projectId, (p) => {
      const [first, second] = splitShot(p, t.b, 5);
      expect(first.takes[0]!.outS).toBe(5);
      expect(first.endPicture).toBe("");
      expect(second.endPicture).toBe("young in the dance hall");
    });
  });

  it("a take still being measured can't be continued from, and the edit and chaining agree on where it ends", async () => {
    const { chainSource } = await import("../src/studio");
    const { takeOutS } = await import("../src/assemble");
    const base = { tier: "draft" as const, imageModel: "i", videoModel: "v", status: "done" as const, videoMediaId: "m", createdAt: "" };
    expect(chainSource({ takes: [{ ...base, id: "a", measuring: true }], selectedTakeId: "a" } as never, "draft")).toBeUndefined();
    // A take from before clips were measured (no analysis, not measuring) can still be continued from.
    expect(chainSource({ takes: [{ ...base, id: "a" }], selectedTakeId: "a" } as never, "draft")?.id).toBe("a");
    const measured = { ...base, id: "a", analysis: { durationS: 6.2, motion: [], jumps: [], suggestedOutS: 4.1 }, outS: 4.1 };
    expect(chainSource({ takes: [measured], selectedTakeId: "a" } as never, "draft")?.id).toBe("a");
    expect(takeOutS(measured, { durationS: 6 })).toBe(4.1);
    expect(takeOutS({ ...measured, outS: undefined }, { durationS: 6 })).toBe(6);
    expect(takeOutS({ ...measured, outS: 6.2 }, { durationS: 6 })).toBe(6.2);
  });

  it("a target picture that fails releases the next shot instead of leaving it queued forever", async () => {
    // Only the target picture's prompt carries the target text, so only it fails.
    const t = await scene({ endPicture: "young in the dance hall [fail]" });
    // Shot b has the target; shot c continues from b.
    await t.store.mutate(t.projectId, (p) => {
      const sc = p.episodes[0]!.scenes[0]!;
      sc.shots.push({ ...sc.shots[1]!, id: "c", endPicture: "", continueFromPrevious: true, takes: [] });
    });
    await t.studio.generateTake(t.projectId, t.b, "draft");
    const c = await t.studio.generateTake(t.projectId, "c", "draft");
    expect(c.status).toBe("queued");
    await drain(t.studio, t.projectId, 40);
    const p = await t.store.get(t.projectId);
    expect(findShot(p, t.b).shot.takes[0]!.status).toBe("failed");
    expect(findShot(p, "c").shot.takes[0]!.status).toBe("failed");
  });
});
