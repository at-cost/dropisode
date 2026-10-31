/**
 * Sign-in (email + password, email link, Google, GitHub) and the account API.
 * Ported from at-cost/glasstrack's auth routes (MIT).
 *
 * An account exists only once its email is proved: a sign-up keeps its password
 * hash on the emailed confirmation link, and the account is created when that
 * link is used. Email links and OAuth both prove the address, so findOrCreateUser
 * marks it verified. Nobody can hold an unconfirmed account for someone else's
 * email (which would otherwise match admin emails or pending invites).
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
import { HttpError, notFound } from "../lib/errors";
import { newToken, sha256 } from "../lib/ids";
import { hashPassword, passwordField, verifyPassword } from "./password";
import { createSession, destroySession, requireUser } from "./session";
import { findOrCreateUser } from "./users";
import { clientIp, emailField, rateLimit, refundAttempt, safeNext } from "./util";
import { switchWorkspace } from "./workspace";

import { verifyPage } from "./pages";

export { authPages } from "./pages";

const LINK_MINUTES = 15;
const SIGNUP_HOURS = 24;
const RESET_MINUTES = 30;
const OAUTH_COOKIES = ["reel_oauth_state", "reel_oauth_verifier", "reel_oauth_next"] as const;
/** Set in the browser that signs up; the sign-up's password applies only when confirmed in that browser. */
const SIGNUP_COOKIE = "reel_signup";

/** Sends an email without making the request wait for it (so response time doesn't reveal which branch ran). */
function sendLater(deps: Deps, msg: Parameters<Deps["mailer"]["send"]>[0]): void {
  Promise.resolve()
    .then(() => deps.mailer.send(msg))
    .catch((err) => console.error(`reel: "${msg.subject}" email failed:`, (err as Error).message));
}

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
    rateLimit(c, "email", `link:${email}`);
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
authRoutes.get("/verify", async (c) => {
  const token = (c.req.query("token") ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (token.length < 10 || token.length > 200) return c.redirect("/sign-in?error=link");
  const link = await c
    .get("deps")
    .db.selectFrom("loginTokens")
    .select(["email", "purpose"])
    .where("tokenHash", "=", sha256(token))
    .where("purpose", "in", ["signin", "signup"])
    .where("usedAt", "is", null)
    .where("expiresAt", ">", new Date())
    .executeTakeFirst();
  if (!link) return c.redirect(await deadLink(c.get("deps"), token));
  return verifyPage(c, token, link);
});

/** Where a used or expired link goes: a sign-up already confirmed (often by a mail scanner or a second click) says so. */
async function deadLink(deps: Deps, token: string): Promise<string> {
  const used = await deps.db
    .selectFrom("loginTokens")
    .select("email")
    .where("tokenHash", "=", sha256(token))
    .where("purpose", "=", "signup")
    .executeTakeFirst();
  const u = used ? await liveUser(deps, used.email) : undefined;
  // Confirmed without the sign-up's password (e.g. a scanner ran the page): they choose one by email.
  if (u) return u.passwordHash ? "/sign-in?error=confirmed" : "/forgot?error=setpassword";
  return "/sign-in?error=link";
}

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
    .where("purpose", "in", ["signin", "signup"])
    .where("usedAt", "is", null)
    .where("expiresAt", ">", new Date())
    .returning(["email", "redirect", "purpose", "passwordHash", "name", "browserHash"])
    .executeTakeFirst();
  if (!link) return c.redirect(await deadLink(deps, token));
  const u = await findOrCreateUser(deps.db, { email: link.email, name: link.name });
  await createSession(c, u.id);
  const next = safeNext(link.redirect, deps.config.APP_URL);
  if (link.purpose !== "signup") return c.redirect(next);

  // Any other pending sign-ups for this email (possibly someone else's) stop working.
  await deps.db
    .updateTable("loginTokens")
    .set({ usedAt: new Date() })
    .where("email", "=", link.email)
    .where("purpose", "=", "signup")
    .where("usedAt", "is", null)
    .execute();
  deleteCookie(c, SIGNUP_COOKIE, { path: "/auth", secure: deps.config.secureCookies });
  // The password chosen at sign-up applies only in the browser that chose it, and never
  // replaces an existing password. Otherwise someone who signed up with your email
  // would know the password of the account you just confirmed.
  const nonce = getCookie(c, SIGNUP_COOKIE);
  const sameBrowser = !!nonce && !!link.browserHash && sha256(nonce) === link.browserHash;
  const current = await deps.db.selectFrom("users").select("passwordHash").where("id", "=", u.id).executeTakeFirstOrThrow();
  if (current.passwordHash) return c.redirect(`/verified?next=${encodeURIComponent(next)}`);
  if (sameBrowser && link.passwordHash) {
    await deps.db.updateTable("users").set({ passwordHash: link.passwordHash }).where("id", "=", u.id).execute();
    return c.redirect(`/verified?next=${encodeURIComponent(next)}`);
  }
  // Confirmed somewhere else: the email is proved, so let them choose a password now.
  const reset = newToken();
  await deps.db
    .insertInto("loginTokens")
    .values({
      tokenHash: sha256(reset),
      email: link.email,
      redirect: null,
      purpose: "reset",
      expiresAt: new Date(Date.now() + RESET_MINUTES * 60_000),
    })
    .execute();
  return c.redirect(`/reset?token=${encodeURIComponent(reset)}&new=1`);
});

