const state = {
  config: null,
  selectedPropertyKey: null,
  rates: [],
  latestRun: null,
  latestRunEvents: [],
  latestDraft: null,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setMessage(text, type = "") {
  const el = $("message");
  el.textContent = text;
  el.className = `message ${type}`.trim();
}

function formatMoney(value) {
  if (value === null || value === undefined) return "-";
  return `$${Number(value).toFixed(2)}`;
}

function tomorrow(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function inclusiveNightCount(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86400000) + 1;
}

function enumerateNights(startDate, endDate) {
  const nights = [];
  if (!startDate || !endDate) return nights;
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    nights.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return nights;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function setOperationProgress({ label = "Working...", detail = "", completed = 0, total = 1, percent = null } = {}) {
  const wrap = $("operationProgress");
  const fill = $("operationProgressFill");
  const track = wrap?.querySelector(".progress-track");
  if (!wrap || !fill) return;
  const computedPercent = percent === null ? (total > 0 ? (completed / total) * 100 : 0) : percent;
  const safePercent = clampPercent(computedPercent);
  wrap.hidden = false;
  $("operationProgressLabel").textContent = label;
  $("operationProgressPercent").textContent = `${safePercent}%`;
  $("operationProgressDetail").textContent = detail;
  fill.style.width = `${safePercent}%`;
  if (track) track.setAttribute("aria-valuenow", String(safePercent));
}

function hideOperationProgress() {
  const wrap = $("operationProgress");
  if (wrap) wrap.hidden = true;
}

function runProgressPercent(run) {
  const chunks = run?.chunks ?? [];
  if (!chunks.length) return 0;
  const completeWeight = chunks.reduce((sum, chunk) => sum + (["applied", "skipped"].includes(chunk.status) ? 1 : 0), 0);
  const activeSequence = run.progress?.activeChunkSequence;
  const activeBonus = activeSequence && run.status === "running" ? 0.35 : 0;
  return clampPercent(((completeWeight + activeBonus) / chunks.length) * 100);
}

function describeRunProgress(run) {
  const chunks = run?.chunks ?? [];
  const completed = chunks.filter((chunk) => ["applied", "skipped"].includes(chunk.status)).length;
  const total = chunks.length || 1;
  const active = run?.progress?.activeChunkSequence;
  const base = active ? `Chunk ${active} of ${total}` : `${completed} of ${total} chunks complete`;
  return `${base} · ${run?.progress?.message ?? run?.status ?? "Working"}`;
}

function formatDateLabel(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  return new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function formatDateTime(dateText) {
  if (!dateText) return "-";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(dateText));
}

function isLegacyHashMismatch(errorText = "") {
  return errorText === "Draft hash mismatch; refusing to apply.";
}

function explainRunError(errorText = "") {
  if (!errorText) return "";
  if (isLegacyHashMismatch(errorText)) {
    return "This older run stopped on the previous chunk-draft hash bug before any Cloudbeds write was sent for that chunk.";
  }
  return errorText;
}

function summarizeRunEvent(event) {
  const payload = event.payload ?? {};
  switch (event.type) {
    case "run_created":
      return `${payload.totalChanges ?? 0} changes planned across ${payload.chunkCount ?? 0} chunk(s).`;
    case "run_apply_started":
      return `Started ${payload.mode === "retry_failed_chunk" ? "failed chunk retry" : "run execution"} for ${payload.chunkCount ?? 0} chunk(s).`;
    case "run_chunk_preflight_started":
      return `Preflight check for chunk ${payload.chunkSequence}.`;
    case "run_chunk_drift_detected":
      return payload.category === "adjacent_spill_suspected"
        ? `Paused on chunk ${payload.chunkSequence}; ${payload.driftedCount ?? 0} row(s) match the previous night's targets and look like spill.`
        : `Paused on chunk ${payload.chunkSequence} after ${payload.driftedCount ?? 0} unexpected live row(s) drifted.`;
    case "run_chunk_skipped":
      return `Skipped chunk ${payload.chunkSequence}; ${payload.alreadySmoothCount ?? 0} row(s) were already smooth.`;
    case "run_chunk_apply_started":
      return `Applying chunk ${payload.chunkSequence} (${payload.changeCount ?? 0} row(s)).`;
    case "run_chunk_apply_finished":
      return `Chunk ${payload.chunkSequence} verified ${payload.verifiedCount ?? 0}/${payload.changeCount ?? 0} row(s).`;
    case "run_chunk_verification_failed":
      return `Chunk ${payload.chunkSequence} only verified ${payload.verifiedCount ?? 0}/${payload.changeCount ?? 0} row(s).`;
    case "run_chunk_reconcile_verified":
      return `Reconciled chunk ${payload.chunkSequence}; delayed readback now verifies ${payload.verifiedCount ?? 0}/${payload.changeCount ?? 0} row(s).`;
    case "run_chunk_reconcile_failed":
      return `Reconcile still failed for chunk ${payload.chunkSequence}; ${payload.verifiedCount ?? 0}/${payload.changeCount ?? 0} row(s) verified.`;
    case "run_reconcile_finished":
      return `Run reconciliation finished with status ${payload.status ?? "unknown"}.`;
    case "run_apply_failed":
      return payload.error ?? "Run apply failed.";
    case "run_apply_finished":
      return `Run finished with status ${payload.status ?? "unknown"}.`;
    case "run_rollback_planned":
      return `Rollback run planned from ${payload.sourceRunId ?? "source run"} with ${payload.chunkCount ?? 0} chunk(s).`;
    case "spill_correction_draft_created":
      return `Created spill repair draft with ${payload.changeCount ?? 0} row(s).`;
    default:
      return payload.error ?? event.type;
  }
}

function runPrimaryAction(run, failedChunks, appliedChunks) {
  if (run.readinessOnly) return null;
  const resumable = ["planned", "running", "paused", "verification_failed", "apply_failed", "partial_apply_failed"].includes(run.status);
  if (!resumable) return null;
  const hasProgress = appliedChunks > 0 || failedChunks > 0 || run.status === "paused";
  if (run.type === "rollback") {
    return { label: hasProgress ? "Resume Rollback Run" : "Execute Rollback Run", mode: "resume" };
  }
  if (failedChunks) {
    return { label: "Resume Run", mode: "resume" };
  }
  return { label: hasProgress ? "Resume Run" : "Apply Run in Chunks", mode: "resume" };
}

function moneyDelta(currentRate, proposedRate) {
  return Number(proposedRate) - Number(currentRate);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error ?? `Request failed (${response.status})`);
  return json;
}

function renderConfig() {
  const limits = state.config.limits;
  const properties = state.config.properties ?? [
    { key: state.config.defaultPropertyKey, propertyId: state.config.propertyId, propertyName: state.config.propertyName },
  ];
  const select = $("propertySelect");
  select.innerHTML = properties
    .map(
      (property) =>
        `<option value="${escapeHtml(property.key)}"${property.key === state.selectedPropertyKey ? " selected" : ""}>${escapeHtml(property.propertyName)}</option>`
    )
    .join("");
  const selected = currentProperty();
  $("propertyLine").textContent = `${selected.propertyName} · property ${selected.propertyId} · fetch ${limits.maxFetchDays} nights · draft ${limits.maxDraftDays} night / ${limits.maxDraftChanges} rows · run ${limits.maxRunDays} nights in ${limits.runChunkMaxNights}-night / ${limits.runChunkMaxChanges}-row chunks`;
  $("writeBadge").textContent = state.config.writesEnabled ? "Writes enabled" : "Preview mode";
  $("writeBadge").className = `badge ${state.config.writesEnabled ? "on" : "off"}`;
}

function currentProperty() {
  const properties = state.config?.properties ?? [];
  return (
    properties.find((property) => property.key === state.selectedPropertyKey) ??
    properties.find((property) => property.key === state.config?.defaultPropertyKey) ?? {
      key: state.config?.defaultPropertyKey,
      propertyId: state.config?.propertyId,
      propertyName: state.config?.propertyName,
    }
  );
}

function selectedPropertyKey() {
  return currentProperty().key;
}

function rateStatus(row) {
  if (row.isDerived) return ["Derived", "warn"];
  if (row.ratePlanID || row.ratePlanNamePublic) return ["Named plan", "warn"];
  if (row.proposedRate === row.currentRate) return ["Already smooth", "ok"];
  return ["Draft target", "ok"];
}

function isIgnoredRow(row) {
  return row.isDerived || row.ratePlanID || row.ratePlanNamePublic;
}

function isTargetChange(row) {
  return row.targetByDefault && row.proposedRate !== row.currentRate;
}

function uniqueDates(rows) {
  return [...new Set(rows.map((row) => row.date))].sort();
}

function roomKey(row) {
  return row.roomTypeID || row.roomTypeName;
}

function groupBaseRowsByRoom(rows) {
  const rooms = new Map();
  rows
    .filter((row) => row.targetByDefault)
    .forEach((row) => {
      const key = roomKey(row);
      if (!rooms.has(key)) {
        rooms.set(key, {
          key,
          name: row.roomTypeName,
          rowsByDate: new Map(),
          changeCount: 0,
        });
      }
      const room = rooms.get(key);
      room.rowsByDate.set(row.date, row);
      if (isTargetChange(row)) room.changeCount += 1;
    });
  return [...rooms.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function summarizeRates(rows) {
  const dates = uniqueDates(rows);
  const targetRows = rows.filter((row) => row.targetByDefault);
  const changedRows = rows.filter(isTargetChange);
  const ignoredRows = rows.filter(isIgnoredRow);
  const changedRooms = new Set(changedRows.map(roomKey));
  return {
    dates,
    targetRows,
    changedRows,
    ignoredRows,
    roomCount: new Set(targetRows.map(roomKey)).size,
    changedRoomCount: changedRooms.size,
  };
}

function renderRateSummary(summary, targetCount, nights, limits) {
  const overChangeLimit = targetCount > limits.maxDraftChanges;
  const overNightLimit = nights > limits.maxDraftDays;
  $("rateSummary").innerHTML = `
    <div class="metric ${overNightLimit ? "warn-metric" : ""}">
      <span>Nights</span>
      <strong>${nights}</strong>
    </div>
    <div class="metric">
      <span>Rooms</span>
      <strong>${summary.changedRoomCount}/${summary.roomCount}</strong>
    </div>
    <div class="metric ${overChangeLimit ? "warn-metric" : ""}">
      <span>Rate changes</span>
      <strong>${targetCount}</strong>
    </div>
    <div class="metric">
      <span>Ignored rows</span>
      <strong>${summary.ignoredRows.length}</strong>
    </div>
  `;
}

function renderRateCell(row) {
  if (!row) return `<td class="rate-cell missing">-</td>`;
  const changed = isTargetChange(row);
  const delta = moneyDelta(row.currentRate, row.proposedRate);
  return `
    <td class="rate-cell ${changed ? "will-change" : "no-change"}">
      <span class="current-rate">${formatMoney(row.currentRate)}</span>
      ${
        changed
          ? `<span class="rate-arrow">to</span>
             <strong>${formatMoney(row.proposedRate)}</strong>
             <span class="delta">${delta.toFixed(2)}</span>`
          : `<span class="steady">No change</span>`
      }
    </td>
  `;
}

function renderRateGrid(summary) {
  const wrap = $("rateGridWrap");
  if (!summary.targetRows.length) {
    wrap.innerHTML = `<div class="empty">No base rates found for this date range.</div>`;
    return;
  }

  const changesOnly = $("changesOnly")?.checked ?? true;
  const rooms = groupBaseRowsByRoom(state.rates).filter((room) => !changesOnly || room.changeCount > 0);
  if (!rooms.length) {
    wrap.innerHTML = `<div class="empty">No changing base rates. Turn off Changes only to inspect all base rates.</div>`;
    return;
  }

  wrap.innerHTML = `
    <table class="rate-calendar">
      <thead>
        <tr>
          <th class="room-head">Room</th>
          ${summary.dates.map((date) => `<th><span>${formatDateLabel(date)}</span><small>${date}</small></th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${rooms
          .map(
            (room) => `
              <tr>
                <th class="room-name">
                  <strong>${escapeHtml(room.name)}</strong>
                  <span>${room.changeCount} change${room.changeCount === 1 ? "" : "s"}</span>
                </th>
                ${summary.dates.map((date) => renderRateCell(room.rowsByDate.get(date))).join("")}
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderExceptions(summary) {
  const panel = $("exceptionsPanel");
  const list = $("exceptionsList");
  const showIgnored = $("showIgnored")?.checked ?? false;
  panel.open = showIgnored;
  panel.querySelector("summary").textContent = `${summary.ignoredRows.length} ignored Cloudbeds row${
    summary.ignoredRows.length === 1 ? "" : "s"
  }`;

  if (!summary.ignoredRows.length) {
    list.className = "exceptions-list empty";
    list.textContent = "No ignored rows in this date range.";
    return;
  }

  list.className = "exceptions-list";
  const grouped = new Map();
  summary.ignoredRows.forEach((row) => {
    const key = `${row.roomTypeName}|${row.ratePlanNamePublic ?? row.ratePlanNamePrivate ?? (row.isDerived ? "Derived" : "Named plan")}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        room: row.roomTypeName,
        plan: row.ratePlanNamePublic ?? row.ratePlanNamePrivate ?? (row.isDerived ? "Derived rate" : "Named plan"),
        count: 0,
      });
    }
    grouped.get(key).count += 1;
  });

  list.innerHTML = [...grouped.values()]
    .sort((a, b) => a.room.localeCompare(b.room) || a.plan.localeCompare(b.plan))
    .map(
      (item) => `
        <div class="exception-item">
          <strong>${escapeHtml(item.room)}</strong>
          <span>${escapeHtml(item.plan)} · ${item.count} row${item.count === 1 ? "" : "s"}</span>
        </div>
      `
    )
    .join("");
}

