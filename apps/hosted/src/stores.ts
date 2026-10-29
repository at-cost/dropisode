/**
 * Postgres + object storage implementations of core's store interfaces.
 * Every instance is bound to one workspace and every query filters by it:
 * a project, media file or job from another workspace is simply not found.
 */
import {
  type JobRecord,
  type JobStore,
  type MediaRef,
  type MediaStore,
  type Project,
  type ProjectStore,
  extFor,
  newId,
  parseProject,
} from "@reel/core";
import { sql } from "kysely";
import type { Db } from "./db";
import { HttpError } from "./lib/errors";
import { type BlobStore, mediaKey } from "./storage";

const isUnfinished = (j: JobRecord) =>
  j.state === "created" ||
  j.state === "submitted" ||
  ((j.state === "done" || j.state === "failed") && (!j.finalized || j.followedUp === false));

export class WorkspaceStores implements ProjectStore, MediaStore {
  constructor(
    readonly db: Db,
    readonly blobs: BlobStore,
    readonly workspaceId: string,
  ) {}

  // Projects

  async list(): Promise<Project[]> {
    const rows = await this.db
      .selectFrom("projects")
      .select("doc")
      .where("workspaceId", "=", this.workspaceId)
      .where("deletedAt", "is", null)
      .orderBy("updatedAt", "desc")
      .execute();
    return rows.map((r) => parseProject(r.doc));
  }

  async create(project: Project): Promise<void> {
    parseProject(project);
    await this.db
      .insertInto("projects")
      .values({ id: project.id, workspaceId: this.workspaceId, name: project.name, doc: JSON.stringify(project) })
      .execute();
  }

  async exists(projectId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("projects")
      .select("id")
      .where("id", "=", projectId)
      .where("workspaceId", "=", this.workspaceId)
      .where("deletedAt", "is", null)
      .executeTakeFirst();
    return !!row;
  }

  async get(projectId: string): Promise<Project> {
    const row = await this.db
      .selectFrom("projects")
      .select("doc")
      .where("id", "=", projectId)
      .where("workspaceId", "=", this.workspaceId)
      .where("deletedAt", "is", null)
      .executeTakeFirst();
    if (!row) throw new HttpError(404, "Project not found");
    return parseProject(row.doc);
  }

