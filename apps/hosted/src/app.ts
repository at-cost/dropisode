import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { Catalog } from "@reel/core";
import { platformSettings } from "@reel/money";
import { createStudioApi } from "@reel/studio";
import { Hono } from "hono";
import { adminRoutes } from "./admin/routes";
import { accountRoutes, authPages, authRoutes } from "./auth/routes";
import { createSession, requireUser, sameOriginWrites, sessionMiddleware } from "./auth/session";
import { findOrCreateUser } from "./auth/users";
import { currentWorkspace } from "./auth/workspace";
import { stripeGateway } from "./billing/gateway";
import { billingRoutes, stripeWebhook } from "./billing/routes";
import type { Config } from "./config";
import type { AppEnv, Deps } from "./context";
import { type Db, createDb } from "./db";
import { createMailer } from "./email";
import { loadFixedCosts } from "./finances";
import { HttpError } from "./lib/errors";
import { createModeration } from "./moderation/service";
import { reportRoutes } from "./moderation/report";
import { siteRoutes } from "./site";
import { createBlobStore, serveLocalFile } from "./storage";
import { hostedStudioContext, providerFactory } from "./studio";
import { falWebhook } from "./webhooks";

export function createDeps(config: Config, db: Db, over: Partial<Deps> = {}): Deps {
  const catalog = over.catalog ?? Catalog.load();
  const base: Omit<Deps, "moderation"> = {
    config,
    db,
    // A stalled lock wait fails after 30 s (the job is retried on the next tick) instead of hanging.
    locks: over.locks ?? createDb(config.DATABASE_URL, 8, { connectionTimeoutMillis: 30_000 }).db,
    blobs: over.blobs ?? createBlobStore(config),
    catalog,
    platform: over.platform ?? platformSettings(catalog.config.services),
    fixedCosts: over.fixedCosts ?? loadFixedCosts(),
    mailer: over.mailer ?? createMailer(config),
    payments:
      over.payments !== undefined
        ? over.payments
        : config.STRIPE_SECRET_KEY
          ? stripeGateway(config.STRIPE_SECRET_KEY, config.STRIPE_WEBHOOK_SECRET)
          : null,
    provider: over.provider ?? providerFactory(config, catalog),
  };
  return { ...base, moderation: over.moderation ?? createModeration(base) };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
    // No page of ours may be framed by another site (sign-in confirm, billing, admin).
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
  });
  app.onError((err, c) => {
    const status = err instanceof HttpError ? err.status : (err as { status?: number }).status;
    if (status && status >= 400 && status < 600) return c.json({ error: err.message }, status as 400);
    if ((err as { name?: string }).name === "ZodError") return c.json({ error: "Invalid request" }, 400);
    console.error(err);
    return c.json({ error: "Something went wrong" }, 500);
  });

  app.get("/health", async (c) => {
    await deps.db.selectFrom("users").select("id").limit(1).execute();
    return c.json({ ok: true });
  });

  const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#b4441d"/><path d="M11 8h7a6 6 0 0 1 1.6 11.8L24 25h-4.4l-3.9-5H15v5h-4zm4 4v4h3a2 2 0 0 0 0-4z" fill="#fff"/></svg>`;
  app.get("/favicon.ico", (c) => c.body(FAVICON, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }));
  app.get("/favicon.svg", (c) => c.body(FAVICON, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }));

  // Third-party callers (no session, no origin check).
  app.route("/webhooks/fal", falWebhook);
  app.route("/webhooks/stripe", stripeWebhook);

  app.use("*", sessionMiddleware);
  app.use("*", sameOriginWrites);

  if (deps.config.STORAGE_DRIVER === "local") {
    app.get("/files", (c) => {
      const key = c.req.query("key") ?? "";
      const ext = extname(key).toLowerCase();
      const type =
        {
          ".mp4": "video/mp4",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".webp": "image/webp",
          ".wav": "audio/wav",
          ".mp3": "audio/mpeg",
        }[ext] ?? "application/octet-stream";
      return serveLocalFile(deps.config, new URL(c.req.url).searchParams, type);
    });
  }

  if (deps.config.TEST_LOGIN) {
    app.post("/auth/test-login", async (c) => {
      const b = (await c.req.json()) as { email: string; name?: string };
      const u = await findOrCreateUser(deps.db, b);
      await createSession(c, u.id);
      return c.json({ userId: u.id });
    });
  }

  app.route("/auth", authRoutes);
  app.route("/api/account", accountRoutes);
  app.route("/api/billing", billingRoutes);
  app.route("/admin", adminRoutes);

  // The studio API, as the signed-in user in their current workspace.
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/account") || c.req.path.startsWith("/api/billing")) return next();
    requireUser(c);
    await next();
  });
  app.route(
    "/api",
    createStudioApi(async (c) => {
      const user = requireUser(c as never);
      const ws = await currentWorkspace(c as never);
      return hostedStudioContext(deps, ws.workspaceId, user.id);
    }),
  );

  // The studio UI (the same build as local).
  const webDir = deps.config.WEB_DIST_DIR ? resolve(deps.config.WEB_DIST_DIR) : "";
  app.get("/studio/*", (c) => {
    if (!c.get("user")) return c.redirect(`/sign-in?next=${encodeURIComponent(c.req.path)}`);
    if (!webDir || !existsSync(join(webDir, "index.html"))) return c.text("The studio UI isn't built", 503);
    const rel = decodeURIComponent(c.req.path.replace(/^\/studio\/?/, "")) || "index.html";
    let full = resolve(webDir, rel);
    if (!full.startsWith(webDir + sep) || !existsSync(full) || !statSync(full).isFile()) full = join(webDir, "index.html");
    return new Response(readFileSync(full), { headers: { "content-type": TYPES[extname(full)] ?? "application/octet-stream" } });
  });
  app.get("/studio", (c) => c.redirect("/studio/"));

  app.route("/", authPages);
  app.route("/", reportRoutes);
  app.route("/", siteRoutes);
  return app;
}
