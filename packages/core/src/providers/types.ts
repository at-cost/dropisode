/**
 * The provider interface. fal.ai implements it in V1; a second provider (MuAPI)
 * implements the same interface without any change to core.
 *
 * Billing wraps a provider from the outside (see apps/hosted): its `submit`
 * places a hold before calling the inner provider, and its `finalize` settles
 * at the real cost or releases the hold. Core may call `finalize` more than
 * once for a job (after a crash, or when a job closed as lost is reopened), so
 * it must make the books match the outcome it is given, idempotently.
 */
import type { CatalogModel } from "../catalog";
import type { Aspect, MediaRef, Tier } from "../project";

export interface MediaInput {
  bytes: Uint8Array;
  contentType: string;
  name: string;
  /** "upload": a photo a person added (may show a real person); "generated": made by a model. */
  origin?: "upload" | "generated";
}

export interface ProviderInput {
  model: CatalogModel;
  prompt?: string;
  negativePrompt?: string;
  /** First frame for image-to-video. */
  image?: MediaInput;
  /** Last frame the clip should end on, for models that take one. */
  endImage?: MediaInput;
  /** Reference images (cast, location, previous frame). */
  images?: MediaInput[];
  durationS?: number;
  aspect?: Aspect;
  audio?: boolean;
  /** An audio file to process (voice isolation). */
  media?: MediaInput;
  /** TTS text. */
  text?: string;
  voice?: string;
  /** LLM system prompt. */
  system?: string;
  maxTokens?: number;
}

export interface ProviderOutput {
  /** Where to download the media (short-lived). */
  url?: string;
  /** Media bytes, when the provider returns them directly. */
  bytes?: Uint8Array;
  contentType?: string;
  /** LLM output text. */
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** The real cost, if the provider reports it per request. */
  actualCostMicro?: number;
}

export type ProviderStatus =
  | { state: "queued" | "running" }
  | { state: "done"; output: ProviderOutput }
  | {
      state: "failed";
      error: string;
      /** Whether the provider billed this failed request. fal documents no charge for server errors. */
      billed: boolean;
      /** If billed and the provider reports a cost. */
      actualCostMicro?: number;
    };

export type JobKind = "image" | "video" | "tts" | "llm" | "audio";
export type JobState = "created" | "submitted" | "done" | "failed" | "blocked";

/** One request to a provider. Written before submission so a crash never loses a charge or a refund. */
export interface JobRecord {
  id: string;
  projectId: string;
  kind: JobKind;
  /** What the job is for: "cast_image", "frame", "video", "tts", "script", "storyboard". */
  purpose: string;
  model: string;
  provider: string;
  tier: Tier | null;
  /** Where the result goes. */
  refs: { episodeId?: string; sceneId?: string; shotId?: string; takeId?: string; castId?: string; lineId?: string };
  estimateMicro: number;
  /** The estimate's units, kept for the cost log. */
  units: number;
  unit: string;
  state: JobState;
  requestId?: string;
  /** The provider endpoint the request went to (some models have a separate text-only endpoint). */
  endpoint?: string;
  error?: string;
  /** Set when finished. */
  providerBilled?: boolean;
  providerCostMicro?: number;
  costSource?: "unit_price" | "provider";
  /** The result: a media file or LLM text. */
  result?: { mediaId?: string; media?: MediaRef; text?: string };
  /** When the outcome was recorded. */
  doneAt?: string;
  /** The provider's real cost is known (or we stopped waiting for it). */
  costConfirmed?: boolean;
  /** The result has been applied to the project. */
  applied?: boolean;
  /** false: follow-up work (e.g. starting the video) is still to run. */
  followedUp?: boolean;
  /** Closed as lost, then found at the provider and reopened. */
  reopened?: boolean;
  /** Last time the provider was asked for the real cost. */
  costLookupAt?: string;
  /** First failed attempt to save the output (downloads are retried until a deadline). */
  outputFailedAt?: string;
  /** The provider's `finalize` has run for this job's latest outcome. */
  finalized: boolean;
  createdAt: string;
  updatedAt: string;
  /** Opaque data for the owner of the job store (hosted: workspace id, member id). */
  owner?: Record<string, string>;
}

export interface JobOutcome {
  succeeded: boolean;
  providerBilled: boolean;
  providerCostMicro: number;
}

export interface Provider {
  readonly id: string;
  /** Sends the request. Throws `BlockedError` if a wrapper refuses it (no balance, moderation). */
  submit(job: JobRecord, input: ProviderInput, opts?: { webhookUrl?: string }): Promise<{ requestId: string; endpoint?: string }>;
  /** Asks the provider where a request is. */
  check(job: JobRecord): Promise<ProviderStatus>;
  /** Downloads an output file. */
  download(url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /**
   * Makes the books match a finished job's outcome. Idempotent per job id: calling
   * it again with the same outcome changes nothing; calling it with a different
   * outcome (a job closed as lost that the provider later reported) corrects it.
   */
  finalize?(job: JobRecord, outcome: JobOutcome): Promise<void>;
  /**
   * The real cost of a finished request, if the provider reports one. null =
   * not known yet (the runner asks again, then falls back to the published price).
   */
  lookupCost?(job: JobRecord): Promise<{ costMicro: number } | null>;
}

/** A request refused before it reached the provider. Nothing was spent. */
export class BlockedError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

/** The provider answered and refused the request (e.g. invalid input). It never ran and wasn't billed. */
export class ProviderRejected extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}
