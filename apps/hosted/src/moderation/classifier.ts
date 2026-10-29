/**
 * Classifiers turn texts and images into category flags and scores. Production
 * uses OpenAI's omni-moderation (free). Tests use FakeClassifier, which reads
 * markers like "[nsfw-minor]" so results are deterministic.
 */
export type ClassifyInput = { kind: "text"; text: string } | { kind: "image"; bytes: Uint8Array; contentType: string; name: string };

export interface ClassifyResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  scores: Record<string, number>;
}

/** One result per input, in the same order. Throws if the check could not run. */
export type Classify = (inputs: ClassifyInput[]) => Promise<ClassifyResult[]>;

const dataUrl = (i: { bytes: Uint8Array; contentType: string }) =>
  `data:${i.contentType};base64,${Buffer.from(i.bytes).toString("base64")}`;

interface OpenAiResult {
  flagged: boolean;
  categories: Record<string, boolean | null>;
  category_scores: Record<string, number | null>;
}

function toResult(r: OpenAiResult): ClassifyResult {
  const categories: Record<string, boolean> = {};
  const scores: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.categories ?? {})) categories[k] = v === true;
  for (const [k, v] of Object.entries(r.category_scores ?? {})) scores[k] = typeof v === "number" ? v : 0;
  return { flagged: r.flagged === true, categories, scores };
}

/**
 * OpenAI moderation: all texts in one request (one result per string), each
 * image in its own request. Any HTTP or network error throws (callers fail closed).
 */
export function openAiClassifier(opts: {
  apiKey: string;
  model: string;
  endpoint: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}): Classify {
  const doFetch = opts.fetch ?? fetch;
  const call = async (input: unknown, expected: number): Promise<ClassifyResult[]> => {
    const res = await doFetch(opts.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model, input }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`moderation API answered ${res.status}`);
    const json = (await res.json()) as { results?: OpenAiResult[] };
    if (!Array.isArray(json.results) || json.results.length !== expected) throw new Error("moderation API returned an unexpected result");
    return json.results.map(toResult);
  };
  return async (inputs) => {
    const texts = inputs
      .map((i, idx) => ({ i, idx }))
      .filter((x): x is { i: Extract<ClassifyInput, { kind: "text" }>; idx: number } => x.i.kind === "text");
    const images = inputs
      .map((i, idx) => ({ i, idx }))
      .filter((x): x is { i: Extract<ClassifyInput, { kind: "image" }>; idx: number } => x.i.kind === "image");
    const out: ClassifyResult[] = new Array(inputs.length);
    const jobs: Promise<void>[] = [];
    if (texts.length) {
      jobs.push(
        call(
          texts.map((t) => t.i.text),
          texts.length,
        ).then((rs) => {
          rs.forEach((r, k) => {
            out[texts[k]!.idx] = r;
          });
        }),
      );
    }
    for (const img of images) {
      jobs.push(
        call([{ type: "image_url", image_url: { url: dataUrl(img.i) } }], 1).then((rs) => {
          out[img.idx] = rs[0]!;
        }),
      );
    }
    await Promise.all(jobs);
    return out;
  };
}

const clean = (): ClassifyResult => ({ flagged: false, categories: {}, scores: {} });

/**
 * A deterministic stand-in for tests and local development. Markers in a text
 * (or anywhere in an image's bytes) score their categories at 0.99:
 *   [nsfw-minor] sexual/minors + sexual, [nsfw] sexual, [threat] harassment/threatening,
 *   [hate-threat] hate/threatening, [violent-crime] illicit/violent, [gore] violence/graphic.
 * `fail` makes every call throw (the API is down); `flagImages` flags every image as sexual.
 */
export class FakeClassifier {
  fail = false;
  flagImages = false;
  calls = 0;
  static readonly MARKERS: Record<string, string[]> = {
    "[nsfw-minor]": ["sexual/minors", "sexual"],
    "[nsfw]": ["sexual"],
    "[threat]": ["harassment/threatening", "harassment"],
    "[hate-threat]": ["hate/threatening", "hate"],
    "[violent-crime]": ["illicit/violent", "illicit"],
    "[gore]": ["violence/graphic", "violence"],
  };

  readonly classify: Classify = async (inputs) => {
    this.calls++;
    if (this.fail) throw new Error("fake moderation API is down");
    return inputs.map((i) => {
      const r = clean();
      const text = i.kind === "text" ? i.text.toLowerCase() : Buffer.from(i.bytes).toString("latin1").toLowerCase();
      for (const [marker, cats] of Object.entries(FakeClassifier.MARKERS)) {
        if (!text.includes(marker)) continue;
        // Like OpenAI: images never score sexual/minors.
        for (const c of cats) {
          if (i.kind === "image" && c === "sexual/minors") continue;
          r.categories[c] = true;
          r.scores[c] = 0.99;
        }
      }
      if (i.kind === "image" && this.flagImages) {
        r.categories.sexual = true;
        r.scores.sexual = 0.99;
      }
      r.flagged = Object.values(r.categories).some(Boolean);
      return r;
    });
  };
}
