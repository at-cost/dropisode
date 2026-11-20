import { ApiError } from "@fal-ai/client";
import { describe, expect, it } from "vitest";
import { FalProvider, costFromBillingEvents } from "../src/providers/fal";
import { ProviderRejected, type JobRecord } from "../src/providers/types";
import { testCatalog } from "./helpers";

function fakeClient(over: { status?: string; result?: () => unknown; submit?: () => unknown } = {}) {
  const calls: { submit: unknown[]; uploads: number } = { submit: [], uploads: 0 };
  const client = {
    queue: {
      submit: async (endpoint: string, opts: unknown) => {
        calls.submit.push([endpoint, opts]);
        if (over.submit) return over.submit();
        return { request_id: "req-1" };
      },
      status: async () => ({ status: over.status ?? "COMPLETED" }),
      result: async () => ({ data: over.result ? over.result() : { video: { url: "https://v3.fal.media/x.mp4" } }, requestId: "req-1" }),
    },
    storage: {
      upload: async () => {
        calls.uploads++;
        return `https://v3.fal.media/files/up${calls.uploads}.png`;
      },
    },
  };
  return { client: client as never, calls };
}

const job = (model: string, kind: JobRecord["kind"] = "video"): JobRecord => ({
  id: "job_1",
  projectId: "prj_1",
  kind,
  purpose: "video",
  model,
  provider: "fal",
  tier: "final",
  refs: {},
  estimateMicro: 1,
  units: 1,
  unit: "second",
  state: "submitted",
  requestId: "req-1",
  finalized: false,
  createdAt: "",
  updatedAt: "",
});

const catalog = testCatalog();

