/**
 * Phase 5 acceptance: disallowed prompts and images are blocked BEFORE any
 * provider call or hold, through the real studio API; every block is logged;
 * the check fails closed; output review hides a flagged file and flags the workspace.
 */
import { Hono } from "hono";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walletState } from "../src/billing/wallet";
import type { AppEnv } from "../src/context";
import { FakeClassifier, openAiClassifier } from "../src/moderation/classifier";
import { reportRoutes, resetReportRateLimit } from "../src/moderation/report";
import { nameMatcher, normalise } from "../src/moderation/rules";
import { BLOCKED_MESSAGE, UNAVAILABLE_MESSAGE, createModeration, createModerationService } from "../src/moderation/service";
import { WorkspaceStores } from "../src/stores";
import { tickJobs } from "../src/worker";
import { type TestApp, testApp } from "./harness";

let t: TestApp;
let fake: FakeClassifier;
let cookie: string;
let ws: string;

type Json = Record<string, any>;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await t.request(method, `/api${path}`, { cookie, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : {} };
}

async function newProject() {
  const p = await api("POST", "/projects", { name: "Moderation test" });
  expect(p.status).toBe(201);
  const pid = p.json.id as string;
  const ep = await api("POST", `/projects/${pid}/episodes`, { title: "Episode 1" });
  const eid = ep.json.episodeId as string;
  const sc = await api("POST", `/projects/${pid}/episodes/${eid}/scenes`, { heading: "INT. CAFE - DAY" });
  const scid = sc.json.project.episodes[0].scenes[0].id as string;
  return { pid, eid, scid };
}

async function addCast(pid: string, name: string, description = "", kind = "character"): Promise<string> {
  const r = await api("POST", `/projects/${pid}/cast`, { kind, name, description });
  expect(r.status).toBe(201);
  const cast = r.json.project.cast as { id: string; name: string }[];
  return cast[cast.length - 1]!.id;
}

async function addShot(pid: string, scid: string, description: string, castIds: string[] = []): Promise<string> {
  const r = await api("POST", `/projects/${pid}/scenes/${scid}/shots`, { description, castIds, durationS: 5 });
  expect(r.status).toBe(201);
  const shots = r.json.project.episodes[0].scenes[0].shots as { id: string }[];
  return shots[shots.length - 1]!.id;
}

/** Stores a reference image the way the studio's upload does, without going through the upload route. */
async function plantUpload(pid: string, cid: string, bytes: Uint8Array) {
  const stores = new WorkspaceStores(t.deps.db, t.deps.blobs, ws);
  const ref = await stores.put(pid, { bytes, contentType: "image/png", source: "upload" });
  await stores.mutate(pid, (p) => {
    p.media.push(ref);
    const c = p.cast.find((x) => x.id === cid)!;
    c.refImageIds.unshift(ref.id);
    c.consentConfirmed = true;
  });
  return ref.id;
}

