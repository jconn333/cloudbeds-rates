#!/usr/bin/env node
import "dotenv/config";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  applyRun,
  createRateBackup,
  createRollbackRunFromRun,
  createRun,
  getDataDir,
  getDraft,
  getRun,
  initializeStorage,
  listRuns,
  reconcileRunVerification,
  resolveProperty,
} from "../server.mjs";

const execFileAsync = promisify(execFile);

function usage() {
  return `Usage:
  node scripts/daily-run.mjs --property berlin-encore --days-ahead 365 [--apply]

Options:
  --property <key>       Cloudbeds property key. Repeat or comma-separate for multiple properties.
  --start-date <date>    First inclusive night to smooth. Defaults to tomorrow UTC.
  --start-offset-days <n>
                         First inclusive night as n days from today's UTC date.
  --days-ahead <n>       Inclusive night count. Defaults to DAILY_RUN_DAYS_AHEAD or 365.
  --end-date-limit <date>
                         Last inclusive night the daily runner may touch.
  --operator <name>      Operator label for run/audit history. Defaults to daily-run.
  --apply                Apply the planned run. Also requires ENABLE_CLOUDBEDS_WRITES=true.
  --skip-pre-apply-backup
                         Skip the full-scope backup created immediately before apply.
  --skip-rollback-readiness
                         Skip immediate rollback-plan validation after apply.
  --force-new            Create a new run even if today's automation key already exists.
  --help                 Show this help.
`;
}

function parseArgs(argv) {
  const options = {
    apply: false,
    forceNew: false,
    operator: process.env.DAILY_RUN_OPERATOR ?? "daily-run",
    verifyRollbackReadiness: String(process.env.DAILY_RUN_VERIFY_ROLLBACK_READINESS ?? "true").toLowerCase() !== "false",
    preApplyBackup: String(process.env.DAILY_RUN_PRE_APPLY_BACKUP ?? "true").toLowerCase() !== "false",
    reconcileAttempts: Number(process.env.DAILY_RUN_RECONCILE_ATTEMPTS ?? "6"),
    reconcileDelayMs: Number(process.env.DAILY_RUN_RECONCILE_DELAY_MS ?? "30000"),
    properties: [],
    startDate: process.env.DAILY_RUN_START_DATE ?? null,
    startOffsetDays:
      process.env.DAILY_RUN_START_OFFSET_DAYS === undefined
        ? null
        : Number(process.env.DAILY_RUN_START_OFFSET_DAYS),
    daysAhead: Number(process.env.DAILY_RUN_DAYS_AHEAD ?? "365"),
    endDateLimit: process.env.DAILY_RUN_END_DATE_LIMIT ?? null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`${arg} requires a value.`);
      return argv[index];
    };

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--skip-rollback-readiness") {
      options.verifyRollbackReadiness = false;
    } else if (arg === "--skip-pre-apply-backup") {
      options.preApplyBackup = false;
    } else if (arg === "--force-new") {
      options.forceNew = true;
    } else if (arg === "--property") {
      options.properties.push(...next().split(",").map((value) => value.trim()).filter(Boolean));
    } else if (arg === "--start-date") {
      options.startDate = next();
    } else if (arg === "--start-offset-days") {
      options.startOffsetDays = Number(next());
    } else if (arg === "--days-ahead") {
      options.daysAhead = Number(next());
    } else if (arg === "--end-date-limit") {
      options.endDateLimit = next();
    } else if (arg === "--operator") {
      options.operator = next();
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.properties.length) {
    const envProperties = process.env.DAILY_RUN_PROPERTIES ?? process.env.CLOUDBEDS_DEFAULT_PROPERTY ?? "berlin-encore";
    options.properties = envProperties.split(",").map((value) => value.trim()).filter(Boolean);
  }

  if (!Number.isInteger(options.daysAhead) || options.daysAhead <= 0) {
    throw new Error("--days-ahead must be a positive integer.");
  }
  if (options.startDate && options.startOffsetDays !== null) {
    throw new Error("Use either --start-date or --start-offset-days, not both.");
  }
  if (
    options.startOffsetDays !== null &&
    (!Number.isInteger(options.startOffsetDays) || options.startOffsetDays < 0)
  ) {
    throw new Error("--start-offset-days must be a non-negative integer.");
  }
  if (options.endDateLimit && !isIsoDate(options.endDateLimit)) {
    throw new Error("--end-date-limit must be YYYY-MM-DD.");
  }

  return options;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""));
}

