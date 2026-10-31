/** @jsxImportSource hono/jsx */
/**
 * The front page. The hero shows a real storyboard (the demo project's shot
 * cards) with each shot's real price as a ticket stub: the same estimate and
 * charge functions the studio's buttons and billing use.
 */
import { type CatalogModel, type Shot, estimate } from "@reel/core";
import { EXAMPLE_PLAN, episodeCost, generationCharge } from "@reel/money";
import { raw } from "hono/html";
import type { Ctx } from "../../context";
import { loadDemo } from "../demo";
import { page, usd } from "../ui";

const CSS = `
.h-hero{background:var(--plum);color:#F3ECFA;position:relative;overflow:hidden}
.h-hero::after{content:"";position:absolute;inset:auto -10% -40% 40%;height:120%;background:radial-gradient(closest-side,rgba(229,51,106,.28),transparent 70%);pointer-events:none}
.h-hero-in{max-width:1180px;margin:0 auto;padding:56px 20px 72px;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:48px;align-items:center;position:relative;z-index:1}
.h-title{font-family:var(--display);font-weight:900;font-size:clamp(50px,6.6vw,96px);line-height:.92;letter-spacing:.005em;margin:0 0 22px;max-width:13.5ch;text-wrap:balance}
.h-lede{font-size:19px;line-height:1.5;color:#D9CCE8;max-width:46ch;margin:0 0 30px}
.h-cta{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.h-btn{font:600 16px/1 var(--font);padding:15px 22px;border-radius:999px;text-decoration:none;display:inline-block;border:2px solid transparent}
.h-btn.primary{background:var(--rouge);color:#fff}.h-btn.primary:hover{background:#F04B7E}
.h-btn.ghost{color:#fff;border-color:#6D5A85}.h-btn.ghost:hover{border-color:#fff}
.h-note{margin:18px 0 0;font-size:14px;color:#A996BF}
.h-phone{justify-self:center;width:min(340px,100%);aspect-ratio:9/18.5;border-radius:44px;background:#0E0716;border:1px solid #4A3463;box-shadow:0 40px 80px -30px rgba(0,0,0,.7),inset 0 0 0 8px #160C22;padding:22px 16px;display:flex;flex-direction:column;gap:12px;overflow:hidden}
.h-phone-bar{display:flex;justify-content:space-between;font:600 13px/1 var(--font);color:#B9A6D0;padding:0 6px}
.h-phone-bar b{color:#fff;font-family:var(--display);font-size:18px;letter-spacing:.02em}
.h-card{position:relative;background:var(--plum-2);border-radius:14px;padding:14px 14px 14px 16px;border-left:3px solid var(--rouge)}
.h-card .cam{font:600 12px/1.2 var(--font);color:#B9A6D0;margin:0 0 6px}
.h-card .what{font-size:14px;line-height:1.4;color:#F3ECFA;margin:0}
.h-card .line{font-size:13px;line-height:1.4;color:var(--gold);margin:8px 0 0;font-style:italic}
.ticket{display:inline-flex;align-items:stretch;background:var(--gold);color:#2A1A05;border-radius:6px;font-family:var(--display);font-weight:800;line-height:1;position:relative;
  -webkit-mask:radial-gradient(circle 5px at 0 50%,transparent 98%,#000) left/51% 100% no-repeat,radial-gradient(circle 5px at 100% 50%,transparent 98%,#000) right/51% 100% no-repeat;
          mask:radial-gradient(circle 5px at 0 50%,transparent 98%,#000) left/51% 100% no-repeat,radial-gradient(circle 5px at 100% 50%,transparent 98%,#000) right/51% 100% no-repeat}
.ticket span{padding:7px 10px;font-size:17px;display:flex;flex-direction:column;justify-content:center}
.ticket span small{font:600 10px/1 var(--font);opacity:.75;margin-bottom:3px}
.ticket span+span{border-left:2px dashed rgba(42,26,5,.45)}
.h-card .ticket{position:absolute;right:-6px;top:-10px;transform:rotate(3deg)}
.h-phone .ticket{opacity:0;animation:stub .5s cubic-bezier(.2,.9,.3,1.3) forwards}
.h-phone .h-card:nth-of-type(2) .ticket{animation-delay:.55s}.h-phone .h-card:nth-of-type(3) .ticket{animation-delay:.85s}.h-phone .h-card:nth-of-type(4) .ticket{animation-delay:1.15s}.h-phone .h-card:nth-of-type(5) .ticket{animation-delay:1.45s}
@keyframes stub{from{opacity:0;transform:translateY(-14px) rotate(-8deg) scale(.9)}to{opacity:1;transform:rotate(3deg)}}
@media (prefers-reduced-motion:reduce){.h-phone .ticket{animation:none;opacity:1}}
.h-ep{margin-top:auto;background:var(--rouge);color:#fff;border-radius:14px;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;font:600 14px/1.2 var(--font)}
.h-ep b{font-family:var(--display);font-size:22px;font-weight:800}

.h-strip{background:#0E0716;color:#F3ECFA}
.h-strip-in{max-width:1180px;margin:0 auto;padding:56px 20px}
.h-strip h2{color:#fff;font-size:clamp(34px,4vw,48px);margin:0 0 8px}
.h-strip p.sub{color:#B9A6D0;margin:0 0 28px;max-width:60ch}
.h-reel{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(210px,1fr);gap:16px;overflow-x:auto;padding:14px 4px 18px;scroll-snap-type:x mandatory}
.h-shot{scroll-snap-align:start;aspect-ratio:9/16;background:linear-gradient(180deg,#2B1840,#1D0F2B);border:1px solid #3B2B4D;border-radius:16px;padding:16px;display:flex;flex-direction:column;position:relative}
.h-shot .n{font-family:var(--display);font-weight:900;font-size:56px;line-height:.8;color:#3E2A55}
.h-shot .cam{font:600 12px/1.3 var(--font);color:#B9A6D0;margin:14px 0 6px}
.h-shot .what{font-size:15px;line-height:1.4;margin:0}
.h-shot .line{font-size:14px;color:var(--gold);font-style:italic;margin:10px 0 0}
.h-shot .ticket{margin-top:auto;align-self:flex-start}

.h-make{max-width:1180px;margin:0 auto;padding:72px 20px 40px}
.h-make h2{font-size:clamp(34px,4vw,48px);margin:0 0 28px}
.h-steps{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:0;counter-reset:st;position:relative}
.h-steps::before{content:"";position:absolute;left:0;right:0;top:21px;height:2px;background:var(--border)}
.h-steps li{counter-increment:st;position:relative;padding:0 16px 0 0;max-width:none;margin:0}
.h-steps li::before{content:counter(st);display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:var(--plum);color:var(--gold);font:800 22px/1 var(--display);margin-bottom:14px;position:relative}
.h-steps b{display:block;font-size:16px;margin-bottom:4px}
.h-steps span{color:var(--text-2);font-size:14.5px;line-height:1.45}

.h-price{max-width:1180px;margin:0 auto;padding:40px 20px 72px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:48px;align-items:start}
.h-big{font-family:var(--display);font-weight:900;font-size:clamp(88px,12vw,160px);line-height:.85;color:var(--accent);margin:0}
.h-big-cap{font-size:17px;max-width:44ch;margin:14px 0 0}
.h-price ul{list-style:none;padding:0;margin:0;display:grid;gap:18px}
.h-price li{max-width:none;margin:0;padding-left:18px;border-left:3px solid var(--gold)}
.h-price li b{display:block;font-size:17px}
.h-price li span{color:var(--text-2)}

.h-local{background:var(--plum);color:#F3ECFA}
.h-local-in{max-width:1180px;margin:0 auto;padding:56px 20px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:40px;align-items:center}
.h-local h2{color:#fff;font-size:clamp(34px,4vw,48px);margin:0 0 10px}
.h-local p{color:#D9CCE8;max-width:48ch}
.h-local a{color:var(--gold)}
.h-term{background:#0E0716;border:1px solid #3B2B4D;border-radius:14px;padding:22px;font:500 15px/1.7 var(--mono);color:#D9CCE8;overflow-x:auto}
.h-term .p{color:var(--rouge)}.h-term .c{color:#fff}.h-term .o{color:#8E7BA6}
@media (max-width:900px){.h-hero-in,.h-price,.h-local-in{grid-template-columns:1fr}.h-hero-in{padding-top:36px}.h-phone{width:min(320px,100%)}
  .h-steps{grid-template-columns:1fr;gap:22px}.h-steps::before{left:21px;right:auto;top:0;bottom:0;width:2px;height:auto}.h-steps li{padding:0 0 0 64px}.h-steps li::before{position:absolute;left:0;top:-4px;margin:0}}
`;

