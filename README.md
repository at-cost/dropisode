# Reel

An open-source AI studio for short dramas and serialised vertical video. Write or paste a script, build a cast of characters, locations and props with reference images, get a storyboard, try every shot as a cheap draft, render the shots you approve on a premium model, and Reel assembles them into a finished episode.

You see the exact price on every generate button before you press it. Reel runs two ways:

- **Locally, free:** `npx reel-studio` with your own fal.ai key. You pay fal directly; Reel adds nothing.
- **Hosted (not launched yet):** prepaid credit at the provider's real price + 20%. No subscription, no expiring credits, no throttled "unlimited" plans. Failed generations the provider doesn't bill are refunded automatically, and the platform's real costs are published.

## Is it cheaper?

Not always, and we won't claim it is. At the provider's price + 20%, a heavy user on a bulk subscription can pay less per second, especially on Kling and Seedance. For a 54-episode, 90-second drama, Kling 3.0 on Higgsfield's Ultra plan comes to roughly a third of Reel's price for the final renders (see [docs/PRICING_NOTES.md](docs/PRICING_NOTES.md#compared-with-higgsfield), with sources).

What Reel does offer:

- the exact price before every shot, and a cost log of every try, with its model, provider, price and refund
- no subscription, no credits that expire, no slowdowns at busy times
- automatic refunds when the provider doesn't bill a failure
- cheap drafts (from about $0.03 a second) before premium finals, so bad tries cost little
- the whole studio running on your machine with your own key, free

## Run it locally

You need Node.js 22 or newer and a [fal.ai](https://fal.ai) key. ffmpeg is bundled (or uses yours if it can burn subtitles).

```sh
npx reel-studio
```

This opens the studio at http://localhost:4320. Paste your fal.ai key in Settings: it is saved in `~/.config/reel/config.json`, readable only by you, and never sent to the browser. Projects are plain folders in `~/Reel`.

- `npx reel-studio --mock` lets you try the whole workflow with placeholder clips: no key, no cost.
- Options: `--dir <folder>` for projects, `--port <n>`, `--no-open`, `--config <file>`.
- Local mode has no moderation layer of ours. fal.ai's and the model providers' own content filters still apply.

### A first episode in about 30 minutes

1. **New project.** Give it a name and an idea; vertical 9:16 is the default.
2. **Script.** Press "Write script" (the price is on the button). Reel writes the script and lists the cast. Or paste your own script.
3. **Cast.** Generate a reference image for each character and location, or upload your own photos (you must confirm you have consent from anyone real in them). The same descriptions and images go into every shot that features them, which is what keeps a character recognisable.
4. **Storyboard.** Press "Storyboard this scene" to break it into shot cards. Edit, reorder, split or merge them.
5. **Draft.** Press "Draft" on each card: a cheap first frame, then a short low-resolution clip.
6. **Approve and final.** Approve the shots you like and press "Final" to render them on a premium model.
7. **Episode.** Assemble the final episode: one MP4 with burned-in subtitles, plus every shot file, `subtitles.srt` and an edit list (`edit-list.edl`, `edit-list.json`) for finishing in another editor.

Projects export as a zip (`project.json` plus media) that opens in local or hosted Reel.

### The command-line spike

```sh
FAL_KEY=... pnpm spike "A courier finds a letter addressed to herself" --tier draft
pnpm spike "..." --provider mock
```

It goes from idea to script to a 6-shot, 30-second episode, and writes `cost-log.csv` with each request's fal request id, so you can check it against fal's dashboard.

## Prices

Every provider price lives in [`packages/core/config/prices.json`](packages/core/config/prices.json), each with a source URL and the date it was checked. Nothing in the code hard-codes a price. The models, prices, failure billing and limits we checked are in [docs/PRICING_NOTES.md](docs/PRICING_NOTES.md).

- **Generations (hosted):** the provider's actual cost × 1.2, settled per job. Before each job Reel holds the estimate; on success it charges the real cost and releases the rest. On a failure the provider didn't bill, it releases the whole hold and shows a refund line. A clip that renders but looks wrong is not a failure.
- **Daily charge (hosted):** (min($4, fixed costs ÷ active workspaces) + storage) × 1.2 ÷ days in the month. Only workspaces that generated something that month pay a share of fixed costs.
- When fal.ai can report a request's real cost (its Billing Events API, with a billing key), Reel settles at that. Otherwise it uses the published unit price × units and reconciles against fal's invoice monthly.

## What V1 doesn't do

- Providers other than fal.ai (MuAPI is planned as a second provider, routed per model to the cheaper one)
- Self-hosted or open-weight models on our own GPUs
- Lip sync, face swap, "AI influencer" or recast features
- Export to CapCut, Premiere or Jianying project files (the shot files and edit list are there instead)
- Publishing, paywalls or hosting finished dramas for viewers
- Real-time collaboration on the same storyboard
- A desktop app (local runs as a web UI in your browser)
- Free tiers, starter credit, trials or referral credit

## Repository

```
packages/core     the drama engine: projects, script, cast, storyboard, shots, generation
                  jobs, assembly, prompts, provider adapters (fal.ai), price estimates.
                  No accounts, no billing, no HTTP server. CI fails if it imports apps/*.
packages/money    the billing formula, holds, settlement and the price calculator
packages/studio   the studio API and web UI, shared by local and hosted
apps/local        core + the studio on your machine (npx reel-studio)
apps/hosted       accounts, workspaces, wallet, Stripe, refunds, moderation, public finances
```

Development:

```sh
pnpm install
pnpm --filter @reel/studio build     # the web UI
pnpm --filter reel-studio start -- --mock --dir ./projects
pnpm test                            # needs Postgres for apps/hosted (TEST_DATABASE_URL)
```

## Licence

MIT. Code taken from other projects is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
