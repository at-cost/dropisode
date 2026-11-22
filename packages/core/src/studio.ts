/**
 * The studio: everything a creator does, on top of the job runner. Local and
 * hosted both build one of these; hosted passes in a provider wrapped with
 * billing and moderation.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Catalog, type CatalogModel, type Estimate, billedDuration, estimate, roughTokens, supportsAspect } from "./catalog";
import {
  EditError,
  addCast,
  addEpisode,
  addScene,
  addShot,
  castByName,
  findCast,
  findEpisode,
  findScene,
  findShot,
  newId,
  sequenceSeconds,
} from "./edit";
import { FPS, takeOutS } from "./assemble";
import { hasAudio, mediaDuration, runFfmpeg } from "./ffmpeg";
import { analyseClip, contactSheet, frameAt } from "./motion";
import { JobRunner, plainJobError, type RunnerDeps } from "./jobs";
import type { Beat, CastMember, MediaRef, Project, Scene, Shot, SoundBed, Take, Tier } from "./project";
import {
  type LlmPrompt,
  castExtractPrompt,
  castImagePrompt,
  framePrompt,
  parseJsonAnswer,
  parseScript,
  parseStoryboard,
  scriptPrompt,
  storyboardPrompt,
  videoPrompt,
  endFramePrompt,
  scriptSpeakers,
  scriptSpeakerFor,
  sceneTargetSeconds,
  normalizeLine,
  scriptVoiceOvers,
  isWideShot,
  sceneMasterPrompt,
  parseStaging,
  parseSequenceBoard,
  sequenceDescription,
} from "./prompts";
import {
  type SequenceContext,
  beatCamera,
  fitPrompt,
  keepsStructure,
  finishWrittenPrompt,
  parseReview,
  refreshConstraints,
  referenceHeader,
  reviewPrompt,
  sequencePrompt,
  withReferenceHeader,
  writerPrompt,
} from "./writer";
import type { JobRecord, MediaInput } from "./providers/types";

export type StudioDeps = RunnerDeps;

export interface TakeEstimate {
  tier: Tier;
  imageModel: string;
  videoModel: string;
  frame: Estimate;
  /** The target picture the clip ends on, when the shot has one and the video model takes one. */
  endFrame: Estimate | null;
  video: Estimate;
  tts: Estimate[];
  /** Writing the sequence's video prompt first, when it has none or it is out of date. */
  write: Estimate | null;
  /** The vision check of the finished clip, when it runs by itself (sequences). */
  review: Estimate | null;
  /** Made from the cast pictures as references: no first frame to pay for. */
  byReference: boolean;
  /** Provider cost of the whole take. */
  providerCostMicro: number;
  durationS: number;
  audio: "native" | "tts" | "none";
}

/** A vision model reads a sheet of frames as about this many input tokens (measured: ~1,100 per picture). */
const SHEET_TOKENS = 1500;

export class Studio {
  readonly runner: JobRunner;
  readonly catalog: Catalog;

  constructor(readonly deps: StudioDeps) {
    this.catalog = deps.catalog;
    this.runner = new JobRunner(deps);
    this.registerHandlers();
  }

  get projects() {
    return this.deps.projects;
  }

  // Estimates

  llmEstimate(p: LlmPrompt, modelId = this.catalog.config.defaults.llm): Estimate {
    return estimate(this.catalog.get(modelId), { inputTokens: roughTokens(p.system + p.prompt), outputTokens: p.maxTokens });
  }

  estimateScript(idea: string, targetSeconds = 30): Estimate {
    const s = this.llmEstimate(scriptPrompt({ idea, targetSeconds, aspect: "9:16" }));
    const c = this.llmEstimate(castExtractPrompt("x".repeat(targetSeconds * 40)));
    return { ...s, units: s.units + c.units, providerCostMicro: s.providerCostMicro + c.providerCostMicro };
  }

  /**
   * Storyboarding a scene: the plan itself and, for sequences, writing each sequence's prompt (about one per
   * 10 seconds), plus the scene's master still when one will be made.
   */
  estimateStoryboard(project: Project, sceneId: string): Estimate {
    const { scene, episode } = findScene(project, sceneId);
    const video = this.catalog.get(this.modelsFor(project, "final").video);
    const target = sceneTargetSeconds(
      scene.script,
      episode.scenes.map((s) => s.script),
    );
    const board = this.llmEstimate(
      storyboardPrompt({
        sceneScript: scene.script,
        heading: scene.heading,
        cast: project.cast,
        durations: video.durations,
        targetSeconds: target,
        cutting: scene.cutting,
      }),
    );
    let micro = board.providerCostMicro;
    let units = board.units;
    if (scene.cutting === "sequences") {
      const w = this.writeEstimateFor(project, sceneId, video);
      const n = Math.max(1, Math.ceil(target / 10));
      micro += w.providerCostMicro * n;
      units += w.units * n;
    }
    if (this.makesMaster(scene, video))
      micro += estimate(this.catalog.get(this.modelsFor(project, "draft").image), { images: 1 }).providerCostMicro;
    return { ...board, units, providerCostMicro: micro };
  }

  /** Sequences that start from the cast pictures need no master still; everything else gets one. */
  private makesMaster(scene: Scene, video: CatalogModel): boolean {
    return !(scene.cutting === "sequences" && scene.start === "references" && video.reference);
  }

  /** What writing one sequence's prompt costs: the writer's prompt for a typical three-shot sequence. */
  private writeEstimateFor(project: Project, sceneId: string, video: CatalogModel, shot?: Shot): Estimate {
    const { scene } = findScene(project, sceneId);
    const beat = (a: number, b: number): Beat => ({
      startS: a,
      endS: b,
      size: "MS",
      angle: "low three-quarter",
      height: "at ground level",
      lens: "35mm",
      movement: "handheld",
      action: "x".repeat(320),
      endState: "x".repeat(90),
    });
    const sample: Shot =
      shot ??
      ({
        ...(scene.shots[0] ?? ({} as Shot)),
        id: "estimate",
        description: "",
        camera: "",
        castIds: project.cast.slice(0, 3).map((c) => c.id),
        dialogue: [],
        durationS: 10,
        beats: [beat(0, 3), beat(3, 7), beat(7, 10)],
        logline: "x".repeat(150),
        startState: "x".repeat(150),
        sounds: ["x".repeat(30), "x".repeat(30), "x".repeat(30), "x".repeat(30)],
        slowMotion: false,
        writtenPrompt: "",
        writtenFor: "",
        promptStale: false,
      } as Shot);
    const ctx = this.contextFor(project, scene, sample, video, []);
    return this.llmEstimate(writerPrompt(ctx, video));
  }

  estimateCastImage(modelId = this.catalog.config.defaults.castImage): Estimate {
    return estimate(this.catalog.get(modelId), { images: 1 });
  }

  /** The models a project uses for a tier: its own choice, else the recommended default. */
  modelsFor(project: Project, tier: Tier): { image: string; video: string; castImage: string } {
    const d = this.catalog.defaultsFor(tier);
    const m = project.models ?? {};
    const ok = (id: string | undefined, kind: "image" | "video") => (id && this.catalog.models.get(id)?.kind === kind ? id : undefined);
    return {
      image: ok(m.image, "image") ?? d.image,
      video: ok(tier === "draft" ? m.draftVideo : m.finalVideo, "video") ?? d.video,
      castImage: ok(m.castImage, "image") ?? this.catalog.config.defaults.castImage,
    };
  }

  /** The exact price shown on a shot's generate button. */
  estimateTake(
    project: Project,
    shotId: string,
    tier: Tier,
    models: { image?: string; video?: string } = {},
    o: { skipWrite?: boolean } = {},
  ): TakeEstimate {
    const { shot, scene } = findShot(project, shotId);
    const d = this.modelsFor(project, tier);
    const image = this.catalog.get(models.image ?? d.image);
    const video = this.catalog.get(models.video ?? d.video);
    const audio =
      tier === "draft" && !this.catalog.config.defaults.draftAudio ? "none" : this.audioPlan(shot.audio, video, shot.dialogue.length > 0);
    // A continued shot takes its first frame from the previous clip: no image to pay for.
    // So does a scene's opening wide shot, which starts on the scene's master still.
    const byReference = this.referenceMembers(project, shotId, video).length > 0;
    const frame =
      byReference || continuesFrom(project, shotId) || opensOnMaster(project, shotId)
        ? estimate(image, { images: 0 })
        : estimate(image, { images: 1 });
    const vid = estimate(video, { durationS: shot.durationS, audio: this.clipAudio(audio, video, tier) });
    const endFrame = !byReference && wantsEndFrame(shot, video) ? estimate(image, { images: 1 }) : null;
    const write = !o.skipWrite && needsWrite(shot) ? this.writeEstimateFor(project, scene.id, video, shot) : null;
    const review = shot.beats.length ? this.estimateReview(project, shotId) : null;
    const tts =
      audio === "tts"
        ? shot.dialogue
            .filter((l) => l.text.trim() && !l.ttsMediaId)
            .map((l) => estimate(this.catalog.get(this.catalog.config.defaults.tts), { chars: l.text.length }))
        : [];
    return {
      tier,
      imageModel: image.id,
      videoModel: video.id,
      frame,
      endFrame,
      video: vid,
      tts,
      write,
      review,
      byReference,
      providerCostMicro:
        frame.providerCostMicro +
        (endFrame?.providerCostMicro ?? 0) +
        vid.providerCostMicro +
        tts.reduce((a, e) => a + e.providerCostMicro, 0) +
        (write?.providerCostMicro ?? 0) +
        (review?.providerCostMicro ?? 0),
      durationS: billedDuration(video, shot.durationS),
      audio,
    };
  }

  /** Writing (or rewriting) one sequence's prompt. */
  estimateWrite(project: Project, shotId: string): Estimate {
    const { shot, scene } = findShot(project, shotId);
    return this.writeEstimateFor(project, scene.id, this.catalog.get(this.modelsFor(project, "final").video), shot);
  }

  /** One vision check of a finished take (null when no checking model is set). */
  estimateReview(project: Project, shotId: string): Estimate | null {
    const id = this.catalog.config.defaults.review;
    if (!id) return null;
    const { shot, scene } = findShot(project, shotId);
    const video = this.catalog.get(this.modelsFor(project, "final").video);
    const ctx = this.contextFor(project, scene, shot, video, []);
    const sent = shot.writtenPrompt || "x".repeat(4000);
    const p = reviewPrompt({
      ctx,
      sentPrompt: sent,
      sheet: { times: Array.from({ length: 16 }, (_, i) => i), cols: 4, rows: 4 },
      clipS: 16,
    });
    return estimate(this.catalog.get(id), { inputTokens: roughTokens(p.system + p.prompt) + SHEET_TOKENS, outputTokens: p.maxTokens });
  }

