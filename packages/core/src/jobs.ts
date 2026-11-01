/**
 * Generation jobs. The order of steps is what keeps money safe:
 *
 *   1. write the job record and a pending cost line (before anything is sent)
 *   2. submit to the provider (a billing wrapper places its hold here)
 *   3. on completion: store the output (retrying downloads), record the outcome
 *   4. confirm the real cost with the provider, if it can report one
 *   5. apply the result to the project and run follow-ups, once
 *   6. finalize: the billing wrapper makes the wallet match the outcome
 *
 * Any step can be repeated after a crash: `resume()` picks up every job that
 * was submitted, or finished but not finalized. A job closed as lost (its
 * submit was never confirmed) is reopened if the provider later turns out to
 * have it, and finalized again with the real outcome.
 */
import { type Catalog, type EstimateInput, estimate } from "./catalog";
import { newId } from "./edit";
import type { CostLine, MediaRef, Project, Tier } from "./project";
import {
  BlockedError,
  ProviderRejected,
  type JobKind,
  type JobRecord,
  type Provider,
  type ProviderInput,
  type ProviderStatus,
} from "./providers/types";
import type { JobStore, MediaStore, ProjectStore } from "./stores";

export interface JobResult {
  media?: MediaRef;
  text?: string;
}

/** What to do with a job's result, by purpose. */
export interface JobHandler {
  /** Runs inside a project mutation on success. Must be idempotent. */
  apply?(project: Project, job: JobRecord, result: JobResult): void;
  /** Runs inside a project mutation on failure. Must be idempotent. */
  fail?(project: Project, job: JobRecord, error: string): void;
  /** Follow-up work after the project is saved. Must be idempotent. */
  after?(job: JobRecord): Promise<void>;
}

export interface StartSpec {
  /** A fixed id makes starting idempotent: if the job exists, it is returned, not started again. */
  id?: string;
  projectId: string;
  kind: JobKind;
  purpose: string;
  modelId: string;
  tier: Tier | null;
  refs: JobRecord["refs"];
  input: Omit<ProviderInput, "model">;
  estimateInput: EstimateInput;
  owner?: Record<string, string>;
}

export interface RunnerDeps {
  projects: ProjectStore;
  media: MediaStore;
  jobs: JobStore;
  provider: Provider;
  catalog: Catalog;
  /** Hosted: a webhook URL for the job. Local: none (the server polls). */
  webhookUrl?: (job: JobRecord) => string | undefined;
  /** Called after any job changes state (for live UI updates). */
  onChange?: (job: JobRecord) => void;
  /** A job left in "created" (submit not confirmed) this long is closed by `resume`. */
  lostAfterMs?: number;
  /** How long to wait for the provider's real cost before settling at the published price. */
  costWaitMs?: number;
  /** How long to keep retrying a finished output's download before giving up. */
  outputRetryMs?: number;
  /** Least time between two cost lookups for one job. */
  costLookupEveryMs?: number;
  /** A submitted job the provider still can't answer about after this long is closed. */
  maxJobAgeMs?: number;
  /**
   * Exclusive access to one job across processes (hosted: a Postgres advisory
   * lock). Without it, work on a job is only serialised inside this runner.
   */
  lock?: <T>(jobId: string, fn: () => Promise<T>) => Promise<T>;
  /** Where to report background errors. */
  log?: (msg: string, err?: unknown) => void;
}

const TERMINAL = new Set(["done", "failed", "blocked"]);

export class JobRunner {
  private handlers = new Map<string, JobHandler>();
  private inFlight = new Map<string, Promise<unknown>>();

  constructor(readonly deps: RunnerDeps) {}

  on(purpose: string, handler: JobHandler): void {
    this.handlers.set(purpose, handler);
  }

