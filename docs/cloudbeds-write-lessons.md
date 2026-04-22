# Cloudbeds Write Lessons (Dec 21, 2026 test)

This captures proven behavior from live rate-write testing on Berlin Encore.

## Confirmed write payload shape

- `putRate` requires a `rates` collection.
- Working form-encoded shape:
  - `rates[0][rateID]`
  - `rates[0][interval][0][startDate]`
  - `rates[0][interval][0][endDate]`
  - `rates[0][interval][0][rate]`

## Critical gotcha

- `roomRate` in the write payload did not update rates.
- Cloudbeds accepted jobs and returned `completed`, but values stayed unchanged.
- The value field that actually updates price is `rate`.

## Verification rules

1. Do not trust job completion alone.
2. Check `getRateJobs` update entries and confirm `updates[].rate` is populated as expected.
3. Re-read with `getRatePlans` (or `getRate`) for the exact target date(s) and target `rateID`s.

## Safe execution pattern

1. Snapshot current values.
2. Test payload on one `rateID`.
3. Verify write + readback.
4. Apply to remaining `rateID`s.
5. Save job IDs and responses to logs.

## Scope rules used in this test

- Date scope: one day only (`2026-12-21` to `2026-12-22` interval).
- Update scope: non-derived base rates only (`isDerived=false`).
- Smoothing rule: truncate cents to `.00` (e.g., `122.37 -> 122.00`).
