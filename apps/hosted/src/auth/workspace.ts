import { getCookie, setCookie } from "hono/cookie";
import type { Ctx } from "../context";
import { HttpError } from "../lib/errors";
import { WORKSPACE_COOKIE, requireUser } from "./session";

export interface Membership {
  workspaceId: string;
  name: string;
  role: "owner" | "member";
  frozen: boolean;
}

export async function memberships(c: Ctx): Promise<Membership[]> {
  const user = requireUser(c);
  const rows = await c
    .get("deps")
    .db.selectFrom("workspaceMembers as m")
    .innerJoin("workspaces as w", "w.id", "m.workspaceId")
    .select(["w.id as workspaceId", "w.name", "m.role", "w.frozenAt"])
    .where("m.userId", "=", user.id)
    .orderBy("m.createdAt")
    .execute();
  return rows.map((r) => ({ workspaceId: r.workspaceId, name: r.name, role: r.role, frozen: !!r.frozenAt }));
}

/** The workspace this request acts in: the cookie's, if the user is a member; else their first. */
export async function currentWorkspace(c: Ctx): Promise<Membership> {
  const list = await memberships(c);
  if (list.length === 0) throw new HttpError(403, "You're not in any workspace");
  const wanted = getCookie(c, WORKSPACE_COOKIE);
  return list.find((m) => m.workspaceId === wanted) ?? list[0]!;
}

export async function switchWorkspace(c: Ctx, workspaceId: string): Promise<void> {
  const list = await memberships(c);
  if (!list.some((m) => m.workspaceId === workspaceId)) throw new HttpError(404, "Workspace not found");
  setCookie(c, WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: c.get("deps").config.secureCookies,
    maxAge: 365 * 86_400,
  });
}
