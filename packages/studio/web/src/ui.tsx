import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from "react";
import type { Config, LocalSettings } from "./api";
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
