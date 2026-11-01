import type { Project, Shot } from "./api";

/** New projects from the idea box start with this name; the script's title replaces it. */
export const PLACEHOLDER_NAME = "Untitled episode";

export type Step = "script" | "cast" | "storyboard" | "episode";

const allShots = (p: Project): Shot[] => p.episodes.flatMap((e) => e.scenes.flatMap((s) => s.shots));

/** Which steps of making an episode are finished. `exports` counts final episodes. */
export function stepsDone(p: Project, exports: number): Record<Step, boolean> {
  const shots = allShots(p);
  const storyboard = shots.length > 0 && shots.every((s) => shotStage(s) === "final");
  return {
    script: p.episodes.some((e) => e.script.trim().length > 0),
    cast: p.cast.length > 0 && p.cast.every((c) => c.refImageIds.length > 0),
    storyboard,
    // A finished episode means a finished storyboard too.
    episode: storyboard && exports > 0,
  };
}

/** A short status for a project card, and how many shots have a final take. `finalExports` counts final episodes only. */
export function projectStatus(
  p: Project,
  finalExports: number,
): { label: string; tone: string; finals: number; shots: number; progress: number } {
  const shots = allShots(p);
  const finals = shots.filter((s) => shotStage(s) === "final").length;
  const progress = shots.length ? finals / shots.length : 0;
  const base = { finals, shots: shots.length, progress };
  if (finalExports > 0 && shots.length > 0 && finals === shots.length) return { label: "Episode ready", tone: "ok", ...base };
  if (shots.some((s) => s.takes.length > 0)) return { label: "In production", tone: "live", ...base };
  if (shots.length > 0) return { label: "Storyboarding", tone: "plain", ...base };
  if (p.episodes.some((e) => e.script.trim())) return { label: "Script ready", tone: "plain", ...base };
  return { label: "New", tone: "plain", ...base };
}

/** Where a shot is in the pipeline, for the board and the status label. */
export type Stage = "todo" | "drafted" | "approved" | "final";

/** A finished take with video. */
const doneVideo = (s: Shot, tier?: "draft" | "final") =>
  s.takes.some((t) => (tier ? t.tier === tier : true) && t.status === "done" && !!t.videoMediaId);

/** Whether the shot has a final take at all, current or not. */
export const hasFinalTake = (s: Shot) => doneVideo(s, "final");

/**
 * Where a shot is. Editing what a shot shows clears its approval on the server (core edit.ts),
 * which also makes an earlier final out of date, so "final" needs the approval too.
 */
export function shotStage(s: Shot): Stage {
  if (s.approved && hasFinalTake(s)) return "final";
  if (s.approved) return "approved";
  if (doneVideo(s)) return "drafted";
  return "todo";
}

export function shotStatus(s: Shot, generating: boolean): { label: string; tone: string } {
  if (s.takes.some((t) => t.status === "queued" && t.waitsForShotId)) return { label: "Waits for the shot before", tone: "live" };
  if (generating) return { label: "Rendering", tone: "live" };
  const stage = shotStage(s);
  if (stage === "final") return { label: "Final ready", tone: "ok" };
  if (stage === "approved") return { label: "Approved", tone: "ok" };
  if (hasFinalTake(s)) return { label: "Needs approval", tone: "warn" };
  const last = s.takes[s.takes.length - 1];
  if (last?.status === "failed") return { label: "Failed", tone: "danger" };
  if (stage === "drafted") return { label: "Draft ready", tone: "plain" };
  return { label: "To draft", tone: "plain" };
}

/** Counts per stage, for the header and the episode summary alike. */
export function stageCounts(shots: Shot[]): Record<Stage, number> {
  const c: Record<Stage, number> = { todo: 0, drafted: 0, approved: 0, final: 0 };
  for (const s of shots) c[shotStage(s)]++;
  return c;
}
