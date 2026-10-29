/** Getting images into a shape the moderation API accepts, and sampling frames from videos. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaDuration, runFfmpeg } from "@reel/core";
import type { ModerationRules } from "./rules";

export interface CheckImage {
  bytes: Uint8Array;
  contentType: string;
  name: string;
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "reel-mod-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

/**
 * Returns the image as-is when the API accepts it, or a resized JPEG when it is
 * large or in another format. Throws when it can't be made checkable.
 */
export async function prepareImage(img: CheckImage, rules: ModerationRules["images"]): Promise<CheckImage> {
  if (rules.acceptedTypes.includes(img.contentType) && img.bytes.byteLength <= rules.resizeAboveBytes) return img;
  const out = await withTemp(async (dir) => {
    const input = join(dir, `in.${EXT[img.contentType] ?? "bin"}`);
    const output = join(dir, "out.jpg");
    writeFileSync(input, img.bytes);
    const side = rules.resizeMaxSide;
    await runFfmpeg(
      [
        "-i",
        input,
        "-vf",
        `scale='min(${side},iw)':'min(${side},ih)':force_original_aspect_ratio=decrease`,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        output,
      ],
      { timeoutMs: 60_000 },
    );
    return readFileSync(output);
  });
  if (out.byteLength > rules.maxBytes) throw new Error("image still too large after resizing");
  return { bytes: out, contentType: "image/jpeg", name: img.name };
}

/** `count` JPEG frames spread from the start to the end of a video. */
export async function videoFrames(bytes: Uint8Array, contentType: string, count: number, maxSide = 1024): Promise<CheckImage[]> {
  return withTemp(async (dir) => {
    const input = join(dir, `in.${EXT[contentType] ?? "mp4"}`);
    writeFileSync(input, bytes);
    const duration = await mediaDuration(input);
    const last = Math.max(0, duration - 0.2);
    const times = count === 1 ? [last / 2] : Array.from({ length: count }, (_, i) => (last * i) / (count - 1));
    const frames: CheckImage[] = [];
    for (const [i, t] of times.entries()) {
      const out = join(dir, `f${i}.jpg`);
      await runFfmpeg(["-ss", t.toFixed(3), "-i", input, "-frames:v", "1", "-vf", `scale='min(${maxSide},iw)':-2`, "-q:v", "3", out], {
        timeoutMs: 60_000,
      });
      frames.push({ bytes: readFileSync(out), contentType: "image/jpeg", name: `frame-${i}-${t.toFixed(1)}s.jpg` });
    }
    return frames;
  });
}
