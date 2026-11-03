/**
 * Edits to a project. Each function mutates the project it is given and
 * returns the thing it created or changed; callers save the project after.
 */
import { randomBytes } from "node:crypto";
import {
  type Aspect,
  type CastKind,
  type CastMember,
  type CostLine,
  type DialogueLine,
  type Episode,
  PROJECT_FORMAT,
  type Project,
  type Scene,
  type Shot,
} from "./project";

export const newId = (prefix: string): string => `${prefix}_${randomBytes(6).toString("base64url")}`;
const now = () => new Date().toISOString();

export class EditError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid" | "not_approved" = "invalid",
  ) {
    super(message);
  }
}

export function createProject(p: { name: string; idea?: string; aspect?: Aspect; id?: string }): Project {
  const t = now();
  return {
    format: PROJECT_FORMAT,
    id: p.id ?? newId("prj"),
    name: p.name,
    idea: p.idea ?? "",
    aspect: p.aspect ?? "9:16",
    createdAt: t,
    updatedAt: t,
    cast: [],
    episodes: [],
    media: [],
    costLog: [],
  };
}

export function touch(project: Project): void {
  project.updatedAt = now();
}

// Lookups

export function findEpisode(project: Project, episodeId: string): Episode {
  const ep = project.episodes.find((e) => e.id === episodeId);
  if (!ep) throw new EditError(`No episode ${episodeId}`, "not_found");
  return ep;
}

export function findScene(project: Project, sceneId: string): { episode: Episode; scene: Scene } {
  for (const episode of project.episodes) {
    const scene = episode.scenes.find((s) => s.id === sceneId);
    if (scene) return { episode, scene };
  }
  throw new EditError(`No scene ${sceneId}`, "not_found");
}

export function findShot(project: Project, shotId: string): { episode: Episode; scene: Scene; shot: Shot; index: number } {
  for (const episode of project.episodes) {
    for (const scene of episode.scenes) {
      const index = scene.shots.findIndex((s) => s.id === shotId);
      if (index >= 0) return { episode, scene, shot: scene.shots[index]!, index };
    }
  }
  throw new EditError(`No shot ${shotId}`, "not_found");
}

export function findCast(project: Project, castId: string): CastMember {
  const c = project.cast.find((x) => x.id === castId);
  if (!c) throw new EditError(`No cast member ${castId}`, "not_found");
  return c;
}

// Episodes and scenes

export function addEpisode(project: Project, p: { title: string; script?: string }): Episode {
  const ep: Episode = { id: newId("ep"), title: p.title, script: p.script ?? "", scenes: [], music: null };
  project.episodes.push(ep);
  return ep;
}

export function addScene(episode: Episode, p: { heading: string; script?: string; locationId?: string | null }): Scene {
  const scene: Scene = {
    id: newId("sc"),
    heading: p.heading,
    script: p.script ?? "",
    locationId: p.locationId ?? null,
    shots: [],
    staging: "",
    ambience: null,
    master: null,
  };
  episode.scenes.push(scene);
  return scene;
}

// Cast

export function addCast(project: Project, p: { kind: CastKind; name: string; description?: string }): CastMember {
  const c: CastMember = { id: newId("cast"), kind: p.kind, name: p.name, description: p.description ?? "", refImageIds: [] };
  project.cast.push(c);
  return c;
}

export function removeCast(project: Project, castId: string): void {
  findCast(project, castId);
  project.cast = project.cast.filter((c) => c.id !== castId);
  for (const ep of project.episodes) {
    for (const sc of ep.scenes) {
      if (sc.locationId === castId) sc.locationId = null;
      for (const sh of sc.shots) {
        sh.castIds = sh.castIds.filter((id) => id !== castId);
        for (const line of sh.dialogue) if (line.castId === castId) line.castId = null;
      }
    }
  }
}