function renderRates() {
  const wrap = $("rateGridWrap");
  $("rateCount").textContent = `${state.rates.length} raw rows`;
  if (!state.rates.length) {
    $("rateSummary").innerHTML = "";
    wrap.innerHTML = `<div class="empty">No rates loaded.</div>`;
    $("exceptionsList").textContent = "No ignored rows loaded.";
    $("createRun").disabled = true;
    return;
  }

  const summary = summarizeRates(state.rates);
  const targetCount = summary.changedRows.length;
  const nights = inclusiveNightCount($("startDate").value, $("endDate").value || $("startDate").value);
  const limits = state.config?.limits ?? { maxDraftDays: 1, maxDraftChanges: 20, maxRunDays: 45 };
  $("createRun").disabled = targetCount === 0 || nights > limits.maxRunDays;
  renderRateSummary(summary, targetCount, nights, limits);
  renderRateGrid(summary);
  renderExceptions(summary);
}

function renderDraftList(drafts) {
  const list = $("draftList");
  if (!drafts.length) {
    list.innerHTML = `<div class="empty">No drafts yet.</div>`;
    return;
  }

  list.innerHTML = drafts
    .map(
      (draft) => `
        <button class="draft-item" data-draft-id="${draft.id}" type="button">
          <strong>${escapeHtml(draft.propertyName ?? "")} · ${draft.startDate} to ${draft.endDate}</strong>
          <span>${draft.changeCount} changes · ${draft.status}</span>
          <span>${draft.id}</span>
        </button>
      `
    )
    .join("");

  list.querySelectorAll("[data-draft-id]").forEach((button) => {
    button.addEventListener("click", () => loadDraft(button.dataset.draftId));
  });
}

