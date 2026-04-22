# Task Notes

## 2026-04-22 Rate write verification hardening

- [x] Fix nightly previews so multi-night spans are fetched one night at a time.
- [x] Treat same-day start/end as one inclusive night.
- [x] Add `MAX_FETCH_DAYS` for safe read previews.
- [x] Poll Cloudbeds jobs through `in_progress` before verification readback.
- [x] Replace typed apply phrase with browser confirmation.
- [x] Add apply/verifying spinner.
- [x] Verify syntax, preflight, served assets, config, and safe endpoint behavior.

Result: Dec 30 live rates read back as already smooth after the user test. Dec 25 remains available as a one-night write test with 10 base-rate changes.
