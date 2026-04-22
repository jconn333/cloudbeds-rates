const state = {
  config: null,
  rates: [],
  latestDraft: null,
};

const $ = (id) => document.getElementById(id);

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
  $("propertyLine").textContent = `${state.config.propertyName} · property ${state.config.propertyId} · max ${limits.maxDraftDays} day / ${limits.maxDraftChanges} draft rows`;
  $("writeBadge").textContent = state.config.writesEnabled ? "Writes enabled" : "Preview mode";
  $("writeBadge").className = `badge ${state.config.writesEnabled ? "on" : "off"}`;
}

function rateStatus(row) {
  if (row.isDerived) return ["Derived", "warn"];
  if (row.ratePlanID || row.ratePlanNamePublic) return ["Named plan", "warn"];
  if (row.proposedRate === row.currentRate) return ["Already smooth", "ok"];
  return ["Draft target", "ok"];
}

function renderRates() {
  $("rateCount").textContent = `${state.rates.length} rows`;
  const body = $("ratesBody");
  if (!state.rates.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">No rates loaded.</td></tr>`;
    $("createDraft").disabled = true;
    return;
  }

  const targetCount = state.rates.filter((row) => row.targetByDefault && row.proposedRate !== row.currentRate).length;
  $("createDraft").disabled = targetCount === 0;
  body.innerHTML = state.rates
    .map((row) => {
      const [label, tone] = rateStatus(row);
      const plan = row.ratePlanNamePublic ?? row.ratePlanNamePrivate ?? "Base";
      const draft = row.targetByDefault ? formatMoney(row.proposedRate) : "-";
      return `
        <tr>
          <td><strong>${row.roomTypeName}</strong><br><span class="muted">rate ${row.rateID}</span></td>
          <td>${plan}</td>
          <td class="money">${formatMoney(row.currentRate)}</td>
          <td class="money">${draft}</td>
          <td><span class="pill ${tone}">${label}</span></td>
        </tr>
      `;
    })
    .join("");
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
          <strong>${draft.startDate} to ${draft.endDate}</strong>
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
          <strong>${backup.startDate} to ${backup.endDate}</strong>
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

function renderDraftDetail(draft) {
  state.latestDraft = draft;
  $("selectedDraftState").textContent = `${draft.status} · ${draft.id}`;
  const verified = draft.verification?.filter((item) => item.verified).length ?? 0;
  const changesTable = draft.changes
    .map(
      (change) => `
        <tr>
          <td><strong>${change.roomTypeName}</strong><br><span class="muted">rate ${change.rateID}</span></td>
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
          <div class="field grow">
            <label for="confirmText">Confirmation</label>
            <input id="confirmText" type="text" placeholder="APPLY ${draft.id}">
          </div>
          <button id="applyDraft" type="button"${state.config.writesEnabled ? "" : " disabled"}>Apply Approved Draft</button>
        </div>
      `
      : "";

  $("draftDetail").className = "draft-detail";
  $("draftDetail").innerHTML = `
    <div class="summary-grid">
      <div class="metric"><span>Property</span><strong>${draft.propertyName}</strong></div>
      <div class="metric"><span>Changes</span><strong>${draft.changes.length}</strong></div>
      <div class="metric"><span>Backup</span><strong>${draft.backupId}</strong></div>
      <div class="metric"><span>Verified</span><strong>${verified}/${draft.changes.length}</strong></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Room</th>
            <th>Original</th>
            <th>Proposed</th>
            <th>Rollback</th>
          </tr>
        </thead>
        <tbody>${changesTable || `<tr><td colspan="4" class="empty">No changes in this draft.</td></tr>`}</tbody>
      </table>
    </div>
    ${applyControls}
  `;

  const applyButton = $("applyDraft");
  if (applyButton) {
    applyButton.addEventListener("click", applySelectedDraft);
  }
}

async function loadConfig() {
  state.config = await api("/api/config");
  renderConfig();
}

async function fetchRates() {
  const startDate = $("startDate").value;
  const endDate = $("endDate").value || tomorrow(startDate);
  if (!startDate) {
    setMessage("Choose a start date first.", "error");
    return;
  }
  setMessage("Fetching live Cloudbeds rates...");
  const json = await api(`/api/rates?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`);
  state.rates = json.rows;
  renderRates();
  const targetCount = state.rates.filter((row) => row.targetByDefault && row.proposedRate !== row.currentRate).length;
  setMessage(`Loaded ${state.rates.length} rows. ${targetCount} base rates would change.`, "good");
}

async function createDraft() {
  const startDate = $("startDate").value;
  const endDate = $("endDate").value || tomorrow(startDate);
  setMessage("Creating draft and backup snapshot...");
  const json = await api("/api/drafts", {
    method: "POST",
    body: JSON.stringify({ startDate, endDate, operator: "web-app", notes: $("notes").value }),
  });
  renderDraftDetail(json.draft);
  await loadDrafts();
  await loadAudit();
  setMessage(`Draft ${json.draft.id} created with ${json.draft.changes.length} changes.`, "good");
}

async function loadDrafts() {
  const json = await api("/api/drafts");
  renderDraftList(json.drafts);
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

async function applySelectedDraft() {
  const draft = state.latestDraft;
  if (!draft) return;
  setMessage("Applying approved draft and waiting for Cloudbeds verification...");
  const json = await api(`/api/drafts/${draft.id}/apply`, {
    method: "POST",
    body: JSON.stringify({ confirmation: $("confirmText").value }),
  });
  renderDraftDetail(json.draft);
  await loadDrafts();
  await loadAudit();
  await fetchRates();
  const ok = json.draft.verification.every((item) => item.verified);
  setMessage(ok ? "Draft applied and verified." : "Draft applied but verification found mismatches.", ok ? "good" : "error");
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
  $("createDraft").addEventListener("click", () => createDraft().catch((error) => setMessage(error.message, "error")));
  $("refreshDrafts").addEventListener("click", () => loadDrafts().catch((error) => setMessage(error.message, "error")));
  $("refreshBackups").addEventListener("click", () => loadBackups().catch((error) => setMessage(error.message, "error")));
  $("refreshAudit").addEventListener("click", () => loadAudit().catch((error) => setMessage(error.message, "error")));
  await loadConfig();
  await loadDrafts();
  await loadBackups();
  await loadAudit();
}

init().catch((error) => setMessage(error.message, "error"));
