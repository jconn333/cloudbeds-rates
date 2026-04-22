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
- Applying a draft requires typing `APPLY <draft-id>`.
- Drafts are hash-checked before execution.
- Drafts are capped by `MAX_DRAFT_DAYS` and `MAX_DRAFT_CHANGES`.
- Applies are capped by `MAX_APPLY_CHANGES`.
- Every apply polls `getRateJobs` and re-reads Cloudbeds rates for verification.
- Backups and rollback payloads are stored under `data/backups/`.
- Audit events are stored in SQLite at `data/audit.sqlite`.

## Cloudbeds Write Shape

Use `rates[0][interval][0][rate]` for the updated value. Do not use `roomRate` in write payloads.
