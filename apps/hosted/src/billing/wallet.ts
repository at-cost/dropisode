/**
 * The wallet: a ledger (balance = sum), a hold per job, and a settlement per job.
 * All arithmetic comes from @reel/money. Every change runs in a transaction
 * that locks the workspace row first, so two jobs can't both spend the same
 * last dollar.
 */
import { type HoldDecision, type PlatformSettings, canHold, holdFor, settle } from "@reel/money";
import { sql } from "kysely";
import { type Db, num } from "../db";

export interface WalletState {
  balanceMicro: number;
  heldMicro: number;
  availableMicro: number;
}

async function lockWorkspace(tx: Db, workspaceId: string) {
  const ws = await tx
    .selectFrom("workspaces")
    .select(["id", "createdAt", "createdBy", "frozenAt", "frozenReason"])
    .where("id", "=", workspaceId)
    .forUpdate()
    .executeTakeFirst();
  if (!ws) throw new Error("No such workspace");
  return ws;
}

export async function walletState(db: Db, workspaceId: string): Promise<WalletState> {
  const bal = await db
    .selectFrom("ledger")
    .select(sql<string>`coalesce(sum(amount_micro), 0)`.as("s"))
    .where("workspaceId", "=", workspaceId)
    .executeTakeFirstOrThrow();
  const held = await db
    .selectFrom("holds")
    .select(sql<string>`coalesce(sum(amount_micro), 0)`.as("s"))
    .where("workspaceId", "=", workspaceId)
    .where("releasedAt", "is", null)
    .executeTakeFirstOrThrow();
  const balanceMicro = num(bal.s);
  const heldMicro = num(held.s);
  return { balanceMicro, heldMicro, availableMicro: balanceMicro - heldMicro };
}

/**
 * Charged today plus holds placed today and still open, across every workspace the
 * same account created (for the new-account daily cap: making more workspaces
 * doesn't raise it).
 */
async function spentToday(db: Db, creatorId: string): Promise<number> {
  const mine = db.selectFrom("workspaces").select("id").where("createdBy", "=", creatorId);
  const charged = await db
    .selectFrom("ledger")
    .select(sql<string>`coalesce(-sum(amount_micro), 0)`.as("s"))
    .where("workspaceId", "in", mine)
    .where("kind", "=", "generation")
    .where("at", ">=", sql<Date>`date_trunc('day', now())`)
    .executeTakeFirstOrThrow();
  const held = await db
    .selectFrom("holds")
    .select(sql<string>`coalesce(sum(amount_micro), 0)`.as("s"))
    .where("workspaceId", "in", mine)
    .where("releasedAt", "is", null)
    .where("createdAt", ">=", sql<Date>`date_trunc('day', now())`)
    .executeTakeFirstOrThrow();
  return num(charged.s) + num(held.s);
}

export type PlaceHold = HoldDecision & { holdMicro: number };

/** Places a hold for a job's estimate, or says why not. Idempotent per job id. */
export async function placeHold(
  db: Db,
  s: PlatformSettings,
  p: { workspaceId: string; jobId: string; estimateMicro: number },
): Promise<PlaceHold> {
  const holdMicro = holdFor(p.estimateMicro, s);
  return db.transaction().execute(async (tx) => {
    const ws = await lockWorkspace(tx, p.workspaceId);
    if (ws.frozenAt)
      return {
        ok: false,
        reason: "insufficient_balance",
        message: "This workspace is frozen while we review it. Contact support.",
        holdMicro,
      } as PlaceHold;
    const existing = await tx.selectFrom("holds").select("amountMicro").where("jobId", "=", p.jobId).executeTakeFirst();
    if (existing) return { ok: true, holdMicro: num(existing.amountMicro) };
    const w = await walletState(tx, p.workspaceId);
    // "New account" means the account that created (and pays for) the workspace. Locking it
    // serialises holds across all of that account's workspaces, so the daily cap can't be raced.
    const creator = await tx.selectFrom("users").select("createdAt").where("id", "=", ws.createdBy).forUpdate().executeTakeFirstOrThrow();
    const ageDays = (Date.now() - new Date(creator.createdAt).getTime()) / 86_400_000;
    const d = canHold({
      balanceMicro: w.balanceMicro,
      heldMicro: w.heldMicro,
      holdMicro,
      spentTodayMicro: await spentToday(tx, ws.createdBy),
      accountAgeDays: ageDays,
      settings: s,
    });
    if (!d.ok) return { ...d, holdMicro };
    await tx.insertInto("holds").values({ jobId: p.jobId, workspaceId: p.workspaceId, amountMicro: holdMicro }).execute();
    return { ok: true, holdMicro };
  });
}

