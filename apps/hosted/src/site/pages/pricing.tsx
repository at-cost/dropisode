/** @jsxImportSource hono/jsx */
import { type CatalogModel, billedDuration } from "@reel/core";
import {
  EXAMPLE_PLAN,
  type EpisodeCost,
  calculatorTable,
  dailyCharge,
  episodeCost,
  generationCharge,
  monthlyFixed,
  usdToMicro,
} from "@reel/money";
import type { Ctx } from "../../context";
import { fixedMonthlyMicro } from "../../finances";
import { COMPARE } from "../compare";
import { Ext, StatusTag, TableWrap, int, page, usd, usdPrecise } from "../ui";

export interface CalcInput {
  shots: number;
  shotSeconds: number;
  draftsPerShot: number;
  finalVideo: string;
  audio: boolean;
}

const clampInt = (v: string | undefined, min: number, max: number, dflt: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/** The calculator form's query string, checked and clamped. Unknown models fall back to the default final model. */
export function readCalcInput(c: Ctx): CalcInput {
  const { catalog } = c.get("deps");
  const q = (k: string) => c.req.query(k);
  const finals = catalog.list("video", "final").map((m) => m.id);
  const want = q("final") ?? "";
  return {
    shots: clampInt(q("shots"), 1, 300, EXAMPLE_PLAN.shots),
    shotSeconds: clampInt(q("seconds"), 1, 30, EXAMPLE_PLAN.shotSeconds),
    draftsPerShot: clampInt(q("drafts"), 0, 10, EXAMPLE_PLAN.draftsPerShot),
    finalVideo: finals.includes(want) ? want : catalog.config.defaults.final.video,
    audio: q("audio") !== "off",
  };
}

function unitLabel(m: CatalogModel): string {
  switch (m.price.unit) {
    case "second":
      return "per second";
    case "video":
      return "per clip";
    case "image":
      return "per image";
    case "1k_chars":
      return "per 1,000 characters";
    case "tokens":
      return "per 1M tokens";
  }
}

/** Provider price and what you pay, per unit, as lines of text. */
function unitPrices(m: CatalogModel, markup: { markup: number }): { fal: string[]; you: string[] } {
  const pr = m.price;
  const fal: string[] = [];
  const you: string[] = [];
  const add = (label: string, usdAmount: number | undefined) => {
    if (usdAmount === undefined) return;
    const micro = usdToMicro(usdAmount);
    fal.push(`${label}${usdPrecise(micro)}`);
    you.push(`${label}${usdPrecise(generationCharge(micro, markup))}`);
  };
  if (pr.unit === "tokens") {
    add("input ", pr.inputUsdPer1M);
    add("output ", pr.outputUsdPer1M);
  } else if (pr.unit === "video" && pr.byDurationUsd) {
    for (const [s, v] of Object.entries(pr.byDurationUsd)) add(`${s} s: `, v);
    for (const [s, v] of Object.entries(pr.byDurationAudioUsd ?? {})) add(`${s} s with audio: `, v);
  } else {
    add("", pr.usd);
    if (pr.audioUsd !== undefined && pr.audioUsd !== pr.usd) add("with audio ", pr.audioUsd);
  }
  return { fal, you };
}

const kindLabel = { video: "Video", image: "Image", tts: "Text to speech", llm: "Script and storyboard" } as const;

function Breakdown(p: { cost: EpisodeCost }) {
  return (
    <TableWrap label="Cost breakdown">
      <table>
        <thead>
          <tr>
            <th>Jobs</th>
            <th class="num">Count</th>
            <th class="num">fal price</th>
            <th class="num">You pay</th>
          </tr>
        </thead>
        <tbody>
          {p.cost.lines.map((l) => (
            <tr>
              <td>{l.label}</td>
              <td class="num">{int(l.count)}</td>
              <td class="num">{usd(l.providerMicro)}</td>
              <td class="num">{usd(l.chargeMicro)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td />
            <td class="num">{usd(p.cost.providerMicro)}</td>
            <td class="num">{usd(p.cost.chargeMicro)}</td>
          </tr>
        </tfoot>
      </table>
    </TableWrap>
  );
}

export function pricingPage(c: Ctx) {
  const { catalog, platform, fixedCosts } = c.get("deps");
  const input = readCalcInput(c);
  const d = catalog.config.defaults;
  const plan = {
    shots: input.shots,
    shotSeconds: input.shotSeconds,
    draftsPerShot: input.draftsPerShot,
    finalsPerShot: 1,
    audio: input.audio,
  };
  const rows = calculatorTable(catalog, platform, plan);
  const draft = catalog.get(d.draft.video);
  const image = catalog.get(d.final.image);
  const draftBilled = billedDuration(draft, input.shotSeconds);
  const chosen = catalog.get(input.finalVideo);
  const chosenCost = episodeCost(catalog, platform, {
    ...plan,
    image: d.final.image,
    finalVideo: chosen.id,
    ...(plan.draftsPerShot > 0 ? { draftVideo: d.draft.video } : {}),
  });
  const markupPct = Math.round(platform.markup * 100);
  const isExample =
    input.shots === EXAMPLE_PLAN.shots &&
    input.shotSeconds === EXAMPLE_PLAN.shotSeconds &&
    input.draftsPerShot === EXAMPLE_PLAN.draftsPerShot &&
    input.audio;

  // The daily charge, worked through with today's settings.
  const fixedMonthly = fixedMonthlyMicro(fixedCosts);
  const capMicro = usdToMicro(platform.shareCapUsd);
  const exampleGb = 20;
  const exampleMonth = monthlyFixed({
    settings: platform,
    fixedMonthlyMicro: fixedMonthly,
    activeWorkspaces: 1,
    storageGb: exampleGb,
    active: true,
  });
  const exampleDay = dailyCharge(exampleMonth, 30);
  const idleMonth = monthlyFixed({
    settings: platform,
    fixedMonthlyMicro: fixedMonthly,
    activeWorkspaces: 1,
    storageGb: exampleGb,
    active: false,
  });
  const models = catalog.list().filter((m) => m.kind !== "llm" || m.price.inputUsdPer1M !== undefined);

  return page(c, {
    title: "Pricing",
    description: `Reel charges the provider's price plus ${markupPct}% per generation. See what an episode costs on every model, with sources for every price.`,
    body: (
      <>
        <h1>Pricing</h1>
        <p class="lede">
          Each generation costs what fal.ai bills for it, plus {markupPct}%. You see the exact price before you press generate. Credit is
          prepaid, from ${platform.minTopupUsd}, and never expires. There is no subscription and no free tier.
        </p>
        <div class="toc">
          <a href="#calculator">Calculator</a>
          <a href="#units">Every model's price</a>
          <a href="#refunds">Failures and refunds</a>
          <a href="#daily">The daily charge</a>
          <a href="#compare">Compared with subscriptions</a>
        </div>

        <h2 id="calculator">What an episode costs</h2>
        <p>
          {isExample ? "The example episode: " : "Your episode: "}
          {int(input.shots)} shots of {input.shotSeconds} seconds. Each shot gets a first frame on {image.label}, then a clip.{" "}
          {input.draftsPerShot > 0
            ? `Draft then final means ${input.draftsPerShot} draft${input.draftsPerShot === 1 ? "" : "s"} on ${draft.label} (silent, ${draftBilled} s billed) and 1 final per shot.`
            : "No drafts: every shot goes straight to final."}{" "}
          Finals {input.audio ? "include native audio where the model has it" : "are silent"}.
        </p>

        <form class="calc card" method="get" action="/pricing#calculator">
          <label>
            <span class="lbl">Shots</span>
            <input type="number" name="shots" min={1} max={300} value={String(input.shots)} />
          </label>
          <label>
            <span class="lbl">Seconds per shot</span>
            <input type="number" name="seconds" min={1} max={30} value={String(input.shotSeconds)} />
          </label>
          <label>
            <span class="lbl">Drafts per shot</span>
            <input type="number" name="drafts" min={0} max={10} value={String(input.draftsPerShot)} />
          </label>
          <label>
            <span class="lbl">Final model</span>
            <select name="final">
              {catalog.list("video", "final").map((m) => (
                <option value={m.id} selected={m.id === input.finalVideo}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span class="lbl">Audio on finals</span>
            <select name="audio">
              <option value="on" selected={input.audio}>
                Yes
              </option>
              <option value="off" selected={!input.audio}>
                No
              </option>
            </select>
          </label>
          <div>
            <button type="submit">Work it out</button>
          </div>
        </form>

        <TableWrap label="Episode cost on each final model">
          <table id="calc-table">
            <thead>
              <tr>
                <th>Final model</th>
                <th class="num">Billed per shot</th>
                <th class="num">Final only: fal</th>
                <th class="num">Final only: you pay</th>
                <th class="num">Draft then final: fal</th>
                <th class="num">Draft then final: you pay</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  class={r.model.id === input.finalVideo ? "hl" : ""}
                  data-model={r.model.id}
                  data-final-only={String(r.finalOnly.chargeMicro)}
                  data-draft-then-final={String(r.draftThenFinal.chargeMicro)}
                >
                  <td>
                    {r.model.label}
                    {input.audio && r.model.nativeAudio ? <span class="muted small"> (audio)</span> : null}
                  </td>
                  <td class="num">
                    {r.model.price.unit === "second" ? `${r.billedSeconds} s` : "1 clip"}
                    {r.model.price.unit === "second" && r.billedSeconds !== input.shotSeconds ? (
                      <div class="small warn-text">rounds up from {input.shotSeconds} s</div>
                    ) : null}
                  </td>
                  <td class="num">{usd(r.finalOnly.providerMicro)}</td>
                  <td class="num">
                    <strong>{usd(r.finalOnly.chargeMicro)}</strong>
                  </td>
                  <td class="num">{usd(r.draftThenFinal.providerMicro)}</td>
                  <td class="num">
                    <strong>{usd(r.draftThenFinal.chargeMicro)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <p class="small muted">
          Models render only certain clip lengths. A shot is billed at the shortest length that covers it: Veo makes 4, 6 or 8 second clips,
          so a 5 second shot is billed as 6 seconds.{" "}
          {draftBilled !== input.shotSeconds
            ? `The draft model, ${draft.label}, bills ${draftBilled} s for each ${input.shotSeconds} s draft.`
            : ""}{" "}
          Each job is charged and rounded on its own, the same way billing does it. Script and storyboard writing adds a few cents per
          episode and is not included.
        </p>

        <h3>
          {chosen.label}, {input.draftsPerShot > 0 ? "draft then final" : "final only"}, line by line
        </h3>
        <Breakdown cost={chosenCost} />

        <h2 id="units">Every model's price</h2>
        <p>
          These are fal.ai's list prices, read on the date shown, and what you pay with the {markupPct}% added. Each job is charged at its
          real cost when it finishes; the estimate on the button uses these prices.
        </p>
        <TableWrap label="Unit prices">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Use</th>
                <th>Unit</th>
                <th class="num">fal price</th>
                <th class="num">You pay</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const u = unitPrices(m, platform);
                return (
                  <tr data-unit-model={m.id}>
                    <td>
                      {m.label}
                      {m.nativeAudio ? <div class="small muted">native audio</div> : null}
                    </td>
                    <td>
                      {kindLabel[m.kind]}
                      {m.tiers.length ? <div class="small muted">{m.tiers.join(" and ")}</div> : null}
                    </td>
                    <td>
                      {unitLabel(m)}
                      {m.durations.length ? (
                        <div class="small muted">
                          clips of{" "}
                          {m.durations.length > 6 ? `${m.durations[0]} to ${m.durations[m.durations.length - 1]}` : m.durations.join(", ")}{" "}
                          s
                        </div>
                      ) : null}
                    </td>
                    <td class="num">
                      {u.fal.map((x) => (
                        <div>{x}</div>
                      ))}
                    </td>
                    <td class="num">
                      {u.you.map((x) => (
                        <div>{x}</div>
                      ))}
                    </td>
                    <td>
                      <Ext href={m.price.source}>source</Ext>
                      <div class="small muted">
                        verified on {m.price.verifiedOn} <StatusTag status={m.price.status} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
        <p class="small muted">
          Seedance is billed by tokens, and fal charges what the model provider reports, so a Seedance job can cost a little more or less
          than its estimate. You always pay the real figure plus {markupPct}%.
        </p>

        <h2 id="refunds">Failures and refunds</h2>
        <ul>
          <li>Before a job starts, we hold its estimate from your balance. If your balance can't cover it, the job doesn't start.</li>
          <li>When it finishes, you pay the real cost plus {markupPct}% and the rest of the hold comes back.</li>
          <li>
            If it fails and fal doesn't bill us (fal doesn't bill server errors or queue time), the whole hold comes back and your cost log
            shows a refund line.
          </li>
          <li>
            If it fails and fal does bill us, we charge it and the cost log says so. We pass on refunds only when the provider refunds us.
          </li>
          <li>A clip that renders but looks wrong is not a failure, and it is charged. That is why drafts are cheap.</li>
        </ul>

        <h2 id="daily">The daily charge</h2>
        <p>
          Besides generations, each workspace pays a small daily charge for its storage and a share of our fixed costs (server, backups,
          domain, email):
        </p>
        <pre>
          <code>
            daily = (min({usd(capMicro)} cap, fixed costs / active workspaces) + storage) x {1 + platform.markup} / days in month
          </code>
        </pre>
        <ul>
          <li>
            Fixed costs are {usd(fixedMonthly)} a month right now, listed line by line on the <a href="/finances">finances page</a>.
          </li>
          <li>
            Only workspaces that generated something that month are active and pay a share. The share is capped at {usd(capMicro)} a month,
            and the cap can only ever go down.
          </li>
          <li>
            Storage is R2's price: {usdPrecise(usdToMicro(platform.storageUsdPerGbMonth))} per GB a month, charged in every month, active or
            not.
          </li>
        </ul>
        <div class="card">
          <p style="margin-top:0">
            <strong>Example:</strong> a workspace with {exampleGb} GB of media, in a 30 day month when it generated something and the share
            is at the cap:
          </p>
          <p>
            ({usd(exampleMonth.fixedShareMicro)} + {usdPrecise(exampleMonth.storageMicro)}) x {1 + platform.markup} ={" "}
            <strong>{usd(exampleMonth.totalMicro)}</strong> a month, or {usdPrecise(exampleDay.totalMicro)} a day.
          </p>
          <p style="margin-bottom:0">
            In a month it generates nothing, it pays only storage: {usdPrecise(idleMonth.totalMicro)}. As more workspaces are active, the
            share falls below the cap.
          </p>
        </div>

        <h2 id="compare">Compared with subscriptions</h2>
        <p>
          A {COMPARE.scenario.episodes}-episode drama of {COMPARE.scenario.episodeSeconds} seconds per episode is{" "}
          {int(COMPARE.scenario.totalSeconds)} seconds of final video, or {int(COMPARE.scenario.shots)} shots of{" "}
          {COMPARE.scenario.shotSeconds} seconds. First frames at ${COMPARE.scenario.frameUsd} each ({COMPARE.scenario.frameModel}). Script
          writing, voices and storage are left out (a few dollars). Checked on {COMPARE.checkedOn}; these are research figures from our
          pricing notes, not live prices.
        </p>
        <ul>
          <li>
            <strong>Final only:</strong> 1 try per shot and 1 first frame.
          </li>
          <li>
            <strong>Draft then final:</strong> 3 drafts per shot on {COMPARE.scenario.draftModel} (${COMPARE.scenario.draftUsdPerSecond}/s),
            then 1 final, and 4 first frames.
          </li>
        </ul>
        <TableWrap label="54-episode drama on each model">
          <table>
            <thead>
              <tr>
                <th>Final model</th>
                <th class="num">fal $/s</th>
                <th class="num">Final only: fal</th>
                <th class="num">Final only: Reel</th>
                <th class="num">Draft then final: fal</th>
                <th class="num">Draft then final: Reel</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.models.map((m) => (
                <tr>
                  <td>{m.model}</td>
                  <td class="num">{m.perSecond}</td>
                  <td class="num">${int(m.finalFal)}</td>
                  <td class="num">${int(m.finalReel)}</td>
                  <td class="num">${int(m.dtfFal)}</td>
                  <td class="num">${int(m.dtfReel)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <p class="small muted">
          Veo can't render 5 second clips, so a Veo shot list would use 4 or 6 second shots. Hailuo is priced per video. Seedance charges
          follow provider-reported tokens. Source: fal.ai model pages, collected in our pricing notes.
        </p>

        <h3>Higgsfield</h3>
        <p>
          Plans read on <Ext href={COMPARE.higgsfieldSource}>higgsfield.ai/pricing</Ext> on {COMPARE.checkedOn}, while a 30% promotion was
          running:
        </p>
        <TableWrap label="Higgsfield plans">
          <table>
            <thead>
              <tr>
                <th>Plan</th>
                <th>Monthly</th>
                <th>Annual (per month)</th>
                <th>Credits a month</th>
                <th>$ per credit (monthly / annual)</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.higgsfieldPlans.map((p) => (
                <tr>
                  <td>{p.plan}</td>
                  <td>{p.monthly}</td>
                  <td>{p.annual}</td>
                  <td>{p.credits}</td>
                  <td>{p.perCredit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <p>
          The same {int(COMPARE.scenario.totalSeconds)} seconds, one Nano Banana Pro frame per try, at the Ultra plan's price per credit.
          This assumes every credit bought gets used:
        </p>
        <TableWrap label="Higgsfield compared with Reel">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Higgsfield final only (Ultra monthly / annual)</th>
                <th>Reel final only</th>
                <th>Higgsfield 4 tries per shot (Ultra monthly)</th>
                <th>Reel draft then final</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.vsHiggsfield.map((r) => (
                <tr>
                  <td>{r.model}</td>
                  <td>{r.hfFinal}</td>
                  <td>{r.reelFinal}</td>
                  <td>{r.hf4}</td>
                  <td>{r.reelDtf}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <div class="notice">
          <p style="margin-top:0">
            <strong>Where subscriptions win.</strong> Higgsfield is cheaper per final second on most models, often by a lot. Kling 3.0 on
            Higgsfield is about a third of Reel's price, and its 7-day unlimited Kling 3.0 window can make Kling drafts nearly free for a
            week. If you use all your credits every month on Kling or Seedance, a subscription is cheaper than Reel.
          </p>
          <p>
            Reel is about even on Veo 3.1 Fast and Veo 3.1. It is cheaper only where Higgsfield has no cheap tier: drafting on Veo 3.1 Lite
            or MiniMax H3 Max Turbo. That is why Reel's draft then final beats four tries on the same model for Veo, Seedance 2.0 and Wan,
            but not for Kling.
          </p>
          <p style="margin-bottom:0">
            Higgsfield's "unlimited" plans include "dynamic speed adjustments" at busy times, and unused credits don't carry over. Its
            credit costs are shown as approximate, and the page doesn't say whether they include audio.
          </p>
        </div>
        <p>
          Reel's case is not the lowest price per second. It is no subscription, no unused credits at month end, no throttling, the real
          cost of every job, automatic refunds for unbilled failures, and a studio you can run yourself with your own key.
        </p>
      </>
    ),
  });
}
