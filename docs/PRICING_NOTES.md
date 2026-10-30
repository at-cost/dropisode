# Pricing and assumptions notes (Phase 0)

Checked on **2026-10-29**. Every figure has a source. "Verified" means the
value was read on the vendor's own page on that date. "Secondary" means a
third-party source. "Uncertain" means no page states it and the Phase 1 spike
must settle it. All prices are USD, excluding VAT, at fal list price (no
enterprise discount). The machine-readable list is
[`pricing-research.json`](pricing-research.json) (97 entries, one per price
variant).

## Verdict

**Nothing found blocks the V1 design** (fal-only provider, queue + webhooks,
per-job settlement, holds, refunds only when fal refunds).

- **fal does report the actual cost per request, but not in the response.**
  The generation result and the webhook payload carry no cost field. The cost
  comes from the Platform API **Billing Events** endpoint, filtered by
  `request_id`, which returns `cost_total` in USD per request (verified in
  docs). How soon a billing event appears after a request completes is not
  documented (uncertain).
- **Design consequence:** hold at the estimate (unit price x units), mark the
  job "completed, cost pending", then settle from Billing Events. If no event
  appears within a set time (say 15 minutes), settle at unit price x units and
  let the monthly reconciliation against fal's invoice (Usage API, FOCUS CSV)
  catch any difference. This is the brief's fallback, used as a backstop rather
  than the main path.
- **Seedance is token billed**, and fal says it uses "provider-reported usage
  when available". The real charge can differ from our estimate, so Billing
  Events matters most there.

Five things change the design slightly or must be proven in the Phase 1 spike.
None is a blocker:

1. **4xx failures can be billed.** fal never bills HTTP 500+ or queue time,
   but a 422 (bad input, or `content_policy_violation`) "may still be charged
   if a runner spent GPU time". Our pre-moderation must catch these before
   submit, and settlement must read Billing Events for failed jobs too, not
   assume a refund.
2. **Concurrency starts at 2.** New fal accounts run 2 requests at once,
   rising automatically with credit purchases to 40 (self-serve). Extra
   requests wait in the queue (not dropped, and queue time is free). A
   30-shot episode at concurrency 2 will be slow until we have bought credits.
3. **Webhooks need a public HTTPS URL.** fal drops deliveries to localhost and
   private IPs, and does not follow redirects. **Local mode must poll** (or use
   the status stream). Hosted mode uses webhooks.
4. **Results must be copied to R2 quickly.** fal CDN media lives "at least 7
   days" by default. A failed webhook is retried for only about 1 hour (about
   6 minutes for result bodies of 10 KB or more). The worker should fetch the
   result and copy media to R2 on the webhook, and poll any job still open
   after a few minutes.
5. **Terms to confirm with fal in writing** (see section 6): end users must be
   18+, we must not expose fal's API directly to end users, and fal's ToS has a
   no-resale clause next to an explicit allowance for "Customer Solutions".
   Reel is a Customer Solution, but an "at-cost resale" framing should be
   cleared with fal before launch.

Also worth knowing before choosing models: realistic human faces are
reportedly blocked as Seedance 2.0 inputs (secondary), Veo 3.1 only renders
4, 6 or 8 second clips, and several cheap models have no audio.

## 1. Video models on fal

