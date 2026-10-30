/**
 * The nightly charge: (min(cap, fixed / active) + storage) × 1.2 / days in month,
 * per workspace, from @reel/money. Then low-balance emails. Idempotent per day.
 */
import { balanceLastsDays, dailyCharge, daysInMonth, formatUsd, GIB, monthlyFixed } from "@reel/money";
import { sql } from "kysely";
import type { Deps } from "../context";
import { num } from "../db";
import { activeWorkspaceIds, fixedMonthlyMicro } from "../finances";
import { walletState } from "./wallet";

/**
 * Bytes a workspace is charged for (media + exports of projects it hasn't deleted).
 * Files of deleted projects are not charged; purging them from storage is a
 * retention decision for the owner (see docs/HARDENING.md).
 */
export async function storageBytes(db: Deps["db"], workspaceId: string): Promise<number> {
  const live = (table: "media" | "exports") =>
    db
      .selectFrom(`${table} as x` as "media as x")
      .innerJoin("projects as p", "p.id", "x.projectId")
      .select(sql<string>`coalesce(sum(x.bytes), 0)`.as("b"))
      .where("x.workspaceId", "=", workspaceId)
      .where("x.deletedAt", "is", null)
      .where("p.deletedAt", "is", null)
      .executeTakeFirstOrThrow();
  const [m, e] = await Promise.all([live("media"), live("exports")]);
  return num(m.b) + num(e.b);
}

export interface DailyResult {
  day: string;
  charged: number;
  emails: number;
}

/** Charges every workspace for `day` (YYYY-MM-DD, normally yesterday). Safe to run twice. */
export async function runDailyCharges(deps: Deps, day: string): Promise<DailyResult> {
  const fixed = fixedMonthlyMicro(deps.fixedCosts);
  const active = await activeWorkspaceIds(deps.db, day);
  const days = daysInMonth(day);
  const monthStart = `${day.slice(0, 7)}-01`;
  const workspaces = await deps.db.selectFrom("workspaces").select(["id"]).where(sql<boolean>`created_at::date <= ${day}::date`).execute();
  let charged = 0;
  let emails = 0;
  for (const ws of workspaces) {
    try {
      const r = await chargeWorkspaceDay(deps, ws.id, day, { fixed, active, days, monthStart });
      if (r.charged) charged++;
      emails += r.emails;
    } catch (err) {
      // One workspace's failure (e.g. email) must not stop the others; its day is retried next run.
      console.warn(`reel daily charge ${ws.id} ${day}: ${(err as Error).message}`);
    }
  }
  return { day, charged, emails };
}

async function chargeWorkspaceDay(
  deps: Deps,
  wsId: string,
  day: string,
  ctx: { fixed: number; active: Set<string>; days: number; monthStart: string },
): Promise<{ charged: boolean; emails: number }> {
  const { fixed, active, days, monthStart } = ctx;
  const ws = { id: wsId };
  const storageGb = (await storageBytes(deps.db, ws.id)) / GIB;
  const isActive = active.has(ws.id);
  const month = monthlyFixed({
    settings: deps.platform,
    fixedMonthlyMicro: fixed,
    activeWorkspaces: active.size,
    storageGb,
    active: isActive,
  });
  const d = dailyCharge(month, days);
  // An active workspace pays the share for the whole month, so earlier days of the month
  // charged before it first generated are caught up (storage for those days is already paid).
  const shareOnly = dailyCharge(
    monthlyFixed({ settings: deps.platform, fixedMonthlyMicro: fixed, activeWorkspaces: active.size, storageGb: 0, active: true }),
    days,
  );
  const result = await deps.db.transaction().execute(async (tx) => {
    const res = await tx
      .insertInto("dailyCharges")
      .values({
        workspaceId: ws.id,
        day,
        active: isActive,
        storageGb: storageGb.toFixed(6),
        fixedShareMicro: d.fixedShareMicro,
        storageMicro: d.storageMicro,
        markupMicro: d.markupMicro,
        totalMicro: d.totalMicro,
      })
      .onConflict((oc) => oc.columns(["workspaceId", "day"]).doNothing())
      .executeTakeFirst();
    if (Number(res.numInsertedOrUpdatedRows ?? 0) === 0) return null;
    let total = d.totalMicro;
    if (d.totalMicro > 0) {
      await tx
        .insertInto("ledger")
        .values({
          workspaceId: ws.id,
          kind: "daily",
          amountMicro: -d.totalMicro,
          ref: `${ws.id}:${day}`,
          note: `${day}: fixed share ${formatUsd(d.fixedShareMicro, { precise: true })}, storage ${storageGb.toFixed(2)} GB ${formatUsd(d.storageMicro, { precise: true })}, +20% ${formatUsd(d.markupMicro, { precise: true })}`,
        })
        .execute();
    }
    if (isActive && shareOnly.totalMicro > 0) {
      const earlier = await tx
        .updateTable("dailyCharges")
        .set({
          active: true,
          fixedShareMicro: sql`fixed_share_micro + ${shareOnly.fixedShareMicro}`,
          markupMicro: sql`markup_micro + ${shareOnly.markupMicro}`,
          totalMicro: sql`total_micro + ${shareOnly.totalMicro}`,
        })
        .where("workspaceId", "=", ws.id)
        .where("active", "=", false)
        .where("day", ">=", monthStart)
        .where("day", "<", day)
        .returning("day")
        .execute();
      if (earlier.length > 0) {
        const amount = shareOnly.totalMicro * earlier.length;
        total += amount;
        await tx
          .insertInto("ledger")
          .values({
            workspaceId: ws.id,
            kind: "daily",
            amountMicro: -amount,
            ref: `${ws.id}:${day}:catch-up`,
            note: `Fixed share for ${earlier.length} earlier day(s) this month: this workspace generated in ${day.slice(0, 7)}, so it pays the month's share`,
          })
          .execute();
      }
    }
    return total;
  });
  if (result === null) {
    // Already charged; still make sure the balance email went out (it may have failed last time).
    return { charged: false, emails: await lowBalanceEmails(deps, ws.id, d.totalMicro, day) };
  }
  if (result <= 0) return { charged: false, emails: 0 };
  return { charged: true, emails: await lowBalanceEmails(deps, ws.id, d.totalMicro, day) };
}

