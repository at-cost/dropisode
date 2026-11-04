import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type Estimates, type ExportInfo, type Project, type View, api } from "./api";
import { CastTab } from "./CastTab";
import { CostsTab } from "./CostsTab";
import { EpisodeTab } from "./EpisodeTab";
import { ScriptTab } from "./ScriptTab";
import { StoryboardTab } from "./StoryboardTab";
import { type Step, stepsDone } from "./progress";
import { Icon, money, plural, useApp } from "./ui";

export interface ProjectState {
  pid: string;
  view: View;
  estimates: Estimates | null;
  /** Runs a request that returns a view (or a view plus extra fields) and shows it. */
  act<T extends View>(key: string, fn: () => Promise<T>, opts?: { kick?: boolean }): Promise<T | undefined>;
  isBusy(key: string): boolean;
  apply(v: View): void;
  /** Re-reads the exports after assembling, for the stepper. */
  refreshExports(): void;
}

const ProjectCtx = createContext<ProjectState | null>(null);
export function useProject(): ProjectState {
  const v = useContext(ProjectCtx);
  if (!v) throw new Error("No project");
  return v;
}

const TABS = [
  ["script", "Script"],
  ["cast", "Cast"],
  ["storyboard", "Storyboard"],
  ["episode", "Episode"],
  ["costs", "Costs"],
] as const;

/** What the prices depend on, so estimates are refetched only when it changes. */
function priceSignature(p: Project): string {
  return JSON.stringify([
    p.models ?? {},
    p.idea.length,
    p.cast.map((c) => [c.id, c.refImageIds.length, c.description.length]),
    p.episodes.map((e) =>
      e.scenes.map((s) => [
        s.id,
        s.script.length,
        s.heading,
        s.shots.map((sh) => [sh.id, sh.durationS, sh.audio, sh.castIds.length, sh.dialogue.map((l) => [l.text.length, !!l.ttsMediaId])]),
      ]),
    ),
  ]);
}

function inProgress(v: View): boolean {
  if (v.openJobs.length > 0) return true;
  return v.project.episodes.some((e) =>
    e.scenes.some((s) => s.shots.some((sh) => sh.takes.some((t) => t.status === "queued" || t.status === "running"))),
  );
}