function renderBackupList(backups) {
  const list = $("backupList");
  if (!backups.length) {
    list.innerHTML = `<div class="empty">No backups yet.</div>`;
    return;
  }

  list.innerHTML = backups
    .map(
      (backup) => `
        <button class="draft-item backup-item" data-backup-id="${backup.id}" type="button">
          <strong>${escapeHtml(backup.propertyName ?? "")} · ${backup.startDate} to ${backup.endDate}</strong>
          <span>${backup.rollbackCount} rollback rows</span>
          <span>${backup.id}</span>
        </button>
      `
    )
    .join("");

  list.querySelectorAll("[data-backup-id]").forEach((button) => {
    button.addEventListener("click", () => createRollbackDraft(button.dataset.backupId));
  });
}

function renderRunList(runs) {
  const list = $("runList");
  if (!runs.length) {
    list.innerHTML = `<div class="empty">No runs yet.</div>`;
    return;
  }

  list.innerHTML = runs
    .map(
      (run) => `
        <button class="draft-item run-item" data-run-id="${run.id}" type="button">
          <strong>${escapeHtml(run.propertyName ?? "")} · ${run.startDate} to ${run.endDate}</strong>
          <span>${run.totalChanges} changes · ${run.chunkCount} chunks · ${run.status}${run.readinessOnly ? " · readiness check" : ""}</span>
          <span>${run.id}</span>
        </button>
      `
    )
    .join("");

  list.querySelectorAll("[data-run-id]").forEach((button) => {
    button.addEventListener("click", () => loadRun(button.dataset.runId));
  });
}

function renderAudit(events) {
  const list = $("auditList");
  if (!events.length) {
    list.className = "audit-list empty";
    list.textContent = "No audit events yet.";
    return;
  }

  list.className = "audit-list";
  list.innerHTML = events
    .map(
      (event) => `
        <div class="audit-event">
          <strong>${event.type}</strong>
          <span>${event.createdAt} · ${event.operator ?? "system"}</span>
          <span>${event.entityType ?? "-"} ${event.entityId ?? ""}</span>
        </div>
      `
    )
    .join("");
}