  /** "Retake with fix": the same tier again with the corrected prompt (nothing to write first). */
  estimateRetake(project: Project, shotId: string, takeId: string): TakeEstimate {
    const { shot } = findShot(project, shotId);
    const take = shot.takes.find((t) => t.id === takeId);
    if (!take) throw new EditError("No such take", "not_found");
    return this.estimateTake(
      project,
      shotId,
      take.tier,
      { image: take.imageModel, video: take.videoModel },
      { skipWrite: !!take.review?.fixedPrompt.trim() },
    );
  }

  // Sequences: the plan, the written prompt, the cast pictures as references

  /** Everything the writer and the check need to know about one shot. */
  private contextFor(project: Project, scene: Scene, shot: Shot, video: CatalogModel, references: string[]): SequenceContext {
    const cast = shot.castIds.map((id) => project.cast.find((c) => c.id === id)).filter((c): c is CastMember => !!c);
    const location = scene.locationId ? project.cast.find((c) => c.id === scene.locationId) : undefined;
    return {
      shot,
      scene,
      cast,
      location,
      aspect: project.aspect,
      nativeAudio: video.nativeAudio && shot.audio !== "none",
      references,
      ...(video.reference ? { imageToken: video.reference.imageToken } : {}),
    };
  }

  /**
   * The cast pictures a sequence sends as references, in order: characters, then props, then the place.
   * Empty when the shot starts from a first frame instead (an ordinary shot, a continued one, a model without
   * a reference endpoint, the scene set to first frames, or nobody has a picture).
   */
  referenceMembers(project: Project, shotId: string, video: CatalogModel): { member: CastMember; name: string; media: MediaRef }[] {
    const { shot, scene } = findShot(project, shotId);
    if (!shot.beats.length || scene.start !== "references" || !video.reference || continuesFrom(project, shotId)) return [];
    const order = { character: 0, prop: 1, location: 2 } as const;
    const ids = [...new Set([...shot.castIds, ...(scene.locationId ? [scene.locationId] : [])])];
    const out: { member: CastMember; name: string; media: MediaRef }[] = [];
    for (const m of ids
      .map((id) => project.cast.find((c) => c.id === id))
      .filter((c): c is CastMember => !!c)
      .sort((a, b) => order[a.kind] - order[b.kind])) {
      const media = m.refImageIds.map((id) => project.media.find((x) => x.id === id)).find((x) => x && !x.hidden);
      if (!media) continue;
      const name = m.kind === "location" ? `the place (${m.name})` : m.name.trim().toUpperCase();
      out.push({ member: m, name, media });
    }
    // A picture of the place alone doesn't hold anyone's look: references only when a character or prop has one.
    if (!out.some((x) => x.member.kind !== "location")) return [];
    return out.slice(0, video.reference.maxImages);
  }

  /**
   * The exact video prompt a take of this shot sends: its written prompt (with the reference line matching
   * the pictures sent), else a sequence's plan, else the template for an ordinary shot.
   */
  videoPromptFor(project: Project, shotId: string, video: CatalogModel, tier: Tier, endPicture?: string): string {
    const { shot, scene } = findShot(project, shotId);
    const refs = this.referenceMembers(project, shotId, video).map((r) => r.name);
    const header = refs.length ? referenceHeader(refs, video.reference?.imageToken) : "";
    if (shot.writtenPrompt.trim()) return withReferenceHeader(shot.writtenPrompt.trim(), header);
    if (shot.beats.length) return sequencePrompt(this.contextFor(project, scene, shot, video, refs));
    const cast = shot.castIds.map((id) => project.cast.find((c) => c.id === id)).filter((c): c is CastMember => !!c);
    const plan = this.audioPlan(shot.audio, video, shot.dialogue.length > 0);
    return videoPrompt({
      shot: { ...shot, endPicture: endPicture ?? shot.endPicture },
      cast,
      nativeAudio: this.clipAudio(plan, video, tier),
      speak: plan === "native",
      counts: scene.counts,
    });
  }

  /**
   * After the scene's plan changes: counts, whitelist and sides are code, so every written prompt in the scene
   * gets them put back at once; a change to the world, grade or characters' notes makes the prompts out of date.
   * Runs inside a project mutation.
   */
  refreshScenePrompts(project: Project, sceneId: string, o: { prose: boolean; shotId?: string }): void {
    const { scene } = findScene(project, sceneId);
    const video = this.catalog.get(this.modelsFor(project, "final").video);
    for (const sh of scene.shots) {
      if (!sh.beats.length || !sh.writtenPrompt.trim() || (o.shotId && sh.id !== o.shotId)) continue;
      const refs = this.referenceMembers(project, sh.id, video).map((r) => r.name);
      sh.writtenPrompt = fitPrompt(refreshConstraints(sh.writtenPrompt, this.contextFor(project, scene, sh, video, refs)));
      if (o.prose) sh.promptStale = true;
    }
  }

  /**
   * Writes a sequence's final video prompt for its video model (an LLM step with its own cost line), with the
   * counts and constraints added in code. Falls back to the plan's own prompt if the answer loses its shape.
   */
  async writeShotPrompt(projectId: string, shotId: string, p: { owner?: Record<string, string> } = {}): Promise<string> {
    const project = await this.projects.get(projectId);
    const { shot, scene, episode } = findShot(project, shotId);
    if (!shot.beats.length) throw new EditError("Only a sequence (a shot with several shots inside it) has a prompt to write");
    const video = this.catalog.get(this.modelsFor(project, "final").video);
    const refs = this.referenceMembers(project, shotId, video).map((r) => r.name);
    const ctx = this.contextFor(project, scene, shot, video, refs);
    const plan = planPrint(shot);
    const { text } = await this.llm(
      projectId,
      "write",
      writerPrompt(ctx, video),
      { episodeId: episode.id, sceneId: scene.id, shotId },
      p.owner,
    );
    const prompt = fitPrompt(finishWrittenPrompt(text, ctx).prompt);
    await this.projects.mutate(projectId, (proj) => {
      const s = findShot(proj, shotId).shot;
      s.writtenPrompt = prompt;
      s.writtenFor = video.id;
      // Edited while the prompt was being written: it stays out of date.
      s.promptStale = planPrint(s) !== plan;
    });
    return prompt;
  }

  /** Whether the video model makes sound: its own voices, or room sound under voice-over lines. */
  private clipAudio(plan: "native" | "tts" | "none", video: CatalogModel, tier: Tier): boolean {
    if (tier === "draft" && !this.catalog.config.defaults.draftAudio) return false;
    return plan === "native" || (plan === "tts" && !!video.nativeAudio);
  }

  private audioPlan(mode: "native" | "tts" | "none", video: CatalogModel, hasDialogue: boolean): "native" | "tts" | "none" {
    if (mode === "none") return "none";
    if (mode === "native" && video.nativeAudio) return "native";
    return hasDialogue ? "tts" : "none";
  }

  // LLM steps (the creator waits for these)

  private async llm(
    projectId: string,
    purpose: string,
    p: LlmPrompt,
    refs: JobRecord["refs"] = {},
    owner?: Record<string, string>,
  ): Promise<{ text: string; jobId: string }> {
    const modelId = this.catalog.config.defaults.llm;
    const est = this.llmEstimate(p, modelId);
    const job = await this.runner.start({
      projectId,
      kind: "llm",
      purpose,
      modelId,
      tier: null,
      refs,
      input: { prompt: p.prompt, system: p.system, maxTokens: p.maxTokens },
      estimateInput: { inputTokens: est.units - p.maxTokens, outputTokens: p.maxTokens },
      ...(owner ? { owner } : {}),
    });
    const done = await this.runner.wait(job.id);
    if (done.state !== "done") throw new Error(done.error ?? "The script model failed");
    return { text: done.result?.text ?? "", jobId: done.id };
  }

  /**
   * Idea → script → episode with scenes, and any new cast members. Returns the episode id.
   * The script is editable afterwards; nothing here is final.
   */
  async writeScript(
    projectId: string,
    p: { idea: string; targetSeconds?: number; episodeTitle?: string; owner?: Record<string, string> },
  ): Promise<string> {
    const project = await this.projects.get(projectId);
    const { text, jobId } = await this.llm(
      projectId,
      "script",
      scriptPrompt({ idea: p.idea, targetSeconds: p.targetSeconds ?? 30, aspect: project.aspect }),
      {},
      p.owner,
    );
    return this.importScript(projectId, {
      script: text,
      ...(p.episodeTitle ? { title: p.episodeTitle } : {}),
      extractCast: true,
      ...(p.owner ? { owner: p.owner } : {}),
      costJobIds: [jobId],
    });
  }

  /** Pasted or written script → episode with scenes. Cast comes from a CAST: block, or the LLM if asked. */
  async importScript(
    projectId: string,
    p: { script: string; title?: string; episodeId?: string; extractCast?: boolean; owner?: Record<string, string>; costJobIds?: string[] },
  ): Promise<string> {
    const parsed = parseScript(p.script);
    let cast = parsed.cast;
    const costJobIds = [...(p.costJobIds ?? [])];
    if (cast.length === 0 && p.extractCast) {
      try {
        const answer = await this.llm(projectId, "cast_extract", castExtractPrompt(p.script), {}, p.owner);
        costJobIds.push(answer.jobId);
        cast = parseJsonAnswer<{ cast: typeof cast }>(answer.text).cast ?? [];
      } catch {
        cast = [];
      }
    }
    return this.projects.mutate(projectId, (project) => {
      for (const c of cast) {
        if (!c?.name || castByName(project, c.name)) continue;
        addCast(project, {
          kind: ["character", "location", "prop"].includes(c.kind) ? c.kind : "character",
          name: c.name,
          description: c.description ?? "",
        });
      }
      let ep = p.episodeId ? findEpisode(project, p.episodeId) : undefined;
      if (ep) {
        assertNothingRunning(ep.scenes.flatMap((sc) => sc.shots));
        ep.script = p.script;
        ep.scenes = [];
      } else {
        ep = addEpisode(project, { title: p.title || parsed.title || `Episode ${project.episodes.length + 1}`, script: p.script });
      }
      for (const s of parsed.scenes) {
        const loc = project.cast.find((c) => c.kind === "location" && s.heading.toLowerCase().includes(c.name.toLowerCase()));
        addScene(ep, { heading: s.heading, script: s.text, locationId: loc?.id ?? null });
      }
      // The script's own cost belongs to the episode it made.
      const epId = ep.id;
      for (const line of project.costLog) if (costJobIds.includes(line.jobId)) line.episodeId = epId;
      return ep.id;
    });
  }

