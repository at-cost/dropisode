import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ExportInfo, api } from "./api";
import { useProject } from "./ProjectView";
import { EpisodePicker, shotLabel, useEpisodeChoice } from "./StoryboardTab";
import { Empty, Icon, Spinner, When, Why, bytes, plural, useApp, useBusy } from "./ui";

export function EpisodeTab() {
  const app = useApp();
  const { pid, view, refreshExports } = useProject();
  const [ep, pick] = useEpisodeChoice();
  const [exports, setExports] = useState<ExportInfo[] | null>(null);
  const { busy, run } = useBusy();
  const [burn, setBurn] = useState(false);
  // Only the project id decides when to reload: fresh links mid-play would restart the player.
  const appRef = useRef(app);
  appRef.current = app;

  const load = useCallback(async () => {
    try {
      setExports(await api.get<ExportInfo[]>(`/projects/${pid}/exports`));
    } catch (err) {
      appRef.current.fail(err);
      setExports([]);
    }
  }, [pid]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!ep) return <Empty>No episodes yet.</Empty>;

  const shots = ep.scenes.flatMap((s) => s.shots);
  const finals = shots.filter((s) => s.approved && s.takes.some((t) => t.tier === "final" && t.status === "done" && t.videoMediaId)).length;
  const drafts = shots.filter((s) => s.takes.some((t) => t.status === "done" && t.videoMediaId)).length;
  const allFinal = shots.length > 0 && finals === shots.length;
  const ffmpegMissing = app.config.mode === "local" && app.settings && !app.settings.ffmpeg;

  const assemble = (source: "rough" | "final") =>
    run(source, async () => {
      await api.post<ExportInfo>(`/projects/${pid}/episodes/${ep.id}/assemble`, { source, burnSubtitles: burn });
      await load();
      refreshExports();
    });

  const mine = (exports ?? []).filter((x) => x.episodeId === ep.id);

  return (
    <div className="episode-tab">
      <div className="row">
        <EpisodePicker ep={ep} onPick={pick} />
      </div>
      <section className="panel">
        <h2>Assemble</h2>
        <div className="progress-line">
          <span>
            <strong>{shots.length}</strong> shots
          </span>
          <span>
            <strong>{drafts}</strong> with video
          </span>
          <span>
            <strong>{finals}</strong> final
          </span>
        </div>
        {ffmpegMissing && (
          <p className="warn-text">
            Assembling needs ffmpeg, which wasn't found. <a href="#/settings">See Settings</a>
          </p>
        )}
        <div className="row">
          <button
            type="button"
            className={allFinal ? "" : "primary"}
            disabled={!!busy || drafts === 0 || !!ffmpegMissing}
            onClick={() => void assemble("rough")}
          >
            {busy === "rough" && <Spinner />} Rough cut from drafts
          </button>
          <button
            type="button"
            className={allFinal ? "primary" : ""}
            disabled={!!busy || !allFinal || !!ffmpegMissing}
            onClick={() => void assemble("final")}
          >
            {busy === "final" && <Spinner />} Make final episode
          </button>
          {!busy && !ffmpegMissing && !allFinal && (
            <Why>
              {drafts === 0
                ? "Make a draft of a shot first"
                : `${finals} of ${plural(shots.length, "shot")} ${finals === 1 ? "is" : "are"} final. Try a rough cut meanwhile.`}
            </Why>
          )}
        </div>
        <label className="insp-check">
          <input type="checkbox" checked={burn} onChange={(e) => setBurn(e.target.checked)} />
          <span>
            Burn subtitles into the video
            <small className="muted">Off: the player shows them with its CC switch, and the video file stays clean.</small>
          </span>
        </label>
        {busy && <p className="muted small-text">Joining shots. About a minute.</p>}
        <p className="muted small-text">Assembling is free. The final episode needs a final take of every shot.</p>
      </section>

      {exports !== null && mine.length === 0 && (
        <div className={`player-empty ${view.project.aspect === "16:9" ? "wide" : "tall"}`}>
          <Icon name="film" size={26} />
          <span>Your rough cut will play here</span>
        </div>
      )}
      {exports === null ? null : mine.length === 0 ? null : <h2 className="section-title">Exports</h2>}
      {exports === null || mine.length === 0
        ? null
        : mine.map((x, i) => {
            const video = x.files.find((f) => f.name === "episode.mp4");
            return (
              <section key={x.id} className="panel export">
                <div className="export-body">
                  {video && i === 0 ? (
                    <ExportPlayer
                      key={x.id}
                      url={video.url}
                      cues={x.subtitlesBurned ? [] : (x.subtitles ?? [])}
                      aspect={view.project.aspect}
                      preload="metadata"
                      onExpired={load}
                    />
                  ) : null}
                  <div className="export-info">
                    <h3>
                      {x.source === "final" ? "Final episode" : "Rough cut"}{" "}
                      <span className="muted when">
                        <When iso={x.createdAt} />
                      </span>
                    </h3>
                    <p className="muted small-text">{x.durationS.toFixed(1)} s long</p>
                    {video && i > 0 && (
                      <details>
                        <summary>Play</summary>
                        <ExportPlayer
                          key={x.id}
                          url={video.url}
                          cues={x.subtitlesBurned ? [] : (x.subtitles ?? [])}
                          aspect={view.project.aspect}
                          preload="none"
                          onExpired={load}
                        />
                      </details>
                    )}
                    <ul className="files">
                      {[...x.files]
                        .sort((a, b) => Number(b.name === "episode.mp4") - Number(a.name === "episode.mp4"))
                        .map((f) => (
                          <li key={f.name}>
                            <a href={`${f.url}?download=1`}>
                              <Icon name="download" /> {f.name}
                            </a>{" "}
                            <span className="muted">{bytes(f.bytes)}</span>
                          </li>
                        ))}
                    </ul>
                    {x.skipped.length > 0 && (
                      <div className="note warn">
                        <strong>Skipped {plural(x.skipped.length, "shot")}</strong>
                        <ul>
                          {x.skipped.map((s) => (
                            <li key={s.shotId}>
                              {shotLabel(view.project, s.shotId)}: {s.reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {x.warnings.length > 0 && (
                      <div className="note warn">
                        <ul>
                          {x.warnings.map((w) => (
                            <li key={w}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
    </div>
  );
}

/**
 * Plays an export from a signed link. The browser fetches the video in pieces as it plays,
 * so a link that expires mid-way stops playback where the buffer ends. On that error we
 * fetch fresh links and carry on from the same second.
 */
function ExportPlayer({
  url,
  cues,
  aspect,
  preload,
  onExpired,
}: {
  url: string;
  cues: { start: number; end: number; text: string }[];
  aspect: string;
  preload: "metadata" | "none";
  onExpired(): Promise<void> | void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const resume = useRef<{ at: number; play: boolean } | null>(null);
  const lastRetry = useRef(0);
  // The link the player is using. A newer link only replaces it after this one has failed:
  // swapping the source while playing would start the video again from the top.
  const [src, setSrc] = useState(url);
  const wantFresh = useRef(false);
  useEffect(() => {
    if (wantFresh.current && url !== src) {
      wantFresh.current = false;
      setSrc(url);
    }
  }, [url, src]);
  const [cc, setCc] = useState(() => {
    try {
      return localStorage.getItem("reel.cc") !== "off";
    } catch {
      return true;
    }
  });
  // A captions track built here from the cues: it shows in full screen too, and needs no extra download.
  const vtt = useMemo(() => (cues.length ? URL.createObjectURL(new Blob([toVtt(cues)], { type: "text/vtt" })) : null), [cues]);
  useEffect(() => () => void (vtt && URL.revokeObjectURL(vtt)), [vtt]);
  useEffect(() => {
    const t = ref.current?.textTracks[0];
    if (t) t.mode = cc ? "showing" : "hidden";
  });
  const toggleCc = () => {
    const next = !cc;
    setCc(next);
    try {
      localStorage.setItem("reel.cc", next ? "on" : "off");
    } catch {}
  };
  return (
    <div className={`player-wrap ${aspect === "16:9" ? "wide" : "tall"}`}>
      <video
        ref={ref}
        className={`player ${aspect === "16:9" ? "wide" : "tall"}`}
        src={src}
        controls
        playsInline
        preload={preload}
        onError={() => {
          const v = ref.current;
          if (!v || Date.now() - lastRetry.current < 10_000) return;
          lastRetry.current = Date.now();
          resume.current = { at: v.currentTime, play: !v.paused || v.currentTime > 0 };
          wantFresh.current = true;
          void onExpired();
        }}
        onLoadedMetadata={() => {
          const v = ref.current;
          const r = resume.current;
          if (!v || !r) return;
          resume.current = null;
          v.currentTime = r.at;
          if (r.play) void v.play().catch(() => {});
        }}
      >
        {vtt && <track kind="subtitles" label="English" srcLang="en" src={vtt} default={cc} />}
      </video>
      {cues.length > 0 && (
        <button type="button" className={`cc-toggle ${cc ? "on" : ""}`} aria-pressed={cc} onClick={toggleCc} title="Subtitles on or off">
          CC
        </button>
      )}
    </div>
  );
}

/** Subtitle cues as WebVTT. */
export function toVtt(cues: { start: number; end: number; text: string }[]): string {
  const t = (x: number) => {
    const ms = Math.max(0, Math.round(x * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
  };
  return `WEBVTT\n\n${cues.map((c) => `${t(c.start)} --> ${t(c.end)}\n${c.text.replace(/-->/g, "->")}`).join("\n\n")}\n`;
}
