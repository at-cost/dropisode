/**
 * Reads how a clip moves, frame by frame, to catch the two faults that make AI video look
 * broken once shots are joined: a stall at the end (the model easing to a stop to match a
 * target picture) and a one-frame jump (a hidden cut or snap inside the take). Sampling a few
 * frames a second hides both, so this compares every frame at a tiny size.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaDuration, runFfmpeg } from "./ffmpeg";

const W = 36;
const H = 64;

export interface ClipMotion {
  durationS: number;
  fps: number;
  /** Mean frame-to-frame change per half second (0 to 255 scale). */
  motion: number[];
  /** Times (s) of one-frame jumps: a change far bigger than the frames around it. */
  jumps: number[];
  /** Where a stall at the end starts (s), if the clip eases to a near standstill. */
  stallFromS?: number;
  /** Where the edit should end this clip (s): before a stall, else its full length. */
  suggestedOutS: number;
  /** Where the clip starts to move (s), when it holds its first frame for a moment. */
  suggestedInS?: number;
}

/** Frame-to-frame differences of a clip, at its own frame rate. */
async function frameDiffs(path: string): Promise<{ diffs: number[]; fps: number }> {
  const dir = mkdtempSync(join(tmpdir(), "reel-motion-"));
  try {
    const raw = join(dir, "frames.gray");
    await runFfmpeg(["-i", path, "-an", "-vf", `scale=${W}:${H},format=gray`, "-f", "rawvideo", raw]);
    const bytes = readFileSync(raw);
    const size = W * H;
    const n = Math.floor(bytes.length / size);
    const diffs: number[] = [];
    for (let f = 1; f < n; f++) {
      let sum = 0;
      const a = (f - 1) * size;
      const b = f * size;
      for (let i = 0; i < size; i++) sum += Math.abs(bytes[b + i]! - bytes[a + i]!);
      diffs.push(sum / size);
    }
    const dur = await mediaDuration(path);
    return { diffs, fps: dur > 0 ? Math.round(n / dur) || 24 : 24 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** The pure analysis, separated from ffmpeg so it can be tested on numbers. */
export function analyseDiffs(diffs: number[], fps: number, durationS: number): ClipMotion {
  const half = Math.max(1, Math.round(fps / 2));
  const motion: number[] = [];
  for (let i = 0; i + half <= diffs.length; i += half)
    motion.push(+(diffs.slice(i, i + half).reduce((a, b) => a + b, 0) / half).toFixed(2));

  const jumps: number[] = [];
  diffs.forEach((v, i) => {
    const around = [...diffs.slice(Math.max(0, i - 6), i), ...diffs.slice(i + 1, i + 7)];
    const base = median(around);
    if (v > 4 && v > base * 3) jumps.push(+((i + 1) / fps).toFixed(2));
  });

  // A stall: from some point to the end, every half second moves less than a third of the clip's typical motion.
  const typical = median(motion.slice(0, Math.max(1, Math.ceil(motion.length * 0.75))));
  const still = Math.max(0.5, typical * 0.35);
  let k = motion.length;
  while (k > 0 && motion[k - 1]! < still) k--;
  const stallHalves = motion.length - k;
  const stallFromS = stallHalves >= 1 && typical > 1 ? +(k * 0.5).toFixed(2) : undefined;
  // Never trim away more than half the clip: a mostly still clip is meant to be still.
  const suggestedOutS =
    stallFromS !== undefined && stallFromS >= durationS * 0.5 ? +Math.min(durationS, stallFromS + 0.1).toFixed(2) : +durationS.toFixed(2);
  // The exact length, unrounded: the edit and a chained shot cap against it and must pick the same frame.
  // A held first frame: the opening frames barely change. Start the edit where movement begins (never past a second in).
  let lead = 0;
  const calm = Math.max(0.25, typical * 0.08);
  while (lead < diffs.length && lead < fps && diffs[lead]! < calm) lead++;
  const suggestedInS = typical > 1 && lead >= 3 && lead < diffs.length ? +(lead / fps).toFixed(2) : undefined;
  return {
    durationS,
    fps,
    motion,
    jumps,
    ...(stallFromS !== undefined ? { stallFromS } : {}),
    suggestedOutS,
    ...(suggestedInS !== undefined ? { suggestedInS } : {}),
  };
}

export async function analyseClip(clip: Uint8Array): Promise<ClipMotion> {
  const dir = mkdtempSync(join(tmpdir(), "reel-motion-src-"));
  try {
    const src = join(dir, "clip.mp4");
    writeFileSync(src, clip);
    const { diffs, fps } = await frameDiffs(src);
    return analyseDiffs(diffs, fps, await mediaDuration(src));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The last frame the edit shows of a clip ending at `atS` (s), as a JPEG: the first frame of the shot that
 * continues from it. Quantised exactly as the assembly does (whole frames at `fps`), and seeked precisely.
 */
export async function frameAt(clip: Uint8Array, atS: number | undefined, fps = 30): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "reel-frame-"));
  try {
    const src = join(dir, "clip.mp4");
    const out = join(dir, "frame.jpg");
    writeFileSync(src, clip);
    const dur = await mediaDuration(src);
    // The frame just before the cut point; the very end of a file can't be decoded reliably.
    // (The same slack as the assembly's framesTo, so 4.1 s ends on frame 123 in both.)
    const shown = Math.floor(Math.min(atS ?? dur, dur) * fps + 1e-6) / fps;
    // Half a frame from the end at most, so the very last frame is still found.
    const t = Math.max(0, Math.min(shown - 1 / fps, dur - 1 / (2 * fps)));
    // Decode up to the exact time (seeking after -i), at the edit's frame rate, so it is the frame the edit ends on.
    // Seek half a frame early: the first frame at or after that is the one wanted, and a rounded-up time
    // can never land just past the clip's last frame (which gives no picture at all).
    // Some ffmpeg builds stop a frame or two short of a clip's end (a 24 fps clip resampled to the edit's rate):
    // then step back a frame at a time until there is a picture.
    for (let back = 0; back < 4; back++) {
      const seek = Math.max(0, t - (back + 0.5) / fps);
      await runFfmpeg(["-y", "-i", src, "-vf", `fps=${fps}`, "-ss", seek.toFixed(4), "-frames:v", "1", "-q:v", "2", out]);
      if (existsSync(out)) return new Uint8Array(readFileSync(out));
    }
    throw new Error("no frame could be read near the end of the clip");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
