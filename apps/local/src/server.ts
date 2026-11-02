/**
 * The local studio: core + the shared studio API + the web UI, on 127.0.0.1.
 * Projects are folders on disk. The fal.ai key lives in a config file readable
 * only by you, never in the browser. Jobs are polled from here (fal can't send
 * webhooks to localhost).
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  BlockedError,
  Catalog,
  FalProvider,
  FolderStore,
  type JobRecord,
  MockProvider,
  type Provider,
  type ProviderStatus,
  Studio,
  assembleEpisode,
  FFMPEG_MISSING,
  createProject,
  exportProject,
  findFfmpeg,
  importInto,
  readArchive,
} from "@reel/core";
import { type ExportInfo, type StudioContext, createStudioApi } from "@reel/studio";
import { type Context, Hono } from "hono";
import { type LocalConfig, loadConfig, saveConfig } from "./config";

export interface LocalOptions {
  projectsDir: string;
  configPath: string;
  /** Built web UI folder. */
  webDir?: string | undefined;
  /** "fal" (default) or "mock" (no key, no cost, placeholder media). */
  provider?: "fal" | "mock";
  port: number;
  pollMs?: number;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".srt": "text/plain; charset=utf-8",
  ".edl": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
  ".ico": "image/x-icon",
};

/** Asks for the key instead of spending anything. */
class NoKeyProvider implements Provider {
  readonly id = "fal";
  async submit(): Promise<never> {
    throw new BlockedError("Add your fal.ai key in Settings first.", "no_key");
  }
  async check(_job: JobRecord): Promise<ProviderStatus> {
    // Jobs submitted with a key that has since been removed: ask again once a key is back.
    throw new Error("No fal.ai key: add it in Settings to check running jobs");
  }
  async download(): Promise<never> {
    throw new Error("No fal.ai key");
  }
}

