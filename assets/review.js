const QUEUE_PATH = "data/review/queue.json";
const DB_NAME = "daily-song-list-review";
const STORE_NAME = "patch-records";

const state = {
  queue: [],
  selected: null,
  selectedSource: null,
  drafts: [],
  undoStack: [],
  db: null,
};

const els = {
  summary: document.getElementById("summary"),
  queue: document.getElementById("queue"),
  detail: document.getElementById("detail"),
  riskFilter: document.getElementById("riskFilter"),
  nicheUnknownOnly: document.getElementById("nicheUnknownOnly"),
  searchBox: document.getElementById("searchBox"),
  exportPatch: document.getElementById("exportPatch"),
  copyPatch: document.getElementById("copyPatch"),
  copyCodex: document.getElementById("copyCodex"),
  clearDrafts: document.getElementById("clearDrafts"),
  importPatch: document.getElementById("importPatch"),
};

init().catch((error) => {
  els.detail.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
});

async function init() {
  state.db = await openDb();
  state.drafts = await loadDrafts();
  const queuePayload = await fetchJson(QUEUE_PATH);
  state.queue = queuePayload.items || [];
  bindEvents();
  render();
}

function bindEvents() {
  for (const el of [els.riskFilter, els.nicheUnknownOnly, els.searchBox]) el.addEventListener("input", renderQueue);
  els.exportPatch.addEventListener("click", exportPatch);
  els.copyPatch.addEventListener("click", () => copyText(JSON.stringify(buildPatch(), null, 2)));
  els.copyCodex.addEventListener("click", copyCodexText);
  els.clearDrafts.addEventListener("click", clearDrafts);
  els.importPatch.addEventListener("change", importPatch);
}

function render() {
  renderSummary();
  renderQueue();
  renderDetail();
}

function renderSummary() {
  const counts = countBy(state.drafts, (record) => record.action);
  els.summary.textContent = `队列 ${state.queue.length} / 修改 ${state.drafts.length} / 删除 ${counts.drop_entry || 0} / 替换 ${counts.replace_entry || 0} / 来源作废 ${counts.reject_source || 0}`;
}

function renderQueue() {
  const items = filteredQueue();
  if (!items.length) {
    els.queue.innerHTML = `<div class="empty">没有匹配来源</div>`;
    return;
  }
  els.queue.innerHTML = items
    .map(
      (item) => `
        <button class="queue-item" data-review-id="${escapeAttr(item.reviewId)}" aria-selected="${state.selected?.reviewId === item.reviewId}">
          <div class="queue-title">${escapeHtml(item.videoTitle || item.videoId)}</div>
          <div class="meta">${escapeHtml(item.channelName)} · ${escapeHtml(item.sourceType)} · ${escapeHtml(item.sourceId || item.sourceHash)}</div>
          <div class="toolbar" style="margin-top: 6px;">
            <span class="badge ${escapeAttr(item.riskLevel)}">${escapeHtml(item.riskLevel)} ${item.riskScore}</span>
            <span class="badge">未知 ${item.unknownArtistCount}</span>
            <span class="badge">小众 ${item.nicheCount}</span>
            <span class="badge">活动 ${item.activityMarkerCount}</span>
          </div>
        </button>
      `,
    )
    .join("");
  els.queue.querySelectorAll(".queue-item").forEach((button) => {
    button.addEventListener("click", () => selectReview(button.dataset.reviewId));
  });
}

function filteredQueue() {
  const risk = els.riskFilter.value;
  const term = normalizeSearch(els.searchBox.value);
  return state.queue.filter((item) => {
    if (risk && item.riskLevel !== risk) return false;
    if (els.nicheUnknownOnly.checked && !(item.nicheCount > 0 && item.unknownArtistCount > 0)) return false;
    if (!term) return true;
    return normalizeSearch(`${item.videoTitle} ${item.channelName} ${item.videoId} ${item.sourceId} ${item.riskReasons?.join(" ")}`).includes(term);
  });
}

async function selectReview(reviewId) {
  state.selected = state.queue.find((item) => item.reviewId === reviewId) || null;
  state.selectedSource = null;
  renderQueue();
  renderDetail();
  if (!state.selected) return;
  state.selectedSource = await fetchJson(state.selected.sourcePath);
  renderDetail();
}

