/**
 * Projects as plain folders on disk:
 *
 *   <root>/<project id>/project.json
 *   <root>/<project id>/media/<media id>.<ext>
 *   <root>/<project id>/jobs/<job id>.json
 *   <root>/<project id>/exports/...
 *
 * Writes go to a temp file and are renamed into place, so a crash never leaves
 * half a project.json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { newId } from "./edit";
import { type MediaRef, type Project, parseProject } from "./project";
import type { JobRecord } from "./providers/types";
import { type JobStore, KeyedMutex, type MediaStore, type ProjectStore, extFor } from "./stores";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function writeAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export class FolderStore implements ProjectStore, MediaStore {
  private lock = new KeyedMutex();
  readonly root: string;
  readonly jobs: FolderJobs;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    this.jobs = new FolderJobs(this);
  }

  dir(projectId: string): string {
    if (!ID.test(projectId)) throw new Error("Bad project id");
    return join(this.root, projectId);
  }

  list(): Project[] {
    const out: Project[] = [];
    for (const name of readdirSync(this.root)) {
      const file = join(this.root, name, "project.json");
      if (!ID.test(name) || !existsSync(file)) continue;
      try {
        out.push(parseProject(JSON.parse(readFileSync(file, "utf8"))));
      } catch {
        // A folder that isn't a valid project is skipped, not deleted.
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  exists(projectId: string): boolean {
    return existsSync(join(this.dir(projectId), "project.json"));
  }

  /** Writes a new project. Fails if the id is taken. */
  create(project: Project): void {
    const dir = this.dir(project.id);
    if (existsSync(join(dir, "project.json"))) throw new Error(`Project ${project.id} already exists`);
    mkdirSync(join(dir, "media"), { recursive: true });
    mkdirSync(join(dir, "jobs"), { recursive: true });
    writeAtomic(join(dir, "project.json"), JSON.stringify(project, null, 2));
  }

  async get(projectId: string): Promise<Project> {
    const file = join(this.dir(projectId), "project.json");
    if (!existsSync(file)) throw new Error(`No project ${projectId}`);
    return parseProject(JSON.parse(readFileSync(file, "utf8")));
  }

  mutate<T>(projectId: string, fn: (project: Project) => T | Promise<T>): Promise<T> {
    return this.lock.run(`p:${projectId}`, async () => {
      const project = await this.get(projectId);
      const out = await fn(project);
      project.updatedAt = new Date().toISOString();
      parseProject(project);
      writeAtomic(join(this.dir(projectId), "project.json"), JSON.stringify(project, null, 2));
      return out;
    });
  }

  // Media

  async put(projectId: string, file: { bytes: Uint8Array; contentType: string; source: string }): Promise<MediaRef> {
    const id = newId("m");
    const path = `media/${id}.${extFor(file.contentType)}`;
    const dir = this.dir(projectId);
    mkdirSync(join(dir, "media"), { recursive: true });
    writeAtomic(join(dir, path), file.bytes);
    return {
      id,
      path,
      contentType: file.contentType,
      bytes: file.bytes.byteLength,
      createdAt: new Date().toISOString(),
      source: file.source,
    };
  }

  async read(projectId: string, ref: MediaRef): Promise<Uint8Array> {
    return readFileSync(this.localPath(projectId, ref));
  }

  localPath(projectId: string, ref: MediaRef): string {
    const dir = this.dir(projectId);
    const full = resolve(dir, ref.path);
    if (!full.startsWith(dir + sep)) throw new Error("Media path escapes the project folder");
    return full;
  }
}

/** Job records as one JSON file each, inside the project folder. */
export class FolderJobs implements JobStore {
  private lock = new KeyedMutex();
  /** Job id -> project id, filled as jobs are created or listed. */
  private index = new Map<string, string>();

  constructor(private store: FolderStore) {}

  private file(id: string, projectId: string): string {
    if (!ID.test(id)) throw new Error("Bad job id");
    return join(this.store.dir(projectId), "jobs", `${id}.json`);
  }

  private projectOf(id: string): string | undefined {
    const known = this.index.get(id);
    if (known) return known;
    for (const name of readdirSync(this.store.root)) {
      if (ID.test(name) && existsSync(join(this.store.root, name, "jobs", `${id}.json`))) {
        this.index.set(id, name);
        return name;
      }
    }
    return undefined;
  }

  async create(job: JobRecord): Promise<void> {
    mkdirSync(join(this.store.dir(job.projectId), "jobs"), { recursive: true });
    const file = this.file(job.id, job.projectId);
    if (existsSync(file)) throw new Error(`Job ${job.id} already exists`);
    writeAtomic(file, JSON.stringify(job, null, 2));
    this.index.set(job.id, job.projectId);
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const projectId = this.projectOf(id);
    if (!projectId) return undefined;
    const file = this.file(id, projectId);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as JobRecord) : undefined;
  }

  update(id: string, patch: Partial<JobRecord>): Promise<JobRecord> {
    return this.lock.run(id, async () => {
      const job = await this.get(id);
      if (!job) throw new Error(`No job ${id}`);
      const next: JobRecord = { ...job, ...patch, id: job.id, projectId: job.projectId, updatedAt: new Date().toISOString() };
      writeAtomic(this.file(id, job.projectId), JSON.stringify(next, null, 2));
      return next;
    });
  }

  async listUnfinished(projectId?: string): Promise<JobRecord[]> {
    const projects = projectId ? [projectId] : readdirSync(this.store.root).filter((n) => ID.test(n));
    const out: JobRecord[] = [];
    for (const p of projects) {
      const dir = join(this.store.root, p, "jobs");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        let job: JobRecord;
        try {
          job = JSON.parse(readFileSync(join(dir, f), "utf8")) as JobRecord;
        } catch {
          // A damaged job file must not stop recovery of every other job.
          console.warn(`reel: skipping unreadable job file ${join(dir, f)}`);
          continue;
        }
        this.index.set(job.id, p);
        if (isUnfinished(job)) out.push(job);
      }
    }
    return out;
  }
}

export const isUnfinished = (job: JobRecord): boolean =>
  job.state === "created" || job.state === "submitted" || ((job.state === "done" || job.state === "failed") && (!job.finalized || job.followedUp === false));
