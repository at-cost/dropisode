import { addEpisode, addScene, addShot } from "@reel/core";
import { generationCharge } from "@reel/money";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { walletState } from "../src/billing/wallet";
import { num } from "../src/db";
import { workspaceStudio } from "../src/studio";
import { tickJobs } from "../src/worker";
import { type TestApp, testApp } from "./harness";

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

describe("job queue under load", () => {
  it("many shots submitted at once across workspaces all settle, with exact money and no stuck holds", async () => {
    t = await testApp();
    const WORKSPACES = 4;
    const SHOTS = 15;
    const users = await Promise.all(Array.from({ length: WORKSPACES }, (_, i) => t.signIn(`u${i}@reel.test`)));
    const setups = await Promise.all(
      users.map(async (cookie) => {
        const ws = await t.workspaceOf(cookie);
        await t.fund(ws, 50);
        const p = (await (await t.request("POST", "/api/projects", { cookie, body: { name: "Load" } })).json()) as { id: string };
        const { stores } = workspaceStudio(t.deps, ws);
        const shotIds = await stores.mutate(p.id, (proj) => {
          const sc = addScene(addEpisode(proj, { title: "E" }), { heading: "S" });
          return Array.from({ length: SHOTS }, (_, i) => addShot(sc, { description: `Shot ${i}`, durationS: 5 }).id);
        });
        return { cookie, ws, projectId: p.id, shotIds };
      }),
    );

    // Every shot in every workspace at once; every 7th provider request fails unbilled.
    let n = 0;
    const realSubmit = t.mock.submit.bind(t.mock);
    t.mock.submit = async (job, input) => {
      if (++n % 7 === 0) t.mock.failNext(1, "unbilled");
      return realSubmit(job, input);
    };
    const responses = await Promise.all(
      setups.flatMap((s) =>
        s.shotIds.map((id) =>
          t.request("POST", `/api/projects/${s.projectId}/shots/${id}/takes`, { cookie: s.cookie, body: { tier: "draft" } }),
        ),
      ),
    );
    expect(responses.map((r) => r.status).every((s) => s === 202)).toBe(true);

    // Several workers polling at the same time.
    for (let round = 0; round < 40; round++) {
      await Promise.all([tickJobs(t.deps), tickJobs(t.deps), tickJobs(t.deps)]);
      const open = await t.deps.db.selectFrom("jobs").select("id").where("unfinished", "=", true).execute();
      if (open.length === 0) break;
    }
    expect(await t.deps.db.selectFrom("jobs").select("id").where("unfinished", "=", true).execute()).toEqual([]);
    expect(await t.deps.db.selectFrom("holds").select("jobId").where("releasedAt", "is", null).execute()).toEqual([]);

    for (const s of setups) {
      const w = await walletState(t.deps.db, s.ws);
      const settled = await t.deps.db.selectFrom("settlements").selectAll().where("workspaceId", "=", s.ws).execute();
      const charged = settled.reduce((a, r) => a + num(r.chargedMicro), 0);
      expect(w.balanceMicro).toBe(50_000_000 - charged);
      // Each settlement equals its provider cost × 1.2, and unbilled failures cost nothing.
      for (const r of settled)
        expect(num(r.chargedMicro)).toBe(r.providerBilled ? generationCharge(num(r.providerCostMicro), t.deps.platform) : 0);
      // The project's cost log agrees with the wallet.
      const view = (await (await t.request("GET", `/api/projects/${s.projectId}`, { cookie: s.cookie })).json()) as any;
      expect(view.totals.paidMicro).toBe(charged);
      expect(view.costLog.every((l: any) => l.status !== "pending")).toBe(true);
    }
    // One settlement per job, no duplicates.
    const dup = await t.deps.db
      .selectFrom("ledger")
      .select([sql<string>`job_id`.as("j"), sql<string>`count(*)`.as("n")])
      .where("kind", "=", "generation")
      .groupBy("jobId")
      .having(sql`count(*)`, ">", 1)
      .execute();
    expect(dup).toEqual([]);
  });
});
