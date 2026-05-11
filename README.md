# Cloudbeds Rate Smoother

Internal tool for previewing, backing up, approving, applying, and verifying Cloudbeds rate smoothing.

## Run

```sh
npm install
npm run preflight
npm run dev
```

Open `http://localhost:3787`.

## Daily Automation

Plan the daily smoothing run without live writes:

```sh
npm run daily:plan
```

Apply the daily run:

```sh
npm run daily:apply
```

Live writes still require `ENABLE_CLOUDBEDS_WRITES=true`; the apply command alone
is not enough. The daily runner uses `DAILY_RUN_PROPERTIES`,
`DAILY_RUN_START_OFFSET_DAYS`, `DAILY_RUN_DAYS_AHEAD`, and
`DAILY_RUN_OPERATOR` from the environment. It stores an automation key on each
run, uses a per-property lock file, and refuses to apply paused or otherwise
non-planned runs unattended.

Before every live `daily:apply`, the runner creates a full-scope pre-apply backup
for the property/window unless `DAILY_RUN_PRE_APPLY_BACKUP=false` or
`--skip-pre-apply-backup` is used. After every successful apply, it immediately
creates a rollback-readiness plan from the new per-write backups and checks every
rollback draft for conflicts. If rollback readiness fails, the command exits
nonzero so systemd/journald and the Codex review loop surface it. This can be
disabled only by setting `DAILY_RUN_VERIFY_ROLLBACK_READINESS=false` or passing
`--skip-rollback-readiness`.

Set `DAILY_RUN_BACKUP_SYNC_COMMAND` to run an off-box backup sync after the
pre-apply backup and after rollback-readiness planning. The command receives
`DAILY_RUN_SYNC_STAGE`, `DAILY_RUN_SYNC_PROPERTY`,
`DAILY_RUN_SYNC_RUN_ID`, `DAILY_RUN_SYNC_BACKUP_ID`,
`DAILY_RUN_SYNC_START_DATE`, and `DAILY_RUN_SYNC_END_DATE`.

If Cloudbeds reports jobs as completed but `getRatePlans` still shows stale
rates, the daily runner performs readback-only late reconciliation before it
fails rollback readiness. This is controlled by `DAILY_RUN_RECONCILE_ATTEMPTS`
and `DAILY_RUN_RECONCILE_DELAY_MS`. Reconciliation never sends new `putRate`
calls; it only re-reads Cloudbeds and updates the saved run/draft when the
delayed readback verifies cleanly.

For lower-risk live rollout, work from far-future dates back toward near-term
dates. For example, this plans one night roughly a year out; tomorrow's scheduled
run naturally moves one day closer because the offset is recalculated from that
day's date:

```sh
DAILY_RUN_START_OFFSET_DAYS=364
DAILY_RUN_DAYS_AHEAD=1
```

For a DigitalOcean/systemd deployment, see
`docs/digitalocean-vps-deploy.md`.

The server binds to `127.0.0.1` by default. Put nginx, HTTPS, and authentication
in front of it before exposing the UI outside the VPS.

## Current Production Setup

The DigitalOcean VPS runs this app from `/opt/cloudbeds-rates` with secrets in
`/etc/cloudbeds-rates.env` and durable state in `/opt/cloudbeds-rates/data`.

There are two systemd surfaces:

- `cloudbeds-rates.service` runs the local-only web UI on `127.0.0.1:3787`.
- `cloudbeds-rates-daily.timer` schedules `cloudbeds-rates-daily.service` daily
  at 10:00 AM America/New_York, with a small randomized delay.

The current rollout mode is controlled live timer testing against far-future 2027
dates. Keep the web UI local-only and review timer logs, recent runs,
verification state, pre-apply backups, per-chunk backups, and rollback-readiness
runs after each live window change.

The preferred rollout direction is far-future to near-term. Use
`DAILY_RUN_START_OFFSET_DAYS=364` with `DAILY_RUN_DAYS_AHEAD=1` to start about a
year out and move one night closer on each daily run. This avoids testing first
on dates closest to today's actual booking window.

To inspect the UI from a local machine:

```sh
ssh -L 3787:127.0.0.1:3787 root@68.183.100.227
```

Then open `http://127.0.0.1:3787`.

Before any live write test, save a scope backup:

```sh
npm run backup:rates -- --property berlin-resort --start-date 2027-02-01 --end-date 2027-02-28
```

Live writes require all of these to be true:

- `ENABLE_CLOUDBEDS_WRITES=true`
- the command is `npm run daily:apply`
- the target run is still `planned`
- the daily runner creates a full-scope pre-apply backup
- the run passes pre-apply live drift checks
- Cloudbeds readback and adjacent-night verification pass after apply
- an immediate rollback plan is generated from the new backup with 0 conflicts

The app can switch between configured Cloudbeds properties. Keep the legacy
`CLOUDBEDS_API_KEY` / `CLOUDBEDS_PROPERTY_ID` values for the default property,
and add named aliases such as `CLOUDBEDS_BERLIN_ENCORE_*` and
`CLOUDBEDS_BERLIN_RESORT_*` when more than one hotel should be available.

## Safety Model

- Writes are disabled unless `ENABLE_CLOUDBEDS_WRITES=true`.
- Creating a draft only reads Cloudbeds and writes local backup JSON.
- Applying a draft requires confirming the browser "Are you sure?" prompt.
- Drafts are hash-checked before execution.
- Server-side property locks prevent overlapping applies from the CLI and web UI.
- Draft applies persist submitted Cloudbeds job references incrementally so partial writes can be reconciled.
- Failed post-apply readbacks can be reconciled without rewriting rates.
- Rate previews fetch each night separately so multi-night spans do not show Cloudbeds stay totals as nightly rates.
- Fetches are capped by `MAX_FETCH_DAYS`.
- Drafts are capped by `MAX_DRAFT_DAYS` and `MAX_DRAFT_CHANGES` (defaults: 7 nights / 100 changes).
- Applies are capped by `MAX_APPLY_CHANGES` (default: 100 changes).
- Proposed write rates must stay between `MIN_ALLOWED_RATE` and `MAX_ALLOWED_RATE` (defaults: $1.00-$999.99).
- Smooth drafts may only remove cents and cannot decrease any rate by more than `MAX_SMOOTH_RATE_DECREASE` (default: $0.99).
- Large-batch runs can plan up to `MAX_RUN_DAYS` nights and split work into `RUN_CHUNK_MAX_NIGHTS` / `RUN_CHUNK_MAX_CHANGES` chunks.
- Every run chunk creates its own draft and backup before writing.
- Daily live applies create a full-scope pre-apply backup before writing.
- Daily runs can call `DAILY_RUN_BACKUP_SYNC_COMMAND` to copy state off the VPS.
- Rollback runs are generated from the per-chunk backups of a prior run.
- Every apply polls `getRateJobs` and re-reads Cloudbeds rates for verification.
- Verification retries a few times after completed jobs because Cloudbeds readback can lag briefly behind job completion.
- Backups and rollback payloads are stored under `data/backups/`.
- Runs are stored under `data/runs/`.
- Audit events are stored in SQLite at `data/audit.sqlite`.

## Cloudbeds Write Shape

Use `rates[0][interval][0][rate]` for the updated value. Do not use `roomRate` in write payloads.
