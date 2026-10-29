import { describe, expect, it } from "vitest";
import { Catalog, billedDuration, estimate } from "../src/catalog";
import { testCatalog } from "./helpers";

describe("estimates", () => {
  const c = testCatalog();

  it("prices per second at the shortest allowed duration that covers the shot", () => {
    const m = c.get("vid-draft");
    expect(billedDuration(m, 3)).toBe(5);
    expect(billedDuration(m, 7)).toBe(10);
    expect(billedDuration(m, 40)).toBe(10);
    expect(estimate(m, { durationS: 5 })).toMatchObject({ units: 5, unit: "second", providerCostMicro: 250_000 });
  });

  it("uses the audio rate only for native-audio models", () => {
    expect(estimate(c.get("vid-final"), { durationS: 5, audio: true }).providerCostMicro).toBe(6 * 150_000);
    expect(estimate(c.get("vid-final"), { durationS: 5, audio: false }).providerCostMicro).toBe(6 * 100_000);
    expect(estimate(c.get("vid-draft"), { durationS: 5, audio: true }).providerCostMicro).toBe(250_000);
  });

  it("prices per clip by duration", () => {
    expect(estimate(c.get("vid-clip"), { durationS: 5 }).providerCostMicro).toBe(270_000);
    expect(estimate(c.get("vid-clip"), { durationS: 8 }).providerCostMicro).toBe(450_000);
  });

  it("prices images, characters and tokens", () => {
    expect(estimate(c.get("img-cheap"), { images: 3 }).providerCostMicro).toBe(117_000);
    expect(estimate(c.get("tts"), { chars: 250 }).providerCostMicro).toBe(25_000);
    expect(estimate(c.get("llm"), { inputTokens: 1000, outputTokens: 2000 }).providerCostMicro).toBe(300 + 5000);
  });

  it("rejects defaults that aren't in the catalog", () => {
    const cfg = structuredClone(c.config);
    cfg.defaults.tts = "nope";
    expect(() => new Catalog(cfg)).toThrow(/nope/);
  });

  it("ships a real prices.json where every price has a source and a date", () => {
    const real = Catalog.load();
    expect(real.models.size).toBeGreaterThan(3);
    for (const m of real.models.values()) {
      expect(m.price.source).toMatch(/^https:\/\//);
      expect(m.price.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const s of Object.values(real.config.services)) expect(s.source).toMatch(/^https:\/\//);
  });
});
