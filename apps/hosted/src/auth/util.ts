import { z } from "zod";
import type { Ctx, Deps } from "../context";
import { HttpError } from "../lib/errors";

/** Where people land after signing in. */
export const APP_HOME = "/studio/";

/** Only same-site relative paths, to avoid open redirects. Anything else becomes the studio. */
export function safeNext(next: string | null | undefined, appUrl = "http://localhost"): string {
  if (!next || next.length > 500) return APP_HOME;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\") || [...next].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return APP_HOME;
  try {
    const base = new URL(appUrl);
    const u = new URL(next, base);
    if (u.origin !== base.origin) return APP_HOME;
  } catch {
    return APP_HOME;
  }
  return next === "/" ? APP_HOME : next;
}

export const emailField = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** Behind one trusted reverse proxy, the last X-Forwarded-For hop is the client. */
export function clientIp(c: Ctx): string {
  const xff = c.req.header("x-forwarded-for");
  return xff?.split(",").pop()?.trim() || c.req.header("x-real-ip") || "local";
}

/** A fixed-window counter in memory, one per app (deps), so tests don't share it. */
class Limiter {
  private hits = new Map<string, { n: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  /** Seconds to wait, or 0 when allowed. */
  take(key: string): number {
    const now = Date.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      this.hits.set(key, { n: 1, resetAt: now + this.windowMs });
      return 0;
    }
    h.n++;
    return h.n > this.max ? Math.ceil((h.resetAt - now) / 1000) : 0;
  }
}

const limiters = new WeakMap<Deps, { ip: Limiter; email: Limiter; verify: Limiter; invite: Limiter; password: Limiter }>();

export function limits(deps: Deps) {
  let l = limiters.get(deps);
  if (!l) {
    const w = 15 * 60_000;
    l = {
      ip: new Limiter(30, w),
      email: new Limiter(5, w),
      verify: new Limiter(30, w),
      invite: new Limiter(30, 60 * 60_000),
      // Wrong-password guesses per account.
      password: new Limiter(10, w),
    };
    limiters.set(deps, l);
  }
  return l;
}

export function rateLimit(c: Ctx, which: keyof ReturnType<typeof limits>, key: string): void {
  const wait = limits(c.get("deps"))[which].take(key);
  if (wait > 0) {
    c.header("Retry-After", String(wait));
    throw new HttpError(429, "Too many attempts. Wait a few minutes and try again.");
  }
}