  /** Records, then submits, a job. Throws BlockedError (nothing spent) if a wrapper refuses it. */
  async start(spec: StartSpec): Promise<JobRecord> {
    if (spec.id) {
      const existing = await this.deps.jobs.get(spec.id);
      if (existing) return existing;
    }
    const model = this.deps.catalog.get(spec.modelId);
    const est = estimate(model, spec.estimateInput);
    const t = new Date().toISOString();
    let job: JobRecord = {
      id: spec.id ?? newId("job"),
      projectId: spec.projectId,
      kind: spec.kind,
      purpose: spec.purpose,
      model: model.id,
      provider: this.deps.provider.id,
      tier: spec.tier,
      refs: spec.refs,
      estimateMicro: est.providerCostMicro,
      units: est.units,
      unit: est.unit,
      state: "created",
      finalized: false,
      createdAt: t,
      updatedAt: t,
      ...(spec.owner ? { owner: spec.owner } : {}),
    };
    try {
      await this.deps.jobs.create(job);
    } catch (err) {
      // Another runner started the same fixed-id job a moment ago: use that one.
      const existing = spec.id ? await this.deps.jobs.get(spec.id) : undefined;
      if (existing) return existing;
      throw err;
    }
    await this.deps.projects.mutate(spec.projectId, (p) => {
      p.costLog.push(pendingLine(job));
    });
    try {
      const webhookUrl = this.deps.webhookUrl?.(job);
      const sent = await this.deps.provider.submit(job, { ...spec.input, model }, webhookUrl ? { webhookUrl } : {});
      job = await this.accepted(job.id, sent.requestId, sent.endpoint);
      this.deps.onChange?.(job);
      return job;
    } catch (err) {
      if (err instanceof BlockedError) {
        job = await this.deps.jobs.update(job.id, {
          state: "blocked",
          error: err.message,
          finalized: true,
          providerBilled: false,
          providerCostMicro: 0,
        });
        await this.deps.projects.mutate(spec.projectId, (p) => {
          p.costLog = p.costLog.filter((l) => l.jobId !== job.id);
        });
        this.deps.onChange?.(job);
        throw err;
      }
      if (err instanceof ProviderRejected) {
        // The provider answered and refused: it never ran, so it wasn't billed.
        return this.complete(job.id, { state: "failed", error: `Not accepted by the provider: ${err.message}`, billed: false });
      }
      // No answer (network): the provider may have accepted it. Leave the job "created"; a
      // webhook can still attach it, and `resume` closes it after `lostAfterMs`.
      job = await this.deps.jobs.update(job.id, { error: `Sending failed: ${errMessage(err)}` });
      this.deps.onChange?.(job);
      return job;
    }
  }

  /** Asks the provider about a submitted job and completes it if it finished. */
  async check(jobId: string): Promise<JobRecord> {
    const job = await this.deps.jobs.get(jobId);
    if (!job) throw new Error(`No job ${jobId}`);
    if (job.state !== "submitted") return TERMINAL.has(job.state) && (!job.finalized || job.followedUp === false) ? this.complete(jobId) : job;
    const status = await this.deps.provider.check(job);
    if (status.state === "queued" || status.state === "running") return job;
    return this.complete(jobId, status);
  }

  /** Hosted: a webhook named a job and its provider request; record the id if the submit reply was lost. */
  async attachRequestId(jobId: string, requestId: string): Promise<JobRecord | undefined> {
    const job = await this.deps.jobs.get(jobId);
    if (!job) return undefined;
    if (job.requestId) return job;
    return this.accepted(jobId, requestId, undefined);
  }

  /**
   * The provider has the request. Normally the job is still "created"; if it was
   * already closed as lost, reopen it so the real outcome is recorded and settled.
   */
  private accepted(jobId: string, requestId: string, endpoint: string | undefined): Promise<JobRecord> {
    return this.serial(jobId, () => this.acceptedOnce(jobId, requestId, endpoint));
  }

  private async acceptedOnce(jobId: string, requestId: string, endpoint: string | undefined): Promise<JobRecord> {
    const cur = (await this.deps.jobs.get(jobId))!;
    const base = { state: "submitted" as const, requestId, ...(endpoint ? { endpoint } : {}) };
    if (cur.state === "created") return this.deps.jobs.update(jobId, base);
    if (cur.state === "failed" && !cur.requestId) {
      this.deps.log?.(`Job ${jobId} was closed as lost but the provider has it; reopening`);
      return this.deps.jobs.update(jobId, {
        ...base,
        finalized: false,
        applied: false,
        costConfirmed: false,
        reopened: true,
        error: undefined,
        providerBilled: undefined,
        providerCostMicro: undefined,
      });
    }
    return cur;
  }

  /**
   * Finishes a job. Safe to call many times and concurrently: each step checks
   * what is already done. With no status, re-runs the steps after the job's
   * recorded terminal state (crash recovery).
   */
  async complete(jobId: string, status?: ProviderStatus): Promise<JobRecord> {
    const job = await this.serial(jobId, () => this.completeOnce(jobId, status));
    return job.applied && job.followedUp === false ? this.followUp(job) : job;
  }

