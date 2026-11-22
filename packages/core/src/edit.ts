/**
 * Edits to a project. Each function mutates the project it is given and
 * returns the thing it created or changed; callers save the project after.
 */
import { randomBytes } from "node:crypto";
import {
  type Aspect,
  type Beat,
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
    models: {},
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
  const ep: Episode = {
    id: newId("ep"),
    title: p.title,
    script: p.script ?? "",
    scenes: [],
    music: null,
    fadeInS: 0,
    fadeOutS: 0,
    soundLead: "voices",
  };
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
    cutting: "continuous",
    ambience: null,
    master: null,
    plate: "",
    grade: "",
    castNotes: [],
    counts: [],
    whitelist: [],
    start: "references",
    autoRetake: false,
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
  endPicture?: string;
  onScreenText?: string;
  audio?: Shot["audio"];
  cutaway?: Shot["cutaway"];
  beats?: Beat[];
  logline?: string;
  startState?: string;
  sounds?: string[];
  slowMotion?: boolean;
}

/** Sequence fields of a new shot: an ordinary shot has none. */
const sequenceFields = (p: Partial<ShotInput> = {}) => ({
  beats: p.beats ?? [],
  logline: p.logline ?? "",
  startState: p.startState ?? "",
  sounds: p.sounds ?? [],
  slowMotion: p.slowMotion ?? false,
  writtenPrompt: "",
  writtenFor: "",
  promptStale: false,
});

/** A sequence runs to the end of its last beat. */
export const sequenceSeconds = (beats: Beat[]): number => beats.reduce((a, b) => Math.max(a, b.endS), 0);

