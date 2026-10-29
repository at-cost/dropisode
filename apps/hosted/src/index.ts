import { serve } from "@hono/node-server";
import { createApp, createDeps } from "./app";
import { loadConfig } from "./config";
import { createDb, migrateToLatest } from "./db";
import { startWorker } from "./worker";

const config = loadConfig();
const { db } = createDb(config.DATABASE_URL, config.DB_POOL_SIZE);
if (config.MIGRATE_ON_BOOT) await migrateToLatest(db);
const deps = createDeps(config, db);
if (config.WORKER_MODE !== "off") startWorker(deps);
if (config.WORKER_MODE !== "only") {
  serve({ fetch: createApp(deps).fetch, port: config.PORT }, () => console.log(`Reel hosted on :${config.PORT}`));
}
