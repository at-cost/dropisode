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
  createdAt: string;
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
  onScreenText?: string;
  cutaway?: { atS: number; lengthS: number } | null;
}

export interface Scene {
  id: string;
  heading: string;
  script: string;
  locationId: string | null;
  shots: Shot[];
}

export interface Episode {
  id: string;
  title: string;
  script: string;
  scenes: Scene[];
}

export interface CostLine {
  id: string;
  jobId: string;
  at: string;
  kind: "image" | "video" | "tts" | "llm";
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

export interface Project {
  id: string;
  name: string;
  idea: string;
  aspect: Aspect;
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
  shots: Record<string, { draft: number; final: number }>;
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
  models?: { id: string; kind: string; label: string; unit: string; nativeAudio?: boolean }[];
  /** Default models per tier (the final video model decides whether "native audio" means anything). */
  defaults?: { final?: { video?: string } };
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
