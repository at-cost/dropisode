/** @jsxImportSource hono/jsx */
/** Shared pieces for the admin pages. */
import type { Child } from "hono/jsx";
import type { SessionUser } from "../context";
import type { Db } from "../db";
import { Layout } from "../site/layout";

const NAV: [string, string][] = [
  ["/admin", "Overview"],
  ["/admin/workspaces", "Workspaces"],
  ["/admin/moderation", "Moderation log"],
  ["/admin/media", "Hidden media"],
  ["/admin/reports", "Abuse reports"],
  ["/admin/invoices", "Provider invoices"],
  ["/admin/log", "Admin log"],
];

const ADMIN_CSS = `.subnav{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 14px}.subnav a{font-size:14px;text-decoration:none;color:var(--text-2);padding:6px 12px;border-radius:999px;border:1px solid var(--border)}.subnav a:hover{color:var(--text);border-color:var(--text-2)}.subnav a[aria-current=page]{color:var(--accent-text);background:var(--accent);border-color:var(--accent)}
.stat-grid{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}.stat-link{text-decoration:none;color:var(--text);display:flex;flex-direction:column;gap:2px}.stat-link:hover{border-color:var(--accent)}.stat-link .big{font-family:var(--display);font-size:40px;font-weight:800;line-height:1}`;

export function AdminPage(props: { title: string; user: SessionUser; notice?: string | undefined; children: Child }) {
  return (
    <Layout title={`Admin: ${props.title}`} user={props.user}>
      <style dangerouslySetInnerHTML={{ __html: ADMIN_CSS }} />
      <nav class="subnav" aria-label="Admin">
        {NAV.map(([href, label]) => (
          <a href={href} aria-current={label === props.title ? "page" : undefined}>
            {label}
          </a>
        ))}
      </nav>
      <h1>{props.title}</h1>
      {props.notice ? (
        <p class="notice" role="status">
          {props.notice}
        </p>
      ) : null}
      {props.children}
    </Layout>
  );
}

export const when = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "");

export function Status(props: { frozenAt: Date | null; flaggedAt: Date | null }) {
  return (
    <span>
      {props.frozenAt ? <strong style="color:var(--bad)">Frozen </strong> : null}
      {props.flaggedAt ? <strong style="color:var(--warn)">Flagged </strong> : null}
      {!props.frozenAt && !props.flaggedAt ? <span class="muted">OK</span> : null}
    </span>
  );
}

/** A POST form with one button and an optional reason box. */
export function ActionForm(props: {
  action: string;
  label: string;
  reason?: boolean;
  secondary?: boolean;
  hidden?: Record<string, string>;
}) {
  return (
    <form method="post" action={props.action} style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0">
      {Object.entries(props.hidden ?? {}).map(([k, v]) => (
        <input type="hidden" name={k} value={v} />
      ))}
      {props.reason ? <input name="reason" required maxlength={500} placeholder="Reason" style="min-width:260px;flex:1" /> : null}
      <button type="submit" class={props.secondary ? "secondary" : ""}>
        {props.label}
      </button>
    </form>
  );
}

/** Writes one admin_log row. Every admin action calls this. */
export async function logAdmin(
  db: Db,
  adminUserId: string,
  action: string,
  target: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db
    .insertInto("adminLog")
    .values({ adminUserId, action, target, details: JSON.stringify(details) })
    .execute();
}
