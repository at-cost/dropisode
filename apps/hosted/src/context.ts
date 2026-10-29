import type { Catalog } from "@reel/core";
import type { PlatformSettings } from "@reel/money";
import type { Context } from "hono";
import type { PaymentGateway } from "./billing/gateway";
import type { Config } from "./config";
import type { Db } from "./db";
import type { Mailer } from "./email";
import type { FixedCosts } from "./finances";
import type { Moderation } from "./moderation/types";
import type { BlobStore } from "./storage";
import type { ProviderFactory } from "./studio";

export interface Deps {
  config: Config;
  db: Db;
  /** A separate small pool used only to hold per-job advisory locks, so lock waiters never starve real work. */
  locks: Db;
  blobs: BlobStore;
  catalog: Catalog;
  platform: PlatformSettings;
  fixedCosts: FixedCosts;
  mailer: Mailer;
  moderation: Moderation;
  payments: PaymentGateway | null;
  /** Makes the raw provider (fal, or the mock in development and tests). */
  provider: ProviderFactory;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  sessionId: string;
  isAdmin: boolean;
}

export type AppEnv = { Variables: { deps: Deps; user: SessionUser | null } };
export type Ctx = Context<AppEnv>;
