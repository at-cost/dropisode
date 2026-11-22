/** Types mirrored from the studio API (packages/studio/src/api.ts) and the project model, plus a small fetch client. */

export type Aspect = "9:16" | "16:9";
export type Tier = "draft" | "final";
export type CastKind = "character" | "location" | "prop";
export type AudioMode = "native" | "tts" | "none";

export interface MediaRef {
  id: string;
  path: string;
  contentType: string;
  bytes: number;
  createdAt: string;
  source: string;
  hidden?: boolean;
}

export interface CastMember {
  id: string;
  kind: CastKind;
  name: string;
  description: string;
  refImageIds: string[];
  consentConfirmed?: boolean;
  /** Why the last generated image failed, in plain words. */
  error?: string;
}

export interface DialogueLine {
  id: string;
  castId: string | null;
  text: string;
  ttsMediaId?: string;
}

export interface Take {
  id: string;
  tier: Tier;
  imageModel: string;
  videoModel: string;
  status: "queued" | "running" | "done" | "failed";
  frameMediaId?: string;
  videoMediaId?: string;
  error?: string;
  /** A continued final waiting for the previous shot's final. */
  waitsForShotId?: string;
  waitsForMaster?: boolean;
  /** The target picture the clip ends on. */
  endFrameMediaId?: string;
  /** How the finished clip moves: a stall at the end, one-frame jumps. */
  analysis?: { durationS: number; motion: number[]; jumps: number[]; stallFromS?: number; suggestedOutS: number; suggestedInS?: number };
  /** Where the edit starts this clip. */
  inS?: number;
  /** Where the edit ends this clip, and where a shot that continues from it starts. */
  outS?: number;
  /** The exact video prompt sent for this take. */
  prompt?: string;
  /** Made from the cast pictures (no first frame). */
  byReference?: boolean;
  /** What the check found against the plan. */
  review?: TakeReview;
  retakeOf?: string;
  autoRetake?: boolean;
  createdAt: string;
}

export interface TakeReview {
  status: "running" | "done" | "failed";
  pass?: boolean;
  problems: { atS: number | null; text: string }[];
  fixedPrompt: string;
  error?: string;
}

/** One shot inside a sequence (seconds into the clip). */
export interface Beat {
  startS: number;
  endS: number;
  size: string;
  angle: string;
  height: string;
  lens: string;
  movement: string;
  action: string;
  endState: string;
}

export interface Shot {
  id: string;
  description: string;
  camera: string;
  castIds: string[];
  dialogue: DialogueLine[];
  durationS: number;
  audio: AudioMode;
  approved: boolean;
  takes: Take[];
  selectedTakeId?: string;
  continueFromPrevious?: boolean;
  /** What the last moment looks like: a target picture made from the shot's first frame. */
  endPicture?: string;
  onScreenText?: string;
  cutaway?: { atS: number; lengthS: number } | null;
  /** How the edit comes into this shot, and a slow move added over it. */
  joinIn?: "cut" | "dissolve";
  joinS?: number;
  move?: "none" | "push-in" | "pull-out";
  /** A sequence: several shots with hard cuts inside one generation. */
  beats?: Beat[];
  logline?: string;
  startState?: string;
  sounds?: string[];
  slowMotion?: boolean;
  /** The video prompt, sent as it is. */
  writtenPrompt?: string;
  writtenFor?: string;
  promptStale?: boolean;
}

export interface Scene {
  id: string;
  heading: string;
  script: string;
  locationId: string | null;
  shots: Shot[];
  ambience?: SoundBed | null;
  /** Where everyone is in the scene and who is hidden from whom. */
  staging?: string;
  /** Long chained takes, quick vertical-drama cuts, or several shots per clip. */
  cutting?: "continuous" | "cuts" | "sequences";
  /** The world, fixed in every shot. */
  plate?: string;
  grade?: string;
  castNotes?: { name: string; size: string; anatomy: string; acting: string; side: string }[];
  counts?: { what: string; n: number }[];
  whitelist?: string[];
  /** Sequences start from the cast pictures, or from a made first frame. */
  start?: "references" | "first-frame";
  autoRetake?: boolean;
  /** Everyone in the place, lit by it: every shot's first frame is a new angle on it. */
  master?: SoundBed | null;
}

export interface SoundBed {
  prompt: string;
  status: "running" | "done" | "failed";
  mediaId?: string;
  error?: string;
}

export interface Episode {
  id: string;
  title: string;
  script: string;
  scenes: Scene[];
  music?: SoundBed | null;
  fadeInS?: number;
  fadeOutS?: number;
  soundLead?: "voices" | "music";
}