  /** Scene → shot cards (replaces the scene's shots). */
  async storyboard(
    projectId: string,
    sceneId: string,
    p: { targetSeconds?: number; owner?: Record<string, string> } = {},
  ): Promise<number> {
    const project = await this.projects.get(projectId);
    const { scene, episode } = findScene(project, sceneId);
    assertNothingRunning(scene.shots);
    const video = this.catalog.get(this.modelsFor(project, "final").video);
    const targetSeconds =
      p.targetSeconds ??
      sceneTargetSeconds(
        scene.script,
        episode.scenes.map((s) => s.script),
      );
    const { text: answer } = await this.llm(
      projectId,
      "storyboard",
      storyboardPrompt({
        sceneScript: scene.script,
        heading: scene.heading,
        cast: project.cast,
        durations: video.durations,
        targetSeconds,
        silentVideo: !video.nativeAudio,
        cutting: scene.cutting,
      }),
      { episodeId: episode.id, sceneId },
      p.owner,
    );
    if (scene.cutting === "sequences") return this.applySequenceBoard(projectId, sceneId, answer, video, p.owner);
    const shots = parseStoryboard(answer);
    const staging = parseStaging(answer);
    const speakers = scriptSpeakers(scene.script);
    const voiceOvers = scriptVoiceOvers(scene.script);
    const n = await this.projects.mutate(projectId, (proj) => {
      const { scene: sc } = findScene(proj, sceneId);
      assertNothingRunning(sc.shots);
      sc.shots = [];
      for (const s of shots) {
        const castIds = (s.cast ?? []).map((n) => castByName(proj, n)?.id).filter((x): x is string => !!x);
        if (sc.locationId && !castIds.includes(sc.locationId)) castIds.push(sc.locationId);
        const lines = (s.dialogue ?? []).filter((d) => d.text.trim());
        // Heard, not seen spoken: the storyboard says so, or the script marks every line V.O.
        const voiceOver = lines.length > 0 && (s.voiceOver || lines.every((d) => voiceOvers.has(normalizeLine(d.text))));
        const prevSpeaks = (sc.shots.at(-1)?.dialogue.length ?? 0) > 0 && !sc.shots.at(-1)?.cutaway;
        addShot(sc, {
          description: s.description,
          camera: s.camera ?? "",
          castIds,
          dialogue: (s.dialogue ?? []).map((d) => {
            // The script's speaker wins; someone outside the cast is the narrator.
            const who = scriptSpeakerFor(speakers, d.text) ?? d.speaker;
            return { castId: who ? (castByName(proj, who)?.id ?? null) : null, text: d.text };
          }),
          durationS: s.duration ?? 8,
          continueFromPrevious: !!s.continues && sc.shots.length > 0,
          endPicture: sc.cutting === "continuous" ? (s.endPicture ?? "") : "",
          onScreenText: "",
          audio: voiceOver ? "tts" : "native",
          // A cutaway plays over the speaking shot before it; anything else is an ordinary shot.
          cutaway: s.cutaway && !lines.length && prevSpeaks ? { atS: s.cutaway.at, lengthS: s.cutaway.length } : null,
        });
      }
      sc.master = null;
      sc.staging = staging;
      return sc.shots.length;
    });
    // A fresh master still for the new staging; shots drafted meanwhile wait for it.
    await this.makeSceneMaster(projectId, sceneId, p.owner).catch(() => {});
    return n;
  }

  /** A sequences storyboard: the scene's plan, one shot per sequence with its beats, then each sequence's prompt written. */
  private async applySequenceBoard(
    projectId: string,
    sceneId: string,
    answer: string,
    video: CatalogModel,
    owner?: Record<string, string>,
  ): Promise<number> {
    const plan = parseSequenceBoard(answer);
    const project = await this.projects.get(projectId);
    const speakers = scriptSpeakers(findScene(project, sceneId).scene.script);
    const maxS = video.durations.length ? Math.max(...video.durations) : 30;
    const ids = await this.projects.mutate(projectId, (proj) => {
      const { scene: sc } = findScene(proj, sceneId);
      assertNothingRunning(sc.shots);
      sc.shots = [];
      sc.staging = plan.staging;
      sc.plate = plan.plate;
      sc.grade = plan.grade;
      sc.castNotes = plan.castNotes;
      sc.counts = plan.counts;
      sc.whitelist = plan.whitelist;
      sc.master = null;
      for (const q of plan.sequences) {
        const beats = fitBeats(q.beats, video, maxS);
        const castIds = q.cast.map((n) => castByName(proj, n)?.id).filter((x): x is string => !!x);
        if (sc.locationId && !castIds.includes(sc.locationId)) castIds.push(sc.locationId);
        addShot(sc, {
          description: sequenceDescription({ logline: q.logline, beats }),
          camera: beats[0] ? beatCamera(beats[0]).slice(0, 500) : "",
          castIds,
          dialogue: q.dialogue.map((d) => {
            const who = scriptSpeakerFor(speakers, d.text) ?? d.speaker;
            return { castId: who ? (castByName(proj, who)?.id ?? null) : null, text: d.text };
          }),
          durationS: sequenceSeconds(beats),
          audio: "native",
          beats,
          logline: q.logline,
          startState: q.start,
          sounds: q.sounds,
          slowMotion: q.slowMotion,
        });
      }
      return sc.shots.map((x) => x.id);
    });
    // Each sequence's prompt, written for the video model (in parallel). One that fails keeps the plan's own prompt.
    await Promise.all(
      ids.map((id) =>
        this.writeShotPrompt(projectId, id, owner ? { owner } : {}).catch(async () => {
          const proj = await this.projects.get(projectId);
          const prompt = this.videoPromptFor(proj, id, video, "final");
          await this.projects.mutate(projectId, (x) => {
            const sh = findShot(x, id).shot;
            if (!sh.writtenPrompt) {
              sh.writtenPrompt = prompt;
              sh.writtenFor = video.id;
            }
          });
        }),
      ),
    );
    const after = await this.projects.get(projectId);
    if (this.makesMaster(findScene(after, sceneId).scene, video)) await this.makeSceneMaster(projectId, sceneId, owner).catch(() => {});
    return ids.length;
  }

  // Cast images

  async generateCastImage(
    projectId: string,
    castId: string,
    p: { modelId?: string; owner?: Record<string, string> } = {},
  ): Promise<JobRecord> {
    const project = await this.projects.get(projectId);
    const member = findCast(project, castId);
    const modelId = p.modelId ?? this.modelsFor(project, "draft").castImage;
    if (member.error) {
      await this.projects.mutate(projectId, (pr) => {
        const c = pr.cast.find((x) => x.id === castId);
        if (c) delete c.error;
      });
    }
    return this.runner.start({
      projectId,
      kind: "image",
      purpose: "cast_image",
      modelId,
      tier: null,
      refs: { castId },
      input: { prompt: castImagePrompt(member), aspect: member.kind === "character" ? "9:16" : project.aspect },
      estimateInput: { images: 1 },
      ...(p.owner ? { owner: p.owner } : {}),
    });
  }

  /** Adds an uploaded reference image. Photos of real people need the uploader's consent confirmation. */
  async addCastImage(
    projectId: string,
    castId: string,
    file: { bytes: Uint8Array; contentType: string },
    p: { consent: boolean },
  ): Promise<MediaRef> {
    if (!/^image\/(png|jpeg|webp)$/.test(file.contentType)) throw new EditError("Reference images must be PNG, JPEG or WebP");
    if (!p.consent) throw new EditError("Confirm you have consent from anyone real shown in this photo");
    const ref = await this.deps.media.put(projectId, { bytes: file.bytes, contentType: file.contentType, source: "upload" });
    await this.projects.mutate(projectId, (project) => {
      const c = findCast(project, castId);
      project.media.push(ref);
      c.refImageIds.unshift(ref.id);
      c.consentConfirmed = true;
    });
    return ref;
  }

  // Shots

  /** Starts a take: first frame, then (automatically) image-to-video. Returns the take. */
  async generateTake(
    projectId: string,
    shotId: string,
    tier: Tier,
    p: { image?: string; video?: string; owner?: Record<string, string>; retakeOf?: string; autoRetake?: boolean } = {},
  ): Promise<Take> {
    let project = await this.projects.get(projectId);
    const first = findShot(project, shotId);
    if (tier === "final" && !first.shot.approved) throw new EditError("Approve this shot before sending it to final", "not_approved");
    // A sequence with no prompt yet, or one out of date: write it first (priced in the take's estimate).
    if (needsWrite(first.shot)) {
      await this.writeShotPrompt(projectId, shotId, p.owner ? { owner: p.owner } : {});
      project = await this.projects.get(projectId);
    }
    const { shot, scene } = findShot(project, shotId);
    if (!shot.beats.length && shot.writtenPrompt.trim() && shot.promptStale)
      throw new EditError(
        "This shot changed after its own prompt was set. Keep the prompt as it is, or go back to the prompt made from the direction.",
      );
    const est = this.estimateTake(project, shotId, tier, p, { skipWrite: true });
    const image = this.catalog.get(est.imageModel);
    const video = this.catalog.get(est.videoModel);
    if (image.kind !== "image") throw new EditError(`${image.label} is not an image model`);
    if (video.kind !== "video") throw new EditError(`${video.label} is not a video model`);
    if (!supportsAspect(video, project.aspect)) throw new EditError(`${video.label} can't render ${project.aspect}`);

    const take: Take = {
      id: newId("take"),
      tier,
      imageModel: image.id,
      videoModel: video.id,
      status: "queued",
      // Fixed now, with the price: editing the shot later doesn't add or drop a paid picture mid-take.
      ...(!est.byReference && wantsEndFrame(shot, video) ? { endPicture: shot.endPicture.trim() } : {}),
      ...(est.byReference ? { byReference: true } : {}),
      ...(p.retakeOf ? { retakeOf: p.retakeOf } : {}),
      ...(p.autoRetake ? { autoRetake: true } : {}),
      createdAt: new Date().toISOString(),
    };
    // From the cast pictures: no first frame, straight to the video.
    if (est.byReference) {
      await this.projects.mutate(projectId, (proj) => {
        findShot(proj, shotId).shot.takes.push({ ...take, status: "running" });
      });
      if (est.audio === "tts") await this.generateMissingTts(projectId, shotId, p.owner).catch(() => {});
      await this.startVideo(projectId, shotId, take.id, p.owner);
      return { ...take, status: "running" };
    }
    const prev = continuesFrom(project, shotId);
    const source = prev ? chainSource(prev, tier) : undefined;
    // No clip to start from yet: wait for one of the same tier that's on its way, else ask for it.
    if (prev && !source && !prev.takes.some((t) => t.tier === tier && (t.status === "running" || t.status === "queued" || isMeasuring(t))))
      throw new EditError(
        tier === "final"
          ? "This shot continues from the one before it: make that shot's final first"
          : "This shot continues from the one before it: make a draft of that shot first",
      );
    await this.projects.mutate(projectId, (proj) => {
      findShot(proj, shotId).shot.takes.push(prev && !source ? { ...take, waitsForShotId: prev.id } : take);
    });

    if (prev) {
      // Its first frame is the previous clip's last; a final waits for the previous final if need be.
      if (source) await this.startChained(projectId, shotId, take.id, source, takeOutS(source, prev), p.owner);
      if (est.audio === "tts") await this.generateMissingTts(projectId, shotId, p.owner).catch(() => {});
      return { ...take, status: source ? "running" : "queued" };
    }

    // The scene's master still is on its way: this take starts from it when it lands.
    if (scene.master?.status === "running") {
      await this.projects.mutate(projectId, (proj) => {
        const t = findShot(proj, shotId).shot.takes.find((x) => x.id === take.id);
        if (t) t.waitsForMaster = true;
      });
      if (est.audio === "tts") await this.generateMissingTts(projectId, shotId, p.owner).catch(() => {});
      return { ...take, status: "queued", waitsForMaster: true };
    }
    await this.startFrame(projectId, shotId, take.id, p.owner, { removeOnError: true });
    // The frame is on its way (and may be charged), so the take stays whatever happens to the voice lines.
    if (est.audio === "tts") {
      try {
        await this.generateMissingTts(projectId, shotId, p.owner);
      } catch (err) {
        await this.projects.mutate(projectId, (proj) => {
          const t = findShot(proj, shotId).shot.takes.find((x) => x.id === take.id);
          if (t) t.error = `Voice lines were not started: ${(err as Error).message}`;
        });
      }
    }
    return { ...take, status: "running" };
  }

