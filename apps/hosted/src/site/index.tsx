/** @jsxImportSource hono/jsx */
/** The public site: landing, pricing calculator, finances, docs, legal drafts, demo, robots and sitemap. */
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { financesSummary } from "../finances";
import { demoExportPath, demoMediaPath, loadDemo, sendFile } from "./demo";
import { demoPage } from "./pages/demo";
import { docsLocalPage, docsPage } from "./pages/docs";
import { financesPage } from "./pages/finances";
import { homePage } from "./pages/home";
import { aupPage, privacyPage, termsPage } from "./pages/legal";
import { pricingPage } from "./pages/pricing";

export const siteRoutes = new Hono<AppEnv>();

/** Public pages listed in the sitemap. */
export const PUBLIC_PATHS = ["/", "/pricing", "/finances", "/demo", "/docs", "/docs/local", "/terms", "/aup", "/privacy"] as const;

siteRoutes.get("/", (c) => homePage(c));
siteRoutes.get("/pricing", (c) => pricingPage(c));

siteRoutes.get("/finances", async (c) => {
  const deps = c.get("deps");
  if (!deps.config.FINANCES_PUBLIC) return c.notFound();
  return financesPage(c, await financesSummary(deps.db, deps.platform, deps.fixedCosts));
});
siteRoutes.get("/finances.json", async (c) => {
  const deps = c.get("deps");
  if (!deps.config.FINANCES_PUBLIC) return c.json({ error: "Not found" }, 404);
  c.header("cache-control", "public, max-age=60");
  c.header("access-control-allow-origin", "*");
  return c.json(await financesSummary(deps.db, deps.platform, deps.fixedCosts));
});

siteRoutes.get("/docs", (c) => docsPage(c));
siteRoutes.get("/docs/local", (c) => docsLocalPage(c));
siteRoutes.get("/terms", (c) => termsPage(c));
siteRoutes.get("/aup", (c) => aupPage(c));
siteRoutes.get("/privacy", (c) => privacyPage(c));

siteRoutes.get("/demo", (c) => demoPage(c, loadDemo()));
siteRoutes.get("/demo/media/:file", (c) => {
  const demo = loadDemo();
  const file = demo ? demoMediaPath(demo, c.req.param("file")) : null;
  if (!file) return c.notFound();
  return sendFile(file, c.req.header("range"));
});
siteRoutes.get("/demo/exports/:file", (c) => {
  const demo = loadDemo();
  const file = demo ? demoExportPath(demo, c.req.param("file")) : null;
  if (!file) return c.notFound();
  return sendFile(file, c.req.header("range"), c.req.query("download") === "1");
});

const base = (c: { get: (k: "deps") => AppEnv["Variables"]["deps"] }) => c.get("deps").config.APP_URL.replace(/\/$/, "");

siteRoutes.get("/robots.txt", (c) => {
  const lines = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /studio/",
    "Disallow: /admin",
    "Disallow: /account",
    "Disallow: /billing",
    "Disallow: /auth/",
    "",
    `Sitemap: ${base(c)}/sitemap.xml`,
    "",
  ];
  c.header("cache-control", "public, max-age=3600");
  return c.text(lines.join("\n"));
});

siteRoutes.get("/sitemap.xml", (c) => {
  const urls = PUBLIC_PATHS.map((p) => `  <url><loc>${base(c)}${p === "/" ? "/" : p}</loc></url>`).join("\n");
  c.header("content-type", "application/xml; charset=utf-8");
  c.header("cache-control", "public, max-age=3600");
  return c.body(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  );
});
