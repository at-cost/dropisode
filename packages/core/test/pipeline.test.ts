import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportProject, importInto, readArchive } from "../src/archive";
import { assembleEpisode } from "../src/assemble";
import { addCast, addEpisode, addScene, addShot, createProject, findShot, projectTotals, updateShot } from "../src/edit";
import { mediaDuration } from "../src/ffmpeg";
import { plainJobError } from "../src/jobs";
import { MockProvider } from "../src/providers/mock";
import { BlockedError, type JobOutcome, type JobRecord, type Provider } from "../src/providers/types";
import { drain, setup } from "./helpers";

async function storyboarded() {
  const t = setup();
  const project = createProject({ name: "The Letter", idea: "A courier finds a letter addressed to herself." });
  t.store.create(project);
  const episodeId = await t.studio.writeScript(project.id, { idea: project.idea });
  const p1 = await t.store.get(project.id);
  const scene = p1.episodes[0]!.scenes[0]!;
  await t.studio.storyboard(project.id, scene.id);
  return { ...t, projectId: project.id, episodeId, sceneId: scene.id };
}

describe("idea to episode", () => {
  it("writes a script, extracts the cast, and storyboards six linked shots", async () => {
    const t = await storyboarded();
    const p = await t.store.get(t.projectId);
    expect(p.cast.map((c) => c.name)).toEqual(["MAYA", "LEO", "CORNER SHOP"]);
    const shots = p.episodes[0]!.scenes[0]!.shots;
    expect(shots).toHaveLength(6);
    expect(shots.reduce((a, s) => a + s.durationS, 0)).toBe(30);
    const maya = p.cast.find((c) => c.name === "MAYA")!;
    expect(shots[1]!.castIds).toContain(maya.id);
    expect(shots[1]!.dialogue[0]!.castId).toBe(maya.id);
    // Two LLM calls (script, storyboard), both in the cost log.
    expect(p.costLog.map((l) => [l.purpose, l.status])).toEqual([
      ["script", "charged"],
      ["storyboard", "charged"],
    ]);
  });

  it("drafts, approves, finals and assembles a playable MP4 with every file and an edit list", async () => {
    const t = await storyboarded();
    let p = await t.store.get(t.projectId);
    for (const c of p.cast) await t.studio.generateCastImage(t.projectId, c.id);
    await drain(t.studio, t.projectId);
    p = await t.store.get(t.projectId);
    expect(p.cast.every((c) => c.refImageIds.length === 1)).toBe(true);

    const shots = p.episodes[0]!.scenes[0]!.shots;
    for (const s of shots) await t.studio.generateTake(t.projectId, s.id, "draft");
    await drain(t.studio, t.projectId);

    // Final needs approval first.
    await expect(t.studio.generateTake(t.projectId, shots[0]!.id, "final")).rejects.toThrow(/Approve/);
    await t.store.mutate(t.projectId, (proj) => {
      for (const s of proj.episodes[0]!.scenes[0]!.shots) updateShot(proj, s.id, { approved: true });
    });
    for (const s of shots) await t.studio.generateTake(t.projectId, s.id, "final");
    await drain(t.studio, t.projectId);

    p = await t.store.get(t.projectId);
    const done = p.episodes[0]!.scenes[0]!.shots.map((s) => s.takes.map((x) => `${x.tier}:${x.status}`));
    expect(done.every((d) => d.join() === "draft:done,final:done")).toBe(true);

    // The frame prompt carries the cast's reference images, every time.
    const frames = t.mock.submitted.filter((x) => x.job.purpose === "frame");
    expect(frames).toHaveLength(12);
    expect(frames.every((f) => (f.input.images?.length ?? 0) >= 1)).toBe(true);
    // Native audio goes to the final model, which supports it.
    const finals = t.mock.submitted.filter((x) => x.job.purpose === "video" && x.job.tier === "final");
    expect(finals.every((f) => f.input.audio === true && f.input.durationS === 6)).toBe(true);

    const outDir = join(t.root, "export");
    const res = await assembleEpisode({ projects: t.store, media: t.store }, t.projectId, t.episodeId, { source: "final", outDir });
    expect(res.skipped).toEqual([]);
    expect(res.shots).toHaveLength(6);
    expect(res.durationS).toBeCloseTo(30, 0);
    expect(await mediaDuration(res.episodeFile)).toBeGreaterThan(29);
    for (const f of ["subtitles.srt", "edit-list.edl", "edit-list.json"]) expect(existsSync(join(outDir, f))).toBe(true);
    expect(readFileSync(join(outDir, "subtitles.srt"), "utf8")).toContain("tomorrow's date");
    expect(readFileSync(join(outDir, "edit-list.edl"), "utf8")).toMatch(/^006 {2}SHOT006/m);

    // Every try has a cost line: 2 LLM + 3 cast images + 6×2 frames + 6×2 videos.
    const totals = projectTotals(p);
    expect(totals.tries).toBe(2 + 3 + 24);
    expect(totals.pending).toBe(0);
    const sum = p.costLog.reduce((a, l) => a + l.estimateMicro, 0);
    const llm = p.costLog.filter((l) => l.kind === "llm").reduce((a, l) => a + l.estimateMicro, 0);
    // Media lines are billed exactly at the estimate (published price × units).
    expect(totals.providerCostMicro).toBe(
      sum - llm + p.costLog.filter((l) => l.kind === "llm").reduce((a, l) => a + l.providerCostMicro, 0),
    );
  });

  it("a rough cut uses drafts and skips shots with nothing finished", async () => {
    const t = await storyboarded();
    const p = await t.store.get(t.projectId);
    const shots = p.episodes[0]!.scenes[0]!.shots;
    await t.studio.generateTake(t.projectId, shots[0]!.id, "draft");
    await drain(t.studio, t.projectId);
    const res = await assembleEpisode({ projects: t.store, media: t.store }, t.projectId, t.episodeId, {
      source: "rough",
      outDir: join(t.root, "rough"),
    });
    expect(res.shots).toHaveLength(1);
    expect(res.skipped).toHaveLength(5);
    await expect(
      assembleEpisode({ projects: t.store, media: t.store }, t.projectId, t.episodeId, { source: "final", outDir: join(t.root, "f") }),
    ).rejects.toThrow(/No approved/);
  });
});

