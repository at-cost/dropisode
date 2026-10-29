import { addEpisode, addScene, addShot, estimate } from "@reel/core";
import { dailyCharge, daysInMonth, episodeCost, generationCharge, monthlyFixed, usdToMicro } from "@reel/money";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { runDailyCharges } from "../src/billing/daily";
import { settleJob, walletState } from "../src/billing/wallet";
import { num } from "../src/db";
import { fixedMonthlyMicro } from "../src/finances";
import { workspaceStudio } from "../src/studio";
import { tickJobs } from "../src/worker";
import { type TestApp, testApp } from "./harness";

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

async function settleAll(app: TestApp) {
  for (let i = 0; i < 30; i++) {
    await tickJobs(app.deps);
    const open = await app.deps.db.selectFrom("jobs").select("id").where("unfinished", "=", true).execute();
    if (open.length === 0) return;
  }
  throw new Error("jobs did not settle");
}

async function setupProject(app: TestApp, cookie: string, shots = 1) {
  const p = (await (await app.request("POST", "/api/projects", { cookie, body: { name: "Test" } })).json()) as { id: string };
  const ws = await app.workspaceOf(cookie);
  const { stores } = workspaceStudio(app.deps, ws);
  const ids = await stores.mutate(p.id, (proj) => {
    const sc = addScene(addEpisode(proj, { title: "E1" }), { heading: "INT. ROOM" });
    return Array.from({ length: shots }, (_, i) => addShot(sc, { description: `Shot ${i + 1}`, durationS: 5 }).id);
  });
  return { projectId: p.id, workspaceId: ws, shotIds: ids };
}

const ledgerRows = (app: TestApp, ws: string) =>
  app.deps.db.selectFrom("ledger").selectAll().where("workspaceId", "=", ws).orderBy("id").execute();

describe("zero balance", () => {
  it("blocks new generations without touching projects, and a top-up unblocks them", async () => {
    t = await testApp();
    const cookie = await t.signIn("maya@reel.test");
    const { projectId, shotIds, workspaceId } = await setupProject(t, cookie);
    const before = await (await t.request("GET", `/api/projects/${projectId}`, { cookie })).json();

    const res = await t.request("POST", `/api/projects/${projectId}/shots/${shotIds[0]}/takes`, { cookie, body: { tier: "draft" } });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toMatch(/Top up/);
    expect(t.mock.submitted).toHaveLength(0);
    const after = (await (await t.request("GET", `/api/projects/${projectId}`, { cookie })).json()) as typeof before;
    expect((after as any).project.episodes).toEqual((before as any).project.episodes);
    expect(await t.deps.db.selectFrom("holds").selectAll().execute()).toEqual([]);

    // Top up through Checkout and the (fake) Stripe webhook.
    const top = await t.request("POST", "/api/billing/topup", { cookie, body: { amountUsd: 10 } });
    expect(top.status).toBe(200);
    expect(((await top.json()) as { url: string }).url).toMatch(/checkout/);
    const s = t.stripe.sessions[0]!;
    const hook = {
      sessionId: s.id,
      topupId: s.topupId,
      workspaceId: s.workspaceId,
      amountCents: 1000,
      paymentIntentId: "pi_1",
      paid: true,
    };
    expect(
      (await t.request("POST", "/webhooks/stripe", { body: JSON.stringify(hook), headers: { "stripe-signature": "fake-signature" } }))
        .status,
    ).toBe(200);
    // Replays credit once.
    await t.request("POST", "/webhooks/stripe", { body: JSON.stringify(hook), headers: { "stripe-signature": "fake-signature" } });
    expect((await walletState(t.deps.db, workspaceId)).balanceMicro).toBe(usdToMicro(10));
    expect(
      (await t.request("POST", "/webhooks/stripe", { body: JSON.stringify(hook), headers: { "stripe-signature": "forged" } })).status,
    ).toBe(400);

    const ok = await t.request("POST", `/api/projects/${projectId}/shots/${shotIds[0]}/takes`, { cookie, body: { tier: "draft" } });
    expect(ok.status).toBe(202);
  });

  it("refuses top-ups below the minimum", async () => {
    t = await testApp();
    const cookie = await t.signIn("a@reel.test");
    expect((await t.request("POST", "/api/billing/topup", { cookie, body: { amountUsd: 5 } })).status).toBe(400);
  });
});

