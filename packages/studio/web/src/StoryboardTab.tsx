import { type CSSProperties, type ReactNode, type TouchEvent, useEffect, useRef, useState } from "react";
import { type DialogueLine, type Episode, type Project, type Scene, type Shot, type Take, type View, api, mediaUrl } from "./api";
import { useProject } from "./ProjectView";
import { type Stage, hasFinalTake, shotStage, shotStatus, stageCounts } from "./progress";
import { Empty, Icon, MoreMenu, Spinner, Ticket, Why, modelLabel, money, plural, store, unitLabel, useApp, useMedia } from "./ui";

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

type ViewMode = "list" | "board";

export function StoryboardTab() {
  const app = useApp();
  const { pid, view } = useProject();
  const [ep, pick] = useEpisodeChoice();
  const [mode, setModeState] = useState<ViewMode>(() => (store.get("dropisode.storyboard") === "board" ? "board" : "list"));
  const [selected, setSelected] = useState<string | null>(null);
  const wide = useMedia("(min-width: 1280px)");
  const setMode = (m: ViewMode) => {
    setModeState(m);
    store.set("dropisode.storyboard", m);
  };
  // Escape closes the inspector; a field being edited is saved first (its blur saves it).
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".modal-layer")) return;
      const el = document.activeElement;
      if (el instanceof HTMLElement && el.closest(".inspector")) el.blur();
      setSelected(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected]);
  if (!ep)
    return (
      <Empty>
        No episodes yet. <a href={`#/p/${pid}/script`}>Write or paste a script first.</a>
      </Empty>
    );
  const shots = ep.scenes.flatMap((s) => s.shots);
  const counts = stageCounts(shots);
  const allFinal = shots.length > 0 && counts.final === shots.length;
  const seconds = shots.reduce((a, s) => a + s.durationS, 0);
  const found = selected ? findShot(ep, selected) : null;
  // The episode summary sits beside the list on wide screens; a selected shot always opens in a panel that slides over from the right.
  const docked = mode === "list" && wide;
  const sel: Selection = { id: found ? selected : null, set: setSelected };
  return (
    <div className="storyboard">
      <datalist id="camera-presets">
        {app.config.cameraPresets.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <div className="sb-toolbar">
        <EpisodePicker ep={ep} onPick={pick} />
        <span className="muted small-text">
          {plural(shots.length, "shot")} · {Math.round(seconds)} s · {counts.approved} approved · {counts.final} final ·{" "}
          {money(view.episodeTotals[ep.id]?.paidMicro ?? 0)} spent
        </span>
        <div className="spacer" />
        {allFinal && (
          <a className="btn primary next-btn" href={`#/p/${pid}/episode`}>
            Next: episode <span aria-hidden="true">→</span>
          </a>
        )}
        <fieldset className="view-toggle" aria-label="Storyboard view">
          <button type="button" aria-pressed={mode === "list"} className={mode === "list" ? "on" : ""} onClick={() => setMode("list")}>
            <Icon name="list" /> List
          </button>
          <button type="button" aria-pressed={mode === "board"} className={mode === "board" ? "on" : ""} onClick={() => setMode("board")}>
            <Icon name="board" /> Board
          </button>
        </fieldset>
      </div>
      <div className={`sb-layout${docked ? " docked" : ""}`}>
        <div className="sb-main">
          {ep.scenes.length === 0 && (
            <Empty>
              This episode has no scenes. <a href={`#/p/${pid}/script`}>Add a script and re-read it into scenes.</a>
            </Empty>
          )}
          {ep.scenes.map((sc, i) => (
            <SceneBlock key={sc.id} ep={ep} scene={sc} n={i + 1} mode={mode} sel={sel} />
          ))}
        </div>
        {docked && (
          <aside className="inspector" aria-label="Episode summary">
            <EpisodeSummary ep={ep} />
          </aside>
        )}
        {found && (
          <>
            <button
              type="button"
              className="inspector-backdrop"
              aria-label="Close inspector"
              tabIndex={-1}
              onClick={() => setSelected(null)}
            />
            <Sheet onClose={() => setSelected(null)}>
              <Inspector key={found.shot.id} ep={ep} {...found} onClose={() => setSelected(null)} />
            </Sheet>
          </>
        )}
      </div>
    </div>
  );
}

