/**
 * The studio for one workspace: core's Studio over Postgres + object storage,
 * with the provider wrapped from the outside: moderation, then billing, then fal.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BlockedError,
  FalProvider,
  type JobOutcome,
  type JobRecord,
  type MediaStore,
  MockProvider,
  type Provider,
  type ProviderInput,
  Studio,
  assembleEpisode,
  createProject,
  exportProject,
  importInto,
  newId,
  readArchive,
} from "@reel/core";
import type { ExportInfo, StudioContext } from "@reel/studio";
import { sql } from "kysely";
import { BilledProvider } from "./billing/provider";
import { walletState } from "./billing/wallet";
import type { Config } from "./config";
import { type BalanceMonitor, balanceMonitor } from "./billing/providerBalance";
import type { Deps } from "./context";
import { hmac } from "./lib/ids";
import { HttpError } from "./lib/errors";
import type { Moderation } from "./moderation/types";
import { exportKey } from "./storage";
import { WorkspaceStores } from "./stores";
import { generationCharge } from "@reel/money";

export type ProviderFactory = () => Provider;

/** The raw provider for this server. One mock instance is shared so its queued requests survive between requests. */
export function providerFactory(config: Config, catalog: Deps["catalog"]): ProviderFactory {
  if (config.PROVIDER === "mock") {
    const mock = new MockProvider({ delayMs: config.NODE_ENV === "test" ? 0 : 1500 });
    return () => mock;
  }
  const fal = new FalProvider({ key: config.FAL_KEY, catalog, ...(config.FAL_BILLING_KEY ? { billingKey: config.FAL_BILLING_KEY } : {}) });
  const funded = new FundedProvider(fal, balanceMonitor(config));
  return () => funded;
}

/** Sends nothing to fal while its prepaid credit is known to be empty. */
export class FundedProvider implements Provider {
  readonly id: string;
  readonly lookupCost?: (job: JobRecord) => Promise<{ costMicro: number } | null>;
  constructor(
    private inner: Provider,
    private balance: BalanceMonitor,
  ) {
    this.id = inner.id;
    if (inner.lookupCost) this.lookupCost = (j) => inner.lookupCost!(j);
  }
  async submit(job: JobRecord, input: ProviderInput, opts?: { webhookUrl?: string }) {
    await this.balance.ensureFunded();
    return this.inner.submit(job, input, opts);
  }
  check(job: JobRecord) {
    return this.inner.check(job);
  }
  download(url: string) {
    return this.inner.download(url);
  }
  finalize(job: JobRecord, outcome: JobOutcome) {
    return this.inner.finalize?.(job, outcome) ?? Promise.resolve();
  }
}

/** Moderation runs first, so a blocked request never places a hold or reaches the provider. */
export class ModeratedProvider implements Provider {
  readonly id: string;
  readonly lookupCost?: (job: JobRecord) => Promise<{ costMicro: number } | null>;
  constructor(
    private inner: Provider,
    private moderation: Moderation,
  ) {
    this.id = inner.id;
    if (inner.lookupCost) this.lookupCost = (j) => inner.lookupCost!(j);
  }
  async submit(job: JobRecord, input: ProviderInput, opts?: { webhookUrl?: string }) {
    const texts = [input.prompt, input.text, input.negativePrompt].filter((t): t is string => !!t?.trim());
    const images = [...(input.image ? [input.image] : []), ...(input.images ?? [])];
    const v = await this.moderation.check({
      workspaceId: job.owner!.workspaceId!,
      userId: job.owner?.userId,
      stage: `generation:${job.purpose}`,
      texts,
      images,
    });
    if (!v.ok) throw new BlockedError(v.message, "moderation");
    return this.inner.submit(job, input, opts);
  }
  check(job: JobRecord) {
    return this.inner.check(job);
  }
  download(url: string) {
    return this.inner.download(url);
  }
  finalize(job: JobRecord, outcome: JobOutcome) {
    return this.inner.finalize?.(job, outcome) ?? Promise.resolve();
  }
}

export function webhookUrl(config: Config, job: JobRecord): string | undefined {
  // fal can't reach localhost or private addresses; those servers poll instead.
  if (config.PROVIDER !== "fal" || !config.webhookBase.startsWith("https://")) return undefined;
  return `${config.webhookBase}/webhooks/fal?job=${encodeURIComponent(job.id)}&sig=${hmac(config.APP_SECRET, `fal:${job.id}`)}`;
}

