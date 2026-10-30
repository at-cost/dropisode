/**
 * Workspaces, members and invites. Every function acts on a workspace the
 * signed-in user is a member of (checked through memberships()), and owner-only
 * actions check the role. Members are free: there are no seats.
 */
import { requireUser } from "../auth/session";
import { type Membership, currentWorkspace, memberships, switchWorkspace } from "../auth/workspace";
import type { Ctx } from "../context";
import type { Db } from "../db";
import { HttpError, forbidden, notFound } from "../lib/errors";
import { newToken, sha256, uuid } from "../lib/ids";

export const INVITE_DAYS = 7;

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: "owner" | "member";
  joinedAt: Date;
}

export interface PendingInvite {
  id: string;
  email: string;
  invitedBy: string;
  expiresAt: Date;
  createdAt: Date;
}

/** The current workspace, or null when the user is in none (e.g. after being removed). */
export async function maybeCurrent(c: Ctx): Promise<Membership | null> {
  const list = await memberships(c);
  return list.length ? currentWorkspace(c) : null;
}

function requireOwner(ws: Membership): void {
  if (ws.role !== "owner") throw forbidden("Only owners can do that");
}

export async function listMembers(db: Db, workspaceId: string): Promise<Member[]> {
  const rows = await db
    .selectFrom("workspaceMembers as m")
    .innerJoin("users as u", "u.id", "m.userId")
    .select(["u.id as userId", "u.email", "u.name", "m.role", "m.createdAt as joinedAt"])
    .where("m.workspaceId", "=", workspaceId)
    .where("u.deletedAt", "is", null)
    .orderBy("m.createdAt")
    .execute();
  return rows;
}

export async function accountState(c: Ctx) {
  const user = requireUser(c);
  const list = await memberships(c);
  const ws = list.length ? await currentWorkspace(c) : null;
  return {
    user: { id: user.id, email: user.email, name: user.name },
    memberships: list,
    workspace: ws,
    members: ws ? await listMembers(c.get("deps").db, ws.workspaceId) : [],
  };
}

async function addWorkspace(db: Db, userId: string, name: string): Promise<string> {
  const id = uuid();
  await db.transaction().execute(async (tx) => {
    await tx.insertInto("workspaces").values({ id, name, createdBy: userId }).execute();
    await tx.insertInto("workspaceMembers").values({ workspaceId: id, userId, role: "owner" }).execute();
  });
  return id;
}

/** A new workspace; the creator is its owner and it becomes the current one. */
export async function createWorkspace(c: Ctx, name: string): Promise<string> {
  const user = requireUser(c);
  const id = await addWorkspace(c.get("deps").db, user.id, name);
  await switchWorkspace(c, id);
  return id;
}

export async function renameWorkspace(c: Ctx, name: string): Promise<void> {
  const ws = await currentWorkspace(c);
  requireOwner(ws);
  await c.get("deps").db.updateTable("workspaces").set({ name }).where("id", "=", ws.workspaceId).execute();
}

export async function createInvite(c: Ctx, email: string): Promise<{ id: string; token: string; url: string }> {
  const deps = c.get("deps");
  const user = requireUser(c);
  const ws = await currentWorkspace(c);
  requireOwner(ws);
  const already = await deps.db
    .selectFrom("workspaceMembers as m")
    .innerJoin("users as u", "u.id", "m.userId")
    .select("u.id")
    .where("m.workspaceId", "=", ws.workspaceId)
    .where("u.email", "=", email)
    .executeTakeFirst();
  if (already) throw new HttpError(409, "They're already a member");
  const token = newToken();
  const id = uuid();
  await deps.db
    .insertInto("invites")
    .values({
      id,
      workspaceId: ws.workspaceId,
      email,
      tokenHash: sha256(token),
      invitedBy: user.id,
      expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
    })
    .execute();
  const url = `${deps.config.APP_URL.replace(/\/$/, "")}/invite/${token}`;
  await deps.mailer.send({
    to: email,
    subject: `${user.name} invited you to ${ws.name} on Dropisode`,
    text: `${user.name} (${user.email}) invited you to join "${ws.name}" on Dropisode.\n\nJoin here: ${url}\n\nSign in with this email address (${email}). The link expires in ${INVITE_DAYS} days.\nIf you don't know them, ignore this email.`,
  });
  return { id, token, url };
}

export async function pendingInvites(c: Ctx): Promise<PendingInvite[]> {
  const ws = await currentWorkspace(c);
  requireOwner(ws);
  return c
    .get("deps")
    .db.selectFrom("invites")
    .select(["id", "email", "invitedBy", "expiresAt", "createdAt"])
    .where("workspaceId", "=", ws.workspaceId)
    .where("acceptedAt", "is", null)
    .where("expiresAt", ">", new Date())
    .orderBy("createdAt", "desc")
    .execute();
}

export async function revokeInvite(c: Ctx, inviteId: string): Promise<void> {
  const ws = await currentWorkspace(c);
  requireOwner(ws);
  const r = await c
    .get("deps")
    .db.deleteFrom("invites")
    .where("id", "=", inviteId)
    .where("workspaceId", "=", ws.workspaceId)
    .where("acceptedAt", "is", null)
    .executeTakeFirst();
  if (Number(r.numDeletedRows) === 0) throw notFound("Invite not found");
}