/** Finds cast members by name, ignoring case. Used to link storyboard output to the cast. */
export function castByName(project: Project, name: string): CastMember | undefined {
  const n = name.trim().toLowerCase();
  return project.cast.find((c) => c.name.trim().toLowerCase() === n);
}

// Shots

export interface ShotInput {
  description: string;
  camera?: string;
  castIds?: string[];
  dialogue?: { castId: string | null; text: string }[];
  durationS: number;
  continueFromPrevious?: boolean;
  onScreenText?: string;
  audio?: Shot["audio"];
  cutaway?: Shot["cutaway"];
}

const toLines = (lines: { castId: string | null; text: string }[] = []): DialogueLine[] =>
  lines.map((l) => ({ id: newId("line"), castId: l.castId, text: l.text }));

export function addShot(scene: Scene, p: ShotInput, at?: number): Shot {
  const shot: Shot = {
    id: newId("shot"),
    description: p.description,
    camera: p.camera ?? "",
    castIds: p.castIds ?? [],
    dialogue: toLines(p.dialogue),
    durationS: p.durationS,
    audio: p.audio ?? "native",
    approved: false,
    takes: [],
    continueFromPrevious: p.continueFromPrevious ?? false,
    onScreenText: p.onScreenText ?? "",
    cutaway: p.cutaway ?? null,
  };
  if (at === undefined) scene.shots.push(shot);
  else scene.shots.splice(Math.max(0, Math.min(at, scene.shots.length)), 0, shot);
  return shot;
}

/** Fields a creator may edit on a card. Editing what the shot shows clears its approval. */
export function updateShot(
  project: Project,
  shotId: string,
  patch: Partial<
    Pick<
      Shot,
      | "description"
      | "camera"
      | "castIds"
      | "durationS"
      | "audio"
      | "approved"
      | "selectedTakeId"
      | "continueFromPrevious"
      | "onScreenText"
      | "cutaway"
    >
  > & {
    dialogue?: { id?: string; castId: string | null; text: string }[];
  },
): Shot {
  const { shot } = findShot(project, shotId);
  for (const id of patch.castIds ?? []) findCast(project, id);
  if (patch.selectedTakeId !== undefined && !shot.takes.some((t) => t.id === patch.selectedTakeId))
    throw new EditError("No such take", "not_found");
  // On-screen text is drawn at assembly, so changing it doesn't touch the clip or its approval.
  const content = ["description", "camera", "castIds", "durationS", "dialogue", "continueFromPrevious"] as const;
  const changesContent = content.some((k) => patch[k] !== undefined);
  if (patch.description !== undefined) shot.description = patch.description;
  if (patch.camera !== undefined) shot.camera = patch.camera;
  if (patch.castIds !== undefined) shot.castIds = patch.castIds;
  if (patch.durationS !== undefined) {
    if (!(patch.durationS > 0 && patch.durationS <= 30)) throw new EditError("A shot is between 0 and 30 seconds");
    shot.durationS = patch.durationS;
  }
  if (patch.audio !== undefined) shot.audio = patch.audio;
  if (patch.continueFromPrevious !== undefined) shot.continueFromPrevious = patch.continueFromPrevious;
  if (patch.onScreenText !== undefined) shot.onScreenText = patch.onScreenText.slice(0, 300);
  if (patch.cutaway !== undefined) shot.cutaway = patch.cutaway;
  if (patch.dialogue !== undefined) {
    const old = new Map(shot.dialogue.map((l) => [l.id, l]));
    shot.dialogue = patch.dialogue.map((l) => {
      const prev = l.id ? old.get(l.id) : undefined;
      // Changed words make an old text-to-speech take wrong.
      const keepTts = prev && prev.text === l.text && prev.castId === l.castId ? prev.ttsMediaId : undefined;
      return { id: prev?.id ?? newId("line"), castId: l.castId, text: l.text, ...(keepTts ? { ttsMediaId: keepTts } : {}) };
    });
  }
  if (patch.selectedTakeId !== undefined) shot.selectedTakeId = patch.selectedTakeId;
  if (patch.approved !== undefined) shot.approved = patch.approved;
  else if (changesContent) shot.approved = false;
  return shot;
}

