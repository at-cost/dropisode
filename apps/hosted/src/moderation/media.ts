/**
 * Hiding and unhiding a media file: the media row (signed URLs refuse hidden
 * files) and the project doc's MediaRef.hidden (the studio, exports and
 * assembly skip it) change together in one transaction.
 */
import type { Db } from "../db";

interface DocMedia {
  id: string;
  hidden?: boolean;
}

export async function setMediaHidden(
  db: Db,
  mediaId: string,
  hide: { reason: string } | null,
): Promise<{ workspaceId: string; projectId: string } | null> {
  return db.transaction().execute(async (tx) => {
    const row = await tx
      .selectFrom("media")
      .select(["id", "workspaceId", "projectId"])
      .where("id", "=", mediaId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return null;
    await tx
      .updateTable("media")
      .set(hide ? { hiddenAt: new Date(), hiddenReason: hide.reason.slice(0, 500) } : { hiddenAt: null, hiddenReason: null })
      .where("id", "=", mediaId)
      .execute();
    const project = await tx
      .selectFrom("projects")
      .select("doc")
      .where("id", "=", row.projectId)
      .where("workspaceId", "=", row.workspaceId)
      .forUpdate()
      .executeTakeFirst();
    if (project) {
      const doc = project.doc as { media?: DocMedia[] };
      const ref = doc.media?.find((m) => m.id === mediaId);
      if (ref) {
        if (hide) ref.hidden = true;
        else delete ref.hidden;
        await tx
          .updateTable("projects")
          .set({ doc: JSON.stringify(doc) })
          .where("id", "=", row.projectId)
          .where("workspaceId", "=", row.workspaceId)
          .execute();
      }
    }
    return { workspaceId: row.workspaceId, projectId: row.projectId };
  });
}
