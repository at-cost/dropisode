import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { dump, fingerprint, restore } from "../src/cli/backup";
import { createDb } from "../src/db";
import { tickJobs } from "../src/worker";
import { TEST_DATABASE_URL } from "./env";
import { type TestApp, testApp } from "./harness";

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

const hasTools = (() => {
  try {
    execFileSync("pg_dump", ["--version"]);
    execFileSync("pg_restore", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTools)("backup restore drill", () => {
  it("a dump restores into an empty database as an exact copy", async () => {
    t = await testApp();
    const cookie = await t.signIn("a@reel.test");
    const ws = await t.workspaceOf(cookie);
    await t.fund(ws, 20);
    const p = (await (await t.request("POST", "/api/projects", { cookie, body: { name: "Keep me" } })).json()) as { id: string };
    const v = (await (
      await t.request("POST", `/api/projects/${p.id}/cast`, { cookie, body: { kind: "character", name: "Maya" } })
    ).json()) as any;
    await t.request("POST", `/api/projects/${p.id}/cast/${v.project.cast[0].id}/generate`, { cookie });
    for (let i = 0; i < 10; i++) await tickJobs(t.deps);

    const file = join(mkdtempSync(join(tmpdir(), "reel-backup-")), "reel.dump");
    dump(TEST_DATABASE_URL, file);

    const scratchName = `reel_restore_${process.pid}`;
    const admin = createDb(TEST_DATABASE_URL, 1).db;
    await sql.raw(`DROP DATABASE IF EXISTS ${scratchName}`).execute(admin);
    await sql.raw(`CREATE DATABASE ${scratchName}`).execute(admin);
    const scratchUrl = TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${scratchName}`);
    try {
      restore(file, scratchUrl);
      const copy = createDb(scratchUrl, 1).db;
      const [a, b] = [await fingerprint(t.deps.db), await fingerprint(copy)];
      await copy.destroy();
      expect(b).toEqual(a);
      expect(a.tables.ledger).toBeGreaterThan(0);
      expect(Object.values(a.balances)).toHaveLength(1);
    } finally {
      await sql.raw(`DROP DATABASE IF EXISTS ${scratchName}`).execute(admin);
      await admin.destroy();
    }
  });
});
