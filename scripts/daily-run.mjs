#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import {
  applyRun,
  createRollbackRunFromRun,
  createRun,
  getDataDir,
  getDraft,
  getRun,
  initializeStorage,
  listRuns,
  resolveProperty,
} from "../server.mjs";

function usage() {
  return `Usage:
  node scripts/daily-run.mjs --property berlin-encore --days-ahead 365 [--apply]

Options:
  --property <key>       Cloudbeds property key. Repeat or comma-separate for multiple properties.
  --start-date <date>    First inclusive night to smooth. Defaults to tomorrow UTC.
  --start-offset-days <n>
                         First inclusive night as n days from today's UTC date.
  --days-ahead <n>       Inclusive night count. Defaults to DAILY_RUN_DAYS_AHEAD or 365.
  --operator <name>      Operator label for run/audit history. Defaults to daily-run.
  --apply                Apply the planned run. Also requires ENABLE_CLOUDBEDS_WRITES=true.
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
    properties: [],
    startDate: process.env.DAILY_RUN_START_DATE ?? null,
    startOffsetDays:
      process.env.DAILY_RUN_START_OFFSET_DAYS === undefined
        ? null
        : Number(process.env.DAILY_RUN_START_OFFSET_DAYS),
    daysAhead: Number(process.env.DAILY_RUN_DAYS_AHEAD ?? "365"),
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

  return options;
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

  const rollbackRun = await createRollbackRunFromRun(appliedRun.id, `${operator}-rollback-readiness`);
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
  const endDate = addDays(startDate, options.daysAhead - 1);
  const automationDate = new Date().toISOString().slice(0, 10);
  const automationKey = `daily-smooth:${automationDate}:${property.key}:${startDate}:${endDate}`;
  const offsetNote = options.startOffsetDays === null ? "default-start=tomorrow" : `start-offset-days=${options.startOffsetDays}`;
  const notes = `daily-run ${automationDate}; property=${property.key}; window=${startDate}..${endDate}; ${offsetNote}`;

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

    const appliedRun = await applyRun(run.id);
    console.log(`Applied run ${appliedRun.id}: ${summarize(appliedRun)}.`);
    const rollbackReadiness = options.verifyRollbackReadiness
      ? await verifyRollbackReadiness(appliedRun, options.operator)
      : { needed: false, message: `Rollback readiness skipped for ${appliedRun.id}.` };
    console.log(rollbackReadiness.message);
    return { run: appliedRun, applied: true, rollbackReadiness };
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

  const lines = results.map(({ run, applied, rollbackReadiness }) => {
    const rollbackText = rollbackReadiness ? `; ${rollbackReadiness.message}` : "";
    return `${applied ? "APPLIED" : "PLANNED"} ${run.id}: ${summarize(run)}${rollbackText}`;
  });
  const message = `Cloudbeds daily run ${options.apply ? "apply" : "plan"} completed.\n${lines.join("\n")}`;
  console.log(message);
  await postNotification(message);
}

main().catch(async (error) => {
  const message = `Cloudbeds daily run failed: ${error.message}`;
  console.error(message);
  await postNotification(message).catch((notifyError) => {
    console.error(`Notification failed: ${notifyError.message}`);
  });
  process.exitCode = 1;
});
