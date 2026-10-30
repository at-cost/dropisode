/**
 * Sign-in (email link, Google, GitHub) and the account API. Ported from
 * at-cost/glasstrack's auth routes (MIT). Email links and OAuth both prove the
 * address, so findOrCreateUser marks it verified.
 */
import { GitHub, Google, generateCodeVerifier, generateState } from "arctic";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  acceptInvite,
  accountState,
  createInvite,
  createWorkspace,
  pendingInvites,
  removeMember,
  renameWorkspace,
  revokeInvite,
  setRole,
} from "../account/service";
import type { AppEnv, Ctx, Deps } from "../context";
import { notFound } from "../lib/errors";
import { newToken, sha256 } from "../lib/ids";
import { createSession, destroySession, requireUser } from "./session";
import { findOrCreateUser } from "./users";
import { clientIp, emailField, rateLimit, safeNext } from "./util";
import { switchWorkspace } from "./workspace";
import { CSS } from "../site/layout";

export { authPages } from "./pages";

const LINK_MINUTES = 15;
const OAUTH_COOKIES = ["reel_oauth_state", "reel_oauth_verifier", "reel_oauth_next"] as const;

const isForm = (c: Ctx) => (c.req.header("content-type") ?? "").includes("application/x-www-form-urlencoded");

async function readBody(c: Ctx): Promise<Record<string, unknown>> {
  if (isForm(c)) return Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  return ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

function providers(deps: Deps) {
  const base = deps.config.APP_URL.replace(/\/$/, "");
  return {
    google: deps.config.googleEnabled
      ? new Google(deps.config.GOOGLE_CLIENT_ID, deps.config.GOOGLE_CLIENT_SECRET, `${base}/auth/oauth/google/callback`)
      : null,
    github: deps.config.githubEnabled
      ? new GitHub(deps.config.GITHUB_CLIENT_ID, deps.config.GITHUB_CLIENT_SECRET, `${base}/auth/oauth/github/callback`)
      : null,
  };
}

interface Profile {
  providerUserId: string;
  email: string;
  name: string | null;
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "reel" } });
  if (!res.ok) throw new Error(`OAuth profile fetch failed: ${res.status}`);
  return (await res.json()) as T;
}

async function googleProfile(token: string): Promise<Profile> {
  const p = await fetchJson<{ sub: string; email?: string; email_verified?: boolean; name?: string }>(
    "https://openidconnect.googleapis.com/v1/userinfo",
    token,
  );
  if (!p.email || !p.email_verified) throw new Error("Google email not verified");
  return { providerUserId: p.sub, email: p.email, name: p.name ?? null };
}

async function githubProfile(token: string): Promise<Profile> {
  const u = await fetchJson<{ id: number; login: string; name: string | null }>("https://api.github.com/user", token);
  const emails = await fetchJson<{ email: string; primary: boolean; verified: boolean }[]>("https://api.github.com/user/emails", token);
  const primary = emails.find((e) => e.primary && e.verified);
  if (!primary) throw new Error("GitHub has no verified primary email");
  return { providerUserId: String(u.id), email: primary.email, name: u.name ?? u.login };
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/email", async (c) => {
  const deps = c.get("deps");
  const raw = await readBody(c);
  const parsed = z.object({ email: emailField, next: z.string().max(500).optional() }).safeParse(raw);
  if (!parsed.success) {
    if (isForm(c)) return c.redirect("/sign-in?error=email");
    return c.json({ error: "Enter a valid email address" }, 400);
  }
  const { email } = parsed.data;
  const next = safeNext(parsed.data.next, deps.config.APP_URL);
  try {
    rateLimit(c, "ip", `ip:${clientIp(c)}`);
    rateLimit(c, "email", `email:${email}`);
  } catch (err) {
    if (isForm(c)) return c.redirect("/sign-in?error=rate");
    throw err;
  }
  const token = newToken();
  await deps.db
    .insertInto("loginTokens")
    .values({ tokenHash: sha256(token), email, redirect: next, expiresAt: new Date(Date.now() + LINK_MINUTES * 60_000) })
    .execute();
  const url = `${deps.config.APP_URL.replace(/\/$/, "")}/auth/verify?token=${encodeURIComponent(token)}`;
  await deps.mailer.send({
    to: email,
    subject: "Your Dropisode sign-in link",
    text: `Sign in to Dropisode: ${url}\n\nThe link works once and expires in ${LINK_MINUTES} minutes.\nIf you didn't ask for it, ignore this email.`,
  });
  if (isForm(c)) return c.redirect("/sign-in?sent=1");
  return c.json({ ok: true });
});

