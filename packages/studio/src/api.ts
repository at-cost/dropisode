/**
 * The studio HTTP API, shared by local and hosted. Each app supplies a
 * per-request context: which projects the caller may see, where media lives,
 * and how prices are shown (local: the provider's cost; hosted: what the
 * creator pays, cost × 1.2). Hosted adds auth, workspace checks and billing
 * around this; nothing studio-related exists only in hosted.
 */
import {
  BlockedError,
  CAMERA_PRESETS,
  EditError,
  type MediaRef,
  type Project,
  type Studio,
  addCast,
  addEpisode,
  addScene,
  addShot,
  deleteShot,
  episodeTotals,
  findCast,
  findEpisode,
  findScene,
  mergeWithNext,
  moveShot,
  projectTotals,
  removeCast,
  splitShot,
  updateShot,
} from "@reel/core";
import { type Context, Hono } from "hono";
import { z } from "zod";

export interface ExportFile {
  name: string;
  url: string;
  bytes: number;
}

export interface ExportInfo {
  id: string;
  episodeId: string;
  createdAt: string;
  source: "final" | "rough";
  durationS: number;
  files: ExportFile[];
  skipped: { shotId: string; reason: string }[];
  warnings: string[];
}

export interface StudioContext {
  studio: Studio;
  /** "local": your own key, provider prices. "hosted": prepaid wallet, prices include the markup. */
  mode: "local" | "hosted";
  /** Turns a provider cost into what this user pays (local: unchanged; hosted: × 1.2). */
  price(providerCostMicro: number): number;
  priceLabel: string;
  listProjects(): Promise<Project[]>;
  createProject(p: { name: string; idea?: string; aspect?: "9:16" | "16:9" }): Promise<Project>;
  deleteProject(projectId: string): Promise<void>;
  /** Throws if the caller may not use this project. */
  assertProject(projectId: string): Promise<void>;
  importArchive(zip: Uint8Array): Promise<Project>;
  exportArchive(projectId: string): Promise<Uint8Array>;
  /** Streams or redirects to a media file. */
  serveMedia(c: Context, projectId: string, ref: MediaRef): Promise<Response>;
  assemble(projectId: string, episodeId: string, source: "final" | "rough"): Promise<ExportInfo>;
  listExports(projectId: string): Promise<ExportInfo[]>;
  /** Hosted: wallet state for the header. */
  wallet?(): Promise<{ balanceMicro: number; heldMicro: number; blocked: boolean; message?: string }>;
  /** Hosted: who is signed in, for the profile menu. */
  account?(): Promise<{ name: string; email: string; workspace: string; isAdmin: boolean }>;
  /** Hosted: who triggered a job (workspace and member), stored with the job. */
  owner?: Record<string, string>;
}

export type ResolveContext = (c: Context) => Promise<StudioContext>;

