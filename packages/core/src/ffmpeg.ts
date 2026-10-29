/**
 * Finds an ffmpeg that can burn in subtitles (needs libass). Order:
 * REEL_FFMPEG, then ffmpeg on PATH if it has the `subtitles` filter, then the
 * bundled ffmpeg-static binary.
 */
import { execFile, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

export interface Ffmpeg {
  path: string;
  /** Can burn subtitles. */
  subtitles: boolean;
}

let cached: Ffmpeg | null | undefined;

function probe(path: string): Ffmpeg | null {
  const r = spawnSync(path, ["-hide_banner", "-filters"], { encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) return null;
  return { path, subtitles: / subtitles /.test(r.stdout) };
}

export function findFfmpeg(): Ffmpeg | null {
  if (cached !== undefined) return cached;
  const candidates: string[] = [];
  if (process.env.REEL_FFMPEG) candidates.push(process.env.REEL_FFMPEG);
  candidates.push("ffmpeg");
  try {
    const bundled = createRequire(import.meta.url)("ffmpeg-static") as string | null;
    if (bundled) candidates.push(bundled);
  } catch {
    // ffmpeg-static not installed.
  }
  let fallback: Ffmpeg | null = null;
  for (const c of candidates) {
    const f = probe(c);
    if (f?.subtitles) {
      cached = f;
      return f;
    }
    fallback ??= f;
  }
  cached = fallback;
  return fallback;
}

export const FFMPEG_MISSING =
  "ffmpeg was not found. Install it (macOS: brew install ffmpeg; Windows: winget install ffmpeg; Linux: your package manager), or set REEL_FFMPEG to its path.";

export function requireFfmpeg(): Ffmpeg {
  const f = findFfmpeg();
  if (!f) throw new Error(FFMPEG_MISSING);
  return f;
}

/** Runs ffmpeg; rejects with the tail of its log on failure. */
export function runFfmpeg(args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<string> {
  const f = requireFfmpeg();
  return new Promise((resolve, reject) => {
    execFile(
      f.path,
      ["-hide_banner", "-loglevel", "error", "-y", ...args],
      { timeout: opts.timeoutMs ?? 10 * 60_000, maxBuffer: 16 * 1024 * 1024, ...(opts.cwd ? { cwd: opts.cwd } : {}) },
      (err, _out, stderr) => {
        if (err) reject(new Error(`ffmpeg failed: ${String(stderr).trim().split("\n").slice(-6).join("\n") || err.message}`));
        else resolve(String(stderr));
      },
    );
  });
}

/** Media duration in seconds, read from ffmpeg's own report. */
export function mediaDuration(path: string): Promise<number> {
  const f = requireFfmpeg();
  return new Promise((resolve, reject) => {
    execFile(f.path, ["-hide_banner", "-i", path], { timeout: 30_000 }, (_err, _out, stderr) => {
      const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr));
      if (!m) reject(new Error(`Could not read the duration of ${path}`));
      else resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
  });
}

/** Whether the file has an audio stream. */
export function hasAudio(path: string): Promise<boolean> {
  const f = requireFfmpeg();
  return new Promise((resolve) => {
    execFile(f.path, ["-hide_banner", "-i", path], { timeout: 30_000 }, (_err, _out, stderr) =>
      resolve(/Stream #.*Audio:/.test(String(stderr))),
    );
  });
}