async function uploadRaw(pid: string, cid: string, bytes: Uint8Array, type = "image/png") {
  const fd = new FormData();
  fd.set("file", new File([bytes as BlobPart], "ref.png", { type }));
  fd.set("consent", "true");
  const req = new Request("http://x/", { method: "POST", body: fd });
  const res = await t.request("POST", `/api/projects/${pid}/cast/${cid}/upload`, {
    cookie,
    body: new Uint8Array(await req.arrayBuffer()),
    headers: { "content-type": req.headers.get("content-type")! },
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Json };
}

async function upload(pid: string, cid: string, bytes: Uint8Array) {
  expect((await uploadRaw(pid, cid, bytes)).status).toBe(201);
}

const count = async (table: "holds" | "ledger" | "moderation_events") =>
  Number((await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(t.deps.db)).rows[0]!.n);

/** Asserts a request was blocked before anything was spent, and logged with `reason`. */
async function expectBlocked(res: { status: number; json: Json }, reason: string | RegExp, message = BLOCKED_MESSAGE) {
  expect(res.status).toBe(402);
  expect(res.json.error).toBe(message);
  expect(t.mock.submitted).toHaveLength(0);
  expect(await count("holds")).toBe(0);
  expect(await count("ledger")).toBe(1); // the top-up only
  const w = await walletState(t.deps.db, ws);
  expect(w.balanceMicro).toBe(20_000_000);
  expect(w.heldMicro).toBe(0);
  const ev = await t.deps.db.selectFrom("moderationEvents").selectAll().orderBy("id", "desc").executeTakeFirstOrThrow();
  expect(ev.blocked).toBe(true);
  expect(ev.workspaceId).toBe(ws);
  expect(ev.userId).not.toBeNull();
  expect(ev.reasons.some((r) => (typeof reason === "string" ? r === reason : reason.test(r)))).toBe(true);
}

async function settleJobs() {
  for (let i = 0; i < 20; i++) {
    const open = await t.deps.db.selectFrom("jobs").select("id").where("unfinished", "=", true).execute();
    if (!open.length) return;
    await tickJobs(t.deps);
  }
  throw new Error("jobs did not finish");
}

beforeEach(async () => {
  fake = new FakeClassifier();
  t = await testApp({ deps: { moderation: createModerationService(() => t.deps, { classify: fake.classify }) } });
  cookie = await t.signIn("maker@reel.test");
  ws = await t.workspaceOf(cookie);
  await t.fund(ws, 20);
});

afterEach(async () => {
  await t.close();
});

describe("blocked before any money is spent", () => {
  it("sexual content involving minors in a cast description", async () => {
    const { pid } = await newProject();
    const cid = await addCast(pid, "Mia", "a schoolgirl [nsfw-minor]");
    await expectBlocked(await api("POST", `/projects/${pid}/cast/${cid}/generate`), "sexual/minors");
  });

  it("sexual content involving minors in a shot prompt", async () => {
    const { pid, scid } = await newProject();
    const sid = await addShot(pid, scid, "Two teens alone [nsfw-minor]");
    await expectBlocked(await api("POST", `/projects/${pid}/shots/${sid}/takes`, { tier: "draft" }), "sexual/minors");
    // The take was removed, nothing is pending in the cost log.
    const p = await api("GET", `/projects/${pid}`);
    expect(p.json.project.episodes[0].scenes[0].shots[0].takes).toHaveLength(0);
    expect(p.json.project.costLog).toHaveLength(0);
  });

  it("a public figure's name in a prompt", async () => {
    const { pid, scid } = await newProject();
    const sid = await addShot(pid, scid, "Taylor Swift walks into the cafe and orders a coffee");
    await expectBlocked(await api("POST", `/projects/${pid}/shots/${sid}/takes`, { tier: "draft" }), "public-figure:Taylor Swift");
    expect(fake.calls).toBe(0); // refused locally, before the moderation API
  });

  it("a public figure as a character name used in a prompt", async () => {
    const { pid, scid } = await newProject();
    const cid = await addCast(pid, "Elon Musk", "tech founder in a black t-shirt");
    const sid = await addShot(pid, scid, "He looks out of the window", [cid]);
    await expectBlocked(await api("POST", `/projects/${pid}/shots/${sid}/takes`, { tier: "draft" }), "public-figure:Elon Musk");
    await expectBlocked(await api("POST", `/projects/${pid}/cast/${cid}/generate`), "public-figure:Elon Musk");
  });

  it("public figure names with accents, case and punctuation", async () => {
    const { pid } = await newProject();
    const cid = await addCast(pid, "BEYONCÉ!!", "singer");
    await expectBlocked(await api("POST", `/projects/${pid}/cast/${cid}/generate`), "public-figure:Beyonce");
  });

  it("a sexual reference image", async () => {
    const { pid, scid } = await newProject();
    const cid = await addCast(pid, "Lena", "a woman in a red coat");
    await plantUpload(pid, cid, new TextEncoder().encode("fake png bytes [nsfw]"));
    const sid = await addShot(pid, scid, "Lena waits at the bus stop", [cid]);
    await expectBlocked(await api("POST", `/projects/${pid}/shots/${sid}/takes`, { tier: "draft" }), "sexual/image");
  });

  it("sexual text together with a reference photo (sexualising a pictured person)", async () => {
    const { pid, scid } = await newProject();
    const cid = await addCast(pid, "Lena", "a woman in a red coat");
    await upload(pid, cid, new TextEncoder().encode("an ordinary photo"));
    const sid = await addShot(pid, scid, "Lena undresses [nsfw]", [cid]);
    await expectBlocked(await api("POST", `/projects/${pid}/shots/${sid}/takes`, { tier: "draft" }), "sexual/real-person");
  });

  it("threats", async () => {
    const { pid, scid } = await newProject();
    const sid = await addShot(pid, scid, "He says he will find her and hurt her [threat]");
    await expectBlocked(await api("POST", `/projects/${pid}/shots/${sid}/takes`, { tier: "draft" }), "harassment/threatening");
  });

  it("fails closed when the moderation API is down", async () => {
    const { pid } = await newProject();
    const cid = await addCast(pid, "Mia", "a baker with flour on her apron");
    fake.fail = true;
    await expectBlocked(await api("POST", `/projects/${pid}/cast/${cid}/generate`), "moderation-unavailable", UNAVAILABLE_MESSAGE);
  });

  it("logs one event per blocked attempt", async () => {
    const { pid, scid } = await newProject();
    const sid = await addShot(pid, scid, "[threat] again");
    await api("POST", `/projects/${pid}/shots/${sid}/takes`, { tier: "draft" });
    await api("POST", `/projects/${pid}/shots/${sid}/takes`, { tier: "draft" });
    expect(await count("moderation_events")).toBe(2);
    const ev = await t.deps.db.selectFrom("moderationEvents").selectAll().executeTakeFirstOrThrow();
    expect(ev.stage).toBe("generation:frame");
    expect(ev.target).toContain("[threat] again");
  });
});

describe("allowed requests", () => {
  it("pass and reach the provider with a hold", async () => {
    const { pid, scid } = await newProject();
    const cid = await addCast(pid, "Mia", "a baker with flour on her apron");
    const r = await api("POST", `/projects/${pid}/cast/${cid}/generate`);
    expect(r.status).toBe(202);
    expect(t.mock.submitted).toHaveLength(1);
    expect(await count("holds")).toBe(1);
    await upload(pid, cid, new TextEncoder().encode("an ordinary photo"));
    const sid = await addShot(pid, scid, "Mia opens the shop at dawn", [cid]);
    expect((await api("POST", `/projects/${pid}/shots/${sid}/takes`, { tier: "draft" })).status).toBe(202);
    expect(t.mock.submitted).toHaveLength(2);
    expect(t.mock.submitted[1]!.input.images).toHaveLength(1);
    expect(await count("moderation_events")).toBe(0);
  });
});

describe("output review", () => {
  it("hides a flagged generated image, flags the workspace, and the media route 404s", async () => {
    const { pid } = await newProject();
    const cid = await addCast(pid, "Mia", "a baker");
    expect((await api("POST", `/projects/${pid}/cast/${cid}/generate`)).status).toBe(202);
    await settleJobs();
    const p = await api("GET", `/projects/${pid}`);
    const mid = p.json.project.media[0].id as string;
    expect((await api("GET", `/projects/${pid}/media/${mid}`)).status).toBe(302);

    fake.flagImages = true;
    expect(await t.deps.moderation.reviewOutputs(10)).toBe(1);

    const row = await t.deps.db.selectFrom("media").selectAll().where("id", "=", mid).executeTakeFirstOrThrow();
    expect(row.hiddenAt).not.toBeNull();
    expect(row.moderatedAt).not.toBeNull();
    expect(row.hiddenReason).toContain("sexual/image");
    const w = await t.deps.db.selectFrom("workspaces").selectAll().where("id", "=", ws).executeTakeFirstOrThrow();
    expect(w.flaggedAt).not.toBeNull();
    expect((await api("GET", `/projects/${pid}/media/${mid}`)).status).toBe(404);
    const after = await api("GET", `/projects/${pid}`);
    expect(after.json.project.media[0].hidden).toBe(true);
    const ev = await t.deps.db.selectFrom("moderationEvents").selectAll().where("stage", "=", "output").executeTakeFirstOrThrow();
    expect(ev.reasons).toContain("sexual/image");
    // Reviewed once only.
    expect(await t.deps.moderation.reviewOutputs(10)).toBe(0);
  });

  it("samples frames of generated videos", async () => {
    const { pid, scid } = await newProject();
    const sid = await addShot(pid, scid, "A quiet street at dawn");
    expect((await api("POST", `/projects/${pid}/shots/${sid}/takes`, { tier: "draft" })).status).toBe(202);
    await settleJobs();
    const media = await t.deps.db.selectFrom("media").select(["id", "contentType"]).execute();
    const video = media.find((m) => m.contentType.startsWith("video/"));
    expect(video).toBeDefined();

    const calls: number[] = [];
    const inner = fake.classify;
    t.deps.moderation = createModerationService(() => t.deps, {
      classify: async (inputs) => {
        calls.push(inputs.length);
        return inner(inputs);
      },
    });
    fake.flagImages = true;
    expect(await t.deps.moderation.reviewOutputs(10)).toBe(media.length);
    expect(calls).toContain(3); // three frames from the video
    const v = await t.deps.db.selectFrom("media").selectAll().where("id", "=", video!.id).executeTakeFirstOrThrow();
    expect(v.hiddenAt).not.toBeNull();
    expect((await api("GET", `/projects/${pid}/media/${video!.id}`)).status).toBe(404);
  }, 60_000);

  it("reviews uploads too (the studio's upload route doesn't call check())", async () => {
    const { pid } = await newProject();
    const cid = await addCast(pid, "Lena", "a woman");
    await plantUpload(pid, cid, new TextEncoder().encode("fake png bytes [nsfw]"));
    expect(await t.deps.moderation.reviewOutputs(10)).toBe(1);
    const row = await t.deps.db.selectFrom("media").selectAll().executeTakeFirstOrThrow();
    expect(row.source).toBe("upload");
    expect(row.hiddenAt).not.toBeNull();
    expect(
      (await t.deps.db.selectFrom("workspaces").select("flaggedAt").where("id", "=", ws).executeTakeFirstOrThrow()).flaggedAt,
    ).not.toBeNull();
  });

  it("a sexual upload never stays visible: blocked at upload (402) or hidden by review", async () => {
    const { pid } = await newProject();
    const cid = await addCast(pid, "Lena", "a woman");
    const res = await uploadRaw(pid, cid, new TextEncoder().encode("fake png bytes [nsfw]"));
    if (res.status === 402) {
      expect(res.json.error).toBe(BLOCKED_MESSAGE);
      expect(await t.deps.db.selectFrom("media").select("id").execute()).toHaveLength(0);
    } else {
      expect(res.status).toBe(201);
      await t.deps.moderation.reviewOutputs(10);
      const row = await t.deps.db.selectFrom("media").selectAll().executeTakeFirstOrThrow();
      expect(row.hiddenAt).not.toBeNull();
      expect((await api("GET", `/projects/${pid}/media/${row.id}`)).status).toBe(404);
    }
    expect(await count("moderation_events")).toBe(1);
  });

  it("leaves files for the next tick when the API is down", async () => {
    const { pid } = await newProject();
    const cid = await addCast(pid, "Lena", "a woman");
    await upload(pid, cid, new TextEncoder().encode("an ordinary photo"));
    fake.fail = true;
    expect(await t.deps.moderation.reviewOutputs(10)).toBe(0);
    const row = await t.deps.db.selectFrom("media").selectAll().executeTakeFirstOrThrow();
    expect(row.moderatedAt).toBeNull();
    expect(row.hiddenAt).toBeNull();
  });
});

describe("service details", () => {
  it("normalises names and matches whole words", () => {
    expect(normalise("Beyoncé's  NEW-song!")).toBe("beyonce s new song");
    const m = nameMatcher(["Taylor Swift", "Pope Leo", "MrBeast"]);
    expect(m.find("T.A.Y.L.O.R S.W.I.F.T on stage")).toEqual(["Taylor Swift"]);
    expect(m.find("taylor-swift's song")).toEqual(["Taylor Swift"]);
    expect(m.find("Mr. Beast gives away cars")).toEqual(["MrBeast"]);
    expect(m.find("A tailor swiftly sews")).toEqual([]);
    expect(m.find("the pope leonardo")).toEqual([]);
  });

  it("development without a key blocks nothing but still refuses public figures", async () => {
    const mod = createModeration({ ...t.deps, config: { ...t.deps.config, NODE_ENV: "development", OPENAI_API_KEY: "" } });
    expect(await mod.check({ workspaceId: ws, stage: "generation", texts: ["[nsfw-minor]"], images: [] })).toEqual({ ok: true });
    expect((await mod.check({ workspaceId: ws, stage: "generation", texts: ["Kim Kardashian at a party"], images: [] })).ok).toBe(false);
    expect(await mod.reviewOutputs(10)).toBe(0);
  });

  it("calls OpenAI omni-moderation with texts and images as data URLs", async () => {
    const seen: { url: string; auth: string | null; body: Json }[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Json;
      seen.push({ url, auth: new Headers(init.headers).get("authorization"), body });
      const n = Array.isArray(body.input) ? body.input.length : 1;
      const isImage = typeof body.input[0] === "object";
      const result = {
        flagged: isImage,
        categories: { sexual: isImage, "sexual/minors": false },
        category_scores: { sexual: isImage ? 0.9 : 0.01, "sexual/minors": 0 },
      };
      return new Response(JSON.stringify({ results: Array.from({ length: n }, () => result) }), { status: 200 });
    }) as unknown as typeof fetch;
    const classify = openAiClassifier({
      apiKey: "sk-test",
      model: "omni-moderation-latest",
      endpoint: "https://api.openai.com/v1/moderations",
      timeoutMs: 5000,
      fetch: fetchStub,
    });
    const mod = createModerationService(t.deps, { classify });
    const v = await mod.check({
      workspaceId: ws,
      stage: "upload",
      texts: ["a calm portrait", "second text"],
      images: [{ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png", name: "a.png" }],
    });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reasons).toEqual(["sexual/image"]);
    expect(seen).toHaveLength(2);
    expect(
      seen.every(
        (s) =>
          s.url === "https://api.openai.com/v1/moderations" && s.auth === "Bearer sk-test" && s.body.model === "omni-moderation-latest",
      ),
    ).toBe(true);
    expect(seen.find((s) => typeof s.body.input[0] === "string")!.body.input).toEqual(["a calm portrait", "second text"]);
    expect(seen.find((s) => typeof s.body.input[0] === "object")!.body.input[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AQID" },
    });

    const down = createModerationService(t.deps, {
      classify: openAiClassifier({
        apiKey: "k",
        model: "m",
        endpoint: "https://api.openai.com/v1/moderations",
        timeoutMs: 5000,
        fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch,
      }),
    });
    const d = await down.check({ workspaceId: ws, stage: "generation", texts: ["hello"], images: [] });
    expect(d).toMatchObject({ ok: false, message: UNAVAILABLE_MESSAGE });
  });
});

describe("abuse report form", () => {
  const reportApp = () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("deps", t.deps);
      c.set("user", null);
      await next();
    });
    app.route("/", reportRoutes);
    return app;
  };
  const post = (app: Hono<AppEnv>, fields: Record<string, string>) =>
    app.fetch(
      new Request("http://localhost:3299/report", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" },
        body: new URLSearchParams(fields).toString(),
      }),
    );

  it("shows the form, stores a report, and rate-limits per IP", async () => {
    resetReportRateLimit();
    const app = reportApp();
    const page = await app.fetch(new Request("http://localhost:3299/report"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Report abuse");

    const ok = await post(app, {
      url: "https://example.com/v/1",
      reason: "impersonation",
      details: "Uses a real person's face",
      email: "r@example.com",
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Thank you");
    const row = await t.deps.db.selectFrom("abuseReports").selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ url: "https://example.com/v/1", reason: "impersonation", reporterEmail: "r@example.com", status: "open" });

    expect((await post(app, { reason: "impersonation" })).status).toBe(400); // needs a link or details
    for (let i = 0; i < 4; i++) expect((await post(app, { reason: "other", details: `report ${i}` })).status).toBe(200);
    expect((await post(app, { reason: "other", details: "one too many" })).status).toBe(429);
    expect(Number((await sql<{ n: string }>`SELECT count(*) AS n FROM abuse_reports`.execute(t.deps.db)).rows[0]!.n)).toBe(5);
  });
});
