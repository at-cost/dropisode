# Hardening (Phase 7)

What was tested, how, and what is known not to be covered. Run the suites with `pnpm test` (hosted needs Postgres at `TEST_DATABASE_URL`).

## Workspace isolation

`apps/hosted/test/isolation.test.ts`

- Every query in `apps/hosted/src/stores.ts` filters by the workspace the request acts in. A project, media file, job or export from another workspace is "not found", never "forbidden", so ids don't leak.
- Tested through the HTTP API: workspace B gets 403/404 for A's project, estimates, export zip, exports list, media, edits, deletes, cast generation and new cast members. B's project list, ledger and balance stay empty.
- Tested at the store level with A's real ids: get, mutate, signed media URL, put media, get job, update job and list unfinished jobs all refuse.
- Media URLs are signed and short-lived (5 minutes by default, `MEDIA_URL_TTL`). A changed key or an expired link gets 403. Signing only happens after the workspace check. Storage keys always start with `ws/<workspace id>/`.
- Signed out, the studio API answers 401. Cross-site writes get 403.
- fal webhooks must carry an HMAC of the job id that only the server can make. Even a valid webhook only makes the server ask fal about the job with its own key, so a replayed or forged body can't change an outcome.

## Money under crashes

`apps/hosted/test/isolation.test.ts` ("crash safety"), `packages/core/test/pipeline.test.ts` ("crash safety", "critic regressions", "reopen races")

- A job record and a pending cost line are written before anything is sent to fal. The hold is placed in the same step, inside a transaction that locks the workspace row.
- The worker was killed inside settlement (a provider `finalize` that throws). The hold stayed in place, the balance didn't move, and the next worker settled the job exactly once. Running the worker again changed nothing.
- A failed job releases its hold once, however many times the worker runs.
- If a submit reply arrives after its job was closed as lost, the job is reopened and settled again. Settlement charges only the difference from what was already charged, so the wallet always matches the provider's final answer.
- Download glitches are retried for up to 6 hours (fal keeps outputs for at least 7 days). The creator is only charged for an output they never get after that.
- A job fal stops answering about (expired request, rotated key) is closed after 24 hours: not billed, unless fal's billing events show a charge.

## Job queue under load

`apps/hosted/test/load.test.ts`

- Test: 4 workspaces each submit 15 shots at once (120 provider requests), every 7th request fails, and three workers poll at the same time.
- Results:
  - every job settled and no hold was left open
  - there is exactly one settlement per job
  - each charge equals the provider cost × 1.2, and unbilled failures cost nothing
  - each wallet equals the sum of its project's cost log
- Every request, webhook and worker tick builds its own job runner, so work on one job is serialised in Postgres. A per-job advisory lock is held on a separate small connection pool, so lock waiters can never starve the main pool. A test runs two runners finishing the same job at once: one output, one charge.
- Real fal limits: new accounts run 2 requests at once, rising with credit purchases (self-serve up to 40). Extra requests wait in fal's queue, and queue time is free.

## Backup and restore drill

`apps/hosted/test/backup.test.ts`, `apps/hosted/src/cli/backup.ts`

- `backup.ts dump <file>` runs `pg_dump` in custom format. `backup.ts verify <file> <scratch-db-url>` restores into an empty database and compares a fingerprint:
  - every table's row count
  - every wallet balance
  - an md5 of every project document
- The test drill does this against a database holding a settled generation, and the copy matches exactly.
- Media lives in R2. Turn on bucket versioning or a nightly copy to a second bucket (owner decision with the host). A database backup plus the bucket is a full backup.
- Not done yet: a scheduled nightly backup on the production host, and a monthly restore drill there. Both need the host.

## Billing acceptance (Phase 4)

`apps/hosted/test/billing.test.ts`

- A zero balance blocks new generations (402), with no hold and the project unchanged. A Stripe top-up (webhook, credited once even when replayed) unblocks them.
- A forced fal failure releases the hold in full, adds no ledger charge, and shows a "refunded" line in the cost log.
- A simulated month of generations and storage gives exactly the calculator's generation total and the daily formula's storage and fixed charges, to the micro-dollar.
- New accounts are capped at $50 a day for their first 7 days.
- Owners get a low-balance email at 7 days of credit left and another at zero, once each. Storage keeps accruing below zero, and nothing is deleted.

## Storage and deleted projects

- Deleting a project hides it at once and stops its storage charges (media and exports of deleted projects aren't counted). The files stay in storage until a retention job removes them.
- That job isn't built. Deleting customer data needs the owner's OK, and the retention period is an open decision (Hosted uses 30 days with warnings on days 1, 14 and 25).
- Until then, Reel pays for those bytes itself, and the finances page shows that as part of storage.

## Payments after the fact

- A Stripe refund debits the refunded credit, once per refund amount.
- A card dispute debits the disputed amount and freezes the workspace for review. The freeze is logged in the admin log.
- The balance may go negative, which blocks new generations. Nothing is deleted.

## Not covered yet

- **Real fal.ai calls.** The Phase 1 spike against fal ("the cost log matches fal's dashboard to the cent") needs a fal key and about $2 of spend, and is the owner's step. Run `FAL_KEY=... pnpm spike "<idea>" --tier draft` and compare `cost-log.csv` with the fal dashboard.
- **Real Stripe payments** (sandbox or live).
- **Real R2 signed URLs.** They are tested with the local driver, which uses the same rules. The R2 presigning code is written but untested against a bucket.
- **Image moderation of minors.** OpenAI's free moderation checks `sexual/minors` on text only. See the moderation notes in `docs/PRICING_NOTES.md`.
