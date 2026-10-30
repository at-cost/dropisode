/**
 * Moderation for hosted Dropisode.
 *
 * check() runs before any money is spent: public-figure names (local list),
 * then OpenAI omni-moderation on every text and image, then the rules in
 * config/moderation.json. Every block is logged to moderation_events. If the
 * check can't run, the request is blocked (fail closed; nothing is charged).
 *
 * reviewOutputs() samples new media (generated outputs and uploads): images as
 * they are, videos as frames from start, middle and end. A hit hides the media
 * and flags the workspace for review.
 */
import type { Deps } from "../context";
import { type Classify, type ClassifyInput, FakeClassifier, openAiClassifier } from "./classifier";
import { type CheckImage, prepareImage, videoFrames } from "./images";
import { setMediaHidden } from "./media";
import { type ModerationRules, type NameMatcher, evaluate, loadPublicFigures, loadRules, nameMatcher } from "./rules";
import type { Moderation, ModerationRequest, ModerationVerdict } from "./types";

export const BLOCKED_MESSAGE = "This request was blocked by our content rules. See /aup.";
export const UNAVAILABLE_MESSAGE =
  "We couldn't run our content check just now, so nothing was sent and you were not charged. Please try again shortly.";
export const IMAGE_UNCHECKABLE_MESSAGE = "We couldn't check this image. Use a PNG, JPEG or WebP under 20 MB.";

export type ModerationDeps = Pick<Deps, "config" | "db" | "blobs">;

export interface ModerationOptions {
  /** null: check nothing (development without a key only). */
  classify: Classify | null;
  rules?: ModerationRules;
  publicFigures?: string[];
  log?: (msg: string) => void;
}

/** A doc ref that is still missing this long after the media row is reviewed anyway. */
const DOC_GRACE_MS = 10 * 60_000;

/** The default service: OpenAI with a key; the fake classifier in tests; nothing checked in development without a key. */
export function createModeration(deps: Omit<Deps, "moderation">): Moderation {
  return createModerationService(deps, { classify: defaultClassifier(deps.config) });
}

let warnedNoKey = false;

export function defaultClassifier(config: Deps["config"], rules: ModerationRules = loadRules()): Classify | null {
  if (config.OPENAI_API_KEY)
    return openAiClassifier({ apiKey: config.OPENAI_API_KEY, model: rules.model, endpoint: rules.endpoint, timeoutMs: rules.timeoutMs });
  if (config.NODE_ENV === "test") return new FakeClassifier().classify;
  if (config.NODE_ENV === "production") {
    // config.ts refuses to start production without a key; if that ever changes, block everything.
    return async () => {
      throw new Error("OPENAI_API_KEY is not set");
    };
  }
  if (!warnedNoKey) {
    warnedNoKey = true;
    console.warn(
      "reel: OPENAI_API_KEY is not set, so content moderation is OFF in this development server (public-figure names are still refused).",
    );
  }
  return null;
}

