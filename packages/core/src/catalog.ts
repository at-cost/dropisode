/**
 * The model catalog and price estimates. Every provider price lives in
 * config/prices.json with a source URL and a "verified on" date; nothing here
 * hard-codes a price. Estimates are the provider's cost only: core knows
 * nothing about markups or wallets.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Aspect, Tier } from "./project";

const Status = z.enum(["verified", "secondary", "uncertain"]);

export const PriceUnit = z.enum(["second", "video", "image", "1k_chars", "tokens"]);
export type PriceUnit = z.infer<typeof PriceUnit>;

export const Price = z.object({
  unit: PriceUnit,
  /** USD per unit (second, video, image, 1,000 characters). */
  usd: z.number().nonnegative().optional(),
  /** Per-unit price when audio is generated, if different. */
  audioUsd: z.number().nonnegative().optional(),
  /** For unit "video": USD per clip by duration in seconds. */
  byDurationUsd: z.record(z.string(), z.number().nonnegative()).optional(),
  /** For unit "video" with audio: USD per clip by duration. */
  byDurationAudioUsd: z.record(z.string(), z.number().nonnegative()).optional(),
  /** Per-resolution multipliers or prices are modelled as separate catalog entries. */
  inputUsdPer1M: z.number().nonnegative().optional(),
  outputUsdPer1M: z.number().nonnegative().optional(),
  source: z.string().url(),
  verifiedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: Status,
  notes: z.string().optional(),
});
export type Price = z.infer<typeof Price>;

/** How Reel's request maps onto the endpoint's input fields. */
export const InputMap = z.object({
  prompt: z.string().default("prompt"),
  /** Single first-frame image (image-to-video). */
  image: z.string().optional(),
  /** List of reference image URLs (image edit / reference-to-image). */
  images: z.string().optional(),
  duration: z.string().optional(),
  /** How the duration is sent: a number, or a string like "5" or "5s". */
  durationFormat: z.enum(["number", "string", "string_s"]).default("number"),
  aspect: z.string().optional(),
  /** Values to send for each aspect, when the endpoint doesn't take "9:16"/"16:9" (e.g. "portrait_16_9"). */
  aspectValues: z.record(z.string(), z.string()).optional(),
  audio: z.string().optional(),
  /** LLM: the max output tokens field. */
  maxTokens: z.string().optional(),
  /** LLM: the system prompt field. */
  system: z.string().optional(),
  negativePrompt: z.string().optional(),
  /** Text for TTS. */
  text: z.string().optional(),
  voice: z.string().optional(),
  /** Fixed extra fields sent with every request. */
  extra: z.record(z.string(), z.unknown()).default({}),
});

export const OutputMap = z.object({
  /** Dot path to the output URL, e.g. "video.url" or "images.0.url". */
  url: z.string(),
  /** For LLMs: dot path to the text. */
  text: z.string().optional(),
  /** Dot paths to token usage, if returned. */
  inputTokens: z.string().optional(),
  outputTokens: z.string().optional(),
  /** Dot path to a cost in USD the endpoint reports for this request, if any. */
  costUsd: z.string().optional(),
});

export const ModelKind = z.enum(["video", "image", "tts", "llm"]);
export type ModelKind = z.infer<typeof ModelKind>;

export const CatalogModel = z.object({
  /** Reel's own short key, stable across providers. */
  id: z.string(),
  kind: ModelKind,
  label: z.string(),
  provider: z.string(),
  endpoint: z.string(),
  /** Used instead of `endpoint` when there are no reference images (text-to-image). Same price unless noted. */
  textEndpoint: z.string().optional(),
  price: Price,
  /** Draft and/or final. Config, not code. */
  tiers: z.array(z.enum(["draft", "final"])).default([]),
  /** The model makes its own dialogue and sound. */
  nativeAudio: z.boolean().default(false),
  /** Allowed clip lengths in seconds; the shortest that covers the shot is used. */
  durations: z.array(z.number().positive()).default([]),
  aspects: z.array(z.enum(["9:16", "16:9"])).default(["9:16", "16:9"]),
  /** Most reference images the endpoint accepts. */
  maxRefImages: z.number().int().nonnegative().default(0),
  input: InputMap,
  output: OutputMap,
  hidden: z.boolean().default(false),
  /** Measured quality, for choosing defaults on the price/quality frontier. */
  quality: z
    .object({
      /** Arena Elo (human preference votes); comparable only within one board. */
      elo: z.number(),
      board: z.string(),
      source: z.string().url(),
      verifiedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      notes: z.string().optional(),
    })
    .optional(),
});
export type CatalogModel = z.infer<typeof CatalogModel>;

