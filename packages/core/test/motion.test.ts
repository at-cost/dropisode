import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFfmpeg } from "../src/ffmpeg";
import { analyseClip, analyseDiffs, frameAt } from "../src/motion";

/** A moving test pattern for `moving` seconds, then (optionally) frozen for `frozen` seconds, with a hard cut part-way if asked. */
async function clip(o: { moving: number; frozen?: number; cutAt?: number }): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "motion-test-"));
  try {
    const out = join(dir, "c.mp4");
    const src = `testsrc2=s=180x320:r=24:d=${o.moving}`;
    const filters: string[] = [];
    if (o.cutAt !== undefined) filters.push(`geq=lum='if(gt(T,${o.cutAt}),255-lum(X,Y),lum(X,Y))':cb='cb(X,Y)':cr='cr(X,Y)'`);
    if (o.frozen) filters.push(`tpad=stop_mode=clone:stop_duration=${o.frozen}`);
    await runFfmpeg(["-f", "lavfi", "-i", src, ...(filters.length ? ["-vf", filters.join(",")] : []), "-pix_fmt", "yuv420p", out]);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("clip motion", () => {
  it("finds a stall at the end and suggests ending the clip before it", async () => {
    const m = await analyseClip(await clip({ moving: 4, frozen: 2 }));
    expect(m.durationS).toBeCloseTo(6, 0);
    expect(m.stallFromS).toBeGreaterThanOrEqual(3.5);
    expect(m.stallFromS).toBeLessThanOrEqual(4.5);
    expect(m.suggestedOutS).toBeLessThan(5);
    expect(m.jumps).toEqual([]);
  }, 60_000);

  it("leaves a clip that keeps moving at full length", async () => {
    const m = await analyseClip(await clip({ moving: 5 }));
    expect(m.stallFromS).toBeUndefined();
    expect(m.suggestedOutS).toBeCloseTo(5, 0);
  }, 60_000);

  it("flags a one-frame jump inside a take", async () => {
    const m = await analyseClip(await clip({ moving: 5, cutAt: 2.5 }));
    expect(m.jumps.some((t) => Math.abs(t - 2.5) < 0.1)).toBe(true);
  }, 60_000);

  it("never trims more than half a mostly still clip", () => {
    const diffs = [...Array(24).fill(6), ...Array(96).fill(0.1)];
    expect(analyseDiffs(diffs, 24, 5).suggestedOutS).toBe(5);
    // Moving for 1.5 s then still for 3.5 s: a real stall, but trimming it would cut most of the clip.
    const late = analyseDiffs([...Array(36).fill(6), ...Array(84).fill(0.1)], 24, 5);
    expect(late.suggestedOutS).toBe(5);
  });

  it("takes a frame from part-way through a clip, and near its very end", async () => {
    const c = await clip({ moving: 3 });
    expect((await frameAt(c, 1.5)).length).toBeGreaterThan(1000);
    expect((await frameAt(c, 3)).length).toBeGreaterThan(1000);
    expect((await frameAt(c, undefined)).length).toBeGreaterThan(1000);
  }, 60_000);

  it("the chained frame is exactly the last frame the edit shows (30 fps, whole frames)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motion-exact-"));
    try {
      // Brightness = 4 x frame number, so a frame's brightness says which frame it is.
      const src = join(dir, "n.mp4");
      await runFfmpeg([
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:r=30:d=2.2",
        "-vf",
        "geq=lum='3*N':cb=128:cr=128",
        "-c:v",
        "libx264",
        "-qp",
        "0",
        "-pix_fmt",
        "yuv444p",
        src,
      ]);
      const bytes = new Uint8Array(readFileSync(src));
      const level = async (jpg: Uint8Array) => {
        const f = join(dir, "f.jpg");
        const o = join(dir, "f.gray");
        (await import("node:fs")).writeFileSync(f, jpg);
        await runFfmpeg(["-i", f, "-vf", "scale=1:1,format=gray", "-f", "rawvideo", o]);
        return readFileSync(o)[0]!;
      };
      // Reference frames 43, 44 and 45, decoded by number (colour range conversion shifts every level the same way).
      const frameN = async (n: number) => {
        const o = join(dir, `r${n}.jpg`);
        await runFfmpeg(["-i", src, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-fps_mode", "vfr", "-q:v", "2", o]);
        return level(new Uint8Array(readFileSync(o)));
      };
      const ref = { 43: await frameN(43), 44: await frameN(44), 45: await frameN(45) };
      const closest = (v: number) =>
        (Object.entries(ref) as [string, number][]).sort((x, y) => Math.abs(x[1] - v) - Math.abs(y[1] - v))[0]![0];
      // The edit ending at 1.5 s shows frames 0..44: the chained frame must be frame 44.
      expect(closest(await level(await frameAt(bytes, 1.5)))).toBe("44");
      // An end point between frames is rounded down the way the assembly rounds it.
      expect(closest(await level(await frameAt(bytes, 1.51)))).toBe("44");
      // At the very end of the clip (2.2 s = 66 frames) it must still be the last frame, 65.
      const end = { 64: await frameN(64), 65: await frameN(65) };
      const v = await level(await frameAt(bytes, 2.2));
      expect(Math.abs(v - end[65])).toBeLessThan(Math.abs(v - end[64]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
