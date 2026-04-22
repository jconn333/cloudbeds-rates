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
