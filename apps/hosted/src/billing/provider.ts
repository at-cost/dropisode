/**
 * Billing wraps the provider from the outside: estimate → hold → generate →
 * settle at the real cost, or release the hold if it failed unbilled. Core
 * knows nothing about any of this.
 */
import { BlockedError, type JobOutcome, type JobRecord, type Provider, type ProviderInput, ProviderRejected } from "@reel/core";
import type { PlatformSettings } from "@reel/money";
import type { Db } from "../db";
import { placeHold, releaseHold, settleJob } from "./wallet";

export class BilledProvider implements Provider {
  readonly id: string;
  readonly lookupCost?: (job: JobRecord) => Promise<{ costMicro: number } | null>;

  constructor(
    private inner: Provider,
    private db: Db,
    private settings: PlatformSettings,
    private opts: { billingEnabled: boolean },
  ) {
    this.id = inner.id;
    if (inner.lookupCost) this.lookupCost = (job) => inner.lookupCost!(job);
  }

  private workspaceOf(job: JobRecord): string {
    const ws = job.owner?.workspaceId;
    if (!ws) throw new Error(`Job ${job.id} has no workspace`);
    return ws;
  }

  async submit(job: JobRecord, input: ProviderInput, opts?: { webhookUrl?: string }) {
    if (!this.opts.billingEnabled)
      throw new BlockedError("Generation isn't open yet: billing is switched off on this server.", "billing_disabled");
    const workspaceId = this.workspaceOf(job);
    const hold = await placeHold(this.db, this.settings, { workspaceId, jobId: job.id, estimateMicro: job.estimateMicro });
    if (!hold.ok) throw new BlockedError(hold.message, hold.reason);
    try {
      return await this.inner.submit(job, input, opts);
    } catch (err) {
      // Refused before it ran: give the money back now. A network error keeps the hold
      // (the provider may have the request); the runner settles it either way.
      if (err instanceof BlockedError || err instanceof ProviderRejected) await releaseHold(this.db, job.id);
      throw err;
    }
  }

  check(job: JobRecord) {
    return this.inner.check(job);
  }

  download(url: string) {
    return this.inner.download(url);
  }

  async finalize(job: JobRecord, outcome: JobOutcome): Promise<void> {
    await this.inner.finalize?.(job, outcome);
    await settleJob(this.db, this.settings, {
      workspaceId: this.workspaceOf(job),
      jobId: job.id,
      provider: job.provider,
      model: job.model,
      succeeded: outcome.succeeded,
      providerBilled: outcome.providerBilled,
      providerCostMicro: outcome.providerCostMicro,
    });
  }
}
