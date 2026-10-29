/** The moderation contract the rest of hosted relies on (implemented in moderation/service.ts). */
export interface ModerationRequest {
  workspaceId: string;
  userId?: string | undefined;
  /** What is being checked: "generation", "upload", "cast_name"... */
  stage: string;
  texts: string[];
  images: { bytes: Uint8Array; contentType: string; name: string }[];
}

export type ModerationVerdict = { ok: true } | { ok: false; reasons: string[]; message: string };

export interface Moderation {
  /** Runs before any money is spent. Logs every blocked attempt. Never throws for a block. */
  check(req: ModerationRequest): Promise<ModerationVerdict>;
  /** Worker: samples frames of new generated media; a hit hides it and flags the workspace. Returns how many were checked. */
  reviewOutputs(limit: number): Promise<number>;
  /** Outputs are actually being reviewed (false only in development without a moderation key). */
  reviewsOutputs?: boolean;
}
