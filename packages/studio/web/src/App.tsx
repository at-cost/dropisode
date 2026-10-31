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

function initials(name: string, email: string): string {
  const words = (name || email.split("@")[0] || "?")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .trim()
    .split(/\s+/);
  const two = words.length > 1 ? (words[0]?.[0] ?? "") + (words[words.length - 1]?.[0] ?? "") : (words[0] ?? "?").slice(0, 1);
  return two.toUpperCase();
}

/** Avatar with a menu: account pages and sign out (hosted only). */
function ProfileMenu({ account }: { account: NonNullable<Config["account"]> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onHash = () => setOpen(false);
    window.addEventListener("hashchange", onHash);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hashchange", onHash);
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="profile" ref={ref}>
      <button
        type="button"
        className="avatar-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Your account menu"
        onClick={() => setOpen(!open)}
      >
        <span className="avatar">{initials(account.name, account.email)}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="who">
            <strong>{account.name}</strong>
            <span>{account.email}</span>
            <span className="ws">{account.workspace}</span>
          </div>
          <a href="#/" role="menuitem">
            Projects
          </a>
          <a href="/billing" role="menuitem">
            Billing and credit
          </a>
          <a href="/account" role="menuitem">
            Account and team
          </a>
          {account.isAdmin && (
            <a href="/admin" role="menuitem">
              Admin
            </a>
          )}
          <a href="/" role="menuitem">
            Dropisode home
          </a>
          <form method="post" action="/auth/sign-out">
            <button type="submit" className="signout" role="menuitem">
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
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
  // Out of credit but not frozen: a calm nudge, not an alarm.
  const lowCredit = !!wallet && wallet.balanceMicro - wallet.heldMicro <= 0 && !/frozen/i.test(wallet.message ?? "");

  return (
    <AppCtx.Provider value={state}>
      <header className="topbar">
        <a className="brand" href="#/">
          Dropisode <span className="brand-sub">Studio</span>
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
        {local && settings?.provider === "mock" && <span className="tag">Test mode: nothing is spent</span>}
        {wallet && (
          <a className="wallet" href="/billing" title="Billing and credit">
            <span className="wallet-label">Credit</span>
            <strong>{money(wallet.balanceMicro)}</strong>
            {wallet.heldMicro > 0 && <span className="wallet-held">{money(wallet.heldMicro)} in use</span>}
            <span className="wallet-add" aria-hidden="true">
              +
            </span>
          </a>
        )}
        {config.account && <ProfileMenu account={config.account} />}
      </header>

      {needKey && (
        <div className="banner warn">
          Add your fal.ai key to generate anything. <a href="#/settings">Open Settings</a>
        </div>
      )}
      {wallet?.blocked && !blocked && lowCredit && (
        <div className="banner gold">
          Add credit to start generating. Everything else is free. <a href="/billing">Add credit</a>
        </div>
      )}
      {wallet?.blocked && !blocked && !lowCredit && (
        <div className="banner danger">
          {wallet.message ?? "Generation is paused for this workspace."} <a href="/billing">Billing</a>
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
