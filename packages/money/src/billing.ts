/**
 * Reel's at-cost billing formula. The one place a charge is worked out: holds,
 * settlement, the daily charge, the public calculator and the finances page all
 * call these functions, so they can never disagree. Pure functions, no I/O.
 *
 *   generation_charge = provider_actual_cost × (1 + markup)                       per job, at settlement
 *   daily_charge      = (min(share_cap, fixed_monthly / active_workspaces) + storage_cost) × (1 + markup) / days_in_month
 *
 * Shaped after at-cost/glasstrack's packages/shared/src/money/pricing.ts (MIT).
 * Money is integer micro-USD.
 */
import { MICRO } from "./units";

export interface PlatformSettings {
  /** Added on top of cost to cover payment fees and build the reserve. 0.2 = 20%. */
  markup: number;
  /** Most an active workspace pays towards fixed costs per month. Only ever decreases. */
  shareCapUsd: number;
  minTopupUsd: number;
  maxTopupUsd: number;
  /** R2 storage, per GB-month. Copied from the prices config by the caller. */
  storageUsdPerGbMonth: number;
  /** New accounts may spend at most this much per day... */
  newAccountDailyCapUsd: number;
  /** ...for this many days after sign-up. */
  newAccountDays: number;
  /** Warn when the balance covers fewer than this many days of storage and fixed charges. */
  lowBalanceDays: number;
  stripeFeePercent: number;
  stripeFeeFixedUsd: number;
  reserveTargetMonths: number;
}

type ProviderPriced = "storageUsdPerGbMonth" | "stripeFeePercent" | "stripeFeeFixedUsd";

/**
 * Platform defaults: owner settings, not provider prices. Storage and Stripe
 * fees are third-party prices, so they come from the prices config: see `platformSettings`.
 */
export const DEFAULT_PLATFORM: Omit<PlatformSettings, ProviderPriced> = {
  markup: 0.2,
  shareCapUsd: 4,
  minTopupUsd: 10,
  maxTopupUsd: 1000,
  newAccountDailyCapUsd: 50,
  newAccountDays: 7,
  lowBalanceDays: 7,
  reserveTargetMonths: 6,
};

/** Full settings: the owner's choices plus third-party prices from config/prices.json. */
export function platformSettings(
  services: Record<string, { usd: number }>,
  overrides: Partial<Omit<PlatformSettings, ProviderPriced>> = {},
): PlatformSettings {
  const need = (k: string) => {
    const v = services[k]?.usd;
    if (v === undefined) throw new Error(`prices.json is missing services.${k}`);
    return v;
  };
  return {
    ...DEFAULT_PLATFORM,
    ...overrides,
    storageUsdPerGbMonth: need("r2_storage"),
    stripeFeePercent: need("stripe_card_percent"),
    stripeFeeFixedUsd: need("stripe_card_fixed"),
  };
}

const toMicro = (usd: number) => Math.round(usd * MICRO);

/** What the creator pays for a job that cost us `providerCostMicro`. */
export function generationCharge(providerCostMicro: number, s: Pick<PlatformSettings, "markup">): number {
  if (!Number.isFinite(providerCostMicro) || providerCostMicro <= 0) return 0;
  return Math.round(providerCostMicro * (1 + s.markup));
}

/** The hold placed before a job: the estimate, charged the same way. */
export const holdFor = generationCharge;

export interface Settlement {
  /** Taken from the wallet. */
  chargeMicro: number;
  /** Returned from the hold to the available balance. */
  releaseMicro: number;
  /** A failed job the provider did not bill: shown to the creator as a refund line. */
  refunded: boolean;
}

/**
 * Settles a job against its hold. A job the provider billed is charged at its
 * real cost even if that is more than the hold (the estimate was low); the
 * provider's bill is the truth. A failure the provider did not bill releases
 * the hold in full. Refunds are passed on only when the provider refunds us.
 */
export function settle(
  p: { holdMicro: number; providerCostMicro: number; providerBilled: boolean; succeeded: boolean },
  s: Pick<PlatformSettings, "markup">,
): Settlement {
  if (!p.providerBilled) return { chargeMicro: 0, releaseMicro: p.holdMicro, refunded: !p.succeeded };
  const charge = generationCharge(p.providerCostMicro, s);
  return { chargeMicro: charge, releaseMicro: Math.max(0, p.holdMicro - charge), refunded: false };
}

/** Money a workspace can still commit to new jobs. */
export const availableMicro = (balanceMicro: number, heldMicro: number): number => balanceMicro - heldMicro;