  /**
   * Starts a take's first frame. With the scene's master still, the frame is a new camera angle on it
   * (character pictures hold the faces); without one, it is built from the cast and place pictures.
   */
  private async startFrame(
    projectId: string,
    shotId: string,
    takeId: string,
    owner: Record<string, string> | undefined,
    o: { removeOnError: boolean },
  ): Promise<void> {
    const project = await this.projects.get(projectId);
    const { shot, episode, scene } = findShot(project, shotId);
    const take = shot.takes.find((t) => t.id === takeId);
    if (!take) return;
    const opening = opensOnMaster(project, shotId);
    if (opening) {
      await this.projects.mutate(projectId, (proj) => {
        const t = findShot(proj, shotId).shot.takes.find((x) => x.id === takeId);
        if (t) {
          t.frameMediaId = opening.id;
          t.status = "running";
          delete t.waitsForMaster;
        }
      });
      await this.startVideo(projectId, shotId, takeId, owner);
      return;
    }
    const image = this.catalog.get(take.imageModel);
    const master =
      scene.master?.status === "done" && scene.master.mediaId ? project.media.find((m) => m.id === scene.master!.mediaId) : undefined;
    const fromMaster = !!master && !master.hidden;
    // The place's picture only for wide shots without a master: closer in, the model pastes people onto it as a backdrop.
    const castRefs = await this.referenceImages(
      project,
      shot.castIds,
      !fromMaster && isWideShot(shot) ? scene.locationId : null,
      Math.max(0, image.maxRefImages - (fromMaster ? 1 : 0)),
      fromMaster || !isWideShot(shot),
    );
    const refs: MediaInput[] = fromMaster
      ? [
          {
            bytes: await this.deps.media.read(projectId, master!),
            contentType: master!.contentType,
            name: `SCENE.${master!.path.split(".").pop()}`,
            origin: "generated",
          },
          ...castRefs,
        ]
      : castRefs;
    const cast = shot.castIds.map((id) => project.cast.find((c) => c.id === id)).filter((c): c is CastMember => !!c);
    const location = scene.locationId ? project.cast.find((c) => c.id === scene.locationId) : undefined;
    let job: JobRecord;
    try {
      job = await this.runner.start({
        id: `job_f_${take.id}`,
        projectId,
        kind: "image",
        purpose: "frame",
        modelId: image.id,
        tier: take.tier,
        refs: { episodeId: episode.id, sceneId: scene.id, shotId, takeId: take.id },
        input: {
          prompt: framePrompt({
            shot: firstMoment(shot),
            cast,
            location,
            aspect: project.aspect,
            fromMaster,
            staging: scene.staging,
            opening: findShot(project, shotId).index === 0 && !shot.continueFromPrevious,
            counts: scene.counts,
            voiceOver: shot.dialogue.length > 0 && this.audioPlan(shot.audio, this.catalog.get(take.videoModel), true) !== "native",
          }),
          aspect: project.aspect,
          ...(refs.length ? { images: refs } : {}),
        },
        estimateInput: { images: 1 },
        ...(owner ? { owner } : {}),
      });
    } catch (err) {
      await this.projects.mutate(projectId, (proj) => {
        const s = findShot(proj, shotId).shot;
        if (o.removeOnError) s.takes = s.takes.filter((x) => x.id !== take.id);
        else {
          const t = s.takes.find((x) => x.id === take.id);
          if (t) {
            t.status = "failed";
            t.error = plainJobError((err as Error).message, true);
          }
        }
      });
      if (o.removeOnError) throw err;
      return;
    }
    await this.projects.mutate(projectId, (proj) => {
      const t = findShot(proj, shotId).shot.takes.find((x) => x.id === take.id);
      if (!t) return;
      t.frameJobId = job.id;
      delete t.waitsForMaster;
      if (t.status === "queued") t.status = "running";
    });
  }

  /** Makes (or remakes) a scene's master still: the whole cast in the place, lit by it. */
  async makeSceneMaster(projectId: string, sceneId: string, owner?: Record<string, string>): Promise<void> {
    const project = await this.projects.get(projectId);
    const { scene, episode } = findScene(project, sceneId);
    if (scene.master?.status === "running") return;
    const image = this.catalog.get(this.modelsFor(project, "draft").image);
    const peopleIds = [...new Set(scene.shots.flatMap((s) => s.castIds))].filter(
      (id) => project.cast.find((c) => c.id === id)?.kind === "character",
    );
    const people = peopleIds.map((id) => project.cast.find((c) => c.id === id)!).slice(0, 8);
    const place = scene.locationId ? project.cast.find((c) => c.id === scene.locationId) : undefined;
    const refs = await this.referenceImages(project, peopleIds, scene.locationId, image.maxRefImages);
    const jobId = `job_sm_${newId("sm")}`;
    const prompt = sceneMasterPrompt({
      heading: scene.heading,
      script: scene.script,
      staging: scene.staging,
      place,
      people,
      aspect: project.aspect,
    });
    await this.projects.mutate(projectId, (proj) => {
      findScene(proj, sceneId).scene.master = { prompt: prompt.slice(0, 2000), status: "running", jobId };
    });
    try {
      await this.runner.start({
        id: jobId,
        projectId,
        kind: "image",
        purpose: "scene_master",
        modelId: image.id,
        tier: null,
        refs: { episodeId: episode.id, sceneId },
        input: { prompt, aspect: project.aspect, ...(refs.length ? { images: refs } : {}) },
        estimateInput: { images: 1 },
        ...(owner ? { owner } : {}),
      });
    } catch (err) {
      await this.projects.mutate(projectId, (proj) => {
        const m = findScene(proj, sceneId).scene.master;
        if (m && m.jobId === jobId) {
          m.status = "failed";
          m.error = (err as Error).message;
        }
      });
      await this.releaseForMaster(projectId, sceneId, owner);
      throw err;
    }
  }

  /** Starts the takes that were waiting for a scene's master still (from it, or without it if it failed). */
  private async releaseForMaster(projectId: string, sceneId: string, owner?: Record<string, string>): Promise<void> {
    const project = await this.projects.get(projectId);
    let scene: Scene;
    try {
      scene = findScene(project, sceneId).scene;
    } catch {
      return;
    }
    for (const sh of scene.shots)
      for (const t of sh.takes)
        if (t.status === "queued" && t.waitsForMaster) await this.startFrame(projectId, sh.id, t.id, owner, { removeOnError: false });
  }

  private async referenceImages(
    project: Project,
    castIds: string[],
    locationId: string | null,
    max: number,
    skipLocations = false,
  ): Promise<MediaInput[]> {
    if (max <= 0) return [];
    const ids = castIds.filter((id) => !skipLocations || project.cast.find((c) => c.id === id)?.kind !== "location");
    if (locationId && !ids.includes(locationId)) ids.push(locationId);
    // Characters first: faces matter most for consistency.
    const order = { character: 0, prop: 1, location: 2 } as const;
    const members = ids
      .map((id) => project.cast.find((c) => c.id === id))
      .filter((c): c is CastMember => !!c && c.refImageIds.length > 0)
      .sort((a, b) => order[a.kind] - order[b.kind]);
    const out: MediaInput[] = [];
    for (const m of members.slice(0, max)) {
      const ref = project.media.find((x) => x.id === m.refImageIds[0]);
      if (!ref || ref.hidden) continue;
      out.push({
        bytes: await this.deps.media.read(project.id, ref),
        contentType: ref.contentType,
        name: `${m.name}.${ref.path.split(".").pop()}`,
        origin: ref.source === "upload" ? "upload" : "generated",
      });
    }
    return out;
  }

  // Sound: voices lifted out of each clip, a background bed per scene, music under the episode

  /** Lifts the voices out of a finished clip that speaks, so the edit can lay one steady background under it. */
  private async isolateVoices(job: JobRecord): Promise<void> {
    await this.isolateTake(job.projectId, job.refs.shotId!, job.refs.takeId!, job.owner);
  }

