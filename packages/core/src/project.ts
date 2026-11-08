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
  /** Waiting for the scene's master still before its first frame is made. */
  waitsForMaster: z.boolean().optional(),
  /** The clip's voices on their own (background removed), for a steady mix under the cuts. */
  voiceMediaId: z.string().optional(),
  error: z.string().optional(),
  /** A continued shot's final waits for the shot before it to finish its own final. */
  waitsForShotId: z.string().optional(),
  /** The target this take ends on, fixed when the take starts (so the price and the work can't drift apart). */
  endPicture: z.string().max(2000).optional(),
  /** The target picture this take's video ends on (made from its own first frame). */
  endFrameJobId: z.string().optional(),
  endFrameMediaId: z.string().optional(),
  /** How the finished clip moves: stalls and one-frame jumps, measured frame by frame. */
  analysis: z
    .object({
      durationS: z.number(),
      motion: z.array(z.number()),
      jumps: z.array(z.number()),
      stallFromS: z.number().optional(),
      suggestedOutS: z.number(),
    })
    .optional(),
  /** Where the edit ends this clip, and where a shot that continues from it starts (s). */
  outS: z.number().positive().optional(),
  /** The clip is in but not measured yet: nothing may continue from it until it is. (Takes from before measuring existed lack it and stay usable.) */
  measuring: z.boolean().optional(),
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
  /** What the last moment of the shot looks like (a change of place or age): made into a target picture from the shot's own first frame. */
  endPicture: z.string().max(2000).default(""),
  /** Text the studio draws over the shot when the episode is assembled (a card, a sign, a date). */
  onScreenText: z.string().max(300).default(""),
  /**
   * A reaction cutaway: this shot's picture plays over the previous speaking shot's sound,
   * cutting in `atS` seconds into it for `lengthS` seconds, so the line carries on over a listener.
   */
  cutaway: z
    .object({ atS: z.number().min(0).max(60), lengthS: z.number().min(0.5).max(8) })
    .nullable()
    .default(null),
});
export type Shot = z.infer<typeof Shot>;

/** A sound bed made for the edit: an episode's music, a scene's background. */
export const SoundBed = z.object({
  prompt: z.string().max(2000),
  status: z.enum(["running", "done", "failed"]),
  mediaId: z.string().optional(),
  jobId: z.string().optional(),
  error: z.string().optional(),
});
export type SoundBed = z.infer<typeof SoundBed>;

export const Scene = z.object({
  id: z.string(),
  heading: z.string().max(300),
  /** The scene's slice of the script. */
  script: z.string().max(40_000).default(""),
  locationId: z.string().nullable().default(null),
  /** Where everyone is in the scene and who is hidden from whom, fixed at storyboarding. */
  staging: z.string().max(3000).default(""),
  /** How the scene is cut: long chained takes, or quick vertical-drama cuts. */
  // Scenes from before continuous takes keep the quick cuts they were storyboarded with; new scenes are continuous.
  cutting: z.enum(["continuous", "cuts"]).default("cuts"),
  shots: z.array(Shot).default([]),
  /** One continuous background under the whole scene, so the room doesn't change at every cut. */
  ambience: SoundBed.nullable().default(null),
  /**
   * The scene's master still: everyone in the place, lit by it. Every shot's first frame is a new
   * camera angle on it, so people belong in the place instead of being pasted onto a backdrop.
   */
  master: SoundBed.nullable().default(null),
});
export type Scene = z.infer<typeof Scene>;

export const Episode = z.object({
  id: z.string(),
  title: z.string().max(300),
  script: z.string().max(200_000).default(""),
  scenes: z.array(Scene).default([]),
  /** An instrumental bed under the episode, ducked under the dialogue. */
  music: SoundBed.nullable().default(null),
});
export type Episode = z.infer<typeof Episode>;

/** Every try, its model, provider, price and refund. */
export const CostLine = z.object({
  id: z.string(),
  jobId: z.string(),
  at: z.string(),
  kind: z.enum(["image", "video", "tts", "llm", "audio"]),
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

/** The project's own model choices; anything unset uses the studio's recommended default. */
export const ProjectModels = z.object({
  draftVideo: z.string().optional(),
  finalVideo: z.string().optional(),
  image: z.string().optional(),
  castImage: z.string().optional(),
});
export type ProjectModels = z.infer<typeof ProjectModels>;

export const Project = z.object({
  format: z.literal(PROJECT_FORMAT),
  id: z.string(),
  name: z.string().min(1).max(200),
  /** Logline or idea the project started from. */
  idea: z.string().max(4000).default(""),
  aspect: Aspect.default("9:16"),
  models: ProjectModels.default({}),
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