interface ShotPrice {
  draft: number;
  final: number;
}

/** What one shot costs on Dropisode, from the price catalog: a first frame, then the clip (and voice lines on finals). */
function shotPrices(c: Ctx, shot: Shot): ShotPrice {
  const { catalog, platform } = c.get("deps");
  const d = catalog.config.defaults;
  const charge = (m: number) => generationCharge(m, platform);
  const frame = (img: CatalogModel) => charge(estimate(img, { images: 1 }).providerCostMicro);
  const clip = (m: CatalogModel, audio: boolean) => charge(estimate(m, { durationS: shot.durationS, audio }).providerCostMicro);
  const finalVideo = catalog.get(d.final.video);
  const voice = finalVideo.nativeAudio
    ? 0
    : shot.dialogue.reduce((a, l) => a + charge(estimate(catalog.get(d.tts), { chars: l.text.length }).providerCostMicro), 0);
  return {
    draft: frame(catalog.get(d.draft.image)) + clip(catalog.get(d.draft.video), false),
    final: frame(catalog.get(d.final.image)) + clip(finalVideo, true) + voice,
  };
}

const camOf = (s: Shot) => (s.camera ? s.camera.charAt(0).toUpperCase() + s.camera.slice(1) : "Shot");
const whatOf = (s: Shot) => s.description.replace(/^(Wide|Medium two-shot|Medium|Close-up|Insert):\s*/i, "");