  /**
   * A speaking shot: its voices on their own. A shot with no lines: its sound effects with any voice taken out,
   * since video models sometimes add speech nobody wrote. Either way the edit lays one steady background under it.
   */
  private async isolateTake(
    projectId: string,
    shotId: string,
    takeId: string,
    owner?: Record<string, string>,
    opts: { forSound?: boolean } = {},
  ): Promise<void> {
    const project = await this.projects.get(projectId);
    const { shot, episode, scene } = findShot(project, shotId);
    const take = shot.takes.find((t) => t.id === takeId);
    if (!take?.videoMediaId || take.voiceMediaId || take.effectsMediaId || shot.audio !== "native") return;
    const speaks = shot.dialogue.some((l) => l.text.trim());
    // Effects are only needed under a scene background: separate them when the scene has one, or when the sound
    // pass is made, so nobody pays for a track the edit will never use.
    if (!speaks && !opts.forSound && !scene.ambience) return;
    const modelId = speaks ? this.catalog.config.defaults.voiceIsolation : this.catalog.config.defaults.effectsIsolation;
    if (!modelId) return;
    const clipRef = project.media.find((m) => m.id === take.videoMediaId);
    if (!clipRef) return;
    const model = this.catalog.get(modelId);
    const audio = await clipAudioTrack(await this.deps.media.read(projectId, clipRef), model.input.minMediaS);
    if (!audio) return;
    await this.runner.start({
      // "fx", not "e": job_e_ is a take's target picture, and a clash made the runner skip this job.
      id: `job_${speaks ? "i" : "fx"}_${take.id}`,
      projectId,
      kind: "audio",
      purpose: speaks ? "isolate" : "effects",
      modelId: model.id,
      tier: take.tier,
      refs: { episodeId: episode.id, sceneId: scene.id, shotId, takeId },
      input: { media: { bytes: audio.bytes, contentType: "audio/wav", name: "voice.wav" }, durationS: audio.seconds },
      estimateInput: { durationS: audio.seconds },
      ...(owner ? { owner } : {}),
    });
  }

  /** The default descriptions for an episode's music and a scene's background. */
  soundPrompts(project: Project, episodeId: string): { music: string; ambience: Record<string, string> } {
    const ep = findEpisode(project, episodeId);
    const ambience: Record<string, string> = {};
    for (const sc of ep.scenes) {
      const place = sc.locationId ? project.cast.find((c) => c.id === sc.locationId) : undefined;
      ambience[sc.id] =
        sc.ambience?.prompt ||
        `Continuous background ambience for this scene: ${sc.heading}.${place ? ` ${sentence(place.description)}` : ""} Only the place's natural sound and weather, steady and even: no voices, no music, no sudden or loud sounds.`;
    }
    const music =
      ep.music?.prompt ||
      `Instrumental underscore for a tense, emotional vertical drama episode, "${ep.title}" (${ep.scenes.map((s) => s.heading).join("; ")}). Sparse and cinematic: low strings, soft piano, a slow pulse. One steady mood that builds gently to an unresolved ending. No vocals, no drum kit, no big drops: it sits quietly under dialogue.`;
    return { music, ambience };
  }

  /** The seconds the episode runs on screen (cutaways add none). */
  episodeSeconds(project: Project, episodeId: string): number {
    const ep = findEpisode(project, episodeId);
    return ep.scenes.flatMap((s) => s.shots).reduce((a, s) => a + (s.cutaway ? 0 : s.durationS), 0);
  }

  estimateSound(
    project: Project,
    episodeId: string,
  ): { music: Estimate | null; ambience: Estimate | null; separation: Estimate | null; scenes: number } {
    const d = this.catalog.config.defaults;
    const ep = findEpisode(project, episodeId);
    const secs = Math.max(30, Math.min(300, Math.ceil(this.episodeSeconds(project, episodeId))));
    // Making sound also separates the voices or effects of every chosen take that hasn't been yet: price that too.
    // Priced per kind: a shot with lines has its voices lifted, one without has its effects (when a model does that).
    const sepPrice = { voice: 0, effects: 0 };
    for (const sh of ep.scenes.flatMap((s) => s.shots)) {
      if (sh.audio !== "native") continue;
      const kind = sh.dialogue.some((l) => l.text.trim()) ? "voice" : "effects";
      const modelId = kind === "voice" ? d.voiceIsolation : d.effectsIsolation;
      if (!modelId) continue;
      const model = this.catalog.get(modelId);
      for (const t of sh.takes)
        if (
          t.status === "done" &&
          t.videoMediaId &&
          !t.voiceMediaId &&
          !t.effectsMediaId &&
          (t.id === sh.selectedTakeId || t.tier === "final")
        ) {
          const s = Math.max(1, Math.ceil(Math.max(t.analysis?.durationS ?? sh.durationS, (model.input.minMediaS ?? 0) + 0.1)));
          sepPrice[kind] += estimate(model, { durationS: s }).providerCostMicro;
        }
    }
    const sepModel = d.voiceIsolation ?? d.effectsIsolation;
    const sepMicro = sepPrice.voice + sepPrice.effects;
    return {
      music: d.music ? estimate(this.catalog.get(d.music), { durationS: secs }) : null,
      ambience: d.ambience ? estimate(this.catalog.get(d.ambience), { durationS: AMBIENCE_SECONDS * ep.scenes.length }) : null,
      separation:
        sepModel && sepMicro > 0 ? { ...estimate(this.catalog.get(sepModel), { durationS: 0 }), providerCostMicro: sepMicro } : null,
      scenes: ep.scenes.length,
    };
  }

  /** Makes the music and every scene's background (or just the ones asked for), with the given or default descriptions. */
  async generateSound(
    projectId: string,
    episodeId: string,
    p: {
      music?: boolean;
      sceneIds?: string[];
      prompts?: { music?: string; ambience?: Record<string, string> };
      owner?: Record<string, string>;
    } = {},
  ): Promise<void> {
    const d = this.catalog.config.defaults;
    const project = await this.projects.get(projectId);
    const ep = findEpisode(project, episodeId);
    const defaults = this.soundPrompts(project, episodeId);
    const wantMusic = p.music ?? !p.sceneIds;
    const scenes = p.sceneIds ?? (p.music ? [] : ep.scenes.map((s) => s.id));
    const starts: { purpose: "music" | "ambience"; sceneId?: string; prompt: string; jobId: string; seconds: number; model: string }[] = [];
    if (wantMusic && d.music) {
      const busy = ep.music?.status === "running";
      if (!busy)
        starts.push({
          purpose: "music",
          prompt: (p.prompts?.music ?? defaults.music).slice(0, 2000),
          jobId: `job_m_${newId("snd")}`,
          seconds: Math.max(30, Math.min(300, Math.ceil(this.episodeSeconds(project, episodeId)) + 2)),
          model: d.music,
        });
    }
    if (d.ambience)
      for (const sid of scenes) {
        const sc = ep.scenes.find((s) => s.id === sid);
        if (!sc || sc.ambience?.status === "running") continue;
        starts.push({
          purpose: "ambience",
          sceneId: sid,
          prompt: (p.prompts?.ambience?.[sid] ?? defaults.ambience[sid]!).slice(0, 2000),
          jobId: `job_a_${newId("snd")}`,
          seconds: AMBIENCE_SECONDS,
          model: d.ambience,
        });
      }
    // Clips made before the sound pass existed get their voices lifted out too.
    for (const sh of ep.scenes.flatMap((s) => s.shots))
      for (const t of sh.takes)
        if (
          t.status === "done" &&
          t.videoMediaId &&
          !t.voiceMediaId &&
          !t.effectsMediaId &&
          (t.id === sh.selectedTakeId || t.tier === "final")
        )
          await this.isolateTake(projectId, sh.id, t.id, p.owner, { forSound: true }).catch(() => {});
    if (!starts.length) return;
    await this.projects.mutate(projectId, (proj) => {
      const e = findEpisode(proj, episodeId);
      for (const s of starts) {
        const bed: SoundBed = { prompt: s.prompt, status: "running", jobId: s.jobId };
        if (s.purpose === "music") e.music = bed;
        else {
          const sc = e.scenes.find((x) => x.id === s.sceneId);
          if (sc) sc.ambience = bed;
        }
      }
    });
    for (const s of starts) {
      try {
        await this.runner.start({
          id: s.jobId,
          projectId,
          kind: "audio",
          purpose: s.purpose,
          modelId: s.model,
          tier: null,
          refs: { episodeId, ...(s.sceneId ? { sceneId: s.sceneId } : {}) },
          input: { prompt: s.prompt, durationS: s.seconds },
          estimateInput: { durationS: s.seconds },
          ...(p.owner ? { owner: p.owner } : {}),
        });
      } catch (err) {
        await this.projects.mutate(projectId, (proj) => {
          const e = findEpisode(proj, episodeId);
          const bed = s.purpose === "music" ? e.music : e.scenes.find((x) => x.id === s.sceneId)?.ambience;
          if (bed && bed.jobId === s.jobId) {
            bed.status = "failed";
            bed.error = (err as Error).message;
          }
        });
        if (err instanceof EditError || (err as { status?: number }).status === 402) throw err;
      }
    }
  }

  /** A continued take: the previous clip's frame at its end point becomes this take's first, then image-to-video. */
  private async startChained(
    projectId: string,
    shotId: string,
    takeId: string,
    source: Take,
    outS: number,
    owner?: Record<string, string>,
  ): Promise<void> {
    try {
      const project = await this.projects.get(projectId);
      const clipRef = project.media.find((m) => m.id === source.videoMediaId);
      if (!clipRef) throw new Error("The previous shot's clip is missing");
      // Start where the edit ends the previous clip: its chosen end point, before any stall.
      const bytes = await frameAt(await this.deps.media.read(projectId, clipRef), outS, FPS);
      const ref = await this.deps.media.put(projectId, { bytes, contentType: "image/jpeg", source: `chain_${source.id}` });
      await this.projects.mutate(projectId, (proj) => {
        proj.media.push(ref);
        const t = findShot(proj, shotId).shot.takes.find((x) => x.id === takeId);
        if (!t) return;
        t.frameMediaId = ref.id;
        t.status = "running";
        delete t.waitsForShotId;
      });
    } catch (err) {
      await this.projects.mutate(projectId, (proj) => {
        const t = findShot(proj, shotId).shot.takes.find((x) => x.id === takeId);
        if (t) {
          t.status = "failed";
          t.error = `Couldn't take the last frame of the previous shot: ${(err as Error).message}`;
        }
      });
      return;
    }
    await this.startVideo(projectId, shotId, takeId, owner);
  }

  /** When a clip finishes, start the continued takes of its tier that were waiting for it (or fail them if it failed). */
  private async releaseWaiting(job: JobRecord): Promise<void> {
    const tier: Tier = job.tier === "final" ? "final" : "draft";
    const project = await this.projects.get(job.projectId);
    let prev: Shot;
    try {
      prev = findShot(project, job.refs.shotId!).shot;
    } catch {
      return;
    }
    const source = job.state === "done" ? chainSource(prev, tier) : undefined;
    for (const sc of project.episodes.flatMap((e) => e.scenes))
      for (const sh of sc.shots)
        for (const t of sh.takes) {
          if (t.status !== "queued" || t.waitsForShotId !== prev.id || t.tier !== tier) continue;
          if (source) await this.startChained(job.projectId, sh.id, t.id, source, takeOutS(source, prev), job.owner);
          else if (job.state !== "done" || job.purpose !== "video") await this.failWaiting(job.projectId, prev.id, tier);
        }
  }

