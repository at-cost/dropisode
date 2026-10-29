/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import type { Ctx } from "../context";
import { Layout } from "../site/layout";
import { CLIENT_JS, PAGE_CSS } from "./client";

/** A full page in the shared layout, with the account pages' small script and styles. */
export function render(c: Ctx, title: string, body: Child, status: 200 | 400 | 403 | 404 = 200) {
  const el = (
    <Layout title={title} user={c.get("user")}>
      <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
      {body}
      <script dangerouslySetInnerHTML={{ __html: CLIENT_JS }} />
    </Layout>
  );
  c.header("cache-control", "no-store");
  return c.html(`<!doctype html>${el}`, status);
}

export const fmtDate = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
export const fmtDateTime = (d: Date | string) => new Date(d).toISOString().slice(0, 16).replace("T", " ");
