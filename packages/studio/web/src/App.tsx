import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type Config, type Dashboard, type LocalSettings, api } from "./api";
import { ProjectView } from "./ProjectView";
import { Home } from "./Home";
import { Projects } from "./Projects";
import { Settings } from "./Settings";
import { AppCtx, type AppState, Icon, Spinner, applyTheme, currentTheme, errorMessage, money } from "./ui";

export type Route = { page: "home" } | { page: "projects" } | { page: "settings" } | { page: "project"; pid: string; tab: string };

function parseHash(): Route {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "settings") return { page: "settings" };
  if (parts[0] === "projects") return { page: "projects" };
  if (parts[0] === "p" && parts[1]) return { page: "project", pid: parts[1], tab: parts[2] ?? "script" };
  return { page: "home" };
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
        className="user-row"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Your account menu"
        onClick={() => setOpen(!open)}
      >
        <span className="avatar">{initials(account.name, account.email)}</span>
        <span className="user-text">
          <strong>{account.name || account.email}</strong>
          <span>{account.email}</span>
        </span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="who">
            <strong>{account.name}</strong>
            <span>{account.email}</span>
            <span className="ws">{account.workspace}</span>
          </div>
          <a href="#/projects" role="menuitem">
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

interface Ask {
  message: string;
  ok: string;
  danger: boolean;
  resolve(v: boolean): void;
}