  /** Starts image-to-video for a take whose first frame is ready. Idempotent. */
  private async startVideo(projectId: string, shotId: string, takeId: string, owner?: Record<string, string>): Promise<void> {
    const project = await this.projects.get(projectId);
    const { shot, episode, scene } = findShot(project, shotId);
    const take = shot.takes.find((t) => t.id === takeId);
    if (!take || (!take.frameMediaId && !take.byReference) || take.videoJobId || take.status !== "running") return;
    const frame = take.frameMediaId ? project.media.find((m) => m.id === take.frameMediaId) : undefined;
    const video = this.catalog.get(take.videoModel);
    // A shot with a target picture: make it from this take's own first frame first, then the video.
    if (take.endPicture && video.input.endImage && !take.endFrameMediaId) {
      if (!take.endFrameJobId) await this.startEndFrame(projectId, shotId, takeId, owner);
      return;
    }
    const endRef = take.endFrameMediaId ? project.media.find((m) => m.id === take.endFrameMediaId) : undefined;
    const plan = this.audioPlan(shot.audio, video, shot.dialogue.length > 0);
    const audio = this.clipAudio(plan, video, take.tier);
    const durationS = billedDuration(video, shot.durationS);
    const refs = take.byReference ? this.referenceMembers(project, shotId, video) : [];
    if (take.byReference && !refs.length) {
      await this.projects.mutate(projectId, (proj) => {
        const t = findShot(proj, shotId).shot.takes.find((x) => x.id === takeId);
        if (t) {
          t.status = "failed";
          t.error = "The cast pictures this take was to start from are gone. Make the take again.";
        }
      });
      return;
    }
    // A take from pictures sends exactly those; a take from a first frame sends no reference line.
    const prompt = take.byReference
      ? this.videoPromptFor(project, shotId, video, take.tier)
      : withReferenceHeader(this.videoPromptFor(project, shotId, video, take.tier, take.endPicture ?? ""), "");
    try {
      const job = await this.runner.start({
        id: `job_v_${take.id}`,
        projectId,
        kind: "video",
        purpose: "video",
        modelId: video.id,
        tier: take.tier,
        refs: { episodeId: episode.id, sceneId: scene.id, shotId, takeId },
        input: {
          prompt,
          ...(frame
            ? {
                image: {
                  bytes: await this.deps.media.read(projectId, frame),
                  contentType: frame.contentType,
                  name: frame.path.split("/").pop()!,
                },
              }
            : {}),
          ...(refs.length
            ? {
                images: await Promise.all(
                  refs.map(async (r) => ({
                    bytes: await this.deps.media.read(projectId, r.media),
                    contentType: r.media.contentType,
                    name: `${r.member.name}.${r.media.path.split(".").pop()}`,
                    origin: r.media.source === "upload" ? ("upload" as const) : ("generated" as const),
                  })),
                ),
              }
            : {}),
          ...(endRef
            ? {
                endImage: {
                  bytes: await this.deps.media.read(projectId, endRef),
                  contentType: endRef.contentType,
                  name: endRef.path.split("/").pop()!,
                },
              }
            : {}),
          durationS,
          aspect: project.aspect,
          audio,
        },
        estimateInput: { durationS, audio },
        ...(owner ? { owner } : {}),
      });
      await this.projects.mutate(projectId, (proj) => {
        const t = findShot(proj, shotId).shot.takes.find((x) => x.id === takeId);
        if (t) {
          t.videoJobId = job.id;
          t.prompt = prompt.slice(0, 16_000);
        }
      });
    } catch (err) {
      await this.projects.mutate(projectId, (proj) => {
        const t = findShot(proj, shotId).shot.takes.find((x) => x.id === takeId);
        if (t) {
          t.status = "failed";
          t.error = (err as Error).message;
          t.prompt = prompt.slice(0, 16_000);
        }
      });
      await this.failWaiting(projectId, shotId, take.tier);
      throw err;
    }
  }

  /**
   * The picture a shot ends on, made by editing this take's own first frame: same camera and framing,
   * only what the shot changes (place, age, clothes, pose). A target framed differently makes the video
   * model snap to it mid-clip.
   */
  private async startEndFrame(projectId: string, shotId: string, takeId: string, owner?: Record<string, string>): Promise<void> {
    const project = await this.projects.get(projectId);
    const { shot, episode, scene } = findShot(project, shotId);
    const take = shot.takes.find((t) => t.id === takeId);
    if (!take?.frameMediaId || !take.endPicture) return;
    const image = this.catalog.get(take.imageModel);
    const first = project.media.find((m) => m.id === take.frameMediaId)!;
    const castRefs = await this.referenceImages(project, shot.castIds, null, Math.max(0, image.maxRefImages - 1), true);
    const cast = shot.castIds.map((id) => project.cast.find((c) => c.id === id)).filter((c): c is CastMember => !!c);
    try {
      const job = await this.runner.start({
        id: `job_e_${take.id}`,
        projectId,
        kind: "image",
        purpose: "end_frame",
        modelId: image.id,
        tier: take.tier,
        refs: { episodeId: episode.id, sceneId: scene.id, shotId, takeId },
        input: {
          prompt: endFramePrompt({ shot: { ...shot, endPicture: take.endPicture ?? "" }, cast, aspect: project.aspect }),
          aspect: project.aspect,
          images: [
            {
              bytes: await this.deps.media.read(projectId, first),
              contentType: first.contentType,
              name: `START.${first.path.split(".").pop()}`,
              origin: "generated",
            },
            ...castRefs,
          ],
        },
        estimateInput: { images: 1 },
        ...(owner ? { owner } : {}),
      });
      await this.projects.mutate(projectId, (proj) => {
        const t = findShot(proj, shotId).shot.takes.find((x) => x.id === takeId);
        if (t) t.endFrameJobId = job.id;
      });
    } catch (err) {
      await this.projects.mutate(projectId, (proj) => {
        const t = findShot(proj, shotId).shot.takes.find((x) => x.id === takeId);
        if (t) {
          t.status = "failed";
          t.error = plainJobError((err as Error).message, true);
        }
      });
      await this.failWaiting(projectId, shotId, take.tier);
    }
  }

  /** A finished take with no analysis (it threw): record the shot's length, so it can still be chained. */
  private async ensureAnalysed(job: JobRecord): Promise<void> {
    await this.projects.mutate(job.projectId, (proj) => {
      let shot: Shot;
      try {
        shot = findShot(proj, job.refs.shotId!).shot;
      } catch {
        return;
      }
      const t = shot.takes.find((x) => x.id === job.refs.takeId);
      if (t && t.status === "done" && !t.analysis)
        t.analysis = { durationS: shot.durationS, motion: [], jumps: [], suggestedOutS: shot.durationS };
      if (t) delete t.measuring;
    });
  }

  /** Fails the takes of the next shot that were waiting to continue from this shot's take of `tier`. */
  private async failWaiting(projectId: string, shotId: string, tier: Tier): Promise<void> {
    // Down the whole chain: a shot waiting on a shot that was waiting on this one fails too.
    await this.projects.mutate(projectId, (proj) => {
      const failed = [shotId];
      while (failed.length) {
        const from = failed.pop()!;
        for (const sc of proj.episodes.flatMap((e) => e.scenes))
          for (const sh of sc.shots)
            for (const x of sh.takes)
              if (x.status === "queued" && x.waitsForShotId === from && x.tier === tier) {
                x.status = "failed";
                x.error = "The shot before this one failed, so this one had nothing to continue from. Remake that shot, then this one.";
                delete x.waitsForShotId;
                failed.push(sh.id);
              }
      }
    });
  }

  /** Measures how a finished clip moves and sets where the edit ends it (before a stall). */
  private async analyseTake(job: JobRecord): Promise<void> {
    const project = await this.projects.get(job.projectId);
    let take: Take | undefined;
    try {
      take = findShot(project, job.refs.shotId!).shot.takes.find((t) => t.id === job.refs.takeId);
    } catch {
      return;
    }
    const ref = take?.videoMediaId ? project.media.find((m) => m.id === take!.videoMediaId) : undefined;
    if (!take || !ref || take.analysis) return;
    const shotNow = findShot(project, job.refs.shotId!).shot;
    const shotLen = shotNow.durationS;
    // A sequence cuts on purpose: a jump at one of its own cuts is the plan, not a fault.
    const cuts = shotNow.beats.slice(1).map((b) => b.startS);
    const planned = (t: number) => cuts.some((c) => Math.abs(c - t) <= 0.35);
    // If the clip can't be measured, record that it wasn't, so the take can still be used and chained.
    const m = await analyseClip(await this.deps.media.read(job.projectId, ref)).catch(() => ({
      durationS: shotLen,
      motion: [] as number[],
      jumps: [] as number[],
      stallFromS: undefined,
      suggestedOutS: shotLen,
    }));
    await this.projects.mutate(job.projectId, (proj) => {
      const t = findShot(proj, job.refs.shotId!).shot.takes.find((x) => x.id === job.refs.takeId);
      if (!t) return;
      t.analysis = {
        durationS: m.durationS,
        motion: m.motion,
        jumps: m.jumps.filter((j) => !planned(j)),
        suggestedOutS: m.suggestedOutS,
        ...(m.stallFromS !== undefined ? { stallFromS: m.stallFromS } : {}),
        ...("suggestedInS" in m && m.suggestedInS !== undefined ? { suggestedInS: m.suggestedInS } : {}),
      };
      // A sequence's last shot may be still on purpose (a held reaction): never trimmed by itself.
      if (t.outS === undefined && m.suggestedOutS < m.durationS && !shotNow.beats.length) t.outS = m.suggestedOutS;
      delete t.measuring;
    });
  }

  /** Sequences are checked when their take lands; ordinary shots only when asked. */
  private async autoReview(job: JobRecord): Promise<void> {
    if (!this.catalog.config.defaults.review) return;
    const project = await this.projects.get(job.projectId);
    let shot: Shot;
    try {
      shot = findShot(project, job.refs.shotId!).shot;
    } catch {
      return;
    }
    const take = shot.takes.find((t) => t.id === job.refs.takeId);
    if (!shot.beats.length || !take || take.review || take.status !== "done") return;
    await this.reviewTake(job.projectId, shot.id, take.id, job.owner ? { owner: job.owner } : {});
  }