/**
 * Charges every day any workspace hasn't been charged for yet, up to yesterday,
 * so a worker that was down (or a day that failed part-way) is caught up.
 * Looks back at most 62 days.
 */
export async function runDueDailyCharges(deps: Deps, now = new Date()): Promise<DailyResult[]> {
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const floor = new Date(now.getTime() - 62 * 86_400_000).toISOString().slice(0, 10);
  const due = await sql<{ day: string }>`
    SELECT d::date::text AS day
    FROM generate_series(${floor}::date, ${yesterday}::date, interval '1 day') AS d
    WHERE EXISTS (
      SELECT 1 FROM workspaces w
      WHERE w.created_at::date <= d::date
        AND NOT EXISTS (SELECT 1 FROM daily_charges c WHERE c.workspace_id = w.id AND c.day = d::date)
    )
    ORDER BY 1`.execute(deps.db);
  const out: DailyResult[] = [];
  for (const { day } of due.rows) out.push(await runDailyCharges(deps, day));
  return out;
}

/** Warns at 7 days of storage credit left and at zero, once each per low spell. */
export async function lowBalanceEmails(deps: Deps, workspaceId: string, dailyTotalMicro: number, day: string): Promise<number> {
  const w = await walletState(deps.db, workspaceId);
  const left = balanceLastsDays(w.balanceMicro, dailyTotalMicro);
  let kind: "low" | "zero" | null = null;
  if (w.balanceMicro <= 0) kind = "zero";
  else if (left !== null && left <= deps.platform.lowBalanceDays) kind = "low";
  if (!kind) return 0;
  // One email per kind until the next top-up: the ref includes the last top-up id.
  const lastTopup = await deps.db
    .selectFrom("ledger")
    .select("ref")
    .where("workspaceId", "=", workspaceId)
    .where("kind", "=", "topup")
    .orderBy("at", "desc")
    .limit(1)
    .executeTakeFirst();
  const ref = `${workspaceId}:${lastTopup?.ref ?? "none"}`;
  const seen = await deps.db
    .selectFrom("emailLog")
    .select("ref")
    .where("kind", "=", `balance_${kind}`)
    .where("ref", "=", ref)
    .executeTakeFirst();
  if (seen) return 0;
  const owners = await deps.db
    .selectFrom("workspaceMembers as m")
    .innerJoin("users as u", "u.id", "m.userId")
    .select("u.email")
    .where("m.workspaceId", "=", workspaceId)
    .where("m.role", "=", "owner")
    .execute();
  const url = `${deps.config.APP_URL.replace(/\/$/, "")}/billing`;
  const text =
    kind === "zero"
      ? `Your Dropisode balance is ${formatUsd(w.balanceMicro)}. New generations are paused until you top up. Nothing has been deleted: your projects and files are safe, and storage keeps accruing at a few cents a day.\n\nTop up: ${url}\n\nWe will email you before any data is ever removed.`
      : `Your Dropisode balance is ${formatUsd(w.balanceMicro)}, about ${left} days of storage and fixed charges. Generations are charged separately when you make them.\n\nTop up: ${url}`;
  for (const o of owners)
    await deps.mailer.send({ to: o.email, subject: kind === "zero" ? "Your Dropisode balance has run out" : "Your Dropisode balance is low", text });
  // Logged only once sent, so a mail failure is retried on the next run.
  await deps.db
    .insertInto("emailLog")
    .values({ kind: `balance_${kind}`, ref, workspaceId })
    .onConflict((oc) => oc.columns(["kind", "ref"]).doNothing())
    .execute();
  void day;
  return owners.length;
}