All endpoints below are image-to-video unless the name says reference-to-video.
Prices are per second of output unless the unit says "video". Durations and
resolutions come from each endpoint's OpenAPI schema
(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>`), read today.
"From image" means there is no aspect parameter and the output follows the
first frame, so a 9:16 first frame gives 9:16 video.

### Kling (Kuaishou)

Kling 3.0 is on fal. So is a newer **Kling 4.0** (listed 2026-10-16).

| Endpoint | Variant | Price | Audio | Durations | Aspect | Source |
|---|---|---|---|---|---|---|
| `fal-ai/kling-video/v3/pro/image-to-video` | audio off / on / on + voice control | $0.112 / $0.168 / $0.196 per s | native, toggle `generate_audio` | 3 to 15 s | from image (0.4 to 2.5) | [page](https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video) (verified) |
| `fal-ai/kling-video/v3/standard/image-to-video` | audio off / on / voice | $0.084 / $0.126 / $0.154 per s | native | 3 to 15 s | from image | [page](https://fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video) (verified) |
| `fal-ai/kling-video/v3/turbo/pro/image-to-video` | 1080p | $0.14 per s | no audio parameter (uncertain) | 3 to 15 s | from image | [page](https://fal.ai/models/fal-ai/kling-video/v3/turbo/pro/image-to-video) (verified) |
| `fal-ai/kling-video/v3/turbo/standard/image-to-video` | | $0.112 per s | uncertain | 3 to 15 s | from image | [page](https://fal.ai/models/fal-ai/kling-video/v3/turbo/standard/image-to-video) (verified) |
| `fal-ai/kling-video/o3/pro/reference-to-video` | audio off / on | $0.112 / $0.14 per s | native, default off | 3 to 15 s | 16:9, 9:16, 1:1 | [page](https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video) (verified) |
| `fal-ai/kling-video/o3/standard/reference-to-video` | audio off / on | $0.084 / $0.112 per s | native | 3 to 15 s | 16:9, 9:16, 1:1 | [page](https://fal.ai/models/fal-ai/kling-video/o3/standard/reference-to-video) (verified) |
| `kling/v4/image-to-video` | 720p / 1080p | $0.157 / $0.235 per s | no audio parameter (uncertain) | 3 to 30 s | from image | [page](https://fal.ai/models/kling/v4/image-to-video) (verified) |
| `fal-ai/kling-video/v2.6/pro/image-to-video` | audio off / on / voice | $0.07 / $0.14 / $0.168 per s | native | 5, 10 s | from image | [page](https://fal.ai/models/fal-ai/kling-video/v2.6/pro/image-to-video) (verified) |
| `fal-ai/kling-video/v2.5-turbo/pro/image-to-video` | | $0.35 per 5 s + $0.07 per extra s | silent | 5, 10 s | from image | [page](https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video) (verified) |
| `fal-ai/kling-video/v2.5-turbo/standard/image-to-video` | | $0.21 per 5 s + $0.042 per extra s | silent | 5, 10 s | from image | [page](https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/standard/image-to-video) (verified) |

Kling 3.0 audio is native Chinese and English; other languages are
auto-translated to English (verified, same page). The O3 reference-to-video
endpoints take character reference images, which helps the "same character in
every shot" acceptance test.

### Seedance (ByteDance)

Seedance 2.0 and 2.5 are on fal under `bytedance/...` ids. All are **billed by
tokens**: tokens = height x width x duration x 24 / 1024. The per-second
figures are fal's own; audio is included at no extra cost either way.

| Endpoint | Variant | Price | Token rate | Durations | Aspect | Source |
|---|---|---|---|---|---|---|
| `bytedance/seedance-2.0/image-to-video` | 720p / 1080p | $0.3024 / $0.682 per s | $0.014 per 1k tokens | 4 to 15 s or auto | 9:16, 16:9, 1:1, 3:4, 4:3, 21:9, auto | [page](https://fal.ai/models/bytedance/seedance-2.0/image-to-video) (verified) |
| `bytedance/seedance-2.0/fast/image-to-video` | 720p (max) | $0.2419 per s | $0.0112 per 1k | 4 to 15 s | same | [page](https://fal.ai/models/bytedance/seedance-2.0/fast/image-to-video) (verified) |
| `bytedance/seedance-2.0/mini/image-to-video` | 480p / 720p | about $0.0721 / $0.1547 per s | $0.007 per 1k | 4 to 15 s | same | [page](https://fal.ai/models/bytedance/seedance-2.0/mini/image-to-video) (verified, "roughly") |
| `bytedance/seedance-2.0/reference-to-video` | 720p, no video refs | $0.3024 per s | $0.014 per 1k (0.6x with video refs) | 4 to 15 s | same | [page](https://fal.ai/models/bytedance/seedance-2.0/reference-to-video) (verified) |
| `bytedance/seedance-2.5/us/image-to-video` | 480p / 720p / 1080p | about $0.2205 / $0.473 / $1.164 per s | $0.0214 per 1k (1080p about $0.0234) | 4 to 30 s | string | [page](https://fal.ai/models/bytedance/seedance-2.5/us/image-to-video) (verified, "roughly") |
| `fal-ai/bytedance/seedance/v1.5/pro/image-to-video` | 720p with audio | about $0.26 per 5 s | $2.40 per 1M tokens with audio, $1.20 without | 4 to 12 s | same | [page](https://fal.ai/models/fal-ai/bytedance/seedance/v1.5/pro/image-to-video) (verified) |

Notes:
- The Seedance 2.0 page header says $0.3034/s; its own table and the token
  formula give $0.3024/s. We bill from Billing Events anyway.
- fal also lists `bytedance/seedance-2.0/us/...` variants at the same price.
  What "US" means (likely US-hosted serving) is not stated (uncertain).
- Seedance 1.0 Lite is deprecated on fal. 1.0 Pro and Pro Fast are still active.
- **Realistic human faces are reportedly blocked as Seedance 2.0 inputs**
  (upstream deepfake filter, with an asset-ingestion route for real faces).
  Sources: [apiyi docs](https://docs.apiyi.com/en/faq/seedance2-asset-face-reference),
  [Segmind error guide](https://blog.segmind.com/seedance-2-0-error-guide-every-error-explained-with-fixes/)
  (secondary). fal's pages do not mention it. A photoreal drama with
  generated faces as first frames could be rejected. Test in the spike.

### Veo 3.1 (Google)

All three tiers are on fal. Veo takes an explicit 9:16. **Durations are only
4, 6 or 8 seconds**, so 5-second shots are not possible on Veo.

| Endpoint | Variant | Audio off | Audio on | Source |
|---|---|---|---|---|
| `fal-ai/veo3.1/image-to-video` | 720p or 1080p | $0.20 per s | $0.40 per s | [page](https://fal.ai/models/fal-ai/veo3.1/image-to-video) (verified) |
| same | 4K | $0.40 per s | $0.60 per s | same |
| `fal-ai/veo3.1/fast/image-to-video` | 720p or 1080p | $0.10 per s | $0.15 per s | [page](https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video) (verified) |
| same | 4K | $0.30 per s | $0.35 per s | same |
| `fal-ai/veo3.1/lite/image-to-video` | 720p | $0.03 per s | $0.05 per s | [page](https://fal.ai/models/fal-ai/veo3.1/lite/image-to-video) (verified) |
| same | 1080p (max) | $0.05 per s | $0.08 per s | same |

Aspect `auto`, `16:9`, `9:16`; `generate_audio` defaults to true;
`safety_tolerance` 1 to 6. Older `fal-ai/veo3/...` endpoints are deprecated.

### MiniMax / Hailuo

| Endpoint | Variant | Price | Audio | Durations | Source |
|---|---|---|---|---|---|
| `fal-ai/minimax/hailuo-2.3/standard/image-to-video` | 768p | $0.28 per 6 s video, $0.56 per 10 s | silent | 6, 10 s | [page](https://fal.ai/models/fal-ai/minimax/hailuo-2.3/standard/image-to-video) (verified) |
| `fal-ai/minimax/hailuo-2.3/pro/image-to-video` | 1080p | $0.49 per video | silent | no parameter (length uncertain, likely 6 s) | [page](https://fal.ai/models/fal-ai/minimax/hailuo-2.3/pro/image-to-video) (verified) |
| `fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video` | | $0.19 per 6 s, $0.32 per 10 s | silent | 6, 10 s | [page](https://fal.ai/models/fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video) (verified) |
| `fal-ai/minimax/hailuo-02/standard/image-to-video` | 768p / 512p | $0.045 / about $0.017 per s | silent | 6, 10 s | [page](https://fal.ai/models/fal-ai/minimax/hailuo-02/standard/image-to-video) (verified) |
| `fal-ai/minimax/hailuo-02/pro/image-to-video` | 1080p | $0.08 per s | silent | fixed | [page](https://fal.ai/models/fal-ai/minimax/hailuo-02/pro/image-to-video) (verified) |
| `minimax/h3/image-to-video` | 480p / 768p / 2K / 4K | $0.05 / $0.06 / $0.13 / $0.16 per s | soundtrack (dialogue uncertain) | 5 to 15 s | [page](https://fal.ai/models/minimax/h3/image-to-video) (verified) |
| `minimax/h3-max/image-to-video` | 480p / 768p / 1080p | $0.05 / $0.08 / $0.16 per s after Oct 31 | soundtrack | 0.92 to 15 s | [page](https://fal.ai/models/minimax/h3-max/image-to-video) (verified) |
| `minimax/h3-max-turbo/image-to-video` | 480p / 768p / 1080p | $0.025 / $0.04 / $0.08 per s after Oct 31 | soundtrack | 0.92 to 15 s | [page](https://fal.ai/models/minimax/h3-max-turbo/image-to-video) (verified) |

H3 Max and H3 Max Turbo are on a 35% promotion that ends October 31. The
config uses the post-promo list price. Hailuo aspect follows the first frame.
`minimax/h3/reference-to-video` exists with explicit 9:16 and charges $0.08
per reference image beyond the first 5.

### Wan (Alibaba)

| Endpoint | Variant | Price | Audio | Durations | Aspect | Source |
|---|---|---|---|---|---|---|
| `alibaba/wan-3.0/image-to-video` | 480p / 720p / 1080p | $0.05 / $0.10 / $0.20 per s | `audio` toggle, no separate price (uncertain) | null = model picks | 9:16, 16:9, 1:1, 3:4, 4:3, adaptive | [page](https://fal.ai/models/alibaba/wan-3.0/image-to-video) (verified) |
| `alibaba/wan-3.0-prime/image-to-video` | 480p / 720p / 1080p | $0.068 / $0.14 / $0.28 per s | same | same | same | [page](https://fal.ai/models/alibaba/wan-3.0-prime/image-to-video) (verified) |
| `fal-ai/wan/v2.7/image-to-video` | 720p / 1080p | $0.10 / $0.15 per s | bring your own (`audio_url`) | 2 to 15 s | from image | [page](https://fal.ai/models/fal-ai/wan/v2.7/image-to-video) (verified) |
| `wan/v2.6/image-to-video` | 720p / 1080p | $0.10 / $0.15 per s | bring your own | 5, 10, 15 s | from image | [page](https://fal.ai/models/wan/v2.6/image-to-video) (verified) |
| `wan/v2.6/image-to-video/flash` | 720p / 1080p | $0.05 / $0.075 per s | `generate_audio`, same price | 5, 10, 15 s | from image | [page](https://fal.ai/models/wan/v2.6/image-to-video/flash) (verified) |
| `fal-ai/wan-25-preview/image-to-video` | 480p / 720p / 1080p | $0.05 / $0.10 / $0.15 per s | bring your own | 5, 10 s | from image | [page](https://fal.ai/models/fal-ai/wan-25-preview/image-to-video) (verified) |

Wan 3.0 pages say "pricing is subject to change".

### Draft tier vs final tier (suggestion)

The brief puts tiers in config. Suggested defaults:

| Tier | Models | Why |
|---|---|---|
| Draft | Veo 3.1 Lite 720p ($0.03 to $0.05/s), MiniMax H3 Max Turbo 480p ($0.025/s), Seedance 2.0 Mini 480p (about $0.072/s), Kling 3.0 Standard audio off ($0.084/s), Wan 2.6 Flash 720p ($0.05/s), Hailuo 02 512p (about $0.017/s, silent) | Cheap, fast |
| Final | Kling 3.0 Pro audio ($0.168/s), Kling O3 Pro reference ($0.14/s), Seedance 2.0 720p ($0.3024/s), Veo 3.1 Fast audio ($0.15/s), Veo 3.1 audio ($0.40/s), MiniMax H3 Max 1080p ($0.16/s), Wan 3.0 1080p ($0.20/s), Kling 4.0 1080p ($0.235/s) | Quality, native audio |

**Draft in the same family as the final** where possible (Kling 3.0 Standard
to Pro, Seedance Mini to 2.0, Veo Lite to Fast, H3 Max Turbo to H3 Max, Wan
3.0 480p to 1080p). A draft on one model says little about how another model
will animate the same frame and prompt.

## 2. Image models (cast references and first frames)

All accept reference images and take an explicit 9:16 (or a portrait size).

| Endpoint | Price | Notes | Source |
|---|---|---|---|
| `fal-ai/nano-banana-2/edit` | $0.08 per image at 1K; 0.5K x0.75, 2K x1.5, 4K x2 | Web search +$0.015, high thinking +$0.002 | [page](https://fal.ai/models/fal-ai/nano-banana-2/edit) (verified) |
| `google/nano-banana-2.1/edit` | token billed; fal's table: 1K edit with two inputs $0.044, 2K $0.063 | Input $1.764/M, output image $35.294/M tokens; each extra input image about $0.002 | [page](https://fal.ai/models/google/nano-banana-2.1/edit) (verified) |
| `fal-ai/nano-banana-pro/edit` | $0.15 per image (4K x2) | Best consistency, highest price | [page](https://fal.ai/models/fal-ai/nano-banana-pro/edit) (verified) |
| `bytedance/seedream/v5/lite/edit` | $0.035 per image | Up to 10 refs. Price is in the page body table, not a price sentence | [page](https://fal.ai/models/bytedance/seedream/v5/lite/edit) (verified) |
| `fal-ai/bytedance/seedream/v4.5/edit` | $0.04 per edit | Up to 10 refs | [page](https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/edit) (verified) |
| `fal-ai/flux-pro/kontext` | $0.04 per image | One ref (multi variant exists) | [page](https://fal.ai/models/fal-ai/flux-pro/kontext) (verified) |
| `alibaba/qwen-image-3/edit` | $0.04 at 1K, $0.075 at 2K | | [page](https://fal.ai/models/alibaba/qwen-image-3/edit) (verified) |

Suggestion: **Nano Banana 2.1 edit** for cast reference sheets (multi-image
consistency) and **Seedream 4.5 or 5.0 Lite edit** for first frames (flat
$0.035 to $0.04). The cost model below uses $0.04 per first frame.

## 3. Text to speech on fal

Most final-tier video models make their own audio, so TTS is for voice-over or
models without audio.

| Endpoint | Price | Source |
|---|---|---|
| `fal-ai/minimax/speech-2.8-hd` | $0.10 per 1,000 characters | [page](https://fal.ai/models/fal-ai/minimax/speech-2.8-hd) (verified) |
| `fal-ai/minimax/speech-2.8-turbo` | $0.06 per 1,000 characters | [page](https://fal.ai/models/fal-ai/minimax/speech-2.8-turbo) (verified) |
| `elevenlabs/tts/eleven-v4` | $0.08 per 1,000 characters | [page](https://fal.ai/models/elevenlabs/tts/eleven-v4) (verified) |
| `elevenlabs/tts/eleven-v4-turbo` | $0.04 per 1,000 characters | [page](https://fal.ai/models/elevenlabs/tts/eleven-v4-turbo) (verified) |
| `fal-ai/elevenlabs/tts/eleven-v3` | $0.10 per 1,000 characters | [page](https://fal.ai/models/fal-ai/elevenlabs/tts/eleven-v3) (verified) |

A 90-second episode has roughly 1,200 to 1,500 characters of dialogue, so
voice for all 54 episodes is about $4 to $8 on any of these.

## 4. Does fal report the cost of each request?

| Question | Answer | Source |
|---|---|---|
| Cost in the result body? | **No.** Output schemas hold `video`, `seed`, etc. Exception: the OpenRouter LLM endpoint returns `usage.cost` | OpenAPI schemas read today (verified); [router page](https://fal.ai/models/openrouter/router) (verified) |
| Cost in response headers? | Not documented | uncertain, check in spike |
| Cost in the webhook payload? | **No.** Payload is `request_id`, `gateway_request_id`, `status` (`OK`/`ERROR`), `payload`, optional `error` / `payload_error` | [webhooks](https://fal.ai/docs/documentation/model-apis/inference/webhooks.md) (verified) |
| Per-request billing API? | **Yes.** `GET https://api.fal.ai/v1/models/billing-events?request_id=<id>` (1 to 50 ids, comma separated). Each record: `request_id`, timestamp, endpoint, `quantity`, `unit`, `unit_price`, `cost_subtotal`, `cost_discount`, `cost_total` (USD), `cost_estimate_nano_usd`. Up to 10,000 rows per page, 90-day window. Key needs `billing:usage:read`, `auth:keys:read`, `account:users:read` (preset `BILLING`) | [billing events](https://fal.ai/docs/platform-apis/v1/models/billing-events.md) (verified) |
| Delay before an event appears | Not documented ("tagged" feed is delayed relative to default) | uncertain, measure in spike |
| Tagging | `X-Fal-Tags` request header, then `source=tagged-billed&tag=key=value`. Could tag workspace and job ids. Needs tagged reporting enabled on the account | same (verified) |
| Aggregate usage | `GET /v1/models/usage` (line items with quantity, unit price, discount, total) | [usage](https://fal.ai/docs/platform-apis/v1/models/usage.md) (verified) |
| Invoice reconciliation | `GET /v1/account/billing`, FOCUS CSV report | [llms index](https://fal.ai/docs/llms.txt) (verified) |
| Unit prices by API | `GET /v1/models/pricing?endpoint_id=...` returns `unit_price`, `unit`, `currency`; `/v1/models/pricing/estimate` computes estimates. Needs a key | [pricing doc](https://fal.ai/docs/documentation/model-apis/pricing.md) (verified) |

**Plan:** estimate and hold with `/models/pricing` (or our config), settle
with Billing Events by `request_id`, reconcile monthly with Usage / FOCUS.
Fallback if Billing Events lags or is missing: unit price x units, flagged as
"estimated" in the cost log until reconciliation.

### Failure billing

| Case | Billed? | Source |
|---|---|---|
| HTTP 500 or higher (server error) | Never | [pricing doc](https://fal.ai/docs/documentation/model-apis/pricing.md), [FAQ](https://fal.ai/docs/documentation/model-apis/faq.md) (verified) |
| Time waiting in the queue, cold starts | Never | same (verified) |
| Runner failure (503, 504, connection error) | Re-queued and retried automatically up to 10 times | [queue doc](https://fal.ai/docs/documentation/model-apis/inference/queue.md) (verified) |
| 422 invalid input | **May be charged** if a runner spent GPU time first | FAQ (verified) |
| 422 `content_policy_violation` | Non-retryable 422. Same rule as above, so may be charged | FAQ, [errors](https://fal.ai/docs/documentation/model-apis/errors.md) (verified); actual behaviour per model uncertain |
| Output that renders but looks wrong | Charged (successful output) | pricing doc (verified) |
| `start_timeout` expires before a runner starts | 504 with `X-Fal-Request-Timeout-Type: user`; no inference ran, so no charge expected | [common parameters](https://fal.ai/docs/documentation/model-apis/common-parameters.md) (verified), charge uncertain |

This matches owner decision 5: we pass on a refund only when Billing Events
shows no charge (or a later credit).

## 5. Queue, webhooks, limits, retention

| Item | Value | Source |
|---|---|---|
| Submit | `POST https://queue.fal.run/<endpoint_id>` (paths with more than two segments use the same URL form). Optional `?fal_webhook=<url>` | [queue](https://fal.ai/docs/documentation/model-apis/inference/queue.md), [webhooks](https://fal.ai/docs/documentation/model-apis/inference/webhooks.md) (verified) |
| Submit response | `request_id`, `response_url`, `status_url`, `cancel_url` | queue (verified) |
| Status | `GET .../requests/{id}/status` (`?logs=1`); states `IN_QUEUE` (with position), `IN_PROGRESS`, `COMPLETED`. SSE stream at `.../status/stream`, keepalive every 15 s | queue (verified) |
| Result | `GET .../requests/{id}`; returns the model's status code and body, errors included | [result ref](https://fal.ai/docs/api-reference/inference-api/queue/result.md) (verified) |
| Cancel | `PUT .../requests/{id}/cancel`; in-progress jobs get a cancel signal, model decides | [cancel ref](https://fal.ai/docs/api-reference/inference-api/queue/cancel.md) (verified) |
| Queue size | No limit unless `fal_max_queue_length` is sent. Never dropped, except when `start_timeout` expires | queue, [concurrency](https://fal.ai/docs/documentation/model-apis/concurrency-limits.md) (verified) |
| Concurrency | 2 for a new account; rises with paid invoices of the last 4 weeks, up to 40 self-serve; more via sales. Counted only while `IN_PROGRESS`. fal may add per-endpoint limits on busy models | concurrency (verified) |
| Webhook delivery | POST to your URL; 2xx acknowledges. First try 15 s timeout, retries 120 s timeout, up to 31 retries with backoff until the stored result expires (about 1 hour, about 6 minutes for results of 10 KB or more). 3xx is a permanent failure. Localhost / private IPs dropped. Handler must be idempotent | webhooks (verified) |
| Webhook signature | ED25519. Keys from JWKS `https://rest.fal.ai/.well-known/jwks.json` (cache up to 24 h). Headers `X-Fal-Webhook-Request-Id`, `-User-Id`, `-Timestamp`, `-Signature` (hex). Message = request id, user id, timestamp, hex SHA-256 of raw body, joined by `\n`. Reject if timestamp is more than 300 s off | webhooks (verified) |
| Webhook source IPs | `GET https://api.fal.ai/v1/meta` returns `webhook_ip_ranges` (15 /32s today; may change) | webhooks (verified) |
| Output media URLs | Public by default, `https://v3b.fal.media/...`; stored "at least 7 days by default". Per request: header `X-Fal-Object-Lifecycle-Preference: {"expiration_duration_seconds": N, "initial_acl": ...}`; account default via storage settings API. Expired files are deleted for good | [FAQ](https://fal.ai/docs/documentation/model-apis/faq.md), [media expiration](https://fal.ai/docs/documentation/model-apis/media-expiration.md) (verified) |
| Request payloads (inputs and outputs) | Kept 90 days in request history; `X-Fal-Store-IO: 0` turns that off per request. Delete API exists for payloads and CDN files | [common parameters](https://fal.ai/docs/documentation/model-apis/common-parameters.md) (verified) |
| Input files | Must be publicly reachable or a short-lived signed URL (private auth URLs do not work). Our signed R2 URLs are fine | [fal CDN](https://fal.ai/docs/documentation/model-apis/fal-cdn.md) (verified) |
| Credits | Prepaid. Purchased credits expire after 365 days. Account locks below a threshold | FAQ (verified) |

Recommendations for the worker: send `X-Fal-Store-IO: 0` and a short CDN
lifecycle (for example 2 days) on every request, since R2 is the store of
record. Tag requests with `X-Fal-Tags` if tagged reporting can be enabled.

## 6. Terms and acceptable use

### fal

| Point | Detail | Source |
|---|---|---|
| Age | Users must be 18+; a Customer with a Customer Solution must ensure its End Users are 18+ | [ToS](https://fal.ai/legal/terms-of-service), last updated 2026-09-08 (verified) |
| Platforms are allowed | Customer may "allow End Users to access and use the Services through the Customer Solution" | ToS s.4, [API Services terms](https://fal.ai/legal/api-services) (verified) |
| No direct exposure | "Client will not expose any of the Services APIs directly to any End Users." Hosted Reel must proxy all calls; never hand our key or raw fal URLs for submission to the browser | same (verified) |
| No resale | ToS forbids to "resell ... or use the Services on a timesharing, service bureau, or similar arrangement ... or to provide the Services for the benefit of any third party" | ToS (verified). How this squares with the Customer Solution allowance is a legal reading; **confirm with fal in writing** |
| End-user terms | Must have enforceable end-user terms "as protective" as fal's; we are liable for end users' acts | API Services terms (verified) |
| AUP | Bans CSAM, NCII ("likeness of an individual in a sexual or pornographic manner without their consent"), "identity theft, impersonation, or deepfakes, including using another person's name, image, voice, or other likeness without their consent", processing biometric data, privacy and publicity violations | [AUP](https://fal.ai/legal/acceptable-use-policy) (verified) |
| Platform duties | Team admins must report CSAM, apply legally required age-gating, cooperate with enforcement | AUP s.9 (verified) |
| Third-party models | Content goes to the model provider when a model runs via a partner API; some models are "Pending Enterprise Ready" and excluded from fal's security obligations and DPA | API Services terms (verified) |
| Commercial use | Per model; most have a "Commercial use" badge. Model search shows `license_type: commercial` for the Kling 4.0 endpoint | [FAQ](https://fal.ai/docs/documentation/model-apis/faq.md) (verified); check each chosen model |

### Model providers

| Provider | Point | Source |
|---|---|---|
| Google (Veo, Nano Banana / Gemini image) | Gemini API: must be 18+, and not used in an app "directed towards or likely to be accessed by individuals under the age of 18" | [Gemini API terms](https://ai.google.dev/gemini-api/terms) (verified) |
| Google | Prohibited Use Policy (2024-12-17): no CSAM, no NCII, no sexually explicit content, no "impersonating an individual (living or dead) without explicit disclosure, in order to deceive", no "misrepresenting the provenance of generated content by claiming it was created solely by a human" | [policy](https://policies.google.com/terms/generative-ai/use-policy) (verified) |
| Kling | User policy (2026-04-21): bans sexually explicit, obscene, pornographic content and privacy/portrait-rights violations; requires proof of consent for inputs on request; s.4.5 asks users to "prominently indicate that the Output is generated by Kling AI". Whether this consumer policy binds use via fal is unclear | [Kling user policy](https://kling.ai/docs/user-policy) (verified via fetch summary) |
| ByteDance (Seedance) | No official policy page found. Reported upstream block on realistic human faces as inputs | secondary (see section 1) |
| MiniMax | Unified Terms of Service updated 2026-04-15; the API ("Open Platform") terms text was not readable | [MiniMax ToS](https://www.minimax.io/terms-of-service-v2.html) (uncertain) |

Implications for V1 (already in the brief, now confirmed by sources): 18+
only with an age confirmation at sign-up, a consent confirmation for real
people's photos, a public-figure name block, "AI-generated" disclosure on
outputs, and consider a "Made with Kling" credit on Kling shots until fal
confirms it is not needed.

## 7. Storage, moderation, LLM

### Cloudflare R2

| Item | Standard | Infrequent Access | Source |
|---|---|---|---|
| Storage | $0.015 per GB-month | $0.01 per GB-month (30-day minimum) | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) (verified) |
| Class A ops (writes, lists) | $4.50 per million | $9.00 per million | same |
| Class B ops (reads) | $0.36 per million | $0.90 per million | same |
| Egress | Free | Free (retrieval $0.01 per GB) | same |
| Free tier per month | 10 GB-month, 1M Class A, 10M Class B (Standard only) | none | same |

Billing rounds up (1.1 GB-month bills as 2). Deletes are free. Rough size of
the 54-episode drama with 4 tries per shot at about 8 MB per 5-second clip
plus finished episodes: about 40 GB, or about $0.60 a month (assumption, not
measured).

### Moderation

| Item | Value | Source |
|---|---|---|
| OpenAI `omni-moderation-latest` | **Free**. Text and images (up to 20 MB). No audio | [moderation guide](https://developers.openai.com/api/docs/guides/moderation) (verified) |
| Image categories | `sexual`, `violence`, `violence/graphic`, `self-harm` (+ intent, instructions) | same (verified) |
| Text-only categories | `harassment`, `hate`, `illicit` (and sub-categories), **`sexual/minors`** | same (verified) |

**Gap:** `sexual/minors` does not work on images (images alone score 0 on
it), and nothing here detects real people or public figures. The brief's
"block sexual content involving minors" check on uploads and output frames
needs a second signal (for example an age-estimation classifier combined
with the `sexual` image score). This is an owner decision because it may add
a cost line to `fixed_monthly`. fal also has its own safety checker on many
endpoints (`enable_safety_checker`, `safety_tolerance`).

### LLM for script and storyboard (owner decision; options only)

OpenRouter direct list prices, read from the public
[OpenRouter models API](https://openrouter.ai/api/v1/models) today (verified).
OpenAI's own page shows the same GPT-5 mini and GPT-5.4 mini prices
([OpenAI pricing](https://developers.openai.com/api/docs/pricing)).
Cost per drama assumes 30,000 input and 10,000 output tokens per episode
(script, shot list, prompts) x 54 episodes (assumption).

| Model | Input per 1M | Output per 1M | 54-episode drama |
|---|---|---|---|
| DeepSeek V4.1 Flash | $0.045 | $0.50 | $0.34 |
| Claude Haiku 5.5 | $0.10 | $0.50 | $0.43 |
| Gemini 3.1 Flash Lite | $0.25 | $1.50 | $1.22 |
| GPT-5 mini | $0.25 | $2.00 | $1.49 |
| Gemini 3.8 Flash | $0.825 | $4.125 | $3.56 |
| GPT-5.4 mini | $0.75 | $4.50 | $3.65 |

Routes:
- **Via fal** (`openrouter/router`, or the OpenAI-compatible
  `openrouter/router/openai/v1/chat/completions`): one provider, one bill, and
  the response carries `usage.cost`. Whether fal adds anything on top of
  OpenRouter's price is not stated (uncertain).
- **OpenRouter direct**: same models, second account and key.
- **Direct provider**: lowest risk of markup, one more integration.

Recommendation for the owner: route through fal's OpenRouter endpoint (keeps
V1 fal-only and gives a real per-request cost), default to a mid-price model
such as Gemini 3.8 Flash or GPT-5 mini for writing quality, and let creators
pick. The LLM is under 1% of a drama's cost on every option, so quality
should decide, not price.

## 8. What a 54-episode drama costs

Scenario: 54 episodes x 90 s = **4,860 s** of final video = **972 shots of
5 s**. First frames at $0.04 each (Seedream 4.5 edit). LLM and TTS excluded
(a few dollars, see above). Storage excluded (under $1 a month). "x1.2" is
Reel's markup. All unit prices come from `pricing-research.json`.

- **Final only** = 972 shots x 1 try + 1 first frame per shot.
- **Draft then final** = per shot, 3 drafts on **Veo 3.1 Lite 720p with
  audio** ($0.05/s) + 1 final on the named model + 4 first frames. Drafts add
  $729 and frames $156 to every row.

| Final model | $/s | Final only (fal) | x1.2 | Draft then final (fal) | x1.2 |
|---|---|---|---|---|---|
| MiniMax H3 768p | 0.06 | $330 | $397 | $1,176 | $1,411 |
| Veo 3.1 Lite 1080p, audio | 0.08 | $428 | $513 | $1,273 | $1,528 |
| Hailuo 2.3 Pro (silent, per 6 s video) | 0.0817 | $436 | $523 | $1,281 | $1,538 |
| Wan 3.0 720p | 0.10 | $525 | $630 | $1,371 | $1,645 |
| Kling 3.0 Standard, audio | 0.126 | $651 | $781 | $1,497 | $1,796 |
| Kling O3 Pro reference, audio | 0.14 | $719 | $863 | $1,565 | $1,878 |
| Veo 3.1 Fast, audio | 0.15 | $768 | $921 | $1,614 | $1,936 |
| Wan 2.6 1080p | 0.15 | $768 | $921 | $1,614 | $1,936 |
| Kling 4.0 720p | 0.157 | $802 | $962 | $1,648 | $1,977 |
| MiniMax H3 Max 1080p | 0.16 | $816 | $980 | $1,662 | $1,995 |
| Kling 3.0 Pro, audio | 0.168 | $855 | $1,026 | $1,701 | $2,041 |
| Wan 3.0 1080p | 0.20 | $1,011 | $1,213 | $1,857 | $2,228 |
| Kling 4.0 1080p | 0.235 | $1,181 | $1,417 | $2,027 | $2,432 |
| Seedance 2.0 Fast 720p | 0.2419 | $1,215 | $1,457 | $2,060 | $2,472 |
| Seedance 2.0 720p | 0.3024 | $1,509 | $1,810 | $2,354 | $2,825 |
| Veo 3.1, audio | 0.40 | $1,983 | $2,379 | $2,829 | $3,394 |
| Seedance 2.5 (US) 720p | 0.473 | $2,338 | $2,805 | $3,183 | $3,820 |
| Seedance 2.0 1080p | 0.682 | $3,353 | $4,024 | $4,199 | $5,039 |

Same-family drafts (3 drafts on the cheaper sibling + 1 final + 4 frames):

| Draft to final | fal | x1.2 |
|---|---|---|
| H3 Max Turbo 480p to H3 Max 1080p | $1,298 | $1,557 |
| Veo 3.1 Lite 720p audio to Veo 3.1 Fast audio | $1,614 | $1,936 |
| Wan 3.0 480p to Wan 3.0 1080p | $1,857 | $2,228 |
| Kling 3.0 Standard (audio off) to Kling 3.0 Pro audio | $2,197 | $2,636 |
| Seedance 2.0 Mini 480p to Seedance 2.0 720p | $2,676 | $3,212 |

Caveats: Veo cannot render 5 s clips (4, 6 or 8 s only), so a Veo shot list
would use 4 s or 6 s shots; 6 s shots for the same 4,860 s mean 810 shots and
fewer frames, but drafts of 6 s cost 20% more each. Hailuo is priced per
video. Seedance real charges follow provider-reported tokens. H3 prices are
post-promo list.

### Compared with Higgsfield

Plans read on [higgsfield.ai/pricing](https://higgsfield.ai/pricing) today
(verified; the page renders with JavaScript). A 30% promotion is running.

| Plan | Monthly | Annual (per month) | Credits per month | $ per credit (monthly / annual) |
|---|---|---|---|---|
| Starter | $19 | $19 | 270 | $0.070 |
| Plus | $59 | $47 | 1,200 | $0.049 / $0.039 |
| Ultra | $129 | $99 | 3,000 (6,000 and 9,000 options shown, prices not captured) | $0.043 / $0.033 |
| Teams | from $65 per seat | | from 1,000 per seat | |

Plus and Ultra include "7-day unlimited" Kling 3.0 and Nano Banana 2 (Ultra
also Nano Banana Pro), only on higgsfield.ai, with "dynamic speed
adjustments" at busy times. Credit costs from the same page (all marked "~"):
Kling 3.0 720p ~7 credits per 5 s, 1080p ~8; Seedance 2.0 720p ~22 per 5 s,
1080p ~60, Fast 720p ~12; Veo 3.1 Fast ~16 per 4 s; Veo 3.1 ~40 per 4 s;
Wan 3.0 1080p 17.5 per 5 s; Hailuo 2.3 1080p ~10 per 6 s; Nano Banana Pro 2
per image. The page does not say whether these include audio (uncertain).

Same 4,860 s, one Nano Banana Pro frame per try, priced at Ultra's per-credit
rate (this assumes every credit bought gets used):

| Model | Higgsfield final only (Ultra monthly / annual) | Reel final only (x1.2) | Higgsfield 4 tries per shot (Ultra monthly) | Reel draft then final (x1.2) |
|---|---|---|---|---|
| Kling 3.0 720p / Pro | $376 / $289 | $1,026 (Pro, audio) | $1,505 | $2,041 (Veo Lite drafts), $2,636 (Kling Std drafts) |
| Seedance 2.0 720p | $1,003 / $770 | $1,810 | $4,012 | $2,825 |
| Seedance 2.0 Fast 720p | $585 / $449 | $1,457 | $2,341 | $2,472 |
| Veo 3.1 Fast | $920 / $706 | $921 | $3,678 | $1,936 |
| Veo 3.1 | $2,173 / $1,668 | $2,379 | $8,694 | $3,394 |
| Wan 3.0 1080p | $815 / $625 | $1,213 | $3,260 | $2,228 |
| Hailuo 2.3 1080p | $432 / $331 | $523 (Pro) | $1,728 | $1,538 |

Honest reading:
- **Higgsfield is cheaper per final second on most models**, often by a lot.
  Kling 3.0 on Higgsfield is about a third of Reel's price, and its 7-day
  unlimited Kling 3.0 window can make Kling drafts nearly free for a week.
  For a creator who uses all their credits each month on Kling or Seedance, a
  subscription wins.
- Reel is about even on Veo 3.1 Fast and Veo 3.1, and wins only where
  Higgsfield has no cheap tier: drafting on Veo 3.1 Lite or MiniMax H3 Max
  Turbo, which Higgsfield does not list. That is why Reel's draft then final
  beats Higgsfield's "4 tries on the same model" for Veo, Seedance 2.0 and
  Wan, but not for Kling.
- Reel's case is no subscription, no unused credits, no expiry at month end,
  no "unlimited" speed throttling, each job's real cost shown, and an
  exportable local studio with the creator's own key. Price per second is not
  the case for Kling or Seedance, and the README must say so.

## Choosing the default models (added 2026-10-30)

Defaults are chosen on the price/quality frontier, after dropping models that fail drama needs (9:16, shot-length durations, dialogue, realistic faces). Quality is Artificial Analysis's image-to-video arena, with audio ([leaderboard](https://artificialanalysis.ai/video/leaderboard/image-to-video), read 2026-10-30). Elo is human preference votes; a 7-point gap is close to a coin flip. Prices are Reel's fal prices (section 1), with audio where the model has it.

| Model | Arena Elo | fal $/s | Example episode on Reel* |
|---|---|---|---|
| Seedance 2.5 | 1152 | 0.473 | not in the catalog |
| Seedance 2.0 (720p) | 1135 | 0.3024 | $73.69 |
| **MiniMax H3 (768p)** | 1128 | 0.06 | **$30.06** |
| MiniMax H3 Max (1080p) | 1115 | 0.16 | $48.06 |
| Wan 3.0 (1080p) | 1111 | 0.20 | $55.26 |
| Kling 3.0 Pro | 1000 | 0.168 | $49.50 |
| Veo 3.1 Fast | 934 | 0.15 | $51.66 |
| Veo 3.1 Lite | 928 | 0.05 | draft only |

*30 shots of 5 s, 3 drafts on the default draft model + 1 final, first frames included, × 1.2.

The frontier runs MiniMax H3 → Seedance 2.0 → Seedance 2.5. Kling 3.0 Pro and both Veo models sit well below it. HeyGen Video 1 (Elo 1119, about $0.04/s on HeyGen's own API) may also sit on it; not checked on fal.

**Provisional defaults:** drafts on MiniMax H3 Max Turbo 480p ($0.025/s), finals on MiniMax H3 768p. Same family, so an approved draft predicts the final (the earlier Veo-draft, Kling-final pairing broke that rule). The 1,000-shot drama in section 8 drops to roughly $360 final-only on Reel.

**What the spike must check before these stay:**
- **Dialogue.** fal describes H3's audio as a soundtrack, so Reel treats it as silent and voices lines with text-to-speech, laid over the clip without lip sync. H3 also takes `target_audio_url` (a clip to build the soundtrack around). Generating the TTS line first and passing it in may give lip-synced dialogue: test it.
- **Faces and consistency** across six shots of one character.
- **Fallback:** Seedance 2.0 as the final if H3 can't carry dialogue, provided realistic faces pass its input filter.

The Elo scores are stored next to each price in `packages/core/config/prices.json` (`quality`, with source and date).

## 9. Open decisions for the owner

1. **Default models.** Suggested: drafts on Veo 3.1 Lite 720p or H3 Max Turbo
   480p; finals on Kling 3.0 Pro (audio) or Kling O3 Pro reference-to-video for
   character consistency, Veo 3.1 Fast as the 9:16-native alternative.
   Seedance 2.0 only after the spike shows its face filter accepts our frames.
2. **LLM** (route and model, creator choice). See section 7.
3. **Minor-safety check on images.** OpenAI moderation cannot flag minors in
   images. Choose an extra classifier and its cost.
4. **Ask fal in writing** about (a) the resale clause versus an at-cost
   Customer Solution, (b) Billing Events delay, (c) whether a
   `content_policy_violation` is billed, (d) whether the Kling "generated by
   Kling AI" label applies via fal, (e) a concurrency raise before launch.
5. **Kling 4.0** is new (2026-10-16) and pricier; include it at launch or wait.
6. **Prepay to raise concurrency.** Concurrency follows the last 4 weeks of
   paid invoices; a launch needs a credit purchase (spends money, so owner
   approval).

## 10. To prove in the Phase 1 spike

- Billing Events returns each test request's `cost_total`, and how long it
  takes to appear. Compare with the dashboard to the cent.
- Response headers on a completed request: is there any cost or units header?
- A forced 422 and a forced content-policy rejection: billed or not.
- Seedance 2.0 with a generated photoreal first frame: accepted or rejected.
- Whether Kling 4.0, Kling 3.0 Turbo, MiniMax H3 and Wan 3.0 outputs carry
  audio, and whether H3 does dialogue.
- Hailuo 2.3 Pro output length.
- Webhook signature verification against the live JWKS.
