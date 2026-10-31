import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type Estimates, type Project, type View, api } from "./api";
import { CastTab } from "./CastTab";
import { CostsTab } from "./CostsTab";
import { EpisodeTab } from "./EpisodeTab";
import { ScriptTab } from "./ScriptTab";
import { StoryboardTab } from "./StoryboardTab";
import { Icon, Spinner, money, useApp } from "./ui";

export interface ProjectState {
  pid: string;
  view: View;
  estimates: Estimates | null;
  /** Runs a request that returns a view (or a view plus extra fields) and shows it. */
  act<T extends View>(key: string, fn: () => Promise<T>, opts?: { kick?: boolean }): Promise<T | undefined>;
  isBusy(key: string): boolean;
  apply(v: View): void;
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

  const apply = useCallback((v: View) => {
    if (alive.current)
      setView({ project: v.project, totals: v.totals, episodeTotals: v.episodeTotals, costLog: v.costLog, openJobs: v.openJobs });
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await api.get<View>(`/projects/${pid}`));
    } catch (err) {
      if ((err as { status?: number }).status === 404) setMissing("This project doesn't exist any more.");
      else app.fail(err);
    }
  }, [pid, apply, app]);

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

  const sig = view ? priceSignature(view.project) : "";
  useEffect(() => {
    if (!sig) return;
    let stale = false;
    api
      .get<Estimates>(`/projects/${pid}/estimates`)
      .then((e) => {
        if (!stale) setEstimates(e);
      })
      .catch((err) => app.fail(err));
    return () => {
      stale = true;
    };
  }, [sig, pid, app]);

  const act = useCallback(
    async <T extends View>(key: string, fn: () => Promise<T>, opts?: { kick?: boolean }): Promise<T | undefined> => {
      setBusy((b) => new Set(b).add(key));
      if (opts?.kick) kickUntil.current = Date.now() + 8000;
      try {
        const v = await fn();
        apply(v);
        return v;
      } catch (err) {
        app.fail(err);
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
    [apply, app, load],
  );

  const state = useMemo<ProjectState | null>(
    () => (view ? { pid, view, estimates, act, isBusy: (k: string) => busy.has(k), apply } : null),
    [pid, view, estimates, act, busy, apply],
  );

  if (missing)
    return (
      <div className="page">
        <p>{missing}</p>
        <a href="#/">Back to projects</a>
      </div>
    );
  if (!state || !view) return <div className="page muted">Loading project</div>;

  const working = view.openJobs.length;
  return (
    <ProjectCtx.Provider value={state}>
      <div className="project-head">
        <div className="title-block">
          <a href="#/" className="crumb">
            <Icon name="left" size={12} /> Projects
          </a>
          <div className="title-line">
            <h1>{view.project.name}</h1>
            <span className="tag">{view.project.aspect === "16:9" ? "Wide 16:9" : "Vertical 9:16"}</span>
          </div>
        </div>
        <div className="spacer" />
        {working > 0 && (
          <span className="working">
            <Spinner /> {working} generating
          </span>
        )}
        <div className="total">
          <span className="total-label">
            Spent
            <button type="button" className="hint" aria-label={app.config.priceLabel} data-tip={app.config.priceLabel}>
              i
            </button>
          </span>
          <a href={`#/p/${pid}/costs`}>
            <strong>{money(view.totals.paidMicro)}</strong>
          </a>
        </div>
      </div>
      <nav className="tabs" aria-label="Project">
        {TABS.map(([id, label]) => (
          <a key={id} href={`#/p/${pid}/${id}`} className={tab === id ? "active" : ""} aria-current={tab === id ? "page" : undefined}>
            {label}
          </a>
        ))}
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
