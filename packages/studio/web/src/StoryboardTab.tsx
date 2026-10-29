import { useState } from "react";
import { type DialogueLine, type Episode, type Project, type Scene, type Shot, type Take, type View, api, mediaUrl } from "./api";
import { useProject } from "./ProjectView";
import { Empty, Icon, Spinner, money, plural, useApp } from "./ui";

/** "Scene 2, shot 3" for a shot id. */
export function shotLabel(p: Project, shotId: string): string {
  for (const ep of p.episodes) {
    for (const [si, sc] of ep.scenes.entries()) {
      const i = sc.shots.findIndex((s) => s.id === shotId);
      if (i >= 0) return `Scene ${si + 1}, shot ${i + 1}`;
    }
  }
  return "Removed shot";
}

export function useEpisodeChoice(): [Episode | undefined, (id: string) => void] {
  const { view } = useProject();
  const eps = view.project.episodes;
  const [id, setId] = useState<string | null>(null);
  const ep = eps.find((e) => e.id === id) ?? eps[0];
  return [ep, setId];
}

export function EpisodePicker({ ep, onPick }: { ep: Episode | undefined; onPick(id: string): void }) {
  const { view } = useProject();
  const eps = view.project.episodes;
  if (eps.length < 2) return ep ? <h2 className="section-title inline">{ep.title}</h2> : null;
  return (
    <select className="ep-picker" value={ep?.id} onChange={(e) => onPick(e.target.value)} aria-label="Episode">
      {eps.map((e, i) => (
        <option key={e.id} value={e.id}>
          Episode {i + 1}: {e.title}
        </option>
      ))}
    </select>
  );
}

export function StoryboardTab() {
  const app = useApp();
  const { pid, view } = useProject();
  const [ep, pick] = useEpisodeChoice();
  if (!ep)
    return (
      <Empty>
        No episodes yet. <a href={`#/p/${pid}/script`}>Write or paste a script first.</a>
      </Empty>
    );
  const shots = ep.scenes.flatMap((s) => s.shots);
  const approved = shots.filter((s) => s.approved).length;
  const seconds = shots.reduce((a, s) => a + s.durationS, 0);
  return (
    <div className="storyboard">
      <datalist id="camera-presets">
        {app.config.cameraPresets.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <div className="row">
        <EpisodePicker ep={ep} onPick={pick} />
        <span className="muted">
          {plural(ep.scenes.length, "scene")}, {plural(shots.length, "shot")}, {Math.round(seconds)} s, {approved} approved,{" "}
          {money(view.episodeTotals[ep.id]?.paidMicro ?? 0)} spent
        </span>
      </div>
      {ep.scenes.length === 0 && (
        <Empty>
          This episode has no scenes. <a href={`#/p/${pid}/script`}>Add a script and re-read it into scenes.</a>
        </Empty>
      )}
      {ep.scenes.map((sc, i) => (
        <SceneBlock key={sc.id} ep={ep} scene={sc} n={i + 1} />
      ))}
    </div>
  );
}

function SceneBlock({ ep, scene, n }: { ep: Episode; scene: Scene; n: number }) {
  const { pid, view, estimates, act, isBusy } = useProject();
  const locations = view.project.cast.filter((c) => c.kind === "location");
  const boarding = isBusy(`board-${scene.id}`);
  const price = estimates?.storyboard[scene.id];
  const running = scene.shots.some((s) => s.takes.some((t) => t.status === "queued" || t.status === "running"));

  const board = () => {
    if (
      scene.shots.length > 0 &&
      !window.confirm(`Storyboarding again replaces this scene's ${scene.shots.length} shots and their takes. Continue?`)
    )
      return;
    void act(`board-${scene.id}`, () => api.post<View>(`/projects/${pid}/scenes/${scene.id}/storyboard`));
  };

  return (
    <section className="scene">
      <div className="scene-head">
        <span className="scene-n">Scene {n}</span>
        <input
          key={scene.heading}
          className="title-input"
          defaultValue={scene.heading}
          maxLength={300}
          aria-label="Scene heading"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== scene.heading)
              void act(`sc-${scene.id}`, () => api.patch<View>(`/projects/${pid}/scenes/${scene.id}`, { heading: v }));
          }}
        />
        <select
          value={scene.locationId ?? ""}
          aria-label="Location"
          onChange={(e) =>
            void act(`sc-${scene.id}`, () => api.patch<View>(`/projects/${pid}/scenes/${scene.id}`, { locationId: e.target.value || null }))
          }
        >
          <option value="">No location</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <button
          type="button"
          className="primary"
          disabled={boarding || running}
          onClick={board}
          title={running ? "Wait for running takes to finish" : undefined}
        >
          {boarding && <Spinner />} {boarding ? "Storyboarding" : "Storyboard this scene"}
          {price !== undefined && <span className="price">{money(price)}</span>}
        </button>
      </div>
      {scene.script.trim() && (
        <details className="scene-script">
          <summary>Scene script</summary>
          <pre>{scene.script}</pre>
        </details>
      )}
      {scene.shots.length === 0 ? (
        <Empty>
          {boarding
            ? "Breaking the scene into shots. This can take a minute."
            : "No shots yet. Storyboard the scene, or add a shot by hand."}
        </Empty>
      ) : (
        <div className="shot-grid">
          {scene.shots.map((s, i) => (
            <ShotCard key={s.id} ep={ep} scene={scene} shot={s} index={i} />
          ))}
        </div>
      )}
      <button
        type="button"
        className="small"
        disabled={isBusy(`add-${scene.id}`)}
        onClick={() => void act(`add-${scene.id}`, () => api.post<View>(`/projects/${pid}/scenes/${scene.id}/shots`, {}))}
      >
        <Icon name="plus" /> Add shot
      </button>
    </section>
  );
}

