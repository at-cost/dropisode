/**
 * Storage interfaces. Local implements them with plain folders on disk
 * (see folderStore.ts); hosted with Postgres and R2.
 */
import type { JobRecord } from "./providers/types";
import type { MediaRef, Project } from "./project";

export interface ProjectStore {
  get(projectId: string): Promise<Project>;
  /** Runs `fn` with exclusive access to the project and saves it after. */
  mutate<T>(projectId: string, fn: (project: Project) => T | Promise<T>): Promise<T>;
}

export interface MediaStore {
  /** Stores a file and returns its reference. The caller adds it to `project.media`. */
  put(projectId: string, file: { bytes: Uint8Array; contentType: string; source: string }): Promise<MediaRef>;
  read(projectId: string, ref: MediaRef): Promise<Uint8Array>;
  /** A path on local disk, if the store has one (saves a copy for ffmpeg). */
  localPath?(projectId: string, ref: MediaRef): string;
}

export interface JobStore {
  create(job: JobRecord): Promise<void>;
  update(id: string, patch: Partial<JobRecord>): Promise<JobRecord>;
  get(id: string): Promise<JobRecord | undefined>;
  /** Jobs that may still change: submitted, or finished but not finalized. */
  listUnfinished(projectId?: string): Promise<JobRecord[]>;
}

/** A per-key async lock, so two edits to one project never interleave. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export const extFor = (contentType: string): string =>
  ({
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "text/plain": "txt",
  })[contentType.split(";")[0]!.trim()] ?? "bin";
