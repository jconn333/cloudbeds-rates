# Cloudbeds Rate Update Preflight Checklist

Use this checklist before any live `putRate` or `patchRate` call.

1. Confirm target property is explicit.
- Never run against a generic "Berlin hotel" target.
- For this project, confirm `CLOUDBEDS_PROPERTY_ID` is the intended hotel.

2. Confirm API auth mode and key format.
- Use `x-api-key` auth unless intentionally using OAuth.
- API key value must be raw (no `CLOUDBEDS_API_KEY=` prefix).

3. Confirm endpoint version and method.
- Use PMS API v1.3 for rate updates.
- Use `putRate` or `patchRate` only.
- Treat updates as async jobs and track via `getRateJobs`.

4. Confirm identifiers and write scope.
- Verify `rateID` exists for the selected property.
- Verify rate is not derived when attempting direct value changes.

5. Confirm safety rails before write.
- Dry-run read check first (`getRate` for same date/rate).
- Log request payload (without secrets), timestamp, and operator.
- Keep a rollback value (prior rate) before update.

6. Confirm post-write verification.
- Poll job status until completion/failure.
- Confirm each job update includes the expected value in `updates[].rate`.
- Re-read final rate (`getRate`) for exact target date(s).
- Record request ID and job reference ID.

## Known gotchas from prior projects

- Some Cloudbeds endpoints are GET-only in practice.
- Payload shapes can vary (`roomRateDetailed` vs `detailedRates`).
- `getRatePlans` totals are not always guest-final totals.
- Cross-property mixups are common; force explicit property selection.
- For `putRate` payloads, use `rates[].interval[].rate` for write value. Do not rely on `roomRate` in write payload.
- `getRateJobs=completed` does not guarantee the displayed rate changed; always do a direct post-write readback.