function pickTake(shot: Shot): Take | undefined {
  return (
    shot.takes.find((t) => t.id === shot.selectedTakeId) ??
    [...shot.takes].reverse().find((t) => t.status === "done") ??
    shot.takes[shot.takes.length - 1]
  );
}

function Preview({ pid, take, aspect }: { pid: string; take: Take | undefined; aspect: string }) {
  const cls = `preview ${aspect === "16:9" ? "wide" : "tall"}`;
  if (take?.videoMediaId)
    return (
      <div className={cls} title="Hover to play, click for sound">
        <video
          src={mediaUrl(pid, take.videoMediaId)}
          poster={take.frameMediaId ? mediaUrl(pid, take.frameMediaId) : undefined}
          muted
          loop
          playsInline
          preload="metadata"
          onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
          onMouseLeave={(e) => {
            e.currentTarget.pause();
            e.currentTarget.muted = true;
          }}
          onClick={(e) => {
            const v = e.currentTarget;
            v.muted = !v.muted;
            if (v.paused) void v.play().catch(() => {});
          }}
        />
        <span className="preview-play" aria-hidden="true">
          <Icon name="film" size={12} /> {take.tier === "final" ? "Final" : "Draft"}
        </span>
      </div>
    );
  if (take?.frameMediaId)
    return (
      <div className={cls}>
        <img src={mediaUrl(pid, take.frameMediaId)} alt="First frame" />
        {(take.status === "running" || take.status === "queued") && (
          <span className="preview-status">
            <Spinner /> Video
          </span>
        )}
      </div>
    );
  return (
    <div className={`${cls} blank`}>
      {take && (take.status === "running" || take.status === "queued") ? (
        <>
          <Spinner />
          <span>Frame</span>
        </>
      ) : take?.status === "failed" ? (
        <span className="danger-text">Failed</span>
      ) : (
        <span className="muted">No take</span>
      )}
    </div>
  );
}

