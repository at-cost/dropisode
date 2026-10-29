export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/reel_test";

export const testEnv = (over: Record<string, string> = {}): Record<string, string> => ({
  NODE_ENV: "test",
  APP_URL: "http://localhost:3299",
  APP_SECRET: "test-secret-test-secret-test-secret-0123456789",
  DATABASE_URL: TEST_DATABASE_URL,
  PROVIDER: "mock",
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_DIR: `./.test-data/media-${process.pid}`,
  BILLING_ENABLED: "true",
  TEST_LOGIN: "true",
  ADMIN_EMAILS: "admin@reel.test",
  ...over,
});