  /** Step 5b: follow-up work (e.g. start the video once its frame exists). Idempotent; outside the job's lock. */
  private async followUp(job: JobRecord): Promise<JobRecord> {
    try {
      await this.handlers.get(job.purpose)?.after?.(job);
    } catch (err) {
      // The follow-up records its own failure (e.g. a blocked video job marks the take failed).
      this.deps.log?.(`Follow-up for ${job.id} failed`, err);
    }
    return this.deps.jobs.update(job.id, { followedUp: true });
  }

  /** Runs `fn` after any other work on the same job, so a reopen can't interleave with a close. */
  private serial<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.inFlight.get(jobId) ?? Promise.resolve();
    // In-process order first; then, across processes and runner instances, the store's lock.
    const locked = this.deps.lock ? () => this.deps.lock!(jobId, fn) : fn;
    const run = prev.catch(() => {}).then(locked);
    const tail = run.catch(() => {});
    this.inFlight.set(jobId, tail as Promise<never>);
    void tail.then(() => {
      if (this.inFlight.get(jobId) === tail) this.inFlight.delete(jobId);
    });
    return run;
  }

  private async completeOnce(jobId: string, status?: ProviderStatus): Promise<JobRecord> {
    let job = (await this.deps.jobs.get(jobId))!;
    if (job.finalized) return job;

    // Step 3: record the outcome once.
    if (!TERMINAL.has(job.state)) {
      if (!status || status.state === "queued" || status.state === "running") return job;
      if (status.state === "done") {
        let result: JobResult;
        try {
          result = await this.storeOutput(job, status.output);
        } catch (err) {
          // Usually a network glitch: leave the job open and try again on the next pass.
          const firstAt = job.outputFailedAt ?? new Date().toISOString();
          if (Date.now() - Date.parse(firstAt) < (this.deps.outputRetryMs ?? 6 * 3600_000)) {
            this.deps.log?.(`Saving output of ${job.id} failed; will retry`, err);
            return this.deps.jobs.update(job.id, {
              outputFailedAt: firstAt,
              error: `Saving the output failed, retrying: ${errMessage(err)}`,
            });
          }
          // Gave up: the provider finished and billed, but the output is gone.
          job = await this.deps.jobs.update(job.id, {
            state: "failed",
            error: `Finished, but the output could not be saved: ${errMessage(err)}`,
            providerBilled: true,
            providerCostMicro: status.output.actualCostMicro ?? job.estimateMicro,
            costSource: status.output.actualCostMicro !== undefined ? "provider" : "unit_price",
            costConfirmed: status.output.actualCostMicro !== undefined || !this.deps.provider.lookupCost,
            doneAt: new Date().toISOString(),
          });
          return this.afterOutcome(job);
        }
        const reported = status.output.actualCostMicro;
        const fromTokens =
          job.kind === "llm" && (status.output.inputTokens !== undefined || status.output.outputTokens !== undefined)
            ? this.tokenCost(job, status.output.inputTokens ?? 0, status.output.outputTokens ?? 0)
            : undefined;
        job = await this.deps.jobs.update(job.id, {
          state: "done",
          result: {
            ...(result.media ? { mediaId: result.media.id, media: result.media } : {}),
            ...(result.text !== undefined ? { text: result.text } : {}),
          },
          providerBilled: true,
          providerCostMicro: reported ?? fromTokens ?? job.estimateMicro,
          costSource: reported !== undefined ? "provider" : "unit_price",
          costConfirmed: reported !== undefined || !this.deps.provider.lookupCost,
          doneAt: new Date().toISOString(),
          error: undefined,
        });
      } else {
        const failed = status as Extract<ProviderStatus, { state: "failed" }>;
        job = await this.deps.jobs.update(job.id, {
          state: "failed",
          error: failed.error,
          providerBilled: failed.billed,
          providerCostMicro: failed.billed ? (failed.actualCostMicro ?? job.estimateMicro) : 0,
          costSource: failed.actualCostMicro !== undefined ? "provider" : "unit_price",
          costConfirmed: failed.actualCostMicro !== undefined || !this.deps.provider.lookupCost,
          doneAt: new Date().toISOString(),
        });
      }
    }
    return this.afterOutcome(job);
  }

  private tokenCost(job: JobRecord, inputTokens: number, outputTokens: number): number | undefined {
    const model = this.deps.catalog.models.get(job.model);
    return model ? estimate(model, { inputTokens, outputTokens }).providerCostMicro : undefined;
  }

  /** Steps 4 to 6, for a job with a recorded outcome. */
  private async afterOutcome(job: JobRecord): Promise<JobRecord> {
    if (job.state === "blocked") return job;

    // Step 4: the real cost, when the provider can report it (fal: billing events).
    let costChanged = false;
    if (!job.costConfirmed && this.deps.provider.lookupCost && job.requestId) {
      let real: { costMicro: number } | null = null;
      const last = job.costLookupAt ? Date.parse(job.costLookupAt) : 0;
      if (Date.now() - last >= (this.deps.costLookupEveryMs ?? 30_000)) {
        try {
          real = await this.deps.provider.lookupCost(job);
        } catch (err) {
          this.deps.log?.(`Cost lookup for ${job.id} failed`, err);
        }
        if (!real) job = await this.deps.jobs.update(job.id, { costLookupAt: new Date().toISOString() });
      }
      if (real) {
        job = await this.deps.jobs.update(job.id, {
          providerCostMicro: real.costMicro,
          providerBilled: job.state === "done" || real.costMicro > 0,
          costSource: "provider",
          costConfirmed: true,
        });
        costChanged = true;
      } else if (Date.now() - Date.parse(job.doneAt ?? job.updatedAt) > (this.deps.costWaitMs ?? 15 * 60_000)) {
        // No billing event in time: settle at the published price; monthly reconciliation catches any gap.
        job = await this.deps.jobs.update(job.id, { costConfirmed: true });
        costChanged = true;
      }
    } else if (!job.costConfirmed) {
      job = await this.deps.jobs.update(job.id, { costConfirmed: true });
    }

    // Step 5: apply to the project and run follow-ups, once (and refresh the cost line when the cost lands).
    const handler = this.handlers.get(job.purpose);
    if (!job.applied || costChanged) {
      const done = job;
      await this.deps.projects.mutate(job.projectId, (p) => {
        const line = p.costLog.find((l) => l.jobId === done.id);
        if (line) settleLine(line, done);
        else p.costLog.push(settleLine(pendingLine(done), done));
        if (done.applied) return;
        if (done.state === "done") {
          const media = done.result?.media;
          if (media && !p.media.some((m) => m.id === media.id)) p.media.push(media);
          handler?.apply?.(p, done, {
            ...(media ? { media } : {}),
            ...(done.result?.text !== undefined ? { text: done.result.text } : {}),
          });
        } else if (done.state === "failed") {
          handler?.fail?.(p, done, done.error ?? "failed");
        }
      });
      // Follow-ups run after the job's lock is released (see `complete`): they start other
      // jobs, which take locks of their own.
      if (!job.applied) job = await this.deps.jobs.update(job.id, { applied: true, followedUp: !handler?.after });
    }
    this.deps.onChange?.(job);
    if (!job.costConfirmed) return job;

    // Step 6: settle. Runs again (correcting) only if a closed job was reopened.
    await this.deps.provider.finalize?.(job, {
      succeeded: job.state === "done",
      providerBilled: !!job.providerBilled,
      providerCostMicro: job.providerCostMicro ?? 0,
    });
    job = await this.deps.jobs.update(job.id, { finalized: true });
    this.deps.onChange?.(job);
    return job;
  }

  private async storeOutput(
    job: JobRecord,
    out: { url?: string; bytes?: Uint8Array; contentType?: string; text?: string },
  ): Promise<JobResult> {
    if (job.kind === "llm") return { text: out.text ?? "" };
    let bytes = out.bytes;
    let contentType = out.contentType;
    if (!bytes) {
      if (!out.url) throw new Error("The provider returned no output");
      const dl = await this.deps.provider.download(out.url);
      bytes = dl.bytes;
      contentType = contentType ?? dl.contentType;
    }
    const media = await this.deps.media.put(job.projectId, {
      bytes,
      contentType: contentType ?? "application/octet-stream",
      source: job.id,
    });
    return { media };
  }

  /**
   * A job the provider keeps erroring about (expired request, rotated key) can't
   * hold money forever. Past the age limit it is closed: if its output had
   * already arrived (download kept failing) it is billed; otherwise not billed,
   * unless the provider's billing record says it was.
   */
  private async giveUpIfStale(jobId: string, err: unknown): Promise<JobRecord | null> {
    const job = await this.deps.jobs.get(jobId);
    if (!job || job.state !== "submitted") return null;
    const outputGone = job.outputFailedAt && Date.now() - Date.parse(job.outputFailedAt) > (this.deps.outputRetryMs ?? 6 * 3600_000);
    const tooOld = Date.now() - Date.parse(job.createdAt) > (this.deps.maxJobAgeMs ?? 24 * 3600_000);
    if (!outputGone && !tooOld) return null;
    return this.complete(jobId, {
      state: "failed",
      error: outputGone
        ? `Finished, but the output could not be saved: ${errMessage(err)}`
        : `No answer from the provider in time: ${errMessage(err)}`,
      billed: !!outputGone,
    });
  }

  /** Polls one job until it finishes. For LLM steps the creator is waiting on. */
  async wait(jobId: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<JobRecord> {
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    for (;;) {
      const job = await this.check(jobId);
      // The result is in the project; settlement can finish in the background.
      if (job.state === "blocked" || ((job.state === "done" || job.state === "failed") && job.applied)) return job;
      if (Date.now() > deadline) throw new Error("Timed out waiting for the provider");
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1500));
    }
  }

  /** Crash recovery and polling: checks every unfinished job once. */
  async resume(projectId?: string): Promise<JobRecord[]> {
    const open = await this.deps.jobs.listUnfinished(projectId);
    const out: JobRecord[] = [];
    for (const job of open) {
      try {
        if (job.state === "created") {
          const age = Date.now() - Date.parse(job.createdAt);
          if (age < (this.deps.lostAfterMs ?? 15 * 60_000)) continue;
          out.push(
            await this.complete(job.id, {
              state: "failed",
              error:
                "Submission was never confirmed (the app stopped while sending). If the provider ran it, it shows on your provider dashboard.",
              billed: false,
            }),
          );
        } else {
          out.push(await this.check(job.id));
        }
      } catch (err) {
        // Network trouble: try again on the next pass, up to a limit.
        this.deps.log?.(`Checking job ${job.id} failed; will retry`, err);
        try {
          const stale = await this.giveUpIfStale(job.id, err);
          if (stale) out.push(stale);
        } catch (e) {
          this.deps.log?.(`Closing stale job ${job.id} failed`, e);
        }
      }
    }
    return out;
  }
}