/** The service with an injectable classifier. `deps` may be a function so tests can build it before the app's deps exist. */
export function createModerationService(deps: ModerationDeps | (() => ModerationDeps), opts: ModerationOptions): Moderation {
  const get = typeof deps === "function" ? deps : () => deps;
  const rules = opts.rules ?? loadRules();
  const names: NameMatcher = nameMatcher(opts.publicFigures ?? (rules.publicFigures.enabled ? loadPublicFigures() : []));
  const warn = opts.log ?? ((m: string) => console.warn(`reel moderation: ${m}`));
  const imageRules = rules.rules.filter((r) => r.applies !== "text");

  async function logEvent(e: {
    workspaceId: string | null;
    userId?: string | undefined;
    stage: string;
    target: string;
    reasons: string[];
  }) {
    try {
      await get()
        .db.insertInto("moderationEvents")
        .values({
          workspaceId: e.workspaceId,
          userId: e.userId ?? null,
          stage: e.stage.slice(0, 100),
          target: e.target.slice(0, 300),
          blocked: true,
          reasons: JSON.stringify(e.reasons),
        })
        .execute();
    } catch (err) {
      warn(`could not log a blocked attempt: ${(err as Error).message}`);
    }
  }

  const describeRequest = (req: ModerationRequest) => {
    const first = req.texts.find((t) => t.trim()) ?? "";
    const text = first ? `"${first.replace(/\s+/g, " ").trim().slice(0, 160)}${first.length > 160 ? "..." : ""}"` : "";
    const imgs = req.images.length
      ? `${req.images.length} image(s): ${req.images
          .map((i) => i.name)
          .join(", ")
          .slice(0, 100)}`
      : "";
    return [text, imgs].filter(Boolean).join("; ") || "(empty)";
  };

  const chunks = (text: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += rules.maxTextChars) out.push(text.slice(i, i + rules.maxTextChars));
    return out;
  };

  async function check(req: ModerationRequest): Promise<ModerationVerdict> {
    const block = async (reasons: string[], message = BLOCKED_MESSAGE): Promise<ModerationVerdict> => {
      await logEvent({ workspaceId: req.workspaceId, userId: req.userId, stage: req.stage, target: describeRequest(req), reasons });
      return { ok: false, reasons, message };
    };
    const texts = req.texts.filter((t) => t.trim());

    // (a) Public figures: free, local, and checked even without a classifier.
    const figures = [...new Set(texts.flatMap((t) => names.find(t)))];
    if (figures.length) return block(figures.map((n) => `public-figure:${n}`));

    if (!opts.classify) return { ok: true };
    if (!texts.length && !req.images.length) return { ok: true };

    // (b) Images the API can read.
    const images: CheckImage[] = [];
    for (const img of req.images) {
      try {
        images.push(await prepareImage(img, rules.images));
      } catch {
        return block(["image-uncheckable"], IMAGE_UNCHECKABLE_MESSAGE);
      }
    }

    const inputs: ClassifyInput[] = [
      ...texts.flatMap(chunks).map((text) => ({ kind: "text" as const, text })),
      ...images.map((i) => ({ kind: "image" as const, ...i })),
    ];
    let results: Awaited<ReturnType<Classify>>;
    try {
      results = await opts.classify(inputs);
      if (results.length !== inputs.length) throw new Error("classifier returned the wrong number of results");
    } catch (err) {
      warn(`check failed, blocking: ${(err as Error).message}`);
      return block(["moderation-unavailable"], UNAVAILABLE_MESSAGE);
    }

    // (c) Rules from config.
    const reasons = evaluate(
      rules.rules,
      inputs.map((input, k) => ({ kind: input.kind, result: results[k]! })),
      { requestHasImage: images.length > 0, requestHasUpload: req.images.some((i) => i.origin === "upload") },
    );
    return reasons.length ? block(reasons) : { ok: true };
  }

  async function reviewOutputs(limit: number): Promise<number> {
    if (!opts.classify) return 0;
    const { db, blobs } = get();
    const rows = await db
      .selectFrom("media as m")
      .leftJoin("projects as p", (j) => j.onRef("p.id", "=", "m.projectId").onRef("p.workspaceId", "=", "m.workspaceId"))
      .select(["m.id", "m.workspaceId", "m.projectId", "m.storageKey", "m.contentType", "m.source", "m.createdAt", "p.doc"])
      .where("m.moderatedAt", "is", null)
      .where("m.deletedAt", "is", null)
      .orderBy("m.createdAt", "asc")
      .limit(limit)
      .execute();

    const markDone = (id: string) => db.updateTable("media").set({ moderatedAt: new Date() }).where("id", "=", id).execute();
    let n = 0;
    for (const row of rows) {
      const isImage = row.contentType.startsWith("image/");
      const isVideo = row.contentType.startsWith("video/");
      if (!isImage && !isVideo) {
        // Audio (TTS) isn't something the moderation API can read.
        await markDone(row.id);
        n++;
        continue;
      }
      // The studio adds the ref to the project doc just after storing the file; wait for it so hiding reaches the doc.
      const inDoc = ((row.doc as { media?: { id: string }[] } | null)?.media ?? []).some((m) => m.id === row.id);
      if (!inDoc && Date.now() - new Date(row.createdAt).getTime() < DOC_GRACE_MS) continue;

      const target = `${row.source === "upload" ? "upload" : "output"} ${row.id} (${row.contentType}) in project ${row.projectId}`;
      let frames: CheckImage[];
      try {
        const bytes = await blobs.get(row.storageKey);
        frames = isImage
          ? [await prepareImage({ bytes, contentType: row.contentType, name: row.id }, rules.images)]
          : await videoFrames(bytes, row.contentType, rules.outputFrames);
      } catch (err) {
        // Fail closed: a file we can't check stays hidden until an admin looks at it. Not the creator's fault, so no flag.
        warn(`could not read ${row.id} for review, hiding it: ${(err as Error).message}`);
        await setMediaHidden(db, row.id, { reason: "Could not be checked" });
        await markDone(row.id);
        n++;
        continue;
      }

      let results: Awaited<ReturnType<Classify>>;
      try {
        results = await opts.classify(frames.map((f) => ({ kind: "image" as const, ...f })));
        if (results.length !== frames.length) throw new Error("classifier returned the wrong number of results");
      } catch (err) {
        // The API is down: stop and retry on the next tick.
        warn(`output review paused: ${(err as Error).message}`);
        break;
      }
      const reasons = evaluate(
        imageRules,
        results.map((result) => ({ kind: "image" as const, result })),
        { requestHasImage: true, requestHasUpload: row.source === "upload" },
      );
      if (reasons.length) {
        await setMediaHidden(db, row.id, { reason: `Content rules: ${reasons.join(", ")}` });
        await db
          .updateTable("workspaces")
          .set({ flaggedAt: new Date(), flaggedReason: `Media ${row.id} hidden by output review (${reasons.join(", ")})` })
          .where("id", "=", row.workspaceId)
          .execute();
        await logEvent({ workspaceId: row.workspaceId, stage: "output", target, reasons });
      }
      await markDone(row.id);
      n++;
    }
    return n;
  }

  return { check, reviewOutputs, reviewsOutputs: !!opts.classify };
}
