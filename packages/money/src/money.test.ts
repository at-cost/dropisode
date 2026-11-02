import { Catalog, estimate } from "@reel/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLATFORM,
  EXAMPLE_PLAN,
  assertCapNotIncreased,
  balanceLastsDays,
  calculatorTable,
  canHold,
  dailyCharge,
  daysInMonth,
  distribute,
  episodeCost,
  fixedShareMicro,
  formatUsd,
  generationCharge,
  holdFor,
  monthlyFixed,
  platformSettings,
  settle,
  usdToMicro,
} from "./index";

const catalog = Catalog.load();
const S = platformSettings(catalog.config.services);

describe("generation charges", () => {
  it("is provider cost × 1.2, rounded to the micro-dollar", () => {
    expect(generationCharge(560_000, S)).toBe(672_000);
    expect(generationCharge(1, S)).toBe(1);
    expect(generationCharge(0, S)).toBe(0);
    expect(generationCharge(-5, S)).toBe(0);
    expect(holdFor(250_000, S)).toBe(300_000);
  });

  it("settles a success at the real cost and releases the rest of the hold", () => {
    expect(settle({ holdMicro: 300_000, providerCostMicro: 200_000, providerBilled: true, succeeded: true }, S)).toEqual({
      chargeMicro: 240_000,
      releaseMicro: 60_000,
      refunded: false,
    });
  });

  it("charges the real cost even when the estimate was low", () => {
    expect(settle({ holdMicro: 100_000, providerCostMicro: 200_000, providerBilled: true, succeeded: true }, S)).toEqual({
      chargeMicro: 240_000,
      releaseMicro: 0,
      refunded: false,
    });
  });

  it("releases the whole hold on a failure the provider didn't bill, and marks it a refund", () => {
    expect(settle({ holdMicro: 300_000, providerCostMicro: 0, providerBilled: false, succeeded: false }, S)).toEqual({
      chargeMicro: 0,
      releaseMicro: 300_000,
      refunded: true,
    });
  });

  it("charges a failure the provider billed", () => {
    expect(settle({ holdMicro: 300_000, providerCostMicro: 250_000, providerBilled: true, succeeded: false }, S)).toEqual({
      chargeMicro: 300_000,
      releaseMicro: 0,
      refunded: false,
    });
  });
});

describe("holds", () => {
  const base = { balanceMicro: usdToMicro(10), heldMicro: 0, spentTodayMicro: 0, accountAgeDays: 30, settings: S };
  it("blocks a hold the available balance can't cover", () => {
    expect(canHold({ ...base, holdMicro: usdToMicro(10) })).toEqual({ ok: true });
    expect(canHold({ ...base, holdMicro: usdToMicro(10) + 1 })).toMatchObject({ ok: false, reason: "insufficient_balance" });
    expect(canHold({ ...base, heldMicro: usdToMicro(9), holdMicro: usdToMicro(2) })).toMatchObject({
      ok: false,
      reason: "insufficient_balance",
    });
    expect(canHold({ ...base, balanceMicro: -100, holdMicro: 1 })).toMatchObject({ ok: false });
  });

  it("caps new accounts at $50 a day for 7 days", () => {
    const rich = { ...base, balanceMicro: usdToMicro(500) };
    expect(canHold({ ...rich, accountAgeDays: 2, spentTodayMicro: usdToMicro(49), holdMicro: usdToMicro(1) })).toEqual({ ok: true });
    expect(canHold({ ...rich, accountAgeDays: 2, spentTodayMicro: usdToMicro(49), holdMicro: usdToMicro(1) + 1 })).toMatchObject({
      ok: false,
      reason: "daily_cap",
    });
    expect(canHold({ ...rich, accountAgeDays: 7, spentTodayMicro: usdToMicro(49), holdMicro: usdToMicro(100) })).toEqual({ ok: true });
  });
});

