/**
 * The background worker: polls open jobs (a backstop for webhooks, and the only
 * path in development), runs the nightly charge, and reviews new outputs.
 */
import { backfillFees } from "./billing/fees";
import { balanceMonitor } from "./billing/providerBalance";
import { runDueDailyCharges } from "./billing/daily";
import type { Deps } from "./context";
import { workspacesWithOpenJobs } from "./stores";
import { workspaceStudio } from "./studio";

export async function tickJobs(deps: Deps): Promise<number> {
  let n = 0;
  for (const ws of await workspacesWithOpenJobs(deps.db)) {
    const { studio } = workspaceStudio(deps, ws);
    n += (await studio.tick()).length;
  }
  return n;
}

export function startWorker(
  deps: Deps,
  opts: { jobsEveryMs?: number; dailyEveryMs?: number; feesEveryMs?: number; balanceEveryMs?: number } = {},
): () => void {
  let busy = false;
  const jobs = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tickJobs(deps);
      await deps.moderation.reviewOutputs(20);
    } catch (err) {
      console.warn(`reel worker: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  }, opts.jobsEveryMs ?? 5000);
  // Daily charges are idempotent per day, so checking hourly is safe; missed days are caught up.
  const daily = setInterval(() => {
    runDueDailyCharges(deps).catch((err) => console.warn(`reel daily charges: ${(err as Error).message}`));
  }, opts.dailyEveryMs ?? 3_600_000);
  // Stripe fees settle a few minutes after payment; fill in any that were missing.
  const fees = setInterval(() => {
    backfillFees(deps).catch((err) => console.warn(`reel stripe fees: ${(err as Error).message}`));
  }, opts.feesEveryMs ?? 600_000);
  // fal is prepaid and separate from user top-ups: watch it and alert before it runs dry.
  const monitor = balanceMonitor(deps.config);
  const checkBalance = () => monitor.check().catch((err) => console.warn(`reel fal balance: ${(err as Error).message}`));
  void checkBalance();
  const balance = setInterval(checkBalance, opts.balanceEveryMs ?? 600_000);
  return () => {
    clearInterval(balance);
    clearInterval(jobs);
    clearInterval(daily);
    clearInterval(fees);
  };
}
