/** @jsxImportSource hono/jsx */
import type { Ctx } from "../../context";
import { page } from "../ui";

export function docsPage(c: Ctx) {
  const { catalog, platform } = c.get("deps");
  const d = catalog.config.defaults;
  const markupPct = Math.round(platform.markup * 100);
  const draft = catalog.get(d.draft.video);
  const final = catalog.get(d.final.video);
  const tts = catalog.get(d.tts);
  return page(c, {
    title: "Docs",
    description:
      "How to use Dropisode: getting started, prices, drafts and finals, approving shots, audio, export, and what V1 doesn't do.",
    body: (
      <>
        <h1>Docs</h1>
        <div class="toc">
          <a href="#start">Getting started</a>
          <a href="#prices">How prices work</a>
          <a href="#tiers">Drafts and finals</a>
          <a href="#approve">Approving shots</a>
          <a href="#audio">Audio</a>
          <a href="#export">Export</a>
          <a href="#move">Moving projects</a>
          <a href="#not-v1">What V1 doesn't do</a>
          <a href="/docs/local">Run it locally</a>
        </div>

        <h2 id="start">Getting started (hosted)</h2>
        <ol>
          <li>
            <a href="/sign-up">Sign up</a> with your email and a password, or with Google. You get a workspace. Invite as many people to it
            as you like; there are no seats.
          </li>
          <li>
            Top up on the <a href="/billing">Billing</a> page, from ${platform.minTopupUsd}. There is no free credit, so you top up before
            your first generation. New accounts can spend up to ${platform.newAccountDailyCapUsd} a day for the first{" "}
            {platform.newAccountDays} days.
          </li>
          <li>
            Open the <a href="/studio/">Studio</a> and create a project. Pick vertical 9:16 (the default) or wide 16:9.
          </li>
          <li>Write or paste a script, or give a one-line idea and let the script model draft one. Dropisode splits it into scenes.</li>
          <li>
            Check the cast. Dropisode picks out characters, locations and props. Give each a description and reference images: generate
            them, or upload your own. Uploading a photo of a real person needs that person's consent, and you confirm it when you upload.
          </li>
          <li>Storyboard each scene. Each shot is a card you can edit, reorder, split or merge.</li>
          <li>Generate drafts, approve the shots you like, render finals, and assemble the episode.</li>
        </ol>
        <p>
          Want to see it first? The <a href="/demo">demo</a> walks through a finished project without signing up.
        </p>

        <h2 id="prices">How prices work</h2>
        <ul>
          <li>
            Every generate button shows the price of that job before you press it, worked out from the provider's published unit price.
          </li>
          <li>When you press it, Dropisode holds that amount from your balance. If the balance can't cover it, nothing starts.</li>
          <li>When the job finishes you pay what fal.ai actually billed, plus {markupPct}%. The rest of the hold comes back.</li>
          <li>If the job fails and fal doesn't bill it, the hold comes back in full and the cost log shows a refund line.</li>
          <li>Every try is in the project's cost log: the model, provider, units, price, and any refund.</li>
          <li>
            A small daily charge covers your storage and a capped share of fixed costs. See <a href="/pricing#daily">the daily charge</a>.
          </li>
        </ul>

        <h2 id="tiers">Drafts and finals</h2>
        <p>
          Each shot is made in two steps: a first frame (a still image using your cast's reference images), then a clip made from that
          frame. Each shot can be made on two tiers:
        </p>
        <ul>
          <li>
            <strong>Draft:</strong> a cheap model at low resolution, silent by default. Use drafts to try the framing and the action. The
            default draft model is {draft.label}.
          </li>
          <li>
            <strong>Final:</strong> a premium model, with audio where the model has it. The default final model is {final.label}.
          </li>
        </ul>
        <p>
          A clip that renders but looks wrong is still charged, because the provider billed it. Drafting first keeps those tries cheap. See
          what each model costs on the <a href="/pricing">pricing page</a>.
        </p>

        <h2 id="approve">Approving shots</h2>
        <p>
          Only shots marked approved can be sent to final. Approve a shot when its draft looks right. Changing what the shot shows (the
          description, camera, cast, lines or length) clears the approval, so you never pay for a final of a shot you haven't checked.
        </p>

        <h2 id="audio">Audio</h2>
        <ul>
          <li>
            <strong>Native:</strong> some video models make their own dialogue and sound. Dropisode sends the shot's lines in the prompt.
            The pricing page marks these models.
          </li>
          <li>
            <strong>Text to speech:</strong> for models without native audio, or when you choose it, Dropisode voices each line with a
            text-to-speech model ({tts.label} by default) and mixes it into the shot.
          </li>
          <li>
            <strong>None:</strong> a silent shot.
          </li>
        </ul>
        <p>Subtitles come from the script and are burned into the episode. They are also written as a separate subtitles.srt file.</p>

        <h2 id="export">Export</h2>
        <p>Assembling an episode joins the approved finals in order and writes:</p>
        <ul>
          <li>
            <code>episode.mp4</code>: the finished episode with burned-in subtitles.
          </li>
          <li>
            <code>shots/</code>: every shot as its own file, trimmed to length.
          </li>
          <li>
            <code>subtitles.srt</code>: the subtitles on their own.
          </li>
          <li>
            <code>edit-list.edl</code> and <code>edit-list.json</code>: the edit list, for finishing in another editor.
          </li>
        </ul>
        <p>You can also assemble a rough cut from drafts to check the pacing before you pay for finals.</p>

        <h2 id="move">Keeping a copy of a project</h2>
        <p>
          Use Export on a project card to download a zip with <code>project.json</code> and every media file. It's yours to keep. Importing
          a zip back into the studio isn't available yet.
        </p>

        <h2 id="not-v1">What V1 doesn't do</h2>
        <ul>
          <li>Providers other than fal.ai. A second provider comes later, after a test spend.</li>
          <li>Models on our own GPUs.</li>
          <li>Lip sync, face swap, "AI influencer" or recast features.</li>
          <li>Export to CapCut, Premiere or Jianying project files. The shot files and edit list are there for that.</li>
          <li>Publishing, paywalls or hosting finished dramas for viewers.</li>
          <li>Real-time editing of the same storyboard by two people at once.</li>
          <li>A desktop app. Local mode runs in your browser.</li>
          <li>A free tier, starter credit, trials or referral credit.</li>
        </ul>
      </>
    ),
  });
}

export function docsLocalPage(c: Ctx) {
  return page(c, {
    title: "Run Dropisode locally",
    description: "Run the Dropisode studio on your own computer with one command and your own fal.ai key. Free, at fal's price.",
    body: (
      <>
        <p class="small">
          <a href="/docs">Docs</a>
        </p>
        <h1>Run Dropisode locally</h1>
        <p class="lede">
          The same studio runs on your computer for free. You use your own fal.ai key and pay fal directly, at fal's price. No account, no
          markup.
        </p>

        <h2>What you need</h2>
        <ul>
          <li>Node.js 22 or newer.</li>
          <li>
            A fal.ai key, from your fal.ai dashboard. Not needed for <code>--mock</code>.
          </li>
          <li>
            ffmpeg. Dropisode uses yours if it can burn in subtitles, and otherwise the copy bundled with the package. If neither works, it
            tells you how to install it. You can point it at a specific ffmpeg with <code>REEL_FFMPEG</code>.
          </li>
        </ul>

        <h2>Start it</h2>
        <pre>
          <code>npx dropisode</code>
        </pre>
        <p>This starts the studio on 127.0.0.1 and opens it in your browser. Add your fal.ai key on the Settings page. Options:</p>
        <ul>
          <li>
            <code>--dir &lt;path&gt;</code>: where projects are kept (default <code>~/Dropisode</code>).
          </li>
          <li>
            <code>--port &lt;n&gt;</code>: the port (default 4320).
          </li>
          <li>
            <code>--no-open</code>: don't open the browser.
          </li>
          <li>
            <code>--mock</code>: no key and no cost. Placeholder clips are made on your computer, so you can try the whole workflow first.
          </li>
        </ul>

        <h2>Where things are stored</h2>
        <ul>
          <li>
            Each project is a plain folder in your projects folder: <code>project.json</code>, a <code>media/</code> folder, a{" "}
            <code>jobs/</code> folder and <code>exports/</code>. No database server.
          </li>
          <li>
            Your fal.ai key is saved in <code>~/.config/dropisode/config.json</code> (or <code>$XDG_CONFIG_HOME/reel/config.json</code>, or
            the path in <code>REEL_CONFIG</code>), readable only by you. It is never sent to the browser. You can also set{" "}
            <code>FAL_KEY</code> in the environment.
          </li>
          <li>
            Optionally add a fal key with billing access, so Dropisode can record what fal actually billed for each request instead of the
            published price.
          </li>
        </ul>

        <h2>Keeping a copy</h2>
        <p>
          Export a project as a zip from the project list. See <a href="/docs#move">keeping a copy</a>.
        </p>

        <h2>Moderation in local mode</h2>
        <p>
          Local mode has no moderation layer of ours: nothing is checked by Dropisode before it is sent. fal.ai's and the model providers'
          own filters still apply, and their terms still bind you. fal.ai requires end users to be 18 or over.
        </p>
      </>
    ),
  });
}