/** A fetch that records submits and answers with the given status and body. */
function fakeFetch(status = 200, body: unknown = { request_id: "req-1" }) {
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    if (init?.body === undefined && status === -1) throw new TypeError("fetch failed");
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (status === -1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const img = { bytes: new Uint8Array([1, 2]), contentType: "image/png", name: "a.png" };

describe("fal adapter", () => {
  it("maps fields from the catalog, uploads images and passes the webhook", async () => {
    const { client } = fakeClient();
    const f = fakeFetch();
    const fal = new FalProvider({ key: "k1", client, catalog, fetch: f.fn });
    const model = catalog.get("vid-final");
    const res = await fal.submit(
      job("vid-final"),
      { model, prompt: "p", image: img, durationS: 6, aspect: "9:16", audio: true },
      { webhookUrl: "https://h/wh?job=job_1" },
    );
    expect(res).toEqual({ requestId: "req-1", endpoint: "fal-ai/test-final" });
    expect(f.calls[0]).toEqual({
      url: `https://queue.fal.run/fal-ai/test-final?fal_webhook=${encodeURIComponent("https://h/wh?job=job_1")}`,
      body: { prompt: "p", image_url: "https://v3.fal.media/files/up1.png", duration: "6s", aspect_ratio: "9:16", generate_audio: true },
      auth: "Key k1",
    });
  });

  it("uses the text-only endpoint when there are no reference images", async () => {
    const cfg = structuredClone(catalog.config);
    cfg.models.find((m) => m.id === "img-cheap")!.textEndpoint = "fal-ai/test-image/t2i";
    const { Catalog } = await import("../src/catalog");
    const cat = new Catalog(cfg);
    const f = fakeFetch();
    const fal = new FalProvider({ key: "k", client: fakeClient().client, catalog: cat, fetch: f.fn });
    expect((await fal.submit(job("img-cheap", "image"), { model: cat.get("img-cheap"), prompt: "p" })).endpoint).toBe(
      "fal-ai/test-image/t2i",
    );
    expect((await fal.submit(job("img-cheap", "image"), { model: cat.get("img-cheap"), prompt: "p", images: [img] })).endpoint).toBe(
      "fal-ai/test-image",
    );
  });

  it("sends nested fields, aspect values, system prompt and max tokens", async () => {
    const fal = new FalProvider({ key: "k", client: fakeClient().client, catalog });
    const model = structuredClone(catalog.get("llm"));
    model.input.system = "system_prompt";
    model.input.maxTokens = "max_tokens";
    model.input.voice = "voice_setting.voice_id";
    model.input.aspect = "image_size";
    model.input.aspectValues = { "9:16": "portrait_16_9" };
    expect(await fal.buildInput({ model, prompt: "p", system: "s", maxTokens: 100, voice: "v1", aspect: "9:16" })).toEqual({
      model: "test/model",
      prompt: "p",
      system_prompt: "s",
      max_tokens: 100,
      voice_setting: { voice_id: "v1" },
      image_size: "portrait_16_9",
    });
  });

  it("caps reference images at the model's limit", async () => {
    const { client } = fakeClient();
    const fal = new FalProvider({ key: "", client, catalog });
    const input = await fal.buildInput({ model: catalog.get("img-cheap"), prompt: "p", images: [img, img, img, img, img, img] });
    expect((input.image_urls as string[]).length).toBe(4);
  });

  it("reads status and output", async () => {
    expect(await new FalProvider({ key: "", client: fakeClient({ status: "IN_QUEUE" }).client, catalog }).check(job("vid-final"))).toEqual({
      state: "queued",
    });
    expect(await new FalProvider({ key: "", client: fakeClient().client, catalog }).check(job("vid-final"))).toEqual({
      state: "done",
      output: { url: "https://v3.fal.media/x.mp4" },
    });
  });

  it("reads LLM text and token usage", async () => {
    const { client } = fakeClient({ result: () => ({ output: "hello", usage: { prompt_tokens: 10, completion_tokens: 20 } }) });
    expect(await new FalProvider({ key: "", client, catalog }).check(job("llm", "llm"))).toEqual({
      state: "done",
      output: { text: "hello", inputTokens: 10, outputTokens: 20 },
    });
  });

  it("a server error is a failure fal didn't bill", async () => {
    const { client } = fakeClient({
      result: () => {
        throw new ApiError({ message: "boom", status: 500, body: { detail: "Internal error" } } as never);
      },
    });
    expect(await new FalProvider({ key: "", client, catalog }).check(job("vid-final"))).toEqual({
      state: "failed",
      error: "fal 500: Internal error",
      billed: false,
    });
  });

  it("a retired endpoint (410 Gone) ends the job instead of being asked about forever", async () => {
    const { client } = fakeClient({
      result: () => {
        throw new ApiError({
          message: "Gone",
          status: 410,
          body: { detail: "This endpoint is deprecated and no longer available." },
        } as never);
      },
    });
    expect(await new FalProvider({ key: "", client, catalog }).check(job("vid-final"))).toMatchObject({ state: "failed", billed: false });
  });

  it("output we can't read is a failure fal billed", async () => {
    const { client } = fakeClient({ result: () => ({ nothing: true }) });
    const st = await new FalProvider({ key: "", client, catalog }).check(job("vid-final"));
    expect(st).toMatchObject({ state: "failed", billed: true });
  });

  it("a 4xx on submit is a rejection; network errors and 5xx are not", async () => {
    const model = catalog.get("vid-draft");
    const rej = fakeFetch(422, { detail: [{ msg: "duration must be 5 or 10" }] });
    await expect(
      new FalProvider({ key: "k", client: fakeClient().client, catalog, fetch: rej.fn }).submit(job("vid-draft"), { model, prompt: "p" }),
    ).rejects.toThrow(/fal 422: duration must be 5 or 10/);
    await expect(
      new FalProvider({ key: "k", client: fakeClient().client, catalog, fetch: rej.fn }).submit(job("vid-draft"), { model, prompt: "p" }),
    ).rejects.toBeInstanceOf(ProviderRejected);
    const net = fakeFetch(-1);
    await expect(
      new FalProvider({ key: "k", client: fakeClient().client, catalog, fetch: net.fn }).submit(job("vid-draft"), { model, prompt: "p" }),
    ).rejects.toBeInstanceOf(TypeError);
    const gw = fakeFetch(503, {});
    const err = await new FalProvider({ key: "k", client: fakeClient().client, catalog, fetch: gw.fn })
      .submit(job("vid-draft"), { model, prompt: "p" })
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(ProviderRejected);
  });

  it("auth, rate-limit and gateway errors on result are retried, not failed", async () => {
    for (const status of [401, 403, 429, 502, 503]) {
      const { client } = fakeClient({
        result: () => {
          throw new ApiError({ message: "x", status, body: {} } as never);
        },
      });
      await expect(new FalProvider({ key: "", client, catalog }).check(job("vid-final"))).rejects.toBeInstanceOf(ApiError);
    }
  });

  it("reads the real cost from billing events", () => {
    expect(costFromBillingEvents({ billing_events: [] }, "r")).toBeNull();
    expect(costFromBillingEvents({ billing_events: [{ request_id: "r", cost_total: 0.56 }] }, "r")).toEqual({ costMicro: 560_000 });
    expect(
      costFromBillingEvents(
        {
          billing_events: [
            { request_id: "r", cost_total: 0.56, cost_estimate_nano_usd: "560123456" },
            { request_id: "x", cost_total: 9 },
          ],
        },
        "r",
      ),
    ).toEqual({ costMicro: 560_123 });
    expect(costFromBillingEvents({ nope: 1 }, "r")).toBeNull();
  });

  it("only offers a cost lookup with a billing key", async () => {
    expect(new FalProvider({ key: "k", client: fakeClient().client, catalog }).lookupCost).toBeUndefined();
    const f = fakeFetch(200, { billing_events: [{ request_id: "req-1", cost_total: 0.3 }] });
    const fal = new FalProvider({ key: "k", billingKey: "b", client: fakeClient().client, catalog, fetch: f.fn });
    expect(await fal.lookupCost!(job("vid-final"))).toEqual({ costMicro: 300_000 });
    expect(f.calls[0]!.auth).toBe("Key b");
  });
});

describe("separated stems", () => {
  it("reads every stem a model returns, and mixes them back into one track", async () => {
    const { Catalog } = await import("../src/catalog");
    const { readOutput } = await import("../src/providers/fal");
    const { mixAudio, mediaDuration, runFfmpeg } = await import("../src/ffmpeg");
    const { readFileSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const fixture = JSON.parse(readFileSync(new URL("./catalog.fixture.json", import.meta.url), "utf8"));
    const model = new Catalog(fixture).get("demucs-effects");
    const out = readOutput(model, {
      other: { url: "https://x/o.wav" },
      drums: { url: "https://x/d.wav" },
      bass: { url: "https://x/b.wav" },
    });
    expect(out).toEqual({ url: "https://x/o.wav", mixUrls: ["https://x/d.wav", "https://x/b.wav"] });
    const dir = mkdtempSync(join(tmpdir(), "reel-stems-"));
    const tone = async (f: number, d: number) => {
      const p = join(dir, `${f}.wav`);
      await runFfmpeg(["-f", "lavfi", "-i", `sine=frequency=${f}:duration=${d}`, p]);
      return new Uint8Array(readFileSync(p));
    };
    const mixed = await mixAudio([await tone(220, 3), await tone(440, 2)]);
    const p = join(dir, "mix.wav");
    writeFileSync(p, mixed);
    expect(await mediaDuration(p)).toBeCloseTo(3, 1);
  });
});