describe("holds, settlement and refunds", () => {
  it("a success charges provider cost × 1.2 and releases the rest of the hold", async () => {
    t = await testApp();
    const cookie = await t.signIn("maya@reel.test");
    const { projectId, shotIds, workspaceId } = await setupProject(t, cookie);
    await t.fund(workspaceId, 20);
    await t.request("POST", `/api/projects/${projectId}/shots/${shotIds[0]}/takes`, { cookie, body: { tier: "draft" } });
    const mid = await walletState(t.deps.db, workspaceId);
    expect(mid.heldMicro).toBeGreaterThan(0);
    await settleAll(t);
    const end = await walletState(t.deps.db, workspaceId);
    expect(end.heldMicro).toBe(0);
    const d = t.deps.catalog.config.defaults.draft;
    const frame = estimate(t.deps.catalog.get(d.image), { images: 1 }).providerCostMicro;
    const clip = estimate(t.deps.catalog.get(d.video), { durationS: 5 }).providerCostMicro;
    expect(end.balanceMicro).toBe(usdToMicro(20) - generationCharge(frame, t.deps.platform) - generationCharge(clip, t.deps.platform));
    const view = (await (await t.request("GET", `/api/projects/${projectId}`, { cookie })).json()) as any;
    expect(view.costLog.map((l: any) => [l.purpose, l.status, l.paidMicro])).toEqual([
      ["frame", "charged", generationCharge(frame, t.deps.platform)],
      ["video", "charged", generationCharge(clip, t.deps.platform)],
    ]);
  });

  it("a forced provider failure releases the hold in full and shows a refund line", async () => {
    t = await testApp();
    const cookie = await t.signIn("maya@reel.test");
    const { projectId, shotIds, workspaceId } = await setupProject(t, cookie);
    await t.fund(workspaceId, 20);
    t.mock.failNext(1, "unbilled");
    await t.request("POST", `/api/projects/${projectId}/shots/${shotIds[0]}/takes`, { cookie, body: { tier: "draft" } });
    expect((await walletState(t.deps.db, workspaceId)).heldMicro).toBeGreaterThan(0);
    await settleAll(t);
    const w = await walletState(t.deps.db, workspaceId);
    expect(w).toEqual({ balanceMicro: usdToMicro(20), heldMicro: 0, availableMicro: usdToMicro(20) });
    expect((await ledgerRows(t, workspaceId)).filter((l) => l.kind === "generation")).toEqual([]);
    const view = (await (await t.request("GET", `/api/projects/${projectId}`, { cookie })).json()) as any;
    expect(view.costLog[0]).toMatchObject({ status: "refunded", paidMicro: 0 });
    expect(view.costLog[0].note).toMatch(/not billed/);
  });

  it("a failure the provider billed is charged and says so", async () => {
    t = await testApp();
    const cookie = await t.signIn("maya@reel.test");
    const { projectId, shotIds, workspaceId } = await setupProject(t, cookie);
    await t.fund(workspaceId, 20);
    t.mock.failNext(1, "billed");
    await t.request("POST", `/api/projects/${projectId}/shots/${shotIds[0]}/takes`, { cookie, body: { tier: "draft" } });
    await settleAll(t);
    const rows = (await ledgerRows(t, workspaceId)).filter((l) => l.kind === "generation");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.note).toMatch(/billed/);
  });

  it("settling the same outcome twice charges once; a corrected outcome charges only the difference", async () => {
    t = await testApp();
    const cookie = await t.signIn("maya@reel.test");
    const ws = await t.workspaceOf(cookie);
    const base = {
      workspaceId: ws,
      jobId: "job_x",
      provider: "fal",
      model: "m",
      succeeded: false,
      providerBilled: false,
      providerCostMicro: 0,
    };
    await t.deps.db.insertInto("holds").values({ jobId: "job_x", workspaceId: ws, amountMicro: 600_000 }).execute();
    await settleJob(t.deps.db, t.deps.platform, base);
    await settleJob(t.deps.db, t.deps.platform, base);
    expect((await ledgerRows(t, ws)).length).toBe(0);
    // The provider reports late that it ran it: charge it once.
    const later = { ...base, succeeded: true, providerBilled: true, providerCostMicro: 500_000 };
    await settleJob(t.deps.db, t.deps.platform, later);
    await settleJob(t.deps.db, t.deps.platform, later);
    const rows = await ledgerRows(t, ws);
    expect(rows.map((r) => num(r.amountMicro))).toEqual([-600_000]);
    expect((await walletState(t.deps.db, ws)).heldMicro).toBe(0);
  });

  it("caps a new account at $50 a day", async () => {
    t = await testApp();
    const cookie = await t.signIn("new@reel.test");
    const { projectId, shotIds, workspaceId } = await setupProject(t, cookie);
    await t.fund(workspaceId, 500);
    await t.deps.db
      .insertInto("ledger")
      .values({ workspaceId, kind: "generation", amountMicro: -usdToMicro(49.99), ref: "earlier-today", note: "" })
      .execute();
    const res = await t.request("POST", `/api/projects/${projectId}/shots/${shotIds[0]}/takes`, { cookie, body: { tier: "draft" } });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toMatch(/\$50 a day/);
  });
});