export function deleteShot(project: Project, shotId: string): void {
  const { scene, index } = findShot(project, shotId);
  scene.shots.splice(index, 1);
}

/** Moves a shot to a new position, possibly in another scene. */
export function moveShot(project: Project, shotId: string, toSceneId: string, toIndex: number): void {
  const { scene, index, shot } = findShot(project, shotId);
  const { scene: target } = findScene(project, toSceneId);
  scene.shots.splice(index, 1);
  target.shots.splice(Math.max(0, Math.min(toIndex, target.shots.length)), 0, shot);
}

/**
 * Splits a shot in two at `atS` seconds. The second half keeps the description,
 * cast and camera; dialogue lines are divided by count. Takes stay with the first half.
 */
export function splitShot(project: Project, shotId: string, atS?: number): [Shot, Shot] {
  const { scene, index, shot } = findShot(project, shotId);
  const at = atS ?? shot.durationS / 2;
  if (!(at > 0 && at < shot.durationS)) throw new EditError("Split point must be inside the shot");
  const cut = Math.ceil(shot.dialogue.length / 2);
  const second: Shot = {
    id: newId("shot"),
    description: shot.description,
    camera: shot.camera,
    castIds: [...shot.castIds],
    dialogue: shot.dialogue.slice(cut),
    durationS: round1(shot.durationS - at),
    audio: shot.audio,
    approved: false,
    takes: [],
    // The second half picks up exactly where the first ends.
    continueFromPrevious: true,
    onScreenText: "",
    cutaway: null,
  };
  shot.dialogue = shot.dialogue.slice(0, cut);
  shot.durationS = round1(at);
  shot.approved = false;
  scene.shots.splice(index + 1, 0, second);
  return [shot, second];
}

/** Merges a shot with the one after it. Durations add (capped at 30 s), dialogue and cast join. */
export function mergeWithNext(project: Project, shotId: string): Shot {
  const { scene, index, shot } = findShot(project, shotId);
  const next = scene.shots[index + 1];
  if (!next) throw new EditError("There is no next shot in this scene to merge with");
  if (next.takes.some((t) => t.status === "queued" || t.status === "running"))
    throw new EditError("The next shot is still generating. Wait for it to finish first.");
  // After a split both halves share a description; don't repeat it.
  shot.description = next.description === shot.description ? shot.description : `${shot.description}\n${next.description}`.trim();
  shot.camera = shot.camera || next.camera;
  shot.castIds = [...new Set([...shot.castIds, ...next.castIds])];
  shot.dialogue = [...shot.dialogue, ...next.dialogue];
  shot.durationS = Math.min(30, round1(shot.durationS + next.durationS));
  shot.approved = false;
  shot.takes = [...shot.takes, ...next.takes];
  scene.shots.splice(index + 1, 1);
  return shot;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// Totals

export interface CostTotals {
  /** What the provider billed. */
  providerCostMicro: number;
  tries: number;
  refunds: number;
  pending: number;
}

function sum(lines: CostLine[]): CostTotals {
  return {
    providerCostMicro: lines.reduce((a, l) => a + l.providerCostMicro, 0),
    tries: lines.length,
    refunds: lines.filter((l) => l.status === "refunded").length,
    pending: lines.filter((l) => l.status === "pending").length,
  };
}

export function projectTotals(project: Project): CostTotals {
  return sum(project.costLog);
}

export function episodeTotals(project: Project, episodeId: string): CostTotals {
  return sum(project.costLog.filter((l) => l.episodeId === episodeId));
}

export function shotCostLog(project: Project, shotId: string): CostLine[] {
  return project.costLog.filter((l) => l.shotId === shotId);
}