/**
 * The emailed link opens a confirm page; signing in needs the button (a POST).
 * Mail scanners that open links (Outlook Safe Links and others) can't use up the token.
 */
authRoutes.get("/verify", (c) => {
  const token = c.req.query("token") ?? "";
  if (token.length < 10 || token.length > 200) return c.redirect("/sign-in?error=link");
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in | Dropisode</title><style>${CSS}</style></head><body><main><div class="card" style="max-width:420px;margin:40px auto"><h1>Sign in to Dropisode</h1><form method="post" action="/auth/verify"><input type="hidden" name="token" value="${token.replace(/[^A-Za-z0-9_-]/g, "")}"><button type="submit">Continue</button></form></div></main></body></html>`,
  );
});

authRoutes.post("/verify", async (c) => {
  const deps = c.get("deps");
  const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  const token = typeof form.token === "string" ? form.token : "";
  try {
    rateLimit(c, "verify", `verify:${clientIp(c)}`);
  } catch {
    return c.redirect("/sign-in?error=rate");
  }
  if (token.length < 10 || token.length > 200) return c.redirect("/sign-in?error=link");
  const link = await deps.db
    .updateTable("loginTokens")
    .set({ usedAt: new Date() })
    .where("tokenHash", "=", sha256(token))
    .where("usedAt", "is", null)
    .where("expiresAt", ">", new Date())
    .returning(["email", "redirect"])
    .executeTakeFirst();
  if (!link) return c.redirect("/sign-in?error=link");
  const u = await findOrCreateUser(deps.db, { email: link.email });
  await createSession(c, u.id);
  return c.redirect(safeNext(link.redirect, deps.config.APP_URL));
});

authRoutes.get("/oauth/:provider", (c) => {
  const deps = c.get("deps");
  const name = c.req.param("provider");
  const p = providers(deps);
  const opts = { httpOnly: true, secure: deps.config.secureCookies, sameSite: "Lax" as const, path: "/auth/oauth", maxAge: 600 };
  const state = generateState();
  if (name === "google" && p.google) {
    const verifier = generateCodeVerifier();
    setCookie(c, "reel_oauth_state", state, opts);
    setCookie(c, "reel_oauth_verifier", verifier, opts);
    setCookie(c, "reel_oauth_next", safeNext(c.req.query("next"), deps.config.APP_URL), opts);
    return c.redirect(p.google.createAuthorizationURL(state, verifier, ["openid", "email", "profile"]).toString());
  }
  if (name === "github" && p.github) {
    // arctic's GitHub client doesn't take a PKCE verifier; the state cookie guards the flow.
    setCookie(c, "reel_oauth_state", state, opts);
    setCookie(c, "reel_oauth_next", safeNext(c.req.query("next"), deps.config.APP_URL), opts);
    return c.redirect(p.github.createAuthorizationURL(state, ["read:user", "user:email"]).toString());
  }
  throw notFound("That sign-in option isn't set up");
});

authRoutes.get("/oauth/:provider/callback", async (c) => {
  const deps = c.get("deps");
  const name = c.req.param("provider");
  const p = providers(deps);
  const state = getCookie(c, "reel_oauth_state");
  const verifier = getCookie(c, "reel_oauth_verifier");
  const next = safeNext(getCookie(c, "reel_oauth_next"), deps.config.APP_URL);
  for (const k of OAUTH_COOKIES) deleteCookie(c, k, { path: "/auth/oauth", secure: deps.config.secureCookies });
  const code = c.req.query("code");
  if (!code || !state || state !== c.req.query("state")) return c.redirect("/sign-in?error=oauth");
  let profile: Profile;
  try {
    if (name === "google" && p.google && verifier)
      profile = await googleProfile((await p.google.validateAuthorizationCode(code, verifier)).accessToken());
    else if (name === "github" && p.github) profile = await githubProfile((await p.github.validateAuthorizationCode(code)).accessToken());
    else return c.redirect("/sign-in?error=oauth");
  } catch (err) {
    console.warn(`reel: ${name} sign-in failed:`, (err as Error).message);
    return c.redirect("/sign-in?error=oauth");
  }
  const linked = await deps.db
    .selectFrom("oauthAccounts")
    .select("userId")
    .where("provider", "=", name)
    .where("providerUserId", "=", profile.providerUserId)
    .executeTakeFirst();
  let userId = linked?.userId;
  if (!userId) {
    // Both providers return only verified emails here, so linking by email is safe.
    userId = (await findOrCreateUser(deps.db, profile)).id;
    await deps.db
      .insertInto("oauthAccounts")
      .values({ provider: name, providerUserId: profile.providerUserId, userId })
      .onConflict((oc) => oc.columns(["provider", "providerUserId"]).doNothing())
      .execute();
  }
  await createSession(c, userId);
  return c.redirect(next);
});

authRoutes.post("/sign-out", async (c) => {
  await destroySession(c);
  if (isForm(c)) return c.redirect("/");
  return c.json({ ok: true });
});

const name = z.string().trim().min(1).max(80);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A path id that must be a uuid (anything else can't exist, so it's a 404 rather than a DB error). */
function idParam(c: Ctx, key: string): string {
  const v = c.req.param(key) ?? "";
  if (!UUID.test(v)) throw notFound();
  return v;
}

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.use("*", async (c, next) => {
  requireUser(c);
  await next();
});

accountRoutes.get("/", async (c) => c.json(await accountState(c)));

accountRoutes.post("/switch", async (c) => {
  const b = z.object({ workspaceId: z.string().max(100) }).parse(await c.req.json());
  await switchWorkspace(c, b.workspaceId);
  return c.json({ ok: true, workspaceId: b.workspaceId });
});

accountRoutes.post("/workspaces", async (c) => {
  const b = z.object({ name }).parse(await c.req.json());
  const workspaceId = await createWorkspace(c, b.name);
  return c.json({ workspaceId }, 201);
});

accountRoutes.patch("/workspace", async (c) => {
  const b = z.object({ name }).parse(await c.req.json());
  await renameWorkspace(c, b.name);
  return c.json({ ok: true });
});

accountRoutes.get("/invites", async (c) => c.json(await pendingInvites(c)));

accountRoutes.post("/invites", async (c) => {
  const user = requireUser(c);
  const b = z.object({ email: emailField }).parse(await c.req.json());
  rateLimit(c, "invite", `invite:${user.id}`);
  const inv = await createInvite(c, b.email);
  return c.json({ id: inv.id }, 201);
});

accountRoutes.delete("/invites/:id", async (c) => {
  await revokeInvite(c, idParam(c, "id"));
  return c.json({ ok: true });
});

accountRoutes.post("/invites/accept", async (c) => {
  const b = z.object({ token: z.string().min(10).max(200) }).parse(await c.req.json());
  return c.json(await acceptInvite(c, b.token));
});

accountRoutes.delete("/members/:userId", async (c) => c.json(await removeMember(c, idParam(c, "userId"))));

accountRoutes.patch("/members/:userId", async (c) => {
  const b = z.object({ role: z.enum(["owner", "member"]) }).parse(await c.req.json());
  await setRole(c, idParam(c, "userId"), b.role);
  return c.json({ ok: true });
});