function renderRunDetail(run) {
  state.latestRun = run;
  $("selectedRunState").textContent = `${run.status} · ${run.id}`;
  const appliedChunks = run.chunks.filter((chunk) => chunk.status === "applied").length;
  const skippedChunks = run.chunks.filter((chunk) => chunk.status === "skipped").length;
  const failedChunks = run.chunks.filter((chunk) =>
    ["verification_failed", "apply_failed", "partial_apply_failed"].includes(chunk.status)
  ).length;
  const spillSuspectedChunks = run.chunks.filter((chunk) => chunk.driftSummary?.category === "adjacent_spill_suspected").length;
  const totalVerified = run.chunks.reduce((sum, chunk) => sum + (chunk.verifiedCount ?? 0), 0);
  const progress = run.progress ?? {};
  const chunkFailures = run.chunks
    .filter((chunk) => chunk.error)
    .map((chunk) => ({
      sequence: chunk.sequence,
      rawError: chunk.error,
      explanation: explainRunError(chunk.error),
      isLegacyHashBug: isLegacyHashMismatch(chunk.error),
    }));
  const primaryFailure = chunkFailures[0] ?? null;
  const canCreateSpillRepairDraft =
    run.type === "smooth" &&
    (spillSuspectedChunks > 0 || appliedChunks > 0) &&
    run.status !== "running";
  const runAlert =
    primaryFailure &&
    `
      <div class="run-alert ${primaryFailure.isLegacyHashBug ? "warn" : "error"}">
        <strong>${
          primaryFailure.isLegacyHashBug
            ? "This failed run came from the older hash-mismatch bug."
            : `${chunkFailures.length} chunk(s) need attention.`
        }</strong>
        <span>${escapeHtml(primaryFailure.explanation)}</span>
        ${
          chunkFailures.length > 1
            ? `<span class="muted">${chunkFailures.length - 1} more chunk issue(s) are listed below.</span>`
            : ""
        }
      </div>
    `;
  const runEvents = state.latestRunEvents.length
    ? `
      <div class="run-events">
        ${state.latestRunEvents
          .map(
            (event) => `
              <div class="run-event">
                <strong>${escapeHtml(event.type)}</strong>
                <span>${escapeHtml(summarizeRunEvent(event))}</span>
                <small>${escapeHtml(formatDateTime(event.createdAt))}</small>
              </div>
            `
          )
          .join("")}
      </div>
    `
    : `<div class="empty inset-empty">No run events yet.</div>`;
  const chunkRows = run.chunks
    .map(
      (chunk) => `
        <tr>
          <td><strong>Chunk ${chunk.sequence}</strong><br><span class="muted">${chunk.id}</span></td>
          <td>${chunk.startDate} to ${chunk.endDate}</td>
          <td class="money">${chunk.changeCount}</td>
          <td>${chunk.draftId ? `<span class="muted">${escapeHtml(chunk.draftId)}</span>` : "-"}</td>
          <td>${chunk.backupId ? `<span class="muted">${escapeHtml(chunk.backupId)}</span>` : "-"}</td>
          <td>
            <span class="pill ${["applied", "skipped"].includes(chunk.status) ? "ok" : chunk.status.includes("failed") ? "warn" : ""}">${escapeHtml(chunk.status)}</span>
            ${
              chunk.error
                ? `<div class="chunk-error ${isLegacyHashMismatch(chunk.error) ? "warn" : "error"}">${escapeHtml(explainRunError(chunk.error))}</div>`
                : ""
            }
            ${
              chunk.driftSummary?.category === "adjacent_spill_suspected"
                ? `<div class="chunk-note spill-note">${escapeHtml("Live readback matched the previous night's targets. Review for adjacent-night spill and use spill repair if needed.")}</div>`
                : ""
            }
            ${
              chunk.skipSummary
                ? `<div class="chunk-note">${escapeHtml(`${chunk.skipSummary.alreadySmoothCount} row(s) were already smooth and were skipped.`)}</div>`
                : ""
            }
            ${
              chunk.partialApply
                ? `<div class="chunk-note">${escapeHtml(`${chunk.partialApply.submittedJobs}/${chunk.partialApply.expectedJobs} Cloudbeds job(s) submitted before reconciliation.`)}</div>`
                : ""
            }
            ${
              chunk.appliedAt
                ? `<div class="chunk-note">Finished ${escapeHtml(formatDateTime(chunk.appliedAt))} · verified ${chunk.verifiedCount ?? 0}/${chunk.changeCount}</div>`
                : ""
            }
          </td>
        </tr>
      `
    )
    .join("");

  const resumable = ["planned", "running", "paused", "verification_failed", "apply_failed", "partial_apply_failed"].includes(run.status);
  const canRollback = !run.readinessOnly && run.type === "smooth" && appliedChunks > 0;
  const primaryAction = runPrimaryAction(run, failedChunks, appliedChunks);
  const canRetryFailedChunk = !run.readinessOnly && failedChunks > 0 && state.config.writesEnabled;
  const canReconcile = !run.readinessOnly && failedChunks > 0;
  $("runDetail").className = "draft-detail";
  $("runDetail").innerHTML = `
    <div class="summary-grid">
      <div class="metric"><span>Property</span><strong>${escapeHtml(run.propertyName)}</strong></div>
      <div class="metric"><span>Type</span><strong>${escapeHtml(run.type)}</strong></div>
      <div class="metric"><span>Total changes</span><strong>${run.totalChanges}</strong></div>
      <div class="metric"><span>Chunks</span><strong>${appliedChunks}/${run.chunkCount}</strong></div>
      <div class="metric"><span>Verified</span><strong>${totalVerified}/${run.totalChanges}</strong></div>
      <div class="metric"><span>Skipped</span><strong>${skippedChunks}</strong></div>
      <div class="metric"><span>Phase</span><strong>${escapeHtml(progress.phase ?? run.status)}</strong></div>
    </div>
    ${runAlert || ""}
    <div class="run-notes">
      <strong>${failedChunks ? `${failedChunks} chunk(s) need attention.` : "Each chunk creates its own draft and backup before writing."}</strong>
      <span>${escapeHtml(progress.message || run.notes || "Use rollback plan to generate per-chunk rollback drafts from this run's backups.")}</span>
      <span>${escapeHtml(`Last updated ${formatDateTime(progress.lastUpdatedAt || run.createdAt)}${progress.activeChunkSequence ? ` · active chunk ${progress.activeChunkSequence}` : ""}`)}</span>
    </div>
    <div class="approval">
      ${
        primaryAction
          ? `<button id="applyRun" data-run-mode="${escapeHtml(primaryAction.mode)}" type="button"${resumable && state.config.writesEnabled ? "" : " disabled"}>${escapeHtml(primaryAction.label)}</button>`
          : ""
      }
      <button id="reconcileRun" type="button" class="secondary"${canReconcile ? "" : " disabled"}>Recheck Failed Readback</button>
      <button id="retryFailedChunk" type="button" class="secondary"${canRetryFailedChunk ? "" : " disabled"}>Retry Failed Chunk Only</button>
      <button id="createSpillCorrectionDraft" type="button" class="secondary"${canCreateSpillRepairDraft ? "" : " disabled"}>Create Spill Repair Draft</button>
      <button id="createRollbackRun" type="button" class="secondary"${canRollback ? "" : " disabled"}>Create Rollback Run</button>
      <span class="apply-progress" id="runProgress" hidden>
        <span class="spinner" aria-hidden="true"></span>
        Executing chunked run with backups, drift checks, and verification...
      </span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Chunk</th>
            <th>Date span</th>
            <th>Changes</th>
            <th>Draft</th>
            <th>Backup</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${chunkRows || `<tr><td colspan="6" class="empty">No chunks planned.</td></tr>`}</tbody>
      </table>
    </div>
    <div class="run-events-panel">
      <h3>Run Events</h3>
      ${runEvents}
    </div>
  `;

  $("applyRun")?.addEventListener("click", applySelectedRun);
  $("reconcileRun")?.addEventListener("click", reconcileSelectedRun);
  $("retryFailedChunk")?.addEventListener("click", retryFailedChunk);
  $("createSpillCorrectionDraft")?.addEventListener("click", createSpillCorrectionDraft);
  $("createRollbackRun")?.addEventListener("click", createRollbackRun);
}

