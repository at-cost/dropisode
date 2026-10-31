import { balanceLastsDays, centsToMicro, dailyCharge, daysInMonth, monthlyFixed, topupAllowed, GIB } from "@reel/money";
import { Hono } from "hono";
import { sql } from "kysely";
import { z } from "zod";
import { requireUser } from "../auth/session";
import { currentWorkspace } from "../auth/workspace";
import type { AppEnv, Deps } from "../context";
import { num } from "../db";
import { activeWorkspaceIds, fixedMonthlyMicro } from "../finances";
import { HttpError } from "../lib/errors";
import type { PaymentReversal } from "./gateway";
import { uuid } from "../lib/ids";
import { storageBytes } from "./daily";
import { creditTopup, walletState } from "./wallet";

/** What today's daily charge would be for a workspace (for "your balance lasts N days"). */
export async function projectedDaily(deps: Deps, workspaceId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const active = await activeWorkspaceIds(deps.db, today);
  const bytes = await storageBytes(deps.db, workspaceId);
  const m = monthlyFixed({
    settings: deps.platform,
    fixedMonthlyMicro: fixedMonthlyMicro(deps.fixedCosts),
    activeWorkspaces: Math.max(1, active.size),
    storageGb: bytes / GIB,
    active: active.has(workspaceId),
  });
  return dailyCharge(m, daysInMonth(today)).totalMicro;
}

export const billingRoutes = new Hono<AppEnv>();

billingRoutes.get("/", async (c) => {
  const deps = c.get("deps");
  const ws = await currentWorkspace(c);
  const w = await walletState(deps.db, ws.workspaceId);
  const ledger = await deps.db
    .selectFrom("ledger")
    .select(["at", "kind", "amountMicro", "ref", "jobId", "provider", "model", "providerCostMicro", "note"])
    .where("workspaceId", "=", ws.workspaceId)
    .orderBy("at", "desc")
    .limit(200)
    .execute();
  const daily = await projectedDaily(deps, ws.workspaceId);
  return c.json({
    workspace: ws,
    billingEnabled: deps.config.BILLING_ENABLED,
    ...w,
    dailyMicro: daily,
    lastsDays: balanceLastsDays(w.balanceMicro, daily),
    minTopupUsd: deps.platform.minTopupUsd,
    maxTopupUsd: deps.platform.maxTopupUsd,
    ledger: ledger.map((l) => ({
      ...l,
      amountMicro: num(l.amountMicro),
      providerCostMicro: l.providerCostMicro === null ? null : num(l.providerCostMicro),
    })),
  });
});

billingRoutes.post("/topup", async (c) => {
  const deps = c.get("deps");
  const user = requireUser(c);
  const ws = await currentWorkspace(c);
  if (!deps.config.BILLING_ENABLED || !deps.payments) throw new HttpError(503, "Top-ups aren't open yet");
  // Accept "10" as well as 10: the preset buttons post their amount from a hidden field.
  const b = z.object({ amountUsd: z.coerce.number().finite() }).parse(await c.req.json());
  if (!topupAllowed(deps.platform, b.amountUsd))
    throw new HttpError(400, `Top-ups are $${deps.platform.minTopupUsd} to $${deps.platform.maxTopupUsd}`);
  const u = await deps.db.selectFrom("users").select(["emailVerifiedAt"]).where("id", "=", user.id).executeTakeFirstOrThrow();
  if (!u.emailVerifiedAt) throw new HttpError(403, "Verify your email before your first top-up");
  const row = await deps.db
    .selectFrom("workspaces")
    .select(["stripeCustomerId", "frozenAt"])
    .where("id", "=", ws.workspaceId)
    .executeTakeFirstOrThrow();
  if (row.frozenAt) throw new HttpError(403, "This workspace is frozen while we review it");
  const payments = deps.payments;
  /** A Stripe outage or misconfiguration: say so plainly; nothing has been charged at this point. */
  const stripe = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      console.error(`reel: Stripe ${what} failed:`, (err as Error).message);
      throw new HttpError(502, "Payments are unavailable right now. Nothing was charged. Try again in a few minutes.");
    }
  };
  const customerId = await stripe("customer", () =>
    payments.ensureCustomer({
      existingId: row.stripeCustomerId,
      workspaceId: ws.workspaceId,
      email: user.email,
      name: ws.name,
    }),
  );
  if (!row.stripeCustomerId)
    await deps.db.updateTable("workspaces").set({ stripeCustomerId: customerId }).where("id", "=", ws.workspaceId).execute();
  const topupId = uuid();
  const amountCents = Math.round(b.amountUsd * 100);
  await deps.db
    .insertInto("topups")
    .values({ id: topupId, workspaceId: ws.workspaceId, userId: user.id, amountCents, status: "pending" })
    .execute();
  const base = deps.config.APP_URL.replace(/\/$/, "");
  const session = await stripe("checkout", async () => {
    try {
      return await payments.createTopupCheckout({
        customerId,
        amountCents,
        workspaceId: ws.workspaceId,
        topupId,
        successUrl: `${base}/billing?paid=1`,
        cancelUrl: `${base}/billing`,
      });
    } catch (err) {
      await deps.db.updateTable("topups").set({ status: "failed" }).where("id", "=", topupId).execute();
      throw err;
    }
  });
  await deps.db.updateTable("topups").set({ checkoutSessionId: session.id }).where("id", "=", topupId).execute();
  return c.json({ url: session.url });
});