/** Releases a hold without charging (the request never reached the provider). */
export async function releaseHold(db: Db, jobId: string): Promise<void> {
  await db.updateTable("holds").set({ releasedAt: new Date() }).where("jobId", "=", jobId).where("releasedAt", "is", null).execute();
}

export interface SettleInput {
  workspaceId: string;
  jobId: string;
  provider: string;
  model: string;
  succeeded: boolean;
  providerBilled: boolean;
  providerCostMicro: number;
}

/**
 * Makes the wallet match a job's outcome. The first call releases the hold and
 * charges cost × 1.2 (nothing if the provider didn't bill). A later call with a
 * different outcome (a job reopened after a late provider reply) charges or
 * credits only the difference. The same outcome twice changes nothing.
 */
export async function settleJob(db: Db, s: PlatformSettings, p: SettleInput): Promise<{ chargedMicro: number; deltaMicro: number }> {
  return db.transaction().execute(async (tx) => {
    await lockWorkspace(tx, p.workspaceId);
    const hold = await tx
      .selectFrom("holds")
      .select(["amountMicro", "releasedAt"])
      .where("jobId", "=", p.jobId)
      .where("workspaceId", "=", p.workspaceId)
      .executeTakeFirst();
    const prev = await tx
      .selectFrom("settlements")
      .selectAll()
      .where("jobId", "=", p.jobId)
      .where("workspaceId", "=", p.workspaceId)
      .executeTakeFirst();
    const target = settle(
      {
        holdMicro: hold && !hold.releasedAt ? num(hold.amountMicro) : 0,
        providerCostMicro: p.providerCostMicro,
        providerBilled: p.providerBilled,
        succeeded: p.succeeded,
      },
      s,
    ).chargeMicro;
    const before = prev ? num(prev.chargedMicro) : 0;
    const delta = target - before;
    const revision = (prev?.revision ?? 0) + 1;
    if (delta !== 0) {
      await tx
        .insertInto("ledger")
        .values({
          workspaceId: p.workspaceId,
          kind: "generation",
          amountMicro: -delta,
          ref: `${p.jobId}:${revision}`,
          jobId: p.jobId,
          provider: p.provider,
          model: p.model,
          providerCostMicro: p.providerBilled ? p.providerCostMicro : 0,
          note: prev
            ? "Corrected: the provider reported the request late"
            : p.succeeded
              ? ""
              : p.providerBilled
                ? "Failed; the provider billed it"
                : "",
        })
        .execute();
    }
    if (prev && delta === 0 && prev.providerBilled === p.providerBilled && prev.succeeded === p.succeeded)
      return { chargedMicro: target, deltaMicro: 0 };
    await tx
      .insertInto("settlements")
      .values({
        jobId: p.jobId,
        workspaceId: p.workspaceId,
        chargedMicro: target,
        providerCostMicro: p.providerCostMicro,
        providerBilled: p.providerBilled,
        succeeded: p.succeeded,
        provider: p.provider,
        model: p.model,
      })
      .onConflict((oc) =>
        oc.column("jobId").doUpdateSet({
          chargedMicro: target,
          providerCostMicro: p.providerCostMicro,
          providerBilled: p.providerBilled,
          succeeded: p.succeeded,
          revision,
          updatedAt: new Date(),
        }),
      )
      .execute();
    await tx.updateTable("holds").set({ releasedAt: new Date() }).where("jobId", "=", p.jobId).where("releasedAt", "is", null).execute();
    return { chargedMicro: target, deltaMicro: delta };
  });
}

/** Credits a paid top-up once (idempotent per payment). */
export async function creditTopup(
  db: Db,
  p: { workspaceId: string; topupId: string; amountMicro: number; note?: string },
): Promise<boolean> {
  const res = await db
    .insertInto("ledger")
    .values({ workspaceId: p.workspaceId, kind: "topup", amountMicro: p.amountMicro, ref: p.topupId, note: p.note ?? "" })
    .onConflict((oc) => oc.columns(["kind", "ref"]).doNothing())
    .executeTakeFirst();
  return Number(res.numInsertedOrUpdatedRows ?? 0) > 0;
}