/**
 * Removes a member from the current workspace. Owners can remove anyone;
 * anyone can remove themselves (leave). The last owner can't go.
 */
export async function removeMember(c: Ctx, targetUserId: string): Promise<{ left: boolean }> {
  const deps = c.get("deps");
  const user = requireUser(c);
  const ws = await currentWorkspace(c);
  const self = targetUserId === user.id;
  if (!self) requireOwner(ws);
  await deps.db.transaction().execute(async (tx) => {
    // Lock the workspace so two owners can't both leave at once.
    await tx.selectFrom("workspaces").select("id").where("id", "=", ws.workspaceId).forUpdate().executeTakeFirstOrThrow();
    const target = await tx
      .selectFrom("workspaceMembers")
      .select("role")
      .where("workspaceId", "=", ws.workspaceId)
      .where("userId", "=", targetUserId)
      .executeTakeFirst();
    if (!target) throw notFound("Member not found");
    if (target.role === "owner") {
      const owners = await tx
        .selectFrom("workspaceMembers")
        .select("userId")
        .where("workspaceId", "=", ws.workspaceId)
        .where("role", "=", "owner")
        .execute();
      if (owners.length <= 1) throw new HttpError(400, "A workspace needs an owner. Make someone else an owner first.");
    }
    await tx.deleteFrom("workspaceMembers").where("workspaceId", "=", ws.workspaceId).where("userId", "=", targetUserId).execute();
    // Nobody is left without a workspace: give them a fresh one of their own.
    const left = await tx.selectFrom("workspaceMembers").select("workspaceId").where("userId", "=", targetUserId).executeTakeFirst();
    if (!left) {
      const u = await tx.selectFrom("users").select("name").where("id", "=", targetUserId).executeTakeFirstOrThrow();
      const id = uuid();
      await tx
        .insertInto("workspaces")
        .values({ id, name: `${u.name}'s studio`, createdBy: targetUserId })
        .execute();
      await tx.insertInto("workspaceMembers").values({ workspaceId: id, userId: targetUserId, role: "owner" }).execute();
    }
  });
  return { left: self };
}

/** Owners can make members owners, or owners members (never the last owner). */
export async function setRole(c: Ctx, targetUserId: string, role: "owner" | "member"): Promise<void> {
  const deps = c.get("deps");
  const ws = await currentWorkspace(c);
  requireOwner(ws);
  await deps.db.transaction().execute(async (tx) => {
    await tx.selectFrom("workspaces").select("id").where("id", "=", ws.workspaceId).forUpdate().executeTakeFirstOrThrow();
    const target = await tx
      .selectFrom("workspaceMembers")
      .select("role")
      .where("workspaceId", "=", ws.workspaceId)
      .where("userId", "=", targetUserId)
      .executeTakeFirst();
    if (!target) throw notFound("Member not found");
    if (target.role === role) return;
    if (role === "member") {
      const owners = await tx
        .selectFrom("workspaceMembers")
        .select("userId")
        .where("workspaceId", "=", ws.workspaceId)
        .where("role", "=", "owner")
        .execute();
      if (owners.length <= 1) throw new HttpError(400, "A workspace needs an owner");
    }
    await tx
      .updateTable("workspaceMembers")
      .set({ role })
      .where("workspaceId", "=", ws.workspaceId)
      .where("userId", "=", targetUserId)
      .execute();
  });
}

/** An open invite by its token, with the workspace name. */
export async function inviteByToken(db: Db, token: string) {
  return db
    .selectFrom("invites as i")
    .innerJoin("workspaces as w", "w.id", "i.workspaceId")
    .select(["i.id", "i.workspaceId", "i.email", "i.expiresAt", "i.acceptedAt", "w.name as workspaceName"])
    .where("i.tokenHash", "=", sha256(token))
    .executeTakeFirst();
}

/** Joins the invite's workspace as a member. The signed-in email must match the invite. */
export async function acceptInvite(c: Ctx, token: string): Promise<{ workspaceId: string }> {
  const deps = c.get("deps");
  const user = requireUser(c);
  const inv = await inviteByToken(deps.db, token);
  if (!inv || inv.acceptedAt || new Date(inv.expiresAt) <= new Date()) throw notFound("This invite is used, expired or doesn't exist");
  if (inv.email.toLowerCase() !== user.email.toLowerCase())
    throw forbidden(`This invite is for ${inv.email}. Sign in with that email to join.`);
  await deps.db.transaction().execute(async (tx) => {
    const r = await tx
      .updateTable("invites")
      .set({ acceptedAt: new Date() })
      .where("id", "=", inv.id)
      .where("acceptedAt", "is", null)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) throw notFound("This invite is already used");
    await tx
      .insertInto("workspaceMembers")
      .values({ workspaceId: inv.workspaceId, userId: user.id, role: "member" })
      .onConflict((oc) => oc.columns(["workspaceId", "userId"]).doNothing())
      .execute();
  });
  await switchWorkspace(c, inv.workspaceId);
  return { workspaceId: inv.workspaceId };
}
