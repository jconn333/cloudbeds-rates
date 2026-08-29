# Cloudbeds Rate Smoother — Recovery & Migration Handoff

**For:** a fresh Claude session implementing this. **From:** Zeke session with Jeff, 2026-08-28.
**Jeff has approved the plan below. Do the tasks in order. Plan-only first, confirm with Jeff before the first live apply.**

## System context

- Repo: `~/Dev/cloudbeds-rates` on Jeff's MacBook (GitHub `jconn333/cloudbeds-rates`, branch `main`). Production has run on a DigitalOcean VPS (`root@68.183.100.227`) at `/opt/cloudbeds-rates`, secrets in `/etc/cloudbeds-rates.env`, durable state in `/opt/cloudbeds-rates/data`. Five Star is migrating everything off the VPS to a **new Mac Mini** — the smoother's future home is the Mini.
- **Designed pipeline (intentional):** hotel staff run **Cloudbeds PIE dynamic pricing in the mornings** for both hotels (Berlin Encore + Berlin Resort). The smoother then **charm-rounds PIE's output to 4/9 endings** (`DAILY_RUN_RULE=round49`, nearest ending in 4 or 9, ±$2.50 max move, $89 floor via `MIN_ROOM_RATE_FLOOR`, parity-locked ADA rooms). Hundreds of changes/day is NORMAL — PIE re-prices, smoother re-charms.
- The smoother is heavily safety-engineered: env-gated writes (`ENABLE_CLOUDBEDS_WRITES=true`), plan-then-apply runs keyed by an automation key, full pre-apply backups, per-chunk drafts/backups, readback verification (targeted + untouched-scope + adjacent-night), rollback-readiness checks, guarded auto-retry. Read `README.md` and `tasks/lessons.md` before changing anything.

## Current state (verified 2026-08-28)

1. **VPS smoother is stopped AND disabled** (`cloudbeds-rates.service`, `cloudbeds-rates-daily.timer`) since **2026-08-25 14:57 EDT** — done from a `zeke` VPS-agent tmux session **without Jeff's authorization**, reason unrecorded. Jeff has decided: **leave the VPS units disabled permanently** (migration is happening anyway).
2. **Something still fires a daily ~10:00 ET run** — NOT the VPS (its systemd/cron are clean) and NOT Jeff's MacBook Pro (no launchd/cron entries; local `data/runs` stale since May). Almost certainly the **Mac Mini**. Its latest run failed `FAILED berlin-encore: Invalid User` (2026-08-28 10:00 EDT, posted to Slack #ai-notifications). "Invalid User" may be a bad/rotated API key on the Mini, or transient Cloudbeds flakiness (it also appeared once on the VPS on Aug 11 while creds were valid).
3. **Jul 20 – Aug 25 failure pattern:** repeated verification failures ("0/N targeted rows verified", untouched-scope mismatches, one true adjacent-spill detection Jul 28). Root cause: **timing collisions** — PIE/staff writing rates during the smoother's 10:00–11:15 ET run window. Each failure paused the run and exited nonzero (correct behavior), but alerts drowned in Pricey Pro watchdog noise in #ai-notifications.
4. **~14 stale paused runs** sit active in the VPS ledger (`/opt/cloudbeds-rates/data/runs/`), e.g.: `run_20260511104200_908475ed` (stuck "running" since May), `run_20260720140337_cb074b22`, `run_20260723140354_cb3cf074`, `run_20260725140826_3b75b0a6`, `run_20260727140659_97171f05`, `run_20260728142045_7f2060c1`, `run_20260731140608_9e0dbbfc`, `run_20260802140713_a873ad29`, `run_20260803144453_603a3709`, `run_20260806142700_378bbdc2`, `run_20260809140401_8685a921`, `run_20260818140501_116102bf`, `run_20260824140355_60e930bf`, `run_20260825142846_0070067c`. Rates themselves are consistent (every write verified or paused-clean; backups exist) — these are just stale ledger records.
5. The VPS also hosts unrelated newer units (`cloudbeds-sync-*`, `cloudbeds-room-revenue*`) built by another project/agent (`ecoseal` user). **Do not touch those.**

## Task 1 — Single-home the smoother on the Mac Mini

