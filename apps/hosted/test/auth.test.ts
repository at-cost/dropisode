import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authPages } from "../src/auth/routes";
import { sessionMiddleware } from "../src/auth/session";
import { safeNext } from "../src/auth/util";
import type { AppEnv } from "../src/context";
import { type TestApp, testApp } from "./harness";

let t: TestApp;
beforeEach(async () => {
  t = await testApp();
});
afterEach(async () => {
  await t.close();
});

/** Merges a response's Set-Cookie values into a Cookie header. */
function withCookies(cookie: string, res: Response): string {
  const jar = new Map(
    cookie
      .split("; ")
      .filter(Boolean)
      .map((p) => [p.split("=")[0]!, p] as const),
  );
  for (const sc of res.headers.getSetCookie()) {
    const pair = sc.split(";")[0]!;
    jar.set(pair.split("=")[0]!, pair);
  }
  return [...jar.values()].join("; ");
}

const lastMailTo = (to: string) => [...(t.deps.mailer.sent ?? [])].reverse().find((m) => m.to === to);
/** Opens the emailed link (the confirm page) and presses Continue. */
async function follow(url: URL, cookie?: string): Promise<Response> {
  const page = await t.request("GET", `${url.pathname}${url.search}`, { cookie });
  if (page.status !== 200) return page;
  const token = url.searchParams.get("token") ?? "";
  return t.request("POST", "/auth/verify", {
    cookie,
    body: `token=${encodeURIComponent(token)}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

const linkIn = (text: string, path: string) => {
  const m = text.match(new RegExp(`https?://[^\\s]+${path}[^\\s]+`));
  if (!m) throw new Error(`no ${path} link in: ${text}`);
  return new URL(m[0]);
};

async function emailSignIn(email: string, next?: string): Promise<Response> {
  const res = await t.request("POST", "/auth/email", { body: { email, next } });
  expect(res.status).toBe(200);
  const url = linkIn(lastMailTo(email.toLowerCase())!.text, "/auth/verify");
  return follow(url);
}

/** Serves the page router the way app.ts will (deps + session first). */
function pages() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", t.deps);
    await next();
  });
  app.use("*", sessionMiddleware);
  app.route("/", authPages);
  return (path: string, cookie?: string) =>
    app.fetch(new Request(`${t.deps.config.APP_URL}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" }));
}

async function invite(owner: string, email: string): Promise<string> {
  const res = await t.request("POST", "/api/account/invites", { cookie: owner, body: { email } });
  expect(res.status).toBe(201);
  return linkIn(lastMailTo(email)!.text, "/invite/").pathname.split("/").pop()!;
}

describe("email link sign-in", () => {
  it("signs in end to end and the link works once", async () => {
    const res = await emailSignIn("New.Person@Reel.test", "/account");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/account");
    const cookie = withCookies("", res);
    const me = (await (await t.request("GET", "/api/account", { cookie })).json()) as {
      user: { email: string };
      memberships: { role: string }[];
    };
    expect(me.user.email).toBe("new.person@reel.test");
    expect(me.memberships).toHaveLength(1);
    expect(me.memberships[0]!.role).toBe("owner");
    const u = await t.deps.db
      .selectFrom("users")
      .select("emailVerifiedAt")
      .where("email", "=", "new.person@reel.test")
      .executeTakeFirstOrThrow();
    expect(u.emailVerifiedAt).not.toBeNull();

    // The token is stored hashed and is single use.
    const url = linkIn(lastMailTo("new.person@reel.test")!.text, "/auth/verify");
    const raw = url.searchParams.get("token")!;
    const rows = await t.deps.db.selectFrom("loginTokens").select("tokenHash").execute();
    expect(rows.some((r) => r.tokenHash === raw)).toBe(false);
    const again = await follow(url);
    expect(again.headers.get("location")).toBe("/sign-in?error=link");
  });

  it("defaults to the studio and refuses expired or bogus tokens", async () => {
    const res = await emailSignIn("a@reel.test");
    expect(res.headers.get("location")).toBe("/studio/");
    expect((await follow(new URL("http://x/auth/verify?token=not-a-real-token-at-all"))).headers.get("location")).toBe(
      "/sign-in?error=link",
    );
    await t.request("POST", "/auth/email", { body: { email: "b@reel.test" } });
    await t.deps.db
      .updateTable("loginTokens")
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where("email", "=", "b@reel.test")
      .execute();
    const url = linkIn(lastMailTo("b@reel.test")!.text, "/auth/verify");
    expect((await follow(url)).headers.get("location")).toBe("/sign-in?error=link");
  });

  it("rejects bad emails and rate-limits per email", async () => {
    expect((await t.request("POST", "/auth/email", { body: { email: "nope" } })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await t.request("POST", "/auth/email", { body: { email: "spam@reel.test" } })).status).toBe(200);
    expect((await t.request("POST", "/auth/email", { body: { email: "spam@reel.test" } })).status).toBe(429);
  });

  it("signs out", async () => {
    const cookie = await t.signIn("a@reel.test");
    expect((await t.request("POST", "/auth/sign-out", { cookie })).status).toBe(200);
    expect((await t.request("GET", "/api/account", { cookie })).status).toBe(401);
  });
});

describe("next= open-redirect protection", () => {
  const evil = [
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "/\tevil",
    "evil.example/path",
    "",
  ];
  it("safeNext keeps only same-site paths", () => {
    for (const n of evil) expect(safeNext(n, "http://localhost:3299")).toBe("/studio/");
    expect(safeNext("/", "http://localhost:3299")).toBe("/studio/");
    expect(safeNext("/billing?paid=1", "http://localhost:3299")).toBe("/billing?paid=1");
    expect(safeNext("/invite/abc", "http://localhost:3299")).toBe("/invite/abc");
  });
  it("the email link never redirects off-site", async () => {
    for (const [i, n] of ["https://evil.example/x", "//evil.example", "/\\evil.example"].entries()) {
      const res = await emailSignIn(`r${i}@reel.test`, n);
      expect(res.headers.get("location")).toBe("/studio/");
    }
  });
  it("the sign-in page sanitises next", async () => {
    const get = pages();
    const html = await (await get("/sign-in?next=%2F%2Fevil.example")).text();
    expect(html).not.toContain("evil.example");
    expect(html).toContain('value="/studio/"');
    const cookie = await t.signIn("a@reel.test");
    expect((await get("/sign-in?next=https%3A%2F%2Fevil.example", cookie)).headers.get("location")).toBe("/studio/");
  });
});

describe("workspaces and invites", () => {
  it("an invited user joins and both see the same projects", async () => {
    const a = await t.signIn("a@reel.test");
    let b = await t.signIn("b@reel.test");
    const created = await t.request("POST", "/api/projects", { cookie: a, body: { name: "Shared film" } });
    expect(created.status).toBe(201);
    const before = (await (await t.request("GET", "/api/projects", { cookie: b })).json()) as { name: string }[];
    expect(before.map((p) => p.name)).not.toContain("Shared film");

    const token = await invite(a, "b@reel.test");
    const pending = (await (await t.request("GET", "/api/account/invites", { cookie: a })).json()) as { email: string }[];
    expect(pending.map((p) => p.email)).toEqual(["b@reel.test"]);

    // The invite page asks a signed-out visitor to sign in first.
    const get = pages();
    expect(await (await get(`/invite/${token}`)).text()).toContain(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`);

    // Someone else can't use it.
    const c = await t.signIn("c@reel.test");
    expect((await t.request("POST", "/api/account/invites/accept", { cookie: c, body: { token } })).status).toBe(403);

    const accepted = await t.request("POST", "/api/account/invites/accept", { cookie: b, body: { token } });
    expect(accepted.status).toBe(200);
    b = withCookies(b, accepted);
    const after = (await (await t.request("GET", "/api/projects", { cookie: b })).json()) as { name: string }[];
    expect(after.map((p) => p.name)).toContain("Shared film");
    expect(await t.workspaceOf(b)).toBe(await t.workspaceOf(a));

    // Used once only.
    expect((await t.request("POST", "/api/account/invites/accept", { cookie: b, body: { token } })).status).toBe(404);
    const state = (await (await t.request("GET", "/api/account", { cookie: a })).json()) as { members: { email: string; role: string }[] };
    expect(state.members.map((m) => [m.email, m.role])).toEqual([
      ["a@reel.test", "owner"],
      ["b@reel.test", "member"],
    ]);
  });

  it("non-owners can't invite, rename or remove others", async () => {
    const a = await t.signIn("a@reel.test");
    let b = await t.signIn("b@reel.test");
    const token = await invite(a, "b@reel.test");
    b = withCookies(b, await t.request("POST", "/api/account/invites/accept", { cookie: b, body: { token } }));
    const aId = ((await (await t.request("GET", "/api/account", { cookie: a })).json()) as { user: { id: string } }).user.id;
    expect((await t.request("POST", "/api/account/invites", { cookie: b, body: { email: "x@reel.test" } })).status).toBe(403);
    expect((await t.request("GET", "/api/account/invites", { cookie: b })).status).toBe(403);
    expect((await t.request("PATCH", "/api/account/workspace", { cookie: b, body: { name: "Mine now" } })).status).toBe(403);
    expect((await t.request("DELETE", `/api/account/members/${aId}`, { cookie: b })).status).toBe(403);
    expect((await t.request("PATCH", `/api/account/members/${aId}`, { cookie: b, body: { role: "member" } })).status).toBe(403);
    expect((await t.request("PATCH", "/api/account/workspace", { cookie: a, body: { name: "Team" } })).status).toBe(200);
  });

  it("the last owner can't leave; a member can", async () => {
    const a = await t.signIn("a@reel.test");
    let b = await t.signIn("b@reel.test");
    const token = await invite(a, "b@reel.test");
    b = withCookies(b, await t.request("POST", "/api/account/invites/accept", { cookie: b, body: { token } }));
    const ids = (await (await t.request("GET", "/api/account", { cookie: a })).json()) as {
      user: { id: string };
      members: { userId: string; email: string }[];
    };
    const aId = ids.user.id;
    const bId = ids.members.find((m) => m.email === "b@reel.test")!.userId;

    const leave = await t.request("DELETE", `/api/account/members/${aId}`, { cookie: a });
    expect(leave.status).toBe(400);
    expect((await t.request("PATCH", `/api/account/members/${aId}`, { cookie: a, body: { role: "member" } })).status).toBe(400);

    expect((await t.request("DELETE", `/api/account/members/${bId}`, { cookie: b })).status).toBe(200);
    expect((await t.request("DELETE", `/api/account/members/${bId}`, { cookie: a })).status).toBe(404);
    expect((await t.request("DELETE", "/api/account/members/not-a-uuid", { cookie: a })).status).toBe(404);
  });

  it("can't switch into a workspace you're not in", async () => {
    const a = await t.signIn("a@reel.test");
    const c = await t.signIn("c@reel.test");
    const cWs = await t.workspaceOf(c);
    await t.request("POST", "/api/projects", { cookie: c, body: { name: "C's secret" } });
    expect((await t.request("POST", "/api/account/switch", { cookie: a, body: { workspaceId: cWs } })).status).toBe(404);
    // A forged workspace cookie falls back to A's own workspace.
    const forged = `${a}; reel_ws=${cWs}`;
    expect(await t.workspaceOf(forged)).not.toBe(cWs);
    const list = (await (await t.request("GET", "/api/projects", { cookie: forged })).json()) as { name: string }[];
    expect(list.map((p) => p.name)).not.toContain("C's secret");
  });

  it("creates another workspace and switches between them", async () => {
    let a = await t.signIn("a@reel.test");
    const first = await t.workspaceOf(a);
    const res = await t.request("POST", "/api/account/workspaces", { cookie: a, body: { name: "Second" } });
    expect(res.status).toBe(201);
    a = withCookies(a, res);
    const { workspaceId } = (await res.json()) as { workspaceId: string };
    expect(await t.workspaceOf(a)).toBe(workspaceId);
    a = withCookies(a, await t.request("POST", "/api/account/switch", { cookie: a, body: { workspaceId: first } }));
    expect(await t.workspaceOf(a)).toBe(first);
  });
});

