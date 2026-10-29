import { type ReactNode, createContext, useContext, useState } from "react";
import type { Config, LocalSettings } from "./api";
import { ApiError } from "./api";

/** Micro-USD as dollars: 2 decimals, or 3 under $1. */
export function money(micro: number): string {
  const usd = micro / 1_000_000;
  const abs = Math.abs(usd);
  const digits = abs > 0 && abs < 1 ? 3 : 2;
  return `${usd < 0 ? "-" : ""}$${abs.toFixed(digits)}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function time(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