/** The floating inspector: a slide-over, or on phones a bottom sheet you can swipe down to close. */
function Sheet({ onClose, children }: { onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const start = useRef<number | null>(null);
  const [dy, setDy] = useState(0);
  const onStart = (e: TouchEvent) => {
    // Only from the top, so scrolling the sheet's content still works.
    if ((ref.current?.scrollTop ?? 0) > 0) return;
    start.current = e.touches[0]?.clientY ?? null;
  };
  const onMove = (e: TouchEvent) => {
    if (start.current === null) return;
    setDy(Math.max(0, (e.touches[0]?.clientY ?? start.current) - start.current));
  };
  const onEnd = () => {
    if (start.current !== null && dy > 90) onClose();
    start.current = null;
    setDy(0);
  };
  return (
    <aside
      ref={ref}
      className="inspector floating"
      aria-label="Shot inspector"
      style={dy ? { transform: `translateY(${dy}px)`, transition: "none" } : undefined}
      onTouchStart={onStart}
      onTouchMove={onMove}
      onTouchEnd={onEnd}
      onTouchCancel={onEnd}
    >
      <span className="sheet-handle" aria-hidden="true" />
      {children}
    </aside>
  );
}

interface Selection {
  id: string | null;
  set(id: string | null): void;
}

function findShot(ep: Episode, id: string): { scene: Scene; shot: Shot; index: number } | null {
  for (const scene of ep.scenes) {
    const index = scene.shots.findIndex((s) => s.id === id);
    if (index >= 0) return { scene, shot: scene.shots[index]!, index };
  }
  return null;
}

function EpisodeSummary({ ep }: { ep: Episode }) {
  const { view } = useProject();
  const shots = ep.scenes.flatMap((s) => s.shots);
  const counts = stageCounts(shots);
  const count = (st: Stage) => counts[st];
  return (
    <div className="inspector-body">
      <div className="insp-head">
        <h2>{ep.title}</h2>
        <span className="insp-kicker">Episode</span>
      </div>
      <dl className="insp-stats">
        <dt>To draft</dt>
        <dd>{count("todo")}</dd>
        <dt>Drafted</dt>
        <dd>{count("drafted")}</dd>
        <dt>Approved</dt>
        <dd>{count("approved")}</dd>
        <dt>Final</dt>
        <dd>{count("final")}</dd>
        <dt>Spent</dt>
        <dd>{money(view.episodeTotals[ep.id]?.paidMicro ?? 0)}</dd>
      </dl>
      <p className="muted small-text">Select a shot to edit its direction, camera, people and lines.</p>
    </div>
  );
}

function SceneBlock({ ep, scene, n, mode, sel }: { ep: Episode; scene: Scene; n: number; mode: ViewMode; sel: Selection }) {
  const app = useApp();
  const { pid, view, estimates, act, isBusy } = useProject();
  const locations = view.project.cast.filter((c) => c.kind === "location");
  const boarding = isBusy(`board-${scene.id}`);
  const price = estimates?.storyboard[scene.id];
  const running = scene.shots.some((s) => s.takes.some((t) => t.status === "queued" || t.status === "running"));
  const untried = scene.shots.filter((s) => s.takes.length === 0 && !view.openJobs.some((j) => j.refs.shotId === s.id));
  const untriedPrices = untried.map((s) => estimates?.shots[s.id]?.draft);
  const untriedTotal = untriedPrices.every((x) => x !== undefined) ? untriedPrices.reduce<number>((a, x) => a + (x ?? 0), 0) : undefined;
  const draftingAll = isBusy(`all-${scene.id}`);
  // Approved shots without a current final, for one "Render N approved" press.
  const toRender = scene.shots.filter(
    (s) =>
      shotStage(s) === "approved" &&
      !view.openJobs.some((j) => j.refs.shotId === s.id) &&
      !s.takes.some((t) => t.status === "queued" || t.status === "running"),
  );
  const renderPrices = toRender.map((s) => estimates?.shots[s.id]?.final);
  const renderTotal = renderPrices.every((x) => x !== undefined) ? renderPrices.reduce<number>((a, x) => a + (x ?? 0), 0) : undefined;
  const renderingAll = isBusy(`render-${scene.id}`);
  const renderAll = () =>
    void act(
      `render-${scene.id}`,
      async () => {
        let last: View | undefined;
        for (const s of toRender) last = await api.post<View>(`/projects/${pid}/shots/${s.id}/takes`, { tier: "final" });
        return last as View;
      },
      { kick: true },
    );
  const draftAll = () =>
    void act(
      `all-${scene.id}`,
      async () => {
        let last: View | undefined;
        for (const s of untried) last = await api.post<View>(`/projects/${pid}/shots/${s.id}/takes`, { tier: "draft" });
        return last as View;
      },
      { kick: true },
    );

  const board = async () => {
    if (
      scene.shots.length > 0 &&
      !(await app.confirm(`Storyboarding again replaces this scene's ${scene.shots.length} shots and their takes.`, {
        ok: "Storyboard again",
        danger: true,
      }))
    )
      return;
    void act(`board-${scene.id}`, () => api.post<View>(`/projects/${pid}/scenes/${scene.id}/storyboard`));
  };

  const addShot = (
    <button
      type="button"
      className="small add-shot"
      disabled={isBusy(`add-${scene.id}`)}
      onClick={() => void act(`add-${scene.id}`, () => api.post<View>(`/projects/${pid}/scenes/${scene.id}/shots`, {}))}
    >
      <Icon name="plus" /> Add shot
    </button>
  );

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

        <div className="scene-actions">
          <select
            value={scene.locationId ?? ""}
            aria-label="Location"
            onChange={(e) =>
              void act(`sc-${scene.id}`, () =>
                api.patch<View>(`/projects/${pid}/scenes/${scene.id}`, { locationId: e.target.value || null }),
              )
            }
          >
            <option value="">No location</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {toRender.length > 0 && renderTotal !== undefined && (
            <button type="button" className={untried.length > 0 ? "" : "primary"} disabled={renderingAll || boarding} onClick={renderAll}>
              {renderingAll && <Spinner />} {`Render ${toRender.length} approved`}
              <Ticket micro={renderTotal} />
            </button>
          )}
          {untried.length > 0 && untriedTotal !== undefined && (
            <button type="button" className="primary" disabled={draftingAll || boarding} onClick={draftAll}>
              {draftingAll && <Spinner />}{" "}
              {`Draft ${untried.length === scene.shots.length ? "all " : ""}${plural(untried.length, "untried shot")}`}
              <Ticket micro={untriedTotal} />
            </button>
          )}
          <button
            type="button"
            className={scene.shots.length === 0 ? "primary" : ""}
            disabled={boarding || running}
            onClick={board}
            title={running && !boarding ? "Wait for running takes to finish" : undefined}
            aria-describedby={running && !boarding ? `wait-${scene.id}` : undefined}
          >
            {boarding && <Spinner />} {boarding ? "Storyboarding" : scene.shots.length === 0 ? "Storyboard this scene" : "Storyboard again"}
            {!boarding && <Ticket micro={price} />}
          </button>
          {running && !boarding && (
            <span id={`wait-${scene.id}`} className="sr-only">
              Wait for running takes to finish
            </span>
          )}
        </div>
      </div>
      {scene.script.trim() && (
        <details className="scene-script">
          <summary>Scene script</summary>
          <pre>{scene.script}</pre>
        </details>
      )}
      {scene.shots.length === 0 ? (
        <>
          <Empty>
            {boarding
              ? "Breaking the scene into shots. This can take a minute."
              : "No shots yet. Storyboard the scene, or add a shot by hand."}
          </Empty>
          {addShot}
        </>
      ) : mode === "board" ? (
        <>
          <div className="board">
            {COLUMNS.map(([stage, label, foot]) => {
              const list = scene.shots.map((s, i) => [s, i] as const).filter(([s]) => shotStage(s) === stage);
              return (
                <div key={stage} className={`board-col ${stage}`}>
                  <div className="board-col-head">
                    <span className="col-dot" aria-hidden="true" />
                    <strong>{label}</strong>
                    <span className="col-count">{list.length}</span>
                  </div>
                  {list.map(([s, i]) => (
                    <ShotTile key={s.id} ep={ep} scene={scene} shot={s} index={i} variant="board" sel={sel} />
                  ))}
                  {list.length === 0 ? <p className="col-empty">Nothing here</p> : <p className="col-foot">{foot}</p>}
                </div>
              );
            })}
          </div>
          {addShot}
        </>
      ) : (
        <>
          <div className="tile-grid">
            {scene.shots.map((s, i) => (
              <ShotTile key={s.id} ep={ep} scene={scene} shot={s} index={i} variant="list" sel={sel} />
            ))}
          </div>
          {addShot}
        </>
      )}
    </section>
  );
}

