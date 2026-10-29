/**
 * Assembly: approved final shots → one episode MP4 with burned-in subtitles,
 * plus every shot file and an edit list (CMX 3600 EDL and JSON) for finishing
 * in another editor.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEpisode } from "./edit";
import { hasAudio, mediaDuration, requireFfmpeg, runFfmpeg } from "./ffmpeg";
import type { MediaRef, Project, Shot, Take } from "./project";
import type { MediaStore, ProjectStore } from "./stores";

export interface AssembleOptions {
  /** "final": approved shots with a final take (the real episode). "rough": every shot's selected take, drafts included. */
  source: "final" | "rough";
  /** Where to write the export. */
  outDir: string;
  burnSubtitles?: boolean;
}

export interface AssembledShot {
  index: number;
  shotId: string;
  takeId: string;
  tier: "draft" | "final";
  file: string;
  startS: number;
  durationS: number;
}

export interface AssembleResult {
  dir: string;
  episodeFile: string;
  shots: AssembledShot[];
  /** Shots left out, and why. */
  skipped: { shotId: string; reason: string }[];
  subtitlesBurned: boolean;
  warnings: string[];
  durationS: number;
}

const FPS = 30;

/** The take a shot contributes, or why it can't. */
export function pickTake(shot: Shot, source: "final" | "rough"): Take | string {
  const done = shot.takes.filter((t) => t.status === "done" && t.videoMediaId);
  if (source === "final") {
    if (!shot.approved) return "not approved";
    const finals = done.filter((t) => t.tier === "final");
    const sel = finals.find((t) => t.id === shot.selectedTakeId);
    return sel ?? finals[finals.length - 1] ?? "no finished final take";
  }
  return done.find((t) => t.id === shot.selectedTakeId) ?? done[done.length - 1] ?? "no finished take";
}

