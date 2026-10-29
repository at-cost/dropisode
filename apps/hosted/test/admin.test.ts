/** Admin tools: access, freeze/unfreeze, media review, reports, invoices; every action lands in admin_log. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClassifier } from "../src/moderation/classifier";
import { createModerationService } from "../src/moderation/service";
import { WorkspaceStores } from "../src/stores";
import { type TestApp, testApp } from "./harness";

let t: TestApp;
let fake: FakeClassifier;
let admin: string;
let maker: string;
let ws: string;

type Json = Record<string, any>;

const form = (fields: Record<string, string>) => ({
  body: new URLSearchParams(fields).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded" },
});
const postForm = (cookie: string, path: string, fields: Record<string, string> = {}) =>
  t.request("POST", path, { cookie, ...form(fields) });

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await t.request(method, `/api${path}`, { cookie: maker, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : {} };
}

async function castProject() {
  const p = await api("POST", "/projects", { name: "Admin test" });
  const pid = p.json.id as string;
  const c = await api("POST", `/projects/${pid}/cast`, { kind: "character", name: "Mia", description: "a baker" });
  return { pid, cid: c.json.project.cast[0].id as string };
}

const adminLog = () => t.deps.db.selectFrom("adminLog").selectAll().orderBy("id").execute();

beforeEach(async () => {
  fake = new FakeClassifier();
  t = await testApp({ deps: { moderation: createModerationService(() => t.deps, { classify: fake.classify }) } });
  admin = await t.signIn("admin@reel.test");
  maker = await t.signIn("maker@reel.test");
  ws = await t.workspaceOf(maker);
  await t.fund(ws, 20);
});

afterEach(async () => {
  await t.close();
});

describe("access", () => {
  it("non-admins get 403 on every page and action", async () => {
    for (const path of [
      "/admin",
      "/admin/workspaces",
      `/admin/workspaces/${ws}`,
      "/admin/moderation",
      "/admin/media",
      "/admin/reports",
      "/admin/invoices",
      "/admin/log",
    ]) {
      expect((await t.request("GET", path, { cookie: maker })).status, path).toBe(403);
    }
    expect((await postForm(maker, `/admin/workspaces/${ws}/freeze`, { reason: "x" })).status).toBe(403);
    expect(
      (await postForm(maker, "/admin/invoices", { provider: "fal", month: "2026-10", amount: "1", source: "https://fal.ai/x" })).status,
    ).toBe(403);
    const w = await t.deps.db.selectFrom("workspaces").select("frozenAt").where("id", "=", ws).executeTakeFirstOrThrow();
    expect(w.frozenAt).toBeNull();
    expect(await adminLog()).toHaveLength(0);
  });

  it("signed-out visitors are sent to sign in; admins see every page", async () => {
    const res = await t.request("GET", "/admin/workspaces");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/sign-in");
    for (const path of [
      "/admin",
      `/admin/workspaces?q=maker`,
      `/admin/workspaces/${ws}`,
      "/admin/moderation",
      "/admin/media",
      "/admin/reports",
      "/admin/invoices",
      "/admin/log",
    ]) {
      const r = await t.request("GET", path, { cookie: admin });
      expect(r.status, path).toBe(200);
    }
    const search = await (await t.request("GET", "/admin/workspaces?q=maker%40reel", { cookie: admin })).text();
    expect(search).toContain(`/admin/workspaces/${ws}`);
    expect(search).toContain("$20.00");
  });

  it("refuses cross-site admin posts", async () => {
    const res = await t.request("POST", `/admin/workspaces/${ws}/freeze`, {
      cookie: admin,
      ...form({ reason: "x" }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});

describe("freeze", () => {
  it("blocks new generations with 402, logs the action, and unfreeze restores", async () => {
    const { pid, cid } = await castProject();
    const res = await postForm(admin, `/admin/workspaces/${ws}/freeze`, { reason: "Chargeback investigation" });
    expect(res.status).toBe(303);
    const w = await t.deps.db.selectFrom("workspaces").selectAll().where("id", "=", ws).executeTakeFirstOrThrow();
    expect(w.frozenAt).not.toBeNull();
    expect(w.frozenReason).toBe("Chargeback investigation");

    const blocked = await api("POST", `/projects/${pid}/cast/${cid}/generate`);
    expect(blocked.status).toBe(402);
    expect(blocked.json.error).toContain("frozen");
    expect(t.mock.submitted).toHaveLength(0);
    expect((await api("GET", "/config")).json.wallet.blocked).toBe(true);

    let log = await adminLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      action: "workspace.freeze",
      target: `workspace:${ws}`,
      details: { reason: "Chargeback investigation" },
    });
    const adminId = (await t.deps.db.selectFrom("users").select("id").where("email", "=", "admin@reel.test").executeTakeFirstOrThrow()).id;
    expect(log[0]!.adminUserId).toBe(adminId);

    expect((await postForm(admin, `/admin/workspaces/${ws}/unfreeze`, { reason: "Resolved" })).status).toBe(303);
    expect((await api("POST", `/projects/${pid}/cast/${cid}/generate`)).status).toBe(202);
    expect(t.mock.submitted).toHaveLength(1);
    log = await adminLog();
    expect(log.map((l) => l.action)).toEqual(["workspace.freeze", "workspace.unfreeze"]);
  });

  it("needs a reason", async () => {
    expect((await postForm(admin, `/admin/workspaces/${ws}/freeze`, { reason: "" })).status).toBe(400);
    expect(await adminLog()).toHaveLength(0);
  });
});

describe("moderation review", () => {
  it("unhide and keep hidden on flagged media, clear flag on the workspace", async () => {
    const { pid, cid } = await castProject();
    const stores = new WorkspaceStores(t.deps.db, t.deps.blobs, ws);
    const ref = await stores.put(pid, { bytes: new TextEncoder().encode("bytes [nsfw]"), contentType: "image/png", source: "upload" });
    await stores.mutate(pid, (p) => {
      p.media.push(ref);
      p.cast.find((c) => c.id === cid)!.refImageIds.unshift(ref.id);
    });
    await t.deps.moderation.reviewOutputs(10);
    const media = await t.deps.db.selectFrom("media").selectAll().executeTakeFirstOrThrow();
    expect(media.hiddenAt).not.toBeNull();

    const page = await (await t.request("GET", "/admin/media", { cookie: admin })).text();
    expect(page).toContain(media.id);
    expect((await t.request("GET", `/admin/media/${media.id}/view`, { cookie: admin })).status).toBe(302);

    expect((await postForm(admin, `/admin/media/${media.id}/keep-hidden`)).status).toBe(303);
    expect(await (await t.request("GET", "/admin/media", { cookie: admin })).text()).not.toContain(`/admin/media/${media.id}/unhide`);

    expect((await postForm(admin, `/admin/media/${media.id}/unhide`, { reason: "False positive" })).status).toBe(303);
    const after = await t.deps.db.selectFrom("media").selectAll().where("id", "=", media.id).executeTakeFirstOrThrow();
    expect(after.hiddenAt).toBeNull();
    const p = await api("GET", `/projects/${pid}`);
    expect(p.json.project.media[0].hidden).toBeUndefined();
    expect((await api("GET", `/projects/${pid}/media/${media.id}`)).status).toBe(302);

    expect((await postForm(admin, `/admin/workspaces/${ws}/clear-flag`, { reason: "Reviewed" })).status).toBe(303);
    expect(
      (await t.deps.db.selectFrom("workspaces").select("flaggedAt").where("id", "=", ws).executeTakeFirstOrThrow()).flaggedAt,
    ).toBeNull();
    expect((await adminLog()).map((l) => l.action)).toEqual(["media.view", "media.keep_hidden", "media.unhide", "workspace.clear_flag"]);
  });
});

describe("reports and invoices", () => {
  it("changes a report's status", async () => {
    const id = "3f1c2b8e-1d2a-4c5b-9e7f-0a1b2c3d4e5f";
    await t.deps.db.insertInto("abuseReports").values({ id, url: "https://example.com/x", reason: "harassment", details: "bad" }).execute();
    expect(await (await t.request("GET", "/admin/reports", { cookie: admin })).text()).toContain("https://example.com/x");
    expect((await postForm(admin, `/admin/reports/${id}/status`, { status: "actioned", note: "Workspace frozen" })).status).toBe(303);
    expect((await t.deps.db.selectFrom("abuseReports").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status).toBe(
      "actioned",
    );
    expect((await adminLog())[0]).toMatchObject({
      action: "report.status",
      target: `report:${id}`,
      details: { from: "open", to: "actioned", note: "Workspace frozen" },
    });
    expect((await postForm(admin, `/admin/reports/${id}/status`, { status: "deleted" })).status).toBe(400);
  });

  it("enters a provider invoice and replaces it on a second save", async () => {
    expect(
      (
        await postForm(admin, "/admin/invoices", {
          provider: "fal",
          month: "2026-10",
          amount: "123.45",
          source: "https://fal.ai/dashboard/billing/inv_1",
        })
      ).status,
    ).toBe(303);
    expect(
      (
        await postForm(admin, "/admin/invoices", {
          provider: "fal",
          month: "2026-10",
          amount: "$1,200.50",
          source: "https://fal.ai/dashboard/billing/inv_2",
        })
      ).status,
    ).toBe(303);
    const rows = await t.deps.db.selectFrom("providerInvoices").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.amountMicro)).toBe(1_200_500_000);
    expect(rows[0]!.source).toBe("https://fal.ai/dashboard/billing/inv_2");
    expect(
      (await postForm(admin, "/admin/invoices", { provider: "fal", month: "2026-13", amount: "1", source: "https://fal.ai/x" })).status,
    ).toBe(400);
    const log = await adminLog();
    expect(log.map((l) => l.action)).toEqual(["invoice.save", "invoice.save"]);
    expect(log[1]!.details).toMatchObject({ amountMicro: 1_200_500_000, previousMicro: 123_450_000 });
    expect(await (await t.request("GET", "/admin/log", { cookie: admin })).text()).toContain("admin@reel.test");
  });
});
