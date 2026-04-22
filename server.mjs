import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import express from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DRAFTS_DIR = path.join(DATA_DIR, "drafts");
const BACKUPS_DIR = path.join(DATA_DIR, "backups");
const AUDIT_DB = path.join(DATA_DIR, "audit.sqlite");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT ?? "3787");
const CLOUDBEDS_BASE_URL = "https://api.cloudbeds.com/api/v1.3";

const TARGET_PROPERTY_ID = process.env.CLOUDBEDS_PROPERTY_ID ?? "";
const TARGET_PROPERTY_NAME = process.env.CLOUDBEDS_PROPERTY_NAME ?? "Berlin Encore";
const API_KEY = process.env.CLOUDBEDS_API_KEY ?? "";
const WRITES_ENABLED = String(process.env.ENABLE_CLOUDBEDS_WRITES ?? "").toLowerCase() === "true";
const MAX_FETCH_DAYS = Number(process.env.MAX_FETCH_DAYS ?? "45");
const MAX_DRAFT_DAYS = Number(process.env.MAX_DRAFT_DAYS ?? "1");
const MAX_DRAFT_CHANGES = Number(process.env.MAX_DRAFT_CHANGES ?? "20");
const MAX_APPLY_CHANGES = Number(process.env.MAX_APPLY_CHANGES ?? "20");

let auditDb;

function requireConfig() {
  if (!API_KEY) throw new Error("CLOUDBEDS_API_KEY is missing.");
  if (!TARGET_PROPERTY_ID) throw new Error("CLOUDBEDS_PROPERTY_ID is missing.");
  if (API_KEY.startsWith("CLOUDBEDS_API_KEY=")) {
    throw new Error("CLOUDBEDS_API_KEY must be the raw key, not a prefixed assignment.");
  }
}

function isoNow() {
  return new Date().toISOString();
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function hashDraftPayload(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function batchId(prefix = "draft") {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = crypto.randomBytes(4).toString("hex");
  return `${prefix}_${stamp}_${suffix}`;
}

function assertDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) {
    throw new Error(`${label} must be YYYY-MM-DD.`);
  }
}

function dateToUtc(dateText) {
  return new Date(`${dateText}T00:00:00Z`);
}

function daySpan(startDate, endDate) {
  return Math.round((dateToUtc(endDate) - dateToUtc(startDate)) / 86400000);
}

function inclusiveNightCount(startDate, endDate) {
  return daySpan(startDate, nextDay(endDate));
}

function assertBatchScope(startDate, endDate, label = "Batch") {
  const days = inclusiveNightCount(startDate, endDate);
  if (days <= 0) throw new Error("endDate must be on or after startDate.");
  if (days > MAX_DRAFT_DAYS) {
    throw new Error(`${label} spans ${days} nights; current limit is ${MAX_DRAFT_DAYS}.`);
  }
}

function assertFetchScope(startDate, endDate) {
  const days = inclusiveNightCount(startDate, endDate);
  if (days <= 0) throw new Error("endDate must be on or after startDate.");
  if (days > MAX_FETCH_DAYS) {
    throw new Error(`Fetch spans ${days} nights; current limit is ${MAX_FETCH_DAYS}.`);
  }
}