function renderDetail() {
  if (!state.selected) {
    els.detail.innerHTML = `<div class="empty">选择一个来源</div>`;
    return;
  }
  const item = state.selected;
  const source = state.selectedSource;
  if (!source) {
    els.detail.innerHTML = `<div class="empty">加载来源 ${escapeHtml(item.sourceId)}</div>`;
    return;
  }
  const accepted = (source.entries || []).filter((entry) => entry.status === "accepted").length;
  const rejected = (source.entries || []).filter((entry) => entry.status === "rejected").length;
  els.detail.innerHTML = `
    <section>
      <div class="toolbar">
        <span class="badge ${escapeAttr(item.riskLevel)}">${escapeHtml(item.riskLevel)} ${item.riskScore}</span>
        <span class="badge">接受 ${accepted}</span>
        <span class="badge">拒绝 ${rejected}</span>
        <span class="badge">修改影响 ${impactText()}</span>
      </div>
      <h3>${escapeHtml(item.videoTitle || item.videoId)}</h3>
      <div class="meta">${escapeHtml(item.channelName)} · ${escapeHtml(item.sourceType)} · ${escapeHtml(item.sourceId)}</div>
      <div class="toolbar" style="margin-top: 8px;">
        <a href="${escapeAttr(item.youtubeUrl)}" target="_blank" rel="noreferrer"><button>打开 YouTube</button></a>
        <button data-action="reject-source" class="danger">整条来源作废</button>
        <button data-action="drop-video" class="danger">整段视频作废</button>
        <button data-action="force-refresh">加入强制重新检查队列</button>
        <button data-action="copy-source-text">复制原评论</button>
        <button data-action="copy-source-json">复制来源 JSON</button>
        <button data-action="undo">撤销修改</button>
      </div>
    </section>
    <section>
      <h3>原始来源</h3>
      <div class="source-text">${source.source?.sourceTextAvailable ? escapeHtml(source.source.sourceText) : "旧数据缺少完整原文，建议强制重新检查。"}</div>
    </section>
    <section class="entry-table">
      <table>
        <thead><tr><th>时间</th><th>标题</th><th>歌手</th><th>状态</th><th>风险</th><th>操作</th></tr></thead>
        <tbody>${(source.entries || []).map(renderEntryRow).join("")}</tbody>
      </table>
    </section>
  `;
  els.detail.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleSourceAction(button.dataset.action));
  });
  els.detail.querySelectorAll("[data-row-action]").forEach((button) => {
    button.addEventListener("click", () => handleRowAction(button.dataset.rowAction, button.closest("tr").dataset.rawHash));
  });
}

function renderEntryRow(entry) {
  return `
    <tr data-raw-hash="${escapeAttr(entry.rawHash || "")}">
      <td>${escapeHtml(entry.time || secondsToTime(entry.seconds))}</td>
      <td>${escapeHtml(entry.title || "")}<div class="meta">${escapeHtml(entry.raw || "")}</div></td>
      <td>${escapeHtml(entry.artist || "")}</td>
      <td>${escapeHtml(entry.status || "")}</td>
      <td>${(entry.riskReasons || []).map((reason) => `<span class="badge">${escapeHtml(reason)}</span>`).join(" ")}</td>
      <td class="actions"><div class="row-actions">
        <button data-row-action="keep">确认是歌曲</button>
        <button data-row-action="drop" class="danger">删除此行</button>
        <button data-row-action="title">修正歌名</button>
        <button data-row-action="artist">修正歌手</button>
        <button data-row-action="seconds">修正时间</button>
        <button data-row-action="force">强制保留</button>
        <button data-row-action="copy">复制原始行</button>
      </div></td>
    </tr>
  `;
}

function handleSourceAction(action) {
  const item = state.selected;
  const source = state.selectedSource?.source || {};
  if (action === "copy-source-text") return copyText(source.sourceText || "");
  if (action === "copy-source-json") return copyText(JSON.stringify(state.selectedSource, null, 2));
  if (action === "undo") return undoDraft();
  if (action === "drop-video") return addDraft({ action: "drop_video", videoId: item.videoId, reason: "review_drop_video" });
  const record = {
    action: "reject_source",
    videoId: item.videoId,
    sourceId: item.sourceId,
    sourceHash: item.sourceHash,
    reason: action === "force-refresh" ? "force_recheck_request" : "review_reject_source",
  };
  return addDraft(record);
}