export function createLocalApp(opts: LocalOptions) {
  const store = new FolderStore(opts.projectsDir);
  const catalog = Catalog.load();
  let config: LocalConfig = loadConfig(opts.configPath);
  const mock = new MockProvider({ delayMs: 1500 });

  const makeStudio = (): Studio => {
    let provider: Provider;
    if (opts.provider === "mock") provider = mock;
    else if (config.falKey)
      provider = new FalProvider({ key: config.falKey, catalog, ...(config.falBillingKey ? { billingKey: config.falBillingKey } : {}) });
    else provider = new NoKeyProvider();
    return new Studio({
      projects: store,
      media: store,
      jobs: store.jobs,
      provider,
      catalog,
      log: (msg, err) => console.warn(`reel: ${msg}${err ? `: ${(err as Error).message ?? err}` : ""}`),
    });
  };
  let studio = makeStudio();

  const exportsDir = (projectId: string) => join(store.dir(projectId), "exports");
  const exportInfo = (projectId: string, id: string): ExportInfo | null => {
    const dir = join(exportsDir(projectId), id);
    const meta = join(dir, "export.json");
    if (!existsSync(meta)) return null;
    return JSON.parse(readFileSync(meta, "utf8")) as ExportInfo;
  };

  const context: StudioContext = {
    get studio() {
      return studio;
    },
    mode: "local",
    price: (micro) => micro,
    priceLabel: "fal.ai price (paid to fal with your key)",
    listProjects: async () => store.list(),
    createProject: async (p) => {
      const project = createProject(p);
      store.create(project);
      return project;
    },
    deleteProject: async (id) => {
      // Moves nothing to the bin: the folder is deleted. The UI confirms first.
      rmSync(store.dir(id), { recursive: true, force: true });
    },
    assertProject: async (id) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !store.exists(id)) throw Object.assign(new Error("Project not found"), { status: 404 });
    },
    importArchive: async (zip) => importInto(readArchive(zip), store, (p) => store.create(p)),
    exportArchive: async (id) => exportProject(await store.get(id), store),
    serveMedia: async (c, projectId, ref) => sendFile(c, store.localPath(projectId, ref), ref.contentType),
    assemble: async (projectId, episodeId, source, opts = {}) => {
      const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${source}`;
      const outDir = join(exportsDir(projectId), id);
      mkdirSync(outDir, { recursive: true });
      const res = await assembleEpisode({ projects: store, media: store }, projectId, episodeId, {
        source,
        outDir,
        burnSubtitles: !!opts.burnSubtitles,
      });
      const files = listFiles(outDir).map((rel) => ({
        name: rel,
        url: `/api/local/projects/${projectId}/exports/${id}/${rel}`,
        bytes: statSync(join(outDir, rel)).size,
      }));
      const info: ExportInfo = {
        id,
        episodeId,
        createdAt: new Date().toISOString(),
        source,
        durationS: res.durationS,
        files,
        skipped: res.skipped,
        warnings: res.warnings,
        subtitles: res.subtitles,
        subtitlesBurned: res.subtitlesBurned,
      };
      writeFileSync(join(outDir, "export.json"), JSON.stringify(info, null, 2));
      return info;
    },
    listExports: async (projectId) => {
      const dir = exportsDir(projectId);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .map((id) => exportInfo(projectId, id))
        .filter((x): x is ExportInfo => !!x)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };

  const app = new Hono();

  // Only this machine, only this page: blocks DNS rebinding and cross-site requests.
  app.use("*", async (c, next) => {
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return c.text("Dropisode only answers on localhost", 403);
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return c.text("Cross-site request refused", 403);
      if (!origin && c.req.header("sec-fetch-site") === "cross-site") return c.text("Cross-site request refused", 403);
    }
    await next();
  });

  app.get("/api/local/settings", (c) => {
    const ff = findFfmpeg();
    return c.json({
      provider: opts.provider === "mock" ? "mock" : "fal",
      hasKey: !!config.falKey,
      keyHint: config.falKey ? `…${config.falKey.slice(-4)}` : null,
      hasBillingKey: !!config.falBillingKey,
      projectsDir: store.root,
      configPath: opts.configPath,
      ffmpeg: ff ? { path: ff.path, subtitles: ff.subtitles } : null,
      ffmpegMissing: ff ? null : FFMPEG_MISSING,
    });
  });

  app.put("/api/local/settings", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { falKey?: string | null; falBillingKey?: string | null };
    const clean = (v: string | null | undefined) => (v === null ? undefined : v?.trim() || undefined);
    if (b.falKey !== undefined) config = { ...config, falKey: clean(b.falKey) };
    if (b.falBillingKey !== undefined) config = { ...config, falBillingKey: clean(b.falBillingKey) };
    saveConfig(opts.configPath, config);
    studio = makeStudio();
    return c.json({ ok: true, hasKey: !!config.falKey, hasBillingKey: !!config.falBillingKey });
  });

  app.get("/api/local/projects/:pid/exports/:xid/*", async (c) => {
    const pid = c.req.param("pid");
    await context.assertProject(pid);
    const xid = c.req.param("xid");
    if (!/^[A-Za-z0-9_-]+$/.test(xid)) return c.text("Not found", 404);
    const base = join(exportsDir(pid), xid);
    const rel = decodeURIComponent(c.req.path.split(`/exports/${xid}/`)[1] ?? "");
    const full = resolve(base, rel);
    if (!full.startsWith(base + sep) || !existsSync(full) || !statSync(full).isFile()) return c.text("Not found", 404);
    const res = await sendFile(c, full, TYPES[extname(full)] ?? "application/octet-stream");
    if (c.req.query("download")) res.headers.set("content-disposition", `attachment; filename="${full.split(sep).pop()}"`);
    return res;
  });

  app.route(
    "/api",
    createStudioApi(async () => context),
  );

  // The web UI.
  if (opts.webDir && existsSync(opts.webDir)) {
    const webDir = resolve(opts.webDir);
    app.get("*", async (c) => {
      const rel = c.req.path === "/" ? "index.html" : decodeURIComponent(c.req.path.slice(1));
      let full = resolve(webDir, rel);
      if (!full.startsWith(webDir + sep) || !existsSync(full) || !statSync(full).isFile()) full = join(webDir, "index.html");
      return sendFile(c, full, TYPES[extname(full)] ?? "application/octet-stream");
    });
  } else {
    app.get("/", (c) => c.text("The web UI isn't built. Run: pnpm --filter @reel/studio build"));
  }

  // Poll fal for running jobs.
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await studio.tick();
    } catch (err) {
      console.warn(`reel: ${(err as Error).message}`);
    } finally {
      ticking = false;
    }
  }, opts.pollMs ?? 3000);
  timer.unref();

  return { app, store, context, getStudio: () => studio, stop: () => clearInterval(timer) };
}

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, `${prefix}${name}/`));
    else if (name !== "export.json") out.push(`${prefix}${name}`);
  }
  return out.sort();
}

/** Sends a file, honouring Range requests so videos can seek. */
async function sendFile(c: Context, path: string, contentType: string): Promise<Response> {
  const size = statSync(path).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  const headers: Record<string, string> = { "content-type": contentType, "accept-ranges": "bytes", "cache-control": "no-store" };
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
    headers: { ...headers, "content-length": String(size) },
  });
}
