import { loadConfig } from "../config";
import { createDb, migrateToLatest } from "../db";

const config = loadConfig();
const { db } = createDb(config.DATABASE_URL, 2);
await migrateToLatest(db);
await db.destroy();
console.log("Migrations applied");
