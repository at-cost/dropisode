/**
 * Project export and import: a zip of project.json plus its media files, the
 * same format in local and hosted, so a project moves between them unchanged.
 */
import { unzipSync, zipSync } from "fflate";
import { newId } from "./edit";
import { type MediaRef, type Project, parseProject } from "./project";
import type { MediaStore, ProjectStore } from "./stores";

/**
 * Limits for reading a zip. The whole archive is unpacked in memory, so callers
 * pick limits that fit their RAM (hosted uses much smaller ones and caps the upload).
 */
export interface ArchiveLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}
export const ARCHIVE_LIMITS: ArchiveLimits = { maxFiles: 5000, maxTotalBytes: 8 * 1024 ** 3, maxFileBytes: 2 * 1024 ** 3 };

const MEDIA_PATH = /^media\/[A-Za-z0-9_-]{1,64}\.[a-z0-9]{1,5}$/;

/** Builds the zip. Media hidden by moderation is left out (its record stays, marked hidden). */
export async function exportProject(project: Project, media: MediaStore): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const kept: MediaRef[] = [];
  for (const ref of project.media) {
    if (ref.hidden) {
      kept.push(ref);
      continue;
    }
    files[ref.path] = await media.read(project.id, ref);
    kept.push(ref);
  }
  const out: Project = { ...project, media: kept };
  files["project.json"] = new TextEncoder().encode(JSON.stringify(out, null, 2));
  // Media is already compressed; store it.
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level: k === "project.json" ? 6 : 0 }]])));
}

export interface ImportedProject {
  project: Project;
  /** Media bytes by media id, ready to put into the target store. */
  files: Map<string, Uint8Array>;
}

/** Reads and checks a zip. Throws on anything unexpected; never trusts paths in the archive. */
export function readArchive(zip: Uint8Array, limits: ArchiveLimits = ARCHIVE_LIMITS): ImportedProject {
  let total = 0;
  let count = 0;
  const entries = unzipSync(zip, {
    filter: (f) => {
      count++;
      total += f.originalSize;
      if (count > limits.maxFiles) throw new Error("Too many files in the archive");
      if (f.originalSize > limits.maxFileBytes || total > limits.maxTotalBytes) throw new Error("The archive is too large");
      return f.name === "project.json" || MEDIA_PATH.test(f.name);
    },
  });
  const raw = entries["project.json"];
  if (!raw) throw new Error("No project.json in the archive");
  const project = parseProject(JSON.parse(new TextDecoder().decode(raw)));
  const files = new Map<string, Uint8Array>();
  for (const ref of project.media) {
    if (!MEDIA_PATH.test(ref.path)) throw new Error(`Bad media path ${ref.path}`);
    const bytes = entries[ref.path];
    if (!bytes) {
      if (ref.hidden) continue;
      throw new Error(`Missing media file ${ref.path}`);
    }
    files.set(ref.id, bytes);
  }
  return { project, files };
}

/**
 * Writes an imported project into a store under a new id (so importing twice
 * never overwrites). Each media file gets the id the store gives it, and every
 * reference to it (cast images, frames, clips, voice lines, job results) is
 * remapped. The project is created first, so stores that tie media to a
 * project row can accept the files.
 */
export async function importInto(
  imported: ImportedProject,
  store: MediaStore & Pick<ProjectStore, "mutate">,
  create: (project: Project) => Promise<void> | void,
  opts: { newId?: string } = {},
): Promise<Project> {
  const project: Project = structuredClone(imported.project);
  project.id = opts.newId ?? newId("prj");
  // Jobs don't travel; a line still pending in the source is shown as such.
  for (const l of project.costLog) if (l.status === "pending") l.note = l.note || "Was still running when exported";
  for (const ep of project.episodes)
    for (const sc of ep.scenes)
      for (const sh of sc.shots)
        for (const t of sh.takes)
          if (t.status === "queued" || t.status === "running") {
            t.status = "failed";
            t.error = "Was still running when exported";
          }
  const source = project.media;
  await create({ ...project, media: [] });

  const ids = new Map<string, string>();
  const kept: MediaRef[] = [];
  for (const ref of source) {
    const bytes = imported.files.get(ref.id);
    if (!bytes) {
      kept.push(ref); // hidden by moderation in the source: the record stays, the file doesn't
      continue;
    }
    const stored = await store.put(project.id, { bytes, contentType: ref.contentType, source: ref.source });
    ids.set(ref.id, stored.id);
    kept.push({ ...ref, id: stored.id, path: stored.path, bytes: stored.bytes });
  }
  const map = (id: string | undefined) => (id && ids.has(id) ? ids.get(id)! : id);
  project.media = kept;
  for (const c of project.cast) c.refImageIds = c.refImageIds.map((id) => map(id)!);
  for (const ep of project.episodes)
    for (const sc of ep.scenes)
      for (const sh of sc.shots) {
        for (const l of sh.dialogue) if (l.ttsMediaId) l.ttsMediaId = map(l.ttsMediaId)!;
        for (const t of sh.takes) {
          if (t.frameMediaId) t.frameMediaId = map(t.frameMediaId)!;
          if (t.videoMediaId) t.videoMediaId = map(t.videoMediaId)!;
        }
      }
  return store.mutate(project.id, (p) => {
    Object.assign(p, project);
    return p;
  });
}
