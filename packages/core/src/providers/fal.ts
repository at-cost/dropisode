/**
 * fal.ai through its queue API. Submissions carry a webhook URL when hosted;
 * local mode polls from the server (never from the browser).
 *
 * Cost: the queue result carries no cost. With a billing key (a fal key with
 * the BILLING preset), the real cost of each request is read from fal's Billing
 * Events API; without one, the cost is the published unit price × units from
 * config/prices.json, and hosted reconciles against fal's invoice monthly.
 * See docs/PRICING_NOTES.md.
 *
 * Failures: fal never bills HTTP 500+ errors or queue time. A 422 (bad input or
 * a content-policy rejection) "may be charged" if GPU time was used, so it is
 * recorded as not billed unless Billing Events shows a charge.
 *
 * Submit uses a plain fetch with no retries: the fal client retries network
 * errors on its own, which could create a second, unrecorded billed request.
 */
import { ApiError, createFalClient } from "@fal-ai/client";
import type { Catalog, CatalogModel } from "../catalog";
import { type JobRecord, type MediaInput, type Provider, type ProviderInput, ProviderRejected, type ProviderStatus } from "./types";

type FalClient = ReturnType<typeof createFalClient>;

export interface FalOptions {
  key: string;
  catalog: Catalog;
  /** A fal key with billing:usage:read (BILLING preset), for real per-request costs. Optional. */
  billingKey?: string;
  /** Queue base URL (tests). */
  queueUrl?: string;
  /** For tests: a stand-in client. */
  client?: Pick<FalClient, "queue" | "storage">;
  fetch?: typeof fetch;
}

export class FalProvider implements Provider {
  readonly id = "fal";
  private client: Pick<FalClient, "queue" | "storage">;
  private fetchFn: typeof fetch;
  private catalog: Catalog;
  private key: string;
  private billingKey: string | undefined;
  private queueUrl: string;
  readonly lookupCost?: (job: JobRecord) => Promise<{ costMicro: number } | null>;

  constructor(opts: FalOptions) {
    this.catalog = opts.catalog;
    if (!opts.key && !opts.client) throw new Error("A fal.ai key is needed");
    this.key = opts.key;
    this.billingKey = opts.billingKey || undefined;
    this.queueUrl = opts.queueUrl ?? "https://queue.fal.run";
    this.client = opts.client ?? createFalClient({ credentials: opts.key });
    this.fetchFn = opts.fetch ?? fetch;
    if (this.billingKey) this.lookupCost = (job) => this.billingEventCost(job);
  }

  async submit(job: JobRecord, input: ProviderInput, opts: { webhookUrl?: string } = {}): Promise<{ requestId: string; endpoint: string }> {
    const body = await this.buildInput(input);
    const endpoint = endpointFor(input.model, !!input.images?.length);
    const url = `${this.queueUrl}/${endpoint}${opts.webhookUrl ? `?fal_webhook=${encodeURIComponent(opts.webhookUrl)}` : ""}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { authorization: `Key ${this.key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      // fal answered and refused (bad input, no credit, unknown endpoint): it never ran.
      throw new ProviderRejected(`fal ${res.status}: ${detailOf(text)}`, res.status);
    }
    if (!res.ok) throw new Error(`fal ${res.status} on submit: ${detailOf(text)}`);
    const requestId = (JSON.parse(text) as { request_id?: string }).request_id;
    if (!requestId) throw new Error("fal accepted the request but returned no request id");
    return { requestId, endpoint };
  }

  async check(job: JobRecord): Promise<ProviderStatus> {
    if (!job.requestId) return { state: "queued" };
    const endpoint = this.endpointOf(job);
    const st = await this.client.queue.status(endpoint, { requestId: job.requestId, logs: false });
    if (st.status === "IN_QUEUE") return { state: "queued" };
    if (st.status === "IN_PROGRESS") return { state: "running" };
    let data: unknown;
    try {
      data = (await this.client.queue.result(endpoint, { requestId: job.requestId })).data;
    } catch (err) {
      // Only errors about the request itself end the job. Auth, rate limits, gateways
      // and network errors are thrown, so the next pass asks again.
      // 410: fal retired the endpoint and won't hand over results; asking again never helps.
      if (err instanceof ApiError && (err.status === 422 || err.status === 400 || err.status === 500 || err.status === 410)) {
        const note = err.status === 500 ? "" : " (fal may bill some rejected requests; billing events will show it)";
        return { state: "failed", error: `${apiMessage(err)}${note}`, billed: false };
      }
      throw err;
    }
    try {
      return { state: "done", output: readOutput(this.modelOf(job), data) };
    } catch (err) {
      // It ran and returned something we can't use: fal billed it.
      return { state: "failed", error: (err as Error).message, billed: true };
    }
  }

  async download(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  private modelOf(job: JobRecord): CatalogModel {
    return this.catalog.get(job.model);
  }
  /** Status and result calls must use the endpoint the job was submitted to. */
  private endpointOf(job: JobRecord): string {
    return job.endpoint ?? this.modelOf(job).endpoint;
  }

  private async upload(file: MediaInput): Promise<string> {
    const blob = new Blob([file.bytes as BlobPart], { type: file.contentType });
    try {
      return await this.client.storage.upload(blob);
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw new ProviderRejected(`fal storage refused ${file.name}: ${apiMessage(err)}`, err.status);
      }
      throw err;
    }
  }

