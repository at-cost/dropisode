/**
 * A stand-in provider that makes real media files locally with ffmpeg and
 * costs nothing. Used by tests, the demo and `REEL_PROVIDER=mock`. Its cost
 * log uses the catalog's real prices, so billing maths can be tested end to end.
 *
 * Failure injection: a prompt or text containing "[fail]" fails unbilled,
 * "[fail-billed]" fails billed. `failNext` does the same for the next N jobs.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "../ffmpeg";
import type { JobRecord, Provider, ProviderInput, ProviderStatus } from "./types";

interface MockRequest {
  job: JobRecord;
  input: ProviderInput;
  readyAt: number;
  fail?: "unbilled" | "billed";
}

export interface MockOptions {
  /** How long a request stays queued, in ms. */
  delayMs?: number;
  /** Reports real costs like fal's billing events: return null for "not yet". */
  lookupCost?: (job: JobRecord) => Promise<{ costMicro: number } | null>;
  /** Answers LLM requests. Default: `mockLlm`. */
  llm?: (purpose: string, input: ProviderInput) => string;
}

export class MockProvider implements Provider {
  readonly id = "mock";
  private requests = new Map<string, MockRequest>();
  private seq = 0;
  private failQueue: ("unbilled" | "billed")[] = [];
  readonly submitted: { job: JobRecord; input: ProviderInput }[] = [];
  readonly finalized: string[] = [];
  /** Outputs served by URL, so download failures can be simulated. */
  private hosted = new Map<string, { bytes: Uint8Array; contentType: string }>();
  private downloadFailures = 0;
  readonly lookupCost?: (job: JobRecord) => Promise<{ costMicro: number } | null>;

  constructor(private opts: MockOptions = {}) {
    if (opts.lookupCost) this.lookupCost = opts.lookupCost;
  }

  /** The next N downloads fail (outputs are then served by URL). */
  failDownloads(n: number): void {
    this.downloadFailures += n;
  }

  private serve(bytes: Uint8Array, contentType: string): { url?: string; bytes?: Uint8Array; contentType: string } {
    if (this.downloadFailures <= 0 && this.hosted.size === 0) return { bytes, contentType };
    const url = `mock://out/${this.hosted.size + 1}`;
    this.hosted.set(url, { bytes, contentType });
    return { url, contentType };
  }

  failNext(n = 1, how: "unbilled" | "billed" = "unbilled"): void {
    for (let i = 0; i < n; i++) this.failQueue.push(how);
  }

  async submit(job: JobRecord, input: ProviderInput): Promise<{ requestId: string }> {
    const requestId = `mock-${++this.seq}`;
    const text = `${input.prompt ?? ""} ${input.text ?? ""}`;
    const fail = this.failQueue.shift() ?? (text.includes("[fail-billed]") ? "billed" : text.includes("[fail]") ? "unbilled" : undefined);
    this.requests.set(requestId, { job, input, readyAt: Date.now() + (this.opts.delayMs ?? 0), ...(fail ? { fail } : {}) });
    this.submitted.push({ job, input });
    return { requestId };
  }

  async check(job: JobRecord): Promise<ProviderStatus> {
    const req = job.requestId ? this.requests.get(job.requestId) : undefined;
    if (!req) return { state: "failed", error: "mock: unknown request (the mock forgets requests when restarted)", billed: false };
    if (Date.now() < req.readyAt) return { state: "running" };
    if (req.fail === "unbilled") return { state: "failed", error: "mock: simulated server error (500)", billed: false };
    if (req.fail === "billed") return { state: "failed", error: "mock: simulated failure the provider billed", billed: true };
    const { input } = req;
    switch (job.kind) {
      case "llm":
        return { state: "done", output: { text: (this.opts.llm ?? mockLlm)(job.purpose, input) } };
      case "image":
        return { state: "done", output: this.serve(await mockImage(input), "image/png") };
      case "video":
        return { state: "done", output: this.serve(await mockVideo(input), "video/mp4") };
      case "tts":
        return { state: "done", output: this.serve(await mockTone(input.text ?? "", 0.06 * (input.text ?? "").length + 0.5), "audio/wav") };
      case "audio":
        return {
          state: "done",
          output: this.serve(await mockTone(`${job.purpose}${input.prompt ?? ""}`, input.durationS ?? 10), "audio/wav"),
        };
    }
  }

  async download(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    if (this.downloadFailures > 0) {
      this.downloadFailures--;
      throw new Error("mock: ECONNRESET");
    }
    const f = this.hosted.get(url);
    if (!f) throw new Error(`mock: no output at ${url}`);
    return f;
  }

  async finalize(job: JobRecord): Promise<void> {
    this.finalized.push(job.id);
  }
}

const color = (seed: string) => createHash("sha1").update(seed).digest("hex").slice(0, 6);