function handleRowAction(action, rawHash) {
  const entry = (state.selectedSource?.entries || []).find((item) => item.rawHash === rawHash);
  if (!entry) return;
  if (action === "copy") return copyText(entry.raw || `${entry.time} ${entry.title}`);
  if (action === "keep" || action === "force") return addEntryDraft("force_keep", entry, { reason: "review_force_keep" });
  if (action === "drop") return addEntryDraft("drop_entry", entry, { reason: "review_drop_entry" });
  if (action === "title") {
    const title = prompt("修正歌名", entry.title || "");
    if (title) return addEntryDraft("replace_entry", entry, { replacement: { title }, reason: "review_replace_title" });
  }
  if (action === "artist") {
    const artist = prompt("修正歌手", entry.artist || "");
    if (artist != null) return addEntryDraft("replace_entry", entry, { replacement: { artist }, reason: "review_replace_artist" });
  }
  if (action === "seconds") {
    const value = prompt("修正秒数", String(entry.seconds ?? ""));
    const seconds = Number(value);
    if (Number.isInteger(seconds) && seconds >= 0) {
      return addEntryDraft("replace_entry", entry, { replacement: { seconds }, reason: "review_replace_seconds" });
    }
  }
}

function addEntryDraft(action, entry, extra = {}) {
  return addDraft({
    action,
    videoId: state.selected.videoId,
    sourceId: state.selected.sourceId,
    sourceHash: state.selected.sourceHash,
    seconds: Number(entry.seconds),
    rawHash: entry.rawHash,
    ...extra,
  });
}

async function addDraft(record) {
  const enriched = {
    reviewedAt: new Date().toISOString(),
    reviewedBy: "review.html",
    note: "",
    ...record,
  };
  state.undoStack.push([...state.drafts]);
  state.drafts = upsertRecord(state.drafts, enriched);
  await saveDrafts(state.drafts);
  render();
}

function upsertRecord(records, record) {
  const key = recordKey(record);
  return [...records.filter((item) => recordKey(item) !== key), record];
}

function recordKey(record) {
  return [record.action, record.videoId, record.sourceId || record.sourceHash, record.seconds ?? "", record.rawHash || ""].join(":");
}

async function undoDraft() {
  if (!state.undoStack.length) return;
  state.drafts = state.undoStack.pop();
  await saveDrafts(state.drafts);
  render();
}

async function clearDrafts() {
  state.undoStack.push([...state.drafts]);
  state.drafts = [];
  await saveDrafts(state.drafts);
  render();
}

function buildPatch() {
  return { schemaVersion: 1, records: state.drafts };
}

function exportPatch() {
  const blob = new Blob([JSON.stringify(buildPatch(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "curation_patch.json";
  link.click();
  URL.revokeObjectURL(url);
}

async function importPatch(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const patch = JSON.parse(await file.text());
  state.undoStack.push([...state.drafts]);
  state.drafts = [...state.drafts, ...(patch.records || [])].reduce(upsertRecordReducer, []);
  await saveDrafts(state.drafts);
  render();
  event.target.value = "";
}

function upsertRecordReducer(records, record) {
  return upsertRecord(records, record);
}

function copyCodexText() {
  const text = [
    "请把以下 curation_patch.json 合并进 config/curation-overrides.json，并运行 npm run check：",
    "",
    "```json",
    JSON.stringify(buildPatch(), null, 2),
    "```",
  ].join("\n");
  return copyText(text);
}

function impactText() {
  const counts = countBy(state.drafts, (record) => record.action);
  return `drop ${counts.drop_entry || 0}, replace ${counts.replace_entry || 0}, keep ${counts.force_keep || 0}, source ${counts.reject_source || 0}, video ${counts.drop_video || 0}`;
}

async function openDb() {
  if (!("indexedDB" in window)) return null;
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function loadDrafts() {
  if (!state.db) return JSON.parse(localStorage.getItem(STORE_NAME) || "[]");
  return new Promise((resolve) => {
    const request = state.db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get("drafts");
    request.onsuccess = () => resolve(request.result?.records || []);
    request.onerror = () => resolve([]);
  });
}

async function saveDrafts(records) {
  localStorage.setItem(STORE_NAME, JSON.stringify(records));
  if (!state.db) return;
  await new Promise((resolve) => {
    const request = state.db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put({ id: "drafts", records });
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  return response.json();
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

function countBy(items, keyFn) {
  return (items || []).reduce((counts, item) => {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function normalizeSearch(text) {
  return String(text || "").normalize("NFKC").toLowerCase().trim();
}

function secondsToTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}
