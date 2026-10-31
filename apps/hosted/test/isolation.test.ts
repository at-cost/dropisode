import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore, MockProvider, type Provider, exportProject, importInto, readArchive } from "@reel/core";
import { afterEach, describe, expect, it } from "vitest";
import { walletState } from "../src/billing/wallet";
import { num } from "../src/db";
import { hmac } from "../src/lib/ids";
import { tickJobs } from "../src/worker";
import { type TestApp, testApp } from "./harness";

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

async function settle(app: TestApp) {
  for (let i = 0; i < 30; i++) {
    await tickJobs(app.deps);
    if ((await app.deps.db.selectFrom("jobs").select("id").where("unfinished", "=", true).execute()).length === 0) return;
  }
  throw new Error("jobs did not settle");
}

/** Workspace A with a project, a cast image (media), a finished job and an export. */
async function seedA(app: TestApp) {
  const a = await app.signIn("a@reel.test");
  const wsA = await app.workspaceOf(a);
  await app.fund(wsA, 20);
  const p = (await (await app.request("POST", "/api/projects", { cookie: a, body: { name: "A's secret drama" } })).json()) as {
    id: string;
  };
  let v = (await (
    await app.request("POST", `/api/projects/${p.id}/cast`, { cookie: a, body: { kind: "character", name: "Maya" } })
  ).json()) as any;
  const castId = v.project.cast[0].id;
  await app.request("POST", `/api/projects/${p.id}/cast/${castId}/generate`, { cookie: a });
  await settle(app);
  v = (await (await app.request("GET", `/api/projects/${p.id}`, { cookie: a })).json()) as any;
  const mediaId = v.project.media[0].id as string;
  const jobId = v.costLog[0].jobId as string;
  return { a, wsA, projectId: p.id, castId, mediaId, jobId };
}

