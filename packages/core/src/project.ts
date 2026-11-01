/**
 * The project model: series → episodes → scenes → shots, plus the cast library.
 * This is exactly what `project.json` holds, in a local folder or a hosted export.
 */
import { z } from "zod";

export const PROJECT_FORMAT = 1;

export const Aspect = z.enum(["9:16", "16:9"]);
export type Aspect = z.infer<typeof Aspect>;

export const Tier = z.enum(["draft", "final"]);
export type Tier = z.infer<typeof Tier>;

export const CastKind = z.enum(["character", "location", "prop"]);
export type CastKind = z.infer<typeof CastKind>;

/** A file in the project's media folder (or object storage when hosted). */
export const MediaRef = z.object({
  id: z.string(),
  /** Path inside the project, e.g. "media/ab12.png". */
  path: z.string(),
  contentType: z.string(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.string(),
  /** "upload" = added by the creator; anything else is the job that made it. */
  source: z.string(),
  /** Moderation hid this file (hosted only). */
  hidden: z.boolean().optional(),
});
export type MediaRef = z.infer<typeof MediaRef>;

export const CastMember = z.object({
  id: z.string(),
  kind: CastKind,
  name: z.string().min(1).max(120),
  /** Wardrobe, features, age, style: used in every prompt that features them. */
  description: z.string().max(4000).default(""),
  /** Reference image media ids, best first. */
  refImageIds: z.array(z.string()).default([]),
  /** The uploader confirmed they have consent from any real person shown in uploaded photos. */
  consentConfirmed: z.boolean().optional(),
  /** Why the last generated image failed, in plain words. Cleared on the next try. */
  error: z.string().max(500).optional(),
});
export type CastMember = z.infer<typeof CastMember>;

export const DialogueLine = z.object({
  id: z.string(),
  /** The speaking character, or null for narration. */
  castId: z.string().nullable(),
  text: z.string().max(1000),
  /** A text-to-speech take for this line, if one was made. */
  ttsMediaId: z.string().optional(),
});
export type DialogueLine = z.infer<typeof DialogueLine>;

export const AudioMode = z.enum(["native", "tts", "none"]);
export type AudioMode = z.infer<typeof AudioMode>;

export const TakeStatus = z.enum(["queued", "running", "done", "failed"]);
export type TakeStatus = z.infer<typeof TakeStatus>;

/** One try at a shot: a first frame, then image-to-video. */
export const Take = z.object({
  id: z.string(),
  tier: Tier,
  imageModel: z.string(),
  videoModel: z.string(),
  status: TakeStatus,
  frameJobId: z.string().optional(),
  videoJobId: z.string().optional(),
  frameMediaId: z.string().optional(),
  videoMediaId: z.string().optional(),
  error: z.string().optional(),
  /** A continued shot's final waits for the shot before it to finish its own final. */
  waitsForShotId: z.string().optional(),
  createdAt: z.string(),
});
export type Take = z.infer<typeof Take>;

export const Shot = z.object({
  id: z.string(),
  description: z.string().max(4000),
  camera: z.string().max(500).default(""),
  castIds: z.array(z.string()).default([]),
  dialogue: z.array(DialogueLine).default([]),
  durationS: z.number().positive().max(30),
  audio: AudioMode.default("native"),
  /** Only approved shots may be sent to the final tier. */
  approved: z.boolean().default(false),
  takes: z.array(Take).default([]),
  /** The take shown on the card and used by a rough cut. */
  selectedTakeId: z.string().optional(),
  /** Start from the last frame of the previous shot in the scene, so the action carries straight on. */
  continueFromPrevious: z.boolean().default(false),
  /** Text the studio draws over the shot when the episode is assembled (a card, a sign, a date). */
  onScreenText: z.string().max(300).default(""),
});
export type Shot = z.infer<typeof Shot>;

export const Scene = z.object({
  id: z.string(),
  heading: z.string().max(300),
  /** The scene's slice of the script. */
  script: z.string().max(40_000).default(""),
  locationId: z.string().nullable().default(null),
  shots: z.array(Shot).default([]),
});
export type Scene = z.infer<typeof Scene>;

export const Episode = z.object({
  id: z.string(),
  title: z.string().max(300),
  script: z.string().max(200_000).default(""),
  scenes: z.array(Scene).default([]),
});
export type Episode = z.infer<typeof Episode>;

/** Every try, its model, provider, price and refund. */
export const CostLine = z.object({
  id: z.string(),
  jobId: z.string(),
  at: z.string(),
  kind: z.enum(["image", "video", "tts", "llm"]),
  purpose: z.string(),
  model: z.string(),
  provider: z.string(),
  tier: Tier.nullable(),
  episodeId: z.string().nullable(),
  shotId: z.string().nullable(),
  castId: z.string().nullable(),
  units: z.number().nonnegative(),
  unit: z.string(),
  /** What the price config predicted, before submission. */
  estimateMicro: z.number().int(),
  /** What the provider billed (0 when it didn't bill). */
  providerCostMicro: z.number().int(),
  /** "unit_price" = published price × units; "provider" = the provider reported it. */
  costSource: z.enum(["unit_price", "provider"]),
  status: z.enum(["pending", "charged", "refunded", "failed_billed"]),
  note: z.string().default(""),
});
export type CostLine = z.infer<typeof CostLine>;

export const Project = z.object({
  format: z.literal(PROJECT_FORMAT),
  id: z.string(),
  name: z.string().min(1).max(200),
  /** Logline or idea the project started from. */
  idea: z.string().max(4000).default(""),
  aspect: Aspect.default("9:16"),
  createdAt: z.string(),
  updatedAt: z.string(),
  cast: z.array(CastMember).default([]),
  episodes: z.array(Episode).default([]),
  media: z.array(MediaRef).default([]),
  costLog: z.array(CostLine).default([]),
});
export type Project = z.infer<typeof Project>;

export function parseProject(json: unknown): Project {
  return Project.parse(json);
}