export function workspaceStudio(
  deps: Deps,
  workspaceId: string,
  userId?: string,
): { studio: Studio; stores: WorkspaceStores; media: MediaStore } {
  const stores = new WorkspaceStores(deps.db, deps.blobs, workspaceId);
  // Uploaded reference photos are moderated before they are stored.
  const media: MediaStore = {
    put: async (projectId, file) => {
      if (file.source === "upload") {
        const v = await deps.moderation.check({
          workspaceId,
          userId,
          stage: "upload",
          texts: [],
          images: [
            {
              bytes: file.bytes,
              contentType: file.contentType,
              name: `upload.${file.contentType.split("/")[1] ?? "bin"}`,
              origin: "upload",
            },
          ],
        });
        if (!v.ok) throw new BlockedError(v.message, "moderation");
      }
      return stores.put(projectId, file);
    },
    read: (projectId, ref) => stores.read(projectId, ref),
  };
  const provider = new ModeratedProvider(
    new BilledProvider(deps.provider(), deps.db, deps.platform, { billingEnabled: deps.config.BILLING_ENABLED }),
    deps.moderation,
  );
  const studio = new Studio({
    projects: stores,
    media,
    jobs: stores.jobs,
    provider,
    catalog: deps.catalog,
    webhookUrl: (job) => webhookUrl(deps.config, job),
    // Every request, webhook and worker builds its own runner: serialise work on a job in Postgres.
    lock: (jobId, fn) =>
      deps.locks.connection().execute(async (conn) => {
        await sql`SELECT pg_advisory_lock(hashtextextended(${`job:${jobId}`}, 0))`.execute(conn);
        try {
          return await fn();
        } finally {
          await sql`SELECT pg_advisory_unlock(hashtextextended(${`job:${jobId}`}, 0))`.execute(conn);
        }
      }),
    log: (msg, err) => console.warn(`reel[${workspaceId}]: ${msg}${err ? `: ${(err as Error).message ?? err}` : ""}`),
  });
  return { studio, stores, media };
}

/** Hosted limits for project imports: the zip is unpacked in memory. */
const IMPORT_LIMITS = { maxFiles: 3000, maxTotalBytes: 1024 ** 3, maxFileBytes: 512 * 1024 ** 2 };

