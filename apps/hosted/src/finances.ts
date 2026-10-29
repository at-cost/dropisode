/**
 * Fixed costs (config/fixed-costs.json) and the live numbers behind the public
 * finances page. Everything is computed from the ledger and the same @reel/money
 * functions billing uses.
 */
import { readFileSync } from "node:fs";
import { fixedShareMicro, type PlatformSettings, usdToMicro } from "@reel/money";
import { sql } from "kysely";
import { z } from "zod";
import { type Db, num } from "./db";

const FixedCostsFile = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      monthlyUsd: z.number().nonnegative(),
      source: z.string().url(),
      status: z.string(),
      notes: z.string().optional(),
    }),
  ),
});
export type FixedCosts = z.infer<typeof FixedCostsFile>;

export function loadFixedCosts(path = new URL("../config/fixed-costs.json", import.meta.url)): FixedCosts {
  return FixedCostsFile.parse(JSON.parse(readFileSync(path, "utf8")));
}

export const fixedMonthlyMicro = (f: FixedCosts): number => f.items.reduce((a, i) => a + usdToMicro(i.monthlyUsd), 0);

/** Workspaces that generated something in the calendar month of `day` (YYYY-MM-DD). Only these pay a share. */
export async function activeWorkspaceIds(db: Db, day: string): Promise<Set<string>> {
  const rows = await db
    .selectFrom("settlements")
    .select("workspaceId")
    .distinct()
    .where(sql<boolean>`date_trunc('month', updated_at) = date_trunc('month', ${day}::date)`)
    .where("providerBilled", "=", true)
    .execute();
  return new Set(rows.map((r) => r.workspaceId));
}

export interface FinancesSummary {
  month: string;
  topupsMicro: number;
  topupCount: number;
  /** Refunds and lost disputes, net of disputes won. */
  paymentReversalsMicro: number;
  stripeFeesMicro: number;
  generation: { provider: string; model: string; jobs: number; providerCostMicro: number; chargedMicro: number }[];
  refunds: { count: number; releasedMicro: number };
  failedBilled: number;
  dailyChargesMicro: number;
  fixed: { items: FixedCosts["items"]; monthlyMicro: number };
  activeWorkspaces: number;
  currentShareMicro: number;
  shareCapMicro: number;
  /** Money taken in minus money paid out to providers and fixed costs (all time). */
  reserveMicro: number;
  reconciliation: { provider: string; month: string; invoiceMicro: number; recordedMicro: number; differenceMicro: number }[];
}

export async function financesSummary(db: Db, s: PlatformSettings, fixed: FixedCosts, now = new Date()): Promise<FinancesSummary> {
  const month = now.toISOString().slice(0, 7);
  const monthStart = `${month}-01`;
  const topups = await db
    .selectFrom("topups")
    .select([
      sql<string>`coalesce(sum(amount_cents), 0)`.as("cents"),
      sql<string>`count(*)`.as("n"),
      sql<string>`coalesce(sum(fee_cents), 0)`.as("fees"),
    ])
    .where("status", "in", ["paid", "refunded"])
    .executeTakeFirstOrThrow();
  const reversals = await db
    .selectFrom("ledger")
    .select(sql<string>`coalesce(-sum(amount_micro), 0)`.as("s"))
    .where("kind", "=", "stripe_refund")
    .executeTakeFirstOrThrow();
  const gen = await db
    .selectFrom("settlements")
    .select([
      "provider",
      "model",
      sql<string>`count(*)`.as("jobs"),
      sql<string>`coalesce(sum(case when provider_billed then provider_cost_micro else 0 end), 0)`.as("cost"),
      sql<string>`coalesce(sum(charged_micro), 0)`.as("charged"),
    ])
    .groupBy(["provider", "model"])
    .orderBy("provider")
    .orderBy("model")
    .execute();
  const refunds = await db
    .selectFrom("settlements as st")
    .innerJoin("holds as h", "h.jobId", "st.jobId")
    .select([sql<string>`count(*)`.as("n"), sql<string>`coalesce(sum(h.amount_micro), 0)`.as("released")])
    .where("st.succeeded", "=", false)
    .where("st.providerBilled", "=", false)
    .executeTakeFirstOrThrow();
  const failedBilled = await db
    .selectFrom("settlements")
    .select(sql<string>`count(*)`.as("n"))
    .where("succeeded", "=", false)
    .where("providerBilled", "=", true)
    .executeTakeFirstOrThrow();
  const daily = await db.selectFrom("dailyCharges").select(sql<string>`coalesce(sum(total_micro), 0)`.as("s")).executeTakeFirstOrThrow();
  const active = await activeWorkspaceIds(db, monthStart);
  const fixedMonthly = fixedMonthlyMicro(fixed);
  const genCost = gen.reduce((a, g) => a + num(g.cost), 0);
  const genCharged = gen.reduce((a, g) => a + num(g.charged), 0);
  const firstMonth = await db.selectFrom("ledger").select(sql<string | null>`min(at)::date::text`.as("d")).executeTakeFirstOrThrow();
  const monthsRunning = firstMonth.d ? Math.max(1, monthsBetween(firstMonth.d, now)) : 0;
  const invoices = await db.selectFrom("providerInvoices").selectAll().orderBy("month", "desc").limit(12).execute();
  const reconciliation = await Promise.all(
    invoices.map(async (inv) => {
      const rec = await db
        .selectFrom("settlements")
        .select(sql<string>`coalesce(sum(case when provider_billed then provider_cost_micro else 0 end), 0)`.as("s"))
        .where("provider", "=", inv.provider)
        .where(sql<boolean>`to_char(updated_at, 'YYYY-MM') = ${inv.month}`)
        .executeTakeFirstOrThrow();
      return {
        provider: inv.provider,
        month: inv.month,
        invoiceMicro: num(inv.amountMicro),
        recordedMicro: num(rec.s),
        differenceMicro: num(inv.amountMicro) - num(rec.s),
      };
    }),
  );
  const fees = num(topups.fees) * 10_000;
  return {
    month,
    topupsMicro: num(topups.cents) * 10_000,
    topupCount: num(topups.n),
    paymentReversalsMicro: num(reversals.s),
    stripeFeesMicro: fees,
    generation: gen.map((g) => ({
      provider: g.provider,
      model: g.model,
      jobs: num(g.jobs),
      providerCostMicro: num(g.cost),
      chargedMicro: num(g.charged),
    })),
    refunds: { count: num(refunds.n), releasedMicro: num(refunds.released) },
    failedBilled: num(failedBilled.n),
    dailyChargesMicro: num(daily.s),
    fixed: { items: fixed.items, monthlyMicro: fixedMonthly },
    activeWorkspaces: active.size,
    currentShareMicro: fixedShareMicro(s, fixedMonthly, active.size),
    shareCapMicro: usdToMicro(s.shareCapUsd),
    // Charges earned minus what providers billed, Stripe fees and fixed costs to date.
    reserveMicro: genCharged - genCost + num(daily.s) - fees - fixedMonthly * monthsRunning,
    reconciliation,
  };
}

function monthsBetween(fromDay: string, now: Date): number {
  const [y, m] = fromDay.split("-").map(Number) as [number, number];
  return (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m) + 1;
}
