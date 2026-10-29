/**
 * Moderation rules: config/moderation.json (thresholds, never in code) and
 * config/public-figures.json (names refused in any text sent for generation).
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { ClassifyResult } from "./classifier";

const Rule = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  applies: z.enum(["text", "image", "any"]),
  when: z.enum(["always", "request_has_image"]).default("always"),
  orFlagged: z.boolean().default(true),
  threshold: z.number().min(0).max(1),
});
export type Rule = z.infer<typeof Rule>;

const ModerationFile = z.object({
  model: z.string().default("omni-moderation-latest"),
  endpoint: z.url().default("https://api.openai.com/v1/moderations"),
  timeoutMs: z.number().int().positive().default(15_000),
  maxTextChars: z.number().int().min(500).default(10_000),
  images: z.object({
    acceptedTypes: z.array(z.string()).default(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    resizeAboveBytes: z.number().int().positive(),
    resizeMaxSide: z.number().int().min(256),
    maxBytes: z.number().int().positive(),
  }),
  outputFrames: z.number().int().min(1).max(10).default(3),
  rules: z.array(Rule).min(1),
});
export type ModerationRules = z.infer<typeof ModerationFile>;

/** Finds a file in apps/hosted/config from src/moderation (tsx) or dist (bundled). */
function configPath(name: string): URL {
  const candidates = [new URL(`../../config/${name}`, import.meta.url), new URL(`../config/${name}`, import.meta.url)];
  return candidates.find((u) => existsSync(u)) ?? candidates[0]!;
}

export function loadRules(path: URL | string = configPath("moderation.json")): ModerationRules {
  return ModerationFile.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function loadPublicFigures(path: URL | string = configPath("public-figures.json")): string[] {
  const file = z.object({ names: z.array(z.string().min(2)) }).parse(JSON.parse(readFileSync(path, "utf8")));
  return file.names;
}

/** Lower case, accents removed, punctuation and symbols turned into single spaces. */
export function normalise(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface NameMatcher {
  /** The listed names found in the text (as listed). */
  find(text: string): string[];
}

/**
 * Matches whole words ("taylor swift" in "Taylor-Swift's"), and runs of whole
 * words that spell the name with the spaces moved or removed ("T.a.y.l.o.r
 * S.w.i.f.t", "Mr Beast", "taylorswift"). Never matches inside a word.
 */
export function nameMatcher(names: string[]): NameMatcher {
  const bySquashed = new Map<string, string>();
  for (const n of names) bySquashed.set(normalise(n).replace(/ /g, ""), n);
  const maxLen = Math.max(0, ...[...bySquashed.keys()].map((k) => k.length));
  return {
    find(text) {
      const tokens = normalise(text).split(" ").filter(Boolean);
      const found = new Set<string>();
      for (let i = 0; i < tokens.length; i++) {
        let joined = "";
        for (let j = i; j < tokens.length; j++) {
          joined += tokens[j];
          if (joined.length > maxLen) break;
          const hit = bySquashed.get(joined);
          if (hit) found.add(hit);
        }
      }
      return [...found];
    },
  };
}

export interface ClassifiedItem {
  kind: "text" | "image";
  result: ClassifyResult;
}

/** The rule ids that block, given the classifier's results for one request. */
export function evaluate(rules: Rule[], items: ClassifiedItem[], opts: { requestHasImage: boolean }): string[] {
  const hits = new Set<string>();
  for (const rule of rules) {
    if (rule.when === "request_has_image" && !opts.requestHasImage) continue;
    for (const item of items) {
      if (rule.applies !== "any" && rule.applies !== item.kind) continue;
      const flagged = rule.orFlagged && item.result.categories[rule.category] === true;
      const score = item.result.scores[rule.category] ?? 0;
      if (flagged || score >= rule.threshold) hits.add(rule.id);
    }
  }
  return [...hits];
}