function ShotCard({ ep, scene, shot, index }: { ep: Episode; scene: Scene; shot: Shot; index: number }) {
  const app = useApp();
  const { pid, view, estimates, act, isBusy } = useProject();
  const p = view.project;
  const path = `/projects/${pid}/shots/${shot.id}`;
  const patch = (body: Record<string, unknown>) => act(`patch-${shot.id}`, () => api.patch<View>(path, body));
  const generating =
    shot.takes.some((t) => t.status === "queued" || t.status === "running") || view.openJobs.some((j) => j.refs.shotId === shot.id);
  const est = estimates?.shots[shot.id];
  const take = pickTake(shot);
  const lines = view.costLog.filter((l) => l.shotId === shot.id);
  const shotSpent = lines.reduce((a, l) => a + l.paidMicro, 0);
  const sceneIdx = ep.scenes.findIndex((s) => s.id === scene.id);
  const prevScene = ep.scenes[sceneIdx - 1];
  const nextScene = ep.scenes[sceneIdx + 1];
  const last = index === scene.shots.length - 1;
  // Shown at once while the change is saved.
  const [approving, setApproving] = useState<boolean | null>(null);
  const approved = approving ?? shot.approved;
  const setApproved = (v: boolean) => {
    setApproving(v);
    void patch({ approved: v }).finally(() => setApproving(null));
  };

  const move = (dir: -1 | 1) => {
    let body: { sceneId: string; index: number } | null = null;
    if (dir === -1)
      body =
        index > 0 ? { sceneId: scene.id, index: index - 1 } : prevScene ? { sceneId: prevScene.id, index: prevScene.shots.length } : null;
    else body = !last ? { sceneId: scene.id, index: index + 1 } : nextScene ? { sceneId: nextScene.id, index: 0 } : null;
    if (body) void act(`move-${shot.id}`, () => api.post<View>(`${path}/move`, body));
  };

  const gen = (tier: "draft" | "final") =>
    void act(`take-${shot.id}-${tier}`, () => api.post<View>(`${path}/takes`, { tier }), { kick: true });

  return (
    <article className={`card shot-card${approved ? " approved" : ""}`}>
      <div className="shot-top">
        <strong>
          {sceneIdx + 1}.{index + 1}
        </strong>
        {approved && (
          <span className="badge ok">
            <Icon name="check" size={11} /> Approved
          </span>
        )}
        <div className="spacer" />
        <div className="tools">
          <button
            type="button"
            className="icon-btn"
            title="Move up"
            aria-label="Move up"
            disabled={index === 0 && !prevScene}
            onClick={() => move(-1)}
          >
            <Icon name="up" />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Move down"
            aria-label="Move down"
            disabled={last && !nextScene}
            onClick={() => move(1)}
          >
            <Icon name="down" />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Split in two"
            aria-label="Split"
            disabled={generating}
            onClick={() => void act(`split-${shot.id}`, () => api.post<View>(`${path}/split`, {}))}
          >
            <Icon name="split" />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Merge with next"
            aria-label="Merge with next"
            disabled={last || generating}
            onClick={() => void act(`merge-${shot.id}`, () => api.post<View>(`${path}/merge`))}
          >
            <Icon name="merge" />
          </button>
          <button
            type="button"
            className="icon-btn danger-text"
            title="Delete"
            aria-label="Delete shot"
            onClick={() => {
              if (window.confirm(`Delete shot ${sceneIdx + 1}.${index + 1} and its ${shot.takes.length} takes?`))
                void act(`del-${shot.id}`, () => api.del<View>(path));
            }}
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>

      <div className="shot-body">
        <Preview pid={pid} take={take} aspect={p.aspect} />
        <div className="shot-fields">
          <textarea
            key={shot.description}
            defaultValue={shot.description}
            rows={3}
            maxLength={4000}
            aria-label="Description"
            placeholder="What we see"
            onBlur={(e) => {
              if (e.target.value !== shot.description) void patch({ description: e.target.value });
            }}
          />
          <input
            key={shot.camera}
            list="camera-presets"
            defaultValue={shot.camera}
            maxLength={500}
            aria-label="Camera"
            placeholder="Camera"
            onBlur={(e) => {
              if (e.target.value !== shot.camera) void patch({ camera: e.target.value });
            }}
          />
          <div className="chips">
            {p.cast.map((c) => {
              const on = shot.castIds.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`chip${on ? " on" : ""}`}
                  aria-pressed={on}
                  title={c.kind}
                  onClick={() => void patch({ castIds: on ? shot.castIds.filter((x) => x !== c.id) : [...shot.castIds, c.id] })}
                >
                  {c.name}
                </button>
              );
            })}
          </div>
          <div className="row tight">
            <label className="inline-label">
              Seconds
              <input
                key={shot.durationS}
                type="number"
                className="w-num"
                min={1}
                max={30}
                step={0.5}
                defaultValue={shot.durationS}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (v > 0 && v <= 30 && v !== shot.durationS) void patch({ durationS: v });
                  else e.target.value = String(shot.durationS);
                }}
              />
            </label>
            <select value={shot.audio} aria-label="Audio" onChange={(e) => void patch({ audio: e.target.value })}>
              <option value="native">Native audio</option>
              <option value="tts">Text to speech</option>
              <option value="none">No audio</option>
            </select>
            <label className="check">
              <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} /> Approve
            </label>
          </div>
        </div>
      </div>

      <Dialogue shot={shot} onSave={(dialogue) => void patch({ dialogue })} />

      <div className="row tight">
        <button type="button" disabled={generating || isBusy(`take-${shot.id}-draft`)} onClick={() => gen("draft")}>
          Draft {est && <span className="price">{money(est.draft)}</span>}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!approved || approving !== null || generating || isBusy(`take-${shot.id}-final`)}
          title={approved ? undefined : "Approve this shot to render it on the final model"}
          onClick={() => gen("final")}
        >
          Final {est && <span className="price">{money(est.final)}</span>}
        </button>
        {generating ? (
          <span className="muted small-text">
            <Spinner /> Generating
          </span>
        ) : (
          !approved && <span className="muted small-text">Approve to enable Final</span>
        )}
      </div>

      {shot.takes.length > 0 && (
        <div className="takes">
          {shot.takes.map((t, i) => (
            <button
              key={t.id}
              type="button"
              className={`take${t.id === take?.id ? " selected" : ""} ${t.status}`}
              title={t.error ?? `${t.tier} take, ${t.status}. ${t.imageModel} then ${t.videoModel}`}
              onClick={() => {
                if (t.id !== shot.selectedTakeId) void patch({ selectedTakeId: t.id });
              }}
            >
              {t.frameMediaId ? <img src={mediaUrl(pid, t.frameMediaId)} alt="" /> : <span className="take-blank" />}
              <span className="take-meta">
                <span className={`tier ${t.tier}`}>{t.tier === "final" ? "Final" : "Draft"}</span> {i + 1}
                <span className={`status ${t.status}`}>{t.status === "done" ? (t.videoMediaId ? "" : "frame") : t.status}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {shot.takes
        .filter((t) => t.status === "failed" && t.error)
        .slice(-1)
        .map((t) => (
          <div key={t.id} className="take-error small-text">
            Last failure: {t.error}
          </div>
        ))}

      {lines.length > 0 && (
        <details className="shot-costs">
          <summary>
            Costs: {lines.length} {lines.length === 1 ? "line" : "lines"}, {money(shotSpent)}
          </summary>
          <table className="table mini">
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className={l.status === "refunded" ? "refunded" : ""}>
                  <td className="nowrap">
                    {l.tier ? `${l.tier} ` : ""}
                    {l.kind}
                  </td>
                  <td className="mono">{l.model}</td>
                  <td className="num">
                    {round(l.units)} {l.unit}
                  </td>
                  <td className="num">{money(l.paidMicro)}</td>
                  <td>
                    <StatusBadge status={l.status} />
                  </td>
                  <td className="muted">{l.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted small-text">{app.config.priceLabel}</div>
        </details>
      )}
    </article>
  );
}

export const round = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(n < 10 ? 2 : 1));

export function StatusBadge({ status }: { status: string }) {
  const label: Record<string, string> = { pending: "Pending", charged: "Charged", refunded: "Refunded", failed_billed: "Failed, billed" };
  const cls = status === "refunded" ? "ok" : status === "failed_billed" ? "danger" : status === "pending" ? "warn" : "plain";
  return <span className={`badge ${cls}`}>{label[status] ?? status}</span>;
}

type LineEdit = { id?: string; castId: string | null; text: string };

function Dialogue({ shot, onSave }: { shot: Shot; onSave(lines: LineEdit[]): void }) {
  const { view, pid } = useProject();
  const speakers = view.project.cast.filter((c) => c.kind === "character");
  const toEdit = (d: DialogueLine[]): LineEdit[] => d.map((l) => ({ id: l.id, castId: l.castId, text: l.text }));
  const serverKey = JSON.stringify(toEdit(shot.dialogue));
  const [base, setBase] = useState(serverKey);
  const [lines, setLines] = useState<LineEdit[]>(() => toEdit(shot.dialogue));
  if (serverKey !== base) {
    setBase(serverKey);
    setLines(toEdit(shot.dialogue));
  }
  const commit = (next: LineEdit[]) => {
    setLines(next);
    if (JSON.stringify(next) !== serverKey) onSave(next);
  };
  const set = (i: number, patch: Partial<LineEdit>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div className="dialogue">
      {lines.map((l, i) => {
        const tts = shot.dialogue.find((d) => d.id === l.id)?.ttsMediaId;
        return (
          <div key={l.id ?? `new-${i}`} className="line">
            <select
              value={l.castId ?? ""}
              aria-label="Speaker"
              onChange={(e) => commit(lines.map((x, j) => (j === i ? { ...x, castId: e.target.value || null } : x)))}
            >
              <option value="">Narrator</option>
              {speakers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              value={l.text}
              maxLength={1000}
              aria-label="Line"
              placeholder="Line"
              onChange={(e) => set(i, { text: e.target.value })}
              onBlur={() => commit(lines)}
            />
            {tts && (
              <a className="icon-btn" href={mediaUrl(pid, tts)} target="_blank" rel="noreferrer" title="Play voice">
                <Icon name="right" />
              </a>
            )}
            <button type="button" className="icon-btn" aria-label="Remove line" onClick={() => commit(lines.filter((_, j) => j !== i))}>
              <Icon name="x" />
            </button>
          </div>
        );
      })}
      <button type="button" className="link small-text" onClick={() => setLines([...lines, { castId: speakers[0]?.id ?? null, text: "" }])}>
        <Icon name="plus" size={11} /> Line
      </button>
    </div>
  );
}