describe("workspace isolation", () => {
  it("workspace B can't list, read, change or sign URLs for A's projects, media, jobs or cost logs", async () => {
    t = await testApp();
    const A = await seedA(t);
    const b = await t.signIn("b@reel.test");

    const list = (await (await t.request("GET", "/api/projects", { cookie: b })).json()) as unknown[];
    expect(list).toEqual([]);
    const paths: [string, string, unknown?][] = [
      ["GET", `/api/projects/${A.projectId}`],
      ["GET", `/api/projects/${A.projectId}/estimates`],
      ["GET", `/api/projects/${A.projectId}/export`],
      ["GET", `/api/projects/${A.projectId}/exports`],
      ["GET", `/api/projects/${A.projectId}/media/${A.mediaId}`],
      ["PATCH", `/api/projects/${A.projectId}`, { name: "pwned" }],
      ["DELETE", `/api/projects/${A.projectId}`],
      ["POST", `/api/projects/${A.projectId}/cast/${A.castId}/generate`],
      ["POST", `/api/projects/${A.projectId}/cast`, { kind: "character", name: "x" }],
    ];
    for (const [method, path, body] of paths) {
      const res = await t.request(method, path, { cookie: b, ...(body ? { body } : {}) });
      expect([403, 404], `${method} ${path} -> ${res.status}`).toContain(res.status);
    }
    // A's project is untouched and B's wallet never paid for anything.
    const still = (await (await t.request("GET", `/api/projects/${A.projectId}`, { cookie: A.a })).json()) as any;
    expect(still.project.name).toBe("A's secret drama");
    expect(still.project.cast).toHaveLength(1);
    const billingB = (await (await t.request("GET", "/api/billing", { cookie: b })).json()) as any;
    expect(billingB.ledger).toEqual([]);
    expect(billingB.balanceMicro).toBe(0);
  });

  it("the stores never return another workspace's rows, even given the right ids", async () => {
    t = await testApp();
    const A = await seedA(t);
    const b = await t.signIn("b@reel.test");
    const wsB = await t.workspaceOf(b);
    const { WorkspaceStores } = await import("../src/stores");
    const storesB = new WorkspaceStores(t.deps.db, t.deps.blobs, wsB);
    await expect(storesB.get(A.projectId)).rejects.toThrow(/not found/i);
    await expect(storesB.signedMediaUrl(A.projectId, A.mediaId, 60)).rejects.toThrow(/not found/i);
    await expect(storesB.mutate(A.projectId, () => {})).rejects.toThrow(/not found/i);
    expect(await storesB.getJob(A.jobId)).toBeUndefined();
    await expect(storesB.updateJob(A.jobId, { error: "x" })).rejects.toThrow();
    expect(await storesB.listUnfinished()).toEqual([]);
    await expect(storesB.put(A.projectId, { bytes: new Uint8Array(1), contentType: "image/png", source: "upload" })).rejects.toThrow(
      /not found/i,
    );
  });

  it("media URLs are signed, short-lived and can't be altered to reach another file", async () => {
    t = await testApp();
    const A = await seedA(t);
    const res = await t.request("GET", `/api/projects/${A.projectId}/media/${A.mediaId}`, { cookie: A.a });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect((await t.request("GET", `${url.pathname}${url.search}`)).status).toBe(200);
    const forged = new URL(url);
    forged.searchParams.set("key", url.searchParams.get("key")!.replace(/m_[^.]+/, "m_other"));
    expect((await t.request("GET", `${forged.pathname}${forged.search}`)).status).toBe(403);
    const expired = new URL(url);
    expired.searchParams.set("exp", String(Math.floor(Date.now() / 1000) - 10));
    expect((await t.request("GET", `${expired.pathname}${expired.search}`)).status).toBe(403);
  });

  it("signed out, nothing in the studio API answers", async () => {
    t = await testApp();
    const A = await seedA(t);
    expect((await t.request("GET", "/api/projects")).status).toBe(401);
    expect((await t.request("GET", `/api/projects/${A.projectId}`)).status).toBe(401);
  });

  it("refuses cross-site writes", async () => {
    t = await testApp();
    const a = await t.signIn("a@reel.test");
    const res = await t.request("POST", "/api/projects", { cookie: a, body: { name: "x" }, headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("fal webhooks must carry the signature we issued for that job", async () => {
    t = await testApp();
    const A = await seedA(t);
    expect((await t.request("POST", `/webhooks/fal?job=${A.jobId}&sig=nope`, { body: {} })).status).toBe(403);
    const sig = hmac(t.deps.config.APP_SECRET, `fal:${A.jobId}`);
    expect((await t.request("POST", `/webhooks/fal?job=${A.jobId}&sig=${sig}`, { body: {} })).status).toBe(200);
  });
});

describe("crash safety", () => {
  it("killing the worker mid-settlement never loses a charge or double-charges", async () => {
    const mock = new MockProvider();
    let crashes = 1;
    const crashing: Provider = {
      id: "mock",
      submit: (j, i) => mock.submit(j, i),
      check: (j) => mock.check(j),
      download: (u) => mock.download(u),
      async finalize() {
        if (crashes-- > 0) throw new Error("worker killed");
      },
    };
    t = await testApp({ deps: { provider: () => crashing } });
    const a = await t.signIn("a@reel.test");
    const ws = await t.workspaceOf(a);
    await t.fund(ws, 20);
    const p = (await (await t.request("POST", "/api/projects", { cookie: a, body: { name: "x" } })).json()) as { id: string };
    const v = (await (
      await t.request("POST", `/api/projects/${p.id}/cast`, { cookie: a, body: { kind: "character", name: "Maya" } })
    ).json()) as any;
    await t.request("POST", `/api/projects/${p.id}/cast/${v.project.cast[0].id}/generate`, { cookie: a });
    const held = (await walletState(t.deps.db, ws)).heldMicro;
    expect(held).toBeGreaterThan(0);

    await tickJobs(t.deps); // dies inside settlement
    const mid = await walletState(t.deps.db, ws);
    expect(mid.heldMicro).toBe(held); // the money is still held, not lost
    expect(mid.balanceMicro).toBe(20_000_000);

    await settle(t); // a fresh worker picks it up
    const end = await walletState(t.deps.db, ws);
    expect(end.heldMicro).toBe(0);
    const gen = await t.deps.db.selectFrom("ledger").selectAll().where("workspaceId", "=", ws).where("kind", "=", "generation").execute();
    expect(gen).toHaveLength(1);
    expect(end.balanceMicro).toBe(20_000_000 + num(gen[0]!.amountMicro));
    // Running the worker again changes nothing.
    await tickJobs(t.deps);
    expect(await walletState(t.deps.db, ws)).toEqual(end);
  });

  it("a crash with a failed job still releases the hold exactly once", async () => {
    t = await testApp();
    const a = await t.signIn("a@reel.test");
    const ws = await t.workspaceOf(a);
    await t.fund(ws, 20);
    const p = (await (await t.request("POST", "/api/projects", { cookie: a, body: { name: "x" } })).json()) as { id: string };
    const v = (await (
      await t.request("POST", `/api/projects/${p.id}/cast`, { cookie: a, body: { kind: "character", name: "Maya" } })
    ).json()) as any;
    t.mock.failNext(1, "unbilled");
    await t.request("POST", `/api/projects/${p.id}/cast/${v.project.cast[0].id}/generate`, { cookie: a });
    await settle(t);
    await settle(t);
    expect(await walletState(t.deps.db, ws)).toEqual({ balanceMicro: 20_000_000, heldMicro: 0, availableMicro: 20_000_000 });
  });
});

describe("hosted ↔ local", () => {
  it("a project round-trips hosted → local → hosted with nothing lost", async () => {
    t = await testApp();
    const A = await seedA(t);
    const zip1 = new Uint8Array(await (await t.request("GET", `/api/projects/${A.projectId}/export`, { cookie: A.a })).arrayBuffer());

    const local = new FolderStore(mkdtempSync(join(tmpdir(), "reel-rt-")));
    const inLocal = await importInto(readArchive(zip1), local, (p) => local.create(p));
    const zip2 = await exportProject(await local.get(inLocal.id), local);

    const res = await t.request("POST", "/api/projects/import", { cookie: A.a, body: zip2 });
    expect(res.status).toBe(201);
    const back = (await res.json()) as any;
    const orig = (await (await t.request("GET", `/api/projects/${A.projectId}`, { cookie: A.a })).json()) as any;
    // Media ids are re-issued on import; map them back and nothing else differs.
    const idMap = new Map<string, string>(back.media.map((m: any, i: number) => [m.id, orig.project.media[i].id]));
    const unmapped = JSON.parse(JSON.stringify(back).replace(/m_[A-Za-z0-9_-]{8}/g, (id) => idMap.get(id) ?? id));
    const strip = (p: any) => ({ ...p, id: "", updatedAt: "", media: p.media.map((m: any) => ({ ...m, path: "", createdAt: "" })) });
    expect(strip(unmapped)).toEqual(strip(orig.project));
    // The media bytes made it too, and the cast image points at the new file.
    const newId = back.cast[0].refImageIds[0];
    expect(newId).not.toBe(A.mediaId);
    const m = await t.request("GET", `/api/projects/${back.id}/media/${newId}`, { cookie: A.a });
    expect(m.status).toBe(302);
  });
});

describe("jobs across runners", () => {
  it("two runners finishing the same job store its output once", async () => {
    t = await testApp();
    const a = await t.signIn("a@reel.test");
    const ws = await t.workspaceOf(a);
    await t.fund(ws, 20);
    const p = (await (await t.request("POST", "/api/projects", { cookie: a, body: { name: "x" } })).json()) as { id: string };
    const v = (await (
      await t.request("POST", `/api/projects/${p.id}/cast`, { cookie: a, body: { kind: "character", name: "Maya" } })
    ).json()) as any;
    await t.request("POST", `/api/projects/${p.id}/cast/${v.project.cast[0].id}/generate`, { cookie: a });
    const job = await t.deps.db.selectFrom("jobs").select("id").where("workspaceId", "=", ws).executeTakeFirstOrThrow();
    const { workspaceStudio } = await import("../src/studio");
    const r1 = workspaceStudio(t.deps, ws).studio.runner;
    const r2 = workspaceStudio(t.deps, ws).studio.runner;
    await Promise.all([r1.check(job.id), r2.check(job.id), r1.check(job.id)]);
    const media = await t.deps.db.selectFrom("media").select("id").where("workspaceId", "=", ws).execute();
    expect(media).toHaveLength(1);
    const ledger = await t.deps.db
      .selectFrom("ledger")
      .select("id")
      .where("workspaceId", "=", ws)
      .where("kind", "=", "generation")
      .execute();
    expect(ledger).toHaveLength(1);
  });
});

describe("dashboard", () => {
  it("shows a workspace its own recent activity, month spend and covers, and nothing of another's", async () => {
    t = await testApp();
    const a = await t.signIn("dash-a@reel.test");
    const b = await t.signIn("dash-b@reel.test");
    await t.fund(await t.workspaceOf(a), 20);
    const p = (await (await t.request("POST", "/api/projects", { cookie: a, body: { name: "Dash Project" } })).json()) as { id: string };
    const cast = (await (
      await t.request("POST", `/api/projects/${p.id}/cast`, { cookie: a, body: { kind: "character", name: "MAYA", description: "courier" } })
    ).json()) as { project: { cast: { id: string }[] } };
    await t.request("POST", `/api/projects/${p.id}/cast/${cast.project.cast[0]!.id}/generate`, { cookie: a });
    for (let i = 0; i < 20; i++) await tickJobs(t.deps);
    const dash = (await (await t.request("GET", "/api/dashboard", { cookie: a })).json()) as {
      recent: { label: string; paidMicro: number; projectName: string }[];
      month: { totalMicro: number; days: unknown[] };
      counts: { projects: number };
    };
    expect(dash.counts.projects).toBe(1);
    expect(dash.recent[0]).toMatchObject({ label: "Cast: MAYA", projectName: "Dash Project" });
    expect(dash.recent[0]!.paidMicro).toBeGreaterThan(0);
    expect(dash.month.totalMicro).toBe(dash.recent.reduce((s, r) => s + r.paidMicro, 0));
    const list = (await (await t.request("GET", "/api/projects", { cookie: a })).json()) as { coverMediaId: string | null }[];
    expect(list[0]!.coverMediaId).toBeTruthy();
    const other = (await (await t.request("GET", "/api/dashboard", { cookie: b })).json()) as { recent: unknown[]; counts: { projects: number } };
    expect(other.recent).toHaveLength(0);
    expect(other.counts.projects).toBe(0);
  });
});
