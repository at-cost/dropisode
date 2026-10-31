/** @jsxImportSource hono/jsx */
/** The public abuse report form: anyone, signed in or not, can report content. Mounted at "/". */
import { clientIp } from "../auth/util";
import { Hono } from "hono";
import type { AppEnv, Ctx } from "../context";
import { uuid } from "../lib/ids";
import { Layout } from "../site/layout";

export const REPORT_REASONS: Record<string, string> = {
  impersonation: "Impersonates a real person",
  sexual_real_person: "Sexual content of a real person",
  minors: "Involves a minor",
  ncii: "Intimate images shared without consent",
  harassment: "Harassment or threats",
  illegal: "Illegal content",
  copyright: "Copyright or trademark",
  other: "Something else",
};

const WINDOW_MS = 60 * 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

/** In-memory, per process: enough to stop one sender flooding the queue. */
export function rateLimited(ip: string, now = Date.now()): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  return false;
}

export function resetReportRateLimit(): void {
  hits.clear();
}

function Form(props: { error?: string; values?: Record<string, string> }) {
  const v = props.values ?? {};
  return (
    <form method="post" action="/report" class="card" style="display:grid;gap:12px;max-width:620px">
      {props.error ? (
        <p class="notice" role="alert">
          {props.error}
        </p>
      ) : null}
      <label>
        Link to the content, or where you saw it
        <br />
        <input name="url" value={v.url ?? ""} maxlength={1000} style="width:100%" placeholder="https://..." />
      </label>
      <label>
        What is wrong
        <br />
        <select name="reason" required>
          {Object.entries(REPORT_REASONS).map(([k, label]) => (
            <option value={k} selected={v.reason === k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Details
        <br />
        <textarea name="details" rows={6} maxlength={5000} style="width:100%" placeholder="Describe the content and who it affects.">
          {v.details ?? ""}
        </textarea>
      </label>
      <label>
        Your email (optional, so we can reply)
        <br />
        <input name="email" type="email" value={v.email ?? ""} maxlength={320} style="width:100%" />
      </label>
      <div style="display:none" aria-hidden="true">
        <label>
          Leave this empty
          <input name="website" tabindex={-1} autocomplete="off" />
        </label>
      </div>
      <div>
        <button type="submit">Send report</button>
      </div>
    </form>
  );
}

export const reportRoutes = new Hono<AppEnv>();

reportRoutes.get("/report", (c) =>
  c.html(
    <Layout title="Report abuse" user={c.get("user")} description="Report content made with Dropisode that breaks our rules.">
      <h1>Report abuse</h1>
      <p class="muted">
        Tell us about content made with Dropisode that impersonates someone, sexualises a real person, involves a minor, harasses, or is
        illegal. We read every report.
      </p>
      <p class="muted small">If someone is in danger, contact the police first.</p>
      <Form />
    </Layout>,
  ),
);

reportRoutes.post("/report", async (c) => {
  const body = await c.req.parseBody();
  const field = (k: string, max: number) => (typeof body[k] === "string" ? (body[k] as string).trim().slice(0, max) : "");
  const values = { url: field("url", 1000), reason: field("reason", 50), details: field("details", 5000), email: field("email", 320) };
  const page = (status: 200 | 400 | 429, inner: unknown) =>
    c.html(
      <Layout title="Report abuse" user={c.get("user")}>
        {inner as never}
      </Layout>,
      status,
    );
  const thanks = () =>
    page(
      200,
      <>
        <h1>Thank you</h1>
        <p>We got your report and will look at it. If you left an email, we may write to you.</p>
        <p>
          <a href="/">Back to Dropisode</a>
        </p>
      </>,
    );

  // Bots fill the hidden field: say thanks, store nothing.
  if (field("website", 200)) return thanks();
  const retry = (error: string, status: 400 | 429 = 400) =>
    page(
      status,
      <>
        <h1>Report abuse</h1>
        <Form error={error} values={values} />
      </>,
    );
  if (!REPORT_REASONS[values.reason]) return retry("Pick what is wrong.");
  if (!values.url && !values.details) return retry("Add a link or describe the content.");
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email))
    return retry("That email doesn't look right. Leave it empty if you prefer.");
  if (rateLimited(clientIp(c))) return retry("Too many reports from your network. Try again in an hour.", 429);

  await c
    .get("deps")
    .db.insertInto("abuseReports")
    .values({
      id: uuid(),
      reporterEmail: values.email || null,
      url: values.url || "(no link)",
      reason: values.reason,
      details: values.details,
    })
    .execute();
  return thanks();
});