describe("daily charges", () => {
  it("shares fixed costs among active workspaces, capped at $4", () => {
    expect(fixedShareMicro(S, usdToMicro(100), 10)).toBe(usdToMicro(4));
    expect(fixedShareMicro(S, usdToMicro(100), 50)).toBe(usdToMicro(2));
    expect(fixedShareMicro(S, usdToMicro(100), 0)).toBe(usdToMicro(4));
  });

  it("charges inactive workspaces storage only", () => {
    const m = monthlyFixed({ settings: S, fixedMonthlyMicro: usdToMicro(100), activeWorkspaces: 50, storageGb: 10, active: false });
    expect(m).toEqual({ fixedShareMicro: 0, storageMicro: 150_000, subtotalMicro: 150_000, markupMicro: 30_000, totalMicro: 180_000 });
  });

  it("splits a month into days whose lines always add up", () => {
    const m = monthlyFixed({ settings: S, fixedMonthlyMicro: usdToMicro(97.31), activeWorkspaces: 37, storageGb: 12.345, active: true });
    expect(m.subtotalMicro + m.markupMicro).toBe(m.totalMicro);
    const d = dailyCharge(m, 31);
    expect(d.fixedShareMicro + d.storageMicro + d.markupMicro).toBe(d.totalMicro);
    expect(Math.abs(d.totalMicro * 31 - m.totalMicro)).toBeLessThan(31);
  });

  it("formula: (min(cap, fixed/active) + storage) × 1.2 / days", () => {
    const m = monthlyFixed({ settings: S, fixedMonthlyMicro: usdToMicro(60), activeWorkspaces: 20, storageGb: 20, active: true });
    expect(m.totalMicro).toBe(Math.round((3 + 20 * 0.015) * 1.2 * 1e6));
    expect(dailyCharge(m, daysInMonth("2026-11-01")).totalMicro).toBe(Math.round((3.3 * 1.2 * 1e6) / 30));
  });

  it("says how many days the balance lasts", () => {
    expect(balanceLastsDays(usdToMicro(1), 140_000)).toBe(7);
    expect(balanceLastsDays(-1, 140_000)).toBe(0);
    expect(balanceLastsDays(5, 0)).toBeNull();
  });

  it("the cap only goes down", () => {
    expect(() => assertCapNotIncreased(4, 3.5)).not.toThrow();
    expect(() => assertCapNotIncreased(4, 4.01)).toThrow(/only go down/);
  });
});

describe("settings", () => {
  it("takes third-party prices from prices.json, not code", () => {
    expect(S.storageUsdPerGbMonth).toBe(catalog.config.services.r2_storage!.usd);
    expect(S.stripeFeePercent).toBe(catalog.config.services.stripe_card_percent!.usd);
    expect(S.markup).toBe(DEFAULT_PLATFORM.markup);
    expect(() => platformSettings({})).toThrow(/r2_storage/);
  });
});

describe("calculator", () => {
  it("prices the example episode job by job, exactly as billing would", () => {
    const d = catalog.config.defaults;
    const e = episodeCost(catalog, S, { ...EXAMPLE_PLAN, draftVideo: d.draft.video, finalVideo: d.final.video, image: d.final.image });
    const frame = estimate(catalog.get(d.final.image), { images: 1 }).providerCostMicro;
    const draft = estimate(catalog.get(d.draft.video), { durationS: 5, audio: d.draftAudio }).providerCostMicro;
    const final = estimate(catalog.get(d.final.video), { durationS: 5, audio: true }).providerCostMicro;
    expect(e.providerMicro).toBe(90 * frame + 90 * draft + 30 * frame + 30 * final);
    expect(e.chargeMicro).toBe(
      90 * generationCharge(frame, S) + 90 * generationCharge(draft, S) + 30 * generationCharge(frame, S) + 30 * generationCharge(final, S),
    );
    expect(e.lines.reduce((a, l) => a + l.chargeMicro, 0)).toBe(e.chargeMicro);
  });

  it("has a row for every final-tier model", () => {
    const rows = calculatorTable(catalog, S);
    expect(rows.map((r) => r.model.id).sort()).toEqual(
      catalog
        .list("video", "final")
        .map((m) => m.id)
        .sort(),
    );
    for (const r of rows) expect(r.draftThenFinal.chargeMicro).toBeGreaterThan(r.finalOnly.chargeMicro);
  });
});

describe("units", () => {
  it("formats and distributes exactly", () => {
    expect(formatUsd(usdToMicro(10))).toBe("$10.00");
    expect(formatUsd(-328_767, { precise: true })).toBe("-$0.3288");
    expect(distribute(10, [1, 1, 1])).toEqual([4, 3, 3]);
  });
});