describe("a simulated month", () => {
  it("produces exactly the charges the calculator and the daily formula predict", async () => {
    t = await testApp();
    const cookie = await t.signIn("maya@reel.test");
    const shots = 3;
    const { projectId, shotIds, workspaceId } = await setupProject(t, cookie, shots);
    await t.fund(workspaceId, 100);
    // A second, idle workspace pays storage only.
    const idleCookie = await t.signIn("idle@reel.test");
    const idle = await t.workspaceOf(idleCookie);
    await t.fund(idle, 10);

    // Generations: one draft and one final per shot, default models, exactly the calculator's plan.
    for (const id of shotIds) await t.request("POST", `/api/projects/${projectId}/shots/${id}/takes`, { cookie, body: { tier: "draft" } });
    await settleAll(t);
    for (const id of shotIds) await t.request("PATCH", `/api/projects/${projectId}/shots/${id}`, { cookie, body: { approved: true } });
    for (const id of shotIds) await t.request("POST", `/api/projects/${projectId}/shots/${id}/takes`, { cookie, body: { tier: "final" } });
    await settleAll(t);

    const d = t.deps.catalog.config.defaults;
    const predicted = episodeCost(t.deps.catalog, t.deps.platform, {
      shots,
      shotSeconds: 5,
      draftsPerShot: 1,
      finalsPerShot: 1,
      draftVideo: d.draft.video,
      finalVideo: d.final.video,
      image: d.final.image,
      audio: true,
    });
    const gen = (await ledgerRows(t, workspaceId)).filter((l) => l.kind === "generation").reduce((a, l) => a - num(l.amountMicro), 0);
    expect(gen).toBe(predicted.chargeMicro);

    // Storage: give each workspace a known size, then run every day of the month.
    await t.deps.db.updateTable("media").set({ bytes: 0 }).execute();
    const someMedia = await t.deps.db
      .selectFrom("media")
      .select("id")
      .where("workspaceId", "=", workspaceId)
      .limit(1)
      .executeTakeFirstOrThrow();
    await t.deps.db
      .updateTable("media")
      .set({ bytes: 3 * 1024 ** 3 })
      .where("id", "=", someMedia.id)
      .execute();
    await t.deps.db
      .updateTable("workspaces")
      .set({ createdAt: new Date("2026-01-01") })
      .execute();
    await t.deps.db
      .updateTable("settlements")
      .set({ updatedAt: new Date("2026-11-10") })
      .execute();
    for (let day = 1; day <= 30; day++) await runDailyCharges(t.deps, `2026-11-${String(day).padStart(2, "0")}`);
    // Running a day twice charges once.
    await runDailyCharges(t.deps, "2026-11-15");

    const month = monthlyFixed({
      settings: t.deps.platform,
      fixedMonthlyMicro: fixedMonthlyMicro(t.deps.fixedCosts),
      activeWorkspaces: 1,
      storageGb: 3,
      active: true,
    });
    const perDay = dailyCharge(month, daysInMonth("2026-11-01")).totalMicro;
    const daily = (await ledgerRows(t, workspaceId)).filter((l) => l.kind === "daily");
    expect(daily).toHaveLength(30);
    expect(daily.reduce((a, l) => a - num(l.amountMicro), 0)).toBe(perDay * 30);
    // The idle workspace has no stored bytes and generated nothing: no daily charge at all.
    expect((await ledgerRows(t, idle)).filter((l) => l.kind === "daily")).toEqual([]);
    const sum = await t.deps.db
      .selectFrom("dailyCharges")
      .select(sql<string>`sum(total_micro)`.as("s"))
      .where("workspaceId", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(num(sum.s)).toBe(perDay * 30);
  });

  it("emails the owner at 7 days left and at zero, once each", async () => {
    t = await testApp();
    const cookie = await t.signIn("maya@reel.test");
    const ws = await t.workspaceOf(cookie);
    await t.deps.db
      .updateTable("workspaces")
      .set({ createdAt: new Date("2026-01-01") })
      .execute();
    const someProject = await setupProject(t, cookie);
    const { stores } = workspaceStudio(t.deps, ws);
    await stores.put(someProject.projectId, { bytes: new Uint8Array(10), contentType: "image/png", source: "upload" });
    await t.deps.db
      .updateTable("media")
      .set({ bytes: 100 * 1024 ** 3 })
      .where("workspaceId", "=", ws)
      .execute();
    await t.fund(ws, 0.5);
    for (let day = 1; day <= 12; day++) await runDailyCharges(t.deps, `2026-11-${String(day).padStart(2, "0")}`);
    const sent = t.deps.mailer.sent!.filter((m) => m.to === "maya@reel.test").map((m) => m.subject);
    expect(sent).toEqual(["Your Reel balance is low", "Your Reel balance has run out"]);
    // Storage keeps accruing below zero; nothing is deleted.
    expect((await walletState(t.deps.db, ws)).balanceMicro).toBeLessThan(0);
    expect(await stores.exists(someProject.projectId)).toBe(true);
  });
});

describe("hosted critic regressions", () => {
  it("doesn't charge storage for deleted projects", async () => {
    t = await testApp();
    const cookie = await t.signIn("maya@reel.test");
    const ws = await t.workspaceOf(cookie);
    await t.deps.db
      .updateTable("workspaces")
      .set({ createdAt: new Date("2026-01-01") })
      .execute();
    const { projectId } = await setupProject(t, cookie);
    const { stores } = workspaceStudio(t.deps, ws);
    await stores.put(projectId, { bytes: new Uint8Array(10), contentType: "image/png", source: "upload" });
    await t.deps.db
      .updateTable("media")
      .set({ bytes: 50 * 1024 ** 3 })
      .execute();
    await t.fund(ws, 10);
    await runDailyCharges(t.deps, "2026-11-01");
    expect((await ledgerRows(t, ws)).filter((l) => l.kind === "daily")).toHaveLength(1);
    await t.request("DELETE", `/api/projects/${projectId}`, { cookie });
    await runDailyCharges(t.deps, "2026-11-02");
    expect((await ledgerRows(t, ws)).filter((l) => l.kind === "daily")).toHaveLength(1);
  });

  it("a workspace that first generates late in the month pays the whole month's share", async () => {
    t = await testApp();
    const cookie = await t.signIn("maya@reel.test");
    const ws = await t.workspaceOf(cookie);
    await t.deps.db
      .updateTable("workspaces")
      .set({ createdAt: new Date("2026-01-01") })
      .execute();
    await t.fund(ws, 100);
    for (let d = 1; d <= 9; d++) await runDailyCharges(t.deps, `2026-11-0${d}`);
    expect((await ledgerRows(t, ws)).filter((l) => l.kind === "daily")).toEqual([]); // no storage, not active: nothing
    await t.deps.db
      .insertInto("settlements")
      .values({
        jobId: "j1",
        workspaceId: ws,
        chargedMicro: 1,
        providerCostMicro: 1,
        providerBilled: true,
        succeeded: true,
        provider: "fal",
        model: "m",
        updatedAt: new Date("2026-11-10"),
      })
      .execute();
    for (let d = 10; d <= 30; d++) await runDailyCharges(t.deps, `2026-11-${d}`);
    const month = monthlyFixed({
      settings: t.deps.platform,
      fixedMonthlyMicro: fixedMonthlyMicro(t.deps.fixedCosts),
      activeWorkspaces: 1,
      storageGb: 0,
      active: true,
    });
    const perDay = dailyCharge(month, 30).totalMicro;
    const total = (await ledgerRows(t, ws)).filter((l) => l.kind === "daily").reduce((a, l) => a - num(l.amountMicro), 0);
    expect(total).toBe(perDay * 30);
    const rows = await t.deps.db
      .selectFrom("dailyCharges")
      .select(sql<string>`sum(total_micro)`.as("s"))
      .where("workspaceId", "=", ws)
      .executeTakeFirstOrThrow();
    expect(num(rows.s)).toBe(perDay * 30);
  });

  it("catches up days missed while the worker was down", async () => {
    t = await testApp();
    const cookie = await t.signIn("maya@reel.test");
    const ws = await t.workspaceOf(cookie);
    await t.deps.db
      .updateTable("workspaces")
      .set({ createdAt: new Date("2026-01-01") })
      .execute();
    await runDailyCharges(t.deps, "2026-11-03");
    const { runDueDailyCharges } = await import("../src/billing/daily");
    const res = await runDueDailyCharges(t.deps, new Date("2026-11-08T05:00:00Z"));
    // Every uncharged day in the 62-day window, but not the day already charged.
    const ran = res.map((r) => r.day);
    expect(ran).toContain("2026-11-04");
    expect(ran).toContain("2026-11-07");
    expect(ran).not.toContain("2026-11-03");
    expect(ran).toHaveLength(61);
    const days = await t.deps.db.selectFrom("dailyCharges").select("day").where("workspaceId", "=", ws).orderBy("day").execute();
    expect(days).toHaveLength(62);
    expect(days.at(-1)!.day).toBe("2026-11-07");
    expect(await runDueDailyCharges(t.deps, new Date("2026-11-08T05:00:00Z"))).toEqual([]);
  });

  it("the new-account cap counts every workspace the account created", async () => {
    t = await testApp();
    const cookie = await t.signIn("new@reel.test");
    const first = await t.workspaceOf(cookie);
    await t.deps.db
      .insertInto("ledger")
      .values({ workspaceId: first, kind: "generation", amountMicro: -usdToMicro(49.99), ref: "earlier", note: "" })
      .execute();
    const created = (await (await t.request("POST", "/api/account/workspaces", { cookie, body: { name: "Second" } })).json()) as any;
    const second = created.workspaceId ?? created.id ?? created.workspace?.workspaceId;
    const sw = await t.request("POST", "/api/account/switch", { cookie, body: { workspaceId: second } });
    const both = `${cookie}; ${(sw.headers.get("set-cookie") ?? "").split(";")[0]}`;
    expect(await t.workspaceOf(both)).toBe(second);
    await t.fund(second, 500);
    const { projectId, shotIds } = await setupProject(t, both);
    const res = await t.request("POST", `/api/projects/${projectId}/shots/${shotIds[0]}/takes`, { cookie: both, body: { tier: "draft" } });
    expect(res.status).toBe(402);
  });

  it("a Stripe refund takes the credit back; a dispute also freezes the workspace", async () => {
    t = await testApp();
    const cookie = await t.signIn("maya@reel.test");
    const ws = await t.workspaceOf(cookie);
    await t.request("POST", "/api/billing/topup", { cookie, body: { amountUsd: 20 } });
    const s = t.stripe.sessions[0]!;
    const send = (body: unknown) =>
      t.request("POST", "/webhooks/stripe", { body: JSON.stringify(body), headers: { "stripe-signature": "fake-signature" } });
    await send({ sessionId: s.id, topupId: s.topupId, workspaceId: ws, amountCents: 2000, paymentIntentId: "pi_9", paid: true });
    expect((await walletState(t.deps.db, ws)).balanceMicro).toBe(usdToMicro(20));
    await send({ kind: "refund", ref: "ch_1:500", paymentIntentId: "pi_9", amountCents: 500 });
    await send({ kind: "refund", ref: "ch_1:500", paymentIntentId: "pi_9", amountCents: 500 });
    await send({ kind: "refund", ref: "ch_1:800", paymentIntentId: "pi_9", amountCents: 800 });
    expect((await walletState(t.deps.db, ws)).balanceMicro).toBe(usdToMicro(12));
    await send({ kind: "dispute", ref: "dp_1", paymentIntentId: "pi_9", amountCents: 1200 });
    expect((await walletState(t.deps.db, ws)).balanceMicro).toBe(0);
    const row = await t.deps.db.selectFrom("workspaces").select("frozenAt").where("id", "=", ws).executeTakeFirstOrThrow();
    expect(row.frozenAt).not.toBeNull();
  });
});

describe("hosted critic regressions, round 2", () => {
  it("refund and dispute events, in any order, never take back more than was paid; a won dispute restores it", async () => {
    t = await testApp();
    const cookie = await t.signIn("maya@reel.test");
    const ws = await t.workspaceOf(cookie);
    await t.request("POST", "/api/billing/topup", { cookie, body: { amountUsd: 20 } });
    const s = t.stripe.sessions[0]!;
    const send = (body: unknown) =>
      t.request("POST", "/webhooks/stripe", { body: JSON.stringify(body), headers: { "stripe-signature": "fake-signature" } });
    await send({ sessionId: s.id, topupId: s.topupId, workspaceId: ws, amountCents: 2000, paymentIntentId: "pi_r", paid: true });
    // Two partial-refund totals arriving at once.
    await Promise.all([
      send({ kind: "refund", ref: "ch:500", paymentIntentId: "pi_r", amountCents: 500 }),
      send({ kind: "refund", ref: "ch:1000", paymentIntentId: "pi_r", amountCents: 1000 }),
    ]);
    expect((await walletState(t.deps.db, ws)).balanceMicro).toBe(usdToMicro(10));
    // A full refund, then a dispute on the same payment: at most $20 in total comes back out.
    await send({ kind: "refund", ref: "ch:2000", paymentIntentId: "pi_r", amountCents: 2000 });
    await send({ kind: "dispute", ref: "dp_9", paymentIntentId: "pi_r", amountCents: 2000 });
    expect((await walletState(t.deps.db, ws)).balanceMicro).toBe(0);
    await send({ kind: "dispute_won", ref: "dp_9", paymentIntentId: "pi_r", amountCents: 2000 });
    expect((await walletState(t.deps.db, ws)).balanceMicro).toBe(0); // the dispute took nothing, so nothing comes back
  });

  it("many frame jobs finishing at once through separate runners don't deadlock", async () => {
    t = await testApp();
    const cookie = await t.signIn("maya@reel.test");
    const { projectId, shotIds, workspaceId } = await setupProject(t, cookie, 12);
    await t.fund(workspaceId, 50);
    for (const id of shotIds) await t.request("POST", `/api/projects/${projectId}/shots/${id}/takes`, { cookie, body: { tier: "draft" } });
    const frames = await t.deps.db.selectFrom("jobs").select("id").where("workspaceId", "=", workspaceId).execute();
    // Each finishes in its own runner at the same moment, as simultaneous webhooks would.
    await Promise.all(frames.map((f) => workspaceStudio(t.deps, workspaceId).studio.runner.check(f.id)));
    await settleAll(t);
    const takes = (
      (await (await t.request("GET", `/api/projects/${projectId}`, { cookie })).json()) as any
    ).project.episodes[0].scenes[0].shots.map((s: any) => s.takes[0].status);
    expect(takes.every((x: string) => x === "done")).toBe(true);
  });

  it("a balance email that fails to send is retried on the next run", async () => {
    t = await testApp();
    const cookie = await t.signIn("maya@reel.test");
    const ws = await t.workspaceOf(cookie);
    await t.deps.db
      .updateTable("workspaces")
      .set({ createdAt: new Date("2026-01-01") })
      .execute();
    const p = await setupProject(t, cookie);
    const { stores } = workspaceStudio(t.deps, ws);
    await stores.put(p.projectId, { bytes: new Uint8Array(10), contentType: "image/png", source: "upload" });
    await t.deps.db
      .updateTable("media")
      .set({ bytes: 100 * 1024 ** 3 })
      .where("workspaceId", "=", ws)
      .execute();
    const send = t.deps.mailer.send.bind(t.deps.mailer);
    let fail = true;
    t.deps.mailer.send = async (m) => {
      if (fail) throw new Error("SMTP down");
      return send(m);
    };
    await runDailyCharges(t.deps, "2026-11-01");
    expect(t.deps.mailer.sent!.length).toBe(0);
    fail = false;
    await runDailyCharges(t.deps, "2026-11-01"); // same day: already charged, email retried
    expect(t.deps.mailer.sent!.map((m) => m.subject)).toEqual(["Your Reel balance has run out"]);
  });
});