/** Beats in time order, each inside the clip and at least half a second long. */
export function cleanBeats(beats: Beat[]): Beat[] {
  const out = [...beats]
    .filter((b) => Number.isFinite(b.startS) && Number.isFinite(b.endS))
    .sort((a, b) => a.startS - b.startS)
    .map((b) => ({ ...b, startS: round1(Math.max(0, b.startS)), endS: round1(Math.min(30, b.endS)) }));
  for (const b of out) if (!(b.endS - b.startS >= 0.5)) throw new EditError("Each shot in a sequence lasts at least half a second");
  for (let i = 1; i < out.length; i++)
    if (out[i]!.startS < out[i - 1]!.endS - 1e-9) throw new EditError("The shots in a sequence can't overlap in time");
  return out;
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
    endPicture: p.endPicture ?? "",
    onScreenText: p.onScreenText ?? "",
    cutaway: p.cutaway ?? null,
    joinIn: "cut" as const,
    joinS: 0.5,
    move: "none" as const,
    ...sequenceFields(p),
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
      | "endPicture"
      | "onScreenText"
      | "cutaway"
      | "joinIn"
      | "joinS"
      | "move"
      | "beats"
      | "logline"
      | "startState"
      | "sounds"
      | "slowMotion"
      | "writtenPrompt"
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
  const content = [
    "description",
    "camera",
    "castIds",
    "durationS",
    "dialogue",
    "continueFromPrevious",
    "endPicture",
    "beats",
    "logline",
    "startState",
    "sounds",
    "slowMotion",
    "writtenPrompt",
  ] as const;
  const changesContent = content.some((k) => patch[k] !== undefined);
  // What the written prompt was made from: changing it makes the prompt out of date (the creator may rewrite it or keep it).
  const plan = [
    "description",
    "camera",
    "castIds",
    "durationS",
    "dialogue",
    "beats",
    "logline",
    "startState",
    "sounds",
    "slowMotion",
  ] as const;
  if (plan.some((k) => patch[k] !== undefined) && shot.writtenPrompt.trim() && patch.writtenPrompt === undefined) shot.promptStale = true;
  if (patch.beats !== undefined) {
    shot.beats = cleanBeats(patch.beats);
    if (shot.beats.length) shot.durationS = Math.min(30, Math.max(1, sequenceSeconds(shot.beats)));
  }
  if (patch.logline !== undefined) shot.logline = patch.logline.slice(0, 600);
  if (patch.startState !== undefined) shot.startState = patch.startState.slice(0, 1000);
  if (patch.sounds !== undefined)
    shot.sounds = patch.sounds
      .map((x) => x.trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 20);
  if (patch.slowMotion !== undefined) shot.slowMotion = patch.slowMotion;
  if (patch.writtenPrompt !== undefined) {
    // The creator's own words: sent as they are, and up to date by definition.
    shot.writtenPrompt = patch.writtenPrompt.slice(0, 12_000);
    shot.promptStale = false;
  }
  if (patch.description !== undefined) shot.description = patch.description;
  if (patch.camera !== undefined) shot.camera = patch.camera;
  if (patch.castIds !== undefined) shot.castIds = patch.castIds;
  if (patch.durationS !== undefined && patch.beats === undefined) {
    if (!(patch.durationS > 0 && patch.durationS <= 30)) throw new EditError("A shot is between 0 and 30 seconds");
    shot.durationS = patch.durationS;
  }
  if (patch.audio !== undefined) shot.audio = patch.audio;
  if (patch.continueFromPrevious !== undefined) shot.continueFromPrevious = patch.continueFromPrevious;
  if (patch.endPicture !== undefined) shot.endPicture = patch.endPicture.slice(0, 2000);
  if (patch.onScreenText !== undefined) shot.onScreenText = patch.onScreenText.slice(0, 300);
  if (patch.cutaway !== undefined) shot.cutaway = patch.cutaway;
  // Joins and moves are made in the edit, like on-screen text: the clip and its approval stand.
  if (patch.joinIn !== undefined) shot.joinIn = patch.joinIn;
  if (patch.joinS !== undefined) shot.joinS = Math.min(2, Math.max(0.2, patch.joinS));
  if (patch.move !== undefined) shot.move = patch.move;
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
  if (shot.beats.length) throw new EditError("A sequence is one generation: edit the shots inside it instead of splitting it");
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
    endPicture: shot.endPicture,
    onScreenText: "",
    cutaway: null,
    joinIn: "cut" as const,
    joinS: 0.5,
    move: "none" as const,
    ...sequenceFields(),
  };
  shot.dialogue = shot.dialogue.slice(0, cut);
  shot.durationS = round1(at);
  // The target is how the shot ends: it belongs to the second half. The first half's takes now end at the split.
  shot.endPicture = "";
  for (const t of shot.takes) t.outS = Math.min(t.outS ?? at, at);
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
  if (shot.beats.length || next.beats.length) {
    // Two sequences (or a sequence and a shot) become one generation: the second's shots follow the first's.
    const asBeats = (s: Shot): Beat[] =>
      s.beats.length
        ? s.beats
        : [
            {
              startS: 0,
              endS: s.durationS,
              size: "",
              angle: s.camera,
              height: "",
              lens: "",
              movement: "",
              action: s.description,
              endState: "",
            },
          ];
    const first = asBeats(shot);
    const offset = sequenceSeconds(first);
    const merged = [...first, ...asBeats(next).map((b) => ({ ...b, startS: round1(b.startS + offset), endS: round1(b.endS + offset) }))];
    if (sequenceSeconds(merged) > 30) throw new EditError("Together these run over 30 seconds, the longest one generation can be");
    shot.beats = merged;
    shot.sounds = [...new Set([...shot.sounds, ...next.sounds])].slice(0, 20);
    shot.slowMotion = shot.slowMotion || next.slowMotion;
    if (shot.writtenPrompt.trim()) shot.promptStale = true;
  }
  // After a split both halves share a description; don't repeat it.
  shot.description = next.description === shot.description ? shot.description : `${shot.description}\n${next.description}`.trim();
  shot.camera = shot.camera || next.camera;
  shot.castIds = [...new Set([...shot.castIds, ...next.castIds])];
  shot.dialogue = [...shot.dialogue, ...next.dialogue];
  shot.durationS = shot.beats.length ? sequenceSeconds(shot.beats) : Math.min(30, round1(shot.durationS + next.durationS));
  shot.approved = false;
  // The merged shot ends where the second one did.
  shot.endPicture = next.endPicture || shot.endPicture;
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