const Aspect = z.enum(["9:16", "16:9"]);
const Tier = z.enum(["draft", "final"]);
const CastKind = z.enum(["character", "location", "prop"]);
const Line = z.object({ id: z.string().optional(), castId: z.string().nullable(), text: z.string().max(1000) });

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    json = {};
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new EditError(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

export function createStudioApi(resolve: ResolveContext): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof BlockedError) return c.json({ error: err.message, reason: err.reason }, 402);
    if (err instanceof EditError) return c.json({ error: err.message, code: err.code }, err.code === "not_found" ? 404 : 400);
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) return c.json({ error: err.message }, status as 400);
    console.error(err);
    return c.json({ error: err.message || "Something went wrong" }, 500);
  });

  const project = async (c: Context, ctx: StudioContext) => {
    const id = c.req.param("pid")!;
    await ctx.assertProject(id);
    return ctx.studio.projects.get(id);
  };
  const mutate = async <T>(c: Context, ctx: StudioContext, fn: (p: Project) => T): Promise<T> => {
    const id = c.req.param("pid")!;
    await ctx.assertProject(id);
    return ctx.studio.projects.mutate(id, fn);
  };

  /** A project as the UI sees it: prices shown the way this user pays. */
  const view = async (ctx: StudioContext, p: Project) => {
    const open = await ctx.studio.runner.deps.jobs.listUnfinished(p.id);
    const t = projectTotals(p);
    return {
      project: p,
      totals: { ...t, paidMicro: p.costLog.reduce((a, l) => a + ctx.price(l.providerCostMicro), 0) },
      episodeTotals: Object.fromEntries(
        p.episodes.map((e) => {
          const et = episodeTotals(p, e.id);
          return [
            e.id,
            { ...et, paidMicro: p.costLog.filter((l) => l.episodeId === e.id).reduce((a, l) => a + ctx.price(l.providerCostMicro), 0) },
          ];
        }),
      ),
      costLog: p.costLog.map((l) => ({ ...l, paidMicro: ctx.price(l.providerCostMicro), estimatePaidMicro: ctx.price(l.estimateMicro) })),
      openJobs: open
        .filter((j) => j.state === "created" || j.state === "submitted")
        .map((j) => ({ id: j.id, purpose: j.purpose, refs: j.refs, state: j.state })),
    };
  };

  app.get("/config", async (c) => {
    const ctx = await resolve(c);
    const cat = ctx.studio.catalog;
    return c.json({
      mode: ctx.mode,
      priceLabel: ctx.priceLabel,
      cameraPresets: CAMERA_PRESETS,
      defaults: cat.config.defaults,
      models: cat.list().map((m) => ({
        id: m.id,
        kind: m.kind,
        label: m.label,
        tiers: m.tiers,
        nativeAudio: m.nativeAudio,
        durations: m.durations,
        aspects: m.aspects,
        unit: m.price.unit,
        // Per-unit price as this user pays it, for display. Exact prices come from /estimate.
        unitPaidMicro: m.price.usd !== undefined ? ctx.price(Math.round(m.price.usd * 1_000_000)) : null,
        audioUnitPaidMicro: m.price.audioUsd !== undefined ? ctx.price(Math.round(m.price.audioUsd * 1_000_000)) : null,
        source: m.price.source,
        verifiedOn: m.price.verifiedOn,
      })),
      wallet: ctx.wallet ? await ctx.wallet() : null,
      account: ctx.account ? await ctx.account() : null,
    });
  });

  // Dashboard: what's happened lately across all projects, this month's spend, what's running.

  app.get("/dashboard", async (c) => {
    const ctx = await resolve(c);
    const list = await ctx.listProjects();
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const days: Record<string, number> = {};
    const lines: Array<{
      projectId: string;
      projectName: string;
      at: string;
      purpose: string;
      tier: string | null;
      label: string;
      status: string;
      paidMicro: number;
      model: string;
    }> = [];
    for (const p of list) {
      for (const l of p.costLog) {
        const paid = ctx.price(l.providerCostMicro);
        if (l.at.startsWith(month)) days[l.at.slice(0, 10)] = (days[l.at.slice(0, 10)] ?? 0) + paid;
        lines.push({
          projectId: p.id,
          projectName: p.name,
          at: l.at,
          purpose: l.purpose,
          tier: l.tier,
          label: costLabel(p, l),
          status: l.status,
          paidMicro: paid,
          model: l.model,
        });
      }
    }
    lines.sort((a, b) => b.at.localeCompare(a.at));
    const running = [];
    for (const p of list) {
      const open = (await ctx.studio.runner.deps.jobs.listUnfinished(p.id)).filter((j) => j.state === "created" || j.state === "submitted");
      if (open.length)
        running.push({ projectId: p.id, projectName: p.name, count: open.length, purposes: [...new Set(open.map((j) => j.purpose))] });
    }
    const dayList = Object.entries(days)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, paidMicro]) => ({ day, paidMicro }));
    return c.json({
      recent: lines.slice(0, 12),
      month: { month, days: dayList, totalMicro: dayList.reduce((a, d) => a + d.paidMicro, 0) },
      running,
      counts: {
        projects: list.length,
        shots: list.reduce((a, p) => a + p.episodes.reduce((b, e) => b + e.scenes.reduce((x, s) => x + s.shots.length, 0), 0), 0),
      },
    });
  });

  // Projects

  app.get("/projects", async (c) => {
    const ctx = await resolve(c);
    const list = await ctx.listProjects();
    return c.json(
      list.map((p) => ({
        id: p.id,
        name: p.name,
        aspect: p.aspect,
        updatedAt: p.updatedAt,
        episodes: p.episodes.length,
        shots: p.episodes.reduce((a, e) => a + e.scenes.reduce((b, s) => b + s.shots.length, 0), 0),
        paidMicro: p.costLog.reduce((a, l) => a + ctx.price(l.providerCostMicro), 0),
        coverMediaId: coverOf(p) ?? null,
      })),
    );
  });

  app.post("/projects", async (c) => {
    const ctx = await resolve(c);
    const b = await body(
      c,
      z.object({ name: z.string().min(1).max(200), idea: z.string().max(4000).optional(), aspect: Aspect.optional() }),
    );
    return c.json(await ctx.createProject(b), 201);
  });

  app.post("/projects/import", async (c) => {
    const ctx = await resolve(c);
    const zip = new Uint8Array(await c.req.arrayBuffer());
    if (zip.byteLength === 0) throw new EditError("Send the project zip as the request body");
    return c.json(await ctx.importArchive(zip), 201);
  });

  app.get("/projects/:pid", async (c) => {
    const ctx = await resolve(c);
    return c.json(await view(ctx, await project(c, ctx)));
  });

  app.patch("/projects/:pid", async (c) => {
    const ctx = await resolve(c);
    const b = await body(
      c,
      z.object({ name: z.string().min(1).max(200).optional(), idea: z.string().max(4000).optional(), aspect: Aspect.optional() }),
    );
    await mutate(c, ctx, (p) => Object.assign(p, b));
    return c.json(await view(ctx, await project(c, ctx)));
  });

  app.delete("/projects/:pid", async (c) => {
    const ctx = await resolve(c);
    await ctx.assertProject(c.req.param("pid"));
    await ctx.deleteProject(c.req.param("pid"));
    return c.body(null, 204);
  });

  app.get("/projects/:pid/export", async (c) => {
    const ctx = await resolve(c);
    const p = await project(c, ctx);
    const zip = await ctx.exportArchive(p.id);
    const name = `${
      p.name
        .replace(/[^A-Za-z0-9 _-]+/g, "")
        .trim()
        .replace(/\s+/g, "-") || "project"
    }.dropisode.zip`;
    return new Response(zip as BodyInit, {
      headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${name}"` },
    });
  });

  app.get("/projects/:pid/media/:mid", async (c) => {
    const ctx = await resolve(c);
    const p = await project(c, ctx);
    const ref = p.media.find((m) => m.id === c.req.param("mid"));
    if (!ref || ref.hidden) return c.json({ error: "Not found" }, 404);
    return ctx.serveMedia(c, p.id, ref);
  });

  // Estimates: the exact price on every generate button.

  app.get("/projects/:pid/estimates", async (c) => {
    const ctx = await resolve(c);
    const p = await project(c, ctx);
    const s = ctx.studio;
    const castImage = ctx.price(s.estimateCastImage().providerCostMicro);
    const seconds = Math.min(600, Math.max(5, Number(c.req.query("targetSeconds")) || 30));
    const script = ctx.price(s.estimateScript(p.idea || "x".repeat(200), seconds).providerCostMicro);
    const scenes: Record<string, number> = {};
    const shots: Record<string, { draft: number; final: number; draftDetail: unknown; finalDetail: unknown }> = {};
    for (const ep of p.episodes) {
      for (const sc of ep.scenes) {
        scenes[sc.id] = ctx.price(s.estimateStoryboard(p, sc.id).providerCostMicro);
        for (const sh of sc.shots) {
          const d = s.estimateTake(p, sh.id, "draft");
          const f = s.estimateTake(p, sh.id, "final");
          shots[sh.id] = { draft: ctx.price(d.providerCostMicro), final: ctx.price(f.providerCostMicro), draftDetail: d, finalDetail: f };
        }
      }
    }
    return c.json({ castImage, script, storyboard: scenes, shots });
  });

  app.get("/projects/:pid/shots/:sid/estimate", async (c) => {
    const ctx = await resolve(c);
    const p = await project(c, ctx);
    const tier = Tier.parse(c.req.query("tier") ?? "draft");
    const image = c.req.query("image");
    const video = c.req.query("video");
    const e = ctx.studio.estimateTake(p, c.req.param("sid"), tier, { ...(image ? { image } : {}), ...(video ? { video } : {}) });
    return c.json({ ...e, paidMicro: ctx.price(e.providerCostMicro) });
  });

  // Script and episodes

  app.post("/projects/:pid/script", async (c) => {
    const ctx = await resolve(c);
    const p = await project(c, ctx);
    const b = await body(
      c,
      z.object({
        idea: z.string().min(3).max(4000),
        targetSeconds: z.number().int().min(5).max(600).optional(),
        title: z.string().max(300).optional(),
      }),
    );
    if (!p.idea)
      await ctx.studio.projects.mutate(p.id, (x) => {
        x.idea = b.idea;
      });
    const episodeId = await ctx.studio.writeScript(p.id, {
      idea: b.idea,
      ...(b.targetSeconds ? { targetSeconds: b.targetSeconds } : {}),
      ...(b.title ? { episodeTitle: b.title } : {}),
      ...(ctx.owner ? { owner: ctx.owner } : {}),
    });
    return c.json({ episodeId, ...(await view(ctx, await project(c, ctx))) });
  });

  app.post("/projects/:pid/episodes", async (c) => {
    const ctx = await resolve(c);
    const p = await project(c, ctx);
    const b = await body(c, z.object({ title: z.string().max(300).optional(), script: z.string().max(200_000).default("") }));
    const episodeId = b.script.trim()
      ? await ctx.studio.importScript(p.id, { script: b.script, ...(b.title ? { title: b.title } : {}) })
      : await ctx.studio.projects.mutate(p.id, (x) => addEpisode(x, { title: b.title || `Episode ${x.episodes.length + 1}` }).id);
    return c.json({ episodeId, ...(await view(ctx, await project(c, ctx))) }, 201);
  });

  app.patch("/projects/:pid/episodes/:eid", async (c) => {
    const ctx = await resolve(c);
    const b = await body(c, z.object({ title: z.string().max(300).optional(), script: z.string().max(200_000).optional() }));
    await mutate(c, ctx, (p) => {
      const ep = findEpisode(p, c.req.param("eid"));
      if (b.title !== undefined) ep.title = b.title;
      if (b.script !== undefined) ep.script = b.script;
    });
    return c.json(await view(ctx, await project(c, ctx)));
  });

  /** Re-reads the episode's script into scenes. Replaces the scenes and their shots. */
  app.post("/projects/:pid/episodes/:eid/parse", async (c) => {
    const ctx = await resolve(c);
    const p = await project(c, ctx);
    const ep = findEpisode(p, c.req.param("eid"));
    await ctx.studio.importScript(p.id, { script: ep.script, episodeId: ep.id });
    return c.json(await view(ctx, await project(c, ctx)));
  });

  app.delete("/projects/:pid/episodes/:eid", async (c) => {
    const ctx = await resolve(c);
    await mutate(c, ctx, (p) => {
      findEpisode(p, c.req.param("eid"));
      p.episodes = p.episodes.filter((e) => e.id !== c.req.param("eid"));
    });
    return c.json(await view(ctx, await project(c, ctx)));
  });

  app.post("/projects/:pid/episodes/:eid/scenes", async (c) => {
    const ctx = await resolve(c);
    const b = await body(
      c,
      z.object({
        heading: z.string().min(1).max(300),
        script: z.string().max(40_000).optional(),
        locationId: z.string().nullable().optional(),
      }),
    );
    await mutate(c, ctx, (p) => addScene(findEpisode(p, c.req.param("eid")), b));
    return c.json(await view(ctx, await project(c, ctx)), 201);
  });

  app.patch("/projects/:pid/scenes/:scid", async (c) => {
    const ctx = await resolve(c);
    const b = await body(
      c,
      z.object({
        heading: z.string().min(1).max(300).optional(),
        script: z.string().max(40_000).optional(),
        locationId: z.string().nullable().optional(),
      }),
    );
    await mutate(c, ctx, (p) => {
      const { scene } = findScene(p, c.req.param("scid"));
      if (b.locationId) findCast(p, b.locationId);
      Object.assign(scene, b);
    });
    return c.json(await view(ctx, await project(c, ctx)));
  });

  app.delete("/projects/:pid/scenes/:scid", async (c) => {
    const ctx = await resolve(c);
    await mutate(c, ctx, (p) => {
      const { episode } = findScene(p, c.req.param("scid"));
      episode.scenes = episode.scenes.filter((s) => s.id !== c.req.param("scid"));
    });
    return c.json(await view(ctx, await project(c, ctx)));
  });

  app.post("/projects/:pid/scenes/:scid/storyboard", async (c) => {
    const ctx = await resolve(c);
    await project(c, ctx);
    const b = await body(c, z.object({ targetSeconds: z.number().int().min(5).max(600).optional() }));
    await ctx.studio.storyboard(c.req.param("pid"), c.req.param("scid"), {
      ...(b.targetSeconds ? { targetSeconds: b.targetSeconds } : {}),
      ...(ctx.owner ? { owner: ctx.owner } : {}),
    });
    return c.json(await view(ctx, await project(c, ctx)));
  });

  // Shots

  app.post("/projects/:pid/scenes/:scid/shots", async (c) => {
    const ctx = await resolve(c);
    const b = await body(
      c,
      z.object({
        description: z.string().max(4000).default("New shot"),
        camera: z.string().max(500).optional(),
        castIds: z.array(z.string()).optional(),
        durationS: z.number().positive().max(30).default(5),
        at: z.number().int().min(0).optional(),
      }),
    );
    await mutate(c, ctx, (p) => {
      for (const id of b.castIds ?? []) findCast(p, id);
      addShot(findScene(p, c.req.param("scid")).scene, b, b.at);
    });
    return c.json(await view(ctx, await project(c, ctx)), 201);
  });

  app.patch("/projects/:pid/shots/:sid", async (c) => {
    const ctx = await resolve(c);
    const b = await body(
      c,
      z.object({
        description: z.string().max(4000).optional(),
        camera: z.string().max(500).optional(),
        castIds: z.array(z.string()).optional(),
        durationS: z.number().positive().max(30).optional(),
        audio: z.enum(["native", "tts", "none"]).optional(),
        approved: z.boolean().optional(),
        selectedTakeId: z.string().optional(),
        dialogue: z.array(Line).optional(),
        continueFromPrevious: z.boolean().optional(),
        onScreenText: z.string().max(300).optional(),
      }),
    );
    await mutate(c, ctx, (p) => updateShot(p, c.req.param("sid"), b));
    return c.json(await view(ctx, await project(c, ctx)));
  });

  app.delete("/projects/:pid/shots/:sid", async (c) => {
    const ctx = await resolve(c);
    await mutate(c, ctx, (p) => deleteShot(p, c.req.param("sid")));
    return c.json(await view(ctx, await project(c, ctx)));
  });

  app.post("/projects/:pid/shots/:sid/move", async (c) => {
    const ctx = await resolve(c);
    const b = await body(c, z.object({ sceneId: z.string(), index: z.number().int().min(0) }));
    await mutate(c, ctx, (p) => moveShot(p, c.req.param("sid"), b.sceneId, b.index));
    return c.json(await view(ctx, await project(c, ctx)));
  });

  app.post("/projects/:pid/shots/:sid/split", async (c) => {
    const ctx = await resolve(c);
    const b = await body(c, z.object({ atS: z.number().positive().optional() }));
    await mutate(c, ctx, (p) => splitShot(p, c.req.param("sid"), b.atS));
    return c.json(await view(ctx, await project(c, ctx)));
  });

  app.post("/projects/:pid/shots/:sid/merge", async (c) => {
    const ctx = await resolve(c);
    await mutate(c, ctx, (p) => mergeWithNext(p, c.req.param("sid")));
    return c.json(await view(ctx, await project(c, ctx)));
  });

  app.post("/projects/:pid/shots/:sid/takes", async (c) => {
    const ctx = await resolve(c);
    await project(c, ctx);
    const b = await body(c, z.object({ tier: Tier, image: z.string().optional(), video: z.string().optional() }));
    const take = await ctx.studio.generateTake(c.req.param("pid"), c.req.param("sid"), b.tier, {
      ...(b.image ? { image: b.image } : {}),
      ...(b.video ? { video: b.video } : {}),
      ...(ctx.owner ? { owner: ctx.owner } : {}),
    });
    return c.json({ take, ...(await view(ctx, await project(c, ctx))) }, 202);
  });

  app.post("/projects/:pid/shots/:sid/lines/:lid/tts", async (c) => {
    const ctx = await resolve(c);
    await project(c, ctx);
    await ctx.studio.generateTts(c.req.param("pid"), c.req.param("sid"), c.req.param("lid"), ctx.owner);
    return c.json(await view(ctx, await project(c, ctx)), 202);
  });

  // Cast

  app.post("/projects/:pid/cast", async (c) => {
    const ctx = await resolve(c);
    const b = await body(c, z.object({ kind: CastKind, name: z.string().min(1).max(120), description: z.string().max(4000).optional() }));
    await mutate(c, ctx, (p) => addCast(p, b));
    return c.json(await view(ctx, await project(c, ctx)), 201);
  });

  app.patch("/projects/:pid/cast/:cid", async (c) => {
    const ctx = await resolve(c);
    const b = await body(
      c,
      z.object({
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(4000).optional(),
        kind: CastKind.optional(),
        refImageIds: z.array(z.string()).optional(),
      }),
    );
    await mutate(c, ctx, (p) => {
      const m = findCast(p, c.req.param("cid"));
      if (b.refImageIds) {
        const known = new Set(m.refImageIds);
        if (b.refImageIds.some((id) => !known.has(id))) throw new EditError("Reference images can only be reordered or removed here");
      }
      Object.assign(m, b);
    });
    return c.json(await view(ctx, await project(c, ctx)));
  });

  app.delete("/projects/:pid/cast/:cid", async (c) => {
    const ctx = await resolve(c);
    await mutate(c, ctx, (p) => removeCast(p, c.req.param("cid")));
    return c.json(await view(ctx, await project(c, ctx)));
  });

  app.post("/projects/:pid/cast/:cid/generate", async (c) => {
    const ctx = await resolve(c);
    await project(c, ctx);
    await ctx.studio.generateCastImage(c.req.param("pid"), c.req.param("cid"), { ...(ctx.owner ? { owner: ctx.owner } : {}) });
    return c.json(await view(ctx, await project(c, ctx)), 202);
  });

  app.post("/projects/:pid/cast/:cid/upload", async (c) => {
    const ctx = await resolve(c);
    await project(c, ctx);
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new EditError("Attach an image as 'file'");
    if (file.size > 20 * 1024 * 1024) throw new EditError("Images must be under 20 MB");
    await ctx.studio.addCastImage(
      c.req.param("pid"),
      c.req.param("cid"),
      { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type },
      { consent: form.get("consent") === "true" },
    );
    return c.json(await view(ctx, await project(c, ctx)), 201);
  });

  // Assembly and exports

  app.post("/projects/:pid/episodes/:eid/assemble", async (c) => {
    const ctx = await resolve(c);
    await project(c, ctx);
    const b = await body(c, z.object({ source: z.enum(["final", "rough"]).default("final") }));
    return c.json(await ctx.assemble(c.req.param("pid"), c.req.param("eid"), b.source), 201);
  });

  app.get("/projects/:pid/exports", async (c) => {
    const ctx = await resolve(c);
    await project(c, ctx);
    return c.json(await ctx.listExports(c.req.param("pid")));
  });

  return app;
}

