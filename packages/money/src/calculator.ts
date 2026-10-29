/**
 * The public pricing calculator. It uses the same estimate functions as the
 * generate buttons and the same charge function as billing, so the numbers on
 * the website are the numbers creators pay.
 */
import { type Catalog, type CatalogModel, estimate } from "@reel/core";
import { type PlatformSettings, generationCharge } from "./billing";

export interface EpisodePlan {
  shots: number;
  shotSeconds: number;
  /** Draft tries per shot before the final (0 = straight to final). */
  draftsPerShot: number;
  finalsPerShot: number;
  draftVideo?: string;
  finalVideo: string;
  image: string;
  /** Final takes with native audio, where the model has it. */
  audio: boolean;
}

export interface EpisodeCost {
  plan: EpisodePlan;
  /** What fal bills. */
  providerMicro: number;
  /** What the creator pays: provider cost × (1 + markup), per job, summed. */
  chargeMicro: number;
  lines: { label: string; count: number; providerMicro: number; chargeMicro: number }[];
}

/** One episode's generation cost, job by job (each job is charged and rounded on its own, as billing does). */
export function episodeCost(catalog: Catalog, settings: Pick<PlatformSettings, "markup">, plan: EpisodePlan): EpisodeCost {
  const lines: EpisodeCost["lines"] = [];
  const add = (label: string, count: number, unitMicro: number) => {
    if (count <= 0) return;
    lines.push({ label, count, providerMicro: unitMicro * count, chargeMicro: generationCharge(unitMicro, settings) * count });
  };
  const image = catalog.get(plan.image);
  const frame = estimate(image, { images: 1 }).providerCostMicro;
  if (plan.draftsPerShot > 0 && plan.draftVideo) {
    const draft = catalog.get(plan.draftVideo);
    const silent = !catalog.config.defaults.draftAudio;
    add(`Draft first frames (${image.label})`, plan.shots * plan.draftsPerShot, frame);
    add(
      `Draft clips (${draft.label})`,
      plan.shots * plan.draftsPerShot,
      estimate(draft, { durationS: plan.shotSeconds, audio: !silent && plan.audio }).providerCostMicro,
    );
  }
  const final = catalog.get(plan.finalVideo);
  add(`Final first frames (${image.label})`, plan.shots * plan.finalsPerShot, frame);
  add(
    `Final clips (${final.label}${plan.audio && final.nativeAudio ? ", with audio" : ""})`,
    plan.shots * plan.finalsPerShot,
    estimate(final, { durationS: plan.shotSeconds, audio: plan.audio }).providerCostMicro,
  );
  return {
    plan,
    providerMicro: lines.reduce((a, l) => a + l.providerMicro, 0),
    chargeMicro: lines.reduce((a, l) => a + l.chargeMicro, 0),
    lines,
  };
}

export const EXAMPLE_PLAN = { shots: 30, shotSeconds: 5, draftsPerShot: 3, finalsPerShot: 1, audio: true } as const;

export interface CalculatorRow {
  model: CatalogModel;
  /** Seconds actually rendered per shot (models round up to their allowed lengths). */
  billedSeconds: number;
  finalOnly: EpisodeCost;
  /** Three drafts on the default draft model, then one final. */
  draftThenFinal: EpisodeCost;
}

/** The calculator table: the example episode on every final-tier video model. */
export function calculatorTable(
  catalog: Catalog,
  settings: Pick<PlatformSettings, "markup">,
  plan: Omit<EpisodePlan, "finalVideo" | "image" | "draftVideo"> = EXAMPLE_PLAN,
): CalculatorRow[] {
  const d = catalog.config.defaults;
  return catalog.list("video", "final").map((model) => {
    const base = { ...plan, image: d.final.image, finalVideo: model.id };
    const billed = estimate(model, { durationS: plan.shotSeconds }).units;
    return {
      model,
      billedSeconds: model.price.unit === "second" ? billed : plan.shotSeconds,
      finalOnly: episodeCost(catalog, settings, { ...base, draftsPerShot: 0 }),
      draftThenFinal: episodeCost(catalog, settings, { ...base, draftVideo: d.draft.video }),
    };
  });
}
