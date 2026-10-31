import { useCallback, useEffect, useState } from "react";
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

  const load = useCallback(async () => {
    try {
      setExports(await api.get<ExportInfo[]>(`/projects/${pid}/exports`));
    } catch (err) {
      app.fail(err);
      setExports([]);
    }
  }, [pid, app]);
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
      await api.post<ExportInfo>(`/projects/${pid}/episodes/${ep.id}/assemble`, { source });
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
                    <video
                      className={`player ${view.project.aspect === "16:9" ? "wide" : "tall"}`}
                      src={video.url}
                      controls
                      playsInline
                      preload="metadata"
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
                        <video
                          className={`player ${view.project.aspect === "16:9" ? "wide" : "tall"}`}
                          src={video.url}
                          controls
                          playsInline
                          preload="none"
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
