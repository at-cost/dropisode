/** @jsxImportSource hono/jsx */
/**
 * Admin tools, mounted at /admin. Admins are the emails in ADMIN_EMAILS.
 * Every action writes admin_log. Forms post to the same origin, so the app's
 * same-origin check passes.
 */
import { formatUsd, usdToMicro } from "@reel/money";
import { Hono } from "hono";
import { sql } from "kysely";
import { requireAdmin } from "../auth/session";
import { walletState } from "../billing/wallet";
import type { AppEnv, Ctx } from "../context";
import { HttpError } from "../lib/errors";
import { setMediaHidden } from "../moderation/media";
import { REPORT_REASONS } from "../moderation/report";
import { ActionForm, AdminPage, Status, logAdmin, when } from "./ui";

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use("*", async (c, next) => {
  if (!c.get("user") && c.req.method === "GET") return c.redirect(`/sign-in?next=${encodeURIComponent(c.req.path)}`);
  requireAdmin(c);
  await next();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTICES: Record<string, string> = {
  frozen: "Workspace frozen. It can't start new generations.",
  unfrozen: "Workspace unfrozen.",
  unflagged: "Flag cleared.",
  unhidden: "Media is visible again.",
  kept: "Media stays hidden.",
  report: "Report updated.",
  invoice: "Invoice saved.",
};
const notice = (c: Ctx) => NOTICES[c.req.query("done") ?? ""];
const admin = (c: Ctx) => requireAdmin(c);
const db = (c: Ctx) => c.get("deps").db;

async function form(c: Ctx): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v.trim();
  return out;
}

function reasonOf(f: Record<string, string>): string {
  const r = (f.reason ?? "").slice(0, 500);
  if (!r) throw new HttpError(400, "Give a reason");
  return r;
}

// Overview

adminRoutes.get("/", async (c) => {
  const user = admin(c);
  const d = db(c);
  const p = c.get("deps").platform;
  const count = async (q: Promise<{ n: string | number | bigint } | undefined>) => Number((await q)?.n ?? 0);
  const [flagged, frozen, openReports, hidden, blocked24h] = await Promise.all([
    count(d.selectFrom("workspaces").select(sql<string>`count(*)`.as("n")).where("flaggedAt", "is not", null).executeTakeFirst()),
    count(d.selectFrom("workspaces").select(sql<string>`count(*)`.as("n")).where("frozenAt", "is not", null).executeTakeFirst()),
    count(d.selectFrom("abuseReports").select(sql<string>`count(*)`.as("n")).where("status", "=", "open").executeTakeFirst()),
    count(
      d
        .selectFrom("media")
        .select(sql<string>`count(*)`.as("n"))
        .where("hiddenAt", "is not", null)
        .where("deletedAt", "is", null)
        .executeTakeFirst(),
    ),
    count(
      d
        .selectFrom("moderationEvents")
        .select(sql<string>`count(*)`.as("n"))
        .where("at", ">", sql<Date>`now() - interval '1 day'`)
        .executeTakeFirst(),
    ),
  ]);
  return c.html(
    <AdminPage title="Overview" user={user}>
      <div class="grid">
        <a class="card" href="/admin/workspaces?status=flagged">
          <strong>{flagged}</strong> flagged workspaces
        </a>
        <a class="card" href="/admin/workspaces?status=frozen">
          <strong>{frozen}</strong> frozen workspaces
        </a>
        <a class="card" href="/admin/reports">
          <strong>{openReports}</strong> open abuse reports
        </a>
        <a class="card" href="/admin/media">
          <strong>{hidden}</strong> hidden media files
        </a>
        <a class="card" href="/admin/moderation">
          <strong>{blocked24h}</strong> blocked requests in 24 hours
        </a>
      </div>
      <h2>Fraud controls</h2>
      <ul>
        <li>Stripe Radar screens every top-up (on by default in Stripe).</li>
        <li>3D Secure is requested on every top-up.</li>
        <li>An email must be verified before the first top-up.</li>
        <li>
          New accounts can spend up to ${p.newAccountDailyCapUsd} a day for their first {p.newAccountDays} days.
        </li>
        <li>
          Top-ups between ${p.minTopupUsd} and ${p.maxTopupUsd}.
        </li>
        <li>Frozen workspaces can't place holds, so they can't start any generation.</li>
      </ul>
      <h2>Moderation</h2>
      <ul>
        <li>
          Every prompt, script excerpt and reference image sent for generation is checked before any money is spent. Rules:
          config/moderation.json.
        </li>
        <li>Public figures' names are refused (config/public-figures.json).</li>
        <li>New outputs and uploads are sampled by the worker. A hit hides the file and flags the workspace.</li>
      </ul>
    </AdminPage>,
  );
});

// Workspaces

adminRoutes.get("/workspaces", async (c) => {
  const user = admin(c);
  const d = db(c);
  const q = (c.req.query("q") ?? "").trim();
  const status = c.req.query("status") ?? "";
  let query = d
    .selectFrom("workspaces as w")
    .select(["w.id", "w.name", "w.createdAt", "w.frozenAt", "w.flaggedAt"])
    .orderBy("w.createdAt", "desc")
    .limit(50);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    query = query.where((eb) =>
      eb.or([
        eb("w.name", "ilike", like),
        ...(UUID.test(q) ? [eb("w.id", "=", q)] : []),
        eb.exists(
          eb
            .selectFrom("workspaceMembers as wm")
            .innerJoin("users as u", "u.id", "wm.userId")
            .select("wm.userId")
            .whereRef("wm.workspaceId", "=", "w.id")
            .where("u.email", "ilike", like),
        ),
      ]),
    );
  }
  if (status === "flagged") query = query.where("w.flaggedAt", "is not", null);
  if (status === "frozen") query = query.where("w.frozenAt", "is not", null);
  const rows = await query.execute();
  const ids = rows.map((r) => r.id);
  const members = ids.length
    ? await d
        .selectFrom("workspaceMembers as wm")
        .innerJoin("users as u", "u.id", "wm.userId")
        .select(["wm.workspaceId", "u.email", "wm.role"])
        .where("wm.workspaceId", "in", ids)
        .execute()
    : [];
  const wallets = await Promise.all(rows.map((r) => walletState(d, r.id)));
  return c.html(
    <AdminPage title="Workspaces" user={user}>
      <form method="get" action="/admin/workspaces" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <input name="q" value={q} placeholder="Name, workspace id or member email" style="flex:1;min-width:240px" />
        <select name="status">
          <option value="">All</option>
          <option value="flagged" selected={status === "flagged"}>
            Flagged
          </option>
          <option value="frozen" selected={status === "frozen"}>
            Frozen
          </option>
        </select>
        <button type="submit">Search</button>
      </form>
      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Workspace</th>
              <th>Members</th>
              <th class="num">Balance</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr>
                <td>
                  <a href={`/admin/workspaces/${r.id}`}>{r.name}</a>
                  <div class="mono small muted">{r.id}</div>
                </td>
                <td class="small">
                  {members
                    .filter((m) => m.workspaceId === r.id)
                    .map((m) => `${m.email}${m.role === "owner" ? " (owner)" : ""}`)
                    .join(", ")}
                </td>
                <td class="num">{formatUsd(wallets[i]!.balanceMicro)}</td>
                <td>
                  <Status frozenAt={r.frozenAt} flaggedAt={r.flaggedAt} />
                </td>
                <td class="small">{when(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? <p class="muted">No workspaces match.</p> : null}
    </AdminPage>,
  );
});

async function workspaceOr404(c: Ctx, id: string) {
  if (!UUID.test(id)) throw new HttpError(404, "No such workspace");
  const ws = await db(c).selectFrom("workspaces").selectAll().where("id", "=", id).executeTakeFirst();
  if (!ws) throw new HttpError(404, "No such workspace");
  return ws;
}

adminRoutes.get("/workspaces/:id", async (c) => {
  const user = admin(c);
  const d = db(c);
  const ws = await workspaceOr404(c, c.req.param("id"));
  const [wallet, members, events, hidden, ledger, log] = await Promise.all([
    walletState(d, ws.id),
    d
      .selectFrom("workspaceMembers as wm")
      .innerJoin("users as u", "u.id", "wm.userId")
      .select(["u.email", "u.name", "wm.role", "u.emailVerifiedAt"])
      .where("wm.workspaceId", "=", ws.id)
      .execute(),
    d.selectFrom("moderationEvents").selectAll().where("workspaceId", "=", ws.id).orderBy("at", "desc").limit(20).execute(),
    d
      .selectFrom("media")
      .select(["id", "contentType", "hiddenAt", "hiddenReason", "projectId"])
      .where("workspaceId", "=", ws.id)
      .where("hiddenAt", "is not", null)
      .orderBy("hiddenAt", "desc")
      .limit(20)
      .execute(),
    d
      .selectFrom("ledger")
      .select(["at", "kind", "amountMicro", "note", "model"])
      .where("workspaceId", "=", ws.id)
      .orderBy("at", "desc")
      .limit(20)
      .execute(),
    d.selectFrom("adminLog").selectAll().where("target", "=", `workspace:${ws.id}`).orderBy("at", "desc").limit(20).execute(),
  ]);
  const base = `/admin/workspaces/${ws.id}`;
  return c.html(
    <AdminPage title={ws.name} user={user} notice={notice(c)}>
      <p class="mono small muted">{ws.id}</p>
      <div class="grid">
        <div class="card">
          <div class="muted small">Balance</div>
          <strong>{formatUsd(wallet.balanceMicro)}</strong>
          <div class="small muted">
            Held {formatUsd(wallet.heldMicro)}, available {formatUsd(wallet.availableMicro)}
          </div>
        </div>
        <div class="card">
          <div class="muted small">Status</div>
          <Status frozenAt={ws.frozenAt} flaggedAt={ws.flaggedAt} />
          {ws.frozenAt ? (
            <div class="small">
              Frozen {when(ws.frozenAt)}: {ws.frozenReason}
            </div>
          ) : null}
          {ws.flaggedAt ? (
            <div class="small">
              Flagged {when(ws.flaggedAt)}: {ws.flaggedReason}
            </div>
          ) : null}
        </div>
        <div class="card">
          <div class="muted small">Created</div>
          {when(ws.createdAt)}
        </div>
      </div>

      <h2>Actions</h2>
      {ws.frozenAt ? (
        <ActionForm action={`${base}/unfreeze`} label="Unfreeze" reason />
      ) : (
        <ActionForm action={`${base}/freeze`} label="Freeze" reason />
      )}
      {ws.flaggedAt ? <ActionForm action={`${base}/clear-flag`} label="Clear flag" reason secondary /> : null}

      <h2>Members</h2>
      <table>
        <tbody>
          {members.map((m) => (
            <tr>
              <td>{m.email}</td>
              <td>{m.name}</td>
              <td>{m.role}</td>
              <td class="small">{m.emailVerifiedAt ? "Email verified" : "Email not verified"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Hidden media</h2>
      <MediaTable rows={hidden.map((h) => ({ ...h, workspaceId: ws.id, workspaceName: ws.name }))} />

      <h2>Blocked requests</h2>
      <EventsTable rows={events} />

      <h2>Recent ledger</h2>
      <table>
        <tbody>
          {ledger.map((l) => (
            <tr>
              <td class="small">{when(l.at)}</td>
              <td>{l.kind}</td>
              <td class="num">{formatUsd(Number(l.amountMicro), { precise: true })}</td>
              <td class="small">{[l.model, l.note].filter(Boolean).join(" ")}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Admin actions</h2>
      <LogTable rows={log} />
    </AdminPage>,
  );
});

adminRoutes.post("/workspaces/:id/freeze", async (c) => {
  const user = admin(c);
  const ws = await workspaceOr404(c, c.req.param("id"));
  const reason = reasonOf(await form(c));
  await db(c).updateTable("workspaces").set({ frozenAt: new Date(), frozenReason: reason }).where("id", "=", ws.id).execute();
  await logAdmin(db(c), user.id, "workspace.freeze", `workspace:${ws.id}`, { reason });
  return c.redirect(`/admin/workspaces/${ws.id}?done=frozen`, 303);
});

adminRoutes.post("/workspaces/:id/unfreeze", async (c) => {
  const user = admin(c);
  const ws = await workspaceOr404(c, c.req.param("id"));
  const reason = reasonOf(await form(c));
  await db(c).updateTable("workspaces").set({ frozenAt: null, frozenReason: null }).where("id", "=", ws.id).execute();
  await logAdmin(db(c), user.id, "workspace.unfreeze", `workspace:${ws.id}`, { reason, wasFrozenFor: ws.frozenReason });
  return c.redirect(`/admin/workspaces/${ws.id}?done=unfrozen`, 303);
});

adminRoutes.post("/workspaces/:id/clear-flag", async (c) => {
  const user = admin(c);
  const ws = await workspaceOr404(c, c.req.param("id"));
  const reason = reasonOf(await form(c));
  await db(c).updateTable("workspaces").set({ flaggedAt: null, flaggedReason: null }).where("id", "=", ws.id).execute();
  await logAdmin(db(c), user.id, "workspace.clear_flag", `workspace:${ws.id}`, { reason, flag: ws.flaggedReason });
  return c.redirect(`/admin/workspaces/${ws.id}?done=unflagged`, 303);
});

// Moderation events

function EventsTable(props: {
  rows: { at: Date; workspaceId: string | null; stage: string; target: string; reasons: string[] }[];
  showWorkspace?: boolean;
}) {
  if (!props.rows.length) return <p class="muted">None.</p>;
  return (
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>When</th>
            {props.showWorkspace ? <th>Workspace</th> : null}
            <th>Stage</th>
            <th>Reasons</th>
            <th>What</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((e) => (
            <tr>
              <td class="small">{when(e.at)}</td>
              {props.showWorkspace ? (
                <td class="mono small">
                  {e.workspaceId ? <a href={`/admin/workspaces/${e.workspaceId}`}>{e.workspaceId.slice(0, 8)}</a> : ""}
                </td>
              ) : null}
              <td class="small">{e.stage}</td>
              <td class="small">{(e.reasons ?? []).join(", ")}</td>
              <td class="small">{e.target}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

adminRoutes.get("/moderation", async (c) => {
  const user = admin(c);
  const ws = c.req.query("workspace") ?? "";
  let q = db(c).selectFrom("moderationEvents").selectAll().orderBy("at", "desc").limit(200);
  if (UUID.test(ws)) q = q.where("workspaceId", "=", ws);
  const rows = await q.execute();
  return c.html(
    <AdminPage title="Moderation log" user={user}>
      <p class="muted">Every blocked request and every output hidden by review. The newest 200.</p>
      <EventsTable rows={rows} showWorkspace />
    </AdminPage>,
  );
});

// Hidden media

interface MediaRow {
  id: string;
  contentType: string;
  hiddenAt: Date | null;
  hiddenReason: string | null;
  workspaceId: string;
  workspaceName: string;
  decision?: string | undefined;
}

function MediaTable(props: { rows: MediaRow[] }) {
  if (!props.rows.length) return <p class="muted">None.</p>;
  return (
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Workspace</th>
            <th>Why</th>
            <th>Review</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((m) => (
            <tr>
              <td>
                <a href={`/admin/media/${m.id}/view`} target="_blank" rel="noopener noreferrer">
                  {m.id}
                </a>
                <div class="small muted">
                  {m.contentType}, hidden {when(m.hiddenAt)}
                </div>
              </td>
              <td>
                <a href={`/admin/workspaces/${m.workspaceId}`}>{m.workspaceName}</a>
              </td>
              <td class="small">{m.hiddenReason}</td>
              <td class="small">{m.decision === "media.keep_hidden" ? "Kept hidden" : "Not reviewed"}</td>
              <td>
                <ActionForm action={`/admin/media/${m.id}/keep-hidden`} label="Keep hidden" secondary />
                <ActionForm action={`/admin/media/${m.id}/unhide`} label="Unhide" reason />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

adminRoutes.get("/media", async (c) => {
  const user = admin(c);
  const d = db(c);
  const rows = await d
    .selectFrom("media as m")
    .innerJoin("workspaces as w", "w.id", "m.workspaceId")
    .select(["m.id", "m.contentType", "m.hiddenAt", "m.hiddenReason", "m.workspaceId", "w.name as workspaceName"])
    .where("m.hiddenAt", "is not", null)
    .where("m.deletedAt", "is", null)
    .orderBy("m.hiddenAt", "desc")
    .limit(200)
    .execute();
  const decisions = rows.length
    ? await d
        .selectFrom("adminLog")
        .select(["target", "action"])
        .where(
          "target",
          "in",
          rows.map((r) => `media:${r.id}`),
        )
        .where("action", "in", ["media.keep_hidden", "media.unhide"])
        .orderBy("at", "asc")
        .execute()
    : [];
  const last = new Map(decisions.map((x) => [x.target, x.action]));
  const show = c.req.query("all") ? rows : rows.filter((r) => last.get(`media:${r.id}`) !== "media.keep_hidden");
  return c.html(
    <AdminPage title="Hidden media" user={user} notice={notice(c)}>
      <p class="muted">
        Files hidden by output review or by an admin. Open a file to look at it (the view is logged).{" "}
        {c.req.query("all") ? (
          <a href="/admin/media">Show only unreviewed</a>
        ) : (
          <a href="/admin/media?all=1">Include ones already kept hidden</a>
        )}
      </p>
      <MediaTable rows={show.map((r) => ({ ...r, decision: last.get(`media:${r.id}`) }))} />
    </AdminPage>,
  );
});

adminRoutes.get("/media/:id/view", async (c) => {
  const user = admin(c);
  const d = db(c);
  const row = await d
    .selectFrom("media")
    .select(["id", "storageKey", "workspaceId"])
    .where("id", "=", c.req.param("id"))
    .executeTakeFirst();
  if (!row) throw new HttpError(404, "Not found");
  await logAdmin(d, user.id, "media.view", `media:${row.id}`, { workspaceId: row.workspaceId });
  return c.redirect(await c.get("deps").blobs.signedUrl(row.storageKey, 120), 302);
});

adminRoutes.post("/media/:id/keep-hidden", async (c) => {
  const user = admin(c);
  const d = db(c);
  const row = await d.selectFrom("media").select(["id", "workspaceId", "hiddenAt"]).where("id", "=", c.req.param("id")).executeTakeFirst();
  if (!row) throw new HttpError(404, "Not found");
  if (!row.hiddenAt) await setMediaHidden(d, row.id, { reason: "Hidden by an admin" });
  const f = await form(c);
  await logAdmin(d, user.id, "media.keep_hidden", `media:${row.id}`, {
    workspaceId: row.workspaceId,
    ...(f.reason ? { reason: f.reason.slice(0, 500) } : {}),
  });
  return c.redirect("/admin/media?done=kept", 303);
});

adminRoutes.post("/media/:id/unhide", async (c) => {
  const user = admin(c);
  const d = db(c);
  const reason = reasonOf(await form(c));
  const row = await d
    .selectFrom("media")
    .select(["id", "workspaceId", "hiddenReason"])
    .where("id", "=", c.req.param("id"))
    .executeTakeFirst();
  if (!row) throw new HttpError(404, "Not found");
  await setMediaHidden(d, row.id, null);
  await logAdmin(d, user.id, "media.unhide", `media:${row.id}`, { workspaceId: row.workspaceId, reason, wasHiddenFor: row.hiddenReason });
  return c.redirect("/admin/media?done=unhidden", 303);
});

// Abuse reports

const REPORT_STATUSES = ["open", "actioned", "dismissed"] as const;

adminRoutes.get("/reports", async (c) => {
  const user = admin(c);
  const status = (REPORT_STATUSES as readonly string[]).includes(c.req.query("status") ?? "")
    ? (c.req.query("status") as (typeof REPORT_STATUSES)[number])
    : "open";
  const rows = await db(c).selectFrom("abuseReports").selectAll().where("status", "=", status).orderBy("at", "desc").limit(200).execute();
  return c.html(
    <AdminPage title="Abuse reports" user={user} notice={notice(c)}>
      <nav class="small" style="display:flex;gap:12px;margin-bottom:10px">
        {REPORT_STATUSES.map((s) => (s === status ? <strong>{s}</strong> : <a href={`/admin/reports?status=${s}`}>{s}</a>))}
      </nav>
      {rows.length === 0 ? <p class="muted">None.</p> : null}
      {rows.map((r) => (
        <div class="card" style="margin-bottom:10px">
          <div class="small muted">
            {when(r.at)} · {REPORT_REASONS[r.reason] ?? r.reason} · {r.reporterEmail ?? "no email"}
          </div>
          <div style="word-break:break-all">{r.url}</div>
          {r.details ? <p style="white-space:pre-wrap">{r.details}</p> : null}
          <form method="post" action={`/admin/reports/${r.id}/status`} style="display:flex;gap:8px;flex-wrap:wrap">
            <select name="status">
              {REPORT_STATUSES.map((s) => (
                <option value={s} selected={s === r.status}>
                  {s}
                </option>
              ))}
            </select>
            <input name="note" maxlength={500} placeholder="Note (optional)" style="flex:1;min-width:200px" />
            <button type="submit">Save</button>
          </form>
        </div>
      ))}
    </AdminPage>,
  );
});

adminRoutes.post("/reports/:id/status", async (c) => {
  const user = admin(c);
  const id = c.req.param("id");
  if (!UUID.test(id)) throw new HttpError(404, "Not found");
  const f = await form(c);
  const status = f.status as (typeof REPORT_STATUSES)[number];
  if (!REPORT_STATUSES.includes(status)) throw new HttpError(400, "Pick a status");
  const prev = await db(c).selectFrom("abuseReports").select("status").where("id", "=", id).executeTakeFirst();
  if (!prev) throw new HttpError(404, "Not found");
  await db(c).updateTable("abuseReports").set({ status }).where("id", "=", id).execute();
  await logAdmin(db(c), user.id, "report.status", `report:${id}`, {
    from: prev.status,
    to: status,
    ...(f.note ? { note: f.note.slice(0, 500) } : {}),
  });
  return c.redirect(`/admin/reports?status=${prev.status}&done=report`, 303);
});

// Provider invoices

adminRoutes.get("/invoices", async (c) => {
  const user = admin(c);
  const rows = await db(c).selectFrom("providerInvoices").selectAll().orderBy("month", "desc").orderBy("provider").limit(100).execute();
  return c.html(
    <AdminPage title="Provider invoices" user={user} notice={notice(c)}>
      <p class="muted">
        Enter each provider's monthly invoice. The finances page compares it with the costs recorded per job. Saving the same provider and
        month again replaces it.
      </p>
      <form method="post" action="/admin/invoices" class="card" style="display:grid;gap:10px;max-width:520px">
        <label>
          Provider
          <br />
          <input name="provider" required maxlength={50} value="fal" />
        </label>
        <label>
          Month (YYYY-MM)
          <br />
          <input name="month" required pattern="\d{4}-(0[1-9]|1[0-2])" placeholder="2026-10" />
        </label>
        <label>
          Amount in USD
          <br />
          <input name="amount" required inputmode="decimal" placeholder="123.45" />
        </label>
        <label>
          Source (invoice URL)
          <br />
          <input name="source" required maxlength={500} placeholder="https://..." style="width:100%" />
        </label>
        <div>
          <button type="submit">Save invoice</button>
        </div>
      </form>
      <h2>Entered</h2>
      <table>
        <thead>
          <tr>
            <th>Month</th>
            <th>Provider</th>
            <th class="num">Amount</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td>{r.month}</td>
              <td>{r.provider}</td>
              <td class="num">{formatUsd(Number(r.amountMicro))}</td>
              <td class="small" style="word-break:break-all">
                {/^https?:\/\//.test(r.source) ? (
                  <a href={r.source} rel="noopener noreferrer">
                    {r.source}
                  </a>
                ) : (
                  r.source
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </AdminPage>,
  );
});

adminRoutes.post("/invoices", async (c) => {
  const user = admin(c);
  const f = await form(c);
  const provider = (f.provider ?? "").toLowerCase();
  const month = f.month ?? "";
  const amount = Number((f.amount ?? "").replace(/[$,\s]/g, ""));
  const source = (f.source ?? "").slice(0, 500);
  if (!/^[a-z0-9_-]{1,50}$/.test(provider)) throw new HttpError(400, "Provider: letters, numbers, - or _");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "Month must be YYYY-MM");
  if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) throw new HttpError(400, "Enter the amount in USD");
  if (!/^https?:\/\/\S+$/.test(source)) throw new HttpError(400, "Source must be the invoice URL");
  const amountMicro = usdToMicro(amount);
  const d = db(c);
  const prev = await d
    .selectFrom("providerInvoices")
    .select("amountMicro")
    .where("provider", "=", provider)
    .where("month", "=", month)
    .executeTakeFirst();
  await d
    .insertInto("providerInvoices")
    .values({ provider, month, amountMicro, source })
    .onConflict((oc) => oc.columns(["provider", "month"]).doUpdateSet({ amountMicro, source }))
    .execute();
  await logAdmin(d, user.id, "invoice.save", `invoice:${provider}:${month}`, {
    amountMicro,
    source,
    ...(prev ? { previousMicro: Number(prev.amountMicro) } : {}),
  });
  return c.redirect("/admin/invoices?done=invoice", 303);
});

// Admin log

function LogTable(props: {
  rows: { at: Date; adminUserId: string | null; action: string; target: string; details: unknown }[];
  emails?: Map<string, string>;
}) {
  if (!props.rows.length) return <p class="muted">None.</p>;
  return (
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Admin</th>
            <th>Action</th>
            <th>Target</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr>
              <td class="small">{when(r.at)}</td>
              <td class="small">{(r.adminUserId && props.emails?.get(r.adminUserId)) ?? r.adminUserId?.slice(0, 8) ?? ""}</td>
              <td>{r.action}</td>
              <td class="mono small">{r.target}</td>
              <td class="mono small" style="word-break:break-all">
                {JSON.stringify(r.details)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

adminRoutes.get("/log", async (c) => {
  const user = admin(c);
  const d = db(c);
  const rows = await d.selectFrom("adminLog").selectAll().orderBy("at", "desc").orderBy("id", "desc").limit(300).execute();
  const ids = [...new Set(rows.map((r) => r.adminUserId).filter((x): x is string => !!x))];
  const users = ids.length ? await d.selectFrom("users").select(["id", "email"]).where("id", "in", ids).execute() : [];
  return c.html(
    <AdminPage title="Admin log" user={user}>
      <p class="muted">Every admin action. The newest 300.</p>
      <LogTable rows={rows} emails={new Map(users.map((u) => [u.id, u.email]))} />
    </AdminPage>,
  );
});