/** A project's cover: the chosen take's first frame of its earliest shot that has one, else any frame, else a cast portrait. */
export function coverOf(p: Project): string | undefined {
  const usable = (id: string | undefined) => (id && p.media.some((m) => m.id === id && !m.hidden) ? id : undefined);
  const shots = p.episodes.flatMap((e) => e.scenes.flatMap((s) => s.shots));
  for (const sh of shots) {
    const take = sh.takes.find((t) => t.id === sh.selectedTakeId);
    const id = usable(take?.frameMediaId);
    if (id) return id;
  }
  for (const sh of shots) for (const t of sh.takes) if (usable(t.frameMediaId)) return t.frameMediaId;
  for (const c of p.cast) for (const id of c.refImageIds) if (usable(id)) return id;
  return undefined;
}

/** "Shot 1.3 draft", "Cast: MAYA", "Script", for activity lines. */
function costLabel(p: Project, l: { purpose: string; shotId: string | null; castId: string | null; tier: string | null }): string {
  if (l.shotId) {
    for (const e of p.episodes)
      for (const [si, s] of e.scenes.entries()) {
        const i = s.shots.findIndex((x) => x.id === l.shotId);
        if (i >= 0) return `Shot ${si + 1}.${i + 1}${l.tier ? ` ${l.tier}` : ""}`;
      }
  }
  if (l.castId) {
    const c = p.cast.find((x) => x.id === l.castId);
    if (c) return `Cast: ${c.name}`;
  }
  const names: Record<string, string> = {
    script: "Script",
    storyboard: "Storyboard",
    parse: "Read into scenes",
    tts: "Voice line",
    assemble: "Episode",
  };
  return names[l.purpose] ?? l.purpose.replace(/_/g, " ");
}
