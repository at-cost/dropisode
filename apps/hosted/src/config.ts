import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3200),
  APP_URL: z.url().default("http://localhost:3200"),
  /** Random, 32+ characters. Signs webhook URLs, local media URLs and OAuth state. */
  APP_SECRET: z.string().min(32),
  DATABASE_URL: z.string().min(1),
  DB_POOL_SIZE: z.coerce.number().int().min(1).default(10),
  MIGRATE_ON_BOOT: bool.default(true),
  /** inline: the web process also runs the job worker. only: worker only. off: web only. */
  WORKER_MODE: z.enum(["inline", "only", "off"]).default("inline"),

  /** "fal" for real generations, "mock" for development and tests (placeholder media, no cost). */
  PROVIDER: z.enum(["fal", "mock"]).default("fal"),
  FAL_KEY: z.string().default(""),
  /** A fal key with the BILLING preset: real per-request costs from fal's billing events. */
  FAL_BILLING_KEY: z.string().default(""),
  /** Public base URL fal can reach for webhooks. Defaults to APP_URL. Must be HTTPS and public. */
  WEBHOOK_BASE_URL: z.string().default(""),

  STORAGE_DRIVER: z.enum(["local", "r2"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./data/media"),
  R2_ACCOUNT_ID: z.string().default(""),
  R2_BUCKET: z.string().default(""),
  R2_ACCESS_KEY_ID: z.string().default(""),
  R2_SECRET_ACCESS_KEY: z.string().default(""),
  /** Seconds a signed media URL stays valid. */
  MEDIA_URL_TTL: z.coerce.number().int().min(30).max(3600).default(300),

  SMTP_URL: z.string().default(""),
  EMAIL_FROM: z.string().default("Dropisode <no-reply@localhost>"),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GITHUB_CLIENT_ID: z.string().default(""),
  GITHUB_CLIENT_SECRET: z.string().default(""),

  /** Off: no top-ups are taken and generation is refused (nothing is free). */
  BILLING_ENABLED: bool.default(false),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),

  /** OpenAI key for omni-moderation (free). Required in production. */
  OPENAI_API_KEY: z.string().default(""),
  /** Comma-separated emails with access to /admin. */
  ADMIN_EMAILS: z.string().default(""),
  /** Test-only sign-in endpoint. Never in production. */
  TEST_LOGIN: bool.default(false),
  /** Show the public finances page. */
  FINANCES_PUBLIC: bool.default(true),
  /** The built studio UI. */
  WEB_DIST_DIR: z.string().default(""),
});

export type Config = z.infer<typeof schema> & {
  secureCookies: boolean;
  googleEnabled: boolean;
  githubEnabled: boolean;
  adminEmails: string[];
  webhookBase: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === "production") {
    if (c.TEST_LOGIN) throw new Error("TEST_LOGIN must be off in production");
    if (c.PROVIDER !== "fal" || !c.FAL_KEY) throw new Error("Production needs PROVIDER=fal and FAL_KEY");
    if (!c.OPENAI_API_KEY) throw new Error("Production needs OPENAI_API_KEY: moderation runs before every generation");
    if (c.STORAGE_DRIVER !== "r2") throw new Error("Production needs STORAGE_DRIVER=r2");
    if (c.BILLING_ENABLED && (!c.STRIPE_SECRET_KEY || !c.STRIPE_WEBHOOK_SECRET))
      throw new Error("BILLING_ENABLED needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET");
  }
  if (c.STORAGE_DRIVER === "r2" && (!c.R2_BUCKET || !c.R2_ACCOUNT_ID))
    throw new Error("STORAGE_DRIVER=r2 needs R2_ACCOUNT_ID and R2_BUCKET");
  return {
    ...c,
    secureCookies: c.APP_URL.startsWith("https://"),
    googleEnabled: Boolean(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET),
    githubEnabled: Boolean(c.GITHUB_CLIENT_ID && c.GITHUB_CLIENT_SECRET),
    adminEmails: c.ADMIN_EMAILS.split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    webhookBase: (c.WEBHOOK_BASE_URL || c.APP_URL).replace(/\/$/, ""),
  };
}