const ERR_LOCKED = "Too many attempts for this account. Wait 15 minutes, or reset your password to get in now.";
const ERR_PASSWORD = "Wrong email or password. If you joined with Google or an email link, use that, or reset your password.";
const base = (deps: Deps) => deps.config.APP_URL.replace(/\/$/, "");
const liveUser = (deps: Deps, email: string) =>
  deps.db.selectFrom("users").select(["id", "passwordHash"]).where("email", "=", email).where("deletedAt", "is", null).executeTakeFirst();

/** Answers a form post with a redirect, or JSON for the page's script. */
function reply(c: Ctx, json: Record<string, unknown>, status: 200 | 400, formTo: string) {
  if (isForm(c)) return c.redirect(formTo);
  return c.json(json, status);
}

function limited(c: Ctx, checks: [Parameters<typeof rateLimit>[1], string][], formTo: string): Response | null {
  try {
    for (const [which, key] of checks) rateLimit(c, which, key);
    return null;
  } catch (err) {
    if (isForm(c)) return c.redirect(formTo);
    throw err;
  }
}

authRoutes.post("/sign-up", async (c) => {
  const deps = c.get("deps");
  const parsed = z
    .object({
      email: emailField,
      password: passwordField,
      name: z.string().trim().max(80).optional(),
      next: z.string().max(500).optional(),
    })
    .safeParse(await readBody(c));
  if (!parsed.success) {
    const msg = parsed.error.issues.find((i) => i.path[0] === "password")?.message ?? "Enter a valid email address";
    return reply(c, { error: msg }, 400, "/sign-up?error=input");
  }
  const { email, password } = parsed.data;
  const stop = limited(
    c,
    [
      ["ip", `ip:${clientIp(c)}`],
      ["email", `signup:${email}`],
    ],
    "/sign-up?error=rate",
  );
  if (stop) return stop;
  const next = safeNext(parsed.data.next, deps.config.APP_URL);
  // Same answer, and the same work, whether or not the account exists, so the form
  // can't be used to find out who has one.
  const passwordHash = await hashPassword(password);
  // Every sign-up gets a fresh browser cookie, whether or not it's used.
  const nonce = newToken();
  setCookie(c, SIGNUP_COOKIE, nonce, {
    httpOnly: true,
    secure: deps.config.secureCookies,
    sameSite: "Lax",
    path: "/auth",
    maxAge: SIGNUP_HOURS * 3600,
  });
  if (await liveUser(deps, email)) {
    sendLater(deps, {
      to: email,
      subject: "You already have a Dropisode account",
      text: `Someone (hopefully you) tried to sign up to Dropisode with this email, but it already has an account.

Sign in: ${base(deps)}/sign-in
Forgot your password? ${base(deps)}/forgot

If it wasn't you, ignore this email. Nothing has changed.`,
    });
  } else {
    const token = newToken();
    await deps.db
      .insertInto("loginTokens")
      .values({
        tokenHash: sha256(token),
        email,
        redirect: next,
        purpose: "signup",
        passwordHash,
        name: parsed.data.name || null,
        browserHash: sha256(nonce),
        expiresAt: new Date(Date.now() + SIGNUP_HOURS * 3_600_000),
      })
      .execute();
    sendLater(deps, {
      to: email,
      subject: "Confirm your Dropisode account",
      text: `Confirm your email to finish creating your Dropisode account: ${base(deps)}/auth/verify?token=${encodeURIComponent(token)}

The link works once and expires in ${SIGNUP_HOURS} hours.
If you didn't sign up, ignore this email and no account is created.`,
    });
  }
  return reply(c, { ok: true }, 200, "/sign-up?sent=1");
});

