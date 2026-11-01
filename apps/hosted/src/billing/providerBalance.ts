/**
 * fal is a separate, prepaid account: user top-ups land in Stripe, not in fal. When fal's
 * credit runs out every generation is refused, so we watch the balance, tell the operator
 * on Telegram before it runs dry, and stop sending work while it is empty (users then get
 * a plain "paused on our side, nothing charged" instead of a failed attempt).
 */
import { ProviderRejected } from "@reel/core";
import type { Config } from "../config";

export interface Balance {
  usd: number;
  at: number;
}

type Fetch = typeof fetch;
const BALANCE_URL = "https://api.fal.ai/v1/account/billing?expand=credits";
/** Below this, nothing is sent to fal (a job can cost more than the balance). */
export const EMPTY_USD = 0.5;
const RECHECK_MS = 30_000;
const REALERT_MS = 6 * 3_600_000;

export class BalanceMonitor {
  latest: Balance | null = null;
  private alertedAt = 0;
  private wasLow = false;

  constructor(
    private config: Pick<Config, "PROVIDER" | "FAL_BILLING_KEY" | "FAL_LOW_BALANCE_USD" | "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID">,
    private fetchFn: Fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.config.PROVIDER === "fal" && !!this.config.FAL_BILLING_KEY;
  }

  /** Reads the balance from fal and alerts if it is low. Returns null when not configured. */
  async check(): Promise<Balance | null> {
    if (!this.enabled) return null;
    const r = await this.fetchFn(BALANCE_URL, {
      headers: { authorization: `Key ${this.config.FAL_BILLING_KEY}`, accept: "application/json" },
    });
    if (!r.ok) throw new Error(`fal balance: HTTP ${r.status}`);
    const body = (await r.json()) as { credits?: { current_balance?: unknown } };
    const usd = Number(body.credits?.current_balance);
    if (!Number.isFinite(usd)) throw new Error("fal balance: no credits in the reply");
    this.latest = { usd, at: this.now() };
    await this.alert(usd);
    return this.latest;
  }

  /** Throws a provider refusal when fal is known to be empty. Re-reads a stale low reading first. */
  async ensureFunded(): Promise<void> {
    if (!this.enabled || !this.latest || this.latest.usd >= EMPTY_USD) return;
    if (this.now() - this.latest.at > RECHECK_MS) {
      try {
        await this.check();
      } catch {
        return; // Can't tell: let fal decide rather than block on our own outage.
      }
    }
    if (this.latest.usd < EMPTY_USD) throw new ProviderRejected("fal: Exhausted balance (our provider account needs a top-up)", 403);
  }

  private async alert(usd: number): Promise<void> {
    const low = usd < this.config.FAL_LOW_BALANCE_USD;
    const money = `$${usd.toFixed(2)}`;
    let text: string | null = null;
    if (low && (!this.wasLow || this.now() - this.alertedAt > REALERT_MS)) {
      text =
        usd < EMPTY_USD
          ? `Dropisode: fal.ai is out of credit (${money}). Generation is paused for every user. Top up: https://fal.ai/dashboard/billing`
          : `Dropisode: fal.ai credit is low (${money}, alert below $${this.config.FAL_LOW_BALANCE_USD}). Top up: https://fal.ai/dashboard/billing`;
    } else if (!low && this.wasLow) {
      text = `Dropisode: fal.ai topped up (${money}). Generation is running.`;
    }
    this.wasLow = low;
    if (!text) return;
    if (low) this.alertedAt = this.now();
    console.warn(`reel ${text}`);
    if (!this.config.TELEGRAM_BOT_TOKEN || !this.config.TELEGRAM_CHAT_ID) return;
    try {
      await this.fetchFn(`https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ chat_id: this.config.TELEGRAM_CHAT_ID, text, disable_web_page_preview: "true" }),
      });
    } catch (err) {
      console.warn(`reel telegram: ${(err as Error).message}`);
    }
  }
}

const monitors = new WeakMap<object, BalanceMonitor>();
/** One monitor per server config, shared by the worker and the provider gate. */
export function balanceMonitor(config: Config): BalanceMonitor {
  let m = monitors.get(config);
  if (!m) {
    m = new BalanceMonitor(config);
    monitors.set(config, m);
  }
  return m;
}