function enumerateNights(startDate, endDate) {
  assertDate(startDate, "startDate");
  assertDate(endDate, "endDate");
  assertFetchScope(startDate, endDate);
  const nights = [];
  const cursor = dateToUtc(startDate);
  const last = dateToUtc(endDate);
  while (cursor <= last) {
    const date = cursor.toISOString().slice(0, 10);
    nights.push({ date, checkoutDate: nextDay(date) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return nights;
}

function nextDay(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function smoothRate(rate) {
  return Number(Math.trunc(Number(rate)).toFixed(2));
}

function money(value) {
  return Number(Number(value).toFixed(2));
}

function ratesEqual(left, right) {
  return Math.abs(money(left) - money(right)) < 0.005;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDataDirs() {
  await fs.mkdir(DRAFTS_DIR, { recursive: true });
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
}

function initAuditDb() {
  auditDb = new DatabaseSync(AUDIT_DB);
  auditDb.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      type TEXT NOT NULL,
      operator TEXT,
      entity_type TEXT,
      entity_id TEXT,
      property_id TEXT,
      start_date TEXT,
      end_date TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id);
  `);
}

function auditEvent({ type, operator = "system", entityType = null, entityId = null, startDate = null, endDate = null, payload = {} }) {
  if (!auditDb) return;
  auditDb
    .prepare(`
      INSERT INTO audit_events (
        event_id,
        created_at,
        type,
        operator,
        entity_type,
        entity_id,
        property_id,
        start_date,
        end_date,
        payload_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      crypto.randomUUID(),
      isoNow(),
      type,
      operator,
      entityType,
      entityId,
      TARGET_PROPERTY_ID,
      startDate,
      endDate,
      JSON.stringify(payload)
    );
}

function listAuditEvents(limit = 100) {
  if (!auditDb) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  return auditDb
    .prepare(`
      SELECT created_at, type, operator, entity_type, entity_id, property_id, start_date, end_date, payload_json
      FROM audit_events
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(safeLimit)
    .map((row) => ({
      createdAt: row.created_at,
      type: row.type,
      operator: row.operator,
      entityType: row.entity_type,
      entityId: row.entity_id,
      propertyId: row.property_id,
      startDate: row.start_date,
      endDate: row.end_date,
      payload: JSON.parse(row.payload_json),
    }));
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function cloudbeds(method, params = {}, init = {}) {
  requireConfig();
  const requestMethod = (init.method ?? "GET").toUpperCase();
  const headers = { "x-api-key": API_KEY, ...(init.headers ?? {}) };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const url = new URL(`${CLOUDBEDS_BASE_URL}/${method}`);
    let response;
    if (requestMethod === "POST") {
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) body.set(key, String(value));
      }
      response = await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } else {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
      response = await fetch(url, { headers });
    }

    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    const message = json.message ?? json.error ?? `Cloudbeds HTTP ${response.status}`;
    const rateLimited = response.status === 429 || /rate limit/i.test(String(message));

    if (response.ok && json.success !== false) return json;
    if (requestMethod === "GET" && rateLimited && attempt < 4) {
      await wait(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(message);
  }

  throw new Error("Cloudbeds request failed after retries.");
}

async function fetchRatePlansForNight(date, checkoutDate) {
  const json = await cloudbeds("getRatePlans", { startDate: date, endDate: checkoutDate });
  const rows = (json.data ?? []).map((row) => ({
    date,
    startDate: date,
    endDate: checkoutDate,
    rateID: String(row.rateID),
    roomTypeID: String(row.roomTypeID ?? ""),
    roomTypeName: String(row.roomTypeName ?? ""),
    ratePlanID: row.ratePlanID ? String(row.ratePlanID) : null,
    ratePlanNamePublic: row.ratePlanNamePublic ?? null,
    ratePlanNamePrivate: row.ratePlanNamePrivate ?? null,
    isDerived: Boolean(row.isDerived),
    roomsAvailable: Number(row.roomsAvailable ?? 0),
    currentRate: money(row.roomRate),
    raw: row,
  }));

  return { raw: json, rows };
}

async function fetchRatePlans(startDate, endDate) {
  const nights = enumerateNights(startDate, endDate);
  const nightlyResults = [];
  for (const night of nights) {
    nightlyResults.push(await fetchRatePlansForNight(night.date, night.checkoutDate));
    if (nights.length > 1) await wait(250);
  }
  return {
    raw: {
      success: true,
      startDate,
      endDate,
      nights: nightlyResults.map((result, index) => ({
        date: nights[index].date,
        checkoutDate: nights[index].checkoutDate,
        response: result.raw,
      })),
    },
    rows: nightlyResults.flatMap((result) => result.rows),
  };
}

function targetRowsForDraft(rows) {
  return rows.filter((row) => !row.isDerived && !row.ratePlanID && !row.ratePlanNamePublic);
}

async function createDraft({ startDate, endDate, operator = "local", notes = "" }) {
  assertDate(startDate, "startDate");
  assertDate(endDate, "endDate");
  assertBatchScope(startDate, endDate, "Draft");

  const fetched = await fetchRatePlans(startDate, endDate);
  const targets = targetRowsForDraft(fetched.rows);
  const changes = targets
    .map((row) => {
      const proposedRate = smoothRate(row.currentRate);
      return {
        rateID: row.rateID,
        roomTypeID: row.roomTypeID,
        roomTypeName: row.roomTypeName,
        date: row.date,
        startDate: row.startDate,
        endDate: row.endDate,
        currentRate: row.currentRate,
        proposedRate,
        changed: proposedRate !== row.currentRate,
        isDerived: row.isDerived,
      };
    })
    .filter((change) => change.changed);
  if (changes.length > MAX_DRAFT_CHANGES) {
    throw new Error(`Draft has ${changes.length} changes; current limit is ${MAX_DRAFT_CHANGES}.`);
  }

  const id = batchId("draft");
  const snapshotId = id.replace(/^draft_/, "backup_");
  const createdAt = isoNow();
  const draftPayload = {
    id,
    backupId: snapshotId,
    propertyId: TARGET_PROPERTY_ID,
    propertyName: TARGET_PROPERTY_NAME,
    startDate,
    endDate,
    operator,
    notes,
    createdAt,
    rule: "truncate cents to .00",
    status: "draft",
    changes,
  };
  const hash = hashDraftPayload(draftPayload);
  const draft = { ...draftPayload, hash, appliedAt: null, jobs: [], verification: [] };
  const backup = {
    id: snapshotId,
    draftId: id,
    propertyId: TARGET_PROPERTY_ID,
    propertyName: TARGET_PROPERTY_NAME,
    startDate,
    endDate,
    createdAt,
    operator,
    hash,
    rawCloudbedsResponse: fetched.raw,
    normalizedRows: fetched.rows,
    rollbackChanges: changes.map((change) => ({
      rateID: change.rateID,
      roomTypeName: change.roomTypeName,
      date: change.date,
      startDate: change.startDate,
      endDate: change.endDate,
      restoreRate: change.currentRate,
      expectedCurrentRate: change.proposedRate,
    })),
  };

  await writeJson(path.join(DRAFTS_DIR, `${id}.json`), draft);
  await writeJson(path.join(BACKUPS_DIR, `${snapshotId}.json`), backup);
  auditEvent({
    type: "draft_created",
    operator,
    entityType: "draft",
    entityId: id,
    startDate,
    endDate,
    payload: {
      backupId: snapshotId,
      changeCount: changes.length,
      hash,
      notes,
      maxFetchDays: MAX_FETCH_DAYS,
      maxDraftDays: MAX_DRAFT_DAYS,
      maxDraftChanges: MAX_DRAFT_CHANGES,
    },
  });
  return draft;
}

async function listDrafts() {
  await ensureDataDirs();
  const files = await fs.readdir(DRAFTS_DIR).catch(() => []);
  const drafts = await Promise.all(
    files.filter((file) => file.endsWith(".json")).map((file) => readJson(path.join(DRAFTS_DIR, file)))
  );
  return drafts
    .map(({ id, propertyName, startDate, endDate, createdAt, status, changes, appliedAt }) => ({
      id,
      propertyName,
      startDate,
      endDate,
      createdAt,
      status,
      appliedAt,
      changeCount: changes.length,
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function listBackups() {
  await ensureDataDirs();
  const files = await fs.readdir(BACKUPS_DIR).catch(() => []);
  const backups = await Promise.all(
    files.filter((file) => file.endsWith(".json")).map((file) => readJson(path.join(BACKUPS_DIR, file)))
  );
  return backups
    .map(({ id, draftId, propertyName, startDate, endDate, createdAt, rollbackChanges }) => ({
      id,
      draftId,
      propertyName,
      startDate,
      endDate,
      createdAt,
      rollbackCount: rollbackChanges.length,
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function getDraft(id) {
  if (!/^draft_\d+_[a-f0-9]{8}$/.test(id)) throw new Error("Invalid draft id.");
  return readJson(path.join(DRAFTS_DIR, `${id}.json`));
}

async function getBackup(id) {
  if (!/^backup_\d+_[a-f0-9]{8}$/.test(id)) throw new Error("Invalid backup id.");
  return readJson(path.join(BACKUPS_DIR, `${id}.json`));
}

async function createRollbackDraftFromBackup(id, operator = "local") {
  const sourceBackup = await getBackup(id);
  assertBatchScope(sourceBackup.startDate, sourceBackup.endDate, "Rollback draft");
  const fetched = await fetchRatePlans(sourceBackup.startDate, sourceBackup.endDate);
  const changes = sourceBackup.rollbackChanges.map((rollback) => {
    const liveRow = fetched.rows.find((row) => row.rateID === rollback.rateID && row.date === (rollback.date ?? rollback.startDate));
    return {
      rateID: rollback.rateID,
      roomTypeID: liveRow?.roomTypeID ?? "",
      roomTypeName: rollback.roomTypeName,
      date: rollback.date ?? rollback.startDate,
      startDate: rollback.startDate,
      endDate: rollback.endDate,
      currentRate: liveRow?.currentRate ?? null,
      proposedRate: money(rollback.restoreRate),
      changed: liveRow ? money(liveRow.currentRate) !== money(rollback.restoreRate) : true,
      expectedCurrentRate: rollback.expectedCurrentRate,
      conflict: liveRow ? money(liveRow.currentRate) !== money(rollback.expectedCurrentRate) : true,
      isDerived: false,
    };
  });

  const rollbackDraftId = batchId("draft");
  const backupId = rollbackDraftId.replace(/^draft_/, "backup_");
  const createdAt = isoNow();
  const draftPayload = {
    id: rollbackDraftId,
    backupId,
    sourceBackupId: sourceBackup.id,
    propertyId: sourceBackup.propertyId,
    propertyName: sourceBackup.propertyName,
    startDate: sourceBackup.startDate,
    endDate: sourceBackup.endDate,
    operator,
    notes: `Rollback draft from ${sourceBackup.id}`,
    createdAt,
    rule: `restore rates from ${sourceBackup.id}`,
    status: "draft",
    changes: changes.filter((change) => change.changed),
  };
  if (draftPayload.changes.length > MAX_DRAFT_CHANGES) {
    throw new Error(`Rollback draft has ${draftPayload.changes.length} changes; current limit is ${MAX_DRAFT_CHANGES}.`);
  }
  const hash = hashDraftPayload(draftPayload);
  const draft = { ...draftPayload, hash, appliedAt: null, jobs: [], verification: [] };
  const backup = {
    id: backupId,
    draftId: rollbackDraftId,
    sourceBackupId: sourceBackup.id,
    propertyId: sourceBackup.propertyId,
    propertyName: sourceBackup.propertyName,
    startDate: sourceBackup.startDate,
    endDate: sourceBackup.endDate,
    createdAt,
    operator,
    hash,
    rawCloudbedsResponse: fetched.raw,
    normalizedRows: fetched.rows,
    rollbackChanges: draft.changes.map((change) => ({
      rateID: change.rateID,
      roomTypeName: change.roomTypeName,
      date: change.date,
      startDate: change.startDate,
      endDate: change.endDate,
      restoreRate: change.currentRate,
      expectedCurrentRate: change.proposedRate,
    })),
  };

  await writeJson(path.join(DRAFTS_DIR, `${rollbackDraftId}.json`), draft);
  await writeJson(path.join(BACKUPS_DIR, `${backupId}.json`), backup);
  auditEvent({
    type: "rollback_draft_created",
    operator,
    entityType: "draft",
    entityId: rollbackDraftId,
    startDate: sourceBackup.startDate,
    endDate: sourceBackup.endDate,
    payload: {
      sourceBackupId: sourceBackup.id,
      backupId,
      changeCount: draft.changes.length,
      conflictCount: draft.changes.filter((change) => change.conflict).length,
      hash,
      maxFetchDays: MAX_FETCH_DAYS,
      maxDraftDays: MAX_DRAFT_DAYS,
      maxDraftChanges: MAX_DRAFT_CHANGES,
    },
  });
  return draft;
}

async function pollJob(jobReferenceID) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const json = await cloudbeds("getRateJobs", { jobReferenceID });
    const job = json.data?.[0];
    if (job?.status && !["queued", "processing", "in_progress"].includes(job.status)) return job;
    await wait(1500);
  }
  const json = await cloudbeds("getRateJobs", { jobReferenceID });
  return json.data?.[0] ?? { jobReferenceID, status: "unknown", updates: [] };
}

async function applyDraft(id, confirmation) {
  const draft = await getDraft(id);
  if (!WRITES_ENABLED) throw new Error("Writes are disabled. Set ENABLE_CLOUDBEDS_WRITES=true to apply drafts.");
  if (draft.status === "applied") throw new Error("Draft has already been applied.");
  if (confirmation !== "yes") throw new Error("Apply confirmation is required.");
  if (draft.changes.length > MAX_APPLY_CHANGES) {
    throw new Error(`Draft has ${draft.changes.length} changes; current apply limit is ${MAX_APPLY_CHANGES}.`);
  }
  if (draft.changes.some((change) => change.conflict)) {
    throw new Error("Draft has rollback conflicts; review before applying.");
  }

  const payloadForHash = {
    id: draft.id,
    backupId: draft.backupId,
    ...(draft.sourceBackupId ? { sourceBackupId: draft.sourceBackupId } : {}),
    propertyId: draft.propertyId,
    propertyName: draft.propertyName,
    startDate: draft.startDate,
    endDate: draft.endDate,
    operator: draft.operator,
    notes: draft.notes,
    createdAt: draft.createdAt,
    rule: draft.rule,
    status: "draft",
    changes: draft.changes,
  };
  if (hashDraftPayload(payloadForHash) !== draft.hash) throw new Error("Draft hash mismatch; refusing to apply.");
  auditEvent({
    type: "draft_apply_started",
    operator: draft.operator,
    entityType: "draft",
    entityId: draft.id,
    startDate: draft.startDate,
    endDate: draft.endDate,
    payload: { changeCount: draft.changes.length, hash: draft.hash },
  });

  const jobs = [];
  for (const change of draft.changes) {
    const response = await cloudbeds(
      "putRate",
      {
        "rates[0][rateID]": change.rateID,
        "rates[0][interval][0][startDate]": change.startDate,
        "rates[0][interval][0][endDate]": change.endDate,
        "rates[0][interval][0][rate]": change.proposedRate.toFixed(2),
      },
      { method: "POST" }
    );
    jobs.push({ rateID: change.rateID, proposedRate: change.proposedRate, jobReferenceID: response.jobReferenceID });
  }

  const completedJobs = [];
  for (const job of jobs) {
    completedJobs.push({ ...job, cloudbedsJob: await pollJob(job.jobReferenceID) });
  }

  const readback = await fetchRatePlans(draft.startDate, draft.endDate);
  const verification = draft.changes.map((change) => {
    const row = readback.rows.find((candidate) => candidate.rateID === change.rateID && candidate.date === change.date);
    return {
      rateID: change.rateID,
      roomTypeName: change.roomTypeName,
      date: change.date,
      expectedRate: change.proposedRate,
      actualRate: row?.currentRate ?? null,
      verified: row ? ratesEqual(row.currentRate, change.proposedRate) : false,
    };
  });

  const applied = {
    ...draft,
    status: verification.every((item) => item.verified) ? "applied" : "verification_failed",
    appliedAt: isoNow(),
    jobs: completedJobs,
    verification,
  };
  await writeJson(path.join(DRAFTS_DIR, `${id}.json`), applied);
  auditEvent({
    type: "draft_apply_finished",
    operator: draft.operator,
    entityType: "draft",
    entityId: draft.id,
    startDate: draft.startDate,
    endDate: draft.endDate,
    payload: {
      status: applied.status,
      jobReferenceIDs: completedJobs.map((job) => job.jobReferenceID),
      verifiedCount: verification.filter((item) => item.verified).length,
      changeCount: draft.changes.length,
    },
  });
  return applied;
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/api/config", (_req, res) => {
  res.json({
    propertyId: TARGET_PROPERTY_ID,
    propertyName: TARGET_PROPERTY_NAME,
    writesEnabled: WRITES_ENABLED,
    limits: {
      maxDraftDays: MAX_DRAFT_DAYS,
      maxFetchDays: MAX_FETCH_DAYS,
      maxDraftChanges: MAX_DRAFT_CHANGES,
      maxApplyChanges: MAX_APPLY_CHANGES,
    },
  });
});

app.get("/api/rates", async (req, res) => {
  try {
    const startDate = String(req.query.startDate ?? "");
    const endDate = String(req.query.endDate ?? nextDay(startDate));
    assertDate(startDate, "startDate");
    assertDate(endDate, "endDate");
    const fetched = await fetchRatePlans(startDate, endDate);
    res.json({
      propertyId: TARGET_PROPERTY_ID,
      propertyName: TARGET_PROPERTY_NAME,
      startDate,
      endDate,
      rows: fetched.rows.map(({ raw, ...row }) => ({
        ...row,
        targetByDefault: targetRowsForDraft(fetched.rows).some((target) => target.rateID === row.rateID && target.date === row.date),
        proposedRate: smoothRate(row.currentRate),
      })),
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/drafts", async (_req, res) => {
  try {
    res.json({ drafts: await listDrafts() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/drafts/:id", async (req, res) => {
  try {
    res.json({ draft: await getDraft(req.params.id) });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get("/api/backups", async (_req, res) => {
  try {
    res.json({ backups: await listBackups() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/backups/:id", async (req, res) => {
  try {
    res.json({ backup: await getBackup(req.params.id) });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get("/api/audit", async (req, res) => {
  try {
    res.json({ events: listAuditEvents(req.query.limit) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/backups/:id/rollback-draft", async (req, res) => {
  try {
    const draft = await createRollbackDraftFromBackup(req.params.id, req.body?.operator ?? "web-app");
    res.status(201).json({ draft });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/drafts", async (req, res) => {
  try {
    const draft = await createDraft(req.body ?? {});
    res.status(201).json({ draft });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/drafts/:id/apply", async (req, res) => {
  try {
    const draft = await applyDraft(req.params.id, req.body?.confirmation ?? "");
    res.json({ draft });
  } catch (error) {
    auditEvent({
      type: "draft_apply_failed",
      operator: "web-app",
      entityType: "draft",
      entityId: req.params.id,
      payload: { error: error.message },
    });
    res.status(400).json({ error: error.message });
  }
});

app.use((_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

await ensureDataDirs();
initAuditDb();
app.listen(PORT, () => {
  console.log(`Cloudbeds Rates app running at http://localhost:${PORT}`);
});
