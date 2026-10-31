import type { Project, Shot } from "./api";

export type Step = "script" | "cast" | "storyboard" | "episode";

const allShots = (p: Project): Shot[] => p.episodes.flatMap((e) => e.scenes.flatMap((s) => s.shots));
const hasDoneTake = (s: Shot) => s.takes.some((t) => t.status === "done" && t.videoMediaId);

/** Which steps of making an episode are finished. */
export function stepsDone(p: Project, exports: number): Record<Step, boolean> {
  const shots = allShots(p);
  return {
    script: p.episodes.some((e) => e.script.trim().length > 0),
    cast: p.cast.length > 0 && p.cast.every((c) => c.refImageIds.length > 0),
    storyboard: shots.length > 0 && shots.every(hasDoneTake),
    episode: exports > 0,
  };
}

/** A short status for a project card, and how far along it is (0 to 1). */
export function projectStatus(p: Project, exports: number): { label: string; tone: string; progress: number } {
  const done = stepsDone(p, exports);
  const progress = Object.values(done).filter(Boolean).length / 4;
  const shots = allShots(p);
  if (done.episode) return { label: "Episode ready", tone: "ok", progress };
  if (shots.some((s) => s.takes.length > 0)) return { label: "In production", tone: "live", progress };
  if (shots.length > 0) return { label: "Storyboarding", tone: "plain", progress };
  if (done.script) return { label: "Script ready", tone: "plain", progress };
  return { label: "New", tone: "plain", progress };
}

/** Where a shot is in the pipeline, for the board and the status label. */
export type Stage = "todo" | "drafted" | "approved" | "final";

export function shotStage(s: Shot): Stage {
  if (s.takes.some((t) => t.tier === "final" && t.status === "done" && t.videoMediaId)) return "final";
  if (s.approved) return "approved";
  if (s.takes.length > 0) return "drafted";
  return "todo";
}

export function shotStatus(s: Shot, generating: boolean): { label: string; tone: string } {
  if (generating) return { label: "Rendering", tone: "live" };
  const stage = shotStage(s);
  if (stage === "final") return { label: "Final ready", tone: "ok" };
  if (stage === "approved") return { label: "Approved", tone: "ok" };
  const last = s.takes[s.takes.length - 1];
  if (last?.status === "failed") return { label: "Failed", tone: "danger" };
  if (stage === "drafted") return { label: "Draft ready", tone: "plain" };
  return { label: "To draft", tone: "plain" };
}
