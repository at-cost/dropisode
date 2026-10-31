/**
 * The whole customer journey in a real browser, against the real app with the
 * AI providers mocked (MockProvider) and Stripe faked: sign up, confirm the
 * email, top up with a preset button, make an episode from idea to export,
 * and check every charge.
 *
 * Run: pnpm e2e (builds the studio UI first). Needs Postgres like the unit tests.
 * On failure, a screenshot is saved to e2e/.artifacts/.
 */
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { type Browser, type Page, chromium, expect as pw } from "playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { CheckoutCompleted } from "../src/billing/gateway";
import { startWorker } from "../src/worker";
import { FakeStripe, type TestApp, testApp } from "../test/harness";

const ARTIFACTS = resolve(__dirname, ".artifacts");
const WEB = resolve(__dirname, "../../../packages/studio/dist/web");
const EMAIL = "e2e-buyer@reel.test";
const PASSWORD = "a long test password";

/** Stripe stand-in: its checkout page is served by the test server, pays at once, and sends the webhook. */
class CheckoutStripe extends FakeStripe {
  constructor(private readonly base: () => string) {
    super();
  }
  override async createTopupCheckout(p: { amountCents: number; workspaceId: string; topupId: string }) {
    const s = await super.createTopupCheckout(p);
    return { id: s.id, url: `${this.base()}/__fake-stripe/${s.id}` };
  }
}

let t: TestApp;
let stripe: CheckoutStripe;
let browser: Browser;
let page: Page;
let base = "";
let close: () => void;

beforeAll(async () => {
  // The app must know its own origin (cookies, same-origin checks), so pick the port first.
  const port = 3400 + Math.floor(Math.random() * 400);
  base = `http://localhost:${port}`;
  stripe = new CheckoutStripe(() => base);
  t = await testApp({ env: { APP_URL: base, WEB_DIST_DIR: WEB, TEST_LOGIN: "false", WORKER_MODE: "inline" }, deps: { payments: stripe } });
  const app = createApp(t.deps);
  const outer = new Hono();
  outer.get("/__fake-stripe/:id", async (c) => {
    const s = stripe.sessions.find((x) => x.id === c.req.param("id"));
    if (!s) return c.text("no such session", 404);
    const event: CheckoutCompleted = {
      sessionId: s.id,
      topupId: s.topupId,
      workspaceId: s.workspaceId,
      amountCents: s.amountCents,
      paymentIntentId: `pi_${s.id}`,
      paid: true,
    };
    const res = await app.fetch(
      new Request(`${base}/webhooks/stripe`, {
        method: "POST",
        headers: { "stripe-signature": "fake-signature" },
        body: JSON.stringify(event),
      }),
    );
    if (res.status !== 200) return c.text(`webhook failed: ${res.status}`, 500);
    return c.redirect("/billing?paid=1");
  });
  outer.all("*", (c) => app.fetch(c.req.raw));
  const server = serve({ fetch: outer.fetch, port });
  await new Promise((r) => server.once("listening", r));
  expect((server.address() as AddressInfo).port).toBe(port);
  // The job worker, as in production (src/index.ts starts it next to the web server).
  const stopWorker = startWorker(t.deps, { jobsEveryMs: 300 });
  close = () => {
    stopWorker();
    server.close();
  };
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on("dialog", (d) => {
    throw new Error(`Unexpected browser dialog: ${d.message()}`);
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  close?.();
  await t?.close();
});

/** Runs a step; on failure saves a screenshot named after it. */
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    mkdirSync(ARTIFACTS, { recursive: true });
    await page.screenshot({ path: join(ARTIFACTS, `${name.replace(/\W+/g, "-")}.png`), fullPage: true }).catch(() => {});
    throw new Error(`Step "${name}" failed: ${(err as Error).message}`);
  }
}

const lastMail = () => [...(t.deps.mailer.sent ?? [])].reverse().find((m) => m.to === EMAIL)!;
const balance = async () =>
  (await page.evaluate(() => fetch("/api/billing").then((r) => r.json()))) as { balanceMicro: number; heldMicro: number };

