import { sql } from "kysely";
import { createDb, migrateToLatest, migrator } from "../src/db";
import { TEST_DATABASE_URL } from "./env";

/** Fresh schema each run: drop everything, migrate up, down and up again. */
export default async function setup() {
  const { db } = createDb(TEST_DATABASE_URL, 2);
  try {
    await sql.raw("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;").execute(db);
    await migrateToLatest(db);
    const down = await migrator(db).migrateDown();
    if (down.error) throw down.error;
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }
}
