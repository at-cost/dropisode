import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Ctx, Deps } from "../context";
import { HttpError, unauthorized } from "../lib/errors";
import { newToken, sha256, uuid } from "../lib/ids";

const SESSION_DAYS = 30;
export const sessionCookie = (deps: Deps) => (deps.config.secureCookies ? "__Host-reel_session" : "reel_session");
export const WORKSPACE_COOKIE = "reel_ws";

export async function createSession(c: Ctx, userId: string): Promise<void> {
  const deps = c.get("deps");
  const token = newToken();
  await deps.db
    .insertInto("sessions")
    .values({ id: uuid(), userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) })
    .execute();
  setCookie(c, sessionCookie(deps), token, {
    httpOnly: true,
    secure: deps.config.secureCookies,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function destroySession(c: Ctx): Promise<void> {
  const deps = c.get("deps");
  const user = c.get("user");
  if (user) await deps.db.deleteFrom("sessions").where("id", "=", user.sessionId).execute();
  deleteCookie(c, sessionCookie(deps), { path: "/", secure: deps.config.secureCookies });
}

/** Loads the signed-in user if there is a valid session cookie. Never rejects. */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const deps = c.get("deps");
  c.set("user", null);
  const token = getCookie(c, sessionCookie(deps));
  if (token) {
    const row = await deps.db
      .selectFrom("sessions as s")
      .innerJoin("users as u", "u.id", "s.userId")
      .select(["s.id as sessionId", "s.lastSeenAt", "u.id", "u.email", "u.name"])
      .where("s.tokenHash", "=", sha256(token))
      .where("s.expiresAt", ">", new Date())
      .where("u.deletedAt", "is", null)
      .executeTakeFirst();
    if (row) {
      c.set("user", {
        id: row.id,
        email: row.email,
        name: row.name,
        sessionId: row.sessionId,
        isAdmin: deps.config.adminEmails.includes(row.email.toLowerCase()),
      });
      if (Date.now() - new Date(row.lastSeenAt).getTime() > 3_600_000) {
        await deps.db
          .updateTable("sessions")
          .set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) })
          .where("id", "=", row.sessionId)
          .execute();
      }
    }
  }
  await next();
};

/** Blocks cross-site writes: state-changing requests must come from our own origin. */
export const sameOriginWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    const app = new URL(c.get("deps").config.APP_URL).origin;
    const site = c.req.header("sec-fetch-site");
    if ((origin && origin !== app) || (!origin && site === "cross-site")) throw new HttpError(403, "Cross-site request refused");
  }
  await next();
};

export function requireUser(c: Ctx) {
  const user = c.get("user");
  if (!user) throw unauthorized();
  return user;
}

export function requireAdmin(c: Ctx) {
  const user = requireUser(c);
  if (!user.isAdmin) throw new HttpError(403, "Admins only");
  return user;
}
