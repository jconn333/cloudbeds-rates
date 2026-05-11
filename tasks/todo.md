# Task Notes

## 2026-05-11 Aggressive live smoothing window June 2026-February 2027

- [x] Confirm current VPS write gates, run limits, and property scope.
- [x] Plan the live smoothing window for Berlin Encore and Berlin Resort.
- [ ] Apply the planned runs for 2026-06-01 through 2027-02-28 with full-scope pre-apply backups enabled.
- [ ] Verify each applied run, per-chunk backup coverage, rollback-readiness plan, and timer health.

Requirement: Keep full backups for this live window. Do not skip pre-apply backups or rollback-readiness checks.

Pause note: The broad Encore apply exposed Cloudbeds linked-room behavior where ADA room rates can drift from their standard-room pair after parent/base updates. Do not resume the broad run until parity checks and correction planning are deployed.

## 2026-05-11 ADA/standard room parity hardening

- [x] Add business-rule parity for `1 King Deluxe` / `1 King Deluxe ADA`.
- [x] Add business-rule parity for `2 Queen Deluxe` / `2 Queen Deluxe ADA`.
- [x] Add read-only parity audit output before creating correction plans.
- [x] Verify the code locally, deploy to the VPS, and inspect already-applied June 2026 dates.
- [x] Decide whether to run a small base-only Cloudbeds inheritance test before simplifying writes.

Result so far: Deployed `parityMode=standard_ada_pairs_v1`. The June 5 saved draft proves the old logic explicitly wrote `1 King Deluxe ADA` from `199.11` to `199` while `1 King Deluxe` went from `200.51` to `200`; the new parity logic proposes ADA as `200` for that date. Read-only June 2026 parity audit found 7 Encore King ADA mismatches and no missing Encore parity pairs. Berlin Resort does not have a `2 Queen Deluxe ADA` room under that exact name in the sampled base-rate rows.

Base-only inheritance test: Saved full Encore one-night backup `backup_20260511112057_ae246210` for `2027-02-27` before writing. Wrote only `1 King Deluxe` rateID `810779` from `129.64` to `129.00` with Cloudbeds job `199066486`; repeated readbacks showed `1 King Deluxe ADA` stayed at `129.64`, so Cloudbeds did not cascade the base-room write to ADA. Corrected only `1 King Deluxe ADA` rateID `810949` to `129.00` with Cloudbeds job `199066530`. Final readback: King Deluxe `129`, King Deluxe ADA `129`; parity audit `mismatchCount=0`. Conclusion: do not simplify to base-only writes for these parity pairs.

Correction result: Saved fresh full Encore backup `backup_20260511145744_56cd4a61` for `2026-06-05..2026-06-20` before correcting the seven King Deluxe ADA mismatches. Applied only `1 King Deluxe ADA` rateID `810949` on `2026-06-05`, `2026-06-06`, `2026-06-12`, `2026-06-13`, `2026-06-16`, `2026-06-19`, and `2026-06-20`; Cloudbeds jobs `199117201`, `199117208`, `199117214`, `199117222`, `199117230`, `199117240`, and `199117249` completed with one update each. Direct readback showed all seven King Deluxe / King Deluxe ADA pairs matching. Read-only parity audits returned `mismatchCount=0` for June 2026 and for the full `2026-06-01..2027-02-28` Encore window.

Fresh parity-aware smoothing result: Applied fresh Encore run `run_20260511152736_5911a38a` for `2026-09-01..2027-02-28` after full backup `backup_20260511152930_aa0ce9ab`; 808 changes across 22 chunks applied and rollback-readiness run `run_20260511160327_a91d1233` had 0 conflicts. Applied fresh Resort run `run_20260511160615_a4c0973b` for `2026-06-01..2027-02-28` after full backup `backup_20260511160904_f76c0633`; 2247 changes across 38 chunks applied after readback-only reconciles on lagging chunks. A Resort rollback plan `run_20260511173147_0e03100a` was created, but rollback conflict check found 63 conflicts because Cloudbeds recalculated June 5 Resort live rates after verification. Repeat read-only audits after waiting showed stable remaining cents: Encore 394 remaining changes with 4 parity mismatches, Resort 63 remaining changes, Resort parity mismatches 0. Stop further blind writes until the Cloudbeds recalculation behavior is understood.

## 2026-05-11 Late Cloudbeds readback reconciliation

- [x] Add a readback-only reconciliation path for verification-failed chunks.
- [x] Let daily automation wait/reconcile transient Cloudbeds readback lag before failing rollback readiness.
- [x] Expose reconciliation in the app/API without sending new Cloudbeds writes.
- [x] Reconcile the paused Encore March-May 2027 run and resume only if verification is clean.
- [x] Verify, commit, push, and deploy.

