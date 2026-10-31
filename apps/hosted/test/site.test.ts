import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXAMPLE_PLAN, episodeCost, formatUsd, generationCharge } from "@reel/money";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FinancesSummary } from "../src/finances";
import { PUBLIC_PATHS } from "../src/site";
import { loadDemo } from "../src/site/demo";
import { tickJobs } from "../src/worker";
import { type TestApp, testApp } from "./harness";

let t: TestApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const html = async (path: string, cookie?: string) => {
  const res = await t.request("GET", path, cookie ? { cookie } : {});
  return { res, body: await res.text() };
};

/** The <tr> for one model in the calculator table. */
const calcRow = (body: string, model: string) => {
  const m = new RegExp(`<tr[^>]*data-model="${model.replace(/\./g, "\\.")}"[^>]*>([\\s\\S]*?)</tr>`).exec(body);
  if (!m) throw new Error(`No calculator row for ${model}`);
  return m[0];
};

describe("public pages", () => {
  const pages: [string, string[]][] = [
    ["/", ["Know what every shot costs", "plus 20%", "npx dropisode", "/pricing#compare", 'href="/sign-in"', 'href="/demo"', "Not always"]],
    ["/pricing", ['id="calculator"', 'id="units"', 'id="daily"', 'id="compare"', "Higgsfield", "Where subscriptions win", "verified on"]],
    ["/finances", ["Fixed costs", "assumed", "Reconciliation", "Reserve", "/finances.json"]],
    [
      "/docs",
      ["Getting started", "Drafts and finals", "Approving shots", "subtitles.srt", "edit-list.edl", "What V1 doesn&#39;t do", "Lip sync"],
    ],
    ["/docs/local", ["npx dropisode", "Node.js 22", "--mock", "config.json", "no moderation layer of ours"]],
    [
      "/terms",
      [
        "Draft: to be reviewed before launch",
        "Dropisode, London, United Kingdom",
        "mailto:transparent-ai-businesses@proton.me",
        "18 or over",
        "impersonates",
        "minors",
        "AI-generated",
        "does not expire",
      ],
    ],
    ["/aup", ["Draft: to be reviewed before launch", "Harassment", "Impersonation"]],
    ["/privacy", ["Draft: to be reviewed before launch", "Stripe", "fal.ai", "transparent-ai-businesses@proton.me", "1 year"]],
    ["/demo", ["placeholder clips", "The script", "The cast", "The storyboard", "The cost log", "/demo/exports/episode.mp4"]],
  ];
  for (const [path, needles] of pages) {
    it(`GET ${path}`, async () => {
      const { res, body } = await html(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(body.startsWith("<!doctype html>")).toBe(true);
      for (const n of needles) expect(body, `${path} should contain ${n}`).toContain(n);
      // House style: no em dashes anywhere.
      expect(body).not.toContain("\u2014");
    });
  }

  it("shows the signed-in header links", async () => {
    const cookie = await t.signIn("site-header@reel.test");
    const { body } = await html("/", cookie);
    expect(body).toContain('href="/billing"');
    expect(body).toContain('href="/account"');
    expect(body).toContain('href="/studio/"');
  });

  it("robots.txt and sitemap.xml", async () => {
    const robots = await html("/robots.txt");
    expect(robots.res.status).toBe(200);
    expect(robots.body).toContain("Sitemap: http://localhost:3299/sitemap.xml");
    const sm = await html("/sitemap.xml");
    expect(sm.res.status).toBe(200);
    expect(sm.res.headers.get("content-type")).toContain("xml");
    for (const p of PUBLIC_PATHS) expect(sm.body).toContain(`<loc>http://localhost:3299${p}</loc>`);
  });
});

describe("pricing calculator", () => {
  it("shows episodeCost() for the default models, from the shared module", async () => {
    const { catalog, platform } = t.deps;
    const d = catalog.config.defaults;
    const { body } = await html("/pricing");
    const expected = episodeCost(catalog, platform, {
      ...EXAMPLE_PLAN,
      image: d.final.image,
      finalVideo: d.final.video,
      draftVideo: d.draft.video,
    });
    const finalOnly = episodeCost(catalog, platform, {
      ...EXAMPLE_PLAN,
      draftsPerShot: 0,
      image: d.final.image,
      finalVideo: d.final.video,
    });
    const row = calcRow(body, d.final.video);
    expect(row).toContain(`data-draft-then-final="${expected.chargeMicro}"`);
    expect(row).toContain(`data-final-only="${finalOnly.chargeMicro}"`);
    expect(row).toContain(formatUsd(expected.chargeMicro));
    expect(row).toContain(formatUsd(expected.providerMicro));
    expect(row).toContain(formatUsd(finalOnly.chargeMicro));
    expect(expected.chargeMicro).toBeGreaterThan(expected.providerMicro);
    // Every final-tier video model has a row.
    for (const m of catalog.list("video", "final")) expect(body).toContain(`data-model="${m.id}"`);
    // Every listed model has a unit price row with its source.
    for (const m of catalog.list("video")) {
      expect(body).toContain(`data-unit-model="${m.id}"`);
      expect(body).toContain(m.price.source);
    }
  });

  it("shows billed seconds when a model rounds up (Veo makes 4, 6 or 8 s)", async () => {
    const { body } = await html("/pricing");
    const veo = calcRow(body, "veo-3.1-fast");
    expect(veo).toContain("6 s");
    expect(veo).toContain("rounds up from 5 s");
  });

  it("recomputes from the form's query string", async () => {
    const { catalog, platform } = t.deps;
    const d = catalog.config.defaults;
    const { res, body } = await html("/pricing?shots=12&seconds=8&drafts=1&final=wan-3-1080p&audio=off");
    expect(res.status).toBe(200);
    const plan = { shots: 12, shotSeconds: 8, draftsPerShot: 1, finalsPerShot: 1, audio: false };
    const want = episodeCost(catalog, platform, { ...plan, image: d.final.image, finalVideo: "wan-3-1080p", draftVideo: d.draft.video });
    const row = calcRow(body, "wan-3-1080p");
    expect(row).toContain('class="hl"');
    expect(row).toContain(`data-draft-then-final="${want.chargeMicro}"`);
    expect(body).toContain("Wan 3.0");
  });

  it("clamps bad input instead of failing", async () => {
    const { res, body } = await html("/pricing?shots=-4&seconds=abc&drafts=999&final=../../etc");
    expect(res.status).toBe(200);
    expect(body).toContain(`data-model="${t.deps.catalog.config.defaults.final.video}"`);
  });
});

describe("finances", () => {
  it("/finances.json reflects a funded workspace's settled job", async () => {
    const before = (await (await t.request("GET", "/finances.json")).json()) as FinancesSummary;
    const cookie = await t.signIn("site-finances@reel.test");
    const ws = await t.workspaceOf(cookie);
    await t.fund(ws, 20);
    const created = await t.request("POST", "/api/projects", { cookie, body: { name: "Finances test" } });
    expect(created.status).toBe(201);
    const pid = ((await created.json()) as { id: string }).id;
    const withCast = await t.request("POST", `/api/projects/${pid}/cast`, {
      cookie,
      body: { kind: "character", name: "Ada", description: "a lighthouse keeper" },
    });
    expect(withCast.status).toBe(201);
    const view = (await withCast.json()) as { project: { cast: { id: string }[] } };
    const cid = view.project.cast[0]!.id;
    const gen = await t.request("POST", `/api/projects/${pid}/cast/${cid}/generate`, { cookie });
    expect(gen.status).toBe(202);
    for (let i = 0; i < 20 && (await tickJobs(t.deps)) > 0; i++);

    const res = await t.request("GET", "/finances.json");
    expect(res.status).toBe(200);
    const f = (await res.json()) as FinancesSummary;
    const model = t.deps.catalog.config.defaults.castImage;
    const cost = Math.round(t.deps.catalog.get(model).price.usd! * 1_000_000);
    const charge = generationCharge(cost, t.deps.platform);
    // This workspace's own settlement: exactly one cast image, charged at cost x (1 + markup).
    const mine = await t.deps.db.selectFrom("settlements").selectAll().where("workspaceId", "=", ws).execute();
    expect(mine.map((s) => [s.model, Number(s.providerCostMicro), Number(s.chargedMicro), s.providerBilled])).toEqual([
      [model, cost, charge, true],
    ]);
    // The public summary includes it. (Compared as "at least": the test database may be shared with other runs.)
    const row = f.generation.find((g) => g.model === model);
    expect(row).toBeDefined();
    const prev = before.generation.find((g) => g.model === model);
    expect(row!.jobs - (prev?.jobs ?? 0)).toBeGreaterThanOrEqual(1);
    expect(row!.providerCostMicro - (prev?.providerCostMicro ?? 0)).toBeGreaterThanOrEqual(cost);
    expect(row!.chargedMicro - (prev?.chargedMicro ?? 0)).toBeGreaterThanOrEqual(charge);
    expect(f.activeWorkspaces).toBeGreaterThanOrEqual(1);
    expect(f.fixed.items.length).toBe(t.deps.fixedCosts.items.length);

    const page = await html("/finances");
    expect(page.body).toContain(model);
    expect(page.body).toContain(formatUsd(row!.chargedMicro));
  });

  it("is hidden when FINANCES_PUBLIC is off", async () => {
    const off = await testApp({ env: { FINANCES_PUBLIC: "false" } });
    try {
      expect((await off.request("GET", "/finances")).status).toBe(404);
      expect((await off.request("GET", "/finances.json")).status).toBe(404);
    } finally {
      await off.close();
    }
  });
});

describe("demo", () => {
  it("lists the demo project's real total and serves its media with path checks", async () => {
    const demo = loadDemo();
    expect(demo).not.toBeNull();
    const total = demo!.project.costLog.reduce((a, l) => a + generationCharge(l.providerCostMicro, t.deps.platform), 0);
    const { body } = await html("/demo");
    expect(body).toContain(`data-k="demo-total">${formatUsd(total)}`);
    for (const m of demo!.project.cast) expect(body).toContain(m.name);

    const img = demo!.project.media.find((m) => m.contentType === "image/png")!;
    const r = await t.request("GET", `/demo/${img.path}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");

    const ep = await t.request("GET", "/demo/exports/episode.mp4", { headers: { range: "bytes=0-99" } });
    expect(ep.status).toBe(206);
    expect(ep.headers.get("content-range")).toMatch(/^bytes 0-99\/\d+$/);
    expect((await ep.arrayBuffer()).byteLength).toBe(100);

    for (const bad of [
      "/demo/media/..%2Fproject.json",
      "/demo/media/project.json",
      "/demo/media/nope.png",
      "/demo/exports/..%2Fdemo.json",
      "/demo/exports/shots",
    ]) {
      expect((await t.request("GET", bad)).status, bad).toBe(404);
    }
  });

  it("keeps the demo folder small", () => {
    const size = (dir: string): number =>
      readdirSync(dir).reduce((a, f) => a + (statSync(join(dir, f)).isDirectory() ? size(join(dir, f)) : statSync(join(dir, f)).size), 0);
    const dir = loadDemo()!.dir;
    expect(size(dir)).toBeLessThan(15 * 1024 * 1024);
    expect(JSON.parse(readFileSync(join(dir, "demo.json"), "utf8")).placeholder).toBe(true);
  });
});
