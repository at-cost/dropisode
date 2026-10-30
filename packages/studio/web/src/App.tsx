import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type Config, type LocalSettings, api } from "./api";
import { ProjectView } from "./ProjectView";
import { Projects } from "./Projects";
import { Settings } from "./Settings";
import { AppCtx, type AppState, Icon, errorMessage, money } from "./ui";

export type Route = { page: "projects" } | { page: "settings" } | { page: "project"; pid: string; tab: string };

function parseHash(): Route {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "settings") return { page: "settings" };
  if (parts[0] === "p" && parts[1]) return { page: "project", pid: parts[1], tab: parts[2] ?? "script" };
  return { page: "projects" };
}

export function go(hash: string) {
  window.location.hash = hash;
}

interface Toast {
  id: number;
  msg: string;
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [config, setConfig] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<LocalSettings | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [blocked, setBlocked] = useState<string | null>(null);
  const nextId = useRef(1);

  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const refreshConfig = useCallback(async () => {
    try {
      setConfig(await api.get<Config>("/config"));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await api.get<LocalSettings>("/local/settings"));
    } catch {
      setSettings(null);
    }
  }, []);

  useEffect(() => {
    void refreshConfig();
  }, [refreshConfig]);
  useEffect(() => {
    if (config?.mode === "local") void refreshSettings();
  }, [config?.mode, refreshSettings]);

  const toast = useCallback((msg: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 8000);
  }, []);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 402) {
        setBlocked(err.message);
        if (config?.mode === "hosted") void refreshConfig();
        return;
      }
      toast(errorMessage(err));
    },
    [toast, config?.mode, refreshConfig],
  );

  const state = useMemo<AppState | null>(
    () => (config ? { config, settings, refreshSettings, refreshConfig, fail, toast } : null),
    [config, settings, refreshSettings, refreshConfig, fail, toast],
  );

  if (!state || !config) {
    return (
      <div className="boot">
        {loadError ? (
          <>
            <p>{loadError}</p>
            <button type="button" onClick={() => void refreshConfig()}>
              Try again
            </button>
          </>
        ) : (
          <p>Loading</p>
        )}
      </div>
    );
  }

  const local = config.mode === "local";
  const needKey = local && settings && settings.provider !== "mock" && !settings.hasKey;
  const wallet = config.wallet;

  return (
    <AppCtx.Provider value={state}>
      <header className="topbar">
        <a className="brand" href="#/">
          <Icon name="film" size={16} /> Dropisode
        </a>
        <nav>
          <a href="#/" className={route.page === "projects" ? "active" : ""}>
            Projects
          </a>
          {local && (
            <a href="#/settings" className={route.page === "settings" ? "active" : ""}>
              Settings
            </a>
          )}
        </nav>
        <div className="spacer" />
        {local && settings?.provider === "mock" && <span className="tag">Mock mode: nothing is spent</span>}
        {wallet && (
          <div className="wallet">
            <span className="muted">Balance</span> <strong>{money(wallet.balanceMicro)}</strong>
            {wallet.heldMicro > 0 && <span className="muted"> ({money(wallet.heldMicro)} held)</span>}
            <a className="btn small primary" href="/billing">
              Top up
            </a>
          </div>
        )}
      </header>

      {needKey && (
        <div className="banner warn">
          Add your fal.ai key to generate anything. <a href="#/settings">Open Settings</a>
        </div>
      )}
      {wallet?.blocked && !blocked && (
        <div className="banner danger">
          {wallet.message ?? "Generation is paused for this workspace."} <a href="/billing">Top up</a>
        </div>
      )}
      {blocked && (
        <div className="banner danger" role="alert">
          <strong>Blocked:</strong> {blocked} {local ? <a href="#/settings">Settings</a> : <a href="/billing">Top up</a>}
          <button type="button" className="link" onClick={() => setBlocked(null)}>
            Dismiss
          </button>
        </div>
      )}

      <main>
        {route.page === "projects" && <Projects />}
        {route.page === "settings" && (local ? <Settings /> : <p className="muted">Settings are only for the local studio.</p>)}
        {route.page === "project" && <ProjectView key={route.pid} pid={route.pid} tab={route.tab} />}
      </main>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.msg}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </AppCtx.Provider>
  );
}