  /** Text-to-speech for one line (the fallback when the video model has no native audio). */
  async generateTts(projectId: string, shotId: string, lineId: string, owner?: Record<string, string>): Promise<JobRecord> {
    const project = await this.projects.get(projectId);
    const { shot, episode, scene } = findShot(project, shotId);
    const line = shot.dialogue.find((l) => l.id === lineId);
    if (!line) throw new EditError("No such line", "not_found");
    const modelId = this.catalog.config.defaults.tts;
    // One job per line and wording: asking twice (two final takes) never pays twice.
    let id = `job_t_${line.id}_${createHash("sha1").update(`${modelId}|${line.castId}|${line.text}`).digest("hex").slice(0, 10)}`;
    const prior = await this.deps.jobs.get(id);
    if (prior && (prior.state === "failed" || prior.state === "blocked")) id = newId("job");
    return this.runner.start({
      id,
      projectId,
      kind: "tts",
      purpose: "tts",
      modelId,
      tier: null,
      refs: { episodeId: episode.id, sceneId: scene.id, shotId, lineId },
      input: { text: line.text },
      estimateInput: { chars: line.text.length },
      ...(owner ? { owner } : {}),
    });
  }

  private async generateMissingTts(projectId: string, shotId: string, owner?: Record<string, string>): Promise<void> {
    const project = await this.projects.get(projectId);
    const { shot } = findShot(project, shotId);
    for (const l of shot.dialogue) if (l.text.trim() && !l.ttsMediaId) await this.generateTts(projectId, shotId, l.id, owner);
  }

  // Checking takes against the plan

  /**
   * Checks a finished take: a contact sheet of its frames and the plan go to a vision model, which answers
   * pass or fail, the problems with their times, and a corrected prompt. Logged like every other job.
   */
  async reviewTake(
    projectId: string,
    shotId: string,
    takeId: string,
    p: { owner?: Record<string, string>; again?: boolean } = {},
  ): Promise<void> {
    const modelId = this.catalog.config.defaults.review;
    if (!modelId) throw new EditError("No model is set up to check takes");
    const project = await this.projects.get(projectId);
    const { shot, scene, episode } = findShot(project, shotId);
    const take = shot.takes.find((t) => t.id === takeId);
    if (!take) throw new EditError("No such take", "not_found");
    if (take.status !== "done" || !take.videoMediaId) throw new EditError("Only a finished take can be checked");
    // A check already on its way is left alone; one marked running with no live job (the app stopped) is redone.
    if (take.review?.status === "running") {
      const job = take.review.jobId ? await this.deps.jobs.get(take.review.jobId) : undefined;
      if (job && !(job.state === "blocked" || ((job.state === "done" || job.state === "failed") && job.applied))) return;
    }
    const clipRef = project.media.find((m) => m.id === take.videoMediaId);
    if (!clipRef) throw new EditError("This take's clip is missing");
    // One automatic check per take; asking again is a new, separately priced job.
    const jobId = p.again || take.review ? newId("job") : `job_r_${take.id}`;
    const before = take.review?.jobId;
    // Claimed before any slow work, so two presses can never start two paid checks.
    const claimed = await this.projects.mutate(projectId, (proj) => {
      const t = findShot(proj, shotId).shot.takes.find((x) => x.id === takeId);
      if (!t || t.review?.jobId !== before) return false;
      t.review = { status: "running", jobId, problems: [], fixedPrompt: "" };
      return true;
    });
    if (!claimed) return;
    const video = this.catalog.get(take.videoModel);
    let sheet: Awaited<ReturnType<typeof contactSheet>>;
    try {
      sheet = await contactSheet(await this.deps.media.read(projectId, clipRef));
    } catch (err) {
      await this.projects.mutate(projectId, (proj) => {
        const t = findShot(proj, shotId).shot.takes.find((x) => x.id === takeId);
        if (t?.review?.jobId === jobId) {
          t.review.status = "failed";
          t.review.error = `The clip's frames couldn't be read. Nothing was charged.`;
        }
      });
      throw err;
    }
    const refs = take.byReference ? this.referenceMembers(project, shotId, video).map((r) => r.name) : [];
    const ctx = this.contextFor(project, scene, shot, video, refs);
    const prompt = reviewPrompt({
      ctx,
      sentPrompt: take.prompt ?? this.videoPromptFor(project, shotId, video, take.tier),
      sheet,
      clipS: sheet.durationS,
    });
    try {
      await this.runner.start({
        id: jobId,
        projectId,
        kind: "llm",
        purpose: "review",
        modelId,
        tier: take.tier,
        refs: { episodeId: episode.id, sceneId: scene.id, shotId, takeId },
        input: {
          prompt: prompt.prompt,
          system: prompt.system,
          maxTokens: prompt.maxTokens,
          images: [{ bytes: sheet.bytes, contentType: "image/jpeg", name: "contact-sheet.jpg", origin: "generated" }],
        },
        estimateInput: { inputTokens: roughTokens(prompt.system + prompt.prompt) + SHEET_TOKENS, outputTokens: prompt.maxTokens },
        ...(p.owner ? { owner: p.owner } : {}),
      });
    } catch (err) {
      await this.projects.mutate(projectId, (proj) => {
        const t = findShot(proj, shotId).shot.takes.find((x) => x.id === takeId);
        if (t?.review?.jobId === jobId) {
          t.review.status = "failed";
          t.review.error = plainJobError((err as Error).message, true).slice(0, 500);
        }
      });
      throw err;
    }
  }

  /**
   * A new take of the same tier with the check's corrected prompt (the counts and constraints put back in code).
   * The shot's prompt becomes the corrected one, so the creator sees exactly what is sent.
   */
  async retakeWithFix(
    projectId: string,
    shotId: string,
    takeId: string,
    p: { owner?: Record<string, string>; auto?: boolean } = {},
  ): Promise<Take> {
    const project = await this.projects.get(projectId);
    const { shot, scene } = findShot(project, shotId);
    const take = shot.takes.find((t) => t.id === takeId);
    if (!take) throw new EditError("No such take", "not_found");
    if (take.review?.status !== "done") throw new EditError("Check this take first");
    if (take.tier === "final" && !shot.approved) throw new EditError("Approve this shot before sending it to final", "not_approved");
    const fixed = take.review.fixedPrompt.trim();
    // A correction that lost the sequence's timecodes or cuts is not used: the retake keeps the shot's prompt.
    if (fixed && (!shot.beats.length || keepsStructure(fixed, shot))) {
      const video = this.catalog.get(take.videoModel);
      const refs = this.referenceMembers(project, shotId, video).map((r) => r.name);
      const prompt = shot.beats.length ? refreshConstraints(fixed, this.contextFor(project, scene, shot, video, refs)) : fixed;
      // Set directly, not as an edit: a retake of an approved shot stays approved.
      await this.projects.mutate(projectId, (proj) => {
        const s = findShot(proj, shotId).shot;
        s.writtenPrompt = fitPrompt(prompt);
        s.writtenFor = video.id;
        s.promptStale = false;
      });
    }
    return this.generateTake(projectId, shotId, take.tier, {
      image: take.imageModel,
      video: take.videoModel,
      retakeOf: take.id,
      ...(p.auto ? { autoRetake: true } : {}),
      ...(p.owner ? { owner: p.owner } : {}),
    });
  }

  /** After a check: one automatic retake per shot when the scene asks for it and the take failed. */
  private async maybeAutoRetake(job: JobRecord): Promise<void> {
    const project = await this.projects.get(job.projectId);
    let shot: Shot;
    let scene: Scene;
    try {
      ({ shot, scene } = findShot(project, job.refs.shotId!));
    } catch {
      return;
    }
    const take = shot.takes.find((t) => t.id === job.refs.takeId);
    // Only the take's own automatic check can start it, never a check asked for again by hand.
    if (!scene.autoRetake || !take || job.id !== `job_r_${take.id}` || take.review?.jobId !== job.id) return;
    if (take.review.status !== "done" || take.review.pass !== false) return;
    // Claimed in one save: at most one automatic retake per shot, however many checks finish together.
    const claimed = await this.projects.mutate(job.projectId, (proj) => {
      const sh = findShot(proj, shot.id).shot;
      if (sh.takes.some((t) => t.autoRetake || t.autoRetakeStarted || t.status === "queued" || t.status === "running")) return false;
      const t = sh.takes.find((x) => x.id === take.id);
      if (!t) return false;
      t.autoRetakeStarted = true;
      return true;
    });
    if (!claimed) return;
    await this.retakeWithFix(job.projectId, shot.id, take.id, { auto: true, ...(job.owner ? { owner: job.owner } : {}) });
  }

  /** A take made from pictures has no first frame: one from early in its clip stands in on the cards. */
  private async thumbnailTake(job: JobRecord): Promise<void> {
    const project = await this.projects.get(job.projectId);
    let take: Take | undefined;
    try {
      take = findShot(project, job.refs.shotId!).shot.takes.find((t) => t.id === job.refs.takeId);
    } catch {
      return;
    }
    if (!take?.byReference || take.frameMediaId || !take.videoMediaId) return;
    const clipRef = project.media.find((m) => m.id === take!.videoMediaId);
    if (!clipRef) return;
    const bytes = await frameAt(await this.deps.media.read(job.projectId, clipRef), 0.5, FPS);
    const ref = await this.deps.media.put(job.projectId, { bytes, contentType: "image/jpeg", source: `thumb_${take.id}` });
    await this.projects.mutate(job.projectId, (proj) => {
      const t = findShot(proj, job.refs.shotId!).shot.takes.find((x) => x.id === job.refs.takeId);
      if (!t || t.frameMediaId) return;
      proj.media.push(ref);
      t.frameMediaId = ref.id;
    });
  }

  // Job results

