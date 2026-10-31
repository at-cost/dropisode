import type { Db } from "../db";
import { uuid } from "../lib/ids";

/**
 * Finds or creates a user by verified email. A new user gets their own workspace.
 * Called after an email link or OAuth sign-in has proved the address.
 */
export async function findOrCreateUser(db: Db, p: { email: string; name?: string | null }): Promise<{ id: string; created: boolean }> {
  const email = p.email.trim().toLowerCase();
  const existing = await db.selectFrom("users").select(["id", "emailVerifiedAt"]).where("email", "=", email).executeTakeFirst();
  if (existing) {
    if (!existing.emailVerifiedAt)
      await db.updateTable("users").set({ emailVerifiedAt: new Date() }).where("id", "=", existing.id).execute();
    return { id: existing.id, created: false };
  }
  const id = uuid();
  const name = p.name?.trim() || email.split("@")[0]!;
  try {
    await create(db, id, email, name);
  } catch (err) {
    // Two confirmations for the same new email at once: the other one created it.
    const raced = await db.selectFrom("users").select("id").where("email", "=", email).executeTakeFirst();
    if (raced) return { id: raced.id, created: false };
    throw err;
  }
  return { id, created: true };
}

async function create(db: Db, id: string, email: string, name: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await tx.insertInto("users").values({ id, email, name, emailVerifiedAt: new Date() }).execute();
    const wsId = uuid();
    await tx
      .insertInto("workspaces")
      .values({ id: wsId, name: `${name}'s studio`, createdBy: id })
      .execute();
    await tx.insertInto("workspaceMembers").values({ workspaceId: wsId, userId: id, role: "owner" }).execute();
  });
}