export interface CostLine {
  id: string;
  jobId: string;
  at: string;
  kind: "image" | "video" | "tts" | "llm" | "audio";
  purpose: string;
  model: string;
  provider: string;
  tier: Tier | null;
  episodeId: string | null;
  shotId: string | null;
  castId: string | null;
  units: number;
  unit: string;
  estimateMicro: number;
  providerCostMicro: number;
  costSource: "unit_price" | "provider";
  status: "pending" | "charged" | "refunded" | "failed_billed";
  note: string;
  paidMicro: number;
  estimatePaidMicro: number;
}

export interface ProjectModels {
  draftVideo?: string;
  finalVideo?: string;
  image?: string;
  castImage?: string;
}

export interface CatalogEntry {
  id: string;
  kind: string;
  label: string;
  unit: string;
  tiers?: ("draft" | "final")[];
  nativeAudio?: boolean;
  /** Can end on a target picture. */
  endFrame?: boolean;
  unitPaidMicro?: number | null;
  audioUnitPaidMicro?: number | null;
}

export interface Project {
  id: string;
  name: string;
  idea: string;
  aspect: Aspect;
  /** The project's own model choices; unset means the recommended default. */
  models?: ProjectModels;
  createdAt: string;
  updatedAt: string;
  cast: CastMember[];
  episodes: Episode[];
  media: MediaRef[];
}

export interface Totals {
  providerCostMicro: number;
  tries: number;
  refunds: number;
  pending: number;
  paidMicro: number;
}

export interface OpenJob {
  id: string;
  purpose: string;
  refs: { episodeId?: string; sceneId?: string; shotId?: string; takeId?: string; castId?: string; lineId?: string };
  state: string;
}

export interface View {
  project: Project;
  totals: Totals;
  episodeTotals: Record<string, Totals>;
  costLog: CostLine[];
  openJobs: OpenJob[];
}

export interface Estimates {
  castImage: number;
  script: number;
  storyboard: Record<string, number>;
  shots: Record<
    string,
    {
      draft: number;
      final: number;
      /** Writing the sequence's prompt on its own. */
      write?: number | null;
      /** Checking one take. */
      review?: number | null;
      /** The most one automatic retake adds. */
      autoRetake?: number;
      /** "Retake with fix", per checked take. */
      retakes?: Record<string, number>;
    }
  >;
}

export interface PromptPreview {
  prompt: string;
  source: "written" | "plan" | "template";
  model: string;
  references: string[];
}

export interface Wallet {
  balanceMicro: number;
  heldMicro: number;
  blocked: boolean;
  message?: string;
}

export interface Config {
  mode: "local" | "hosted";
  priceLabel: string;
  cameraPresets: string[];
  /** The model catalog, for human labels. */
  models?: CatalogEntry[];
  /** Recommended models per tier (the final video model decides whether "native audio" means anything). */
  defaults?: { draft?: { video?: string; image?: string }; final?: { video?: string; image?: string }; castImage?: string };
  wallet: Wallet | null;
  /** Hosted only: the signed-in person, for the profile menu. */
  account: { name: string; email: string; workspace: string; isAdmin: boolean } | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  aspect: Aspect;
  updatedAt: string;
  episodes: number;
  shots: number;
  paidMicro: number;
  /** A frame or portrait from the project, for the poster. */
  coverMediaId?: string | null;
}

export interface Dashboard {
  recent: {
    projectId: string;
    projectName: string;
    at: string;
    purpose: string;
    tier: string | null;
    label: string;
    status: string;
    paidMicro: number;
    model: string;
  }[];
  month: { month: string; days: { day: string; paidMicro: number }[]; totalMicro: number };
  running: { projectId: string; projectName: string; count: number; purposes: string[] }[];
  counts: { projects: number; shots: number };
}

export interface LocalSettings {
  provider: "mock" | "fal";
  hasKey: boolean;
  keyHint: string | null;
  hasBillingKey: boolean;
  projectsDir: string;
  configPath: string;
  ffmpeg: { path: string; subtitles: boolean } | null;
}

export interface ExportInfo {
  id: string;
  episodeId: string;
  createdAt: string;
  source: "final" | "rough";
  durationS: number;
  files: { name: string; url: string; bytes: number }[];
  skipped: { shotId: string; reason: string }[];
  warnings: string[];
  subtitles?: { start: number; end: number; text: string }[];
  subtitlesBurned?: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData || body instanceof Blob) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError("Can't reach the studio. Is it still running?", 0);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON (for example a plain-text 403).
  }
  if (!res.ok) {
    const msg = (json as { error?: string } | null)?.error ?? (text.trim() || `Request failed (${res.status})`);
    throw new ApiError(msg, res.status);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body?: unknown) => call<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => call<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body: unknown) => call<T>("PATCH", path, body),
  del: <T>(path: string) => call<T>("DELETE", path),
  raw: <T>(path: string, body: Blob | FormData) => call<T>("POST", path, body),
};

export const mediaUrl = (pid: string, mediaId: string) => `/api/projects/${pid}/media/${mediaId}`;