Result: Added `/api/runs/:id/reconcile`, `reconcileRunVerification`, and daily-run late reconcile attempts. The paused Encore run `run_20260511091735_e0cae15a` reconciled chunk 3 from delayed Cloudbeds readback without rewriting, then resumed from chunk 4 and completed all 330 changes across 10 chunks with 330/330 verified. Rollback plan `run_20260511101853_7ac9144c` was created with 10 ready chunks and 330 rollback changes. Deployed commit `2ba88be`; VPS web service and timer are active, daily service is inactive between runs.

## 2026-05-10 Daily live workflow hardening

- [x] Add server-side run/property locking so CLI and web applies cannot overlap.
- [x] Persist Cloudbeds job references incrementally during applies.
- [x] Preserve partial-apply verification evidence when a write/poll fails mid-run.
- [x] Make notification failures warning-only after successful daily runs.
- [x] Mark rollback-readiness runs as readiness artifacts.
- [x] Create full-scope pre-apply backups by default for daily live applies.
- [x] Add an optional off-box backup sync hook.
- [x] Tighten VPS systemd/docs/env examples for live automation.
- [x] Verify syntax and Cloudbeds preflight after changes.

Result: Added shared data-dir apply locks, incremental draft job persistence, `partial_apply_failed` / `apply_failed` draft states, partial-apply chunk reconciliation, default daily pre-apply backups, optional off-box backup sync via `DAILY_RUN_BACKUP_SYNC_COMMAND`, rollback-readiness metadata, warning-only success notifications, UI visibility for readiness/partial apply states, and stricter systemd templates. Verified `node --check` for server, public app, and scripts, plus `npm run preflight`. Also removed the temporary VPS `live-now.conf` timer override after the March-May Resort run completed.

## 2026-05-07 DigitalOcean VPS daily runner

- [x] Record a concrete migration plan for running Cloudbeds smoothing daily without a local machine.
- [x] Add a headless daily runner that reuses the existing run/apply safety path.
- [x] Add deployment docs and systemd service/timer templates for the VPS.
- [x] Verify syntax and preflight checks after the runner/deploy changes.

Planned shape: Keep the Express UI as the review/control surface, add a deterministic CLI for daily automation, run both on the DigitalOcean VPS with durable `data/` storage, and keep live writes gated by `ENABLE_CLOUDBEDS_WRITES=true` plus an explicit CLI `--apply` flag.

Result: Added `scripts/daily-run.mjs`, `npm run daily:plan`, `npm run daily:apply`, `CLOUDBEDS_RATES_DATA_DIR`, per-property locks, daily-run idempotency keys, DigitalOcean/systemd templates, and `docs/digitalocean-vps-deploy.md`. Verified JavaScript syntax, live Cloudbeds preflight, a one-night Encore plan with 10 changes, a one-night Resort plan with 0 changes, and idempotent reuse of the existing daily Encore plan. Deployed the app to the `fivestar-agents` DigitalOcean VPS at `/opt/cloudbeds-rates`, installed `/etc/cloudbeds-rates.env` with writes disabled, started/enabled `cloudbeds-rates.service`, bound the UI to `127.0.0.1:3787`, verified `/api/config` locally on the VPS, and left `cloudbeds-rates-daily.timer` disabled until live VPS writes are approved.

Follow-up live test:

- [x] Add a backup-only rate snapshot command before live VPS writes.
- [x] Save Berlin Resort February 2027 backup before changing any rates.
- [x] Apply one controlled Berlin Resort night manually with writes temporarily enabled.
- [x] Verify targeted readback and adjacent-night checks.
- [x] Return VPS writes to disabled and keep the daily timer disabled.

Result: Saved full Berlin Resort February 2027 snapshot `backup_20260508025139_3e397d14` with 6,796 normalized rows, 588 base-rate snapshot rows, and hash `79c5c0a858a850b6e87b0fc506d97d14672caf75a237861d95a73a4f1bd3b0a7`. Temporarily enabled VPS writes for one manual run, applied `run_20260508025157_1666da43` for Berlin Resort `2027-02-05`, and changed 21 base-rate rows from cents to whole-dollar rates. Draft `draft_20260508025223_e88a1ddd` and backup `backup_20260508025223_e88a1ddd` were created for the live write. Verification passed for 21/21 targeted rows, 21/21 scoped rows, and 21/21 adjacent Feb 6 rows with 0 suspected spill rows. VPS `ENABLE_CLOUDBEDS_WRITES=false` and `cloudbeds-rates-daily.timer` remains disabled.