  async mutate<T>(projectId: string, fn: (project: Project) => T | Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("projects")
        .select("doc")
        .where("id", "=", projectId)
        .where("workspaceId", "=", this.workspaceId)
        .where("deletedAt", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new HttpError(404, "Project not found");
      const project = parseProject(row.doc);
      const out = await fn(project);
      project.updatedAt = new Date().toISOString();
      parseProject(project);
      await tx
        .updateTable("projects")
        .set({ doc: JSON.stringify(project), name: project.name, updatedAt: new Date() })
        .where("id", "=", projectId)
        .where("workspaceId", "=", this.workspaceId)
        .execute();
      return out;
    });
  }

  /** Soft delete: media is removed from storage by the retention job, never immediately. */
  async softDelete(projectId: string): Promise<void> {
    await this.db
      .updateTable("projects")
      .set({ deletedAt: new Date() })
      .where("id", "=", projectId)
      .where("workspaceId", "=", this.workspaceId)
      .execute();
  }

  // Media

  async put(projectId: string, file: { bytes: Uint8Array; contentType: string; source: string }): Promise<MediaRef> {
    if (!(await this.exists(projectId))) throw new HttpError(404, "Project not found");
    const id = newId("m");
    const name = `${id}.${extFor(file.contentType)}`;
    const key = mediaKey(this.workspaceId, projectId, name);
    await this.blobs.put(key, file.bytes, file.contentType);
    await this.db
      .insertInto("media")
      .values({
        id,
        workspaceId: this.workspaceId,
        projectId,
        storageKey: key,
        contentType: file.contentType,
        bytes: file.bytes.byteLength,
        source: file.source,
      })
      .execute();
    return {
      id,
      path: `media/${name}`,
      contentType: file.contentType,
      bytes: file.bytes.byteLength,
      createdAt: new Date().toISOString(),
      source: file.source,
    };
  }

  /** The storage key of a media file in this workspace, or 404. */
  async mediaRow(projectId: string, mediaId: string) {
    const row = await this.db
      .selectFrom("media")
      .select(["storageKey", "contentType", "hiddenAt"])
      .where("id", "=", mediaId)
      .where("projectId", "=", projectId)
      .where("workspaceId", "=", this.workspaceId)
      .where("deletedAt", "is", null)
      .executeTakeFirst();
    if (!row) throw new HttpError(404, "Not found");
    return row;
  }

  async read(projectId: string, ref: MediaRef): Promise<Uint8Array> {
    const row = await this.mediaRow(projectId, ref.id);
    return this.blobs.get(row.storageKey);
  }

  async signedMediaUrl(projectId: string, mediaId: string, ttlS: number): Promise<string> {
    const row = await this.mediaRow(projectId, mediaId);
    if (row.hiddenAt) throw new HttpError(404, "Not found");
    return this.blobs.signedUrl(row.storageKey, ttlS);
  }

  // Jobs

  async createJob(job: JobRecord): Promise<void> {
    await this.db
      .insertInto("jobs")
      .values({
        id: job.id,
        workspaceId: this.workspaceId,
        projectId: job.projectId,
        state: job.state,
        unfinished: isUnfinished(job),
        record: JSON.stringify(job),
      })
      .execute();
  }

  async getJob(id: string): Promise<JobRecord | undefined> {
    const row = await this.db
      .selectFrom("jobs")
      .select("record")
      .where("id", "=", id)
      .where("workspaceId", "=", this.workspaceId)
      .executeTakeFirst();
    return row ? (row.record as JobRecord) : undefined;
  }

  async updateJob(id: string, patch: Partial<JobRecord>): Promise<JobRecord> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("jobs")
        .select("record")
        .where("id", "=", id)
        .where("workspaceId", "=", this.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new Error(`No job ${id}`);
      const cur = row.record as JobRecord;
      const next: JobRecord = JSON.parse(
        JSON.stringify({ ...cur, ...patch, id: cur.id, projectId: cur.projectId, updatedAt: new Date().toISOString() }),
      );
      await tx
        .updateTable("jobs")
        .set({ record: JSON.stringify(next), state: next.state, unfinished: isUnfinished(next), updatedAt: new Date() })
        .where("id", "=", id)
        .where("workspaceId", "=", this.workspaceId)
        .execute();
      return next;
    });
  }

  async listUnfinished(projectId?: string): Promise<JobRecord[]> {
    let q = this.db.selectFrom("jobs").select("record").where("workspaceId", "=", this.workspaceId).where("unfinished", "=", true);
    if (projectId) q = q.where("projectId", "=", projectId);
    return (await q.execute()).map((r) => r.record as JobRecord);
  }

  /** The JobStore view of this object (core's JobStore names clash with ProjectStore's). */
  get jobs(): JobStore {
    return {
      create: (j) => this.createJob(j),
      get: (id) => this.getJob(id),
      update: (id, p) => this.updateJob(id, p),
      listUnfinished: (pid) => this.listUnfinished(pid),
    };
  }
}

/** Workspaces with jobs that may still change, for the worker. */
export async function workspacesWithOpenJobs(db: Db): Promise<string[]> {
  const rows = await db
    .selectFrom("jobs")
    .select(sql<string>`DISTINCT workspace_id`.as("workspaceId"))
    .where("unfinished", "=", true)
    .execute();
  return rows.map((r) => r.workspaceId);
}

/** Finds which workspace a job belongs to (webhooks carry only the job id). */
export async function jobWorkspace(db: Db, jobId: string): Promise<string | undefined> {
  const row = await db.selectFrom("jobs").select("workspaceId").where("id", "=", jobId).executeTakeFirst();
  return row?.workspaceId;
}