describe("full customer journey (mocked providers)", () => {
  it("sign up, confirm, top up, make an episode, and every charge is cost x 1.2", async () => {
    await step("sign up", async () => {
      await page.goto(`${base}/`);
      await page.getByRole("link", { name: "Sign up" }).first().click();
      await page.getByLabel("Email").fill(EMAIL);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Create account" }).click();
      await pw(page.getByText("Check your email")).toBeVisible();
    });

    await step("confirm email", async () => {
      const link = /https?:\/\/\S+\/auth\/verify\?\S+/.exec(lastMail().text)![0];
      await page.goto(link);
      await pw(page.getByRole("heading", { name: "Account verified" })).toBeVisible();
      await page.getByRole("link", { name: "Go now" }).click();
      await page.waitForURL(/\/studio\//);
      await pw(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
    });

    await step("sign out and back in with the password", async () => {
      await page.getByRole("button", { name: "Your account menu" }).click();
      await page.getByRole("menuitem", { name: "Sign out" }).click();
      await page.goto(`${base}/sign-in`);
      await page.getByLabel("Email").fill(EMAIL);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/studio\//);
    });

    await step("top up $10 with the preset button", async () => {
      await page.goto(`${base}/billing`);
      await page.getByRole("button", { name: "$10" }).click();
      await page.waitForURL(/\/billing\?paid=1/);
      await pw(page.locator(".grid .big").first()).toHaveText("$10.00");
      expect(stripe.sessions.at(-1)!.amountCents).toBe(1000);
    });

    await step("create a project", async () => {
      await page.goto(`${base}/studio/`);
      await page.getByLabel("Project name").fill("E2E Courier");
      await page.getByLabel(/The idea/).fill("A courier finds a letter addressed to herself, dated tomorrow.");
      await page.getByRole("button", { name: "Create project" }).click();
      await page.waitForURL(/#\/p\/[^/]+\/script/);
    });

    await step("write the script", async () => {
      await page.getByRole("button", { name: /Write script/ }).click();
      await pw(page.getByText(/Next: storyboard/)).toBeVisible({ timeout: 30_000 });
    });

    await step("cast portraits", async () => {
      await page.getByRole("link", { name: "Cast" }).click();
      const generate = page.getByRole("button", { name: /^Generate/ });
      await pw(generate.first()).toBeVisible();
      // Each button turns into "Generating" once pressed, so keep pressing the first one left.
      for (let i = 0; i < 20 && (await generate.count()) > 0; i++) await generate.first().click();
      await pw(page.getByText("No image yet")).toHaveCount(0, { timeout: 30_000 });
    });

    await step("storyboard", async () => {
      await page.getByRole("link", { name: "Storyboard" }).click();
      const board = page.getByRole("button", { name: /Storyboard this scene/ });
      await pw(board.first()).toBeEnabled({ timeout: 30_000 });
      await board.first().click();
      await pw(page.getByRole("button", { name: /^Draft/ }).first()).toBeVisible({ timeout: 30_000 });
    });

    await step("draft every shot and approve them", async () => {
      const all = page.getByRole("button", { name: /^Draft (all|\d+ untried)/ });
      if (await all.count()) await all.first().click();
      else
        for (let i = 0; i < 30 && (await page.getByRole("button", { name: /^Draft/ }).count()) > 0; i++)
          await page
            .getByRole("button", { name: /^Draft/ })
            .first()
            .click();
      const approve = page.getByRole("button", { name: "Approve shot" });
      await pw(approve.first()).toBeVisible({ timeout: 60_000 });
      await pw.poll(async () => (await balance()).heldMicro, { timeout: 60_000 }).toBe(0);
      for (let i = 0; i < 30 && (await approve.count()) > 0; i++) await approve.first().click();
      await pw(page.getByRole("button", { name: "Approve shot" })).toHaveCount(0);
    });

    await step("render finals", async () => {
      for (const b of await page.getByRole("button", { name: /^Final/ }).all()) if (await b.isEnabled()) await b.click();
      await pw.poll(async () => (await balance()).heldMicro, { timeout: 60_000 }).toBe(0);
    });

    await step("assemble the episode", async () => {
      await page.getByRole("link", { name: "Episode" }).click();
      const final = page.getByRole("button", { name: /Final episode|Make final episode/ });
      await pw(final.first()).toBeEnabled({ timeout: 30_000 });
      await final.first().click();
      await pw(page.locator("video").first()).toBeVisible({ timeout: 90_000 });
    });

    await step("every charge is provider cost x 1.2 and the balance adds up", async () => {
      const ws = (await page.evaluate(() => fetch("/api/billing").then((r) => r.json()))) as { workspace: { workspaceId: string } };
      const rows = await t.deps.db
        .selectFrom("ledger")
        .select(["kind", "amountMicro"])
        .where("workspaceId", "=", ws.workspace.workspaceId)
        .execute();
      const gens = rows.filter((r) => r.kind === "generation");
      expect(gens.length).toBeGreaterThan(5);
      const jobs = await t.deps.db.selectFrom("jobs").select("record").where("workspaceId", "=", ws.workspace.workspaceId).execute();
      const recs = jobs.map((j) => j.record as { providerBilled?: boolean; providerCostMicro?: number });
      const billed = recs.filter((r) => r.providerBilled).reduce((a, r) => a + (r.providerCostMicro ?? 0), 0);
      const charged = -gens.reduce((a, r) => a + Number(r.amountMicro), 0);
      expect(Math.abs(charged - Math.round(billed * 1.2))).toBeLessThanOrEqual(gens.length);
      const b = await balance();
      expect(b.heldMicro).toBe(0);
      expect(b.balanceMicro).toBe(10_000_000 - charged);
      await page.goto(`${base}/billing`);
      await pw(page.getByText("Generation").first()).toBeVisible();
    });
  });
});
