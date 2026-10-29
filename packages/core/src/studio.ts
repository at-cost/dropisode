/**
 * The studio: everything a creator does, on top of the job runner. Local and
 * hosted both build one of these; hosted passes in a provider wrapped with
 * billing and moderation.
 */
import { createHash } from "node:crypto";
import { type Catalog, type CatalogModel, type Estimate, billedDuration, estimate, roughTokens, supportsAspect } from "./catalog";
import { EditError, addCast, addEpisode, addScene, addShot, castByName, findCast, findEpisode, findScene, findShot, newId } from "./edit";
import { JobRunner, type RunnerDeps } from "./jobs";
import type { CastMember, MediaRef, Project, Take, Tier } from "./project";
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

  /** The exact price shown on a shot's generate button. */
  estimateTake(project: Project, shotId: string, tier: Tier, models: { image?: string; video?: string } = {}): TakeEstimate {
    const { shot } = findShot(project, shotId);
    const d = this.catalog.defaultsFor(tier);
    const image = this.catalog.get(models.image ?? d.image);
    const video = this.catalog.get(models.video ?? d.video);
    const audio =
      tier === "draft" && !this.catalog.config.defaults.draftAudio ? "none" : this.audioPlan(shot.audio, video, shot.dialogue.length > 0);
    const frame = estimate(image, { images: 1 });
    const vid = estimate(video, { durationS: shot.durationS, audio: audio === "native" });
    const tts =
      audio === "tts" && tier === "final"
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
    const video = this.catalog.get(this.catalog.defaultsFor("final").video);
    const { text: answer } = await this.llm(
      projectId,
      "storyboard",
      storyboardPrompt({
        sceneScript: scene.script,
        heading: scene.heading,
        cast: project.cast,
        durations: video.durations,
        ...(p.targetSeconds ? { targetSeconds: p.targetSeconds } : {}),
      }),
      { episodeId: episode.id, sceneId },
      p.owner,
    );
    const shots = parseStoryboard(answer);
    return this.projects.mutate(projectId, (proj) => {
      const { scene: sc } = findScene(proj, sceneId);
      assertNothingRunning(sc.shots);
      sc.shots = [];
      for (const s of shots) {
        const castIds = (s.cast ?? []).map((n) => castByName(proj, n)?.id).filter((x): x is string => !!x);
        if (sc.locationId && !castIds.includes(sc.locationId)) castIds.push(sc.locationId);
        addShot(sc, {
          description: s.description,
          camera: s.camera ?? "",
          castIds,
          dialogue: (s.dialogue ?? []).map((d) => ({ castId: d.speaker ? (castByName(proj, d.speaker)?.id ?? null) : null, text: d.text })),
          durationS: s.duration ?? 5,
        });
      }
      return sc.shots.length;
    });
  }

  // Cast images

  async generateCastImage(
    projectId: string,
    castId: string,
    p: { modelId?: string; owner?: Record<string, string> } = {},
  ): Promise<JobRecord> {
    const project = await this.projects.get(projectId);
    const member = findCast(project, castId);
    const modelId = p.modelId ?? this.catalog.config.defaults.castImage;
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
    await this.projects.mutate(projectId, (proj) => {
      findShot(proj, shotId).shot.takes.push(take);
    });

    const refs = await this.referenceImages(project, shot.castIds, scene.locationId, image.maxRefImages);
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
        tier,
        refs: { episodeId: episode.id, sceneId: scene.id, shotId, takeId: take.id },
        input: {
          prompt: framePrompt({ shot, cast, location, aspect: project.aspect }),
          aspect: project.aspect,
          ...(refs.length ? { images: refs } : {}),
        },
        estimateInput: { images: 1 },
        ...(p.owner ? { owner: p.owner } : {}),
      });
    } catch (err) {
      // Nothing was sent: remove the take.
      await this.projects.mutate(projectId, (proj) => {
        const s = findShot(proj, shotId).shot;
        s.takes = s.takes.filter((x) => x.id !== take.id);
      });
      throw err;
    }
    await this.projects.mutate(projectId, (proj) => {
      const t = findShot(proj, shotId).shot.takes.find((x) => x.id === take.id);
      if (!t) return;
      t.frameJobId = job.id;
      if (t.status === "queued") t.status = "running";
    });
    // The frame is on its way (and may be charged), so the take stays whatever happens to the voice lines.
    if (tier === "final" && est.audio === "tts") {
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

  private async referenceImages(project: Project, castIds: string[], locationId: string | null, max: number): Promise<MediaInput[]> {
    if (max <= 0) return [];
    const ids = [...castIds];
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
      });
    }
    return out;
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
    const draftSilent = take.tier === "draft" && !this.catalog.config.defaults.draftAudio;
    const audio = !draftSilent && this.audioPlan(shot.audio, video, shot.dialogue.length > 0) === "native";
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
          prompt: videoPrompt({ shot, cast, nativeAudio: audio }),
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
        t.error = error;
      }
    };

    this.runner.on("cast_image", {
      apply: (project, job, r) => {
        const c = project.cast.find((x) => x.id === job.refs.castId);
        if (c && r.media && !c.refImageIds.includes(r.media.id)) c.refImageIds.unshift(r.media.id);
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