describe("pages", () => {
  it("render for a signed-in user and redirect otherwise", async () => {
    const get = pages();
    expect((await get("/account")).headers.get("location")).toBe("/sign-in?next=%2Faccount");
    expect((await get("/billing?paid=1")).headers.get("location")).toBe(`/sign-in?next=${encodeURIComponent("/billing?paid=1")}`);
    const signIn = await (await get("/sign-in")).text();
    expect(signIn).toContain("Forgot your password?");
    expect(signIn).toContain('href="/sign-up?next=%2Fstudio%2F"');
    expect(signIn).not.toContain("Continue with Google");
    const signUp = await (await get("/sign-up")).text();
    expect(signUp).toContain("Create account");
    expect(signUp).toContain('autocomplete="new-password"');
    expect(await (await get("/forgot")).text()).toContain("Email me a reset link");
    expect((await get("/reset?token=abcdefghijkl")).headers.get("location")).toBe("/forgot?error=link");
    expect((await get("/reset?token=x")).headers.get("location")).toBe("/forgot?error=link");
    const a = await t.signIn("a@reel.test");
    await t.fund(await t.workspaceOf(a), 25);
    const account = await (await get("/account", a)).text();
    expect(account).toContain("Members are free");
    expect(account).toContain("Send invite");
    const billing = await (await get("/billing?paid=1", a)).text();
    expect(billing).toContain("$25.00");
    expect(billing).toContain("Payment received; it appears here within a minute.");
    expect(billing).toContain("Credit never expires.");
    expect(billing).toContain("test credit");
    for (const html of [signIn, account, billing]) expect(html).not.toContain("\u2014");
  });
});