function size(input: ProviderInput, small = false): string {
  const vertical = (input.aspect ?? "9:16") === "9:16";
  const [w, h] = small ? [360, 640] : [720, 1280];
  return vertical ? `${w}x${h}` : `${h}x${w}`;
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "reel-mock-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function mockImage(input: ProviderInput): Promise<Uint8Array> {
  return withTemp(async (dir) => {
    const out = join(dir, "frame.png");
    await runFfmpeg(["-f", "lavfi", "-i", `color=c=0x${color(input.prompt ?? "")}:s=${size(input)}`, "-frames:v", "1", out]);
    return readFileSync(out);
  });
}

export function mockVideo(input: ProviderInput): Promise<Uint8Array> {
  return withTemp(async (dir) => {
    const out = join(dir, "clip.mp4");
    const d = String(input.durationS ?? 5);
    const args = [
      "-f",
      "lavfi",
      "-i",
      `testsrc2=s=${size(input, true)}:r=24:d=${d}`,
      "-f",
      "lavfi",
      "-i",
      `color=c=0x${color(input.prompt ?? "")}:s=${size(input, true)}:r=24:d=${d}`,
    ];
    const filter = "[0:v][1:v]blend=all_mode=overlay:all_opacity=0.7,format=yuv420p[v]";
    if (input.audio) args.push("-f", "lavfi", "-i", `sine=frequency=330:duration=${d}`);
    args.push("-filter_complex", filter, "-map", "[v]");
    if (input.audio) args.push("-map", "2:a", "-c:a", "aac");
    args.push("-c:v", "libx264", "-preset", "ultrafast", "-t", d, out);
    await runFfmpeg(args);
    return readFileSync(out);
  });
}

export function mockTone(seed: string, seconds: number): Promise<Uint8Array> {
  return withTemp(async (dir) => {
    const out = join(dir, "line.wav");
    const f = 200 + (Number.parseInt(color(seed).slice(0, 2), 16) % 300);
    await runFfmpeg(["-f", "lavfi", "-i", `sine=frequency=${f}:duration=${seconds.toFixed(2)}`, "-ar", "48000", out]);
    return readFileSync(out);
  });
}

/** Canned LLM answers in the shape each prompt asks for. */
export function mockLlm(purpose: string, input: ProviderInput): string {
  const idea = /IDEA:\s*([^\n]+)/.exec(input.prompt ?? "")?.[1]?.trim() ?? "A courier finds a letter addressed to herself, dated tomorrow.";
  if (purpose === "script") {
    return [
      "TITLE: The Letter",
      "",
      "CAST:",
      "- MAYA (character): late 20s courier, short black hair, yellow rain jacket, messenger bag.",
      "- LEO (character): early 30s shopkeeper, round glasses, grey cardigan.",
      "- CORNER SHOP (location): a small, warmly lit corner shop at night, rain on the windows.",
      "",
      "SCENE 1. INT. CORNER SHOP - NIGHT",
      `${idea}`,
      "Maya shakes rain off her jacket and slides a letter across the counter.",
      "MAYA: This one has my name on it. And tomorrow's date.",
      "Leo turns the envelope over under the lamp.",
      "LEO: Then you'd better not open it until tomorrow.",
      "Maya tears it open anyway.",
      "MAYA: It says: don't come back here.",
    ].join("\n");
  }
  if (purpose === "storyboard") {
    const shots = [
      {
        description: "Wide: rain-streaked window, the corner shop glowing at night. Maya pushes the door open.",
        camera: "wide, static",
        cast: ["MAYA", "CORNER SHOP"],
        dialogue: [],
        duration: 5,
      },
      {
        description: "Medium: Maya shakes rain off her yellow jacket and slides a letter across the counter.",
        camera: "medium, slow push in",
        cast: ["MAYA", "CORNER SHOP"],
        dialogue: [{ speaker: "MAYA", text: "This one has my name on it. And tomorrow's date." }],
        duration: 5,
      },
      {
        description: "Close-up: Leo turns the envelope over under the lamp, frowning.",
        camera: "close-up, handheld",
        cast: ["LEO"],
        dialogue: [],
        duration: 5,
      },
      {
        description: "Medium two-shot: Leo slides the letter back.",
        camera: "medium two-shot",
        cast: ["MAYA", "LEO"],
        dialogue: [{ speaker: "LEO", text: "Then you'd better not open it until tomorrow." }],
        duration: 5,
      },
      {
        description: "Insert: Maya's hands tear the envelope open.",
        camera: "insert, top-down",
        cast: ["MAYA"],
        dialogue: [],
        duration: 5,
      },
      {
        description: "Close-up: Maya reads, her face falling.",
        camera: "close-up, slow push in",
        cast: ["MAYA"],
        dialogue: [{ speaker: "MAYA", text: "It says: don't come back here." }],
        duration: 5,
      },
    ];
    return JSON.stringify({ shots });
  }
  if (purpose === "cast_extract") {
    return JSON.stringify({
      cast: [
        { kind: "character", name: "MAYA", description: "late 20s courier, short black hair, yellow rain jacket, messenger bag" },
        { kind: "character", name: "LEO", description: "early 30s shopkeeper, round glasses, grey cardigan" },
        { kind: "location", name: "CORNER SHOP", description: "a small, warmly lit corner shop at night, rain on the windows" },
      ],
    });
  }
  return "OK";
}