  private registerHandlers(): void {
    const takeOf = (project: Project, job: JobRecord) => {
      try {
        return findShot(project, job.refs.shotId!).shot.takes.find((t) => t.id === job.refs.takeId);
      } catch {
        return undefined; // The shot was deleted while the job ran.
      }
    };
    const failTake = (project: Project, job: JobRecord, error: string) => {
      const t = takeOf(project, job);
      if (t && t.status !== "done") {
        t.status = "failed";
        t.error = plainJobError(error, job.providerBilled === false);
      }
    };

    this.runner.on("cast_image", {
      apply: (project, job, r) => {
        const c = project.cast.find((x) => x.id === job.refs.castId);
        if (c) delete c.error;
        if (c && r.media && !c.refImageIds.includes(r.media.id)) c.refImageIds.unshift(r.media.id);
      },
      fail: (project, job, error) => {
        const c = project.cast.find((x) => x.id === job.refs.castId);
        if (c) c.error = plainJobError(error, job.providerBilled === false);
      },
    });
    this.runner.on("frame", {
      apply: (project, job, r) => {
        const t = takeOf(project, job);
        if (!t || !r.media) return;
        t.frameMediaId = r.media.id;
        // A frame that arrived after its job was given up on: the take carries on.
        if (t.status === "failed" && !t.videoJobId && job.reopened) {
          t.status = "running";
          delete t.error;
        }
      },
      fail: failTake,
      after: async (job) => {
        if (job.state === "done") await this.startVideo(job.projectId, job.refs.shotId!, job.refs.takeId!, job.owner);
        // A take that fails at its first frame never makes a clip: shots waiting to continue from it must hear so.
        if (job.state === "failed") await this.releaseWaiting(job);
      },
    });
    this.runner.on("video", {
      apply: (project, job, r) => {
        const t = takeOf(project, job);
        if (!t || !r.media) return;
        t.videoMediaId = r.media.id;
        t.status = "done";
        t.measuring = true;
        const { shot } = findShot(project, job.refs.shotId!);
        const selected = shot.takes.find((x) => x.id === shot.selectedTakeId);
        // A new final replaces the selection; a new draft is selected unless a final already is.
        if (!selected || t.tier === "final" || selected.tier === "draft") shot.selectedTakeId = t.id;
      },
      fail: failTake,
      after: async (job) => {
        // Measure the clip first: a shot that continues from it starts at its end point, not its last frame.
        if (job.state === "done") await this.analyseTake(job).catch(() => {});
        // Analysis is what makes a take chainable: a take that somehow still has none gets a placeholder.
        if (job.state === "done") await this.ensureAnalysed(job);
        if (job.state === "done" || job.state === "failed") await this.releaseWaiting(job);
        if (job.state === "done") await this.isolateVoices(job).catch(() => {});
        if (job.state === "done") await this.thumbnailTake(job).catch(() => {});
        // A sequence is checked against its plan by itself (priced in its estimate).
        if (job.state === "done") await this.autoReview(job).catch((err) => this.deps.log?.(`Checking ${job.id} failed`, err));
      },
    });
    this.runner.on("review", {
      apply: (project, job, r) => {
        const t = takeOf(project, job);
        if (!t?.review || t.review.jobId !== job.id) return;
        try {
          const v = parseReview(r.text ?? "");
          t.review = { status: "done", jobId: job.id, pass: v.pass, problems: v.problems, fixedPrompt: v.fixedPrompt };
        } catch (err) {
          t.review = { status: "failed", jobId: job.id, problems: [], fixedPrompt: "", error: (err as Error).message.slice(0, 500) };
        }
      },
      fail: (project, job, error) => {
        const t = takeOf(project, job);
        if (!t?.review || t.review.jobId !== job.id) return;
        t.review.status = "failed";
        t.review.error = plainJobError(error, job.providerBilled === false).slice(0, 500);
      },
      after: async (job) => {
        if (job.state === "done") await this.maybeAutoRetake(job);
      },
    });
    this.runner.on("end_frame", {
      apply: (project, job, r) => {
        const t = takeOf(project, job);
        if (!t || !r.media) return;
        t.endFrameMediaId = r.media.id;
        // A target picture that arrived after its job was given up on: the take carries on to its video.
        if (t.status === "failed" && !t.videoJobId && job.reopened) {
          t.status = "running";
          delete t.error;
        }
      },
      fail: failTake,
      after: async (job) => {
        if (job.state === "done") await this.startVideo(job.projectId, job.refs.shotId!, job.refs.takeId!, job.owner);
        if (job.state === "failed") await this.releaseWaiting(job);
      },
    });
    this.runner.on("scene_master", {
      apply: (project, job, r) => {
        try {
          const m = findScene(project, job.refs.sceneId!).scene.master;
          if (!m || m.jobId !== job.id || !r.media) return;
          m.mediaId = r.media.id;
          m.status = "done";
          delete m.error;
        } catch {}
      },
      fail: (project, job, error) => {
        try {
          const m = findScene(project, job.refs.sceneId!).scene.master;
          if (!m || m.jobId !== job.id) return;
          m.status = "failed";
          m.error = plainJobError(error, job.providerBilled === false);
        } catch {}
      },
      after: async (job) => {
        if (job.state === "done" || job.state === "failed") await this.releaseForMaster(job.projectId, job.refs.sceneId!, job.owner);
      },
    });
    this.runner.on("isolate", {
      apply: (project, job, r) => {
        const t = takeOf(project, job);
        if (t && r.media) t.voiceMediaId = r.media.id;
      },
    });
    this.runner.on("effects", {
      apply: (project, job, r) => {
        const t = takeOf(project, job);
        if (t && r.media) t.effectsMediaId = r.media.id;
      },
    });
    const bedOf = (project: Project, job: JobRecord): SoundBed | null | undefined => {
      try {
        if (job.purpose === "music") return findEpisode(project, job.refs.episodeId!).music;
        return findScene(project, job.refs.sceneId!).scene.ambience;
      } catch {
        return undefined;
      }
    };
    for (const purpose of ["music", "ambience"])
      this.runner.on(purpose, {
        apply: (project, job, r) => {
          const bed = bedOf(project, job);
          if (!bed || bed.jobId !== job.id || !r.media) return;
          bed.mediaId = r.media.id;
          bed.status = "done";
          delete bed.error;
        },
        fail: (project, job, error) => {
          const bed = bedOf(project, job);
          if (!bed || bed.jobId !== job.id) return;
          bed.status = "failed";
          bed.error = plainJobError(error, job.providerBilled === false);
        },
      });
    this.runner.on("tts", {
      apply: (project, job, r) => {
        try {
          const line = findShot(project, job.refs.shotId!).shot.dialogue.find((l) => l.id === job.refs.lineId);
          if (line && r.media) line.ttsMediaId = r.media.id;
        } catch {
          // Shot deleted.
        }
      },
    });
  }

  /** Polls every unfinished job once. Local runs this on a timer; hosted from the worker. */
  tick(projectId?: string): Promise<JobRecord[]> {
    return this.runner.resume(projectId);
  }
}

/** Replacing shots while their generations run would throw away results that are being paid for. */
export function assertNothingRunning(shots: { takes: Take[] }[]): void {
  if (shots.some((sh) => sh.takes.some((t) => t.status === "queued" || t.status === "running"))) {
    throw new EditError("Some shots here are still generating. Wait for them to finish first.");
  }
}

/**
 * The scene's master still, when it is this shot's first frame as it stands: the scene's opening wide shot.
 * The master is drawn as that opening moment, so re-imagining it only moves people from where the staging put them.
 */
export function opensOnMaster(project: Project, shotId: string): MediaRef | undefined {
  const { shot, scene, index } = findShot(project, shotId);
  if (index !== 0 || shot.continueFromPrevious || !isWideShot(shot)) return undefined;
  const m = scene.master;
  const media = m?.status === "done" && m.mediaId ? project.media.find((x) => x.id === m.mediaId) : undefined;
  return media && !media.hidden ? media : undefined;
}

/** The shot this one continues from: the one before it in its scene, if it asks to continue. */
export function continuesFrom(project: Project, shotId: string): Shot | undefined {
  const { shot, scene, index } = findShot(project, shotId);
  return shot.continueFromPrevious && index > 0 ? scene.shots[index - 1] : undefined;
}

/** Which of the previous shot's takes a continued take starts from: its finished final for a final, else the take on its card. */
export function chainSource(prev: Shot, tier: Tier): Take | undefined {
  // Only measured takes: until then nobody knows where the edit ends the clip, so nothing may start from it.
  const done = prev.takes.filter((t) => t.status === "done" && t.videoMediaId && !t.measuring);
  if (tier === "final") {
    const sel = done.find((t) => t.id === prev.selectedTakeId && t.tier === "final");
    return sel ?? done.filter((t) => t.tier === "final").at(-1);
  }
  return done.find((t) => t.id === prev.selectedTakeId) ?? done.at(-1);
}

/** A finished clip still being measured: shots that continue from it wait for the measurement. */
const isMeasuring = (t: Take) => t.status === "done" && !!t.measuring;

/** A shot ends on a target picture when it describes one and its video model can take one. */
export function wantsEndFrame(shot: Shot, video: CatalogModel): boolean {
  return !!shot.endPicture?.trim() && !!video.input.endImage;
}

/** What a written prompt is made from, to tell whether the shot changed while it was being written. */
const planPrint = (s: Shot) =>
  JSON.stringify([
    s.description,
    s.camera,
    s.castIds,
    s.durationS,
    s.dialogue.map((l) => l.text),
    s.beats,
    s.logline,
    s.startState,
    s.sounds,
    s.slowMotion,
  ]);

/** A sequence takes its prompt from the writer: one is needed when it has none, or the plan changed since. */
export function needsWrite(shot: Shot): boolean {
  return shot.beats.length > 0 && (!shot.writtenPrompt.trim() || shot.promptStale);
}

/**
 * A sequence's beats fitted to what the video model renders: squeezed when they run past its longest clip,
 * and the last one stretched to the clip length it will bill, so the plan and the clip agree.
 */
export function fitBeats(beats: Beat[], video: CatalogModel, maxS: number): Beat[] {
  if (!beats.length) return beats;
  const total = sequenceSeconds(beats);
  const k = total > maxS ? maxS / total : 1;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const out = beats.map((b) => ({ ...b, startS: r1(b.startS * k), endS: r1(b.endS * k) }));
  const billed = billedDuration(video, sequenceSeconds(out));
  if (billed > sequenceSeconds(out)) out[out.length - 1]!.endS = billed;
  return out;
}

/** The first moment of a sequence, for its first frame: where everyone is and the first beat's camera. */
function firstMoment(shot: Shot): Shot {
  const b = shot.beats[0];
  if (!b) return shot;
  return { ...shot, description: [shot.startState, b.action].filter((x) => x.trim()).join(" "), camera: beatCamera(b) };
}

/** ElevenLabs sound effects top out at 22 s; the loop tiles it under a scene of any length. */
const AMBIENCE_SECONDS = 22;

/** A clip's soundtrack as WAV, or null when it has none. */
async function clipAudioTrack(clip: Uint8Array, minS = 0): Promise<{ bytes: Uint8Array; seconds: number } | null> {
  const dir = mkdtempSync(join(tmpdir(), "reel-voice-"));
  try {
    const src = join(dir, "clip.mp4");
    const out = join(dir, "audio.wav");
    writeFileSync(src, clip);
    if (!(await hasAudio(src))) return null;
    // Padded with silence up to the shortest audio the model accepts; the edit trims it back to the clip.
    await runFfmpeg(["-i", src, "-vn", "-ac", "2", "-ar", "44100", ...(minS > 0 ? ["-af", `apad=whole_dur=${minS + 0.1}`] : []), out]);
    return { bytes: new Uint8Array(readFileSync(out)), seconds: Math.max(1, Math.ceil(await mediaDuration(out))) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** "an old church" -> "An old church." */
const sentence = (t: string) => {
  const x = t.trim().replace(/[.!?]*$/, "");
  return x ? `${x.charAt(0).toUpperCase()}${x.slice(1)}.` : "";
};
