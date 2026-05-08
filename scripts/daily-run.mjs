#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import {
  applyRun,
  createRun,
  getDataDir,
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
  --days-ahead <n>       Inclusive night count. Defaults to DAILY_RUN_DAYS_AHEAD or 365.
  --operator <name>      Operator label for run/audit history. Defaults to daily-run.
  --apply                Apply the planned run. Also requires ENABLE_CLOUDBEDS_WRITES=true.
  --force-new            Create a new run even if today's automation key already exists.
  --help                 Show this help.
`;
}

function parseArgs(argv) {
  const options = {
    apply: false,
    forceNew: false,
    operator: process.env.DAILY_RUN_OPERATOR ?? "daily-run",
    properties: [],
    startDate: process.env.DAILY_RUN_START_DATE ?? null,
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
    } else if (arg === "--force-new") {
      options.forceNew = true;
    } else if (arg === "--property") {
      options.properties.push(...next().split(",").map((value) => value.trim()).filter(Boolean));
    } else if (arg === "--start-date") {
      options.startDate = next();
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

async function findExistingRun(automationKey) {
  const runs = await listRuns();
  const existing = runs.find((run) => run.automationKey === automationKey);
  return existing ? getRun(existing.id) : null;
}

async function runProperty(propertyKey, options) {
  const property = resolveProperty(propertyKey);
  const startDate = options.startDate ?? dateDaysFromNow(1);
  const endDate = addDays(startDate, options.daysAhead - 1);
  const automationDate = new Date().toISOString().slice(0, 10);
  const automationKey = `daily-smooth:${automationDate}:${property.key}:${startDate}:${endDate}`;
  const notes = `daily-run ${automationDate}; property=${property.key}; window=${startDate}..${endDate}`;

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
    return { run: appliedRun, applied: true };
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

  const lines = results.map(({ run, applied }) => `${applied ? "APPLIED" : "PLANNED"} ${run.id}: ${summarize(run)}`);
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
