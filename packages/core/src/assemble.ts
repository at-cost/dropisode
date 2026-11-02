/**
 * Assembly: approved final shots → one episode MP4 with burned-in subtitles,
 * plus every shot file and an edit list (CMX 3600 EDL and JSON) for finishing
 * in another editor.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  /** Shots whose on-screen text was drawn over the video. */
  overlaysBurned: number;
  /** Reaction cutaways laid over the speaking shot before them. */
  cutaways: number;
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
    const overlays: { start: number; end: number; text: string }[] = [];
    let t = 0;
    let cutaways = 0;
    const all = episode.scenes.flatMap((s) => s.shots);
    const firstInScene = new Set(episode.scenes.map((s) => s.shots[0]?.id));
    // The speaking shot a cutaway lays its picture over: the last shot in this scene that wasn't one.
    let speaking: AssembledShot | undefined;
    for (const shot of all) {
      if (firstInScene.has(shot.id)) speaking = undefined;
      const pick = pickTake(shot, opts.source);
      if (typeof pick === "string") {
        skipped.push({ shotId: shot.id, reason: pick });
        if (!shot.cutaway) speaking = undefined;
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

      if (shot.cutaway && speaking && (await spliceCutaway(speaking, file, dur, shot.cutaway, work))) {
        renameSync(file, join(shotsDir, `${String(speaking.index).padStart(2, "0")}c${++cutaways}_${shot.id}_cutaway.mp4`));
        continue;
      }

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
      if (shot.onScreenText?.trim()) overlays.push({ start: t + 0.2, end: t + dur - 0.1, text: shot.onScreenText.trim() });
      const entry = { index, shotId: shot.id, takeId: pick.id, tier: pick.tier, file, startS: t, durationS: dur };
      out.push(entry);
      if (!shot.cutaway) speaking = entry;
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
    let overlaysBurned = 0;
    const burnSubs = (opts.burnSubtitles ?? true) && subs.length > 0;
    if (burnSubs || overlays.length) {
      if (ff.subtitles) {
        if (!fontsAvailable())
          warnings.push(
            "No fonts are installed on this server, so subtitles and on-screen text may not show. Install fonts (e.g. font-dejavu) for ffmpeg.",
          );
        const filters: string[] = [];
        if (overlays.length) {
          writeFileSync(join(work, "overlay.ass"), toAss(overlays, w, h));
          filters.push("ass=overlay.ass");
        }
        if (burnSubs) {
          copyFileSync(join(opts.outDir, "subtitles.srt"), join(work, "subs.srt"));
          // libass sizes SRT styles against a 288-line script, whatever the video size.
          const style = `FontName=Arial,FontSize=${vertical ? 11 : 16},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1,Shadow=0,Alignment=2,MarginV=${vertical ? 40 : 18},MarginL=12,MarginR=12`;
          filters.push(`subtitles=subs.srt:force_style='${style}'`);
        }
        await runFfmpeg(
          [
            "-i",
            joined,
            "-vf",
            filters.join(","),
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
        burned = burnSubs;
        overlaysBurned = overlays.length;
      } else {
        warnings.push(
          "This ffmpeg can't draw text (it lacks libass): subtitles.srt is written next to the episode, and on-screen text is left out.",
        );
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
    return {
      dir: opts.outDir,
      episodeFile,
      shots: out,
      skipped,
      subtitlesBurned: burned,
      overlaysBurned,
      cutaways,
      warnings,
      durationS: t,
    };
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

/** On-screen text as an ASS script: centred in a dark box, sized to the frame. */
export function toAss(items: { start: number; end: number; text: string }[], w: number, h: number): string {
  const t = (s: number) => {
    const cs = Math.max(0, Math.round(s * 100));
    const hh = Math.floor(cs / 360000);
    const mm = Math.floor((cs % 360000) / 6000);
    const ss = Math.floor((cs % 6000) / 100);
    return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
  };
  const size = Math.round(Math.min(w, h) * 0.058);
  const esc = (x: string) => x.replace(/\\/g, "\\\\").replace(/[{}]/g, "").replace(/\r?\n/g, "\\N");
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Card,DejaVu Serif,${size},&H00FFFFFF,&H00FFFFFF,&H64000000,&H64000000,0,0,0,0,100,100,0,0,3,${Math.round(size * 0.45)},0,5,${Math.round(w * 0.1)},${Math.round(w * 0.1)},0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...items.map((i) => `Dialogue: 0,${t(i.start)},${t(i.end)},Card,,0,0,0,,{\\fad(250,250)}${esc(i.text)}`),
    "",
  ].join("\n");
}

/** libass draws nothing, silently, when no fonts are installed (a bare Alpine image, say). */
function fontsAvailable(): boolean {
  if (process.platform !== "linux") return true;
  for (const dir of ["/usr/share/fonts", "/usr/local/share/fonts"]) {
    try {
      if (readdirSync(dir, { recursive: true }).some((f) => /\.(ttf|otf|ttc)$/i.test(String(f)))) return true;
    } catch {}
  }
  return false;
}

/**
 * Lays a cutaway's picture over its speaking shot: the picture cuts away `atS` seconds in for
 * `lengthS` seconds (and back, if the shot runs on), while the speaker's sound carries on
 * underneath. Rewrites the speaking shot's file in place. False if there's no room for it.
 */
async function spliceCutaway(
  base: AssembledShot,
  cutFile: string,
  cutLen: number,
  c: { atS: number; lengthS: number },
  work: string,
): Promise<boolean> {
  const fr = (x: number) => Math.round(x * FPS) / FPS;
  // Skip the cutaway's first moment: image-to-video clips start on a still frame.
  const off = cutLen >= c.lengthS + 0.6 ? 0.4 : 0;
  const at = fr(Math.min(Math.max(0.3, c.atS), base.durationS - 0.5));
  const len = fr(Math.min(c.lengthS, cutLen - off, base.durationS - at));
  if (!(len >= 0.5)) return false;
  const rest = base.durationS - (at + len) > 1 / FPS;
  const graph = [
    `[0:v]split=${rest ? 2 : 1}${rest ? "[s0][s1]" : "[s0]"}`,
    `[s0]trim=end=${at.toFixed(3)},setpts=PTS-STARTPTS[p0]`,
    `[1:v]trim=start=${off}:duration=${len.toFixed(3)},setpts=PTS-STARTPTS[p1]`,
    ...(rest ? [`[s1]trim=start=${(at + len).toFixed(3)},setpts=PTS-STARTPTS[p2]`] : []),
    `${rest ? "[p0][p1][p2]" : "[p0][p1]"}concat=n=${rest ? 3 : 2}:v=1:a=0,fps=${FPS},format=yuv420p[v]`,
  ].join(";");
  const tmp = join(work, `splice_${base.index}.mp4`);
  await runFfmpeg([
    "-y",
    "-i",
    base.file,
    "-i",
    cutFile,
    "-filter_complex",
    graph,
    "-map",
    "[v]",
    "-map",
    "0:a",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "copy",
    "-t",
    base.durationS.toFixed(3),
    "-movflags",
    "+faststart",
    tmp,
  ]);
  copyFileSync(tmp, base.file);
  return true;
}