const COLUMNS: [Stage, string, string][] = [
  ["todo", "To draft", "Ready for a first take"],
  ["drafted", "Drafted", "Review takes, then approve"],
  ["approved", "Approved", "Ready for the final render"],
  ["final", "Final", "Ready for your episode"],
];

function pickTake(shot: Shot): Take | undefined {
  return (
    shot.takes.find((t) => t.id === shot.selectedTakeId) ??
    [...shot.takes].reverse().find((t) => t.status === "done") ??
    shot.takes[shot.takes.length - 1]
  );
}

function Preview({ pid, take, aspect, clickToOpen }: { pid: string; take: Take | undefined; aspect: string; clickToOpen?: boolean }) {
  const cls = `preview ${aspect === "16:9" ? "wide" : "tall"}`;
  if (take?.videoMediaId)
    return (
      <div className={cls} title={clickToOpen ? "Hover to play, click to open" : "Hover to play, click for sound"}>
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
            if (clickToOpen) return;
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

/** Everything a shot's controls need, shared by the card, the tile and the inspector. */
function useShot(ep: Episode, scene: Scene, shot: Shot, index: number) {
  const { pid, view, estimates, act, isBusy } = useProject();
  const path = `/projects/${pid}/shots/${shot.id}`;
  const patch = (body: Record<string, unknown>) => act(`patch-${shot.id}`, () => api.patch<View>(path, body));
  const generating =
    shot.takes.some((t) => t.status === "queued" || t.status === "running") || view.openJobs.some((j) => j.refs.shotId === shot.id);
  const sceneIdx = ep.scenes.findIndex((s) => s.id === scene.id);
  const prevScene = ep.scenes[sceneIdx - 1];
  const nextScene = ep.scenes[sceneIdx + 1];
  const last = index === scene.shots.length - 1;
  const lines = view.costLog.filter((l) => l.shotId === shot.id);
  const move = (dir: -1 | 1) => {
    let body: { sceneId: string; index: number } | null = null;
    if (dir === -1)
      body =
        index > 0 ? { sceneId: scene.id, index: index - 1 } : prevScene ? { sceneId: prevScene.id, index: prevScene.shots.length } : null;
    else body = !last ? { sceneId: scene.id, index: index + 1 } : nextScene ? { sceneId: nextScene.id, index: 0 } : null;
    if (body) void act(`move-${shot.id}`, () => api.post<View>(`${path}/move`, body));
  };
  return {
    pid,
    p: view.project,
    path,
    patch,
    act,
    isBusy,
    generating,
    est: estimates?.shots[shot.id],
    take: pickTake(shot),
    lines,
    spent: lines.reduce((a, l) => a + l.paidMicro, 0),
    label: `${sceneIdx + 1}.${index + 1}`,
    canUp: index > 0 || !!prevScene,
    canDown: !last || !!nextScene,
    last,
    move,
    gen: (tier: "draft" | "final") => void act(`take-${shot.id}-${tier}`, () => api.post<View>(`${path}/takes`, { tier }), { kick: true }),
  };
}
type ShotCtl = ReturnType<typeof useShot>;

/** Approve toggle: reads "Approve shot" until pressed, then "Approved". */
function useApproval(shot: Shot, c: ShotCtl) {
  // Shown at once while the change is saved.
  const [approving, setApproving] = useState<boolean | null>(null);
  const approved = approving ?? shot.approved;
  const set = (v: boolean) => {
    setApproving(v);
    void c.patch({ approved: v }).finally(() => setApproving(null));
  };
  return { approved, approving, set };
}

function ApproveToggle({ shot, a, variant }: { shot: Shot; a: ReturnType<typeof useApproval>; variant: "pill" | "switch" }) {
  if (!(shot.takes.length > 0 || a.approved)) return null;
  return (
    <button
      type="button"
      className={`approve ${variant === "switch" ? "toggle" : "pill"}${a.approved ? " on" : ""}`}
      aria-pressed={a.approved}
      disabled={a.approving !== null}
      title={a.approved ? "Click to unapprove" : "Approve this shot for the final render"}
      onClick={(e) => {
        e.stopPropagation();
        a.set(!a.approved);
      }}
    >
      {variant === "pill" && a.approved && <Icon name="check" size={12} />}
      <span className="approve-text">{a.approved ? "Approved" : "Approve shot"}</span>
      {variant === "switch" && <span className="switch" aria-hidden="true" />}
    </button>
  );
}

function GenButtons({
  shot,
  c,
  approved,
  approving,
  compact,
}: {
  shot: Shot;
  c: ShotCtl;
  approved: boolean;
  approving: boolean;
  compact?: boolean;
}) {
  // A current final exists: rendering again is the exception, not the next step.
  const rendered = approved && hasFinalTake(shot);
  return (
    <div className={`gen-row${compact ? " compact" : ""}`}>
      <button
        type="button"
        disabled={c.generating || c.isBusy(`take-${shot.id}-draft`)}
        onClick={(e) => {
          e.stopPropagation();
          c.gen("draft");
        }}
      >
        Draft <Ticket micro={c.est?.draft} />
      </button>
      {(!compact || approved) && (
        <button
          type="button"
          className={approved && !rendered ? "primary" : ""}
          title={approved ? undefined : "Draft and approve the shot first"}
          disabled={!approved || approving || c.generating || c.isBusy(`take-${shot.id}-final`)}
          onClick={(e) => {
            e.stopPropagation();
            c.gen("final");
          }}
        >
          {rendered ? "Re-render final" : "Final"} <Ticket micro={c.est?.final} />
        </button>
      )}
    </div>
  );
}

function ShotMenu({ shot, c }: { shot: Shot; c: ShotCtl }) {
  const app = useApp();
  return (
    <MoreMenu label={`More for shot ${c.label}`}>
      <button type="button" role="menuitem" disabled={!c.canUp} onClick={() => c.move(-1)}>
        <Icon name="up" /> Move earlier
      </button>
      <button type="button" role="menuitem" disabled={!c.canDown} onClick={() => c.move(1)}>
        <Icon name="down" /> Move later
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={c.generating}
        onClick={() => void c.act(`split-${shot.id}`, () => api.post<View>(`${c.path}/split`, {}))}
      >
        <Icon name="split" /> Split in two
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={c.last || c.generating}
        onClick={() => void c.act(`merge-${shot.id}`, () => api.post<View>(`${c.path}/merge`))}
      >
        <Icon name="merge" /> Merge with next
      </button>
      <button
        type="button"
        role="menuitem"
        className="danger-item"
        onClick={async () => {
          if (await app.confirm(`Delete shot ${c.label} and its ${shot.takes.length} takes?`, { ok: "Delete shot", danger: true }))
            void c.act(`del-${shot.id}`, () => api.del<View>(c.path));
        }}
      >
        <Icon name="trash" /> Delete shot
      </button>
    </MoreMenu>
  );
}

function Takes({ shot, c, small }: { shot: Shot; c: ShotCtl; small?: boolean }) {
  const app = useApp();
  if (shot.takes.length === 0) return null;
  return (
    <div className={`takes${small ? " small" : ""}`}>
      {shot.takes.map((t, i) => (
        <button
          key={t.id}
          type="button"
          className={`take${t.id === c.take?.id ? " selected" : ""} ${t.status}`}
          aria-label={`Take ${i + 1}, ${t.tier === "final" ? "final" : "draft"}`}
          title={
            t.error ??
            `${t.tier === "final" ? "Final" : "Draft"} take ${i + 1}, ${t.status}. ${modelLabel(app.config, t.imageModel)}, then ${modelLabel(app.config, t.videoModel)}`
          }
          onClick={(e) => {
            e.stopPropagation();
            if (t.id !== shot.selectedTakeId) void c.patch({ selectedTakeId: t.id });
          }}
        >
          {t.frameMediaId ? <img src={mediaUrl(c.pid, t.frameMediaId)} alt="" /> : <span className="take-blank" />}
          {!small && (
            <span className="take-meta">
              <span className={`tier ${t.tier}`}>{t.tier === "final" ? "Final" : "Draft"}</span> {i + 1}
              <span className={`status ${t.status}`}>{t.status === "done" ? (t.videoMediaId ? "" : "frame") : t.status}</span>
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** What the shot will actually sound like: a silent video model voices lines with text to speech. */
function audioLabel(shot: Shot, silentVideo: boolean): string {
  if (shot.audio === "none") return AUDIO.none!;
  if (shot.audio === "native" && !silentVideo) return AUDIO.native!;
  return shot.dialogue.some((l) => l.text.trim()) ? "Voice-over" : "Silent";
}

const setupLine = (shot: Shot, silentVideo: boolean) =>
  `${cap(shot.camera.trim()) || "No camera set"} · ${round(shot.durationS)} s · ${audioLabel(shot, silentVideo)}`;

/** A compact shot for the wide list and the board; editing happens in the inspector. */
function ShotTile({
  ep,
  scene,
  shot,
  index,
  variant,
  sel,
}: {
  ep: Episode;
  scene: Scene;
  shot: Shot;
  index: number;
  variant: "list" | "board";
  sel: Selection;
}) {
  const { config } = useApp();
  const finalVideo = config.models?.find((m) => m.id === config.defaults?.final?.video);
  const silentVideo = finalVideo ? !finalVideo.nativeAudio : false;
  const c = useShot(ep, scene, shot, index);
  const a = useApproval(shot, c);
  const status = shotStatus({ ...shot, approved: a.approved }, c.generating);
  const isSel = sel.id === shot.id;
  const open = () => sel.set(isSel ? null : shot.id);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the card's own "Edit this shot" button is the keyboard route
    <article
      className={`tile v-${variant}${isSel ? " selected" : ""}${a.approved ? " approved" : ""}`}
      onClick={(e) => {
        // Anywhere on the card opens it, except its own buttons and fields.
        if ((e.target as HTMLElement).closest("button, a, input, select, textarea, label")) return;
        open();
      }}
    >
      <div className="tile-top">
        <strong>Shot {c.label}</strong>
        <span className={`tile-status ${status.tone}`}>
          {status.tone === "live" && <Spinner />} {status.label}
        </span>
        <ShotMenu shot={shot} c={c} />
      </div>
      <div className="tile-body">
        <div
          className="tile-frame"
          style={c.take?.frameMediaId ? ({ "--frame-bg": `url("${mediaUrl(c.pid, c.take.frameMediaId)}")` } as CSSProperties) : undefined}
        >
          <Preview pid={c.pid} take={c.take} aspect={c.p.aspect} clickToOpen />
        </div>
        <div className="tile-info">
          <button type="button" className="tile-open" aria-expanded={isSel} onClick={open} title="Edit this shot">
            <span className="tile-desc">{shot.description.trim() || "No direction yet"}</span>
            <span className="tile-meta">{setupLine(shot, silentVideo)}</span>
          </button>
          {shot.takes.length > 0 && (
            <div className="tile-takes">
              <Takes shot={shot} c={c} small />
              <span className="muted small-text">{plural(shot.takes.length, "take")}</span>
            </div>
          )}
          <ApproveToggle shot={shot} a={a} variant="switch" />
          <GenButtons shot={shot} c={c} approved={a.approved} approving={a.approving !== null} compact={variant === "board"} />
        </div>
      </div>
    </article>
  );
}

/** The selected shot's editor, beside the list (wide screens) or over the board. */
/** The inspector's player: big, with sound and controls, and a full-screen button. */
function ShotPlayer({ pid, take, aspect }: { pid: string; take: Take; aspect: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  return (
    <div className={`shot-player ${aspect === "16:9" ? "wide" : "tall"}`}>
      <video
        ref={ref}
        key={take.videoMediaId}
        src={mediaUrl(pid, take.videoMediaId!)}
        poster={take.frameMediaId ? mediaUrl(pid, take.frameMediaId) : undefined}
        controls
        playsInline
        preload="metadata"
      />
      <div className="shot-player-bar">
        <span className="muted small-text">
          <Icon name="film" size={12} /> {take.tier === "final" ? "Final" : "Draft"} take
        </span>
        <button type="button" className="small" onClick={() => void ref.current?.requestFullscreen?.().catch(() => {})}>
          Full screen
        </button>
      </div>
    </div>
  );
}

function Inspector({ ep, scene, shot, index, onClose }: { ep: Episode; scene: Scene; shot: Shot; index: number; onClose(): void }) {
  const app = useApp();
  const c = useShot(ep, scene, shot, index);
  const a = useApproval(shot, c);
  const sceneN = ep.scenes.findIndex((s) => s.id === scene.id) + 1;
  return (
    <div className="inspector-body">
      <div className="insp-head">
        <h2>Shot {c.label}</h2>
        <span className="insp-kicker">Inspector</span>
        <button type="button" className="icon-btn" aria-label="Close inspector" title="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <p className="muted small-text insp-where">
        {ep.title} · Scene {sceneN}
      </p>
      <div className="insp-preview">
        {c.take?.videoMediaId ? (
          <ShotPlayer pid={c.pid} take={c.take} aspect={c.p.aspect} />
        ) : (
          <Preview pid={c.pid} take={c.take} aspect={c.p.aspect} />
        )}
      </div>
      {a.approved && <p className="insp-note">Editing direction, camera, length, people or lines clears this shot's approval.</p>}
      <label className="insp-field">
        <span>Direction</span>
        <textarea
          key={shot.description}
          defaultValue={shot.description}
          rows={4}
          maxLength={4000}
          placeholder="What we see"
          onBlur={(e) => {
            if (e.target.value !== shot.description) void c.patch({ description: e.target.value });
          }}
        />
      </label>
      <label className="insp-field">
        <span>Camera</span>
        <input
          key={shot.camera}
          list="camera-presets"
          defaultValue={shot.camera}
          maxLength={500}
          placeholder="e.g. Medium, slow push in"
          onBlur={(e) => {
            if (e.target.value !== shot.camera) void c.patch({ camera: e.target.value });
          }}
        />
      </label>
      <div className="insp-pair">
        <label className="insp-field">
          <span>Seconds</span>
          <input
            key={shot.durationS}
            type="number"
            min={1}
            max={30}
            step={0.5}
            defaultValue={shot.durationS}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (v > 0 && v <= 30 && v !== shot.durationS) void c.patch({ durationS: v });
              else e.target.value = String(shot.durationS);
            }}
          />
        </label>
        <label className="insp-field">
          <span>Audio</span>
          <select value={shot.audio} onChange={(e) => void c.patch({ audio: e.target.value })}>
            <option value="native">Native audio</option>
            <option value="tts">Text to speech</option>
            <option value="none">No audio</option>
          </select>
        </label>
      </div>
      <div className="insp-field">
        <span>In this shot</span>
        <CastChips shot={shot} c={c} />
      </div>
      <div className="insp-field">
        <span>Dialogue</span>
        <Dialogue shot={shot} onSave={(dialogue) => void c.patch({ dialogue })} />
      </div>
      <Takes shot={shot} c={c} />
      <div className="insp-spend">
        <span>This shot so far</span>
        <strong>{money(c.spent)}</strong>
      </div>
      {c.lines.length > 0 && <ShotCosts lines={c.lines} config={app.config} />}
      <ApproveToggle shot={shot} a={a} variant="switch" />
      <GenButtons shot={shot} c={c} approved={a.approved} approving={a.approving !== null} />
      {!a.approved && shot.takes.length > 0 && <Why>Approve a take to unlock the final render</Why>}
      <FailNote shot={shot} />
    </div>
  );
}

function CastChips({ shot, c }: { shot: Shot; c: ShotCtl }) {
  return (
    <div className="chips">
      {c.p.cast.map((m) => {
        const on = shot.castIds.includes(m.id);
        return (
          <button
            key={m.id}
            type="button"
            className={`chip${on ? " on" : ""}`}
            aria-pressed={on}
            title={m.kind}
            onClick={() => void c.patch({ castIds: on ? shot.castIds.filter((x) => x !== m.id) : [...shot.castIds, m.id] })}
          >
            {m.name}
          </button>
        );
      })}
    </div>
  );
}

function FailNote({ shot }: { shot: Shot }) {
  return (
    <>
      {shot.takes
        .filter((t) => t.status === "failed" && t.error)
        .slice(-1)
        .map((t) => (
          <div key={t.id} className="take-error small-text">
            Last failure: {t.error}
          </div>
        ))}
    </>
  );
}

function ShotCosts({ lines, config }: { lines: ShotCtl["lines"]; config: ReturnType<typeof useApp>["config"] }) {
  return (
    <details className="shot-costs">
      <summary>{plural(lines.length, "charge")}</summary>
      <ShotCostsTable lines={lines} config={config} />
    </details>
  );
}

function ShotCostsTable({ lines, config }: { lines: ShotCtl["lines"]; config: ReturnType<typeof useApp>["config"] }) {
  return (
    <table className="table mini">
      <tbody>
        {lines.map((l) => (
          <tr key={l.id} className={l.status === "refunded" ? "refunded" : ""}>
            <td className="nowrap">
              {l.tier === "final" ? "Final " : l.tier === "draft" ? "Draft " : ""}
              {KIND[l.kind] ?? l.kind}
            </td>
            <td>{modelLabel(config, l.model)}</td>
            <td className="num nowrap">{unitLabel(l.units, l.unit)}</td>
            <td className="num">{money(l.paidMicro)}</td>
            <td>
              <StatusBadge status={l.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const AUDIO: Record<string, string> = { native: "Native audio", tts: "Text to speech", none: "No audio" };
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

const KIND: Record<string, string> = { image: "image", video: "video", tts: "voice", llm: "text" };

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
