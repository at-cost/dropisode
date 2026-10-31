import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from "react";
import type { Config, Dashboard, LocalSettings } from "./api";
import { ApiError } from "./api";

/** Micro-USD as dollars: 2 decimals, or 3 for small non-zero amounts (under $0.10). */
export function money(micro: number): string {
  const usd = micro / 1_000_000;
  const abs = Math.abs(usd);
  const digits = abs > 0 && abs < 0.1 ? 3 : 2;
  return `${usd < 0 ? "-" : ""}$${abs.toFixed(digits)}`;
}

/** A price as a gold ticket stub, for generate buttons. */
export function Ticket({ micro }: { micro: number | null | undefined }) {
  if (micro == null) return null;
  return <span className="ticket">{money(micro)}</span>;
}

/** Why a primary action is disabled, shown beside it. */
export function Why({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <span className="why">{children}</span>;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "31 Oct, 10:47" (with the year when it isn't this year). */
export function when(iso: string): string {
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}, ${hm}`;
}

/** "just now", "2 min ago", "3 h ago", then "31 Oct, 10:47". */
export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return when(iso);
}

/** A timestamp in body text: relative, with the exact time on hover. */
export function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={when(iso)}>
      {ago(iso)}
    </time>
  );
}

/** The human name of a model id, from config.models. */
export function modelLabel(config: Config, id: string): string {
  return config.models?.find((m) => m.id === id)?.label ?? id;
}

export function providerLabel(p: string): string {
  if (p === "mock") return "Test mode";
  if (p === "fal") return "fal.ai";
  return p;
}

const num = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en") : n.toFixed(n < 10 ? 1 : 0));

/** Billed units in plain words: "5 s", "1 image", "420 chars", "1,684 tokens". */
export function unitLabel(units: number, unit: string): string {
  switch (unit) {
    case "second":
      return `${num(units)} s`;
    case "image":
      return plural(units, "image");
    case "video":
      return plural(units, "clip");
    case "1k_chars":
      return `${Math.round(units * 1000).toLocaleString("en")} chars`;
    case "tokens":
      return `${num(units)} tokens`;
    default:
      return `${num(units)} ${unit}`;
  }
}

/** A small "⋯" button that opens a menu of actions. */
export function MoreMenu({ label, children }: { label: string; children: ReactNode }) {
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
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="more" ref={ref}>
      <button
        type="button"
        className="icon-btn more-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen(!open)}
      >
        <Icon name="more" />
      </button>
      {open && (
        // Any click on an item closes the menu.
        <div
          className="more-menu"
          role="menu"
          onClick={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export interface AppState {
  config: Config;
  settings: LocalSettings | null;
  refreshSettings(): Promise<void>;
  refreshConfig(): Promise<void>;
  /** Shows an error: 402 as a banner, anything else as a toast. */
  fail(err: unknown): void;
  toast(msg: string): void;
  /** Activity, month spend and running jobs across the workspace. */
  dash: Dashboard | null;
  refreshDash(): Promise<void>;
  /** An in-page confirmation (no browser dialogs). */
  confirm(message: string, opts?: { ok?: string; danger?: boolean }): Promise<boolean>;
  /** The last part of the page header breadcrumb, set by the page. */
  setCrumb(crumb: ReactNode): void;
}

export const AppCtx = createContext<AppState | null>(null);
export function useApp(): AppState {
  const v = useContext(AppCtx);
  if (!v) throw new Error("No app context");
  return v;
}

/** Runs an async action with a busy flag and error reporting. */
export function useBusy() {
  const app = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key);
    try {
      return await fn();
    } catch (err) {
      app.fail(err);
      return undefined;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError || err instanceof Error) return err.message;
  return String(err);
}

const paths: Record<string, ReactNode> = {
  up: <path d="M4 10l4-4 4 4" />,
  down: <path d="M4 6l4 4 4-4" />,
  left: <path d="M10 4L6 8l4 4" />,
  right: <path d="M6 4l4 4-4 4" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  plus: <path d="M8 3v10M3 8h10" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />,
  split: <path d="M8 2v12M3 5l-1.5 3L3 11M13 5l1.5 3L13 11" />,
  merge: <path d="M2 4h4l2 4-2 4H2M14 4h-4M14 12h-4M8 8h6" />,
  check: <path d="M3 8.5l3 3 7-7" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1" fill="currentColor" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  film: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6.5 6l3.5 2-3.5 2z" />
    </>
  ),
  upload: <path d="M8 11V3M5 6l3-3 3 3M3 13h10" />,
  home: <path d="M2.5 7.5L8 3l5.5 4.5M4 6.5V13h3v-3h2v3h3V6.5" />,
  folder: <path d="M2 4.5A1.5 1.5 0 013.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z" />,
  card: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <path d="M2 6.5h12M4.5 10h3" />
    </>
  ),
  team: (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <path d="M2 13c.4-2.2 2-3.4 4-3.4s3.6 1.2 4 3.4M10.5 4a2 2 0 010 4M12 9.8c1.1.4 1.8 1.6 2 3.2" />
    </>
  ),
  help: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.3 6.3a1.8 1.8 0 113 1.4c-.7.4-1.3.8-1.3 1.6M8 11.3v.2" />
    </>
  ),
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
    </>
  ),
  moon: <path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" />,
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5" />,
  board: (
    <>
      <rect x="2" y="2.5" width="3.3" height="11" rx="1" />
      <rect x="6.35" y="2.5" width="3.3" height="7" rx="1" />
      <rect x="10.7" y="2.5" width="3.3" height="9" rx="1" />
    </>
  ),
  chevron: <path d="M4.5 6.5L8 10l3.5-3.5" />,
  spark: <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2L12 12M12 4l-1.8 1.8M5.8 10.2L4 12" />,
  download: <path d="M8 3v8M5 8l3 3 3-3M3 13h10" />,
  image: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2.5 11l3.5-3.5 3 3 2-2 2.5 2.5" />
    </>
  ),
};

export function Icon({ name, size = 14 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Working" />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** "1 scene", "2 scenes". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** True while a media query matches. */
export function useMedia(query: string): boolean {
  const get = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);
  const [on, setOn] = useState(get);
  useEffect(() => {
    const m = window.matchMedia(query);
    const fn = () => setOn(m.matches);
    fn();
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, [query]);
  return on;
}

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Not saved; the choice lasts for this visit only.
    }
  },
};

/** Light or dark: the studio defaults to dark. */
export function currentTheme(): "light" | "dark" {
  return store.get("dropisode.theme") === "light" ? "light" : "dark";
}
export function applyTheme(t: "light" | "dark"): void {
  document.documentElement.dataset.theme = t;
  store.set("dropisode.theme", t);
}
