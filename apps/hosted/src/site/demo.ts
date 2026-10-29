/**
 * The public demo project, read from apps/hosted/demo/ (built by
 * scripts/build-demo.ts). Media is served by name only, and only files the
 * project lists.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Project, parseProject } from "@reel/core";

export interface DemoMeta {
  placeholder: boolean;
  builtAt?: string;
  episodeId?: string;
  episodeDurationS?: number;
}

export interface Demo {
  dir: string;
  project: Project;
  meta: DemoMeta;
  /** Files in exports/ that exist. */
  exports: string[];
}

export const EXPORT_FILES = ["episode.mp4", "subtitles.srt", "edit-list.edl", "edit-list.json"] as const;

/** src/site/ in development, dist/ when bundled, or REEL_DEMO_DIR. */
function demoDir(): string | null {
  const candidates = [
    process.env.REEL_DEMO_DIR,
    fileURLToPath(new URL("../../demo", import.meta.url)),
    fileURLToPath(new URL("../demo", import.meta.url)),
  ];
  for (const c of candidates) if (c && existsSync(join(c, "project.json"))) return resolve(c);
  return null;
}

let cached: { demo: Demo; mtime: number } | null = null;

export function loadDemo(): Demo | null {
  const dir = demoDir();
  if (!dir) return null;
  const file = join(dir, "project.json");
  const mtime = statSync(file).mtimeMs;
  if (cached && cached.demo.dir === dir && cached.mtime === mtime) return cached.demo;
  const project = parseProject(JSON.parse(readFileSync(file, "utf8")));
  const metaFile = join(dir, "demo.json");
  const meta: DemoMeta = existsSync(metaFile)
    ? { placeholder: true, ...(JSON.parse(readFileSync(metaFile, "utf8")) as Partial<DemoMeta>) }
    : { placeholder: true };
  const exports = EXPORT_FILES.filter((f) => existsSync(join(dir, "exports", f)));
  const demo = { dir, project, meta, exports };
  cached = { demo, mtime };
  return demo;
}

const NAME = /^[A-Za-z0-9_-]{1,80}\.(png|jpg|webp|mp4|wav|mp3)$/;

/** The path of a demo media file the project lists and hasn't hidden, or null. */
export function demoMediaPath(demo: Demo, name: string): { path: string; contentType: string } | null {
  if (!NAME.test(name)) return null;
  const ref = demo.project.media.find((m) => m.path === `media/${name}`);
  if (!ref || ref.hidden) return null;
  const base = join(demo.dir, "media");
  const full = resolve(base, name);
  if (!full.startsWith(base + sep) || !existsSync(full)) return null;
  return { path: full, contentType: ref.contentType };
}

const EXPORT_TYPES: Record<string, string> = {
  "episode.mp4": "video/mp4",
  "subtitles.srt": "application/x-subrip; charset=utf-8",
  "edit-list.edl": "text/plain; charset=utf-8",
  "edit-list.json": "application/json; charset=utf-8",
};

export function demoExportPath(demo: Demo, name: string): { path: string; contentType: string } | null {
  if (!(demo.exports as string[]).includes(name)) return null;
  return { path: join(demo.dir, "exports", name), contentType: EXPORT_TYPES[name]! };
}

/** A file response with byte-range support (Safari won't play video without it). */
export function sendFile(file: { path: string; contentType: string }, range: string | undefined, download = false): Response {
  const size = statSync(file.path).size;
  const headers: Record<string, string> = {
    "content-type": file.contentType,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
  };
  if (download) headers["content-disposition"] = `attachment; filename="${file.path.split(sep).pop()}"`;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    let start: number;
    let end: number;
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    }
    if (start > end || start >= size)
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    const bytes = readFileSync(file.path).subarray(start, end + 1);
    return new Response(bytes, {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(bytes.byteLength) },
    });
  }
  return new Response(readFileSync(file.path), { headers: { ...headers, "content-length": String(size) } });
}