/** Stripe → Dropisode. Credits the wallet once per paid top-up. */
export const stripeWebhook = new Hono<AppEnv>();
stripeWebhook.post("/", async (c) => {
  const deps = c.get("deps");
  if (!deps.payments) return c.text("Billing is off", 503);
  const raw = await c.req.text();
  let done: Awaited<ReturnType<NonNullable<Deps["payments"]>["parseWebhook"]>>;
  try {
    done = await deps.payments.parseWebhook(raw, c.req.header("stripe-signature") ?? "");
  } catch {
    return c.text("Bad signature", 400);
  }
  if (done && done.kind !== undefined && done.kind !== "checkout") {
    // Not finding the top-up must never drop a refund or chargeback: answer 500 so Stripe retries.
    if (!(await reverseTopup(deps, done as PaymentReversal))) return c.text("Top-up not found yet; retry", 500);
    return c.json({ ok: true });
  }
  if (!done || !("paid" in done) || !done.paid) return c.json({ ok: true });
  const topup = await deps.db.selectFrom("topups").selectAll().where("id", "=", done.topupId).executeTakeFirst();
  if (!topup || topup.workspaceId !== done.workspaceId || topup.amountCents !== done.amountCents) return c.text("Unknown top-up", 400);
  await deps.db
    .updateTable("topups")
    .set({ status: "paid", paidAt: new Date(), paymentIntentId: done.paymentIntentId })
    .where("id", "=", topup.id)
    .where("status", "=", "pending")
    .execute();
  await creditTopup(deps.db, {
    workspaceId: topup.workspaceId,
    topupId: topup.id,
    amountMicro: centsToMicro(topup.amountCents),
    note: "Top-up",
  });
  if (done.paymentIntentId) {
    const fee = await deps.payments.fetchFee(done.paymentIntentId).catch(() => null);
    if (fee !== null) await deps.db.updateTable("topups").set({ feeCents: fee }).where("id", "=", topup.id).execute();
  }
  return c.json({ ok: true });
});

/**
 * A refund or chargeback after a top-up takes that credit back out of the wallet
 * (the balance may go negative, which blocks new generations). A dispute also
 * freezes the workspace until an admin looks at it; a won dispute gives the
 * credit back (the workspace stays frozen until an admin unfreezes it).
 * Never takes back more than the top-up paid in, whatever order events arrive in.
 */
async function reverseTopup(deps: Deps, r: PaymentReversal): Promise<boolean> {
  const found =
    (r.topupId ? await deps.db.selectFrom("topups").select("id").where("id", "=", r.topupId).executeTakeFirst() : undefined) ??
    (await deps.db.selectFrom("topups").select("id").where("paymentIntentId", "=", r.paymentIntentId).executeTakeFirst());
  if (!found) return false;
  await deps.db.transaction().execute(async (tx) => {
    const topup = await tx.selectFrom("topups").selectAll().where("id", "=", found.id).forUpdate().executeTakeFirstOrThrow();
    if (!topup.paymentIntentId && r.paymentIntentId)
      await tx.updateTable("topups").set({ paymentIntentId: r.paymentIntentId }).where("id", "=", topup.id).execute();
    const paidMicro = centsToMicro(topup.amountCents);
    const prior = await tx
      .selectFrom("ledger")
      .select(["ref", "amountMicro"])
      .where("kind", "=", "stripe_refund")
      .where((eb) =>
        eb.or([
          eb("ref", "like", `refund:${topup.id}:%`),
          eb("ref", "like", `dispute:${topup.id}:%`),
          eb("ref", "like", `dispute_won:${topup.id}:%`),
        ]),
      )
      .execute();
    const reversed = -prior.reduce((a, l) => a + num(l.amountMicro), 0);
    const refunded = -prior.filter((l) => l.ref.startsWith("refund:")).reduce((a, l) => a + num(l.amountMicro), 0);
    const add = async (ref: string, amountMicro: number, note: string) => {
      if (amountMicro === 0) return;
      await tx
        .insertInto("ledger")
        .values({ workspaceId: topup.workspaceId, kind: "stripe_refund", amountMicro, ref, note })
        .onConflict((oc) => oc.columns(["kind", "ref"]).doNothing())
        .execute();
    };
    if (r.kind === "refund") {
      // Refund events carry the running total for the charge; debit only what's new.
      const delta = Math.min(centsToMicro(r.amountCents) - refunded, paidMicro - reversed);
      if (delta > 0) await add(`refund:${topup.id}:${r.ref}`, -delta, "Top-up refunded");
      if (r.amountCents >= topup.amountCents)
        await tx.updateTable("topups").set({ status: "refunded" }).where("id", "=", topup.id).execute();
    } else if (r.kind === "dispute") {
      await add(
        `dispute:${topup.id}:${r.ref}`,
        -Math.max(0, Math.min(centsToMicro(r.amountCents), paidMicro - reversed)),
        "Card payment disputed",
      );
      await tx
        .updateTable("workspaces")
        .set({ frozenAt: new Date(), frozenReason: `Card payment disputed (${r.ref})` })
        .where("id", "=", topup.workspaceId)
        .where("frozenAt", "is", null)
        .execute();
      await tx
        .insertInto("adminLog")
        .values({
          adminUserId: null,
          action: "auto_freeze_dispute",
          target: topup.workspaceId,
          details: JSON.stringify({ dispute: r.ref, amountCents: r.amountCents }),
        })
        .execute();
    } else {
      // Won: return exactly what the dispute took.
      const taken = -prior.filter((l) => l.ref === `dispute:${topup.id}:${r.ref}`).reduce((a, l) => a + num(l.amountMicro), 0);
      await add(`dispute_won:${topup.id}:${r.ref}`, taken, "Dispute won: credit restored");
      await tx
        .insertInto("adminLog")
        .values({
          adminUserId: null,
          action: "dispute_won",
          target: topup.workspaceId,
          details: JSON.stringify({ dispute: r.ref, restoredMicro: taken }),
        })
        .execute();
    }
  });
  return true;
}