Follow-up unattended review rollout:

- [x] Set the VPS daily systemd service to plan-only using `/etc/systemd/system/cloudbeds-rates-daily.service.d/plan-only.conf`.
- [x] Keep `/etc/cloudbeds-rates.env` at `ENABLE_CLOUDBEDS_WRITES=false`.
- [x] Enable `cloudbeds-rates-daily.timer` for unattended dry-run observation.
- [x] Verify the web service remains local-only on `127.0.0.1:3787`.

Result: `cloudbeds-rates-daily.timer` is enabled and active, with the next plan-only run scheduled for `2026-05-08 05:17:31 EDT`. The effective service command is `npm run daily:plan`, not `daily:apply`; the app API still reports `writesEnabled: false`.

Follow-up rollout direction adjustment:

- [x] Add `DAILY_RUN_START_OFFSET_DAYS` / `--start-offset-days` so unattended runs can start far in the future.
- [x] Document far-future-to-near-term rollout with `DAILY_RUN_START_OFFSET_DAYS=364` and `DAILY_RUN_DAYS_AHEAD=1`.
- [x] Deploy the new plan-only offset settings to the VPS and verify the next planned date.

Result: VPS `/etc/cloudbeds-rates.env` now has `DAILY_RUN_START_OFFSET_DAYS=364`, `DAILY_RUN_DAYS_AHEAD=1`, and `ENABLE_CLOUDBEDS_WRITES=false`. The timer remains enabled/active and plan-only via `plan-only.conf`. A VPS smoke plan for Berlin Resort created `run_20260508031245_78461538` for `2027-05-07` with 21 planned changes and 1 chunk, confirming the far-future one-night window.

Follow-up rollback readiness gate:

- [x] Make `daily:apply` immediately generate a rollback plan after a successful apply.
- [x] Fail/report the apply command if any generated rollback draft has conflicts.
- [x] Keep the gate enabled by default through `DAILY_RUN_VERIFY_ROLLBACK_READINESS=true`.
- [x] Deploy to the VPS and verify the timer remains plan-only before enabling live writes.

Result: Deployed the rollback readiness gate to the VPS with `DAILY_RUN_VERIFY_ROLLBACK_READINESS=true`. VPS safety state remains `ENABLE_CLOUDBEDS_WRITES=false`, `DAILY_RUN_START_OFFSET_DAYS=364`, `DAILY_RUN_DAYS_AHEAD=1`, and the effective daily service command is still `npm run daily:plan` via `plan-only.conf`. A VPS plan-only smoke run reused `run_20260510091538_b0a288e9` for Berlin Resort `2027-05-09` without writes.

## 2026-04-23 Progress bar for fetches and chunked runs

- [x] Add a reusable operation progress bar near the status message.
- [x] Fetch nightly rate ranges one night at a time so percent complete can reflect real progress.
- [x] Poll selected run status while chunked applies/retries are in flight and update percent complete from chunk state.
- [x] Verify syntax, preflight, and browser rendering.

Result: Fetching now shows a percentage bar that advances by completed nights and finishes at 100%. Chunked run apply/retry actions poll the saved run while the write request is in flight and update the same progress bar from completed/applied/skipped chunks plus the active chunk. Verified syntax, preflight, browser rendering, and a real two-night fetch progress flow.

## 2026-04-23 Berlin Resort property support

- [x] Confirm Berlin Resort Cloudbeds property ID from the new API key.
- [x] Add selectable multi-property config without breaking the existing Encore defaults.
- [x] Thread selected property through live reads, drafts, runs, backups, and write verification.
- [x] Update docs/env examples and run preflight/tests.

Result: Berlin Resort verified as Cloudbeds property `304361`. The app now exposes Encore and Resort in a property selector, uses the selected property's API key for live reads and new drafts/runs, and uses the saved draft/run property context for writes, polling, rollback, and verification. `node --check server.mjs`, `node --check public/app.js`, `npm run preflight`, direct `/api/rates?propertyKey=berlin-resort`, and a browser selector/fetch check all passed.

Follow-up UI note: Removed the top-level `Create Draft` button from the toolbar and made `Create Run` the primary workflow action next to `Fetch Rates`. Drafts remain internal safety artifacts for runs, rollbacks, and verification. Rechecked syntax and browser rendering after the change.

Follow-up safety note:

- [x] Add write-time absolute rate bounds so drafts cannot send zero, thousand-dollar, or non-numeric proposed rates.
- [x] Add a smooth-draft max-decrease guard so normal smoothing cannot change any row by more than $0.99.
- [x] Verify syntax, preflight, and synthetic unsafe-draft rejections.

