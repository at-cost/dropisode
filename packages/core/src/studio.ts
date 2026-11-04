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
import { EditError, addCast, addEpisode, addScene, addShot, castByName, findCast, findEpisode, findScene, findShot, newId } from "./edit";
import { hasAudio, mediaDuration, runFfmpeg } from "./ffmpeg";
import { JobRunner, plainJobError, type RunnerDeps } from "./jobs";
import type { CastMember, MediaRef, Project, Scene, Shot, SoundBed, Take, Tier } from "./project";
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
  scriptSpeakers,
  scriptSpeakerFor,
  sceneTargetSeconds,
  normalizeLine,
  scriptVoiceOvers,
  isWideShot,
  sceneMasterPrompt,
  parseStaging,
} from "./prompts";
import type { JobRecord, MediaInput } from "./providers/types";

export type StudioDeps = RunnerDeps;

export interface TakeEstimate {
  tier: Tier;
  imageModel: string;
  videoModel: string;
  frame: Estimate;
  video: Estimate;
  tts: Estimate[];
  /** Provider cost of the whole take. */
  providerCostMicro: number;
  durationS: number;
  audio: "native" | "tts" | "none";
}

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

  estimateStoryboard(project: Project, sceneId: string): Estimate {
    const { scene } = findScene(project, sceneId);
    return this.llmEstimate(storyboardPrompt({ sceneScript: scene.script, heading: scene.heading, cast: project.cast, durations: [] }));
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
  estimateTake(project: Project, shotId: string, tier: Tier, models: { image?: string; video?: string } = {}): TakeEstimate {
    const { shot } = findShot(project, shotId);
    const d = this.modelsFor(project, tier);
    const image = this.catalog.get(models.image ?? d.image);
    const video = this.catalog.get(models.video ?? d.video);
    const audio =
      tier === "draft" && !this.catalog.config.defaults.draftAudio ? "none" : this.audioPlan(shot.audio, video, shot.dialogue.length > 0);
    // A continued shot takes its first frame from the previous clip: no image to pay for.
    const frame = continuesFrom(project, shotId) ? estimate(image, { images: 0 }) : estimate(image, { images: 1 });
    const vid = estimate(video, { durationS: shot.durationS, audio: this.clipAudio(audio, video, tier) });
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
      video: vid,
      tts,
      providerCostMicro: frame.providerCostMicro + vid.providerCostMicro + tts.reduce((a, e) => a + e.providerCostMicro, 0),
      durationS: billedDuration(video, shot.durationS),
      audio,
    };
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
      }),
      { episodeId: episode.id, sceneId },
      p.owner,
    );
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
    p: { image?: string; video?: string; owner?: Record<string, string> } = {},
  ): Promise<Take> {
    const project = await this.projects.get(projectId);
    const { shot, episode, scene } = findShot(project, shotId);
    if (tier === "final" && !shot.approved) throw new EditError("Approve this shot before sending it to final", "not_approved");
    const est = this.estimateTake(project, shotId, tier, p);
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
      createdAt: new Date().toISOString(),
    };
    const prev = continuesFrom(project, shotId);
    const source = prev ? chainSource(prev, tier) : undefined;
    // No clip to start from yet: wait for one of the same tier that's on its way, else ask for it.
    if (prev && !source && !prev.takes.some((t) => t.tier === tier && (t.status === "running" || t.status === "queued")))
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
      if (source) await this.startChained(projectId, shotId, take.id, source, p.owner);
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
            shot,
            cast,
            location,
            aspect: project.aspect,
            fromMaster,
            staging: scene.staging,
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

  private async isolateTake(projectId: string, shotId: string, takeId: string, owner?: Record<string, string>): Promise<void> {
    const modelId = this.catalog.config.defaults.voiceIsolation;
    if (!modelId) return;
    const project = await this.projects.get(projectId);
    const { shot, episode, scene } = findShot(project, shotId);
    const take = shot.takes.find((t) => t.id === takeId);
    if (!take?.videoMediaId || take.voiceMediaId) return;
    const speaks = shot.audio === "native" && shot.dialogue.some((l) => l.text.trim());
    if (!speaks) return;
    const clipRef = project.media.find((m) => m.id === take.videoMediaId);
    if (!clipRef) return;
    const audio = await clipAudioTrack(await this.deps.media.read(projectId, clipRef));
    if (!audio) return;
    const model = this.catalog.get(modelId);
    await this.runner.start({
      id: `job_i_${take.id}`,
      projectId,
      kind: "audio",
      purpose: "isolate",
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

  estimateSound(project: Project, episodeId: string): { music: Estimate | null; ambience: Estimate | null; scenes: number } {
    const d = this.catalog.config.defaults;
    const ep = findEpisode(project, episodeId);
    const secs = Math.max(30, Math.min(300, Math.ceil(this.episodeSeconds(project, episodeId))));
    return {
      music: d.music ? estimate(this.catalog.get(d.music), { durationS: secs }) : null,
      ambience: d.ambience ? estimate(this.catalog.get(d.ambience), { durationS: AMBIENCE_SECONDS * ep.scenes.length }) : null,
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
        if (t.status === "done" && t.videoMediaId && !t.voiceMediaId && (t.id === sh.selectedTakeId || t.tier === "final"))
          await this.isolateTake(projectId, sh.id, t.id, p.owner).catch(() => {});
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

  /** A continued take: the previous clip's last frame becomes this take's first, then image-to-video. */
  private async startChained(
    projectId: string,
    shotId: string,
    takeId: string,
    source: Take,
    owner?: Record<string, string>,
  ): Promise<void> {
    try {
      const project = await this.projects.get(projectId);
      const clipRef = project.media.find((m) => m.id === source.videoMediaId);
      if (!clipRef) throw new Error("The previous shot's clip is missing");
      const bytes = await lastFrame(await this.deps.media.read(projectId, clipRef));
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
          if (source) await this.startChained(job.projectId, sh.id, t.id, source, job.owner);
          else if (job.state !== "done")
            await this.projects.mutate(job.projectId, (proj) => {
              const x = findShot(proj, sh.id).shot.takes.find((y) => y.id === t.id);
              if (x) {
                x.status = "failed";
                x.error = "The shot before this one failed, so this one had nothing to continue from. Remake that shot, then this one.";
                delete x.waitsForShotId;
              }
            });
        }
  }

  /** Starts image-to-video for a take whose first frame is ready. Idempotent. */
  private async startVideo(projectId: string, shotId: string, takeId: string, owner?: Record<string, string>): Promise<void> {
    const project = await this.projects.get(projectId);
    const { shot, episode, scene } = findShot(project, shotId);
    const take = shot.takes.find((t) => t.id === takeId);
    if (!take || !take.frameMediaId || take.videoJobId || take.status !== "running") return;
    const frame = project.media.find((m) => m.id === take.frameMediaId)!;
    const video = this.catalog.get(take.videoModel);
    const cast = shot.castIds.map((id) => project.cast.find((c) => c.id === id)).filter((c): c is CastMember => !!c);
    const plan = this.audioPlan(shot.audio, video, shot.dialogue.length > 0);
    const audio = this.clipAudio(plan, video, take.tier);
    const durationS = billedDuration(video, shot.durationS);
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
          prompt: videoPrompt({ shot, cast, nativeAudio: audio, speak: plan === "native" }),
          image: {
            bytes: await this.deps.media.read(projectId, frame),
            contentType: frame.contentType,
            name: frame.path.split("/").pop()!,
          },
          durationS,
          aspect: project.aspect,
          audio,
        },
        estimateInput: { durationS, audio },
        ...(owner ? { owner } : {}),
      });
      await this.projects.mutate(projectId, (proj) => {
        const t = findShot(proj, shotId).shot.takes.find((x) => x.id === takeId);
        if (t) t.videoJobId = job.id;
      });
    } catch (err) {
      await this.projects.mutate(projectId, (proj) => {
        const t = findShot(proj, shotId).shot.takes.find((x) => x.id === takeId);
        if (t) {
          t.status = "failed";
          t.error = (err as Error).message;
        }
      });
      throw err;
    }
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
      },
    });
    this.runner.on("video", {
      apply: (project, job, r) => {
        const t = takeOf(project, job);
        if (!t || !r.media) return;
        t.videoMediaId = r.media.id;
        t.status = "done";
        const { shot } = findShot(project, job.refs.shotId!);
        const selected = shot.takes.find((x) => x.id === shot.selectedTakeId);
        // A new final replaces the selection; a new draft is selected unless a final already is.
        if (!selected || t.tier === "final" || selected.tier === "draft") shot.selectedTakeId = t.id;
      },
      fail: failTake,
      after: async (job) => {
        if (job.state === "done" || job.state === "failed") await this.releaseWaiting(job);
        if (job.state === "done") await this.isolateVoices(job).catch(() => {});
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

/** The shot this one continues from: the one before it in its scene, if it asks to continue. */
export function continuesFrom(project: Project, shotId: string): Shot | undefined {
  const { shot, scene, index } = findShot(project, shotId);
  return shot.continueFromPrevious && index > 0 ? scene.shots[index - 1] : undefined;
}

/** Which of the previous shot's takes a continued take starts from: its finished final for a final, else the take on its card. */
export function chainSource(prev: Shot, tier: Tier): Take | undefined {
  const done = prev.takes.filter((t) => t.status === "done" && t.videoMediaId);
  if (tier === "final") {
    const sel = done.find((t) => t.id === prev.selectedTakeId && t.tier === "final");
    return sel ?? done.filter((t) => t.tier === "final").at(-1);
  }
  return done.find((t) => t.id === prev.selectedTakeId) ?? done.at(-1);
}

/** The last frame of a clip, as a JPEG. */
async function lastFrame(clip: Uint8Array): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "reel-chain-"));
  try {
    const src = join(dir, "clip.mp4");
    const out = join(dir, "last.jpg");
    writeFileSync(src, clip);
    await runFfmpeg(["-sseof", "-0.2", "-i", src, "-update", "1", "-q:v", "2", out]);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** ElevenLabs sound effects top out at 22 s; the loop tiles it under a scene of any length. */
const AMBIENCE_SECONDS = 22;

/** A clip's soundtrack as WAV, or null when it has none. */
async function clipAudioTrack(clip: Uint8Array): Promise<{ bytes: Uint8Array; seconds: number } | null> {
  const dir = mkdtempSync(join(tmpdir(), "reel-voice-"));
  try {
    const src = join(dir, "clip.mp4");
    const out = join(dir, "audio.wav");
    writeFileSync(src, clip);
    if (!(await hasAudio(src))) return null;
    await runFfmpeg(["-i", src, "-vn", "-ac", "2", "-ar", "44100", out]);
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