authRoutes.post("/sign-in", async (c) => {
  const deps = c.get("deps");
  const parsed = z
    .object({ email: emailField, password: z.string().min(1).max(200), next: z.string().max(500).optional() })
    .safeParse(await readBody(c));
  if (!parsed.success) return reply(c, { error: "Enter your email and password" }, 400, "/sign-in?error=password");
  const { email, password } = parsed.data;
  // Attempts are counted as they arrive (so a burst of parallel guesses can't slip past
  // the limits) and given back when the password is right, so only wrong guesses add up.
  const perIp = `pw:${email}|${clientIp(c)}`;
  // Which check is running, so a refusal can say whether the account or the network hit its limit.
  let stage: "ip" | "password" | "account" = "ip";
  try {
    rateLimit(c, "ip", `ip:${clientIp(c)}`);
    stage = "password";
    rateLimit(c, "password", perIp);
    stage = "account";
    rateLimit(c, "passwordAccount", `pw:${email}`);
  } catch (err) {
    if (stage === "account") refundAttempt(c, "password", perIp);
    // Only the account's own limits suggest a reset; the per-IP limit also covers /forgot.
    if (isForm(c)) return c.redirect(stage === "ip" ? "/sign-in?error=rate" : "/sign-in?error=locked");
    if (stage === "ip") throw err;
    throw new HttpError(429, ERR_LOCKED);
  }
  const u = await liveUser(deps, email);
  if (!(await verifyPassword(password, u?.passwordHash)) || !u) return reply(c, { error: ERR_PASSWORD }, 400, "/sign-in?error=password");
  refundAttempt(c, "password", perIp);
  refundAttempt(c, "passwordAccount", `pw:${email}`);
  await createSession(c, u.id);
  const next = safeNext(parsed.data.next, deps.config.APP_URL);
  if (isForm(c)) return c.redirect(next);
  return c.json({ ok: true, next });
});

authRoutes.post("/forgot", async (c) => {
  const deps = c.get("deps");
  const parsed = z.object({ email: emailField }).safeParse(await readBody(c));
  if (!parsed.success) return reply(c, { error: "Enter a valid email address" }, 400, "/forgot?error=email");
  const { email } = parsed.data;
  const stop = limited(
    c,
    [
      ["ip", `ip:${clientIp(c)}`],
      ["email", `forgot:${email}`],
    ],
    "/forgot?error=rate",
  );
  if (stop) return stop;
  // Same answer whether or not the account exists.
  if (await liveUser(deps, email)) {
    const token = newToken();
    await deps.db
      .insertInto("loginTokens")
      .values({
        tokenHash: sha256(token),
        email,
        redirect: null,
        purpose: "reset",
        expiresAt: new Date(Date.now() + RESET_MINUTES * 60_000),
      })
      .execute();
    sendLater(deps, {
      to: email,
      subject: "Reset your Dropisode password",
      text: `Choose a new password: ${base(deps)}/reset?token=${encodeURIComponent(token)}

The link works once and expires in ${RESET_MINUTES} minutes.
If you didn't ask for it, ignore this email. Your password hasn't changed.`,
    });
  }
  return reply(c, { ok: true }, 200, "/forgot?sent=1");
});

authRoutes.post("/reset", async (c) => {
  const deps = c.get("deps");
  const parsed = z.object({ token: z.string().min(10).max(200), password: passwordField }).safeParse(await readBody(c));
  if (!parsed.success) {
    const raw = await readBody(c).catch(() => ({}) as Record<string, unknown>);
    const tok = typeof raw.token === "string" ? raw.token.replace(/[^A-Za-z0-9_-]/g, "") : "";
    const msg = parsed.error.issues.find((i) => i.path[0] === "password")?.message ?? "That reset link doesn't work";
    return reply(c, { error: msg }, 400, tok ? `/reset?token=${encodeURIComponent(tok)}&error=newpassword` : "/forgot?error=link");
  }
  const stop = limited(c, [["verify", `verify:${clientIp(c)}`]], "/sign-in?error=rate");
  if (stop) return stop;
  const passwordHash = await hashPassword(parsed.data.password);
  const userId = await deps.db.transaction().execute(async (tx) => {
    const link = await tx
      .updateTable("loginTokens")
      .set({ usedAt: new Date() })
      .where("tokenHash", "=", sha256(parsed.data.token))
      .where("purpose", "=", "reset")
      .where("usedAt", "is", null)
      .where("expiresAt", ">", new Date())
      .returning("email")
      .executeTakeFirst();
    if (!link) return null;
    const u = await tx.selectFrom("users").select("id").where("email", "=", link.email).where("deletedAt", "is", null).executeTakeFirst();
    if (!u) return null;
    await tx.updateTable("users").set({ passwordHash, emailVerifiedAt: new Date() }).where("id", "=", u.id).execute();
    // A new password signs out every other device and voids every other emailed link.
    await tx.deleteFrom("sessions").where("userId", "=", u.id).execute();
    await tx.updateTable("loginTokens").set({ usedAt: new Date() }).where("email", "=", link.email).where("usedAt", "is", null).execute();
    return u.id;
  });
  if (!userId) return reply(c, { error: "That reset link is used or expired. Ask for a new one." }, 400, "/forgot?error=link");
  await createSession(c, userId);
  if (isForm(c)) return c.redirect("/studio/");
  return c.json({ ok: true, next: "/studio/" });
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
