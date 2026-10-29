/** @jsxImportSource hono/jsx */
import { EXAMPLE_PLAN, episodeCost } from "@reel/money";
import type { Ctx } from "../../context";
import { page, usd } from "../ui";

export function homePage(c: Ctx) {
  const { catalog, platform } = c.get("deps");
  const user = c.get("user");
  const d = catalog.config.defaults;
  const final = catalog.get(d.final.video);
  const draft = catalog.get(d.draft.video);
  // The same function the calculator and billing use.
  const example = episodeCost(catalog, platform, { ...EXAMPLE_PLAN, image: d.final.image, finalVideo: final.id, draftVideo: draft.id });
  const markupPct = Math.round(platform.markup * 100);
  return page(c, {
    title: "Reel",
    description: `Reel is an open-source AI short-drama studio. Write a script, cast it, storyboard it, draft cheaply, render finals. The provider's price plus ${markupPct}%, shown before every shot.`,
    body: (
      <>
        <section class="hero">
          <h1>Make short dramas with AI. See the price before every shot.</h1>
          <p class="lede">
            Reel is an open-source studio for vertical short dramas. You pay the model provider's real price plus {markupPct}%, from prepaid
            credit. No subscription, no credits that expire, no throttling.
          </p>
          <div class="actions">
            {user ? (
              <a class="button" href="/studio/">
                Open the studio
              </a>
            ) : (
              <a class="button" href="/sign-in">
                Sign in
              </a>
            )}
            <a class="button secondary" href="/demo">
              Try the demo
            </a>
          </div>
          <p class="small muted">No sign-up needed for the demo. There is no free tier: you top up before your first generation.</p>
        </section>

        <h2>How it works</h2>
        <ol class="steps">
          <li>
            <strong>Write or paste a script.</strong> Or start from a one-line idea and let a language model draft it. Edit it at every
            step.
          </li>
          <li>
            <strong>Cast it.</strong> Characters, locations and props, each with a description and reference images. They are used in every
            shot they appear in, so faces stay the same.
          </li>
          <li>
            <strong>Storyboard.</strong> Each scene becomes shot cards: what we see, the camera, who is in it, the lines, the length.
            Reorder, split, merge or rewrite them.
          </li>
          <li>
            <strong>Draft cheaply, then render finals.</strong> Try each shot on a cheap draft model. Approve the ones you like and only
            those go to a premium model.
          </li>
          <li>
            <strong>Get the episode.</strong> Reel joins the approved finals into a vertical MP4 with subtitles. You also get every shot
            file and an edit list for another editor.
          </li>
        </ol>

        <h2>What it costs</h2>
        <div class="grid">
          <div class="card">
            <strong>The exact price on every button.</strong>
            <p class="muted">
              Every generate button shows what that shot will cost before you press it. The cost log shows every try, its model and price.
            </p>
          </div>
          <div class="card">
            <strong>Provider price plus {markupPct}%.</strong>
            <p class="muted">
              We charge what fal.ai bills us for each job, plus {markupPct}% to cover card fees and a reserve. Unit prices are{" "}
              <a href="/pricing#units">listed</a> with their sources.
            </p>
          </div>
          <div class="card">
            <strong>No subscription, no expiry.</strong>
            <p class="muted">Top up from ${platform.minTopupUsd}. Your credit never expires and no plan slows you down at busy times.</p>
          </div>
          <div class="card">
            <strong>Automatic refunds.</strong>
            <p class="muted">
              When a generation fails and the provider doesn't bill it, the hold is released in full and you see a refund line. If the
              provider did bill a failure, we say so.
            </p>
          </div>
          <div class="card">
            <strong>Real costs, published.</strong>
            <p class="muted">
              Our <a href="/finances">finances page</a> shows top-ups, what providers billed, refunds, fixed costs and the reserve, live.
            </p>
          </div>
          <div class="card">
            <strong>Free to run yourself.</strong>
            <p class="muted">
              <code>npx reel-studio</code> runs the same studio on your computer with your own fal.ai key, at fal's price.{" "}
              <a href="/docs/local">How</a>.
            </p>
          </div>
        </div>

        <div class="card" style="margin-top:16px">
          <p style="margin-top:0">
            <strong>An example episode:</strong> {EXAMPLE_PLAN.shots} shots of {EXAMPLE_PLAN.shotSeconds} seconds,{" "}
            {EXAMPLE_PLAN.draftsPerShot} drafts on {draft.label} and {EXAMPLE_PLAN.finalsPerShot} final on {final.label} per shot, costs{" "}
            <strong>{usd(example.chargeMicro)}</strong> on Reel ({usd(example.providerMicro)} at fal's price).
          </p>
          <a href="/pricing">See every model in the calculator</a>
        </div>

        <h2>Is it the cheapest?</h2>
        <p>
          Not always. Heavy users who spend every credit on some subscriptions pay less per second, especially on Kling and Seedance. Reel
          is about even on Veo, and cheaper when you draft on a cheap model first. We publish the{" "}
          <a href="/pricing#compare">full comparison with its sources</a>, including where subscriptions win.
        </p>
        <p>
          What Reel offers instead: the price before every shot, credit that never expires, no throttling, automatic refunds for failures
          the provider didn't bill, cheap drafts before premium renders, and a studio you can run yourself for free.
        </p>
      </>
    ),
  });
}