/** A small in-page confirmation, instead of the browser's dialog. */
function ConfirmDialog({ ask, done }: { ask: Ask; done(v: boolean): void }) {
  const okRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef(done);
  doneRef.current = done;
  useEffect(() => {
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") doneRef.current(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="modal-layer">
      <button type="button" className="modal-backdrop" aria-label="Cancel" tabIndex={-1} onClick={() => done(false)} />
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-msg">
        <p id="confirm-msg">{ask.message}</p>
        <div className="modal-actions">
          <button type="button" onClick={() => done(false)}>
            Cancel
          </button>
          <button type="button" ref={okRef} className={ask.danger ? "danger-solid" : "primary"} onClick={() => done(true)}>
            {ask.ok}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One sidebar link; an icon with a label that hides on the rail. */
function NavItem({
  href,
  icon,
  label,
  active,
}: {
  href: string;
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  active?: boolean;
}) {
  return (
    <a href={href} className={`nav-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined} title={label}>
      <Icon name={icon} size={17} />
      <span className="nav-label">{label}</span>
    </a>
  );
}

const PAGE_NAMES: Record<string, string> = { home: "Home", projects: "Projects", settings: "Settings" };

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [config, setConfig] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<LocalSettings | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [crumb, setCrumb] = useState<ReactNode>(null);
  const [drawer, setDrawer] = useState(false);
  const [theme, setTheme] = useState(currentTheme);
  const [ask, setAsk] = useState<Ask | null>(null);
  const nextId = useRef(1);

  useEffect(() => {
    const on = () => {
      setRoute(parseHash());
      setDrawer(false);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);

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

  const refreshDash = useCallback(async () => {
    try {
      setDash(await api.get<Dashboard>("/dashboard"));
    } catch {
      // The dashboard is a nicety; pages work without it.
    }
  }, []);

  useEffect(() => {
    void refreshConfig();
  }, [refreshConfig]);
  useEffect(() => {
    if (config?.mode === "local") void refreshSettings();
  }, [config?.mode, refreshSettings]);

  // Refresh on every page change, then every few seconds while something is running.
  const running = dash?.running.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: route is the trigger
  useEffect(() => {
    if (!config) return;
    void refreshDash();
  }, [config, route, refreshDash]);
  useEffect(() => {
    if (!config) return;
    const t = setInterval(() => void refreshDash(), running > 0 ? 4000 : 20000);
    return () => clearInterval(t);
  }, [config, running, refreshDash]);
  useEffect(() => {
    if (route.page !== "project") setCrumb(null);
  }, [route.page]);

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

  const confirm = useCallback(
    (message: string, opts?: { ok?: string; danger?: boolean }) =>
      new Promise<boolean>((resolve) => setAsk({ message, ok: opts?.ok ?? "OK", danger: !!opts?.danger, resolve })),
    [],
  );

  const state = useMemo<AppState | null>(
    () => (config ? { config, settings, refreshSettings, refreshConfig, fail, toast, dash, refreshDash, setCrumb, confirm } : null),
    [config, settings, refreshSettings, refreshConfig, fail, toast, dash, refreshDash, confirm],
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
  const account = config.account;
  // Out of credit but not frozen: a calm nudge, not an alarm.
  const lowCredit = !!wallet && wallet.balanceMicro - wallet.heldMicro <= 0 && !/frozen/i.test(wallet.message ?? "");
  const workspace = account?.workspace ?? "Studio";
  const runCount = dash?.running.reduce((a, r) => a + r.count, 0) ?? 0;
  const firstRun = dash?.running[0];
  const onProject = route.page === "project";
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };

  return (
    <AppCtx.Provider value={state}>
      <div className={`shell${drawer ? " drawer-open" : ""}`}>
        <aside className="sidebar" aria-label="Studio">
          <a className="side-brand" href="#/" aria-label="Dropisode studio home">
            <span className="brand-full">Dropisode</span>
            <span className="brand-mark" aria-hidden="true">
              D
            </span>
            <span className="brand-sub">Studio</span>
          </a>
          {account && (
            <a className="ws-switch" href="/account" title="Workspace and team">
              <span className="ws-mark">{account.workspace.trim().charAt(0).toUpperCase() || "W"}</span>
              <span className="ws-text">
                <strong>{account.workspace}</strong>
                <span>Workspace</span>
              </span>
            </a>
          )}
          <nav className="side-nav">
            <NavItem href="#/" icon="home" label="Home" active={route.page === "home"} />
            <NavItem href="#/projects" icon="folder" label="Projects" active={route.page === "projects" || onProject} />
            <div className="nav-gap" />
            {!local && <NavItem href="/billing" icon="card" label="Usage & credit" />}
            {!local && <NavItem href="/account" icon="team" label="Team" />}
            {local && <NavItem href="#/settings" icon="gear" label="Settings" active={route.page === "settings"} />}
            {!local && (
              <>
                <div className="nav-gap" />
                <NavItem href="/docs" icon="help" label="Help" />
              </>
            )}
          </nav>
          <div className="side-fill" />
          {wallet && (
            <div className={`credit-card${lowCredit ? " low" : ""}`}>
              <span className="credit-label">Available credit</span>
              <strong className="credit-amount">{money(wallet.balanceMicro)}</strong>
              {wallet.heldMicro > 0 && <span className="credit-held">{money(wallet.heldMicro)} in use</span>}
              <a className="btn credit-add" href="/billing">
                <Icon name="plus" size={13} /> Add credit
              </a>
            </div>
          )}
          {local && settings?.provider === "mock" && <span className="side-tag">Test mode: nothing is spent</span>}
          {account && <ProfileMenu account={account} />}
        </aside>
        <button type="button" className="drawer-backdrop" aria-label="Close menu" tabIndex={-1} onClick={() => setDrawer(false)} />

        <div className="shell-main">
          <header className="pagebar">
            <button type="button" className="icon-btn menu-btn" aria-label="Open menu" onClick={() => setDrawer(true)}>
              <Icon name="menu" size={20} />
            </button>
            <nav className="crumbs" aria-label="Breadcrumb">
              <span className="crumb-ws">{workspace}</span>
              <span className="crumb-sep" aria-hidden="true">
                /
              </span>
              {onProject ? (
                <>
                  <a href="#/projects">Projects</a>
                  {crumb && (
                    <>
                      <span className="crumb-sep" aria-hidden="true">
                        /
                      </span>
                      <span className="crumb-here">{crumb}</span>
                    </>
                  )}
                </>
              ) : (
                <span className="crumb-here">{PAGE_NAMES[route.page]}</span>
              )}
            </nav>
            <div className="spacer" />
            {runCount > 0 && firstRun && (
              <a
                className="running"
                href={`#/p/${firstRun.projectId}/storyboard`}
                title={dash?.running.map((r) => `${r.projectName}: ${r.count}`).join(", ")}
              >
                <Spinner /> {runCount} generating
              </a>
            )}
            <button
              type="button"
              className="icon-btn theme-btn"
              aria-label={theme === "dark" ? "Use the light theme" : "Use the dark theme"}
              title={theme === "dark" ? "Light theme" : "Dark theme"}
              onClick={toggleTheme}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} size={17} />
            </button>
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
            {route.page === "home" && <Home />}
            {route.page === "projects" && <Projects />}
            {route.page === "settings" && (local ? <Settings /> : <p className="muted">Settings are only for the local studio.</p>)}
            {route.page === "project" && <ProjectView key={route.pid} pid={route.pid} tab={route.tab} />}
          </main>
        </div>
      </div>

      {ask && (
        <ConfirmDialog
          ask={ask}
          done={(v) => {
            ask.resolve(v);
            setAsk(null);
          }}
        />
      )}

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
