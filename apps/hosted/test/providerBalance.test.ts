import { ProviderRejected } from "@reel/core";
import { describe, expect, it } from "vitest";
import { BalanceMonitor } from "../src/billing/providerBalance";

const config = {
  PROVIDER: "fal" as const,
  FAL_BILLING_KEY: "k",
  FAL_LOW_BALANCE_USD: 20,
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_CHAT_ID: "c",
};

function rig(balances: number[]) {
  const sent: string[] = [];
  let clock = 1_000_000;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("telegram")) {
      sent.push(String((init?.body as URLSearchParams | undefined)?.get("text")));
      return new Response("{}");
    }
    return Response.json({ username: "x", credits: { current_balance: balances.shift() ?? 0, currency: "USD" } });
  }) as typeof fetch;
  const m = new BalanceMonitor(config, fetchFn, () => clock);
  return { m, sent, tick: (ms: number) => (clock += ms) };
}

describe("fal balance monitor", () => {
  it("alerts once when credit falls below the line, again when it is topped up", async () => {
    const { m, sent, tick } = rig([50, 15, 12, 60]);
    await m.check();
    await m.check();
    tick(60_000);
    await m.check();
    await m.check();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/credit is low \(\$15\.00/);
    expect(sent[1]).toMatch(/topped up \(\$60\.00\)/);
  });

  it("says generation is paused at zero, and repeats every six hours while it stays low", async () => {
    const { m, sent, tick } = rig([0, 0, 0]);
    await m.check();
    tick(60 * 60_000);
    await m.check();
    tick(6 * 3_600_000);
    await m.check();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/out of credit/);
  });

  it("refuses new work while empty, and lets it through once a re-check sees a top-up", async () => {
    const { m, tick } = rig([0, 0, 25]);
    await m.check();
    await expect(m.ensureFunded()).rejects.toBeInstanceOf(ProviderRejected);
    tick(31_000);
    await expect(m.ensureFunded()).rejects.toThrow(/Exhausted balance/);
    tick(31_000);
    await expect(m.ensureFunded()).resolves.toBeUndefined();
  });

  it("does nothing without a billing key", async () => {
    const m = new BalanceMonitor({ ...config, FAL_BILLING_KEY: "" });
    expect(await m.check()).toBeNull();
    await expect(m.ensureFunded()).resolves.toBeUndefined();
  });
});
