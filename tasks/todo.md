# Task Notes

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