function Ticket(p: { prices: ShotPrice }) {
  return (
    <span class="ticket" aria-label={`Draft ${usd(p.prices.draft)}, final ${usd(p.prices.final)}`}>
      <span>
        <small>Draft</small>
        {usd(p.prices.draft)}
      </span>
      <span>
        <small>Final</small>
        {usd(p.prices.final)}
      </span>
    </span>
  );
}

export function homePage(c: Ctx) {
  const { catalog, platform } = c.get("deps");
  const user = c.get("user");
  const d = catalog.config.defaults;
  const final = catalog.get(d.final.video);
  const draft = catalog.get(d.draft.video);
  const example = episodeCost(catalog, platform, { ...EXAMPLE_PLAN, image: d.final.image, finalVideo: final.id, draftVideo: draft.id });
  const markupPct = Math.round(platform.markup * 100);
  const demo = loadDemo();
  const shots = demo?.project.episodes[0]?.scenes.flatMap((s) => s.shots) ?? [];
  const priced = shots.map((s) => ({ shot: s, prices: shotPrices(c, s) }));
  const projectName = demo?.project.name ?? "The Letter";
  const episodeTotal = priced.reduce((a, p) => a + p.prices.final, 0);

  return page(c, {
    title: "Dropisode",
    fullBleed: true,
    description: `Dropisode is an open-source studio for vertical AI short dramas. Script, cast, storyboard, cheap drafts, premium finals. The provider's price plus ${markupPct}%, shown before every shot.`,
    body: (
      <>
        <style>{raw(CSS)}</style>

        <section class="h-hero">
          <div class="h-hero-in">
            <div>
              <h1 class="h-title">Make the next episode. Know what every shot costs.</h1>
              <p class="h-lede">
                Dropisode is a studio for vertical short dramas. Write the script, cast your characters, storyboard each scene, try every
                shot as a cheap draft, then render the ones you approve. Every button shows its exact price before you press it.
              </p>
              <div class="h-cta">
                <a class="h-btn primary" href={user ? "/studio/" : "/sign-up"}>
                  {user ? "Open the studio" : "Start a project"}
                </a>
                <a class="h-btn ghost" href="/demo">
                  See a finished episode
                </a>
              </div>
              <p class="h-note">
                Prepaid credit at the model provider's price plus {markupPct}%. No subscription, and credit never expires.
              </p>
            </div>

            <div class="h-phone" aria-label={`A storyboard from the demo project ${projectName}, with the price of each shot`}>
              <div class="h-phone-bar">
                <b>{projectName}</b>
                <span>Episode 1</span>
              </div>
              {priced.slice(1, 5).map(({ shot, prices }) => (
                <div class="h-card">
                  <p class="cam">{camOf(shot)}</p>
                  <p class="what">{whatOf(shot)}</p>
                  {shot.dialogue[0] ? <p class="line">"{shot.dialogue[0].text}"</p> : null}
                  <Ticket prices={prices} />
                </div>
              ))}
              <div class="h-ep">
                <span>
                  {shots.length} shots, finals
                  <br />
                  {shots.reduce((a, s) => a + s.durationS, 0)} seconds
                </span>
                <b>{usd(episodeTotal)}</b>
              </div>
            </div>
          </div>
        </section>

        {priced.length > 0 ? (
          <section class="h-strip">
            <div class="h-strip-in">
              <h2>The whole storyboard, priced</h2>
              <p class="sub">
                Every shot of the demo episode with what a draft and a final cost on Dropisode today, worked out from each model's published
                price. Drafts use {draft.label}; finals use {final.label}.
              </p>
              <div class="h-reel">
                {priced.map(({ shot, prices }, i) => (
                  <article class="h-shot" aria-label={`Shot ${i + 1}`}>
                    <span class="n" aria-hidden="true">
                      {i + 1}
                    </span>
                    <p class="cam">
                      {camOf(shot)}, {shot.durationS} s
                    </p>
                    <p class="what">{whatOf(shot)}</p>
                    {shot.dialogue[0] ? <p class="line">"{shot.dialogue[0].text}"</p> : null}
                    <Ticket prices={prices} />
                  </article>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        <section class="h-make">
          <h2>From an idea to an episode</h2>
          <ol class="h-steps">
            <li>
              <b>Script</b>
              <span>Paste yours or start from a one-line idea. Edit it at every step.</span>
            </li>
            <li>
              <b>Cast</b>
              <span>Characters and places with reference images, reused in every shot so faces stay the same.</span>
            </li>
            <li>
              <b>Storyboard</b>
              <span>Each scene becomes shot cards. Reorder, split, merge or rewrite them.</span>
            </li>
            <li>
              <b>Draft</b>
              <span>Try each shot on a cheap model. Bad tries cost cents.</span>
            </li>
            <li>
              <b>Final</b>
              <span>Approve the shots you like. Only those go to the better model.</span>
            </li>
            <li>
              <b>Episode</b>
              <span>One vertical MP4 with subtitles, plus every shot file and an edit list.</span>
            </li>
          </ol>
        </section>

        <section class="h-price">
          <div>
            <p class="h-big">{usd(example.chargeMicro)}</p>
            <p class="h-big-cap">
              A {EXAMPLE_PLAN.shots}-shot episode, every shot drafted {EXAMPLE_PLAN.draftsPerShot} times and finished once, on today's
              default models. <a href="/pricing">Price it on any model</a>.
            </p>
          </div>
          <ul>
            <li>
              <b>The provider's price plus {markupPct}%</b>
              <span>
                We charge what fal.ai bills for each job, plus {markupPct}% for card fees and a reserve. Every unit price is{" "}
                <a href="/pricing#units">listed with its source</a>.
              </span>
            </li>
            <li>
              <b>Failures the provider doesn't bill are refunded</b>
              <span>Automatically, with a refund line in your cost log.</span>
            </li>
            <li>
              <b>Our costs are public</b>
              <span>
                Top-ups, what providers billed, refunds and fixed costs, live on the <a href="/finances">finances page</a>.
              </span>
            </li>
            <li>
              <b>Not always the cheapest</b>
              <span>
                Heavy users on some subscriptions pay less per second. <a href="/pricing#compare">See where they win</a>.
              </span>
            </li>
          </ul>
        </section>

        <section class="h-local">
          <div class="h-local-in">
            <div>
              <h2>Or run it on your own computer</h2>
              <p>
                The same studio, free, with your own fal.ai key. You pay fal directly and nothing is added. Projects are plain folders, and
                they move between your computer and dropisode.com. <a href="/docs/local">How to run it</a>.
              </p>
            </div>
            <div class="h-term" aria-label="Terminal">
              <div>
                <span class="p">$ </span>
                <span class="c">npx dropisode</span>
              </div>
              <div class="o">Dropisode is running at http://localhost:4320</div>
              <div class="o">Projects: ~/Dropisode</div>
            </div>
          </div>
        </section>
      </>
    ),
  });
}