describe("email and password accounts", () => {
  const PW = "correct horse battery";
  const signUp = (email: string, password = PW, next?: string) => t.request("POST", "/auth/sign-up", { body: { email, password, next } });
  const signInPw = (email: string, password: string, ip = "203.0.113.1") =>
    t.request("POST", "/auth/sign-in", { body: { email, password }, headers: { "x-forwarded-for": ip } });
  /** Signs up and confirms in the same browser (with the sign-up cookie). */
  async function signUpAndConfirm(email: string, password = PW, next?: string): Promise<Response> {
    const browser = withCookies("", await signUp(email, password, next));
    return follow(linkIn(lastMailTo(email.toLowerCase())!.text, "/auth/verify"), browser);
  }
  const users = () => t.deps.db.selectFrom("users").select(["email", "passwordHash"]).execute();
  const sessionOk = async (cookie: string) => (await t.request("GET", "/api/account", { cookie })).status === 200;

  it("sign-up creates the account only when the email link is used, then the password works", async () => {
    const up = await signUp("New@Reel.test", PW, "/billing");
    expect(up.status).toBe(200);
    expect(await users()).toHaveLength(0);
    const mail = lastMailTo("new@reel.test")!;
    expect(mail.subject).toBe("Confirm your Dropisode account");
    const url = linkIn(mail.text, "/auth/verify");
    const page = await (await t.request("GET", `${url.pathname}${url.search}`)).text();
    expect(page).toContain("Create an account for <strong>new@reel.test</strong>");
    const res = await follow(url, withCookies("", up));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/billing");
    expect(await sessionOk(withCookies("", res))).toBe(true);
    const [u] = await users();
    expect(u!.email).toBe("new@reel.test");
    expect(u!.passwordHash).toMatch(/^scrypt\$/);
    expect(u!.passwordHash).not.toContain(PW);

    const ok = await signInPw("NEW@reel.test", PW);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { next: string }).next).toBe("/studio/");
    expect(await sessionOk(withCookies("", ok))).toBe(true);
    const bad = await signInPw("new@reel.test", "wrong password!!");
    expect(bad.status).toBe(400);
    expect(bad.headers.getSetCookie()).toHaveLength(0);
    expect((await signInPw("nobody@reel.test", PW)).status).toBe(400);
  });

  it("rejects short passwords", async () => {
    const res = await signUp("a@reel.test", "short");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("10 characters");
  });

  it("an unconfirmed sign-up for an admin email gets no session and no account", async () => {
    const admin = t.deps.config.adminEmails[0] ?? "admin@reel.test";
    const res = await signUp(admin);
    expect(res.headers.getSetCookie().filter((c) => c.includes("_session="))).toHaveLength(0);
    expect(await users()).toHaveLength(0);
    expect((await signInPw(admin, PW)).status).toBe(400);
  });

  it("signing up with an existing email answers the same, sends a notice and changes nothing", async () => {
    await t.signIn("have@reel.test");
    const res = await signUp("have@reel.test", "attacker password 1");
    expect(res.status).toBe(200);
    expect(lastMailTo("have@reel.test")!.subject).toBe("You already have a Dropisode account");
    const tokens = await t.deps.db.selectFrom("loginTokens").select("purpose").where("purpose", "=", "signup").execute();
    expect(tokens).toHaveLength(0);
    expect((await signInPw("have@reel.test", "attacker password 1")).status).toBe(400);
  });

  it("a link-only account has no password to guess", async () => {
    await t.signIn("link@reel.test");
    expect((await signInPw("link@reel.test", "")).status).toBe(400);
    expect((await signInPw("link@reel.test", "anything at all")).status).toBe(400);
  });

  it("password reset: new password works, old fails, other sessions end, link works once", async () => {
    await signUpAndConfirm("r@reel.test");
    const other = withCookies("", await signInPw("r@reel.test", PW));
    expect(await sessionOk(other)).toBe(true);

    expect((await t.request("POST", "/auth/forgot", { body: { email: "nobody@reel.test" } })).status).toBe(200);
    expect(lastMailTo("nobody@reel.test")).toBeUndefined();
    expect((await t.request("POST", "/auth/forgot", { body: { email: "r@reel.test" } })).status).toBe(200);
    const url = linkIn(lastMailTo("r@reel.test")!.text, "/reset");
    const token = url.searchParams.get("token")!;
    // A reset link can't be used as a sign-in link.
    expect((await follow(new URL(`${t.deps.config.APP_URL}/auth/verify?token=${token}`))).headers.get("location")).toBe(
      "/sign-in?error=link",
    );

    const res = await t.request("POST", "/auth/reset", { body: { token, password: "a brand new password" } });
    expect(res.status).toBe(200);
    expect(await sessionOk(withCookies("", res))).toBe(true);
    expect(await sessionOk(other)).toBe(false);
    expect((await signInPw("r@reel.test", PW)).status).toBe(400);
    expect((await signInPw("r@reel.test", "a brand new password")).status).toBe(200);
    expect((await t.request("POST", "/auth/reset", { body: { token, password: "another new password" } })).status).toBe(400);
  });

  it("a sign-in link can't be used to reset a password", async () => {
    await t.signIn("s@reel.test");
    await t.request("POST", "/auth/email", { body: { email: "s@reel.test" } });
    const token = linkIn(lastMailTo("s@reel.test")!.text, "/auth/verify").searchParams.get("token")!;
    expect((await t.request("POST", "/auth/reset", { body: { token, password: "a brand new password" } })).status).toBe(400);
  });

  it("limits wrong-password guesses per account", async () => {
    await signUpAndConfirm("g@reel.test");
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await signInPw("g@reel.test", `guess number ${i}`, "198.51.100.7")).status);
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true);
    expect(codes[10]).toBe(429);
    // Locked for the guessing IP even with the right password...
    expect((await signInPw("g@reel.test", PW, "198.51.100.7")).status).toBe(429);
    // ...but the owner elsewhere still gets in, and right passwords never count.
    for (let i = 0; i < 15; i++) expect((await signInPw("g@reel.test", PW)).status).toBe(200);
  });

  it("plain HTML forms work without JavaScript", async () => {
    const form = (path: string, body: string) =>
      t.request("POST", path, { body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect((await form("/auth/sign-up", "email=f%40reel.test&password=short")).headers.get("location")).toBe("/sign-up?error=input");
    const up = await form("/auth/sign-up", `email=f%40reel.test&password=${encodeURIComponent(PW)}`);
    expect(up.headers.get("location")).toBe("/sign-up?sent=1");
    await follow(linkIn(lastMailTo("f@reel.test")!.text, "/auth/verify"), withCookies("", up));
    expect((await form("/auth/sign-in", "email=f%40reel.test&password=nope")).headers.get("location")).toBe("/sign-in?error=password");
    const ok = await form("/auth/sign-in", `email=f%40reel.test&password=${encodeURIComponent(PW)}&next=%2Fbilling`);
    expect(ok.headers.get("location")).toBe("/billing");
  });
});

