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
const RUNS_DIR = path.join(DATA_DIR, "runs");
const AUDIT_DB = path.join(DATA_DIR, "audit.sqlite");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT ?? "3787");
const CLOUDBEDS_BASE_URL = "https://api.cloudbeds.com/api/v1.3";

const TARGET_PROPERTY_ID = process.env.CLOUDBEDS_PROPERTY_ID ?? "";
const TARGET_PROPERTY_NAME = process.env.CLOUDBEDS_PROPERTY_NAME ?? "Berlin Encore";
const API_KEY = process.env.CLOUDBEDS_API_KEY ?? "";
const WRITES_ENABLED = String(process.env.ENABLE_CLOUDBEDS_WRITES ?? "").toLowerCase() === "true";
const MAX_FETCH_DAYS = Number(process.env.MAX_FETCH_DAYS ?? "400");
const MAX_DRAFT_DAYS = Number(process.env.MAX_DRAFT_DAYS ?? "7");
const MAX_DRAFT_CHANGES = Number(process.env.MAX_DRAFT_CHANGES ?? "100");
const MAX_APPLY_CHANGES = Number(process.env.MAX_APPLY_CHANGES ?? "100");
const MAX_RUN_DAYS = Number(process.env.MAX_RUN_DAYS ?? "400");
const RUN_CHUNK_MAX_CHANGES = Number(process.env.RUN_CHUNK_MAX_CHANGES ?? "80");
const RUN_CHUNK_MAX_NIGHTS = Number(process.env.RUN_CHUNK_MAX_NIGHTS ?? "7");
const VERIFY_RETRY_ATTEMPTS = Number(process.env.VERIFY_RETRY_ATTEMPTS ?? "4");
const VERIFY_RETRY_DELAY_MS = Number(process.env.VERIFY_RETRY_DELAY_MS ?? "3000");
const SAFETY_METADATA = {
  writeIntervalMode: "same_day",
  verificationMode: "targeted_scope_adjacent",
  backupSnapshotMode: "full_base_scope",
  correctiveDraftMode: "spill_repair_v1",
};

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