export type HoldDecision = { ok: true } | { ok: false; reason: "insufficient_balance" | "daily_cap"; message: string };

/**
 * Whether a new hold may be placed. Blocks when the available balance can't cover
 * it, and for new accounts when today's spend plus holds would pass the daily cap.
 */
export function canHold(p: {
  balanceMicro: number;
  heldMicro: number;
  holdMicro: number;
  /** Charged today plus open holds placed today. */
  spentTodayMicro: number;
  accountAgeDays: number;
  settings: PlatformSettings;
}): HoldDecision {
  const avail = availableMicro(p.balanceMicro, p.heldMicro);
  if (p.holdMicro > avail) {
    return {
      ok: false,
      reason: "insufficient_balance",
      message: "Your balance doesn't cover this generation. Top up to continue; nothing in your projects is affected.",
    };
  }
  if (p.accountAgeDays < p.settings.newAccountDays && p.spentTodayMicro + p.holdMicro > toMicro(p.settings.newAccountDailyCapUsd)) {
    return {
      ok: false,
      reason: "daily_cap",
      message: `New accounts can spend up to $${p.settings.newAccountDailyCapUsd} a day for the first ${p.settings.newAccountDays} days. Try again tomorrow.`,
    };
  }
  return { ok: true };
}

/** The fixed-cost share for one active workspace this month. With no active workspaces, the cap. */
export function fixedShareMicro(s: Pick<PlatformSettings, "shareCapUsd">, fixedMonthlyMicro: number, activeWorkspaces: number): number {
  const cap = toMicro(s.shareCapUsd);
  if (activeWorkspaces <= 0) return cap;
  return Math.min(cap, Math.round(Math.max(0, fixedMonthlyMicro) / activeWorkspaces));
}

export interface MonthlyFixed {
  fixedShareMicro: number;
  storageMicro: number;
  subtotalMicro: number;
  markupMicro: number;
  totalMicro: number;
}

/**
 * A workspace's fixed and storage charges for a month, line by line. Only
 * workspaces that generated something that month are active and pay a share.
 */
export function monthlyFixed(p: {
  settings: PlatformSettings;
  fixedMonthlyMicro: number;
  activeWorkspaces: number;
  storageGb: number;
  active: boolean;
}): MonthlyFixed {
  const share = p.active ? fixedShareMicro(p.settings, p.fixedMonthlyMicro, p.activeWorkspaces) : 0;
  const storage = Math.round(Math.max(0, p.storageGb) * p.settings.storageUsdPerGbMonth * MICRO);
  const subtotal = share + storage;
  const total = Math.round(subtotal * (1 + p.settings.markup));
  return { fixedShareMicro: share, storageMicro: storage, subtotalMicro: subtotal, markupMicro: total - subtotal, totalMicro: total };
}

/** One day's charge. Each line is its monthly amount ÷ days, rounded; the markup line absorbs rounding. */
export function dailyCharge(month: MonthlyFixed, days: number): MonthlyFixed {
  const total = Math.round(month.totalMicro / days);
  const share = Math.round(month.fixedShareMicro / days);
  const storage = Math.round(month.storageMicro / days);
  return {
    fixedShareMicro: share,
    storageMicro: storage,
    subtotalMicro: share + storage,
    markupMicro: total - share - storage,
    totalMicro: total,
  };
}

/** Stripe's fee on one top-up, in micro-USD. */
export function topupFeeMicro(s: PlatformSettings, amountMicro: number): number {
  return Math.round(amountMicro * s.stripeFeePercent + s.stripeFeeFixedUsd * MICRO);
}

/** A top-up amount is allowed (inclusive bounds). */
export function topupAllowed(s: PlatformSettings, amountUsd: number): boolean {
  return Number.isFinite(amountUsd) && amountUsd >= s.minTopupUsd && amountUsd <= s.maxTopupUsd;
}

/** Days of fixed and storage charges the balance covers. null = no daily charge. */
export function balanceLastsDays(balanceMicro: number, dailyTotalMicro: number): number | null {
  if (dailyTotalMicro <= 0) return null;
  return Math.max(0, Math.floor(balanceMicro / dailyTotalMicro));
}

/** The share cap may only go down. Throws otherwise. */
export function assertCapNotIncreased(currentUsd: number | null, nextUsd: number): void {
  if (!Number.isFinite(nextUsd) || nextUsd < 0) throw new Error("The share cap must be zero or more");
  if (currentUsd !== null && nextUsd > currentUsd) throw new Error(`The share cap can only go down: $${nextUsd} > $${currentUsd}`);
}
