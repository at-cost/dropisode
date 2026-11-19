/**
 * Assembly: approved final shots → one episode MP4 with burned-in subtitles,
 * plus every shot file and an edit list (CMX 3600 EDL and JSON) for finishing
 * in another editor.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEpisode } from "./edit";
import { gainTo, hasAudio, measureLoudness, mediaDuration, requireFfmpeg, runFfmpeg } from "./ffmpeg";
import { FPS, cutawaySpan, dissolveFrames, keptFrames, pickTake } from "./cut";
import type { MediaRef } from "./project";
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
  /** The part of the take used (s on the take's own clock): from `inS` for `durationS`. */
  inS: number;
  /** Seconds this shot dissolves in over the end of the one before it. */
  dissolveS?: number;
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
  /** Music and background beds mixed under the episode. */
  soundBeds: number;
  /** The subtitle cues, for a player to show or hide. */
  subtitles: { start: number; end: number; text: string }[];
  warnings: string[];
  durationS: number;
}

// The cut's arithmetic lives in cut.ts, shared with the studio's Cut panel. A chained shot starts on the last frame the edit shows.
export { FPS, pickTake, takeInS, takeOutS } from "./cut";

const ENC = [
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
];

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
    // The running time, counted in whole frames so the panel's total, the file and the edit list agree exactly.
    let tF = 0;
    let t = 0;
    let cutaways = 0;
    let soundBeds = 0;
    const all = episode.scenes.flatMap((s) => s.shots);
    const firstInScene = new Set(episode.scenes.map((s) => s.shots[0]?.id));
    const sceneOf = new Map(episode.scenes.flatMap((sc) => sc.shots.map((sh) => [sh.id, sc] as const)));
    // A finished bed: the scene's own background, laid under it in the mix.
    const bedRef = (b: { status: string; mediaId?: string } | null | undefined) =>
      b?.status === "done" && b.mediaId ? mediaById.get(b.mediaId) : undefined;
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
      // A take's end point (set before a stall, or by hand) wins: a shot that continues from it starts there.
      const { inF, outF } = keptFrames(pick, shot, clipLen);
      const inAt = inF / FPS;
      const durF = outF - inF;
      const dur = durF / FPS;
      const index = out.length + 1;
      const file = join(shotsDir, `${String(index).padStart(2, "0")}_${shot.id}.mp4`);

      // Audio: the clip's own sound, plus text-to-speech lines when the clip doesn't speak them
      // (TTS mode, or a model without native audio). Never both: that would double the voice.
      const hasClipAudio = shot.audio !== "none" && (await hasAudio(clip));
      const useTts = shot.audio === "tts" || (shot.audio === "native" && !hasClipAudio);
      // With a background bed under the scene, each clip gives only its voices (lifted out of the clip),
      // so the room sound doesn't change at every cut. Without a bed, or without lifted voices, the clip's own sound.
      const sceneBed = bedRef(sceneOf.get(shot.id)?.ambience);
      const speaksNatively = shot.audio === "native" && hasClipAudio && shot.dialogue.some((l) => l.text.trim());
      // A shot with no lines keeps its sound effects (voices taken out) over the bed, instead of going silent.
      const liftedId = speaksNatively ? pick.voiceMediaId : shot.audio === "native" ? pick.effectsMediaId : undefined;
      const voiceRef = sceneBed && liftedId ? mediaById.get(liftedId) : undefined;
      const voicePath = voiceRef ? await pathOf(voiceRef) : undefined;
      const clipAudio = hasClipAudio && !voicePath && !(sceneBed && !speaksNatively);
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
      if (voicePath) args.push("-i", voicePath);
      else if (!clipAudio) args.push("-f", "lavfi", "-t", String(dur), "-i", "anullsrc=r=48000:cl=stereo");
      const base = clipAudio ? "0:a" : `${tts.length + 1}:a`;
      const from = inAt > 0 ? `trim=start=${inAt.toFixed(3)},setpts=PTS-STARTPTS,` : "";
      // The clip's own sound and its lifted voices run on the clip's clock, so they start where the picture does.
      const aFrom = inAt > 0 && (clipAudio || voicePath) ? `atrim=start=${inAt.toFixed(3)},asetpts=PTS-STARTPTS,` : "";
      // A slow move made in the edit: worked at twice the size so the drift is smooth, not stepped.
      const frames = Math.max(1, durF);
      const zoom = shot.move === "push-in" ? `1+0.08*on/${frames}` : shot.move === "pull-out" ? `1.08-0.08*on/${frames}` : "";
      const move = zoom
        ? `scale=${w * 2}:${h * 2},zoompan=z='${zoom}':d=1:s=${w}x${h}:fps=${FPS}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',`
        : "";
      const vf = `[0:v]${from}scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},${move}format=yuv420p[v]`;
      const af = [
        `[${base}]${aFrom}aresample=48000,aformat=channel_layouts=stereo,apad[a0]`,
        ...tts.map(
          (x, i) =>
            `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(x.at * 1000)}|${Math.round(x.at * 1000)}[t${i}]`,
        ),
        `[a0]${tts.map((_, i) => `[t${i}]`).join("")}amix=inputs=${tts.length + 1}:duration=first:normalize=0,atrim=0:${dur.toFixed(3)},afade=t=in:d=0.015,afade=t=out:st=${Math.max(0, dur - 0.03).toFixed(3)}:d=0.03[a]`,
      ];
      args.push("-filter_complex", [vf, ...af].join(";"), "-map", "[v]", "-map", "[a]", "-frames:v", String(durF), "-t", dur.toFixed(6));
      args.push(...ENC, file);
      await runFfmpeg(args);

      if (shot.cutaway && speaking && (await spliceCutaway(speaking, file, dur, shot.cutaway, work))) {
        renameSync(file, join(shotsDir, `${String(speaking.index).padStart(2, "0")}c${++cutaways}_${shot.id}_cutaway.mp4`));
        continue;
      }

      // A dissolve lays the start of this shot over the end of the last one, so the episode is that much shorter.
      const before = out[out.length - 1];
      const dissolveF = shot.joinIn === "dissolve" && before ? dissolveFrames(shot.joinS, Math.round(before.durationS * FPS), durF) : 0;
      const dissolveS = dissolveF / FPS;
      tF -= dissolveF;
      t = tF / FPS;

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
      const entry: AssembledShot = {
        index,
        shotId: shot.id,
        takeId: pick.id,
        tier: pick.tier,
        file,
        startS: t,
        durationS: dur,
        inS: inAt,
        ...(dissolveS ? { dissolveS } : {}),
      };
      out.push(entry);
      if (!shot.cutaway) speaking = entry;
      tF += durF;
      t = tF / FPS;
    }
    if (out.length === 0)
      throw new Error(opts.source === "final" ? "No approved shots with a finished final take yet" : "No finished takes yet");

    // Join (all clips share codec settings, so stream copy is exact).
    // Shots joined by a dissolve are first made into one piece; the shot files themselves stay whole.
    const pieces: string[] = [];
    // Lengths in whole frames, and the output capped by frame count: some ffmpeg builds let `-t` through one frame long.
    let cur: { file: string; f: number } | undefined;
    const frames = (s: number) => Math.round(s * FPS);
    for (const s of out) {
      if (s.dissolveS && cur) {
        const xF = frames(s.dissolveS);
        const x = xF / FPS;
        const lenF = cur.f + frames(s.durationS) - xF;
        const merged = join(work, `dissolve_${s.index}.mp4`);
        await runFfmpeg([
          "-i",
          cur.file,
          "-i",
          s.file,
          "-filter_complex",
          // Both clips on one clock first: without it the bundled ffmpeg 6.0 snaps to the second clip a few frames in.
          `[0:v]settb=AVTB,fps=${FPS}[xa];[1:v]settb=AVTB,fps=${FPS}[xb];[xa][xb]xfade=transition=fade:duration=${x.toFixed(6)}:offset=${((cur.f - xF) / FPS).toFixed(6)},format=yuv420p,trim=end_frame=${lenF},setpts=N/(${FPS}*TB)[v];[0:a][1:a]acrossfade=d=${x.toFixed(6)}:c1=tri:c2=tri,apad,atrim=0:${(lenF / FPS).toFixed(6)}[a]`,
          "-map",
          "[v]",
          "-map",
          "[a]",
          "-r",
          String(FPS),
          ...ENC,
          merged,
        ]);
        cur = { file: merged, f: lenF };
      } else {
        if (cur) pieces.push(cur.file);
        cur = { file: s.file, f: frames(s.durationS) };
      }
    }
    if (cur) pieces.push(cur.file);
    const list = join(work, "list.txt");
    writeFileSync(list, pieces.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    let joined = join(work, "joined.mp4");
    await runFfmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", joined]);

    // The sound pass: each scene's background bed under its shots, the music under everything
    // (dipping whenever someone speaks), and one even loudness for the whole episode.
    // Levels are set from each file's measured loudness: backgrounds well under the voices, music a little louder.
    const beds: { path: string; start: number; len: number; gainDb: number }[] = [];
    for (const sc of episode.scenes) {
      const ref = bedRef(sc.ambience);
      const mine = out.filter((o) => sceneOf.get(o.shotId)?.id === sc.id);
      if (!ref || !mine.length) continue;
      const start = mine[0]!.startS;
      const end = mine[mine.length - 1]!.startS + mine[mine.length - 1]!.durationS;
      const path = await pathOf(ref);
      beds.push({ path, start, len: end - start, gainDb: gainTo(BED_LUFS, await measureLoudness(path)) });
    }
    const musicRef = bedRef(episode.music);
    if (beds.length || musicRef) {
      const mixed = join(work, "mixed.mp4");
      const musicPath = musicRef ? await pathOf(musicRef) : undefined;
      const musicGainDb = musicPath
        ? gainTo(episode.soundLead === "music" ? MUSIC_LEAD_LUFS : MUSIC_UNDER_LUFS, await measureLoudness(musicPath))
        : 0;
      await runFfmpeg(mixArgs(joined, beds, musicPath, t, mixed, episode.soundLead, musicGainDb));
      joined = mixed;
      soundBeds = beds.length + (musicRef ? 1 : 0);
    }

    const srt = toSrt(subs);
    writeFileSync(join(opts.outDir, "subtitles.srt"), srt);
    const episodeFile = join(opts.outDir, "episode.mp4");
    let burned = false;
    let overlaysBurned = 0;
    // Off unless asked: players show the cues themselves, with an on/off switch.
    const burnSubs = (opts.burnSubtitles ?? false) && subs.length > 0;
    const vfilters: string[] = [];
    if (burnSubs || overlays.length) {
      if (ff.subtitles) {
        if (!fontsAvailable())
          warnings.push(
            "No fonts are installed on this server, so subtitles and on-screen text may not show. Install fonts (e.g. font-dejavu) for ffmpeg.",
          );
        if (overlays.length) {
          writeFileSync(join(work, "overlay.ass"), toAss(overlays, w, h));
          vfilters.push("ass=overlay.ass");
        }
        if (burnSubs) {
          copyFileSync(join(opts.outDir, "subtitles.srt"), join(work, "subs.srt"));
          // libass sizes SRT styles against a 288-line script, whatever the video size.
          const style = `FontName=Arial,FontSize=${vertical ? 11 : 16},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1,Shadow=0,Alignment=2,MarginV=${vertical ? 40 : 18},MarginL=12,MarginR=12`;
          vfilters.push(`subtitles=subs.srt:force_style='${style}'`);
        }
        burned = burnSubs;
        overlaysBurned = overlays.length;
      } else {
        warnings.push(
          "This ffmpeg can't draw text (it lacks libass): subtitles.srt is written next to the episode, and on-screen text is left out.",
        );
      }
    }
    // Fades at the two ends, picture and sound together; never more than a third of the episode each.
    const fadeIn = Math.min(episode.fadeInS, t / 3);
    const fadeOut = Math.min(episode.fadeOutS, t / 3);
    const afilters: string[] = [];
    // One loudness for every episode, whatever it holds: measured, then a plain gain and a peak limiter. Without it
    // an episode with no talking came out at its backgrounds' level, about 18 dB too quiet.
    const level = await measureLoudness(joined);
    if (level) afilters.push(`volume=${gainTo(EPISODE_LUFS, level, 24).toFixed(2)}dB`, "alimiter=limit=0.89:level=disabled");
    if (fadeIn > 0) {
      vfilters.push(`fade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
      afilters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
    }
    if (fadeOut > 0) {
      vfilters.push(`fade=t=out:st=${(t - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
      afilters.push(`afade=t=out:st=${(t - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
    }
    if (vfilters.length || afilters.length) {
      await runFfmpeg(
        [
          "-i",
          joined,
          // The joined video can start a fraction of a frame late (the concat's timestamps); re-encoding that at a
          // constant rate adds a frame. Starting it at zero keeps the episode exactly as long as the cut.
          // Lengths are set by trim filters, never -frames:v: with ffmpeg 7 that stops the whole file when the
          // picture reaches its count, dropping the last third of a second of sound queued behind it.
          // A picture with nothing to draw (no fades, no text) is copied as it is: only the sound is reworked.
          ...(vfilters.length
            ? [
                "-vf",
                ["setpts=PTS-STARTPTS", `fps=${FPS}`, `trim=end_frame=${tF}`, `setpts=N/(${FPS}*TB)`, ...vfilters].join(","),
                // Renumbering the frames drops the rate on ffmpeg 7, which then writes 25 fps and adds frames.
                "-r",
                String(FPS),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "18",
              ]
            : ["-map", "0:v", "-map", "0:a?", "-c:v", "copy"]),
          ...(afilters.length
            ? ["-af", [...afilters, "apad", `atrim=0:${(tF / FPS).toFixed(6)}`].join(","), "-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
            : ["-c:a", "copy"]),
          "-movflags",
          "+faststart",
          episodeFile,
        ],
        { cwd: work },
      );
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
      soundBeds,
      subtitles: subs,
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

/**
 * A CMX 3600 edit list over the shot files. Each shot file is already cut to the part of its take the edit uses
 * (so it is used from its start; a comment gives the take and where in it the part begins). A dissolve is the
 * standard two-line event: the outgoing shot at the point the dissolve starts, then `D` and its length in frames.
 */
export function toEdl(title: string, shots: AssembledShot[]): string {
  const lines = [`TITLE: ${title.replace(/[^\x20-\x7e]/g, "").slice(0, 60) || "Episode"}`, "FCM: NON-DROP FRAME", ""];
  const reel = (s: AssembledShot) => `SHOT${pad(s.index, 3)}`.slice(0, 8).padEnd(8);
  let n = 0;
  shots.forEach((s, i) => {
    const ev = pad(++n, 3);
    const next = shots[i + 1];
    // A shot that the next one dissolves out of is cut where that dissolve starts; the dissolve event carries the rest.
    const until = next?.dissolveS ? next.startS - s.startS : s.durationS;
    const recIn = timecode(s.startS, 1);
    const prev = shots[i - 1];
    for (const track of ["V", "A"]) {
      if (s.dissolveS && prev) {
        const at = timecode(s.startS - prev.startS);
        lines.push(`${ev}  ${reel(prev)} ${track.padEnd(5)} C        ${at} ${at} ${recIn} ${recIn}`);
        lines.push(
          `${ev}  ${reel(s)} ${track.padEnd(5)} D    ${pad(Math.round(s.dissolveS * FPS), 3)} ${timecode(0)} ${timecode(until)} ${recIn} ${timecode(s.startS + until, 1)}`,
        );
      } else {
        lines.push(
          `${ev}  ${reel(s)} ${track.padEnd(5)} C        ${timecode(0)} ${timecode(until)} ${recIn} ${timecode(s.startS + until, 1)}`,
        );
      }
    }
    if (s.dissolveS && prev) lines.push(`* FROM CLIP NAME: ${prev.file.split("/").pop()}`, `* TO CLIP NAME: ${s.file.split("/").pop()}`);
    else lines.push(`* FROM CLIP NAME: ${s.file.split("/").pop()}`);
    lines.push(`* SOURCE: ${s.takeId}${s.inS > 0 ? ` FROM ${timecode(s.inS)}` : ""}`);
    lines.push("");
  });
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
  const span = cutawaySpan(base.durationS, cutLen, c);
  if (!span) return false;
  const { atS: at, lenS: len, skipS: off } = span;
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

/** Loudness targets (LUFS): the finished episode, a scene's background, and music under voices or leading. */
export const EPISODE_LUFS = -16;
const BED_LUFS = -34;
const MUSIC_UNDER_LUFS = -28;
const MUSIC_LEAD_LUFS = -18;

/** ffmpeg arguments for the sound pass over the joined episode. */
export function mixArgs(
  joined: string,
  beds: { path: string; start: number; len: number; gainDb?: number }[],
  music: string | undefined,
  total: number,
  out: string,
  lead: "voices" | "music" = "voices",
  musicGainDb = 0,
): string[] {
  const args = ["-i", joined];
  const f: string[] = [];
  const fmt = "aresample=48000,aformat=channel_layouts=stereo";
  // Dialogue: levelled so every shot speaks at the same loudness.
  const musicLeads = lead === "music" && !!music;
  // Music leading: the clips' own sound is kept as it is, far behind, as the air of the room.
  if (musicLeads) f.push(`[0:a]${fmt},volume=-24dB,apad=whole_dur=${total.toFixed(3)}[dlgm]`);
  // Levelled shot by shot (dynaudnorm). No loudnorm here or on the final mix: on the bundled ffmpeg 6.0 it
  // swallowed the last three seconds of the episode (its last line) or never finished. Padded to the episode's
  // length so the mix always runs to the end of the picture.
  else
    f.push(
      `[0:a]${fmt},apad=pad_dur=5,dynaudnorm=f=250:g=15:p=0.9,atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,apad=whole_dur=${total.toFixed(3)}[dlg]`,
    );
  const mixIn = ["[dlgm]"];
  beds.forEach((b, i) => {
    args.push("-stream_loop", "-1", "-i", b.path);
    const ms = Math.round(b.start * 1000);
    const fade = Math.min(0.4, b.len / 4);
    f.push(
      `[${i + 1}:a]${fmt},volume=${(b.gainDb ?? 0).toFixed(2)}dB,atrim=0:${b.len.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=${fade.toFixed(2)},afade=t=out:st=${Math.max(0, b.len - fade).toFixed(3)}:d=${fade.toFixed(2)},adelay=${ms}|${ms}[bed${i}]`,
    );
    mixIn.push(`[bed${i}]`);
  });
  if (musicLeads) {
    const k = beds.length + 1;
    args.push("-stream_loop", "-1", "-i", music as string);
    f.push(
      `[${k}:a]${fmt},volume=${musicGainDb.toFixed(2)}dB,atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, total - 2).toFixed(3)}:d=2[musd]`,
    );
    mixIn.push("[musd]");
  } else if (music) {
    const k = beds.length + 1;
    args.push("-stream_loop", "-1", "-i", music);
    f.push(
      `[${k}:a]${fmt},volume=${musicGainDb.toFixed(2)}dB,atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, total - 2.5).toFixed(3)}:d=2.5[mus]`,
    );
    f.push("[dlg]asplit=2[dlgm][key]");
    // Ducking: the music dips while anyone speaks and comes back up between lines.
    f.push("[mus][key]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=450:makeup=1[musd]");
    mixIn.push("[musd]");
  } else {
    f.push("[dlg]anull[dlgm]");
  }
  f.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:duration=longest:normalize=0,apad=whole_dur=${(total + 5).toFixed(3)},alimiter=limit=0.95:level=disabled[mix]`);
  return [
    ...args,
    "-filter_complex",
    f.join(";"),
    "-map",
    "0:v",
    "-map",
    "[mix]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-t",
    total.toFixed(3),
    "-movflags",
    "+faststart",
    out,
  ];
}
