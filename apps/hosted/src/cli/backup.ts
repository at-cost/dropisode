/**
 * Database backups and the restore drill.
 *
 *   tsx src/cli/backup.ts dump <file>              pg_dump (custom format) of DATABASE_URL
 *   tsx src/cli/backup.ts verify <file> <scratch-db-url>
 *        restores into an empty scratch database and checks that it is a
 *        working copy: same tables, row counts, wallet balances and projects.
 *
 * Media lives in R2 (versioned bucket, see docs/HARDENING.md), so a database
 * backup plus the bucket is a full backup.
 */
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { loadConfig } from "../config";
import { createDb, type Db } from "../db";

export function dump(databaseUrl: string, file: string): void {
  execFileSync("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--file=${file}`, databaseUrl], { stdio: "inherit" });
}

export function restore(file: string, scratchUrl: string): void {
  execFileSync("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${scratchUrl}`, file], { stdio: "inherit" });
}

export interface Fingerprint {
  tables: Record<string, number>;
  balances: Record<string, string>;
  projects: Record<string, string>;
}

/** What must survive a restore: every table's row count, every wallet and every project document. */
export async function fingerprint(db: Db): Promise<Fingerprint> {
  const names = await sql<{ t: string }>`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`.execute(db);
  const tables: Record<string, number> = {};
  for (const { t } of names.rows)
    tables[t] = Number((await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(t)}`.execute(db)).rows[0]!.n);
  const bal = await sql<{
    w: string;
    s: string;
  }>`SELECT workspace_id AS w, sum(amount_micro)::text AS s FROM ledger GROUP BY 1 ORDER BY 1`.execute(db);
  const proj = await sql<{ id: string; h: string }>`SELECT id, md5(doc::text) AS h FROM projects ORDER BY 1`.execute(db);
  return {
    tables,
    balances: Object.fromEntries(bal.rows.map((r) => [r.w, r.s])),
    projects: Object.fromEntries(proj.rows.map((r) => [r.id, r.h])),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, file, scratch] = process.argv.slice(2);
  const config = loadConfig();
  if (cmd === "dump" && file) {
    dump(config.DATABASE_URL, file);
    console.log(`Backup written to ${file}`);
  } else if (cmd === "verify" && file && scratch) {
    restore(file, scratch);
    const a = createDb(config.DATABASE_URL, 2).db;
    const b = createDb(scratch, 2).db;
    const [fa, fb] = [await fingerprint(a), await fingerprint(b)];
    await Promise.all([a.destroy(), b.destroy()]);
    const same = JSON.stringify(fa) === JSON.stringify(fb);
    console.log(
      same
        ? "Restore drill passed: the copy matches."
        : "Restore drill FAILED: the copy differs (writes may have happened since the dump).",
    );
    process.exit(same ? 0 : 1);
  } else {
    console.log("Usage: backup.ts dump <file> | verify <file> <scratch-db-url>");
    process.exit(2);
  }
}