Result: The server now rejects unsafe proposed rates before hash verification or any Cloudbeds write loop. Synthetic apply checks rejected both `$1000.00` as outside the allowed absolute range and a `$2.08` smooth decrease as exceeding the `$0.99` smoothing cap.

## 2026-04-23 Adjacent verification overlap fix

- [x] Confirm why the latest March 2027 run paused after chunk 1.
- [x] Exclude in-chunk target dates from adjacent-night verification.
- [x] Make paused-run verification messaging reflect the real failing bucket.
- [x] Verify against the saved failing run/draft artifact and preflight.

Result: The March 2027 run paused because adjacent-night verification was re-checking March 3-6 even though those dates were also targeted inside the same chunk. Adjacent verification now treats overlapping in-chunk target dates as intentional, the Selected Draft UI hides those pseudo-adjacent mismatches, and run error text now reports the real failing bucket instead of implying targeted rows failed. `npm run preflight` passed, and a direct check on `draft_20260423141636_0c805487` showed all 40 adjacent mismatches overlapped targeted dates with 0 true non-overlap adjacent mismatches.

## 2026-04-23 Rollback draft hash alignment

- [x] Diagnose the March 2027 rollback-run `Draft hash mismatch; refusing to apply.` error.
- [x] Align rollback draft creation with the shared draft hash payload builder.
- [x] Verify a fresh rollback draft now recomputes to its stored hash.

Result: The rollback run paused because `createRollbackDraftFromBackup` hashed a hand-built payload whose key order differed from the canonical `buildDraftPayload(...)` order used during apply-time verification. Rollback drafts now use the shared payload builder before hashing. `npm run preflight` passed, the previously failed draft `draft_20260423143313_e00101dc` still shows the old mismatch as expected, and a fresh rollback draft from `backup_20260423142753_ac9d91ab` created `draft_20260423143507_0a93fad2` with a stored hash that recomputes exactly.

## 2026-04-22 Multi-date rate calendar redesign

- [x] Replace row-first live-rate preview with a room/date calendar grid.
- [x] Add batch summary metrics and change/ignored-row filters.
- [x] Group selected draft review for multi-date changes.
- [x] Verify syntax, preflight, and served app behavior.

Result: Aug 3-6, 2026 loaded as 464 Cloudbeds rows summarized into 10 room rows, 4 date columns, 40 highlighted base-rate changes, and 424 ignored named/derived rows. A multi-date draft was created locally with 40 changes and no live apply was run.

## 2026-04-22 Apply result placement and readback visibility

- [x] Move apply result feedback into the Selected Draft action area.
- [x] Show Cloudbeds readback rates after apply, including mismatches.
- [x] Verify syntax and browser rendering on an existing applied/failed draft.

Result: Existing verification-failed draft now renders a Selected Draft apply-result panel after the exact-change table with 20 readback rows, including approved rate, Cloudbeds current rate, and Updated/Mismatch status.

## 2026-04-22 Verification retry hardening

- [x] Investigate the three suite mismatches from draft_20260422152535_57ab1628.
- [x] Confirm whether Cloudbeds later converges to the approved rates.
- [x] Retry post-apply verification before marking a draft as failed.
- [x] Verify syntax and preflight after the change.

Result: The three August 13 suite mismatches were transient; live Cloudbeds later returned the approved 234/224 rates. Verification now retries completed-job readback before declaring `verification_failed`.

## 2026-04-22 Large-batch runs, chunked backups, and rollback planning

- [x] Add large-batch `run` planning for long date ranges.
- [x] Split runs into internal chunked apply units.
- [x] Create a draft and backup for every chunk before write.
- [x] Add rollback-run planning from chunk backups.
- [x] Add Batch Runs UI and Selected Run detail.
- [x] Verify syntax, preflight, API run creation, and browser run planning flow.

Result: A 31-night August 2026 run planned successfully with 200 changes split into 5 chunks. The UI now exposes chunk status, draft/backup slots, chunked apply action, and rollback-run planning readiness.

## 2026-04-22 Run apply hash alignment

- [x] Diagnose the run-apply `Draft hash mismatch; refusing to apply.` failure.
- [x] Align apply-time hash verification with run-created draft payloads.
- [x] Verify the exact failing run draft now recomputes to the stored hash.

Result: Chunk drafts created from runs include `sourceRunId` and `sourceChunkId`; apply now uses the same shared draft payload builder, so the exact failed draft hash recomputes correctly.

## 2026-04-22 Failed run diagnostics in Selected Run

- [x] Surface the real run/chunk failure reason in Selected Run.
- [x] Special-case the older run hash bug so it reads as a legacy internal failure.
- [x] Verify browser rendering against both the failed and successful runs.