export function ProjectView({ pid, tab }: { pid: string; tab: string }) {
  const app = useApp();
  const [view, setView] = useState<View | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [estimates, setEstimates] = useState<Estimates | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const kickUntil = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  // The app context changes on every dashboard refresh; read it through a ref so that doesn't reload the project.
  const appRef = useRef(app);
  appRef.current = app;

  const apply = useCallback((v: View) => {
    if (alive.current)
      setView({ project: v.project, totals: v.totals, episodeTotals: v.episodeTotals, costLog: v.costLog, openJobs: v.openJobs });
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await api.get<View>(`/projects/${pid}`));
    } catch (err) {
      if ((err as { status?: number }).status === 404) setMissing("This project doesn't exist any more.");
      else appRef.current.fail(err);
    }
  }, [pid, apply]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  // Poll every 2 s while anything is generating, and for a short while after starting one.
  useEffect(() => {
    if (!view) return;
    if (timer.current) clearTimeout(timer.current);
    if (inProgress(view) || Date.now() < kickUntil.current) {
      timer.current = setTimeout(() => void load(), 2000);
    }
  }, [view, load]);

  // Whether a final episode has been exported, for the stepper's last tick.
  const [exportCount, setExportCount] = useState(0);
  const [anyExport, setAnyExport] = useState(false);
  const refreshExports = useCallback(() => {
    api
      .get<ExportInfo[]>(`/projects/${pid}/exports`)
      // A complete final episode: nothing was skipped.
      .then((x) => {
        setExportCount(x.filter((e) => e.source === "final" && e.skipped.length === 0).length);
        setAnyExport(x.length > 0);
      })
      .catch(() => {});
  }, [pid]);
  useEffect(() => {
    refreshExports();
  }, [refreshExports]);

  // When generation starts or finishes, the credit, the dashboard and the running pill change too.
  const activity = view
    ? [
        view.openJobs.map((j) => j.id).join(","),
        view.costLog.length,
        view.costLog.filter((l) => l.status === "pending").length,
        view.project.episodes.flatMap((e) => e.scenes.flatMap((s) => s.shots.flatMap((sh) => sh.takes.filter((t) => t.status === "done"))))
          .length,
      ].join("|")
    : "";
  const lastActivity = useRef("");
  useEffect(() => {
    if (!activity) return;
    if (lastActivity.current && lastActivity.current !== activity) {
      void appRef.current.refreshDash();
      if (appRef.current.config.wallet) void appRef.current.refreshConfig();
    }
    lastActivity.current = activity;
  }, [activity]);
  const name = view?.project.name;
  useEffect(() => {
    app.setCrumb(name ?? null);
  }, [app, name]);

  const sig = view ? priceSignature(view.project) : "";
  useEffect(() => {
    if (!sig) return;
    let stale = false;
    api
      .get<Estimates>(`/projects/${pid}/estimates`)
      .then((e) => {
        if (!stale) setEstimates(e);
      })
      .catch((err) => appRef.current.fail(err));
    return () => {
      stale = true;
    };
  }, [sig, pid]);

  const act = useCallback(
    async <T extends View>(key: string, fn: () => Promise<T>, opts?: { kick?: boolean }): Promise<T | undefined> => {
      setBusy((b) => new Set(b).add(key));
      if (opts?.kick) kickUntil.current = Date.now() + 8000;
      try {
        const v = await fn();
        apply(v);
        return v;
      } catch (err) {
        appRef.current.fail(err);
        // The server may have changed something before failing (a refund, a failed take).
        void load();
        return undefined;
      } finally {
        setBusy((b) => {
          const n = new Set(b);
          n.delete(key);
          return n;
        });
      }
    },
    [apply, load],
  );

  const state = useMemo<ProjectState | null>(
    () => (view ? { pid, view, estimates, act, isBusy: (k: string) => busy.has(k), apply, refreshExports } : null),
    [pid, view, estimates, act, busy, apply, refreshExports],
  );

  if (missing)
    return (
      <div className="page">
        <p>{missing}</p>
        <a href="#/">Back to projects</a>
      </div>
    );
  if (!state || !view) return <div className="page muted">Loading project</div>;

  const p = view.project;
  const done = stepsDone(p, exportCount);
  const ep = p.episodes[0];
  const epShots = ep ? ep.scenes.flatMap((s) => s.shots) : [];
  const epSeconds = Math.round(epShots.reduce((a, s) => a + s.durationS, 0));
  return (
    <ProjectCtx.Provider value={state}>
      <div className="project-head">
        <div className="title-block">
          <div className="eyebrow-line">
            <span>Project</span>
            <span className="format-chip">{p.aspect === "16:9" ? "Wide 16:9" : "Vertical 9:16"}</span>
          </div>
          <h1>{p.name}</h1>
          {ep && (
            <p className="project-sub">
              {p.episodes.length > 1 ? `${plural(p.episodes.length, "episode")} · ` : `Episode 1: ${ep.title} · `}
              {plural(epShots.length, "shot")}
              {epSeconds > 0 ? `, ${epSeconds} seconds` : ""}
            </p>
          )}
        </div>
        <div className="spacer" />
        <div className="head-actions">
          <div className="total">
            <span className="total-label">
              Project spent
              <button type="button" className="hint" aria-label={app.config.priceLabel} data-tip={app.config.priceLabel}>
                i
              </button>
            </span>
            <a href={`#/p/${pid}/costs`}>
              <strong>{money(view.totals.paidMicro)}</strong>
            </a>
          </div>
          {anyExport && (
            <a className="btn preview-btn" href={`#/p/${pid}/episode`}>
              Preview episode
            </a>
          )}
        </div>
      </div>
      <nav className="stepper" aria-label="Project steps">
        {TABS.map(([id, label], i) => {
          const tick = id !== "costs" && done[id as Step];
          return (
            <a
              key={id}
              href={`#/p/${pid}/${id}`}
              className={`${tab === id ? "active" : ""}${tick ? " done" : ""}`}
              aria-current={tab === id ? "page" : undefined}
              title={tick ? `${label}: done` : label}
            >
              <span className="step-dot" aria-hidden="true">
                {tick ? <Icon name="check" size={12} /> : i + 1}
              </span>
              <span className="step-label">{label}</span>
            </a>
          );
        })}
      </nav>
      <div className="tab-body">
        {tab === "script" && <ScriptTab />}
        {tab === "cast" && <CastTab />}
        {tab === "storyboard" && <StoryboardTab />}
        {tab === "episode" && <EpisodeTab />}
        {tab === "costs" && <CostsTab />}
      </div>
    </ProjectCtx.Provider>
  );
}