function groupChangesByRoom(changes) {
  const rooms = new Map();
  changes.forEach((change) => {
    const key = change.roomTypeID || change.roomTypeName;
    if (!rooms.has(key)) {
      rooms.set(key, {
        name: change.roomTypeName,
        changesByDate: new Map(),
      });
    }
    rooms.get(key).changesByDate.set(change.date ?? change.startDate, change);
  });
  return [...rooms.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function renderDraftChangeGrid(changes) {
  if (!changes.length) return `<div class="empty">No changes in this draft.</div>`;
  const dates = uniqueDates(changes.map((change) => ({ date: change.date ?? change.startDate })));
  const rooms = groupChangesByRoom(changes);
  return `
    <div class="calendar-wrap draft-calendar-wrap">
      <table class="rate-calendar draft-calendar">
        <thead>
          <tr>
            <th class="room-head">Room</th>
            ${dates.map((date) => `<th><span>${formatDateLabel(date)}</span><small>${date}</small></th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${rooms
            .map(
              (room) => `
                <tr>
                  <th class="room-name"><strong>${escapeHtml(room.name)}</strong></th>
                  ${dates
                    .map((date) => {
                      const change = room.changesByDate.get(date);
                      if (!change) return `<td class="rate-cell missing">-</td>`;
                      return `
                        <td class="rate-cell will-change">
                          <span class="current-rate">${formatMoney(change.currentRate)}</span>
                          <span class="rate-arrow">to</span>
                          <strong>${formatMoney(change.proposedRate)}</strong>
                        </td>
                      `;
                    })
                    .join("")}
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderApplyResult(draft) {
  const verification = draft.verification ?? [];
  if (!verification.length) return "";

  const summary = draft.verificationSummary ?? {
    targetedCount: verification.length,
    targetedVerifiedCount: verification.filter((item) => item.verified).length,
    untouchedScopeCount: 0,
    untouchedScopeVerifiedCount: 0,
    adjacentCount: 0,
    adjacentVerifiedCount: 0,
    adjacentSuspiciousCount: 0,
  };
  const mismatchCount =
    (summary.targetedCount - summary.targetedVerifiedCount) +
    (summary.untouchedScopeCount - summary.untouchedScopeVerifiedCount) +
    (summary.adjacentCount - summary.adjacentVerifiedCount);
  const tone = mismatchCount ? "error" : "good";
  const title = mismatchCount ? "Apply finished with verification warnings" : "Apply finished and verified";
  const description = mismatchCount
    ? "Cloudbeds accepted the apply request, but full-scope verification found targeted, untouched, or adjacent-night mismatches."
    : "Cloudbeds readback matched every targeted row, untouched row in scope, and adjacent spill-risk night.";
  const targetedRows = verification
    .map(
      (item) => `
        <tr>
          <td><strong>${escapeHtml(item.roomTypeName)}</strong><br><span class="muted">rate ${escapeHtml(item.rateID)}</span></td>
          <td>${escapeHtml(item.date)}</td>
          <td class="money">${formatMoney(item.expectedRate)}</td>
          <td class="money">${formatMoney(item.actualRate)}</td>
          <td><span class="pill ${item.verified ? "ok" : "warn"}">${item.verified ? "Updated" : "Mismatch"}</span></td>
        </tr>
      `
    )
    .join("");
  const untouchedRows = (draft.scopeVerification ?? [])
    .filter((item) => item.kind === "untouched_scope" && !item.verified)
    .map(
      (item) => `
        <tr>
          <td><strong>${escapeHtml(item.roomTypeName)}</strong><br><span class="muted">untouched scope row</span></td>
          <td>${escapeHtml(item.date)}</td>
          <td class="money">${formatMoney(item.expectedRate)}</td>
          <td class="money">${formatMoney(item.actualRate)}</td>
          <td><span class="pill warn">Changed unexpectedly</span></td>
        </tr>
      `
    )
    .join("");
  const adjacentRows = (draft.adjacentVerification ?? [])
    .filter((item) => !item.verified && !item.overlapsTargetedDate)
    .map(
      (item) => `
        <tr>
          <td><strong>${escapeHtml(item.roomTypeName)}</strong><br><span class="muted">${item.suspectedSpill ? "adjacent spill suspected" : "adjacent risk night"}</span></td>
          <td>${escapeHtml(item.date)}</td>
          <td class="money">${formatMoney(item.expectedRate)}</td>
          <td class="money">${formatMoney(item.actualRate)}</td>
          <td><span class="pill warn">${item.suspectedSpill ? "Spill suspected" : "Mismatch"}</span></td>
        </tr>
      `
    )
    .join("");

  return `
    <section class="apply-result ${tone}" id="applyResult">
      <div class="apply-result-head">
        <div>
          <h3>${title}</h3>
          <p>${description}</p>
        </div>
        <strong>${summary.targetedVerifiedCount}/${summary.targetedCount} targeted</strong>
      </div>
      <div class="summary-grid compact-summary verification-summary">
        <div class="metric"><span>Targeted</span><strong>${summary.targetedVerifiedCount}/${summary.targetedCount}</strong></div>
        <div class="metric"><span>Untouched scope</span><strong>${summary.untouchedScopeVerifiedCount}/${summary.untouchedScopeCount}</strong></div>
        <div class="metric"><span>Adjacent nights</span><strong>${summary.adjacentVerifiedCount}/${summary.adjacentCount}</strong></div>
        <div class="metric"><span>Spill warnings</span><strong>${summary.adjacentSuspiciousCount}</strong></div>
      </div>
      <div class="table-wrap readback-wrap">
        <table>
          <thead>
            <tr>
              <th>Room</th>
              <th>Date</th>
              <th>Approved</th>
              <th>Cloudbeds now shows</th>
              <th>Readback</th>
            </tr>
          </thead>
          <tbody>${targetedRows}</tbody>
        </table>
      </div>
      ${
        untouchedRows
          ? `<div class="table-wrap readback-wrap"><table><thead><tr><th>Room</th><th>Date</th><th>Expected untouched value</th><th>Cloudbeds now shows</th><th>Status</th></tr></thead><tbody>${untouchedRows}</tbody></table></div>`
          : ""
      }
      ${
        adjacentRows
          ? `<div class="table-wrap readback-wrap"><table><thead><tr><th>Room</th><th>Date</th><th>Expected adjacent value</th><th>Cloudbeds now shows</th><th>Status</th></tr></thead><tbody>${adjacentRows}</tbody></table></div>`
          : ""
      }
    </section>
  `;
}

function renderDraftDetail(draft) {
  state.latestDraft = draft;
  $("selectedDraftState").textContent = `${draft.status} · ${draft.id}`;
  const verified = draft.verification?.filter((item) => item.verified).length ?? 0;
  const draftGrid = renderDraftChangeGrid(draft.changes);
  const applyResult = renderApplyResult(draft);
  const changesTable = draft.changes
    .map(
      (change) => `
        <tr>
          <td><strong>${escapeHtml(change.roomTypeName)}</strong><br><span class="muted">rate ${escapeHtml(change.rateID)}</span></td>
          <td>${change.date ?? change.startDate}</td>
          <td class="money">${formatMoney(change.currentRate)}</td>
          <td class="money">${formatMoney(change.proposedRate)}</td>
          <td><span class="pill ${change.conflict ? "warn" : "ok"}">${change.conflict ? "Review conflict" : `Rollback: ${formatMoney(change.currentRate)}`}</span></td>
        </tr>
      `
    )
    .join("");

  const applyControls =
    draft.status === "draft"
      ? `
        <div class="approval">
          <button id="applyDraft" type="button"${state.config.writesEnabled ? "" : " disabled"}>Apply Approved Draft</button>
          <span id="applyProgress" class="apply-progress" hidden>
            <span class="spinner" aria-hidden="true"></span>
            Applying and verifying with Cloudbeds...
          </span>
        </div>
      `
      : "";

  $("draftDetail").className = "draft-detail";
  $("draftDetail").innerHTML = `
    <div class="summary-grid">
      <div class="metric"><span>Property</span><strong>${escapeHtml(draft.propertyName)}</strong></div>
      <div class="metric"><span>Changes</span><strong>${draft.changes.length}</strong></div>
      <div class="metric"><span>Backup</span><strong>${escapeHtml(draft.backupId)}</strong></div>
      <div class="metric"><span>Verified</span><strong>${verified}/${draft.changes.length}</strong></div>
    </div>
    ${draftGrid}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Room</th>
            <th>Date</th>
            <th>Original</th>
            <th>Proposed</th>
            <th>Rollback</th>
          </tr>
        </thead>
        <tbody>${changesTable || `<tr><td colspan="5" class="empty">No changes in this draft.</td></tr>`}</tbody>
      </table>
    </div>
    ${applyResult}
    ${applyControls}
  `;

  const applyButton = $("applyDraft");
  if (applyButton) {
    applyButton.addEventListener("click", applySelectedDraft);
  }
}

async function loadConfig() {
  state.config = await api("/api/config");
  state.selectedPropertyKey = state.selectedPropertyKey ?? state.config.defaultPropertyKey;
  renderConfig();
}

async function fetchRates() {
  const startDate = $("startDate").value;
  const endDate = $("endDate").value || tomorrow(startDate);
  if (!startDate) {
    setMessage("Choose a start date first.", "error");
    return;
  }
  const nights = enumerateNights(startDate, endDate);
  if (!nights.length) {
    setMessage("End night must be on or after start night.", "error");
    return;
  }
  const rows = [];
  const fetchButton = $("fetchRates");
  const runButton = $("createRun");
  if (fetchButton) {
    fetchButton.disabled = true;
    fetchButton.textContent = "Fetching...";
  }
  if (runButton) runButton.disabled = true;

  try {
    setMessage("Fetching live Cloudbeds rates...");
    setOperationProgress({
      label: "Fetching rates",
      detail: `Starting ${nights.length} night${nights.length === 1 ? "" : "s"} from Cloudbeds...`,
      completed: 0,
      total: nights.length,
    });
    for (const [index, night] of nights.entries()) {
      setOperationProgress({
        label: "Fetching rates",
        detail: `Fetching ${formatDateLabel(night)} (${index + 1} of ${nights.length})`,
        completed: index,
        total: nights.length,
      });
      const params = new URLSearchParams({
        propertyKey: selectedPropertyKey(),
        startDate: night,
        endDate: night,
      });
      const json = await api(`/api/rates?${params}`);
      rows.push(...json.rows);
      setOperationProgress({
        label: "Fetching rates",
        detail: `Loaded ${formatDateLabel(night)} (${index + 1} of ${nights.length})`,
        completed: index + 1,
        total: nights.length,
      });
    }
    state.rates = rows;
    renderRates();
    const targetCount = state.rates.filter((row) => row.targetByDefault && row.proposedRate !== row.currentRate).length;
    const limits = state.config.limits;
    const draftLimitNote =
      targetCount > limits.maxDraftChanges || nights.length > limits.maxDraftDays
        ? ` Draft creation is disabled by current limits (${limits.maxDraftDays} night / ${limits.maxDraftChanges} rows).`
        : "";
    const runLimitNote = nights.length > limits.maxRunDays ? ` Large-batch runs are capped at ${limits.maxRunDays} nights.` : "";
    setMessage(
      `Loaded ${state.rates.length} nightly rows across ${nights.length} night${nights.length === 1 ? "" : "s"}. ${targetCount} base rates would change.${draftLimitNote}${runLimitNote}`,
      targetCount ? "good" : ""
    );
    setOperationProgress({
      label: "Fetch complete",
      detail: `${state.rates.length} rows loaded.`,
      percent: 100,
    });
  } finally {
    if (fetchButton) {
      fetchButton.disabled = false;
      fetchButton.textContent = "Fetch Rates";
    }
    renderRates();
  }
}

async function createRun() {
  const startDate = $("startDate").value;
  const endDate = $("endDate").value || tomorrow(startDate);
  setMessage("Planning large-batch run and chunk boundaries...");
  const json = await api("/api/runs", {
    method: "POST",
    body: JSON.stringify({ propertyKey: selectedPropertyKey(), startDate, endDate, operator: "web-app", notes: $("notes").value, type: "smooth" }),
  });
  const events = await api(`/api/runs/${json.run.id}/events?limit=20`);
  state.latestRunEvents = events.events;
  renderRunDetail(json.run);
  await loadRuns();
  await loadAudit();
  setMessage(`Run ${json.run.id} planned with ${json.run.totalChanges} changes across ${json.run.chunkCount} chunks.`, "good");
}

async function loadDrafts() {
  const json = await api("/api/drafts");
  renderDraftList(json.drafts);
}

async function loadRuns() {
  const json = await api("/api/runs");
  renderRunList(json.runs);
}

async function loadBackups() {
  const json = await api("/api/backups");
  renderBackupList(json.backups);
}

async function loadAudit() {
  const json = await api("/api/audit?limit=40");
  renderAudit(json.events);
}

async function loadDraft(id) {
  setMessage(`Loading ${id}...`);
  const json = await api(`/api/drafts/${id}`);
  renderDraftDetail(json.draft);
  setMessage(`Loaded ${id}.`, "good");
}

async function loadRun(id) {
  setMessage(`Loading ${id}...`);
  const [json, events] = await Promise.all([api(`/api/runs/${id}`), api(`/api/runs/${id}/events?limit=20`)]);
  state.latestRunEvents = events.events;
  renderRunDetail(json.run);
  setMessage(`Loaded ${id}.`, "good");
}

async function createRollbackDraft(backupId) {
  setMessage(`Creating rollback draft from ${backupId}...`);
  const json = await api(`/api/backups/${backupId}/rollback-draft`, {
    method: "POST",
    body: JSON.stringify({ operator: "web-app" }),
  });
  renderDraftDetail(json.draft);
  await loadDrafts();
  await loadBackups();
  await loadAudit();
  const conflicts = json.draft.changes.filter((change) => change.conflict).length;
  setMessage(
    conflicts
      ? `Rollback draft created with ${conflicts} conflicts to review.`
      : `Rollback draft ${json.draft.id} created.`,
    conflicts ? "error" : "good"
  );
}

function startRunProgressPolling(runId) {
  let stopped = false;
  let inFlight = false;
  const poll = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const json = await api(`/api/runs/${runId}`);
      state.latestRun = json.run;
      renderRunDetail(json.run);
      setOperationProgress({
        label: json.run.type === "rollback" ? "Executing rollback run" : "Executing run chunks",
        detail: describeRunProgress(json.run),
        percent: runProgressPercent(json.run),
      });
    } catch {
      // Keep the in-flight operation moving even if one status poll misses.
    } finally {
      inFlight = false;
    }
  };
  poll();
  const timer = window.setInterval(poll, 1500);
  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}

async function applySelectedRun() {
  const run = state.latestRun;
  if (!run) return;
  const mode = $("applyRun")?.dataset.runMode || "resume";
  const actionLabel = run.type === "rollback" ? "execute this rollback run" : "apply this large batch run";
  if (!window.confirm(`Are you sure you want to ${actionLabel}? Each chunk will recheck live Cloudbeds rates before writing.`)) return;

  const button = $("applyRun");
  const retryButton = $("retryFailedChunk");
  const rollbackButton = $("createRollbackRun");
  const progress = $("runProgress");
  if (button) {
    button.disabled = true;
    button.textContent = mode === "resume" ? "Running..." : "Retrying...";
    button.classList.add("working");
  }
  if (retryButton) retryButton.disabled = true;
  if (rollbackButton) rollbackButton.disabled = true;
  if (progress) progress.hidden = false;
  setOperationProgress({
    label: run.type === "rollback" ? "Executing rollback run" : "Executing run chunks",
    detail: describeRunProgress(run),
    percent: runProgressPercent(run),
  });
  const stopPolling = startRunProgressPolling(run.id);

  try {
    setMessage("Executing chunked run with live drift checks...");
    const json = await api(`/api/runs/${run.id}/apply`, {
      method: "POST",
      body: JSON.stringify({ confirmation: "yes", mode }),
    });
    const events = await api(`/api/runs/${run.id}/events?limit=20`);
    state.latestRunEvents = events.events;
    renderRunDetail(json.run);
    setOperationProgress({
      label: json.run.status === "applied" ? "Run complete" : "Run paused",
      detail: describeRunProgress(json.run),
      percent: runProgressPercent(json.run),
    });
    await loadRuns();
    await loadDrafts();
    await loadBackups();
    await loadAudit();
    await fetchRates();
    const ok = json.run.status === "applied";
    setMessage(ok ? "Run completed with chunk-level backups and verification." : `Run paused with status ${json.run.status}. Review the run detail.`, ok ? "good" : "error");
  } catch (error) {
    setMessage(error.message, "error");
    if (button) {
      button.disabled = false;
      button.textContent = run.type === "rollback" ? "Execute Rollback Run" : "Apply Run in Chunks";
      button.classList.remove("working");
    }
    if (retryButton) retryButton.disabled = false;
    if (rollbackButton) rollbackButton.disabled = false;
    if (progress) progress.hidden = true;
    setOperationProgress({
      label: "Run stopped",
      detail: error.message,
      percent: runProgressPercent(state.latestRun ?? run),
    });
  } finally {
    stopPolling();
  }
}

async function retryFailedChunk() {
  const run = state.latestRun;
  if (!run) return;
  if (!window.confirm("Retry only the first failed chunk? The app will preflight live rates again before writing.")) return;

  const button = $("applyRun");
  const retryButton = $("retryFailedChunk");
  const rollbackButton = $("createRollbackRun");
  const progress = $("runProgress");
  if (button) button.disabled = true;
  if (retryButton) {
    retryButton.disabled = true;
    retryButton.textContent = "Retrying...";
  }
  if (rollbackButton) rollbackButton.disabled = true;
  if (progress) progress.hidden = false;
  setOperationProgress({
    label: "Retrying failed chunk",
    detail: describeRunProgress(run),
    percent: runProgressPercent(run),
  });
  const stopPolling = startRunProgressPolling(run.id);

  try {
    setMessage("Retrying the first failed chunk with a fresh preflight...");
    const json = await api(`/api/runs/${run.id}/apply`, {
      method: "POST",
      body: JSON.stringify({ confirmation: "yes", mode: "retry_failed_chunk" }),
    });
    const events = await api(`/api/runs/${run.id}/events?limit=20`);
    state.latestRunEvents = events.events;
    renderRunDetail(json.run);
    setOperationProgress({
      label: json.run.status === "applied" ? "Run complete" : "Retry finished",
      detail: describeRunProgress(json.run),
      percent: runProgressPercent(json.run),
    });
    await loadRuns();
    await loadDrafts();
    await loadBackups();
    await loadAudit();
    await fetchRates();
    setMessage(json.run.status === "applied" ? "Failed chunk retry completed and the run is now applied." : `Retry finished with status ${json.run.status}. Review the run detail.`, json.run.status === "applied" ? "good" : "error");
  } catch (error) {
    setMessage(error.message, "error");
    setOperationProgress({
      label: "Retry stopped",
      detail: error.message,
      percent: runProgressPercent(state.latestRun ?? run),
    });
    await loadRun(run.id).catch(() => {});
  } finally {
    stopPolling();
  }
}

async function reconcileSelectedRun() {
  const run = state.latestRun;
  if (!run) return;
  const button = $("reconcileRun");
  const applyButton = $("applyRun");
  const retryButton = $("retryFailedChunk");
  if (button) {
    button.disabled = true;
    button.textContent = "Rechecking...";
  }
  if (applyButton) applyButton.disabled = true;
  if (retryButton) retryButton.disabled = true;

  try {
    setMessage("Rechecking failed chunk readback without writing...");
    const json = await api(`/api/runs/${run.id}/reconcile`, {
      method: "POST",
      body: JSON.stringify({ operator: "web-app-reconcile" }),
    });
    const events = await api(`/api/runs/${run.id}/events?limit=20`);
    state.latestRunEvents = events.events;
    renderRunDetail(json.run);
    await loadRuns();
    await loadDrafts();
    await loadBackups();
    await loadAudit();
    setMessage(
      json.run.status === "applied"
        ? "Delayed Cloudbeds readback now verifies cleanly."
        : `Recheck finished with status ${json.run.status}.`,
      json.run.status === "applied" ? "good" : "error"
    );
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    if (button) {
      button.textContent = "Recheck Failed Readback";
      button.disabled = false;
    }
    if (applyButton) applyButton.disabled = false;
    if (retryButton) retryButton.disabled = false;
  }
}

async function createRollbackRun() {
  const run = state.latestRun;
  if (!run) return;
  setMessage(`Planning rollback run for ${run.id}...`);
  const json = await api(`/api/runs/${run.id}/rollback-plan`, {
    method: "POST",
    body: JSON.stringify({ operator: "web-app" }),
  });
  const events = await api(`/api/runs/${json.run.id}/events?limit=20`);
  state.latestRunEvents = events.events;
  renderRunDetail(json.run);
  await loadRuns();
  await loadDrafts();
  await loadBackups();
  await loadAudit();
  setMessage(`Rollback run ${json.run.id} created with ${json.run.chunkCount} chunks.`, "good");
}

async function createSpillCorrectionDraft() {
  const run = state.latestRun;
  if (!run) return;
  setMessage(`Auditing ${run.id} for proven spill rows...`);
  const json = await api(`/api/runs/${run.id}/spill-correction-draft`, {
    method: "POST",
    body: JSON.stringify({ operator: "web-app" }),
  });
  renderDraftDetail(json.draft);
  await loadDrafts();
  await loadBackups();
  await loadAudit();
  setMessage(`Spill repair draft ${json.draft.id} created with ${json.draft.changes.length} rows. Review it in Selected Draft.`, "good");
}

async function applySelectedDraft() {
  const draft = state.latestDraft;
  if (!draft) return;
  if (!window.confirm("Are you sure? This will write these approved rates to Cloudbeds.")) return;

  const button = $("applyDraft");
  const progress = $("applyProgress");
  if (button) {
    button.disabled = true;
    button.textContent = "Applying...";
    button.classList.add("working");
  }
  if (progress) progress.hidden = false;

  try {
    setMessage("Applying approved draft and waiting for Cloudbeds verification...");
    const detail = $("draftDetail");
    if (detail) detail.insertAdjacentHTML("afterbegin", `<div class="inline-message">Applying approved draft and waiting for Cloudbeds verification...</div>`);
    const json = await api(`/api/drafts/${draft.id}/apply`, {
      method: "POST",
      body: JSON.stringify({ confirmation: "yes" }),
    });
    renderDraftDetail(json.draft);
    await loadDrafts();
    await loadAudit();
    await fetchRates();
    const ok = json.draft.verification.every((item) => item.verified);
    setMessage(
      ok ? "Draft applied and verified. Readback is shown in the selected draft." : "Draft applied with readback mismatches. Review the selected draft result.",
      ok ? "good" : "error"
    );
    $("applyResult")?.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch (error) {
    setMessage(error.message, "error");
    const detail = $("draftDetail");
    if (detail) {
      detail.insertAdjacentHTML("afterbegin", `<div class="inline-message error">${escapeHtml(error.message)}</div>`);
    }
    if (button) {
      button.disabled = false;
      button.textContent = "Apply Approved Draft";
      button.classList.remove("working");
    }
    if (progress) progress.hidden = true;
  }
}

function setDefaultDates() {
  const today = new Date();
  const date = today.toISOString().slice(0, 10);
  $("startDate").value = date;
  $("endDate").value = tomorrow(date);
}

async function init() {
  setDefaultDates();
  $("fetchRates").addEventListener("click", () => fetchRates().catch((error) => setMessage(error.message, "error")));
  $("propertySelect").addEventListener("change", () => {
    state.selectedPropertyKey = $("propertySelect").value;
    state.rates = [];
    renderConfig();
    renderRates();
    setMessage(`Selected ${currentProperty().propertyName}. Fetch rates when ready.`);
  });
  $("createRun").addEventListener("click", () => createRun().catch((error) => setMessage(error.message, "error")));
  $("changesOnly").addEventListener("change", renderRates);
  $("showIgnored").addEventListener("change", renderRates);
  $("refreshRuns").addEventListener("click", () => loadRuns().catch((error) => setMessage(error.message, "error")));
  $("refreshDrafts").addEventListener("click", () => loadDrafts().catch((error) => setMessage(error.message, "error")));
  $("refreshBackups").addEventListener("click", () => loadBackups().catch((error) => setMessage(error.message, "error")));
  $("refreshAudit").addEventListener("click", () => loadAudit().catch((error) => setMessage(error.message, "error")));
  await loadConfig();
  await loadRuns();
  await loadDrafts();
  await loadBackups();
  await loadAudit();
}

init().catch((error) => setMessage(error.message, "error"));