describe("sign-up takeover attempts", () => {
  const PW = "correct horse battery";
  const signInPw = (email: string, password: string) => t.request("POST", "/auth/sign-in", { body: { email, password } });

  it("a sign-up confirmed in another browser doesn't keep the password chosen at sign-up", async () => {
    // The attacker signs up with the victim's email in the attacker's browser.
    const attacker = withCookies(
      "",
      await t.request("POST", "/auth/sign-up", { body: { email: "victim@reel.test", password: "attacker password" } }),
    );
    expect(attacker).toContain("reel_signup=");
    // The victim clicks the email in their own browser.
    const res = await follow(linkIn(lastMailTo("victim@reel.test")!.text, "/auth/verify"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/reset\?token=[A-Za-z0-9_-]+&new=1$/);
    expect((await signInPw("victim@reel.test", "attacker password")).status).toBe(400);
    // The victim is signed in and can choose their own password.
    const victim = withCookies("", res);
    expect((await t.request("GET", "/api/account", { cookie: victim })).status).toBe(200);
    const token = new URL(res.headers.get("location")!, t.deps.config.APP_URL).searchParams.get("token")!;
    expect((await t.request("POST", "/auth/reset", { body: { token, password: "victim's own password" } })).status).toBe(200);
    expect((await signInPw("victim@reel.test", "victim's own password")).status).toBe(200);
  });

  it("confirming one sign-up voids the others, and never replaces an existing password", async () => {
    const mine = withCookies("", await t.request("POST", "/auth/sign-up", { body: { email: "v2@reel.test", password: PW } }));
    const myLink = linkIn(lastMailTo("v2@reel.test")!.text, "/auth/verify");
    const theirs = withCookies(
      "",
      await t.request("POST", "/auth/sign-up", { body: { email: "v2@reel.test", password: "attacker password" } }),
    );
    const theirLink = linkIn(lastMailTo("v2@reel.test")!.text, "/auth/verify");
    expect((await follow(myLink, mine)).headers.get("location")).toBe("/studio/");
    // Even in the attacker's own browser, their link is dead now.
    expect((await follow(theirLink, theirs)).headers.get("location")).toBe("/sign-in?error=link");
    expect((await signInPw("v2@reel.test", PW)).status).toBe(200);
    expect((await signInPw("v2@reel.test", "attacker password")).status).toBe(400);
  });

  it("a password reset voids every other emailed link", async () => {
    const browser = withCookies("", await t.request("POST", "/auth/sign-up", { body: { email: "v3@reel.test", password: PW } }));
    await follow(linkIn(lastMailTo("v3@reel.test")!.text, "/auth/verify"), browser);
    await t.request("POST", "/auth/email", { body: { email: "v3@reel.test" } });
    const signinLink = linkIn(lastMailTo("v3@reel.test")!.text, "/auth/verify");
    await t.request("POST", "/auth/forgot", { body: { email: "v3@reel.test" } });
    const token = linkIn(lastMailTo("v3@reel.test")!.text, "/reset").searchParams.get("token")!;
    expect((await t.request("POST", "/auth/reset", { body: { token, password: "a brand new password" } })).status).toBe(200);
    expect((await follow(signinLink)).headers.get("location")).toBe("/sign-in?error=link");
  });

  it("a too-short new password returns to the reset page with the link intact", async () => {
    const res = await t.request("POST", "/auth/reset", {
      body: "token=abcdefghijklmnop&password=short",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.headers.get("location")).toBe("/reset?token=abcdefghijklmnop&error=newpassword");
  });

  it("the sign-up reply is identical (cookie included) whether or not the account exists", async () => {
    await t.signIn("exists@reel.test");
    const a = await t.request("POST", "/auth/sign-up", { body: { email: "exists@reel.test", password: PW } });
    const b = await t.request("POST", "/auth/sign-up", { body: { email: "fresh@reel.test", password: PW } });
    const names = (r: Response) => r.headers.getSetCookie().map((c) => c.split("=")[0]);
    expect(names(a)).toEqual(names(b));
    expect(names(a)).toEqual(["reel_signup"]);
    expect(await a.text()).toBe(await b.text());
  });

  it("a burst of parallel guesses can't get past the per-account limit", async () => {
    const browser = withCookies("", await t.request("POST", "/auth/sign-up", { body: { email: "b@reel.test", password: PW } }));
    await follow(linkIn(lastMailTo("b@reel.test")!.text, "/auth/verify"), browser);
    const codes = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        t.request("POST", "/auth/sign-in", {
          body: { email: "b@reel.test", password: `guess ${i} xxxx` },
          headers: { "x-forwarded-for": "192.0.2.9" },
        }),
      ).map(async (r) => (await r).status),
    );
    expect(codes.filter((c) => c === 400).length).toBeLessThanOrEqual(10);
  });

  it("the choose-password page names the account", async () => {
    await t.request("POST", "/auth/sign-up", { body: { email: "named@reel.test", password: PW } });
    const res = await follow(linkIn(lastMailTo("named@reel.test")!.text, "/auth/verify"));
    const page = await (await t.request("GET", res.headers.get("location")!, { cookie: withCookies("", res) })).text();
    expect(page).toContain("Account: <strong>named@reel.test</strong>");
  });
});
