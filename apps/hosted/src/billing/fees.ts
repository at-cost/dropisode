import type { Deps } from "../context";

/**
 * Fills in Stripe fees that weren't known when the payment was confirmed (Stripe settles the
 * balance transaction a little later). Runs from the worker; looks back 14 days.
 */
export async function backfillFees(deps: Deps, limit = 20): Promise<number> {
  if (!deps.payments) return 0;
  const rows = await deps.db
    .selectFrom("topups")
    .select(["id", "paymentIntentId"])
    .where("status", "in", ["paid", "refunded"])
    .where("feeCents", "is", null)
    .where("paymentIntentId", "is not", null)
    .where("createdAt", ">", new Date(Date.now() - 14 * 86_400_000))
    .orderBy("createdAt")
    .limit(limit)
    .execute();
  let filled = 0;
  for (const r of rows) {
    const fee = await deps.payments.fetchFee(r.paymentIntentId!).catch(() => null);
    if (fee === null) continue;
    await deps.db.updateTable("topups").set({ feeCents: fee }).where("id", "=", r.id).where("feeCents", "is", null).execute();
    filled++;
  }
  return filled;
}