function dateDaysFromNow(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasPostApplyVerificationFailure(run) {
  return run.chunks.some((chunk) => ["verification_failed", "partial_apply_failed"].includes(chunk.status));
}

async function withLock(name, fn) {
  const lockFile = path.join(getDataDir(), "locks", `${name}.lock`);
  const staleMinutes = Number(process.env.DAILY_RUN_LOCK_STALE_MINUTES ?? "240");

  try {
    const stat = await fs.stat(lockFile);
    const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
    if (ageMinutes > staleMinutes) await fs.unlink(lockFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let handle;
  try {
    handle = await fs.open(lockFile, "wx");
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another daily run is already active (${lockFile}).`);
    throw error;
  }

  try {
    return await fn();
  } finally {
    await handle?.close();
    await fs.unlink(lockFile).catch(() => {});
  }
}

async function postNotification(text) {
  const url = process.env.DAILY_RUN_WEBHOOK_URL;
  if (!url) return;

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(`Daily-run notification failed with HTTP ${response.status}.`);
  }
}

async function runBackupSync(stage, context = {}) {
  const command = process.env.DAILY_RUN_BACKUP_SYNC_COMMAND;
  if (!command) return;

  const env = {
    ...process.env,
    DAILY_RUN_SYNC_STAGE: stage,
    DAILY_RUN_SYNC_PROPERTY: context.propertyKey ?? "",
    DAILY_RUN_SYNC_RUN_ID: context.runId ?? "",
    DAILY_RUN_SYNC_BACKUP_ID: context.backupId ?? "",
    DAILY_RUN_SYNC_START_DATE: context.startDate ?? "",
    DAILY_RUN_SYNC_END_DATE: context.endDate ?? "",
  };
  await execFileAsync("/bin/sh", ["-lc", command], {
    cwd: process.cwd(),
    env,
    maxBuffer: 1024 * 1024 * 10,
  });
  console.log(`Backup sync command completed for ${stage}.`);
}

function summarize(run) {
  return `${run.propertyName} ${run.startDate}..${run.endDate}: ${run.status}, ${run.totalChanges} change(s), ${run.chunkCount} chunk(s)`;
}

async function verifyRollbackReadiness(appliedRun, operator) {
  if (appliedRun.status !== "applied") {
    throw new Error(`Rollback readiness requires an applied run; ${appliedRun.id} is ${appliedRun.status}.`);
  }
  if (!appliedRun.totalChanges) {
    return {
      needed: false,
      message: `Rollback readiness not needed for ${appliedRun.id}; no rates changed.`,
    };
  }

  const rollbackRun = await createRollbackRunFromRun(appliedRun.id, `${operator}-rollback-readiness`, {
    readinessOnly: true,
  });
  let draftCount = 0;
  let changeCount = 0;
  let conflictCount = 0;
  const conflictSamples = [];

  for (const chunk of rollbackRun.chunks) {
    if (!chunk.draftId || !chunk.backupId) {
      throw new Error(`Rollback readiness failed for ${rollbackRun.id}; chunk ${chunk.sequence} is missing a draft or backup.`);
    }
    const draft = await getDraft(chunk.draftId);
    draftCount += 1;
    changeCount += draft.changes.length;
    const conflicts = draft.changes.filter((change) => change.conflict);
    conflictCount += conflicts.length;
    for (const conflict of conflicts.slice(0, 3 - conflictSamples.length)) {
      conflictSamples.push({
        roomTypeName: conflict.roomTypeName,
        date: conflict.date,
        currentRate: conflict.currentRate,
        expectedCurrentRate: conflict.expectedCurrentRate,
        proposedRate: conflict.proposedRate,
      });
    }
  }

  if (conflictCount) {
    throw new Error(
      `Rollback readiness failed for ${appliedRun.id}; rollback run ${rollbackRun.id} has ${conflictCount} conflict(s). Samples: ${JSON.stringify(conflictSamples)}`
    );
  }

  return {
    needed: true,
    rollbackRunId: rollbackRun.id,
    draftCount,
    changeCount,
    conflictCount,
    message: `Rollback readiness passed for ${appliedRun.id}; rollback run ${rollbackRun.id} has ${draftCount} draft(s), ${changeCount} change(s), and 0 conflicts.`,
  };
}

async function createPreApplyBackup(property, startDate, endDate, operator, automationKey) {
  const backup = await createRateBackup({
    propertyKey: property.key,
    startDate,
    endDate,
    operator: `${operator}-pre-apply-backup`,
    notes: `pre-apply backup for ${automationKey}`,
  });
  console.log(
    `Created pre-apply backup ${backup.id}: ${backup.propertyName} ${backup.startDate}..${backup.endDate}; ${backup.baseRowsSnapshot.length} base row(s).`
  );
  await runBackupSync("pre-apply-backup", {
    propertyKey: property.key,
    backupId: backup.id,
    startDate,
    endDate,
  });
  return backup;
}

async function reconcileAppliedRun(run, options) {
  let currentRun = run;
  for (let attempt = 1; attempt <= options.reconcileAttempts; attempt += 1) {
    if (currentRun.status === "applied") return currentRun;
    if (attempt > 1 && options.reconcileDelayMs > 0) await wait(options.reconcileDelayMs);
    currentRun = await reconcileRunVerification(currentRun.id, {
      operator: `${options.operator}-late-reconcile`,
      attempts: 1,
      delayMs: 0,
    });
    if (currentRun.status === "applied") {
      console.log(`Late reconcile verified ${currentRun.id} on attempt ${attempt}.`);
      return currentRun;
    }
    const message = currentRun.progress?.message ?? `${currentRun.id} remains ${currentRun.status}`;
    console.log(`Late reconcile attempt ${attempt}/${options.reconcileAttempts} did not verify ${currentRun.id}: ${message}`);
  }
  return currentRun;
}

async function findExistingRun(automationKey) {
  const runs = await listRuns();
  const existing = runs.find((run) => run.automationKey === automationKey);
  return existing ? getRun(existing.id) : null;
}

async function runProperty(propertyKey, options) {
  const property = resolveProperty(propertyKey);
  const startDate =
    options.startDate ??
    (options.startOffsetDays === null ? dateDaysFromNow(1) : dateDaysFromNow(options.startOffsetDays));
  let endDate = addDays(startDate, options.daysAhead - 1);
  if (options.endDateLimit && startDate > options.endDateLimit) {
    const message = `Skipping ${property.propertyName}; ${startDate} is after end-date limit ${options.endDateLimit}.`;
    console.log(message);
    return { skipped: true, message, applied: false };
  }
  if (options.endDateLimit && endDate > options.endDateLimit) {
    endDate = options.endDateLimit;
  }
  const automationDate = new Date().toISOString().slice(0, 10);
  const automationKey = `daily-smooth:${automationDate}:${property.key}:${startDate}:${endDate}`;
  const offsetNote = options.startOffsetDays === null ? "default-start=tomorrow" : `start-offset-days=${options.startOffsetDays}`;
  const limitNote = options.endDateLimit ? `; end-date-limit=${options.endDateLimit}` : "";
  const notes = `daily-run ${automationDate}; property=${property.key}; window=${startDate}..${endDate}; ${offsetNote}${limitNote}`;

  return withLock(`daily-${property.key}`, async () => {
    let run = options.forceNew ? null : await findExistingRun(automationKey);
    if (run) {
      console.log(`Found existing run for ${automationKey}: ${run.id} (${run.status}).`);
    } else {
      run = await createRun({
        propertyKey: property.key,
        startDate,
        endDate,
        operator: options.operator,
        notes,
        automationKey,
      });
      console.log(`Created run ${run.id}: ${summarize(run)}.`);
    }

    if (!options.apply) {
      return { run, applied: false };
    }

    if (run.status === "applied") {
      console.log(`Run ${run.id} already applied; skipping.`);
      return { run, applied: false };
    }
    if (run.status !== "planned") {
      throw new Error(`Run ${run.id} is ${run.status}; refusing unattended apply.`);
    }

    const preApplyBackup = options.preApplyBackup
      ? await createPreApplyBackup(property, startDate, endDate, options.operator, automationKey)
      : null;
    let appliedRun = await applyRun(run.id);
    console.log(`Applied run ${appliedRun.id}: ${summarize(appliedRun)}.`);
    if (appliedRun.status !== "applied" && hasPostApplyVerificationFailure(appliedRun)) {
      appliedRun = await reconcileAppliedRun(appliedRun, options);
    }
    const rollbackReadiness = options.verifyRollbackReadiness
      ? await verifyRollbackReadiness(appliedRun, options.operator)
      : { needed: false, message: `Rollback readiness skipped for ${appliedRun.id}.` };
    console.log(rollbackReadiness.message);
    await runBackupSync("post-rollback-readiness", {
      propertyKey: property.key,
      runId: appliedRun.id,
      backupId: preApplyBackup?.id ?? "",
      startDate,
      endDate,
    });
    return { run: appliedRun, applied: true, rollbackReadiness, preApplyBackup };
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  await initializeStorage();
  const results = [];

  for (const propertyKey of options.properties) {
    results.push(await runProperty(propertyKey, options));
  }

  const lines = results.map(({ run, applied, rollbackReadiness, preApplyBackup, skipped, message }) => {
    if (skipped) return `SKIPPED: ${message}`;
    const backupText = preApplyBackup ? `; pre-apply backup ${preApplyBackup.id}` : "";
    const rollbackText = rollbackReadiness ? `; ${rollbackReadiness.message}` : "";
    return `${applied ? "APPLIED" : "PLANNED"} ${run.id}: ${summarize(run)}${backupText}${rollbackText}`;
  });
  const message = `Cloudbeds daily run ${options.apply ? "apply" : "plan"} completed.\n${lines.join("\n")}`;
  console.log(message);
  await postNotification(message).catch((error) => {
    console.error(`Notification failed after successful daily run: ${error.message}`);
  });
}

main().catch(async (error) => {
  const message = `Cloudbeds daily run failed: ${error.message}`;
  console.error(message);
  await postNotification(message).catch((notifyError) => {
    console.error(`Notification failed: ${notifyError.message}`);
  });
  process.exitCode = 1;
});