Result: Selected Run now shows a run-level alert and per-chunk error detail for the legacy hash-mismatch failure, while successful runs stay on the normal backup/verification guidance state.

## 2026-04-22 Phase 2 run hardening

- [x] Add resumable run progress and failed-chunk retry support.
- [x] Regenerate chunk drafts from fresh live data before smooth-run apply.
- [x] Regenerate rollback drafts from the source backup before rollback-run apply.
- [x] Pause runs on unexpected live drift instead of writing stale plans.
- [x] Add Selected Run progress messaging and run-specific event history.
- [x] Verify syntax, preflight, run event API, rollback planning, and renderer states.

Result: Runs now keep progress state, surface run-specific events, support retrying the first failed chunk, and preflight live Cloudbeds state before each chunk write. A fresh rollback plan from the applied August run created `run_20260422192729_5e7aca51`, `/api/runs/:id/events` returned run-scoped events, and renderer checks confirmed the new Execute Rollback Run, Retry Failed Chunk Only, paused progress, and event-panel states.

## 2026-04-22 Rate write verification hardening

- [x] Fix nightly previews so multi-night spans are fetched one night at a time.
- [x] Treat same-day start/end as one inclusive night.
- [x] Add `MAX_FETCH_DAYS` for safe read previews.
- [x] Poll Cloudbeds jobs through `in_progress` before verification readback.
- [x] Replace typed apply phrase with browser confirmation.
- [x] Add apply/verifying spinner.
- [x] Verify syntax, preflight, served assets, config, and safe endpoint behavior.

Result: Dec 30 live rates read back as already smooth after the user test. Dec 25 remains available as a one-night write test with 10 base-rate changes.


## 2026-04-22 Side-panel list containment

- [x] Cap the right-rail run, draft, and backup list heights.
- [x] Make each list scroll internally instead of stretching the page.
- [x] Verify the UI assets still load cleanly.

Result: The right-side Batch Runs, Drafts, and Backups sections now scroll within their own list areas, so the page no longer grows into a long single column when history gets large.

## 2026-04-22 Nightly write spill fix

- [x] Confirm the Sept 16 apply likely overwrote Sept 17.
- [x] Change Cloudbeds write payloads to use the target night as the write end date.
- [x] Verify syntax and capture the lesson in repo notes.

Result: Sept 17 was planned from 184.48 -> 184, but after the Sept 16 chunk applied Cloudbeds read back Sept 17 as 196, matching Sept 16. The write payload was sending next-day checkout as `endDate`; nightly writes now send same-day `endDate` to avoid spilling into the following night.

## 2026-04-22 Full base-rate backup snapshots

- [x] Add full base-rate snapshots to backup artifacts, including already-smooth rows in scope.
- [x] Feed smooth run chunk backups from the full preflight fetch, not only the changed rows.
- [x] Verify syntax and a local draft snapshot.

Result: Backup artifacts now store `baseRowsSnapshot` with every base row in scope, including untouched/already-smooth rows plus targeted/proposed metadata. A local draft-only snapshot for 2026-08-02 created `backup_20260422201642_32af9987` with 10 `baseRowsSnapshot` rows and 0 rollback changes, confirming zero-change days are now auditable too.

## 2026-04-22 Spill-bug corrective draft

- [x] Build a review-only corrective draft for the proven bad Sept 9 and Sept 17 rows.
- [x] Save a matching backup snapshot for those corrective rows.
- [x] Verify the draft contains the intended 20-row repair scope.

Result: Created corrective draft `draft_20260422202057_0499abb3` with backup `backup_20260422202057_0499abb3` covering Sept 9 and Sept 17 only. The draft restores the intended smoothed values for the 20 proven spill-damage rows and has not been applied.

## 2026-04-22 Spill and full-scope verification hardening

- [x] Verify targeted rows, untouched base rows in scope, and adjacent spill-risk nights after draft apply.
- [x] Persist safety metadata on runs, drafts, and backups for the current write/verification strategy.
- [x] Improve run drift categorization so suspected adjacent-night spill reads differently from generic external drift.
- [x] Add a run-level UI action to generate a spill repair draft from proven live mismatches.
- [x] Verify syntax plus the spill-repair endpoint on an existing applied run.

Result: Applies now verify the rows we meant to change, the untouched base rows we expected to stay still, and the adjacent nights that are most at risk of spill. Runs and backups now record the active safety strategy metadata, drift can surface as `adjacent_spill_suspected`, and Selected Run exposes a `Create Spill Repair Draft` action that produced a reviewable corrective draft from a historical applied run.