function pendingLine(job: JobRecord): CostLine {
  return {
    id: newId("cost"),
    jobId: job.id,
    at: job.createdAt,
    kind: job.kind,
    purpose: job.purpose,
    model: job.model,
    provider: job.provider,
    tier: job.tier,
    episodeId: job.refs.episodeId ?? null,
    shotId: job.refs.shotId ?? null,
    castId: job.refs.castId ?? null,
    units: job.units,
    unit: job.unit,
    estimateMicro: job.estimateMicro,
    providerCostMicro: 0,
    costSource: "unit_price",
    status: "pending",
    note: "",
  };
}

function settleLine(line: CostLine, job: JobRecord): CostLine {
  if (job.state !== "done" && job.state !== "failed") return line;
  line.providerCostMicro = job.providerCostMicro ?? 0;
  line.costSource = job.costSource ?? "unit_price";
  if (!job.costConfirmed) {
    line.status = "pending";
    line.note =
      job.state === "done"
        ? "Finished; confirming the cost with the provider"
        : `Failed; confirming with the provider whether it was billed: ${job.error ?? ""}`.trim();
    return line;
  }
  if (job.state === "done") {
    line.status = "charged";
    line.note = "";
  } else if (job.providerBilled) {
    line.status = "failed_billed";
    line.note = `Failed, and the provider billed it: ${job.error ?? ""}`.trim();
  } else {
    line.status = "refunded";
    line.note = `Failed, not billed by the provider: ${job.error ?? ""}`.trim();
  }
  if (job.reopened) line.note = `${line.note} (the provider replied late; settled again)`.trim();
  return line;
}

export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A job error as a user should read it. A provider account that is out of credit is our
 * problem, not theirs, so it says so instead of echoing the provider's message.
 */
export function plainJobError(error: string, notBilled: boolean): string {
  const nothing = notBilled ? " Nothing was charged." : "";
  if (/exhausted balance|insufficient (funds|balance|credit)|out of credit|user is locked|billing/i.test(error)) {
    return `Generation is paused on our side: our image and video provider needs a top-up.${nothing} Please try again later.`;
  }
  const clean = error.replace(/^Not accepted by the provider: /, "").slice(0, 300);
  return `That didn't work: ${clean}.${nothing}`.replace(/\.\./g, ".");
}
