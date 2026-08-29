#!/usr/bin/env bash
# mini-reschedule-and-cleanup.sh — single-home the rate smoother on the Mac
# mini, per docs/smoother-recovery-handoff.md (Jeff-approved 2026-08-28).
#
# What this does (idempotent):
#   1. Syncs this repo's code to the mini's deploy at ~/Services/cloudbeds-rates
#      (code only — data/, logs/, node_modules/ etc. untouched).
#   2. Moves the daily schedule from 10:00 ET (PIE collision window) to
#      20:00 ET with a 0-15 min random jitter, via a run-with-jitter wrapper.
#   3. Archives the 14 stale paused/running ledger runs from the Jul-Aug
#      collision era (metadata-only via the exported archiveRun; NO rate
#      writes, NO rollbacks). The two Aug-27 "planned" rollback-plan runs are
#      deliberately NOT touched — they are live rollback readiness.
#   4. Verifies: zero paused/running runs remain; prints the new schedule.
#
# Run from the repo root on Jeff's MacBook: bash scripts/mini-reschedule-and-cleanup.sh
set -euo pipefail

MINI="jeffconn@100.96.217.56"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> 1/4 sync code to mini (data/logs/state untouched)"
rsync -a --delete \
  --exclude data/ --exclude logs/ --exclude output/ --exclude tmp/ \
  --exclude deploy-backups/ --exclude node_modules/ --exclude .git/ \
  "$REPO_ROOT/" "$MINI:Services/cloudbeds-rates/"
ssh "$MINI" 'cd ~/Services/cloudbeds-rates && "$HOME/.nvm/versions/node/v24.13.0/bin/npm" ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || "$HOME/.nvm/versions/node/v24.13.0/bin/npm" install --omit=dev --no-audit --no-fund >/dev/null'
echo "  synced + deps refreshed"

echo "==> 2/4 reschedule 10:00 -> 20:00 ET with jitter"
ssh "$MINI" bash -s <<'REMOTE_SCHED'
set -euo pipefail
mkdir -p "$HOME/Services/bin"
cat > "$HOME/Services/bin/run-with-jitter.sh" <<'EOS'
#!/bin/bash
# run-with-jitter.sh <max_jitter_seconds> <cmd...> — launchd has no
# RandomizedDelaySec equivalent, so sleep a random 0..max first.
MAX="$1"; shift
sleep $((RANDOM % MAX))
exec "$@"
EOS
chmod +x "$HOME/Services/bin/run-with-jitter.sh"

PLIST="$HOME/Library/LaunchAgents/com.triple3.svc-cloudbeds-rates-daily.plist"
cp "$PLIST" "$PLIST.bak-$(date +%Y%m%d%H%M%S)"
cat > "$PLIST" <<EOP
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.triple3.svc-cloudbeds-rates-daily</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>/Users/jeffconn/Services/bin/run-with-jitter.sh</string>
    <string>900</string>
    <string>/bin/bash</string><string>/Users/jeffconn/Services/bin/run-service.sh</string>
    <string>cloudbeds-rates-daily</string>
    <string>daily-apply</string>
    <string>cloudbeds.rates</string>
    <string>fivestar</string>
    <string>cloudbeds-rates.env</string>
    <string>/Users/jeffconn/Services/cloudbeds-rates</string>
    <string>/Users/jeffconn/.nvm/versions/node/v24.13.0/bin/npm</string>
    <string>run</string>
    <string>daily:apply</string>
  </array>
  <key>StartCalendarInterval</key><array>
    <dict>
      <key>Hour</key><integer>20</integer>
      <key>Minute</key><integer>0</integer>
    </dict>
  </array>
  <key>StandardOutPath</key><string>/Users/jeffconn/Library/Logs/services/launchd-cloudbeds-rates-daily.log</string>
  <key>StandardErrorPath</key><string>/Users/jeffconn/Library/Logs/services/launchd-cloudbeds-rates-daily.log</string>
</dict></plist>
EOP
launchctl bootout "gui/$(id -u)/com.triple3.svc-cloudbeds-rates-daily" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "  rescheduled: daily 20:00 local + 0-15min jitter"
REMOTE_SCHED

echo "==> 3/4 archive stale Jul-Aug collision-era runs (metadata only)"
ssh "$MINI" 'set -a; . "$HOME/Services/etc/cloudbeds-rates.env"; set +a; cd "$HOME/Services/cloudbeds-rates" && "$HOME/.nvm/versions/node/v24.13.0/bin/node" --no-warnings --input-type=module -e "
const ids = [
  \"run_20260511104200_908475ed\",
  \"run_20260720140337_cb074b22\",
  \"run_20260723140354_cb3cf074\",
  \"run_20260725140826_3b75b0a6\",
  \"run_20260727140659_97171f05\",
  \"run_20260728142045_7f2060c1\",
  \"run_20260731140608_9e0dbbfc\",
  \"run_20260802140713_a873ad29\",
  \"run_20260803144453_603a3709\",
  \"run_20260806142700_378bbdc2\",
  \"run_20260809140401_8685a921\",
  \"run_20260818140501_116102bf\",
  \"run_20260824140355_60e930bf\",
  \"run_20260825142846_0070067c\",
];
const m = await import(\"./server.mjs\");
if (m.initializeStorage) await m.initializeStorage();
for (const id of ids) {
  try {
    await m.archiveRun(id, { operator: \"zeke-recovery\", reason: \"stale after Jul-Aug PIE collision era; superseded; smoother single-homed on Mac mini 2026-08-28\" });
    console.log(\"archived\", id);
  } catch (e) {
    console.log(\"SKIP\", id, \"-\", e.message);
  }
}
"'

echo "==> 4/4 verify ledger + schedule"
ssh "$MINI" 'cd "$HOME/Services/cloudbeds-rates/data/runs" && python3 -c "
import json, glob, collections
c = collections.Counter()
bad = []
for f in glob.glob(\"run_*.json\"):
    try: s = json.load(open(f)).get(\"status\",\"?\")
    except Exception: s = \"unreadable\"
    c[s] += 1
    if s in (\"running\",\"paused\"): bad.append(f)
print(\"ledger:\", dict(c))
print(\"VERIFY:\", \"PASS - no active non-clean runs\" if not bad else \"FAIL: \" + \", \".join(bad))
"'
echo "DONE — next smoother run: tonight/tomorrow 20:00 ET (+jitter). VPS units: gone with the droplet."