1. Get Mini access from Jeff (SSH or run there directly). Find what triggers the ~10:00 ET run: check `launchctl list`, `~/Library/LaunchAgents`, `/Library/LaunchDaemons`, `crontab -l` for all users, and any resident Claude/agent schedules. Identify the app copy it runs.
2. Bring that copy current with GitHub `main` (the VPS deploy and repo were in sync as of commit `cc676f2`+).
3. Fix its environment: it needs everything the VPS had in `/etc/cloudbeds-rates.env` — Cloudbeds API keys/property IDs for both properties (`CLOUDBEDS_BERLIN_ENCORE_*`, `CLOUDBEDS_BERLIN_RESORT_*`), `ENABLE_CLOUDBEDS_WRITES=true`, `DAILY_RUN_RULE=round49`, `DAILY_RUN_PROPERTIES=berlin-encore,berlin-resort`, `DAILY_RUN_DAYS_AHEAD=365`, `DAILY_RUN_START_OFFSET_DAYS=0`, `DAILY_RUN_NOTIFY_ON_SUCCESS=false`, `DAILY_RUN_WEBHOOK_URL=<Slack Zeke-app webhook for #ai-notifications>`, and the reconcile knobs (`DAILY_RUN_RECONCILE_ATTEMPTS=12`, `DAILY_RUN_RECONCILE_DELAY_MS=60000`). **Copy secret values from the VPS env file over SSH — never paste keys into chat or commit them.** Note the VPS backup copy at `/etc/cloudbeds-rates.env.bak-20260710-charmflip`.
4. Test credentials read-only first: `npm run preflight`, or a 1-night plan run (no `--apply`): `node scripts/daily-run.mjs --property berlin-encore --start-date <tomorrow> --days-ahead 1 --rule round49`. If "Invalid User" persists on valid-looking keys, the Encore key may need regenerating in Cloudbeds (Jeff can do that).
5. Migrate durable state: copy the VPS `/opt/cloudbeds-rates/data/` (runs, drafts, backups, audit.sqlite, ~7 GB) to the Mini so history/backups/rollback plans survive the VPS retirement.
6. Run one full plan-only cycle for both properties, show Jeff the numbers, get his explicit OK, then enable live applies on the schedule from Task 2. **There must be exactly ONE scheduled runner across all machines when done.**

## Task 2 — Reschedule away from PIE's window

- PIE pricing happens **in the mornings**. The old 10:00 ET schedule collided with it constantly.
- **Move the daily run to ~20:00 (8 PM) ET.** Rationale: PIE's morning prices are final by afternoon; an evening run charm-rounds them the same day, guests browsing in the evening/overnight see charm prices, and next morning PIE takes over again. (Avoid anything 08:00–13:00 ET. Early-morning slots like 4 AM are bad — instantly clobbered by morning PIE.)
- Keep a small randomized delay like the old systemd timer had. On the Mini use launchd (`StartCalendarInterval`) or whatever scheduler already fires the current job.

## Task 3 — VPS cleanup (Jeff approved)

1. **Leave `cloudbeds-rates.service` and `cloudbeds-rates-daily.timer` disabled.** That is now the intended state.
2. Find and **stop the Mini's current broken 10:00 schedule** before enabling the new one (avoid two runners).
3. Archive the ~14 stale paused/running runs listed above — metadata-only, NO rate writes, NO rollbacks, NO retries. On the VPS as the service user (`sudo -u cloudbeds-rates`, never root — root-owned files in `data/` break the runner; see `tasks/lessons.md`), call the exported `archiveRun(id, { operator, reason })` from `server.mjs` for each id, with reason like "stale after Jul–Aug PIE collision era; superseded; smoother migrated to Mac Mini". Verify zero active non-clean runs afterward.

## Task 4 — Collision-tolerant verification (code change, do last)

Goal: a PIE write landing during/after a smoother run should not pause the whole pipeline.

- Design direction (discuss trade-offs in a plan before coding): after apply, when a **targeted** row's readback mismatches, fetch the row fresh and check whether the live value looks like a **newer external write** (differs from both our proposed value AND the pre-apply current value). If so, classify it `superseded_external` rather than failed — it will be re-planned and re-charmed in the next daily run. Only pause when readback matches the pre-apply value (our write truly didn't land) or when untouched-scope/adjacent checks show writes we can't attribute (keep the spill detection strict — it caught a real spill on 2026-07-28).
- Keep the guarded auto-retry envelope untouched for genuine failures. Cap how many `superseded_external` rows a run may tolerate (e.g. env `MAX_SUPERSEDED_ROWS`, default generous) so a runaway still pauses.
- Add tests or a standalone assertion script; `node --check` everything; update README Safety Model + `tasks/todo.md` per repo convention (`AGENTS.md`).

## Ground rules (from Jeff's global config — apply here too)

- Cloudbeds writes ONLY through this app's gated pipeline (this is the one Jeff-approved write path besides pricey-pro's HostAway push). Never hand-craft `putRate` calls.
- Plan-only first, show Jeff numbers, explicit go before any live apply. Never leave two schedulers active.
- Failures alert via the Slack webhook (posts as "Zeke" to #ai-notifications, channel `C0BFGQ7TP19`); successes stay silent. Consider prefixing smoother alerts distinctly (e.g. "🛏️ Rate smoother:") so they stand out from Pricey Pro watchdog noise — that noise is why five weeks of failures went unnoticed.
- Update the memory file `~/.claude/projects/-Users-jeffconn-Dev-cloudbeds-rates/memory/round49-charm-rollout.md` when the Mini is live so future sessions know the smoother's home.

## Success criteria

- One scheduler, on the Mini, running ~20:00 ET daily with `round49`, both properties.
- A clean live run end-to-end (applied, verified, rollback-readiness 0 conflicts) observed after the move.
- VPS ledger shows zero active non-clean runs; VPS units remain disabled.
- A subsequent week with collisions producing `superseded_external` rows (post-Task-4) instead of paused runs.