export async function assembleEpisode(
  deps: { projects: ProjectStore; media: MediaStore },
  projectId: string,
  episodeId: string,
  opts: AssembleOptions,
): Promise<AssembleResult> {
  const ff = requireFfmpeg();
  const project = await deps.projects.get(projectId);
  const episode = findEpisode(project, episodeId);
  const vertical = project.aspect === "9:16";
  const [w, h] = opts.source === "final" ? (vertical ? [1080, 1920] : [1920, 1080]) : vertical ? [720, 1280] : [1280, 720];
  const work = mkdtempSync(join(tmpdir(), "reel-assemble-"));
  const warnings: string[] = [];
  const skipped: AssembleResult["skipped"] = [];
  const shotsDir = join(opts.outDir, "shots");
  mkdirSync(shotsDir, { recursive: true });

  try {
    const pathOf = async (ref: MediaRef): Promise<string> => {
      if (deps.media.localPath) return deps.media.localPath(projectId, ref);
      const p = join(work, ref.path.replace(/\//g, "_"));
      writeFileSync(p, await deps.media.read(projectId, ref));
      return p;
    };
    const mediaById = new Map(project.media.map((m) => [m.id, m]));

    const out: AssembledShot[] = [];
    const subs: { start: number; end: number; text: string }[] = [];
    let t = 0;
    const all = episode.scenes.flatMap((s) => s.shots);
    for (const shot of all) {
      const pick = pickTake(shot, opts.source);
      if (typeof pick === "string") {
        skipped.push({ shotId: shot.id, reason: pick });
        continue;
      }
      const clipRef = mediaById.get(pick.videoMediaId!);
      if (!clipRef || clipRef.hidden) {
        skipped.push({ shotId: shot.id, reason: clipRef?.hidden ? "hidden by moderation" : "clip file missing" });
        continue;
      }
      const clip = await pathOf(clipRef);
      const clipLen = await mediaDuration(clip);
      // Whole frames, so the shot files, the joined episode, the subtitles and the EDL agree.
      const dur = Math.floor(Math.min(shot.durationS, clipLen) * FPS) / FPS;
      const index = out.length + 1;
      const file = join(shotsDir, `${String(index).padStart(2, "0")}_${shot.id}.mp4`);

      // Audio: the clip's own sound, plus text-to-speech lines when the clip doesn't speak them
      // (TTS mode, or a model without native audio). Never both: that would double the voice.
      const clipAudio = shot.audio !== "none" && (await hasAudio(clip));
      const useTts = shot.audio === "tts" || (shot.audio === "native" && !clipAudio);
      const timed: { at: number; len: number; text: string; path?: string }[] = [];
      let cursor = 0.3;
      for (const line of shot.dialogue) {
        if (!line.text.trim()) continue;
        const ref = useTts && line.ttsMediaId ? mediaById.get(line.ttsMediaId) : undefined;
        if (ref) {
          const p = await pathOf(ref);
          const len = await mediaDuration(p);
          timed.push({ path: p, at: cursor, len, text: line.text });
          cursor += len + 0.25;
        } else {
          timed.push({ at: Number.NaN, len: Number.NaN, text: line.text });
        }
      }
      const tts = timed.filter((x): x is { at: number; len: number; text: string; path: string } => !!x.path);
      const args = ["-i", clip];
      for (const x of tts) args.push("-i", x.path);
      if (!clipAudio) args.push("-f", "lavfi", "-t", String(dur), "-i", "anullsrc=r=48000:cl=stereo");
      const base = clipAudio ? "0:a" : `${tts.length + 1}:a`;
      const vf = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v]`;
      const af = [
        `[${base}]aresample=48000,aformat=channel_layouts=stereo[a0]`,
        ...tts.map(
          (x, i) =>
            `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(x.at * 1000)}|${Math.round(x.at * 1000)}[t${i}]`,
        ),
        `[a0]${tts.map((_, i) => `[t${i}]`).join("")}amix=inputs=${tts.length + 1}:duration=first:normalize=0[a]`,
      ];
      args.push("-filter_complex", [vf, ...af].join(";"), "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3));
      args.push(
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        file,
      );
      await runFfmpeg(args);

      // Subtitles: TTS lines at their own timings; the rest share the time left after the voiced lines.
      const untimed = timed.filter((x) => !x.path);
      for (const x of tts) subs.push({ start: t + x.at, end: Math.min(t + dur, t + x.at + x.len), text: x.text });
      if (untimed.length) {
        const from = tts.length ? Math.min(dur, cursor) : 0;
        const slot = Math.max(0.5, (dur - from) / untimed.length);
        untimed.forEach((x, i) => {
          subs.push({ start: t + from + i * slot + 0.1, end: Math.min(t + dur, t + from + (i + 1) * slot - 0.1), text: x.text });
        });
      }
      out.push({ index, shotId: shot.id, takeId: pick.id, tier: pick.tier, file, startS: t, durationS: dur });
      t += dur;
    }
    if (out.length === 0)
      throw new Error(opts.source === "final" ? "No approved shots with a finished final take yet" : "No finished takes yet");

    // Join (all clips share codec settings, so stream copy is exact).
    const list = join(work, "list.txt");
    writeFileSync(list, out.map((s) => `file '${s.file.replace(/'/g, "'\\''")}'`).join("\n"));
    const joined = join(work, "joined.mp4");
    await runFfmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", joined]);

    const srt = toSrt(subs);
    writeFileSync(join(opts.outDir, "subtitles.srt"), srt);
    const episodeFile = join(opts.outDir, "episode.mp4");
    let burned = false;
    if ((opts.burnSubtitles ?? true) && subs.length) {
      if (ff.subtitles) {
        copyFileSync(join(opts.outDir, "subtitles.srt"), join(work, "subs.srt"));
        // libass sizes SRT styles against a 288-line script, whatever the video size.
        const style = `FontName=Arial,FontSize=${vertical ? 11 : 16},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1,Shadow=0,Alignment=2,MarginV=${vertical ? 40 : 18},MarginL=12,MarginR=12`;
        await runFfmpeg(
          [
            "-i",
            joined,
            "-vf",
            `subtitles=subs.srt:force_style='${style}'`,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
            episodeFile,
          ],
          { cwd: work },
        );
        burned = true;
      } else {
        warnings.push("This ffmpeg can't burn in subtitles (it lacks libass); subtitles.srt is written next to the episode instead.");
        copyFileSync(joined, episodeFile);
      }
    } else {
      copyFileSync(joined, episodeFile);
    }

    writeFileSync(join(opts.outDir, "edit-list.edl"), toEdl(episode.title, out));
    writeFileSync(
      join(opts.outDir, "edit-list.json"),
      JSON.stringify(
        {
          project: project.name,
          episode: episode.title,
          aspect: project.aspect,
          fps: FPS,
          resolution: `${w}x${h}`,
          source: opts.source,
          shots: out.map((s) => ({ ...s, file: `shots/${s.file.split("/").pop()}` })),
          subtitles: "subtitles.srt",
          skipped,
        },
        null,
        2,
      ),
    );
    return { dir: opts.outDir, episodeFile, shots: out, skipped, subtitlesBurned: burned, warnings, durationS: t };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function srtTime(s: number): string {
  const ms = Math.max(0, Math.round(s * 1000));
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

export function toSrt(subs: { start: number; end: number; text: string }[]): string {
  return subs
    .filter((s) => s.end > s.start)
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text.replace(/\n+/g, " ")}\n`)
    .join("\n");
}

export function timecode(s: number, hourOffset = 0): string {
  const frames = Math.round(s * FPS);
  const f = frames % FPS;
  const total = Math.floor(frames / FPS);
  return `${pad(Math.floor(total / 3600) + hourOffset)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(f)}`;
}

/** A CMX 3600 edit list: one event per shot, each clip used from its start. */
export function toEdl(title: string, shots: AssembledShot[]): string {
  const lines = [`TITLE: ${title.replace(/[^\x20-\x7e]/g, "").slice(0, 60) || "Episode"}`, "FCM: NON-DROP FRAME", ""];
  for (const s of shots) {
    const reel = `SHOT${pad(s.index, 3)}`.slice(0, 8);
    lines.push(
      `${pad(s.index, 3)}  ${reel.padEnd(8)} V     C        ${timecode(0)} ${timecode(s.durationS)} ${timecode(s.startS, 1)} ${timecode(s.startS + s.durationS, 1)}`,
    );
    lines.push(
      `${pad(s.index, 3)}  ${reel.padEnd(8)} A     C        ${timecode(0)} ${timecode(s.durationS)} ${timecode(s.startS, 1)} ${timecode(s.startS + s.durationS, 1)}`,
    );
    lines.push(`* FROM CLIP NAME: ${s.file.split("/").pop()}`);
    lines.push("");
  }
  return lines.join("\n");
}