describe("failures and refunds", () => {
  it("a failure the provider didn't bill is a refund line and the take fails", async () => {
    const t = await storyboarded();
    const p = await t.store.get(t.projectId);
    const shot = p.episodes[0]!.scenes[0]!.shots[0]!;
    t.mock.failNext(1, "unbilled");
    await t.studio.generateTake(t.projectId, shot.id, "draft");
    await drain(t.studio, t.projectId);
    const after = await t.store.get(t.projectId);
    const line = after.costLog.find((l) => l.shotId === shot.id)!;
    expect(line).toMatchObject({ status: "refunded", providerCostMicro: 0, purpose: "frame" });
    expect(line.note).toMatch(/not billed/);
    const take = findShot(after, shot.id).shot.takes[0]!;
    expect(take.status).toBe("failed");
    // No video job was started for a failed frame.
    expect(t.mock.submitted.filter((x) => x.job.purpose === "video")).toHaveLength(0);
  });

  it("a failed cast image tells the user why on the card, and the next try clears it", async () => {
    const t = await storyboarded();
    const castId = (await t.store.get(t.projectId)).cast[0]!.id;
    t.mock.failNext(1, "unbilled");
    await t.studio.generateCastImage(t.projectId, castId);
    await drain(t.studio, t.projectId);
    const failed = (await t.store.get(t.projectId)).cast.find((c) => c.id === castId)!;
    expect(failed.refImageIds).toHaveLength(0);
    expect(failed.error).toMatch(/didn't work/);
    expect(failed.error).toMatch(/Nothing was charged/);
    await t.studio.generateCastImage(t.projectId, castId);
    await drain(t.studio, t.projectId);
    const ok = (await t.store.get(t.projectId)).cast.find((c) => c.id === castId)!;
    expect(ok.error).toBeUndefined();
    expect(ok.refImageIds).toHaveLength(1);
  });

  it("a provider account out of credit reads as our problem, not the user's", () => {
    const msg = plainJobError("Not accepted by the provider: fal 403: User is locked. Reason: Exhausted balance.", true);
    expect(msg).toMatch(/paused on our side/);
    expect(msg).toMatch(/Nothing was charged/);
    expect(msg).not.toMatch(/fal/);
  });

  it("a failure the provider billed is charged and says so", async () => {
    const t = await storyboarded();
    const shot = (await t.store.get(t.projectId)).episodes[0]!.scenes[0]!.shots[0]!;
    await t.studio.generateTake(t.projectId, shot.id, "draft");
    t.mock.failNext(1, "billed"); // the video, after the frame
    await drain(t.studio, t.projectId);
    const after = await t.store.get(t.projectId);
    const video = after.costLog.find((l) => l.purpose === "video")!;
    expect(video.status).toBe("failed_billed");
    expect(video.providerCostMicro).toBe(video.estimateMicro);
    expect(video.note).toMatch(/billed it/);
  });

  it("a blocked request spends nothing and leaves no take or cost line", async () => {
    const mock = new MockProvider();
    const blocking: Provider = {
      id: "mock",
      submit: async () => {
        throw new BlockedError("No balance", "insufficient_balance");
      },
      check: (j) => mock.check(j),
      download: (u) => mock.download(u),
    };
    const t = setup({ provider: blocking, mock });
    const project = createProject({ name: "x" });
    t.store.create(project);
    await t.store.mutate(project.id, (p) => {
      addShot(addScene(addEpisode(p, { title: "e" }), { heading: "s" }), { description: "d", durationS: 5 });
    });
    const shot = (await t.store.get(project.id)).episodes[0]!.scenes[0]!.shots[0]!;
    await expect(t.studio.generateTake(project.id, shot.id, "draft")).rejects.toBeInstanceOf(BlockedError);
    const after = await t.store.get(project.id);
    expect(after.costLog).toEqual([]);
    expect(findShot(after, shot.id).shot.takes).toEqual([]);
  });
});

describe("crash safety", () => {
  it("finalize runs once per job even when it crashed the first time", async () => {
    const mock = new MockProvider();
    const settled = new Map<string, number>();
    let crash = true;
    const wrapped: Provider = {
      id: "mock",
      submit: (j, i) => mock.submit(j, i),
      check: (j) => mock.check(j),
      download: (u) => mock.download(u),
      async finalize(job: JobRecord, _o: JobOutcome) {
        if (crash) {
          crash = false;
          throw new Error("worker killed");
        }
        // Idempotent per job id, as the interface requires.
        settled.set(job.id, (settled.get(job.id) ?? 0) + 1);
      },
    };
    const t = setup({ provider: wrapped, mock });
    const project = createProject({ name: "x" });
    t.store.create(project);
    const castId = await t.store.mutate(project.id, (p) => {
      return addCast(p, { kind: "character", name: "A" }).id;
    });
    const job = await t.studio.generateCastImage(project.id, castId);
    await expect(t.studio.runner.check(job.id)).rejects.toThrow(/worker killed/);
    const mid = await t.store.jobs.get(job.id);
    expect(mid).toMatchObject({ state: "done", finalized: false });
    // Restart: resume picks it up, applies (idempotently) and settles.
    await t.studio.tick(project.id);
    const end = await t.store.jobs.get(job.id);
    expect(end?.finalized).toBe(true);
    expect(settled.get(job.id)).toBe(1);
    const p = await t.store.get(project.id);
    expect(p.cast[0]!.refImageIds).toHaveLength(1);
    expect(p.costLog).toHaveLength(1);
    expect(p.costLog[0]!.status).toBe("charged");
  });

  it("a video job is never started twice for one take", async () => {
    const t = await storyboarded();
    const shot = (await t.store.get(t.projectId)).episodes[0]!.scenes[0]!.shots[0]!;
    const take = await t.studio.generateTake(t.projectId, shot.id, "draft");
    await t.studio.tick(t.projectId);
    // Run the frame's completion again, as after a crash.
    await t.studio.runner.complete(`job_f_${take.id}`);
    await t.studio.tick(t.projectId);
    await drain(t.studio, t.projectId);
    expect(t.mock.submitted.filter((x) => x.job.purpose === "video")).toHaveLength(1);
  });
});

describe("export and import", () => {
  it("round-trips a project through a zip with nothing lost", async () => {
    const t = await storyboarded();
    const p0 = await t.store.get(t.projectId);
    for (const c of p0.cast) await t.studio.generateCastImage(t.projectId, c.id);
    await drain(t.studio, t.projectId);
    const p = await t.store.get(t.projectId);
    const zip = await exportProject(p, t.store);
    const imported = readArchive(zip);
    const other = setup();
    const copy = await importInto(imported, other.store, (proj) => other.store.create(proj));
    const back = await other.store.get(copy.id);
    // Media gets new ids in the new store; map them back and nothing else differs.
    const idMap = new Map(back.media.map((m, i) => [m.id, p.media[i]!.id]));
    const unmapped = JSON.parse(JSON.stringify(back).replace(/m_[A-Za-z0-9_-]{8}/g, (id) => idMap.get(id) ?? id));
    expect({ ...unmapped, id: p.id, updatedAt: p.updatedAt, media: [] }).toEqual({ ...p, media: [] });
    expect(back.media.map((m) => m.bytes)).toEqual(p.media.map((m) => m.bytes));
    for (const [i, m] of back.media.entries()) expect(await other.store.read(back.id, m)).toEqual(await t.store.read(p.id, p.media[i]!));
    expect(back.cast.every((c) => c.refImageIds.every((id) => back.media.some((m) => m.id === id)))).toBe(true);
  });

  it("rejects archives with paths outside media/", async () => {
    const { zipSync } = await import("fflate");
    const p = createProject({ name: "x" });
    p.media.push({ id: "m_1", path: "../evil.png", contentType: "image/png", bytes: 1, createdAt: p.createdAt, source: "upload" });
    const zip = zipSync({ "project.json": new TextEncoder().encode(JSON.stringify(p)), "../evil.png": new Uint8Array([1]) });
    expect(() => readArchive(zip)).toThrow(/Bad media path/);
  });
});

describe("critic regressions", () => {
  async function oneShot(t: ReturnType<typeof setup>, opts: { approved?: boolean; audio?: "native" | "tts" } = {}) {
    const project = createProject({ name: "x" });
    t.store.create(project);
    const shotId = await t.store.mutate(project.id, (p) => {
      const a = addCast(p, { kind: "character", name: "A" });
      const sc = addScene(addEpisode(p, { title: "e" }), { heading: "s" });
      const sh = addShot(sc, { description: "d", durationS: 5, castIds: [a.id], dialogue: [{ castId: a.id, text: "Hello there." }] });
      sh.approved = opts.approved ?? false;
      sh.audio = opts.audio ?? "native";
      return sh.id;
    });
    return { projectId: project.id, shotId };
  }

  it("a blocked voice line doesn't delete a take whose frame is already running", async () => {
    const mock = new MockProvider();
    let n = 0;
    const blockTts: Provider = {
      id: "mock",
      submit: (j, i) => {
        if (j.kind === "tts") throw new BlockedError("No balance", "insufficient_balance");
        n++;
        return mock.submit(j, i);
      },
      check: (j) => mock.check(j),
      download: (u) => mock.download(u),
    };
    const t = setup({ provider: blockTts, mock });
    const { projectId, shotId } = await oneShot(t, { approved: true, audio: "tts" });
    await t.studio.generateTake(projectId, shotId, "final");
    await drain(t.studio, projectId);
    const p = await t.store.get(projectId);
    const take = findShot(p, shotId).shot.takes[0]!;
    expect(take).toMatchObject({ status: "done" });
    expect(take.error).toMatch(/Voice lines were not started/);
    expect(n).toBe(2); // frame + video
  });

  it("two final takes never pay twice for the same voice line", async () => {
    const t = setup();
    const { projectId, shotId } = await oneShot(t, { approved: true, audio: "tts" });
    await t.studio.generateTake(projectId, shotId, "final");
    await t.studio.generateTake(projectId, shotId, "final");
    await drain(t.studio, projectId);
    expect(t.mock.submitted.filter((x) => x.job.kind === "tts")).toHaveLength(1);
  });

  it("a submit reply that arrives after the job was closed as lost reopens and settles it", async () => {
    const mock = new MockProvider();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const outcomes: { id: string; billed: boolean; ok: boolean }[] = [];
    const slow: Provider = {
      id: "mock",
      submit: async (j, i) => {
        await gate;
        return mock.submit(j, i);
      },
      check: (j) => mock.check(j),
      download: (u) => mock.download(u),
      finalize: async (j, o) => {
        outcomes.push({ id: j.id, billed: o.providerBilled, ok: o.succeeded });
      },
    };
    const root = setup({ provider: slow, mock });
    const { Studio } = await import("../src/studio");
    const studio = new Studio({
      projects: root.store,
      media: root.store,
      jobs: root.store.jobs,
      provider: slow,
      catalog: root.catalog,
      lostAfterMs: 0,
    });
    const project = createProject({ name: "x" });
    root.store.create(project);
    const castId = await root.store.mutate(project.id, (p) => addCast(p, { kind: "character", name: "A" }).id);
    const pending = studio.generateCastImage(project.id, castId);
    await new Promise((r) => setTimeout(r, 20));
    await studio.tick(project.id); // closes it as lost
    let p = await root.store.get(project.id);
    expect(p.costLog[0]!.status).toBe("refunded");
    release();
    await pending; // the late reply
    await drain(studio, project.id);
    p = await root.store.get(project.id);
    expect(p.costLog[0]!.status).toBe("charged");
    expect(p.costLog[0]!.note).toMatch(/replied late/);
    expect(p.cast[0]!.refImageIds).toHaveLength(1);
    expect(outcomes.map((o) => o.billed)).toEqual([false, true]);
  });

  it("a download glitch is retried, not charged as a lost output", async () => {
    const t = setup();
    const { projectId } = await oneShot(t);
    const castId = (await t.store.get(projectId)).cast[0]!.id;
    t.mock.failDownloads(2);
    const job = await t.studio.generateCastImage(projectId, castId);
    await t.studio.tick(projectId);
    expect(await t.store.jobs.get(job.id)).toMatchObject({ state: "submitted", finalized: false });
    await drain(t.studio, projectId);
    const p = await t.store.get(projectId);
    expect(p.costLog[0]!.status).toBe("charged");
    expect(p.cast[0]!.refImageIds).toHaveLength(1);
  });

  it("waits for the provider's real cost, then settles at it", async () => {
    let known: number | null = null;
    const mock = new MockProvider({ lookupCost: async () => (known === null ? null : { costMicro: known }) });
    const base = setup({ mock });
    const { Studio } = await import("../src/studio");
    const t = {
      ...base,
      studio: new Studio({
        projects: base.store,
        media: base.store,
        jobs: base.store.jobs,
        provider: mock,
        catalog: base.catalog,
        costLookupEveryMs: 0,
      }),
    };
    const { projectId } = await oneShot(t);
    const castId = (await t.store.get(projectId)).cast[0]!.id;
    const job = await t.studio.generateCastImage(projectId, castId);
    await t.studio.tick(projectId);
    let p = await t.store.get(projectId);
    expect(p.costLog[0]).toMatchObject({ status: "pending", note: expect.stringMatching(/confirming the cost/) });
    expect(p.cast[0]!.refImageIds).toHaveLength(1); // the image is usable meanwhile
    expect((await t.store.jobs.get(job.id))!.finalized).toBe(false);
    known = 41_234;
    await t.studio.tick(projectId);
    p = await t.store.get(projectId);
    expect(p.costLog[0]).toMatchObject({ status: "charged", providerCostMicro: 41_234, costSource: "provider" });
    expect(t.mock.finalized).toEqual([job.id]);
  });

  it("falls back to the published price when no cost arrives in time", async () => {
    const mock = new MockProvider({ lookupCost: async () => null });
    const t = setup({ mock });
    const { Studio } = await import("../src/studio");
    const studio = new Studio({ projects: t.store, media: t.store, jobs: t.store.jobs, provider: mock, catalog: t.catalog, costWaitMs: 0 });
    const { projectId } = await oneShot(t);
    const castId = (await t.store.get(projectId)).cast[0]!.id;
    await studio.generateCastImage(projectId, castId);
    await drain(studio, projectId);
    const p = await t.store.get(projectId);
    expect(p.costLog[0]).toMatchObject({ status: "charged", providerCostMicro: 39_000, costSource: "unit_price" });
  });

  it("won't re-storyboard or merge over shots that are still generating", async () => {
    const t = await storyboarded();
    const shots = (await t.store.get(t.projectId)).episodes[0]!.scenes[0]!.shots;
    await t.studio.generateTake(t.projectId, shots[1]!.id, "draft");
    await expect(t.studio.storyboard(t.projectId, t.sceneId)).rejects.toThrow(/still generating/);
    const { mergeWithNext } = await import("../src/edit");
    await expect(t.store.mutate(t.projectId, (p) => mergeWithNext(p, shots[0]!.id))).rejects.toThrow(/still generating/);
  });

  it("assembly doesn't lay TTS over a clip that speaks for itself", async () => {
    const t = setup();
    const { projectId, shotId } = await oneShot(t, { approved: true, audio: "native" });
    await t.store.mutate(projectId, (p) => {
      findShot(p, shotId).shot.dialogue[0]!.ttsMediaId = "m_gone";
    });
    await t.studio.generateTake(projectId, shotId, "final");
    await drain(t.studio, projectId);
    const p = await t.store.get(projectId);
    const res = await assembleEpisode({ projects: t.store, media: t.store }, projectId, p.episodes[0]!.id, {
      source: "final",
      outDir: join(t.root, "x"),
    });
    expect(res.shots).toHaveLength(1);
    expect(readFileSync(join(t.root, "x", "subtitles.srt"), "utf8")).toContain("Hello there.");
  });
});

describe("reopen races", () => {
  it("a late reply arriving while the lost-job close is still settling ends up settled as billed", async () => {
    const mock = new MockProvider();
    let releaseSubmit!: () => void;
    const submitGate = new Promise<void>((r) => {
      releaseSubmit = r;
    });
    let releaseFinalize!: () => void;
    const finalizeGate = new Promise<void>((r) => {
      releaseFinalize = r;
    });
    let firstFinalize = true;
    const outcomes: boolean[] = [];
    const provider: Provider = {
      id: "mock",
      submit: async (j, i) => {
        await submitGate;
        return mock.submit(j, i);
      },
      check: (j) => mock.check(j),
      download: (u) => mock.download(u),
      finalize: async (_j, o) => {
        if (firstFinalize) {
          firstFinalize = false;
          await finalizeGate;
        }
        outcomes.push(o.providerBilled);
      },
    };
    const base = setup({ provider, mock });
    const { Studio } = await import("../src/studio");
    const studio = new Studio({
      projects: base.store,
      media: base.store,
      jobs: base.store.jobs,
      provider,
      catalog: base.catalog,
      lostAfterMs: 0,
    });
    const project = createProject({ name: "x" });
    base.store.create(project);
    const castId = await base.store.mutate(project.id, (p) => addCast(p, { kind: "character", name: "A" }).id);
    const started = studio.generateCastImage(project.id, castId);
    await new Promise((r) => setTimeout(r, 20));
    const closing = studio.tick(project.id); // closes as lost, held inside finalize
    await new Promise((r) => setTimeout(r, 20));
    releaseSubmit(); // the late reply arrives while the close is mid-finalize
    await new Promise((r) => setTimeout(r, 20));
    releaseFinalize();
    await closing;
    await started;
    await drain(studio, project.id);
    const p = await base.store.get(project.id);
    expect(p.costLog[0]!.status).toBe("charged");
    expect(outcomes).toEqual([false, true]);
    expect(await base.store.jobs.listUnfinished(project.id)).toEqual([]);
  });
});
