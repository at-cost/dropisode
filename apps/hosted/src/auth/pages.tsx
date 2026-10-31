/** @jsxImportSource hono/jsx */
/** Sign-in and invite pages, plus the account and billing pages. Mount at "/". */
import { Hono } from "hono";
import { accountPages } from "../account/pages";
import { render } from "../account/render";
import { inviteByToken } from "../account/service";
import type { AppEnv } from "../context";
import { safeNext } from "./util";

export const authPages = new Hono<AppEnv>();

const ERRORS: Record<string, string> = {
  link: "That link is used or expired. Ask for a new one.",
  oauth: "That sign-in didn't work. Try again, or use your email and password.",
  rate: "Too many attempts. Wait a few minutes and try again.",
  email: "Enter a valid email address.",
  input: "Enter a valid email address and a password of at least 10 characters.",
  password: "Wrong email or password.",
};

/** Posts a form as JSON; on success goes to data.next or shows the [data-done] block. */
const SUBMIT = `
for (const f of document.querySelectorAll("form[data-auth]")) {
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = f.querySelector("[data-error]"); out.textContent = "";
    const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(f));
      const res = await fetch(f.action, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
      if (data.next) { location.href = data.next; return; }
      const done = document.querySelector(f.dataset.auth);
      if (done) { done.hidden = false; f.hidden = true; }
    } catch (err) { out.textContent = err.message; btn.disabled = false; }
  });
}`;

const Field = (p: { id: string; label: string; type: string; auto: string; hint?: string; min?: number }) => (
  <div>
    <label for={p.id}>{p.label}</label>
    <input
      id={p.id}
      name={p.id}
      type={p.type}
      required
      minlength={p.min}
      maxlength={p.type === "email" ? 254 : 200}
      autocomplete={p.auto}
      style="width:100%"
    />
    {p.hint ? <p class="muted small">{p.hint}</p> : null}
  </div>
);

function Providers(p: { google: boolean; github: boolean; q: string }) {
  if (!p.google && !p.github) return null;
  return (
    <div class="stack">
      <p class="muted small" style="text-align:center">or</p>
      {p.google ? (
        <a class="button secondary" style="display:block;text-align:center" href={`/auth/oauth/google${p.q}`}>
          Continue with Google
        </a>
      ) : null}
      {p.github ? (
        <a class="button secondary" style="display:block;text-align:center" href={`/auth/oauth/github${p.q}`}>
          Continue with GitHub
        </a>
      ) : null}
    </div>
  );
}

const Script = () => <script dangerouslySetInnerHTML={{ __html: SUBMIT }} />;

authPages.get("/sign-in", (c) => {
  const deps = c.get("deps");
  const next = safeNext(c.req.query("next"), deps.config.APP_URL);
  if (c.get("user")) return c.redirect(next);
  const err = ERRORS[c.req.query("error") ?? ""];
  const q = `?next=${encodeURIComponent(next)}`;
  return render(
    c,
    "Sign in",
    <div class="narrow stack">
      <h1>Sign in</h1>
      <p class="muted">
        No account yet? <a href={`/sign-up${q}`}>Sign up</a>
      </p>
      {err ? <p class="notice">{err}</p> : null}
      <form class="card stack" method="post" action="/auth/sign-in" data-auth="">
        <Field id="email" label="Email" type="email" auto="email" />
        <Field id="password" label="Password" type="password" auto="current-password" />
        <input type="hidden" name="next" value={next} />
        <button type="submit">Sign in</button>
        <p class="err" data-error="" />
        <p class="small">
          <a href="/forgot">Forgot your password?</a>
        </p>
      </form>
      <Providers google={deps.config.googleEnabled} github={deps.config.githubEnabled} q={q} />
      <Script />
    </div>,
  );
});

authPages.get("/sign-up", (c) => {
  const deps = c.get("deps");
  const next = safeNext(c.req.query("next"), deps.config.APP_URL);
  if (c.get("user")) return c.redirect(next);
  const err = ERRORS[c.req.query("error") ?? ""];
  const sent = c.req.query("sent") === "1";
  const q = `?next=${encodeURIComponent(next)}`;
  return render(
    c,
    "Sign up",
    <div class="narrow stack">
      <h1>Create your account</h1>
      <p class="muted">
        Already have one? <a href={`/sign-in${q}`}>Sign in</a>
      </p>
      {err ? <p class="notice">{err}</p> : null}
      <div id="sent" class="notice" hidden={!sent}>
        Check your email and click the link to confirm your address. Your account is ready as soon as you do.
      </div>
      <form class="card stack" method="post" action="/auth/sign-up" data-auth="#sent" hidden={sent}>
        <Field id="email" label="Email" type="email" auto="email" />
        <Field id="password" label="Password" type="password" auto="new-password" min={10} hint="At least 10 characters." />
        <input type="hidden" name="next" value={next} />
        <button type="submit">Create account</button>
        <p class="err" data-error="" />
      </form>
      <Providers google={deps.config.googleEnabled} github={deps.config.githubEnabled} q={q} />
      <p class="muted small">
        By creating an account you agree to the <a href="/terms">terms</a> and <a href="/aup">acceptable use policy</a>.
      </p>
      <Script />
    </div>,
  );
});

authPages.get("/forgot", (c) => {
  const err = ERRORS[c.req.query("error") ?? ""];
  const sent = c.req.query("sent") === "1";
  return render(
    c,
    "Reset password",
    <div class="narrow stack">
      <h1>Reset your password</h1>
      {err ? <p class="notice">{err}</p> : null}
      <div id="sent" class="notice" hidden={!sent}>
        If there's an account for that email, we've sent it a link to choose a new password. It works once, for 30 minutes.
      </div>
      <form class="card stack" method="post" action="/auth/forgot" data-auth="#sent" hidden={sent}>
        <Field id="email" label="Email" type="email" auto="email" />
        <button type="submit">Email me a reset link</button>
        <p class="err" data-error="" />
      </form>
      <p class="muted small">
        <a href="/sign-in">Back to sign in</a>
      </p>
      <Script />
    </div>,
  );
});

authPages.get("/reset", (c) => {
  const token = (c.req.query("token") ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (token.length < 10 || token.length > 200) return c.redirect("/forgot?error=link");
  return render(
    c,
    "Choose a new password",
    <div class="narrow stack">
      <h1>Choose a new password</h1>
      <form class="card stack" method="post" action="/auth/reset" data-auth="">
        <Field id="password" label="New password" type="password" auto="new-password" min={10} hint="At least 10 characters." />
        <input type="hidden" name="token" value={token} />
        <button type="submit">Save and sign in</button>
        <p class="err" data-error="" />
      </form>
      <Script />
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
