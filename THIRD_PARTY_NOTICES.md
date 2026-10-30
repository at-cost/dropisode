# Third-party notices

## Code copied or adapted

| Source | Licence | What | Where |
|---|---|---|---|
| [at-cost/glasstrack](https://github.com/at-cost/glasstrack) (same team) | MIT, Copyright (c) 2026 at-cost and contributors | Money units and helpers (micro-USD, `distribute`, `dailyShare`, `daysInMonth`, `formatUsd`); the shape of the pricing formula, the email module and the Stripe gateway | `packages/money/src/units.ts`, `packages/money/src/billing.ts`, `apps/hosted/src/email.ts`, `apps/hosted/src/billing/gateway.ts`, `apps/hosted/src/auth/*` |

## Ideas, no code copied

These projects shaped the workflow. No code or prompt text was copied from them.

| Project | Licence | What we took |
|---|---|---|
| [HKUDS/ViMax](https://github.com/HKUDS/ViMax) | MIT | The character-consistency approach: the same fixed description and reference images go into every shot |
| [HBAI-Ltd/Toonflow-app](https://github.com/HBAI-Ltd/Toonflow-app) | MIT | Storyboard and cast-library flow; price before generate |
| [Anil-matcha/Open-Generative-AI](https://github.com/Anil-matcha/Open-Generative-AI) | MIT | The idea of camera presets per shot |
| [zenstory-ai/drama-skills](https://github.com/zenstory-ai/drama-skills) | MIT | Script and storyboard prompt structure |

Not used, by licence: huobao-drama (CC BY-NC-SA), BigBanana AI Director (non-commercial), ArcReel (AGPL-3.0, ideas only), Open-AI-Micro-Drama-Generator (no licence file).

## Runtime dependencies worth knowing about

- **ffmpeg-static** (npm package, GPL-3.0-or-later): installs a prebuilt ffmpeg binary (GPL build with libx264 and libass) on your machine. Dropisode calls it as a separate program and does not include or link ffmpeg's code. If you have your own ffmpeg with libass, Dropisode uses that instead.
- **@fal-ai/client** (MIT), **hono** (MIT), **zod** (MIT), **fflate** (MIT), **react** (MIT), **kysely** (MIT), **stripe** (MIT), **arctic** (MIT), **aws4fetch** (MIT), **nodemailer** (MIT-0), **pg** (MIT).