export function hostedStudioContext(deps: Deps, workspaceId: string, userId: string): StudioContext {
  const { studio, stores, media } = workspaceStudio(deps, workspaceId, userId);
  const ttl = deps.config.MEDIA_URL_TTL;
  const signExport = async (projectId: string, row: { id: string; info: unknown }): Promise<ExportInfo> => {
    const { mediaIds: _ids, ...info } = row.info as ExportInfo & { mediaIds?: string[] };
    const files = await Promise.all(
      info.files.map(async (f) => ({
        ...f,
        url: await deps.blobs.signedUrl(
          exportKey(workspaceId, projectId, row.id, f.name),
          // Long enough to watch an episode through; the player re-fetches links if one still lapses.
          Math.max(ttl, 3600),
          f.name.endsWith(".mp4") ? {} : { download: f.name.split("/").pop()! },
        ),
      })),
    );
    return { ...info, files };
  };
  return {
    studio,
    mode: "hosted",
    price: (micro) => generationCharge(micro, deps.platform),
    priceLabel: `Price you pay: provider cost + ${Math.round(deps.platform.markup * 100)}%`,
    owner: { workspaceId, userId },
    listProjects: () => stores.list(),
    createProject: async (p) => {
      const project = createProject(p);
      await stores.create(project);
      return project;
    },
    deleteProject: (id) => stores.softDelete(id),
    assertProject: async (id) => {
      if (!(await stores.exists(id))) throw new HttpError(404, "Project not found");
    },
    // Imported files go through the same upload moderation as new uploads.
    importArchive: async (zip) =>
      importInto(readArchive(zip, IMPORT_LIMITS), { ...media, mutate: (id, fn) => stores.mutate(id, fn) }, (p) => stores.create(p)),
    exportArchive: async (id) => exportProject(await stores.get(id), stores),
    serveMedia: async (c, projectId, ref) => c.redirect(await stores.signedMediaUrl(projectId, ref.id, ttl), 302),
    assemble: async (projectId, episodeId, source) => {
      // Nothing unreviewed goes into an episode people can download and share.
      if (deps.moderation.reviewsOutputs) {
        const pending = await deps.db
          .selectFrom("media")
          .select(sql<string>`count(*)`.as("n"))
          .where("workspaceId", "=", workspaceId)
          .where("projectId", "=", projectId)
          .where("moderatedAt", "is", null)
          .where("deletedAt", "is", null)
          .executeTakeFirstOrThrow();
        if (Number(pending.n) > 0) throw new HttpError(409, "Some new clips are still being checked. Try again in a minute.");
      }
      const id = newId("x");
      const outDir = mkdtempSync(join(tmpdir(), "reel-export-"));
      try {
        const res = await assembleEpisode({ projects: stores, media: stores }, projectId, episodeId, { source, outDir });
        const names = listFiles(outDir);
        let bytes = 0;
        const files = [];
        for (const name of names) {
          const data = readFileSync(join(outDir, name));
          bytes += data.byteLength;
          await deps.blobs.put(exportKey(workspaceId, projectId, id, name), data, contentTypeOf(name));
          files.push({ name, url: "", bytes: data.byteLength });
        }
        const info: ExportInfo = {
          id,
          episodeId,
          createdAt: new Date().toISOString(),
          source,
          durationS: res.durationS,
          files,
          skipped: res.skipped,
          warnings: res.warnings,
        };
        // Which media went in, so the export is withdrawn if any of it is hidden later.
        const project = await stores.get(projectId);
        const shotsById = new Map(project.episodes.flatMap((e) => e.scenes.flatMap((sc) => sc.shots)).map((sh) => [sh.id, sh]));
        const mediaIds = res.shots.flatMap((s) => {
          const sh = shotsById.get(s.shotId);
          const take = sh?.takes.find((t) => t.id === s.takeId);
          return [take?.videoMediaId, ...(sh?.dialogue.map((l) => l.ttsMediaId) ?? [])].filter((x): x is string => !!x);
        });
        await deps.db
          .insertInto("exports")
          .values({ id, workspaceId, projectId, info: JSON.stringify({ ...info, mediaIds }), bytes })
          .execute();
        return signExport(projectId, { id, info });
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    listExports: async (projectId) => {
      const rows = await deps.db
        .selectFrom("exports")
        .select(["id", "info"])
        .where("workspaceId", "=", workspaceId)
        .where("projectId", "=", projectId)
        .where("deletedAt", "is", null)
        .orderBy("createdAt", "desc")
        .limit(50)
        .execute();
      const hidden = new Set(
        (
          await deps.db
            .selectFrom("media")
            .select("id")
            .where("workspaceId", "=", workspaceId)
            .where("projectId", "=", projectId)
            .where("hiddenAt", "is not", null)
            .execute()
        ).map((r) => r.id),
      );
      const visible = rows.filter((r) => !((r.info as { mediaIds?: string[] }).mediaIds ?? []).some((m) => hidden.has(m)));
      return Promise.all(visible.map((r) => signExport(projectId, r)));
    },
    account: async () => {
      const u = await deps.db.selectFrom("users").select(["name", "email"]).where("id", "=", userId).executeTakeFirstOrThrow();
      const ws = await deps.db.selectFrom("workspaces").select("name").where("id", "=", workspaceId).executeTakeFirstOrThrow();
      return { name: u.name, email: u.email, workspace: ws.name, isAdmin: deps.config.adminEmails.includes(u.email.toLowerCase()) };
    },
    wallet: async () => {
      const w = await walletState(deps.db, workspaceId);
      const ws = await deps.db.selectFrom("workspaces").select(["frozenAt"]).where("id", "=", workspaceId).executeTakeFirst();
      const blocked = !!ws?.frozenAt || w.availableMicro <= 0 || !deps.config.BILLING_ENABLED;
      return {
        balanceMicro: w.balanceMicro,
        heldMicro: w.heldMicro,
        blocked,
        ...(ws?.frozenAt
          ? { message: "This workspace is frozen while we review it." }
          : w.availableMicro <= 0
            ? { message: "Top up to generate. Your projects are safe." }
            : {}),
      };
    },
  };
}

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out.sort();
}

const contentTypeOf = (name: string) =>
  name.endsWith(".mp4")
    ? "video/mp4"
    : name.endsWith(".json")
      ? "application/json"
      : name.endsWith(".srt") || name.endsWith(".edl")
        ? "text/plain; charset=utf-8"
        : "application/octet-stream";
