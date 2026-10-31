/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import type { Ctx } from "../context";
import { Layout } from "../site/layout";
import { CLIENT_JS, PAGE_CSS } from "./client";

/** A full page in the shared layout, with the account pages' small script and styles. */
export function render(c: Ctx, title: string, body: Child, status: 200 | 400 | 403 | 404 = 200, opts: { variant?: "auth" } = {}) {
  const el = (
    <Layout title={title} user={c.get("user")} path={c.req.path} {...(opts.variant ? { variant: opts.variant } : {})}>
      <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
      {body}
      <script dangerouslySetInnerHTML={{ __html: CLIENT_JS }} />
    </Layout>
  );
  c.header("cache-control", "no-store");
  return c.html(`<!doctype html>${el}`, status);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "31 Oct 2026" (UTC). */
export const fmtDate = (d: Date | string) => {
  const x = new Date(d);
  return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
};
/** "31 Oct, 10:47" (UTC). */
export const fmtDateTime = (d: Date | string) => {
  const x = new Date(d);
  return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}, ${String(x.getUTCHours()).padStart(2, "0")}:${String(x.getUTCMinutes()).padStart(2, "0")}`;
};
/** Dollars with 2 decimals; 3 for non-zero amounts under 10 cents (per-generation prices). */
export const fmtMoney = (micro: number) => {
  const d = micro / 1_000_000;
  const digits = d !== 0 && Math.abs(d) < 0.1 ? 3 : 2;
  return `${d < 0 ? "-" : ""}$${Math.abs(d).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
