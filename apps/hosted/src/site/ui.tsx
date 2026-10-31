/** @jsxImportSource hono/jsx */
/** Small pieces shared by the public pages. */
import { formatUsd } from "@reel/money";
import type { Child } from "hono/jsx";
import type { Ctx } from "../context";
import { Layout } from "./layout";

/** A full public page in the shared layout. */
export function page(c: Ctx, p: { title: string; description: string; body: Child; cache?: string; fullBleed?: boolean }) {
  const el = (
    <Layout title={p.title} description={p.description} user={c.get("user")} fullBleed={p.fullBleed ?? false} path={c.req.path}>
      {p.body}
    </Layout>
  );
  // Signed-in pages show the user's links in the header, so never share them in a cache.
  c.header("cache-control", c.get("user") ? "private, no-store" : (p.cache ?? "public, max-age=300"));
  c.header("vary", "cookie");
  return c.html(`<!doctype html>${el}`);
}

/** A table that scrolls sideways on a phone instead of squashing. */
export const TableWrap = (p: { children: Child; label?: string }) => (
  <section class="table-wrap" aria-label={p.label ?? "Table"} tabindex={0}>
    {p.children}
  </section>
);

export const usd = (micro: number) => formatUsd(micro);
/** Four decimals when cents would hide the amount (per-second prices, single jobs). */
export const usdPrecise = (micro: number) => formatUsd(micro, { precise: true });
export const int = (n: number) => n.toLocaleString("en-US");

export const StatusTag = (p: { status: string }) => (
  <span class={`tag ${p.status === "verified" ? "ok" : p.status === "assumed" || p.status === "uncertain" ? "warn" : ""}`}>{p.status}</span>
);

export const Ext = (p: { href: string; children: Child }) => (
  <a href={p.href} rel="noopener noreferrer" target="_blank">
    {p.children}
  </a>
);
