# Cloudbeds Rate Smoother Lessons

## API write payload

- Use `putRate` with `rates[0][interval][0][rate]` for the value to write.
- Do not use `roomRate` in the write payload; Cloudbeds accepts the request shape but it does not update the rate as intended.
- Keep write batches small and verify by reading Cloudbeds back after jobs finish.

## Nightly reads

- Fetch each night separately with `getRatePlans` when previewing or verifying nightly rates.
- Multi-night `getRatePlans` calls can return stay totals that look like inflated nightly rates.
- The UI treats start/end fields as inclusive nights, so a same-day selection is one night.

## Job polling and verification

- `getRateJobs` can return `in_progress`; treat that as incomplete, same as `queued` or `processing`.
- Do not read back immediately after seeing a job reference. Poll until Cloudbeds reports a terminal status or the timeout is reached.
- Compare money values with a small tolerance after rounding to cents to avoid false mismatches from numeric representation.

## Apply UX and safety

- Writes remain gated by `ENABLE_CLOUDBEDS_WRITES=true` and server-side confirmation.
- The browser UI should use a simple confirmation prompt, not a long typed draft string.
- Show an applying/verifying spinner because Cloudbeds write jobs can take long enough to look frozen.
- A `verification_failed` draft may be a stale false negative if the old polling logic read back while Cloudbeds jobs were still `in_progress`; verify live rates before assuming Cloudbeds rejected the write.

## Large-batch run safety

- Before each smooth-run chunk apply, re-read Cloudbeds for that chunk and rebuild the draft from fresh live rows.
- If Cloudbeds already matches the target rate for every row in a chunk, mark the chunk `skipped` instead of rewriting it.
- If any live row drifts away from the planned current rate before apply, pause the run and surface the drift rather than writing stale assumptions.
- Before each rollback-run chunk apply, regenerate the rollback draft from the source backup so conflict checks use current live rates.

- Cloudbeds `putRate` interval `endDate` behaves as inclusive for nightly writes in this workflow; using checkout day can spill the write into the next night. Use the target night itself as the write `endDate` for one-night updates.

- Backups should persist a full base-rate snapshot for the scoped dates, not only the changed rows, so already-smooth nights remain auditable later.

- Targeted-row verification is not enough for nightly smoothing writes. Also verify untouched base rows in scope and the adjacent risk nights so spill bugs show up immediately instead of hiding behind "successful" target readback.

- When a paused chunk's drifted live values all match the previous night's applied targets, classify it as suspected adjacent-night spill and offer a repair-draft path directly from the run history.

- Adjacent-night verification for multi-night chunks must exclude dates that are also targeted within the same draft; otherwise legitimate in-chunk updates are mislabeled as adjacent mismatches and the run pauses falsely.

- Rollback draft hashes must be generated from the same shared `buildDraftPayload(...)` shape used at apply time; even identical field values will fail if creation hashes a differently ordered object.