export const PricesConfig = z.object({
  verifiedOn: z.string(),
  models: z.array(CatalogModel),
  /** Which model each step uses by default, per tier. */
  defaults: z.object({
    draft: z.object({ image: z.string(), video: z.string() }),
    final: z.object({ image: z.string(), video: z.string() }),
    castImage: z.string(),
    tts: z.string(),
    llm: z.string(),
    /** Drafts are about the picture: generate them without audio unless this is true. */
    draftAudio: z.boolean().default(false),
  }),
  /** Non-model prices used by hosted billing (storage, moderation). Same rules: source + date. */
  services: z.record(
    z.string(),
    z.object({
      usd: z.number().nonnegative(),
      unit: z.string(),
      source: z.string().url(),
      verifiedOn: z.string(),
      status: Status,
      notes: z.string().optional(),
    }),
  ),
});
export type PricesConfig = z.infer<typeof PricesConfig>;

export class Catalog {
  readonly models: Map<string, CatalogModel>;
  constructor(readonly config: PricesConfig) {
    this.models = new Map(config.models.map((m) => [m.id, m]));
    for (const id of [
      ...Object.values(config.defaults.draft),
      ...Object.values(config.defaults.final),
      config.defaults.castImage,
      config.defaults.tts,
      config.defaults.llm,
    ]) {
      if (!this.models.has(id)) throw new Error(`prices.json default "${id}" is not a model in the catalog`);
    }
  }

  /** Loads config/prices.json (next to the source, or next to a bundled build), or REEL_PRICES. */
  static load(path?: URL | string): Catalog {
    const candidates = path
      ? [path]
      : [
          process.env.REEL_PRICES,
          new URL("../config/prices.json", import.meta.url),
          new URL("./config/prices.json", import.meta.url),
        ].filter((x): x is string | URL => !!x);
    const found = candidates.find((p) => existsSync(p));
    if (!found) throw new Error("config/prices.json not found");
    return new Catalog(PricesConfig.parse(JSON.parse(readFileSync(found, "utf8"))));
  }

  get(id: string): CatalogModel {
    const m = this.models.get(id);
    if (!m) throw new Error(`Unknown model "${id}"`);
    return m;
  }

  list(kind?: ModelKind, tier?: Tier): CatalogModel[] {
    return [...this.models.values()].filter((m) => !m.hidden && (!kind || m.kind === kind) && (!tier || m.tiers.includes(tier)));
  }

  defaultsFor(tier: Tier) {
    return this.config.defaults[tier];
  }
}

export interface EstimateInput {
  durationS?: number;
  audio?: boolean;
  images?: number;
  chars?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface Estimate {
  model: string;
  provider: string;
  units: number;
  unit: PriceUnit;
  /** Provider cost in micro-USD. */
  providerCostMicro: number;
}

/** The clip length a model will actually render for a shot: the shortest allowed length that covers it. */
export function billedDuration(model: CatalogModel, wantS: number): number {
  if (model.durations.length === 0) return wantS;
  const sorted = [...model.durations].sort((a, b) => a - b);
  return sorted.find((d) => d >= wantS - 1e-9) ?? sorted[sorted.length - 1]!;
}

const micro = (usd: number) => Math.round(usd * 1_000_000);

/** What the provider will bill for one request, from the published unit price. */
export function estimate(model: CatalogModel, p: EstimateInput): Estimate {
  const pr = model.price;
  const base = { model: model.id, provider: model.provider, unit: pr.unit };
  const audio = !!p.audio && model.nativeAudio;
  switch (pr.unit) {
    case "second": {
      const s = billedDuration(model, p.durationS ?? 5);
      const rate = audio && pr.audioUsd !== undefined ? pr.audioUsd : need(pr.usd, model);
      return { ...base, units: s, providerCostMicro: micro(rate * s) };
    }
    case "video": {
      const s = billedDuration(model, p.durationS ?? 5);
      const table = audio && pr.byDurationAudioUsd ? pr.byDurationAudioUsd : pr.byDurationUsd;
      const usd = table?.[String(s)] ?? (audio && pr.audioUsd !== undefined ? pr.audioUsd : pr.usd);
      return { ...base, units: 1, providerCostMicro: micro(need(usd, model)) };
    }
    case "image": {
      const n = p.images ?? 1;
      return { ...base, units: n, providerCostMicro: micro(need(pr.usd, model) * n) };
    }
    case "1k_chars": {
      const k = Math.max(1, p.chars ?? 0) / 1000;
      return { ...base, units: k, providerCostMicro: micro(need(pr.usd, model) * k) };
    }
    case "tokens": {
      const i = p.inputTokens ?? 0;
      const o = p.outputTokens ?? 0;
      const usd = (i * need(pr.inputUsdPer1M, model) + o * need(pr.outputUsdPer1M, model)) / 1_000_000;
      return { ...base, units: i + o, providerCostMicro: micro(usd) };
    }
  }
}

function need(v: number | undefined, m: CatalogModel): number {
  if (v === undefined) throw new Error(`prices.json: model "${m.id}" has no price for this request`);
  return v;
}

/** Whether a video model renders at the project's aspect ratio. */
export const supportsAspect = (m: CatalogModel, a: Aspect): boolean => m.aspects.includes(a);

/** A rough token count for estimates: about 4 characters per token. */
export const roughTokens = (text: string): number => Math.ceil(text.length / 4);
