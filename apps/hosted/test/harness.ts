/**
 * Test harness: a real Postgres schema (truncated per test), local storage,
 * the mock provider, a fake Stripe and a fake moderation API.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@reel/core";
import { usdToMicro } from "@reel/money";
import { sql } from "kysely";
import { createApp, createDeps } from "../src/app";
import type { CheckoutCompleted, PaymentGateway } from "../src/billing/gateway";
import { creditTopup } from "../src/billing/wallet";
import { loadConfig } from "../src/config";
import type { Deps } from "../src/context";
import { createDb } from "../src/db";
import { uuid } from "../src/lib/ids";
import { testEnv } from "./env";

export class FakeStripe implements PaymentGateway {
  sessions: { id: string; topupId: string; workspaceId: string; amountCents: number }[] = [];
  async ensureCustomer(p: { existingId: string | null; workspaceId: string }) {
    return p.existingId ?? `cus_${p.workspaceId.slice(0, 8)}`;
  }
  async createTopupCheckout(p: { amountCents: number; workspaceId: string; topupId: string }) {
    const id = `cs_${this.sessions.length + 1}`;
    this.sessions.push({ id, topupId: p.topupId, workspaceId: p.workspaceId, amountCents: p.amountCents });
    return { id, url: `https://checkout.stripe.test/${id}` };
  }
  async fetchFee(_paymentIntentId?: string): Promise<number | null> {
    return 57;
  }
  async parseWebhook(raw: string, signature: string): Promise<CheckoutCompleted | null> {
    if (signature !== "fake-signature") throw new Error("bad signature");
    return JSON.parse(raw) as CheckoutCompleted;
  }
}

export interface TestApp {
  deps: Deps;
  mock: MockProvider;
  stripe: FakeStripe;
  request(method: string, path: string, opts?: { body?: unknown; cookie?: string; headers?: Record<string, string> }): Promise<Response>;
  /** Signs in (creating the user and their workspace); returns the session cookie. */
  signIn(email: string): Promise<string>;
  workspaceOf(cookie: string): Promise<string>;
  /** Credits a workspace directly, as a paid top-up would. */
  fund(workspaceId: string, usd: number): Promise<void>;
  close(): Promise<void>;
}

export async function testApp(over: { env?: Record<string, string>; deps?: Partial<Deps> } = {}): Promise<TestApp> {
  const config = loadConfig(testEnv({ STORAGE_LOCAL_DIR: mkdtempSync(join(tmpdir(), "reel-hosted-")), ...over.env }));
  const { db } = createDb(config.DATABASE_URL, 5);
  await sql
    .raw(
      `TRUNCATE ${["admin_log", "abuse_reports", "moderation_events", "email_log", "provider_invoices", "daily_charges", "topups", "settlements", "holds", "ledger", "exports", "jobs", "media", "projects", "invites", "workspace_members", "workspaces", "oauth_accounts", "login_tokens", "sessions", "users"].join(", ")} RESTART IDENTITY CASCADE`,
    )
    .execute(db);
  const mock = new MockProvider();
  const stripe = new FakeStripe();
  const deps = createDeps(config, db, { provider: () => mock, payments: stripe, ...over.deps });
  const app = createApp(deps);
  const request: TestApp["request"] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { origin: config.APP_URL, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers };
    let body: BodyInit | undefined;
    if (opts.body instanceof Uint8Array) body = opts.body as BodyInit;
    else if (typeof opts.body === "string") body = opts.body;
    else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    return app.fetch(
      new Request(`${config.APP_URL}${path}`, { method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual" }),
    );
  };
  return {
    deps,
    mock,
    stripe,
    request,
    async signIn(email) {
      const res = await request("POST", "/auth/test-login", { body: { email } });
      const set = res.headers.get("set-cookie") ?? "";
      return set.split(";")[0]!;
    },
    async workspaceOf(cookie) {
      const res = await request("GET", "/api/billing", { cookie });
      return ((await res.json()) as { workspace: { workspaceId: string } }).workspace.workspaceId;
    },
    async fund(workspaceId, usd) {
      await creditTopup(db, { workspaceId, topupId: uuid(), amountMicro: usdToMicro(usd), note: "test credit" });
    },
    async close() {
      await deps.locks.destroy();
      await db.destroy();
    },
  };
}