  /** The real cost from fal's Billing Events API. null until the event appears. */
  private async billingEventCost(job: JobRecord): Promise<{ costMicro: number } | null> {
    if (!job.requestId) return null;
    const res = await this.fetchFn(`https://api.fal.ai/v1/models/billing-events?request_id=${encodeURIComponent(job.requestId)}`, {
      headers: { authorization: `Key ${this.billingKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`fal billing events: HTTP ${res.status}`);
    return costFromBillingEvents(await res.json(), job.requestId);
  }

  /** Maps Dropisode's request onto the endpoint's own field names (from the catalog). */
  async buildInput(input: ProviderInput): Promise<Record<string, unknown>> {
    const map = input.model.input;
    const out: Record<string, unknown> = structuredClone(map.extra);
    const set = (path: string, v: unknown) => setPath(out, path, v);
    if (input.prompt !== undefined) set(map.prompt, input.prompt);
    if (input.system !== undefined && map.system) set(map.system, input.system);
    if (input.maxTokens !== undefined && map.maxTokens) set(map.maxTokens, input.maxTokens);
    if (input.negativePrompt && map.negativePrompt) set(map.negativePrompt, input.negativePrompt);
    if (input.image && map.image) set(map.image, await this.upload(input.image));
    if (input.endImage && map.endImage) set(map.endImage, await this.upload(input.endImage));
    if (input.images?.length && map.images) {
      const max = input.model.maxRefImages || input.images.length;
      set(map.images, await Promise.all(input.images.slice(0, max).map((f) => this.upload(f))));
    }
    if (input.durationS !== undefined && map.duration) {
      const d = input.durationS;
      set(
        map.duration,
        map.durationFormat === "number"
          ? d
          : map.durationFormat === "ms"
            ? Math.round(d * 1000)
            : map.durationFormat === "string_s"
              ? `${d}s`
              : String(d),
      );
    }
    if (input.aspect && map.aspect) set(map.aspect, map.aspectValues?.[input.aspect] ?? input.aspect);
    if (input.audio !== undefined && map.audio) set(map.audio, input.audio);
    if (input.text !== undefined && map.text) set(map.text, input.text);
    if (input.media && map.media) set(map.media, await this.upload(input.media));
    if (input.voice && map.voice) set(map.voice, input.voice);
    return out;
  }
}

/** The endpoint a request goes to: text-to-image when there are no reference images and the model has one. */
export function endpointFor(model: CatalogModel, hasRefImages: boolean): string {
  return !hasRefImages && model.textEndpoint ? model.textEndpoint : model.endpoint;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

/** Reads a dot path such as "images.0.url". */
export function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function readOutput(
  model: CatalogModel,
  data: unknown,
): { url?: string; mixUrls?: string[]; text?: string; inputTokens?: number; outputTokens?: number; actualCostMicro?: number } {
  const o = model.output;
  const num = (p?: string) => {
    const v = p ? pick(data, p) : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const cost = num(o.costUsd);
  const costPart = cost !== undefined && cost >= 0 ? { actualCostMicro: Math.round(cost * 1_000_000) } : {};
  if (model.kind === "llm") {
    const text = pick(data, o.text ?? o.url);
    if (typeof pick(data, "error") === "string" && pick(data, "error"))
      throw new Error(`The model returned an error: ${String(pick(data, "error")).slice(0, 300)}`);
    const inputTokens = num(o.inputTokens);
    const outputTokens = num(o.outputTokens);
    return {
      text: typeof text === "string" ? text : "",
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...costPart,
    };
  }
  const url = pick(data, o.url);
  if (typeof url !== "string") throw new Error(`fal returned no output at "${o.url}"`);
  const mixUrls = (o.mix ?? []).map((p) => pick(data, p)).filter((u): u is string => typeof u === "string");
  return mixUrls.length ? { url, mixUrls } : { url };
}

/** Sums the cost of one request's billing events. null if there are none yet. */
export function costFromBillingEvents(body: unknown, requestId: string): { costMicro: number } | null {
  const events = (body as { billing_events?: unknown[] })?.billing_events;
  if (!Array.isArray(events)) return null;
  const mine = events.filter((e) => (e as { request_id?: string })?.request_id === requestId) as {
    cost_total?: number | string;
    cost_estimate_nano_usd?: number | string;
  }[];
  if (mine.length === 0) return null;
  let micro = 0;
  for (const e of mine) {
    if (e.cost_estimate_nano_usd !== undefined && e.cost_estimate_nano_usd !== null) micro += Number(e.cost_estimate_nano_usd) / 1000;
    else micro += Number(e.cost_total ?? 0) * 1_000_000;
  }
  if (!Number.isFinite(micro)) return null;
  return { costMicro: Math.round(micro) };
}

function detailOf(text: string): string {
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    const d = body.detail;
    if (typeof d === "string") return d.slice(0, 400);
    if (Array.isArray(d))
      return d
        .map((x) => (x as { msg?: string }).msg ?? JSON.stringify(x))
        .join("; ")
        .slice(0, 400);
  } catch {
    // not JSON
  }
  return text.slice(0, 200) || "no detail";
}

function apiMessage(err: ApiError<unknown>): string {
  const body = err.body as { detail?: unknown } | undefined;
  const detail = body?.detail;
  const text =
    typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? detail.map((d) => (d as { msg?: string }).msg ?? JSON.stringify(d)).join("; ")
        : err.message;
  return `fal ${err.status}: ${text}`.slice(0, 500);
}
