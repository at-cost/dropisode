/**
 * The cut's arithmetic: whole frames at the edit's rate, where a take starts and ends, how far a dissolve
 * overlaps and whether a cutaway fits. The assembly and the studio's Cut panel both use it, so the length the
 * panel states is the length the episode comes out. No Node imports: the web UI bundles this file.
 */

/** The edit's frame rate. */
export const FPS = 30;

/** Whole frames that fit before `s` seconds. A hair of slack, so 4.1 s is 123 frames, not 122.99... */
export function framesTo(s: number): number {
  return Math.floor(s * FPS + 1e-6);
}

interface TakeLike {
  id: string;
  status: string;
  tier: string;
  videoMediaId?: string | undefined;
  inS?: number | undefined;
  outS?: number | undefined;
  analysis?: { durationS: number } | undefined;
}

interface ShotLike<T extends TakeLike = TakeLike> {
  id: string;
  durationS: number;
  approved?: boolean | undefined;
  selectedTakeId?: string | null | undefined;
  takes: T[];
  cutaway?: { atS: number; lengthS: number } | null | undefined;
  joinIn?: "cut" | "dissolve" | undefined;
  joinS?: number | undefined;
}

/** Where the edit ends a take (s): its end point, else the shot's length, never past the clip. */
export function takeOutS(
  take: { outS?: number | undefined; analysis?: { durationS: number } | undefined },
  shot: { durationS: number },
  clipLen?: number,
): number {
  return Math.min(take.outS ?? shot.durationS, clipLen ?? take.analysis?.durationS ?? Number.POSITIVE_INFINITY);
}

/** The fewest frames the edit keeps of a take: half a second. */
export const MIN_KEEP_F = FPS / 2;

/**
 * Where the edit starts a take (s), on a whole frame: its start point, when that leaves at least half a second
 * before `outS`. Counted in frames, so exactly half a second is kept, not lost to float rounding.
 */
export function takeInS(take: { inS?: number | undefined }, outS: number): number {
  const inF = Math.round((take.inS ?? 0) * FPS);
  return inF > 0 && framesTo(outS) - inF >= MIN_KEEP_F ? inF / FPS : 0;
}

/** The latest start point (s, a whole frame) that still keeps half a second before `outS`; 0 if none. */
export function latestInS(outS: number): number {
  return Math.max(0, framesTo(outS) - MIN_KEEP_F) / FPS;
}

/** The frames of a take the edit keeps: from `inF` up to, not including, `outF`. */
export function keptFrames(take: TakeLike, shot: { durationS: number }, clipLen?: number): { inF: number; outF: number } {
  const outS = takeOutS(take, shot, clipLen);
  return { inF: Math.round(takeInS(take, outS) * FPS), outF: framesTo(outS) };
}

/** Frames a dissolve overlaps: at most half of either shot, and none under 0.1 s. */
export function dissolveFrames(joinS: number, beforeF: number, thisF: number): number {
  const x = Math.min(framesTo(joinS), Math.floor(beforeF / 2), Math.floor(thisF / 2));
  return x >= 3 ? x : 0;
}

/** Where a cutaway lays its picture over the speaking shot (s, whole frames), or null when there is no room. */
export function cutawaySpan(
  baseS: number,
  cutLenS: number,
  c: { atS: number; lengthS: number },
): { atS: number; lenS: number; skipS: number } | null {
  const fr = (x: number) => Math.round(x * FPS) / FPS;
  // Skip the cutaway's first moment: image-to-video clips start on a still frame.
  const skipS = cutLenS >= c.lengthS + 0.6 ? 0.4 : 0;
  const atS = fr(Math.min(Math.max(0.3, c.atS), baseS - 0.5));
  const lenS = fr(Math.min(c.lengthS, cutLenS - skipS, baseS - atS));
  return lenS >= 0.5 ? { atS, lenS, skipS } : null;
}

/** The take a shot contributes, or why it can't. */
export function pickTake<T extends TakeLike>(shot: ShotLike<T>, source: "final" | "rough"): T | string {
  const done = shot.takes.filter((t) => t.status === "done" && t.videoMediaId);
  if (source === "final") {
    if (!shot.approved) return "not approved";
    const finals = done.filter((t) => t.tier === "final");
    const sel = finals.find((t) => t.id === shot.selectedTakeId);
    return sel ?? finals[finals.length - 1] ?? "no finished final take";
  }
  return done.find((t) => t.id === shot.selectedTakeId) ?? done[done.length - 1] ?? "no finished take";
}

export interface PlannedShot<S, T> {
  shot: S;
  take: T;
  /** Frames of the take kept: [inF, outF). */
  inF: number;
  outF: number;
  /** Where it starts in the episode, and how long it runs (frames). */
  startF: number;
  lengthF: number;
  /** Frames it dissolves in over the shot before. */
  dissolveF: number;
  /** A cutaway laid over an earlier shot: it adds no time. */
  overShotId?: string;
}

/**
 * The episode as the assembly will cut it, without touching a file: which take each shot gives, the part kept,
 * the dissolves, and the total. `clipLen` is each clip's length (default: its measured length).
 */
export function planCut<S extends ShotLike, T extends TakeLike = S["takes"][number]>(
  episode: { scenes: { shots: S[] }[] },
  source: "final" | "rough",
  opts: { clipLen?: (take: T) => number | undefined; usable?: (take: T) => boolean } = {},
): { shots: PlannedShot<S, T>[]; totalF: number } {
  const shots: PlannedShot<S, T>[] = [];
  let t = 0;
  for (const scene of episode.scenes) {
    let speaking: PlannedShot<S, T> | undefined;
    for (const shot of scene.shots) {
      const take = pickTake(shot, source) as T | string;
      if (typeof take === "string") {
        if (!shot.cutaway) speaking = undefined;
        continue;
      }
      if (opts.usable && !opts.usable(take)) continue;
      const len = opts.clipLen ? opts.clipLen(take) : take.analysis?.durationS;
      const { inF, outF } = keptFrames(take, shot, len);
      const lengthF = outF - inF;
      if (shot.cutaway && speaking && cutawaySpan(speaking.lengthF / FPS, lengthF / FPS, shot.cutaway)) {
        shots.push({ shot, take, inF, outF, startF: speaking.startF, lengthF, dissolveF: 0, overShotId: speaking.shot.id });
        continue;
      }
      const before = [...shots].reverse().find((s) => !s.overShotId);
      const dissolveF = shot.joinIn === "dissolve" && before ? dissolveFrames(shot.joinS ?? 0.5, before.lengthF, lengthF) : 0;
      t -= dissolveF;
      const entry: PlannedShot<S, T> = { shot, take, inF, outF, startF: t, lengthF, dissolveF };
      shots.push(entry);
      if (!shot.cutaway) speaking = entry;
      t += lengthF;
    }
  }
  return { shots, totalF: t };
}