function buildDraftPayload({
  id,
  backupId,
  propertyId,
  propertyName,
  startDate,
  endDate,
  operator,
  notes,
  createdAt,
  rule,
  status = "draft",
  changes,
  sourceRunId = null,
  sourceChunkId = null,
  sourceBackupId = null,
}) {
  return {
    id,
    backupId,
    propertyId,
    propertyName,
    startDate,
    endDate,
    operator,
    notes,
    createdAt,
    rule,
    status,
    changes,
    ...(sourceRunId ? { sourceRunId } : {}),
    ...(sourceChunkId ? { sourceChunkId } : {}),
    ...(sourceBackupId ? { sourceBackupId } : {}),
  };
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

function assertRunScope(startDate, endDate) {
  const days = inclusiveNightCount(startDate, endDate);
  if (days <= 0) throw new Error("endDate must be on or after startDate.");
  if (days > MAX_RUN_DAYS) {
    throw new Error(`Run spans ${days} nights; current limit is ${MAX_RUN_DAYS}.`);
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

function minDate(values) {
  return [...values].sort()[0] ?? null;
}

function maxDate(values) {
  return [...values].sort().at(-1) ?? null;
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
  await fs.mkdir(RUNS_DIR, { recursive: true });
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

function listAuditEventsForEntity(entityType, entityId, limit = 100) {
  if (!auditDb) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  return auditDb
    .prepare(`
      SELECT created_at, type, operator, entity_type, entity_id, property_id, start_date, end_date, payload_json
      FROM audit_events
      WHERE entity_type = ? AND entity_id = ?
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(entityType, entityId, safeLimit)
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

async function fetchBaseRowsForDates(dates) {
  const uniqueDates = [...new Set(dates.filter(Boolean))].sort();
  const nightlyResults = [];
  for (const date of uniqueDates) {
    nightlyResults.push(await fetchRatePlansForNight(date, nextDay(date)));
    if (uniqueDates.length > 1) await wait(250);
  }
  return nightlyResults.flatMap((result) => result.rows);
}

function targetRowsForDraft(rows) {
  return rows.filter((row) => !row.isDerived && !row.ratePlanID && !row.ratePlanNamePublic);
}

function plannedChangesFromRows(rows) {
  return targetRowsForDraft(rows)
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
}

function normalizeRollbackChanges(changes) {
  return changes.map((change) => ({
    rateID: change.rateID,
    roomTypeName: change.roomTypeName,
    date: change.date,
    startDate: change.startDate,
    endDate: change.endDate,
    restoreRate: change.currentRate,
    expectedCurrentRate: change.proposedRate,
  }));
}

function cloudbedsWriteEndDate(change) {
  return change.date ?? change.startDate;
}

function buildAdjacentRiskDates(changes) {
  return [...new Set(changes.map((change) => nextDay(change.date ?? change.startDate)))].sort();
}

function buildTargetedDateSet(changes = []) {
  return new Set(changes.map((change) => change.date ?? change.startDate).filter(Boolean));
}

function buildBaseRowsSnapshot(rows, changes = []) {
  const proposedByKey = new Map(
    changes.map((change) => [`${change.date ?? change.startDate}::${change.rateID}`, change.proposedRate])
  );
  return targetRowsForDraft(rows).map((row) => ({
    date: row.date,
    startDate: row.startDate,
    endDate: row.endDate,
    rateID: row.rateID,
    roomTypeID: row.roomTypeID,
    roomTypeName: row.roomTypeName,
    currentRate: row.currentRate,
    proposedRate: proposedByKey.get(`${row.date}::${row.rateID}`) ?? smoothRate(row.currentRate),
    targeted: proposedByKey.has(`${row.date}::${row.rateID}`),
    alreadySmooth: smoothRate(row.currentRate) === row.currentRate,
  }));
}

function buildAdjacentRowsSnapshot(rows) {
  return targetRowsForDraft(rows).map((row) => ({
    date: row.date,
    startDate: row.startDate,
    endDate: row.endDate,
    rateID: row.rateID,
    roomTypeID: row.roomTypeID,
    roomTypeName: row.roomTypeName,
    currentRate: row.currentRate,
  }));
}

async function createDraftRecord({
  propertyId = TARGET_PROPERTY_ID,
  propertyName = TARGET_PROPERTY_NAME,
  startDate,
  endDate,
  operator = "local",
  notes = "",
  rule = "truncate cents to .00",
  changes,
  normalizedRows,
  rawCloudbedsResponse,
  adjacentRows = [],
  sourceRunId = null,
  sourceChunkId = null,
  sourceBackupId = null,
}) {
  if (changes.length > MAX_DRAFT_CHANGES) {
    throw new Error(`Draft has ${changes.length} changes; current limit is ${MAX_DRAFT_CHANGES}.`);
  }

  const id = batchId("draft");
  const snapshotId = id.replace(/^draft_/, "backup_");
  const createdAt = isoNow();
  const draftPayload = buildDraftPayload({
    id,
    backupId: snapshotId,
    propertyId,
    propertyName,
    startDate,
    endDate,
    operator,
    notes,
    createdAt,
    rule,
    status: "draft",
    changes,
    sourceRunId,
    sourceChunkId,
    sourceBackupId,
  });
  const hash = hashDraftPayload(draftPayload);
  const draft = { ...draftPayload, hash, appliedAt: null, jobs: [], verification: [] };
  const backup = {
    id: snapshotId,
    draftId: id,
    propertyId,
    propertyName,
    startDate,
    endDate,
    createdAt,
    operator,
    hash,
    ...(sourceRunId ? { sourceRunId } : {}),
    ...(sourceChunkId ? { sourceChunkId } : {}),
    rawCloudbedsResponse,
    safetyMetadata: SAFETY_METADATA,
    normalizedRows,
    baseRowsSnapshot: buildBaseRowsSnapshot(normalizedRows, changes),
    adjacentRowsSnapshot: buildAdjacentRowsSnapshot(adjacentRows),
    rollbackChanges: normalizeRollbackChanges(changes),
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
      safetyMetadata: SAFETY_METADATA,
      maxFetchDays: MAX_FETCH_DAYS,
      maxDraftDays: MAX_DRAFT_DAYS,
      maxDraftChanges: MAX_DRAFT_CHANGES,
    },
  });
  return { draft, backup };
}

async function createDraft({ startDate, endDate, operator = "local", notes = "" }) {
  assertDate(startDate, "startDate");
  assertDate(endDate, "endDate");
  assertBatchScope(startDate, endDate, "Draft");

  const fetched = await fetchRatePlans(startDate, endDate);
  const changes = plannedChangesFromRows(fetched.rows);
  const adjacentRows = await fetchBaseRowsForDates(buildAdjacentRiskDates(changes));
  const { draft } = await createDraftRecord({
    startDate,
    endDate,
    operator,
    notes,
    changes,
    normalizedRows: fetched.rows,
    rawCloudbedsResponse: fetched.raw,
    adjacentRows,
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

function chunkChangesForRun(changes) {
  const sorted = [...changes].sort((a, b) => a.date.localeCompare(b.date) || a.roomTypeName.localeCompare(b.roomTypeName));
  const chunks = [];
  let currentChanges = [];
  let currentDates = new Set();

  function flushChunk() {
    if (!currentChanges.length) return;
    chunks.push({
      id: batchId("chunk"),
      startDate: minDate(currentDates),
      endDate: maxDate(currentDates),
      changeCount: currentChanges.length,
      changes: currentChanges,
      draftId: null,
      backupId: null,
      status: "planned",
      appliedAt: null,
      verifiedCount: 0,
    });
    currentChanges = [];
    currentDates = new Set();
  }

  for (const change of sorted) {
    const nextDates = new Set(currentDates);
    nextDates.add(change.date);
    const nights = currentDates.size ? inclusiveNightCount(minDate(nextDates), maxDate(nextDates)) : 1;
    const wouldOverflow = currentChanges.length >= RUN_CHUNK_MAX_CHANGES || nights > RUN_CHUNK_MAX_NIGHTS;
    if (wouldOverflow) flushChunk();
    currentChanges.push(change);
    currentDates.add(change.date);
  }
  flushChunk();
  return chunks;
}

function summarizeRun(run) {
  const appliedChunks = run.chunks.filter((chunk) => chunk.status === "applied").length;
  const skippedChunks = run.chunks.filter((chunk) => chunk.status === "skipped").length;
  const failedChunks = run.chunks.filter((chunk) => chunk.status === "verification_failed" || chunk.status === "apply_failed").length;
  const totalVerified = run.chunks.reduce((sum, chunk) => sum + (chunk.verifiedCount ?? 0), 0);
  return {
    id: run.id,
    type: run.type,
    propertyName: run.propertyName,
    startDate: run.startDate,
    endDate: run.endDate,
    createdAt: run.createdAt,
    status: run.status,
    chunkCount: run.chunks.length,
    appliedChunks,
    skippedChunks,
    failedChunks,
    totalChanges: run.totalChanges,
    totalVerified,
    progress: run.progress ?? null,
  };
}

async function listRuns() {
  await ensureDataDirs();
  const files = await fs.readdir(RUNS_DIR).catch(() => []);
  const runs = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readJson(path.join(RUNS_DIR, file))));
  return runs.map(summarizeRun).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function getRun(id) {
  if (!/^run_\d+_[a-f0-9]{8}$/.test(id)) throw new Error("Invalid run id.");
  return readJson(path.join(RUNS_DIR, `${id}.json`));
}

async function saveRun(run) {
  await writeJson(path.join(RUNS_DIR, `${run.id}.json`), run);
}

async function createRun({ startDate, endDate, operator = "web-app", notes = "", type = "smooth" }) {
  assertDate(startDate, "startDate");
  assertDate(endDate, "endDate");
  assertRunScope(startDate, endDate);
  const fetched = await fetchRatePlans(startDate, endDate);
  const changes = plannedChangesFromRows(fetched.rows);
  const chunks = chunkChangesForRun(changes).map((chunk, index) => ({
    ...chunk,
    sequence: index + 1,
  }));
  const createdAt = isoNow();
  const run = {
    id: batchId("run"),
    type,
    propertyId: TARGET_PROPERTY_ID,
    propertyName: TARGET_PROPERTY_NAME,
    startDate,
    endDate,
    operator,
    notes,
    createdAt,
    status: "planned",
    totalChanges: changes.length,
    chunkCount: chunks.length,
    safetyMetadata: SAFETY_METADATA,
    chunks,
    progress: {
      completedChunks: 0,
      skippedChunks: 0,
      failedChunkSequence: null,
      activeChunkSequence: null,
      lastUpdatedAt: createdAt,
      phase: "planned",
      message: `Planned ${chunks.length} chunk(s).`,
    },
  };
  await saveRun(run);
  auditEvent({
    type: "run_created",
    operator,
    entityType: "run",
    entityId: run.id,
    startDate,
    endDate,
    payload: {
      type,
      totalChanges: run.totalChanges,
      chunkCount: run.chunkCount,
      safetyMetadata: SAFETY_METADATA,
      runChunkMaxChanges: RUN_CHUNK_MAX_CHANGES,
      runChunkMaxNights: RUN_CHUNK_MAX_NIGHTS,
    },
  });
  return run;
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
  const draftPayload = buildDraftPayload({
    id: rollbackDraftId,
    backupId,
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
    sourceBackupId: sourceBackup.id,
  });
  if (draftPayload.changes.length > MAX_DRAFT_CHANGES) {
    throw new Error(`Rollback draft has ${draftPayload.changes.length} changes; current limit is ${MAX_DRAFT_CHANGES}.`);
  }
  const hash = hashDraftPayload(draftPayload);
  const draft = { ...draftPayload, hash, appliedAt: null, jobs: [], verification: [] };
  const adjacentRows = await fetchBaseRowsForDates(buildAdjacentRiskDates(draft.changes));
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
    safetyMetadata: SAFETY_METADATA,
    rawCloudbedsResponse: fetched.raw,
    normalizedRows: fetched.rows,
    baseRowsSnapshot: buildBaseRowsSnapshot(fetched.rows, draft.changes),
    adjacentRowsSnapshot: buildAdjacentRowsSnapshot(adjacentRows),
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
      safetyMetadata: SAFETY_METADATA,
      maxFetchDays: MAX_FETCH_DAYS,
      maxDraftDays: MAX_DRAFT_DAYS,
      maxDraftChanges: MAX_DRAFT_CHANGES,
    },
  });
  return draft;
}

async function createRollbackRunFromRun(id, operator = "web-app") {
  const sourceRun = await getRun(id);
  const appliedChunks = sourceRun.chunks.filter((chunk) => chunk.backupId);
  if (!appliedChunks.length) throw new Error("Run has no backups to roll back.");

  const rollbackChunks = [];
  for (const chunk of appliedChunks) {
    const draft = await createRollbackDraftFromBackup(chunk.backupId, operator);
    rollbackChunks.push({
      id: batchId("chunk"),
      sequence: rollbackChunks.length + 1,
      startDate: draft.startDate,
      endDate: draft.endDate,
      changeCount: draft.changes.length,
      changes: [],
      draftId: draft.id,
      backupId: draft.backupId,
      sourceBackupId: chunk.backupId,
      status: "ready",
      appliedAt: null,
      verifiedCount: 0,
    });
  }

  const rollbackRun = {
    id: batchId("run"),
    type: "rollback",
    sourceRunId: sourceRun.id,
    propertyId: sourceRun.propertyId,
    propertyName: sourceRun.propertyName,
    startDate: sourceRun.startDate,
    endDate: sourceRun.endDate,
    operator,
    notes: `Rollback plan for ${sourceRun.id}`,
    createdAt: isoNow(),
    status: "planned",
    totalChanges: rollbackChunks.reduce((sum, chunk) => sum + chunk.changeCount, 0),
    chunkCount: rollbackChunks.length,
    safetyMetadata: SAFETY_METADATA,
    chunks: rollbackChunks,
    progress: {
      completedChunks: 0,
      skippedChunks: 0,
      failedChunkSequence: null,
      activeChunkSequence: null,
      lastUpdatedAt: isoNow(),
      phase: "planned",
      message: `Rollback plan created from ${sourceRun.id}.`,
    },
  };
  await saveRun(rollbackRun);
  auditEvent({
    type: "run_rollback_planned",
    operator,
    entityType: "run",
    entityId: rollbackRun.id,
    startDate: rollbackRun.startDate,
    endDate: rollbackRun.endDate,
    payload: { sourceRunId: sourceRun.id, chunkCount: rollbackRun.chunkCount, totalChanges: rollbackRun.totalChanges },
  });
  return rollbackRun;
}

async function createSpillCorrectionDraftFromRun(id, operator = "web-app") {
  const run = await getRun(id);
  if (run.type !== "smooth") throw new Error("Spill correction drafts are only supported for smooth runs.");
  const appliedChunks = run.chunks.filter((chunk) => chunk.status === "applied" && chunk.draftId);
  if (!appliedChunks.length) throw new Error("Run has no applied chunks to audit for spill correction.");

  const intendedByKey = new Map();
  for (const chunk of run.chunks) {
    for (const change of chunk.changes ?? []) {
      intendedByKey.set(`${change.date}::${change.rateID}`, change);
    }
  }

  const spillRiskDates = buildAdjacentRiskDates(appliedChunks.flatMap((chunk) => chunk.changes ?? []));
  const liveAdjacentRows = await fetchBaseRowsForDates(spillRiskDates);
  const liveAdjacentByKey = new Map(liveAdjacentRows.map((row) => [`${row.date}::${row.rateID}`, row]));
  const correctionByKey = new Map();

  for (const chunk of appliedChunks) {
    const draft = await getDraft(chunk.draftId);
    for (const change of draft.changes) {
      const spillDate = nextDay(change.date);
      const intendedNext = intendedByKey.get(`${spillDate}::${change.rateID}`);
      const liveNext = liveAdjacentByKey.get(`${spillDate}::${change.rateID}`);
      if (!intendedNext || !liveNext) continue;
      if (ratesEqual(liveNext.currentRate, change.proposedRate) && !ratesEqual(liveNext.currentRate, intendedNext.proposedRate)) {
        correctionByKey.set(`${spillDate}::${change.rateID}`, {
          rateID: intendedNext.rateID,
          roomTypeID: intendedNext.roomTypeID,
          roomTypeName: intendedNext.roomTypeName,
          date: spillDate,
          startDate: spillDate,
          endDate: intendedNext.endDate,
          currentRate: liveNext.currentRate,
          proposedRate: intendedNext.proposedRate,
          changed: true,
          isDerived: false,
        });
      }
    }
  }

  const corrections = [...correctionByKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.roomTypeName.localeCompare(b.roomTypeName));
  if (!corrections.length) throw new Error("No proven spill-correction rows were found for this run.");

  const startDate = minDate(corrections.map((item) => item.date));
  const endDate = maxDate(corrections.map((item) => item.date));
  const fetched = await fetchRatePlans(startDate, endDate);
  const adjacentRows = await fetchBaseRowsForDates(buildAdjacentRiskDates(corrections));
  const { draft } = await createDraftRecord({
    startDate,
    endDate,
    operator,
    notes: `Spill correction draft from ${run.id}`,
    rule: `repair proven spill rows from ${run.id}`,
    changes: corrections,
    normalizedRows: fetched.rows,
    rawCloudbedsResponse: {
      ...fetched.raw,
      source: "spill-correction",
      sourceRunId: run.id,
    },
    adjacentRows,
    sourceRunId: run.id,
  });
  auditEvent({
    type: "spill_correction_draft_created",
    operator,
    entityType: "draft",
    entityId: draft.id,
    startDate,
    endDate,
    payload: { sourceRunId: run.id, changeCount: draft.changes.length, backupId: draft.backupId },
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

function buildVerification(changes, readbackRows) {
  return changes.map((change) => {
    const row = readbackRows.find((candidate) => candidate.rateID === change.rateID && candidate.date === change.date);
    return {
      rateID: change.rateID,
      roomTypeName: change.roomTypeName,
      date: change.date,
      expectedRate: change.proposedRate,
      actualRate: row?.currentRate ?? null,
      verified: row ? ratesEqual(row.currentRate, change.proposedRate) : false,
      kind: "targeted",
    };
  });
}

function buildScopeVerification(baseRowsSnapshot = [], readbackRows = []) {
  return baseRowsSnapshot.map((snapshot) => {
    const row = readbackRows.find((candidate) => candidate.rateID === snapshot.rateID && candidate.date === snapshot.date);
    const expectedRate = snapshot.targeted ? snapshot.proposedRate : snapshot.currentRate;
    return {
      rateID: snapshot.rateID,
      roomTypeName: snapshot.roomTypeName,
      date: snapshot.date,
      expectedRate,
      actualRate: row?.currentRate ?? null,
      verified: row ? ratesEqual(row.currentRate, expectedRate) : false,
      targeted: snapshot.targeted,
      kind: snapshot.targeted ? "targeted_scope" : "untouched_scope",
    };
  });
}

function buildAdjacentVerification(adjacentRowsSnapshot = [], changes = [], readbackRows = []) {
  const targetedDates = buildTargetedDateSet(changes);
  const priorTargetMap = new Map(
    changes.map((change) => [`${nextDay(change.date ?? change.startDate)}::${change.rateID}`, change.proposedRate])
  );
  return adjacentRowsSnapshot.map((snapshot) => {
    const overlapsTargetedDate = targetedDates.has(snapshot.date);
    const row = readbackRows.find((candidate) => candidate.rateID === snapshot.rateID && candidate.date === snapshot.date);
    const actualRate = row?.currentRate ?? null;
    const priorTargetRate = priorTargetMap.get(`${snapshot.date}::${snapshot.rateID}`);
    const changedUnexpectedly = row ? !ratesEqual(actualRate, snapshot.currentRate) : true;
    return {
      rateID: snapshot.rateID,
      roomTypeName: snapshot.roomTypeName,
      date: snapshot.date,
      expectedRate: snapshot.currentRate,
      actualRate,
      verified: overlapsTargetedDate ? true : row ? ratesEqual(actualRate, snapshot.currentRate) : false,
      kind: "adjacent",
      suspectedSpill:
        !overlapsTargetedDate &&
        changedUnexpectedly &&
        priorTargetRate !== undefined &&
        ratesEqual(actualRate, priorTargetRate),
      priorTargetRate: priorTargetRate ?? null,
      overlapsTargetedDate,
    };
  });
}

function describeVerificationFailure(summary) {
  const targetedMismatchCount = summary.targetedCount - summary.targetedVerifiedCount;
  const untouchedMismatchCount = summary.untouchedScopeCount - summary.untouchedScopeVerifiedCount;
  const adjacentMismatchCount = summary.adjacentCount - summary.adjacentVerifiedCount;
  const parts = [];
  if (targetedMismatchCount) parts.push(`${summary.targetedVerifiedCount}/${summary.targetedCount} targeted rows verified`);
  if (untouchedMismatchCount) parts.push(`${summary.untouchedScopeVerifiedCount}/${summary.untouchedScopeCount} untouched scope rows verified`);
  if (adjacentMismatchCount) parts.push(`${summary.adjacentVerifiedCount}/${summary.adjacentCount} adjacent nights verified`);
  return parts.length ? `${parts.join("; ")}.` : "Verification reported mismatches after apply.";
}

function summarizeVerification(targetedVerification, scopeVerification, adjacentVerification) {
  const untouchedScope = scopeVerification.filter((item) => !item.targeted);
  const targetedVerifiedCount = targetedVerification.filter((item) => item.verified).length;
  const untouchedVerifiedCount = untouchedScope.filter((item) => item.verified).length;
  const adjacentVerifiedCount = adjacentVerification.filter((item) => item.verified).length;
  return {
    targetedCount: targetedVerification.length,
    targetedVerifiedCount,
    untouchedScopeCount: untouchedScope.length,
    untouchedScopeVerifiedCount: untouchedVerifiedCount,
    adjacentCount: adjacentVerification.length,
    adjacentVerifiedCount,
    adjacentSuspiciousCount: adjacentVerification.filter((item) => item.suspectedSpill).length,
    allVerified:
      targetedVerifiedCount === targetedVerification.length &&
      untouchedVerifiedCount === untouchedScope.length &&
      adjacentVerifiedCount === adjacentVerification.length,
  };
}

async function verifyDraftIntegrity(draft, backup) {
  const adjacentDates = [...new Set((backup.adjacentRowsSnapshot ?? []).map((row) => row.date))].sort();
  let readback = await fetchRatePlans(draft.startDate, draft.endDate);
  let adjacentReadbackRows = adjacentDates.length ? await fetchBaseRowsForDates(adjacentDates) : [];
  let targetedVerification = buildVerification(draft.changes, readback.rows);
  let scopeVerification = buildScopeVerification(backup.baseRowsSnapshot ?? [], readback.rows);
  let adjacentVerification = buildAdjacentVerification(backup.adjacentRowsSnapshot ?? [], draft.changes, adjacentReadbackRows);
  let summary = summarizeVerification(targetedVerification, scopeVerification, adjacentVerification);

  for (let attempt = 0; attempt < VERIFY_RETRY_ATTEMPTS; attempt += 1) {
    if (summary.allVerified) break;
    await wait(VERIFY_RETRY_DELAY_MS);
    readback = await fetchRatePlans(draft.startDate, draft.endDate);
    adjacentReadbackRows = adjacentDates.length ? await fetchBaseRowsForDates(adjacentDates) : [];
    targetedVerification = buildVerification(draft.changes, readback.rows);
    scopeVerification = buildScopeVerification(backup.baseRowsSnapshot ?? [], readback.rows);
    adjacentVerification = buildAdjacentVerification(backup.adjacentRowsSnapshot ?? [], draft.changes, adjacentReadbackRows);
    summary = summarizeVerification(targetedVerification, scopeVerification, adjacentVerification);
  }

  return { targetedVerification, scopeVerification, adjacentVerification, summary };
}

async function applyDraft(id, confirmation) {
  const draft = await getDraft(id);
  const backup = await getBackup(draft.backupId);
  if (!WRITES_ENABLED) throw new Error("Writes are disabled. Set ENABLE_CLOUDBEDS_WRITES=true to apply drafts.");
  if (draft.status === "applied") throw new Error("Draft has already been applied.");
  if (confirmation !== "yes") throw new Error("Apply confirmation is required.");
  if (draft.changes.length > MAX_APPLY_CHANGES) {
    throw new Error(`Draft has ${draft.changes.length} changes; current apply limit is ${MAX_APPLY_CHANGES}.`);
  }
  if (draft.changes.some((change) => change.conflict)) {
    throw new Error("Draft has rollback conflicts; review before applying.");
  }

  const payloadForHash = buildDraftPayload({
    id: draft.id,
    backupId: draft.backupId,
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
    sourceRunId: draft.sourceRunId,
    sourceChunkId: draft.sourceChunkId,
    sourceBackupId: draft.sourceBackupId,
  });
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
        "rates[0][interval][0][endDate]": cloudbedsWriteEndDate(change),
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

  const verificationResult = await verifyDraftIntegrity(draft, backup);
  const verification = verificationResult.targetedVerification;

  const applied = {
    ...draft,
    safetyMetadata: backup.safetyMetadata ?? SAFETY_METADATA,
    status: verificationResult.summary.allVerified ? "applied" : "verification_failed",
    appliedAt: isoNow(),
    jobs: completedJobs,
    verification,
    scopeVerification: verificationResult.scopeVerification,
    adjacentVerification: verificationResult.adjacentVerification,
    verificationSummary: verificationResult.summary,
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
      untouchedScopeVerifiedCount: verificationResult.summary.untouchedScopeVerifiedCount,
      untouchedScopeCount: verificationResult.summary.untouchedScopeCount,
      adjacentVerifiedCount: verificationResult.summary.adjacentVerifiedCount,
      adjacentCount: verificationResult.summary.adjacentCount,
      adjacentSuspiciousCount: verificationResult.summary.adjacentSuspiciousCount,
    },
  });
  return applied;
}

async function draftFromRunChunk(run, chunk, options = {}) {
  const startDate = chunk.startDate;
  const endDate = chunk.endDate;
  const relevantDates = new Set(chunk.changes.map((change) => change.date));
  const normalizedRows =
    options.normalizedRows ??
    chunk.changes.map((change) => ({
      date: change.date,
      startDate: change.startDate,
      endDate: change.endDate,
      rateID: change.rateID,
      roomTypeID: change.roomTypeID ?? "",
      roomTypeName: change.roomTypeName,
      ratePlanID: null,
      ratePlanNamePublic: null,
      ratePlanNamePrivate: null,
      isDerived: false,
      roomsAvailable: 0,
      currentRate: change.currentRate,
      raw: null,
    }));
  const rawCloudbedsResponse =
    options.rawCloudbedsResponse ??
    {
      success: true,
      source: "run-plan",
      startDate,
      endDate,
      nights: [...relevantDates].sort().map((date) => ({ date, checkoutDate: nextDay(date), response: null })),
    };
  const adjacentRows = options.adjacentRows ?? [];
  const { draft, backup } = await createDraftRecord({
    startDate,
    endDate,
    operator: run.operator,
    notes: run.notes,
    rule: run.type === "rollback" ? `rollback for ${run.sourceRunId ?? run.id}` : "truncate cents to .00",
    changes: chunk.changes,
    normalizedRows,
    rawCloudbedsResponse,
    adjacentRows,
    sourceRunId: run.id,
    sourceChunkId: chunk.id,
  });
  return { draft, backup };
}

function updateRunProgress(run, updates = {}) {
  const completedChunks = run.chunks.filter((chunk) => chunk.status === "applied").length;
  const skippedChunks = run.chunks.filter((chunk) => chunk.status === "skipped").length;
  run.progress = {
    completedChunks,
    skippedChunks,
    failedChunkSequence: run.progress?.failedChunkSequence ?? null,
    activeChunkSequence: run.progress?.activeChunkSequence ?? null,
    lastUpdatedAt: isoNow(),
    phase: run.progress?.phase ?? run.status,
    message: run.progress?.message ?? "",
    ...updates,
  };
  return run.progress;
}

function findLiveRow(rows, change) {
  return rows.find((row) => row.rateID === change.rateID && row.date === change.date);
}

function categorizeChunkDrift(run, drifted = []) {
  const priorTargetMap = new Map();
  for (const chunk of run.chunks) {
    for (const change of chunk.changes ?? []) {
      priorTargetMap.set(`${nextDay(change.date)}::${change.rateID}`, change.proposedRate);
    }
  }
  const spillMatches = drifted.filter((item) => {
    const priorTarget = priorTargetMap.get(`${item.date}::${item.rateID}`);
    return priorTarget !== undefined && ratesEqual(item.liveRate, priorTarget);
  });
  if (spillMatches.length && spillMatches.length === drifted.length) {
    return {
      category: "adjacent_spill_suspected",
      message: `Chunk drift detected before apply (${drifted.length} row(s)); live rates match the previous night's applied targets, suggesting adjacent-night spill.`,
    };
  }
  return {
    category: "external_drift",
    message: `Chunk drift detected before apply (${drifted.length} row(s)). Re-plan or review this chunk.`,
  };
}

async function assessChunkLiveState(run, chunk) {
  const fetched = await fetchRatePlans(chunk.startDate, chunk.endDate);
  const adjacentRows = await fetchBaseRowsForDates(buildAdjacentRiskDates(chunk.changes));
  const actionableChanges = [];
  const alreadySmooth = [];
  const drifted = [];

  for (const change of chunk.changes) {
    const liveRow = findLiveRow(fetched.rows, change);
    if (!liveRow) {
      drifted.push({
        ...change,
        reason: "Cloudbeds no longer returned this rate/date row during pre-apply readback.",
        liveRate: null,
      });
      continue;
    }
    if (ratesEqual(liveRow.currentRate, change.proposedRate)) {
      alreadySmooth.push({
        ...change,
        liveRate: money(liveRow.currentRate),
      });
      continue;
    }
    if (!ratesEqual(liveRow.currentRate, change.currentRate)) {
      drifted.push({
        ...change,
        reason: `Live rate changed from planned ${money(change.currentRate).toFixed(2)} to ${money(liveRow.currentRate).toFixed(2)} before this chunk applied.`,
        liveRate: money(liveRow.currentRate),
      });
      continue;
    }
    actionableChanges.push({
      ...change,
      currentRate: money(liveRow.currentRate),
    });
  }

  return { fetched, adjacentRows, actionableChanges, alreadySmooth, drifted };
}

async function applyRun(id, options = {}) {
  const run = await getRun(id);
  if (!WRITES_ENABLED) throw new Error("Writes are disabled. Set ENABLE_CLOUDBEDS_WRITES=true to apply runs.");
  if (run.status === "applied") throw new Error("Run has already been applied.");
  const mode = options.mode === "retry_failed_chunk" ? "retry_failed_chunk" : "resume";
  const failedChunk = run.chunks.find((chunk) => chunk.status === "verification_failed" || chunk.status === "apply_failed");
  const targetChunkSequence = mode === "retry_failed_chunk" ? failedChunk?.sequence ?? null : null;
  if (mode === "retry_failed_chunk" && !targetChunkSequence) {
    throw new Error("Run has no failed chunk to retry.");
  }

  run.status = "running";
  updateRunProgress(run, {
    phase: mode === "retry_failed_chunk" ? "retry_failed_chunk" : "running",
    failedChunkSequence: null,
    activeChunkSequence: null,
    message: mode === "retry_failed_chunk" ? "Retrying first failed chunk only." : "Executing run chunk by chunk.",
  });
  await saveRun(run);
  auditEvent({
    type: "run_apply_started",
    operator: run.operator,
    entityType: "run",
    entityId: run.id,
    startDate: run.startDate,
    endDate: run.endDate,
    payload: { chunkCount: run.chunkCount, totalChanges: run.totalChanges, type: run.type, mode },
  });

  for (const chunk of run.chunks) {
    if (targetChunkSequence && chunk.sequence !== targetChunkSequence) continue;
    if (chunk.status === "applied") continue;
    try {
      chunk.error = null;
      updateRunProgress(run, {
        phase: "preflight",
        activeChunkSequence: chunk.sequence,
        message: `Checking live Cloudbeds state for chunk ${chunk.sequence} before apply.`,
      });
      await saveRun(run);
      auditEvent({
        type: "run_chunk_preflight_started",
        operator: run.operator,
        entityType: "run",
        entityId: run.id,
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        payload: { chunkId: chunk.id, chunkSequence: chunk.sequence, changeCount: chunk.changeCount },
      });

      const liveState =
        run.type === "smooth"
          ? await assessChunkLiveState(run, chunk)
          : { actionableChanges: null, alreadySmooth: [], drifted: [] };

      if (run.type === "smooth" && liveState.drifted.length) {
        const driftCategory = categorizeChunkDrift(run, liveState.drifted);
        chunk.status = "apply_failed";
        chunk.error = driftCategory.message;
        chunk.driftSummary = {
          category: driftCategory.category,
          driftedCount: liveState.drifted.length,
          alreadySmoothCount: liveState.alreadySmooth.length,
          drifted: liveState.drifted.map(({ rateID, roomTypeName, date, currentRate, liveRate, reason }) => ({
            rateID,
            roomTypeName,
            date,
            plannedCurrentRate: currentRate,
            liveRate,
            reason,
          })),
        };
        run.status = "paused";
        updateRunProgress(run, {
          phase: "paused",
          failedChunkSequence: chunk.sequence,
          activeChunkSequence: null,
          message: `Paused on chunk ${chunk.sequence} after detecting unexpected Cloudbeds drift.`,
        });
        await saveRun(run);
        auditEvent({
          type: "run_chunk_drift_detected",
          operator: run.operator,
          entityType: "run",
          entityId: run.id,
          startDate: chunk.startDate,
          endDate: chunk.endDate,
          payload: {
            chunkId: chunk.id,
            chunkSequence: chunk.sequence,
            category: driftCategory.category,
            driftedCount: liveState.drifted.length,
            alreadySmoothCount: liveState.alreadySmooth.length,
          },
        });
        return run;
      }

      if (run.type === "smooth" && !liveState.actionableChanges.length) {
        chunk.status = "skipped";
        chunk.appliedAt = isoNow();
        chunk.verifiedCount = chunk.changeCount;
        chunk.skipSummary = {
          alreadySmoothCount: liveState.alreadySmooth.length,
        };
        updateRunProgress(run, {
          phase: "running",
          activeChunkSequence: null,
          message: `Skipped chunk ${chunk.sequence}; all ${chunk.changeCount} row(s) were already smooth.`,
        });
        await saveRun(run);
        auditEvent({
          type: "run_chunk_skipped",
          operator: run.operator,
          entityType: "run",
          entityId: run.id,
          startDate: chunk.startDate,
          endDate: chunk.endDate,
          payload: {
            chunkId: chunk.id,
            chunkSequence: chunk.sequence,
            alreadySmoothCount: liveState.alreadySmooth.length,
          },
        });
        if (targetChunkSequence) break;
        continue;
      }

      let draft;
      if (run.type === "smooth") {
        const draftSource = { ...chunk, changes: liveState.actionableChanges, changeCount: liveState.actionableChanges.length };
        const created = await draftFromRunChunk(run, draftSource, {
          normalizedRows: liveState.fetched.rows,
          rawCloudbedsResponse: liveState.fetched.raw,
          adjacentRows: liveState.adjacentRows,
        });
        draft = created.draft;
        chunk.draftId = created.draft.id;
        chunk.backupId = created.backup.id;
        chunk.status = "draft_created";
        chunk.changeCount = draft.changes.length;
        await saveRun(run);
      } else if (run.type === "rollback") {
        const draftFromBackup = await createRollbackDraftFromBackup(chunk.sourceBackupId ?? chunk.backupId, run.operator);
        draft = draftFromBackup;
        chunk.draftId = draftFromBackup.id;
        chunk.backupId = draftFromBackup.backupId;
        chunk.status = "draft_created";
        chunk.changeCount = draft.changes.length;
        await saveRun(run);
      } else {
        const created = await draftFromRunChunk(run, chunk);
        draft = created.draft;
        chunk.draftId = created.draft.id;
        chunk.backupId = created.backup.id;
        chunk.status = "draft_created";
        chunk.changeCount = draft.changes.length;
        await saveRun(run);
      }

      chunk.status = "running";
      updateRunProgress(run, {
        phase: "applying",
        activeChunkSequence: chunk.sequence,
        message: `Applying chunk ${chunk.sequence} with ${draft.changes.length} row(s).`,
      });
      await saveRun(run);
      auditEvent({
        type: "run_chunk_apply_started",
        operator: run.operator,
        entityType: "run",
        entityId: run.id,
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        payload: {
          chunkId: chunk.id,
          chunkSequence: chunk.sequence,
          draftId: draft.id,
          backupId: chunk.backupId,
          changeCount: draft.changes.length,
        },
      });

      const applied = await applyDraft(draft.id, "yes");
      chunk.status = applied.status;
      chunk.appliedAt = applied.appliedAt;
      chunk.verifiedCount = applied.verification.filter((item) => item.verified).length;
      chunk.backupId = chunk.backupId ?? applied.backupId;
      chunk.error = applied.status === "applied" ? null : describeVerificationFailure(applied.verificationSummary ?? {});
      updateRunProgress(run, {
        phase: applied.status === "applied" ? "running" : "paused",
        activeChunkSequence: null,
        failedChunkSequence: applied.status === "applied" ? null : chunk.sequence,
        message:
          applied.status === "applied"
            ? `Chunk ${chunk.sequence} finished and verified ${chunk.verifiedCount}/${draft.changes.length} row(s).`
            : `Chunk ${chunk.sequence} applied but verification found additional mismatches outside the targeted rows.`,
      });
      await saveRun(run);
      auditEvent({
        type: applied.status === "applied" ? "run_chunk_apply_finished" : "run_chunk_verification_failed",
        operator: run.operator,
        entityType: "run",
        entityId: run.id,
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        payload: {
          chunkId: chunk.id,
          chunkSequence: chunk.sequence,
          draftId: draft.id,
          status: applied.status,
          verifiedCount: chunk.verifiedCount,
          changeCount: draft.changes.length,
        },
      });
      if (applied.status !== "applied") {
        run.status = "paused";
        await saveRun(run);
        auditEvent({
          type: "run_apply_finished",
          operator: run.operator,
          entityType: "run",
          entityId: run.id,
          startDate: run.startDate,
          endDate: run.endDate,
          payload: { status: run.status, failedChunkId: chunk.id, chunkSequence: chunk.sequence },
        });
        return run;
      }
      if (targetChunkSequence) break;
    } catch (error) {
      chunk.status = "apply_failed";
      chunk.error = error.message;
      run.status = "paused";
      updateRunProgress(run, {
        phase: "paused",
        failedChunkSequence: chunk.sequence,
        activeChunkSequence: null,
        message: `Chunk ${chunk.sequence} failed: ${error.message}`,
      });
      await saveRun(run);
      auditEvent({
        type: "run_apply_failed",
        operator: run.operator,
        entityType: "run",
        entityId: run.id,
        startDate: run.startDate,
        endDate: run.endDate,
        payload: { error: error.message, chunkId: chunk.id, chunkSequence: chunk.sequence },
      });
      throw error;
    }
  }

  run.status = "applied";
  updateRunProgress(run, {
    phase: "applied",
    failedChunkSequence: null,
    activeChunkSequence: null,
    message: `Run completed with ${run.chunks.filter((chunk) => chunk.status === "applied").length} applied chunk(s) and ${run.chunks.filter((chunk) => chunk.status === "skipped").length} skipped chunk(s).`,
  });
  await saveRun(run);
  auditEvent({
    type: "run_apply_finished",
    operator: run.operator,
    entityType: "run",
    entityId: run.id,
    startDate: run.startDate,
    endDate: run.endDate,
    payload: { status: run.status, chunkCount: run.chunkCount, totalChanges: run.totalChanges },
  });
  return run;
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/api/config", (_req, res) => {
  res.json({
    propertyId: TARGET_PROPERTY_ID,
    propertyName: TARGET_PROPERTY_NAME,
    writesEnabled: WRITES_ENABLED,
    safetyMetadata: SAFETY_METADATA,
    limits: {
      maxRunDays: MAX_RUN_DAYS,
      maxDraftDays: MAX_DRAFT_DAYS,
      maxFetchDays: MAX_FETCH_DAYS,
      maxDraftChanges: MAX_DRAFT_CHANGES,
      maxApplyChanges: MAX_APPLY_CHANGES,
      runChunkMaxChanges: RUN_CHUNK_MAX_CHANGES,
      runChunkMaxNights: RUN_CHUNK_MAX_NIGHTS,
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

app.get("/api/runs", async (_req, res) => {
  try {
    res.json({ runs: await listRuns() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/runs/:id", async (req, res) => {
  try {
    res.json({ run: await getRun(req.params.id) });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get("/api/runs/:id/events", async (req, res) => {
  try {
    await getRun(req.params.id);
    res.json({ events: listAuditEventsForEntity("run", req.params.id, req.query.limit) });
  } catch (error) {
    res.status(404).json({ error: error.message });
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

app.post("/api/runs", async (req, res) => {
  try {
    const run = await createRun(req.body ?? {});
    res.status(201).json({ run });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/runs/:id/apply", async (req, res) => {
  try {
    const run = await applyRun(req.params.id, req.body ?? {});
    res.json({ run });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/runs/:id/rollback-plan", async (req, res) => {
  try {
    const run = await createRollbackRunFromRun(req.params.id, req.body?.operator ?? "web-app");
    res.status(201).json({ run });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/runs/:id/spill-correction-draft", async (req, res) => {
  try {
    const draft = await createSpillCorrectionDraftFromRun(req.params.id, req.body?.operator ?? "web-app");
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
