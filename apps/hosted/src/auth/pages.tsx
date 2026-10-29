/** @jsxImportSource hono/jsx */
/** Sign-in and invite pages, plus the account and billing pages. Mount at "/". */
import { Hono } from "hono";
import { accountPages } from "../account/pages";
import { render } from "../account/render";
import { inviteByToken } from "../account/service";
import type { AppEnv } from "../context";
import { safeNext } from "./util";

const ERRORS: Record<string, string> = {
  link: "That sign-in link is used or expired. Ask for a new one.",
  oauth: "That sign-in didn't work. Try again, or use an email link.",
  rate: "Too many attempts. Wait a few minutes and try again.",
  email: "Enter a valid email address.",
};

export const authPages = new Hono<AppEnv>();

authPages.get("/sign-in", (c) => {
  const deps = c.get("deps");
  const next = safeNext(c.req.query("next"), deps.config.APP_URL);
  if (c.get("user")) return c.redirect(next);
  const err = ERRORS[c.req.query("error") ?? ""];
  const sent = c.req.query("sent") === "1";
  const q = `?next=${encodeURIComponent(next)}`;
  return render(
    c,
    "Sign in",
    <div class="narrow stack">
      <h1>Sign in</h1>
      <p class="muted">New here? Signing in creates your account.</p>
      {err ? <p class="notice">{err}</p> : null}
      <div id="sent" class="notice" hidden={!sent}>
        Check your email for a sign-in link. It works once, for 15 minutes.
      </div>
      <form class="card stack" method="post" action="/auth/email" id="email-form">
        <div>
          <label for="email">Email</label>
          <input
            id="email"
            type="email"
            name="email"
            required
            maxlength={254}
            autocomplete="email"
            placeholder="you@example.com"
            style="width:100%"
          />
        </div>
        <input type="hidden" name="next" value={next} />
        <button type="submit">Email me a sign-in link</button>
        <p class="err" data-error="" />
      </form>
      {deps.config.googleEnabled || deps.config.githubEnabled ? (
        <div class="stack">
          {deps.config.googleEnabled ? (
            <a class="button secondary" style="display:block;text-align:center" href={`/auth/oauth/google${q}`}>
              Continue with Google
            </a>
          ) : null}
          {deps.config.githubEnabled ? (
            <a class="button secondary" style="display:block;text-align:center" href={`/auth/oauth/github${q}`}>
              Continue with GitHub
            </a>
          ) : null}
        </div>
      ) : null}
      <p class="muted small">
        By signing in you agree to the <a href="/terms">terms</a> and <a href="/aup">acceptable use policy</a>.
      </p>
      <script
        dangerouslySetInnerHTML={{
          __html: `
const f = document.getElementById("email-form");
f.addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = f.querySelector("[data-error]"); out.textContent = "";
  const btn = f.querySelector("button"); btn.disabled = true;
  try {
    const res = await fetch("/auth/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: f.email.value, next: f.next.value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    document.getElementById("sent").hidden = false;
    f.hidden = true;
  } catch (err) { out.textContent = err.message; btn.disabled = false; }
});`,
        }}
      />
    </div>,
  );
});

authPages.get("/invite/:token", async (c) => {
  const deps = c.get("deps");
  const token = c.req.param("token");
  const inv = token.length >= 10 && token.length <= 200 ? await inviteByToken(deps.db, token) : undefined;
  if (!inv || inv.acceptedAt || new Date(inv.expiresAt) <= new Date()) {
    return render(
      c,
      "Invite",
      <div class="narrow stack">
        <h1>This invite doesn't work</h1>
        <p class="muted">It's used, expired or doesn't exist. Ask for a new one.</p>
      </div>,
      404,
    );
  }
  const user = c.get("user");
  if (!user) {
    return render(
      c,
      "Invite",
      <div class="narrow stack">
        <h1>Join {inv.workspaceName}</h1>
        <p>
          Sign in as <strong>{inv.email}</strong> to join. Members are free.
        </p>
        <a class="button" href={`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`}>
          Sign in to join
        </a>
      </div>,
    );
  }
  if (user.email.toLowerCase() !== inv.email.toLowerCase()) {
    return render(
      c,
      "Invite",
      <div class="narrow stack">
        <h1>Join {inv.workspaceName}</h1>
        <p class="notice">
          This invite is for <strong>{inv.email}</strong>, but you're signed in as <strong>{user.email}</strong>.
        </p>
        <form class="row" method="post" action="/auth/sign-out">
          <button class="secondary" type="submit">
            Sign out
          </button>
        </form>
        <p class="muted small">Then open the invite link again and sign in with {inv.email}.</p>
      </div>,
      403,
    );
  }
  return render(
    c,
    "Invite",
    <div class="narrow stack">
      <h1>Join {inv.workspaceName}</h1>
      <p>You'll share its projects and balance with the other members. Members are free.</p>
      <form class="row" data-api="/api/account/invites/accept" data-next="/studio/">
        <input type="hidden" name="token" value={token} />
        <button type="submit">Join</button>
        <p class="err" data-error="" />
      </form>
    </div>,
  );
});

authPages.route("/", accountPages);
