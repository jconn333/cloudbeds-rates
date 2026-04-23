# Cloudbeds Rate Smoother

Internal tool for previewing, backing up, approving, applying, and verifying Cloudbeds rate smoothing.

## Run

```sh
npm install
npm run preflight
npm run dev
```

Open `http://localhost:3787`.

## Safety Model

- Writes are disabled unless `ENABLE_CLOUDBEDS_WRITES=true`.
- Creating a draft only reads Cloudbeds and writes local backup JSON.
- Applying a draft requires confirming the browser "Are you sure?" prompt.
- Drafts are hash-checked before execution.
- Rate previews fetch each night separately so multi-night spans do not show Cloudbeds stay totals as nightly rates.
- Fetches are capped by `MAX_FETCH_DAYS`.
- Drafts are capped by `MAX_DRAFT_DAYS` and `MAX_DRAFT_CHANGES` (defaults: 7 nights / 100 changes).
- Applies are capped by `MAX_APPLY_CHANGES` (default: 100 changes).
- Large-batch runs can plan up to `MAX_RUN_DAYS` nights and split work into `RUN_CHUNK_MAX_NIGHTS` / `RUN_CHUNK_MAX_CHANGES` chunks.
- Every run chunk creates its own draft and backup before writing.
- Rollback runs are generated from the per-chunk backups of a prior run.
- Every apply polls `getRateJobs` and re-reads Cloudbeds rates for verification.
- Verification retries a few times after completed jobs because Cloudbeds readback can lag briefly behind job completion.
- Backups and rollback payloads are stored under `data/backups/`.
- Runs are stored under `data/runs/`.
- Audit events are stored in SQLite at `data/audit.sqlite`.

## Cloudbeds Write Shape

Use `rates[0][interval][0][rate]` for the updated value. Do not use `roomRate` in write payloads.
