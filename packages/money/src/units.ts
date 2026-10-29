/**
 * Money units, copied from at-cost/glasstrack (packages/shared/src/money/index.ts, MIT,
 * Copyright (c) 2026 at-cost and contributors). Pure functions, no I/O.
 * All amounts are integer micro-USD (1 USD = 1,000,000) so per-job and daily
 * pro-rata charges are exact; convert to cents only for Stripe.
 */

export const MICRO = 1_000_000;
export const GIB = 1024 ** 3;

export const usdToMicro = (usd: number): number => Math.round(usd * MICRO);
export const microToCents = (micro: number): number => Math.round(micro / 10_000);
export const centsToMicro = (cents: number): number => cents * 10_000;

export function formatUsd(micro: number, opts: { precise?: boolean } = {}): string {
  const dollars = micro / MICRO;
  const digits = opts.precise && Math.abs(micro) % 10_000 !== 0 ? 4 : 2;
  return `${dollars < 0 ? "-" : ""}$${Math.abs(dollars).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/**
 * Splits `total` into integer parts proportional to `weights`, assigning the
 * rounding remainder by largest fractional part so the parts sum exactly to
 * total. Zero total weight splits evenly.
 */
export function distribute(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  if (!Number.isInteger(total)) throw new Error("distribute: total must be an integer");
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = sum > 0 ? weights : weights.map(() => 1);
  const wsum = sum > 0 ? sum : weights.length;
  const raw = w.map((x) => (total * x) / wsum);
  const parts = raw.map(Math.floor);
  let rest = total - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) parts[order[k]!.i]! += 1;
  return parts;
}

/** Spreads a cost entry evenly over its days (inclusive). */
export function dailyShare(amountMicro: number, periodStart: string, periodEnd: string, day: string): number {
  if (day < periodStart || day > periodEnd) return 0;
  const days = Math.round((Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000) + 1;
  const index = Math.round((Date.parse(day) - Date.parse(periodStart)) / 86_400_000);
  return distribute(amountMicro, Array(days).fill(1))[index]!;
}

/** Days in the calendar month of an ISO day (YYYY-MM-DD). */
export function daysInMonth(day: string): number {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
