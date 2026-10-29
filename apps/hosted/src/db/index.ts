import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import { Migrator } from "kysely/migration";
import pg from "pg";
import { migrations } from "../migrations";
import type { DB } from "./schema";

// DATE as plain YYYY-MM-DD; bigint as string (micro-USD sums can pass 2^53 only in theory, but be exact).
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => v);

export type Db = Kysely<DB>;

export function createDb(url: string, max = 10, opts: { connectionTimeoutMillis?: number } = {}): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url, max, options: "-c TimeZone=UTC", ...opts });
  pool.on("error", (err) => console.error("reel: idle postgres client error", err.message));
  return { db: new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin()] }), pool };
}

export function migrator(db: Db): Migrator {
  return new Migrator({ db, provider: { getMigrations: async () => migrations } });
}

export async function migrateToLatest(db: Db): Promise<void> {
  const { error } = await migrator(db).migrateToLatest();
  if (error) throw error;
}

/** bigint column value as a number (micro-USD stays far below 2^53). */
export const num = (v: string | number | bigint | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));
