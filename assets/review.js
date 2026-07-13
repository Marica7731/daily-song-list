const MANIFEST_PATH = "data/review/manifest.json";
const DEFAULT_QUEUE_PATHS = {
  current: "data/review/queue-current.json",
  history: "data/review/queue-history.json",
};
const DEFAULT_ENTRY_INDEX_PATH = "data/review/current-entry-index.json";
const DB_NAME = "daily-song-list-review";
const STORE_NAME = "patch-records";
const SOURCE_RENDER_LIMIT = 800;

const state = {
  manifest: null,
  queues: { current: [], history: null },
  queuePayloads: {},
  queueByReviewId: new Map(),
  entryIndex: [],
  selected: null,
  selectedSource: null,
  selectedSourcePath: "",
  targetRawHash: "",
  drafts: [],
  undoStack: [],
  batchUndoStack: [],
  db: null,
  globalMatches: [],
  globalMatchIndex: -1,
  sourceMatches: [],
  sourceMatchIndex: -1,
  selectedEntryHashes: new Set(),
  editingRawHash: "",
  autoAdvance: false,
  pendingQueueScroll: 0,
  pendingDetailScroll: 0,
  scrollSyncTimer: null,
  sourceFilters: {
    q: "",
    onlyMatches: false,
    accepted: false,
    rejected: false,
    niche: false,
    unknown: false,
    modified: false,
  },
};

const els = {
  layout: document.getElementById("layout"),
  summary: document.getElementById("summary"),
  queue: document.getElementById("queue"),
  detail: document.getElementById("detail"),
  scopeFilter: document.getElementById("scopeFilter"),
  riskFilter: document.getElementById("riskFilter"),
  classificationFilter: document.getElementById("classificationFilter"),
  nicheUnknownOnly: document.getElementById("nicheUnknownOnly"),
  onlyUnreviewed: document.getElementById("onlyUnreviewed"),
  searchBox: document.getElementById("searchBox"),
  prevMatch: document.getElementById("prevMatch"),
  nextMatch: document.getElementById("nextMatch"),
  exportPatch: document.getElementById("exportPatch"),
  copyPatch: document.getElementById("copyPatch"),
  copyCodex: document.getElementById("copyCodex"),
  clearDrafts: document.getElementById("clearDrafts"),
  importPatch: document.getElementById("importPatch"),
  showQueuePanel: document.getElementById("showQueuePanel"),
  showDetailPanel: document.getElementById("showDetailPanel"),
};

init().catch((error) => {
  els.detail.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
});

async function init() {
  state.db = await openDb();
  state.drafts = await loadDrafts();
  state.manifest = await fetchJson(MANIFEST_PATH).catch(() => null);
  await loadScope("current");
  await loadEntryIndex();
  restoreUrlState();
  await loadScope(els.scopeFilter.value);
  bindEvents();
  await ensureSelectedFromUrl();
  renderSummary();
  renderQueue();
  if (!state.selected) renderDetail();
}

async function loadScope(scope) {
  if (state.queuePayloads[scope]) return;
  const path = queuePathForScope(scope);
  const payload = await fetchJson(path);
  state.queuePayloads[scope] = payload;
  state.queues[scope] = payload.items || [];
  rebuildQueueMap();
}

async function loadEntryIndex() {
  const path = state.manifest?.currentEntryIndexPath || DEFAULT_ENTRY_INDEX_PATH;
  const payload = await fetchJson(path);
  state.entryIndex = payload.items || [];
}

function queuePathForScope(scope) {
  if (scope === "history") return state.manifest?.historyQueuePath || DEFAULT_QUEUE_PATHS.history;
  return state.manifest?.currentQueuePath || state.manifest?.queuePath || DEFAULT_QUEUE_PATHS.current;
}

function rebuildQueueMap() {
  state.queueByReviewId = new Map();
  for (const item of [...(state.queues.current || []), ...(state.queues.history || [])]) {
    if (!state.queueByReviewId.has(item.reviewId)) state.queueByReviewId.set(item.reviewId, item);
  }
}

function bindEvents() {
  for (const el of [els.riskFilter, els.classificationFilter, els.nicheUnknownOnly, els.onlyUnreviewed]) {
    el.addEventListener("input", () => {
      state.globalMatchIndex = -1;
      renderSummary();
      renderQueue();
      syncUrl();
    });
  }
  els.scopeFilter.addEventListener("input", async () => {
    await loadScope(els.scopeFilter.value);
    state.globalMatchIndex = -1;
    state.selected = null;
    state.selectedSource = null;
    state.selectedSourcePath = "";
    state.targetRawHash = "";
    renderSummary();
    renderQueue();
    renderDetail();
    syncUrl();
  });
  els.searchBox.addEventListener("input", () => {
    state.globalMatchIndex = -1;
    renderSummary();
    renderQueue();
    syncUrl();
  });
  els.searchBox.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      jumpGlobalMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      clearGlobalSearch();
    }
  });
  els.prevMatch.addEventListener("click", () => jumpGlobalMatch(-1));
  els.nextMatch.addEventListener("click", () => jumpGlobalMatch(1));
  els.queue.addEventListener("click", handleQueueClick);
  els.detail.addEventListener("click", handleDetailClick);
  els.detail.addEventListener("input", handleDetailInput);
  els.exportPatch.addEventListener("click", exportPatch);
  els.copyPatch.addEventListener("click", () => copyText(JSON.stringify(buildPatch(), null, 2)));
  els.copyCodex.addEventListener("click", copyCodexText);
  els.clearDrafts.addEventListener("click", clearDrafts);
  els.importPatch.addEventListener("change", importPatch);
  els.showQueuePanel?.addEventListener("click", () => setMobilePanel("queue"));
  els.showDetailPanel?.addEventListener("click", () => setMobilePanel("detail"));
  els.queue.addEventListener("scroll", scheduleScrollUrlSync, { passive: true });
  els.detail.addEventListener("scroll", scheduleScrollUrlSync, { passive: true });
  window.addEventListener("keydown", handleGlobalKeys, { capture: true });
  window.addEventListener("popstate", async () => {
    restoreUrlState();
    await ensureSelectedFromUrl();
    renderSummary();
    renderQueue();
    if (!state.selected) renderDetail();
  });
}

async function ensureSelectedFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const reviewId = params.get("review") || "";
  const rawHash = params.get("entry") || "";
  if (!reviewId) return;
  await loadScope(els.scopeFilter.value);
  await selectReview(reviewId, rawHash, { syncUrl: false, focusDetail: false });
}

function restoreUrlState() {
  const params = new URLSearchParams(window.location.search);
  const scope = params.get("scope");
  if (scope === "history" || scope === "current") els.scopeFilter.value = scope;
  els.searchBox.value = params.get("q") || "";
  els.riskFilter.value = params.get("risk") || "";
  els.classificationFilter.value = params.get("classification") || "";
  els.nicheUnknownOnly.checked = params.get("onlyNicheUnknown") === "1";
  els.onlyUnreviewed.checked = params.get("onlyUnreviewed") === "1";
  state.targetRawHash = params.get("entry") || "";
  state.sourceFilters.q = params.get("sourceQ") || "";
  state.sourceFilters.onlyMatches = params.get("onlyMatches") === "1";
  state.sourceFilters.accepted = params.get("filterAccepted") === "1";
  state.sourceFilters.rejected = params.get("filterRejected") === "1";
  state.sourceFilters.niche = params.get("filterNiche") === "1";
  state.sourceFilters.unknown = params.get("filterUnknown") === "1";
  state.sourceFilters.modified = params.get("filterModified") === "1";
  state.pendingQueueScroll = readScrollParam(params.get("queueScroll"));
  state.pendingDetailScroll = readScrollParam(params.get("detailScroll"));
}

function syncUrl(mode = "replace") {
  const params = new URLSearchParams();
  if (els.scopeFilter.value !== "current") params.set("scope", els.scopeFilter.value);
  if (els.searchBox.value.trim()) params.set("q", els.searchBox.value.trim());
  if (els.riskFilter.value) params.set("risk", els.riskFilter.value);
  if (els.classificationFilter.value) params.set("classification", els.classificationFilter.value);
  if (state.selected?.reviewId) params.set("review", state.selected.reviewId);
  if (state.targetRawHash) params.set("entry", state.targetRawHash);
  if (state.sourceFilters.q.trim()) params.set("sourceQ", state.sourceFilters.q.trim());
  if (state.sourceFilters.onlyMatches) params.set("onlyMatches", "1");
  if (state.sourceFilters.accepted) params.set("filterAccepted", "1");
  if (state.sourceFilters.rejected) params.set("filterRejected", "1");
  if (state.sourceFilters.niche) params.set("filterNiche", "1");
  if (state.sourceFilters.unknown) params.set("filterUnknown", "1");
  if (state.sourceFilters.modified) params.set("filterModified", "1");
  if (els.queue.scrollTop > 0) params.set("queueScroll", String(Math.round(els.queue.scrollTop)));
  if (els.detail.scrollTop > 0) params.set("detailScroll", String(Math.round(els.detail.scrollTop)));
  if (els.nicheUnknownOnly.checked) params.set("onlyNicheUnknown", "1");
  if (els.onlyUnreviewed.checked) params.set("onlyUnreviewed", "1");
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
  window.history[mode === "push" ? "pushState" : "replaceState"]({}, "", url);
}

function readScrollParam(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function scheduleScrollUrlSync() {
  if (state.scrollSyncTimer) window.clearTimeout(state.scrollSyncTimer);
  state.scrollSyncTimer = window.setTimeout(() => {
    state.scrollSyncTimer = null;
    syncUrl();
  }, 150);
}

function handleGlobalKeys(event) {
  const tagName = event.target?.tagName;
  const inField = tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    focusGlobalSearch();
    return;
  }
  if (!inField && event.key === "/") {
    event.preventDefault();
    focusGlobalSearch();
    return;
  }
  if (event.key === "Escape") {
    if (document.activeElement === els.searchBox && els.searchBox.value) {
      event.preventDefault();
      clearGlobalSearch();
    } else if (state.targetRawHash) {
      event.preventDefault();
      state.targetRawHash = "";
      state.sourceFilters.onlyMatches = false;
      renderDetail({ preserveScroll: true });
      syncUrl();
    }
  }
}

function focusGlobalSearch() {
  els.searchBox.focus();
  els.searchBox.select();
}

function clearGlobalSearch() {
  els.searchBox.value = "";
  state.globalMatchIndex = -1;
  state.globalMatches = [];
  renderSummary();
  renderQueue();
  syncUrl();
}

function renderSummary() {
  const queue = activeQueue();
  const matches = buildGlobalMatches();
  const counts = countBy(state.drafts, (record) => record.action);
  const processed = countProcessedRecords();
  const currentEntryCount = state.manifest?.currentEntryCount ?? state.entryIndex.length;
  const currentSourceCount = state.manifest?.currentSourceCount ?? state.queues.current?.length ?? 0;
  const historySourceCount = state.manifest?.historySourceCount ?? state.queues.history?.length ?? 0;
  const matchText = els.searchBox.value.trim() ? ` / 匹配 ${matches.length}` : "";
  els.summary.textContent = [
    `当前来源 ${currentSourceCount}`,
    `当前条目 ${currentEntryCount}`,
    `历史来源 ${historySourceCount}`,
    `本页队列 ${queue.length}${matchText}`,
    `已处理 ${processed}`,
    `未处理 ${Math.max(0, currentEntryCount - processed)}`,
    `删除 ${counts.drop_entry || 0}`,
    `替换 ${counts.replace_entry || 0}`,
    `保留 ${counts.force_keep || 0}`,
    `来源拒绝 ${counts.reject_source || 0}`,
    `重新抓取 ${counts.force_refresh || 0}`,
  ].join(" / ");
}

function renderQueue() {
  const term = normalizedGlobalTerm();
  if (term) {
    renderEntryMatches();
    return;
  }
  const items = filteredQueue();
  if (!items.length) {
    els.queue.innerHTML = `<div class="empty">没有匹配来源</div>`;
    restorePendingQueueScroll();
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
            <span class="badge">候选 ${item.acceptedCount || item.parsedEntryCount || 0}</span>
            <span class="badge">未知 ${item.unknownArtistCount || 0}</span>
            <span class="badge">小众 ${item.nicheCount || 0}</span>
            <span class="badge">活动 ${item.activityMarkerCount || 0}</span>
            ${draftBadgeForSource(item)}
          </div>
          ${renderEntryPreview(item.entryPreview)}
        </button>
      `,
    )
    .join("");
  restorePendingQueueScroll();
}

function renderEntryMatches() {
  const matches = buildGlobalMatches();
  state.globalMatches = matches;
  if (!matches.length) {
    els.queue.innerHTML = `<div class="empty">没有匹配条目</div>`;
    restorePendingQueueScroll();
    return;
  }
  els.queue.innerHTML = `
    <div class="empty" style="padding: 10px 12px;">匹配 ${matches.length} 条</div>
    ${matches
      .map(
        (entry, index) => `
          <button class="queue-item is-match" data-match-index="${index}" data-review-id="${escapeAttr(entry.reviewId)}" data-raw-hash="${escapeAttr(entry.rawHash)}" aria-selected="${
            state.selected?.reviewId === entry.reviewId && state.targetRawHash === entry.rawHash
          }">
            <div class="queue-title">${escapeHtml(entry.time || secondsToTime(entry.seconds))} · ${escapeHtml(entry.title || "")}</div>
            <div class="meta">${escapeHtml(entry.artist || "待补歌手")}</div>
            <div class="meta">${escapeHtml(entry.videoTitle || entry.videoId)} · ${escapeHtml(entry.channelName || "")}</div>
            <div class="toolbar">
              <span class="badge">${escapeHtml(entry.classification || "needs_review")}</span>
              <span class="badge">${escapeHtml(entry.status || "")}</span>
              ${entry.isNiche ? `<span class="badge">小众</span>` : ""}
              ${isUnknownArtist(entry.artist) ? `<span class="badge">待补歌手</span>` : ""}
              ${draftBadgeForEntry(entry)}
            </div>
          </button>
        `,
      )
      .join("")}
  `;
  restorePendingQueueScroll();
}

function renderEntryPreview(entries) {
  if (!entries?.length) return "";
  return `
    <div class="meta" style="margin-top: 8px;">
      ${entries
        .map(
          (entry) =>
            `<div>${escapeHtml(entry.time || "")} ${escapeHtml(entry.title || "")}${entry.artist ? ` / ${escapeHtml(entry.artist)}` : ""} · ${escapeHtml(
              entry.classification || "",
            )}</div>`,
        )
        .join("")}
    </div>
  `;
}

function activeQueue() {
  return state.queues[els.scopeFilter.value] || [];
}

function filteredQueue() {
  const risk = els.riskFilter.value;
  const classification = els.classificationFilter.value;
  return activeQueue().filter((item) => {
    if (risk && item.riskLevel !== risk) return false;
    if (els.nicheUnknownOnly.checked && !(item.nicheCount > 0 && item.unknownArtistCount > 0)) return false;
    if (classification && !sourceHasClassification(item, classification)) return false;
    if (els.onlyUnreviewed.checked && isSourceProcessed(item)) return false;
    return true;
  });
}

function buildGlobalMatches() {
  const term = normalizedGlobalTerm();
  if (!term) return [];
  const risk = els.riskFilter.value;
  const classification = els.classificationFilter.value;
  const queueLookup = state.queueByReviewId;
  const scope = els.scopeFilter.value;
  const candidates =
    scope === "current"
      ? state.entryIndex
      : activeQueue().flatMap((item) =>
          (item.entryPreview || []).map((entry) => ({
            ...entry,
            reviewId: item.reviewId,
            sourcePath: item.sourcePath,
            videoId: item.videoId,
            videoTitle: item.videoTitle,
            channelName: item.channelName,
            sourceId: item.sourceId,
            sourceHash: item.sourceHash,
          })),
        );
  return candidates.filter((entry) => {
    const source = queueLookup.get(entry.reviewId);
    if (source?.scope && source.scope !== scope) return false;
    if (risk && source?.riskLevel !== risk) return false;
    if (classification && entry.classification !== classification) return false;
    if (els.nicheUnknownOnly.checked && !(entry.isNiche && isUnknownArtist(entry.artist))) return false;
    if (els.onlyUnreviewed.checked && isEntryProcessed(entry)) return false;
    return entrySearchText(entry).includes(term);
  });
}

function sourceHasClassification(item, classification) {
  return (item.entryPreview || []).some((entry) => entry.classification === classification);
}

function normalizedGlobalTerm() {
  return normalizeSearch(els.searchBox.value);
}

function entrySearchText(entry) {
  return normalizeSearch(
    [
      entry.title,
      entry.artist,
      entry.raw,
      entry.time,
      entry.videoTitle,
      entry.channelName,
      entry.videoId,
      entry.sourceId,
      entry.sourceHash,
      entry.classification,
      ...(entry.riskReasons || []),
    ].join(" "),
  );
}

async function handleQueueClick(event) {
  const button = event.target.closest("[data-review-id]");
  if (!button) return;
  const rawHash = button.dataset.rawHash || "";
  if (button.dataset.matchIndex) state.globalMatchIndex = Number(button.dataset.matchIndex);
  await selectReview(button.dataset.reviewId, rawHash, { syncUrl: true, pushUrl: true });
}

async function jumpGlobalMatch(direction) {
  const matches = buildGlobalMatches();
  state.globalMatches = matches;
  if (!matches.length) {
    renderQueue();
    return;
  }
  state.globalMatchIndex = wrapIndex(state.globalMatchIndex + direction, matches.length);
  const entry = matches[state.globalMatchIndex];
  await selectReview(entry.reviewId, entry.rawHash, { syncUrl: true, pushUrl: true });
  renderQueue();
}

async function selectReview(reviewId, rawHash = "", options = {}) {
  const item = state.queueByReviewId.get(reviewId);
  if (!item) return;
  state.selected = item;
  state.targetRawHash = rawHash || state.targetRawHash || "";
  state.selectedEntryHashes.clear();
  state.editingRawHash = "";
  if (state.selectedSourcePath !== item.sourcePath) {
    state.selectedSourcePath = item.sourcePath;
    state.selectedSource = await fetchJson(item.sourcePath);
  }
  if (rawHash && els.searchBox.value.trim()) {
    state.sourceFilters.q = els.searchBox.value.trim();
    state.sourceFilters.onlyMatches = true;
  }
  setMobilePanel("detail");
  const hadPendingQueueScroll = Boolean(state.pendingQueueScroll);
  renderQueue();
  if (!hadPendingQueueScroll) scrollSelectedQueueIntoView();
  renderDetail({ focusTarget: Boolean(rawHash) || options.focusDetail !== false });
  if (options.syncUrl !== false) syncUrl(options.pushUrl ? "push" : "replace");
}

function renderDetail(options = {}) {
  if (!state.selected) {
    els.detail.innerHTML = `<div class="empty">选择一个来源</div>`;
    return;
  }
  if (!state.selectedSource) {
    els.detail.innerHTML = `<div class="empty">加载来源 ${escapeHtml(state.selected.sourceId)}</div>`;
    return;
  }
  const scrollTop = options.preserveScroll ? els.detail.scrollTop : 0;
  const source = state.selectedSource;
  const entries = source.entries || [];
  const filtered = filteredSourceEntries(entries);
  const accepted = entries.filter((entry) => entry.status === "accepted").length;
  const rejected = entries.filter((entry) => entry.status === "rejected").length;
  const renderedEntries = visibleSourceEntries(filtered);
  els.detail.innerHTML = `
    <section class="detail-sticky">
      <div class="toolbar">
        <span class="badge ${escapeAttr(state.selected.riskLevel)}">${escapeHtml(state.selected.riskLevel)} ${state.selected.riskScore}</span>
        <span class="badge">接受 ${accepted}</span>
        <span class="badge">拒绝 ${rejected}</span>
        <span class="badge">显示 ${renderedEntries.length} / ${filtered.length} / 总计 ${entries.length}</span>
        <span class="badge">修改影响 ${impactText()}</span>
      </div>
      <h3>${escapeHtml(state.selected.videoTitle || state.selected.videoId)}</h3>
      <div class="meta">${escapeHtml(state.selected.channelName)} · ${escapeHtml(state.selected.sourceType)} · ${escapeHtml(state.selected.sourceId)}</div>
      <div class="toolbar" style="margin-top: 8px;">
        <a href="${escapeAttr(state.selected.youtubeUrl)}" target="_blank" rel="noreferrer"><button>打开 YouTube</button></a>
        <button data-action="reject-source" class="danger">拒绝此来源</button>
        <button data-action="force-refresh">重新抓取此视频</button>
        <button data-action="drop-video" class="danger">移除整个视频</button>
        <button data-action="copy-source-text">复制原评论</button>
        <button data-action="copy-source-json">复制来源 JSON</button>
        <button data-action="prev-unreviewed">上一个未处理</button>
        <button data-action="next-unreviewed">下一条未处理</button>
        <label class="badge"><input id="autoAdvance" type="checkbox" ${state.autoAdvance ? "checked" : ""}> 自动下一条</label>
      </div>
    </section>
    <section class="entry-filter-bar">
      <div class="toolbar">
        <input id="sourceSearchBox" type="search" placeholder="来源内搜索" value="${escapeAttr(state.sourceFilters.q)}" autocomplete="off">
        <span id="sourceMatchCount" class="badge">匹配 ${state.sourceMatches.length} / ${entries.length}</span>
        <button data-action="prev-source-match">上一条</button>
        <button data-action="next-source-match">下一条</button>
        ${filterToggle("onlySourceMatches", "只看匹配", state.sourceFilters.onlyMatches)}
        ${filterToggle("filterAccepted", "accepted", state.sourceFilters.accepted)}
        ${filterToggle("filterRejected", "rejected", state.sourceFilters.rejected)}
        ${filterToggle("filterNiche", "小众", state.sourceFilters.niche)}
        ${filterToggle("filterUnknown", "无歌手", state.sourceFilters.unknown)}
        ${filterToggle("filterModified", "有修改", state.sourceFilters.modified)}
      </div>
      <div class="toolbar" style="margin-top: 8px;">
        <span class="badge">已选 <span id="selectedEntryCount">${state.selectedEntryHashes.size}</span></span>
        <button data-action="select-visible">选择当前显示</button>
        <button data-action="select-matches">选择当前匹配</button>
        <button data-action="clear-selection">清除选择</button>
        <button data-action="batch-drop" class="danger">批量删除</button>
        <button data-action="batch-keep">批量保留</button>
        <button data-action="batch-suggestions">应用高置信建议</button>
        <button data-action="undo-batch">撤销批量</button>
      </div>
    </section>
    <details class="source-details">
      <summary>显示原评论</summary>
      <div class="source-text">${source.source?.sourceTextAvailable ? escapeHtml(source.source.sourceText) : "旧数据缺少完整原文，建议重新抓取。"}</div>
    </details>
    <section class="entry-table">
      <table>
        <thead><tr><th><input id="toggleVisibleEntries" type="checkbox" aria-label="选择当前显示"></th><th>时间</th><th>标题</th><th>歌手</th><th>状态</th><th>风险</th><th>操作</th></tr></thead>
        <tbody>${renderedEntries.map(renderEntryRow).join("")}</tbody>
      </table>
    </section>
    ${filtered.length > renderedEntries.length ? `<div class="empty">当前显示 ${renderedEntries.length} / ${filtered.length}，请用来源内搜索继续缩小范围。</div>` : ""}
  `;
  updateSourceMatches(entries);
  updateDraftDecorations();
  if (options.preserveScroll) els.detail.scrollTop = scrollTop;
  else if (!(options.focusTarget && state.targetRawHash)) restorePendingDetailScroll();
  if (options.focusTarget && state.targetRawHash) scrollTargetIntoView();
}

function filterToggle(id, label, checked) {
  return `<label class="badge"><input id="${id}" type="checkbox" ${checked ? "checked" : ""}> ${escapeHtml(label)}</label>`;
}

function renderEntryRow(entry) {
  const isTarget = state.targetRawHash && entry.rawHash === state.targetRawHash;
  const isSelected = state.selectedEntryHashes.has(entry.rawHash);
  const draft = draftForEntry(entry);
  if (state.editingRawHash === entry.rawHash) {
    return `
      <tr data-raw-hash="${escapeAttr(entry.rawHash || "")}" class="${isTarget ? "is-target" : ""} ${draft ? "is-drafted" : ""}">
        <td><input class="entry-select" type="checkbox" ${isSelected ? "checked" : ""}></td>
        <td>${escapeHtml(entry.time || secondsToTime(entry.seconds))}</td>
        <td colspan="5">
          <div class="edit-grid">
            <input data-edit-field="title" type="text" value="${escapeAttr(entry.title || "")}" aria-label="title">
            <input data-edit-field="artist" type="text" value="${escapeAttr(entry.artist || "")}" aria-label="artist">
            <input data-edit-field="seconds" type="number" min="0" step="1" value="${escapeAttr(entry.seconds ?? "")}" aria-label="seconds">
          </div>
          <div class="meta" style="margin-top: 6px;">修改前：${escapeHtml(entry.time || secondsToTime(entry.seconds))} ${escapeHtml(entry.title || "")}${
            entry.artist ? ` / ${escapeHtml(entry.artist)}` : ""
          }</div>
          <div class="toolbar" style="margin-top: 8px;">
            <button data-row-action="save-edit">保存</button>
            <button data-row-action="cancel-edit">取消</button>
          </div>
        </td>
      </tr>
    `;
  }
  return `
    <tr data-raw-hash="${escapeAttr(entry.rawHash || "")}" class="${isTarget ? "is-target" : ""} ${draft ? "is-drafted" : ""}">
      <td><input class="entry-select" type="checkbox" ${isSelected ? "checked" : ""}></td>
      <td>${escapeHtml(entry.time || secondsToTime(entry.seconds))}</td>
      <td>${escapeHtml(entry.title || "")}<div class="meta">${escapeHtml(entry.raw || "")}</div></td>
      <td>${escapeHtml(entry.artist || "")}</td>
      <td>${escapeHtml(entry.status || "")}<div class="meta" data-draft-status>${draftStatusText(draft)}</div></td>
      <td>
        <div>${escapeHtml(entry.classification || "")} · ${escapeHtml(entry.suggestedAction || "")}</div>
        ${(entry.riskReasons || []).map((reason) => `<span class="badge">${escapeHtml(reason)}</span>`).join(" ")}
      </td>
      <td class="actions"><div class="row-actions">
        <button data-row-action="keep">保留</button>
        <button data-row-action="drop" class="danger">删除</button>
        <button data-row-action="edit">编辑</button>
        <details class="row-more">
          <summary>更多</summary>
          <div class="row-more-menu">
            <button data-row-action="copy">复制原始行</button>
            <button data-row-action="copy-json">复制条目 JSON</button>
            <button data-row-action="open-time">打开时间戳</button>
          </div>
        </details>
      </div></td>
    </tr>
  `;
}

function filteredSourceEntries(entries) {
  updateSourceMatches(entries);
  return entries.filter((entry) => {
    const match = !state.sourceFilters.q || sourceEntrySearchText(entry).includes(normalizeSearch(state.sourceFilters.q));
    if (state.sourceFilters.onlyMatches && !match) return false;
    if (state.sourceFilters.accepted && entry.status !== "accepted") return false;
    if (state.sourceFilters.rejected && entry.status !== "rejected") return false;
    if (state.sourceFilters.niche && entry.isNiche !== true) return false;
    if (state.sourceFilters.unknown && !isUnknownArtist(entry.artist)) return false;
    if (state.sourceFilters.modified && !draftForEntry(entry)) return false;
    return true;
  });
}

function visibleSourceEntries(entries) {
  if (entries.length <= SOURCE_RENDER_LIMIT) return entries;
  if (!state.targetRawHash) return entries.slice(0, SOURCE_RENDER_LIMIT);
  const targetIndex = entries.findIndex((entry) => entry.rawHash === state.targetRawHash);
  if (targetIndex < 0 || targetIndex < SOURCE_RENDER_LIMIT) return entries.slice(0, SOURCE_RENDER_LIMIT);
  const before = Math.max(0, targetIndex - 20);
  const windowed = entries.slice(before, before + SOURCE_RENDER_LIMIT);
  if (!windowed.some((entry) => entry.rawHash === state.targetRawHash)) windowed.push(entries[targetIndex]);
  return windowed;
}

function updateSourceMatches(entries = state.selectedSource?.entries || []) {
  const term = normalizeSearch(state.sourceFilters.q);
  state.sourceMatches = term ? entries.filter((entry) => sourceEntrySearchText(entry).includes(term)) : [];
  if (state.sourceMatchIndex >= state.sourceMatches.length) state.sourceMatchIndex = state.sourceMatches.length - 1;
}

function sourceEntrySearchText(entry) {
  return normalizeSearch([entry.title, entry.artist, entry.raw, entry.time, entry.classification, entry.suggestedAction, ...(entry.riskReasons || [])].join(" "));
}

function handleDetailInput(event) {
  const id = event.target.id;
  if (id === "sourceSearchBox") {
    state.sourceFilters.q = event.target.value;
    state.sourceMatchIndex = -1;
    renderDetail({ preserveScroll: true });
    syncUrl();
  } else if (id === "onlySourceMatches") {
    state.sourceFilters.onlyMatches = event.target.checked;
    renderDetail({ preserveScroll: true });
    syncUrl();
  } else if (id === "filterAccepted") {
    state.sourceFilters.accepted = event.target.checked;
    renderDetail({ preserveScroll: true });
    syncUrl();
  } else if (id === "filterRejected") {
    state.sourceFilters.rejected = event.target.checked;
    renderDetail({ preserveScroll: true });
    syncUrl();
  } else if (id === "filterNiche") {
    state.sourceFilters.niche = event.target.checked;
    renderDetail({ preserveScroll: true });
    syncUrl();
  } else if (id === "filterUnknown") {
    state.sourceFilters.unknown = event.target.checked;
    renderDetail({ preserveScroll: true });
    syncUrl();
  } else if (id === "filterModified") {
    state.sourceFilters.modified = event.target.checked;
    renderDetail({ preserveScroll: true });
    syncUrl();
  } else if (id === "autoAdvance") {
    state.autoAdvance = event.target.checked;
  } else if (event.target.classList.contains("entry-select")) {
    const rawHash = event.target.closest("tr")?.dataset.rawHash;
    if (rawHash) {
      if (event.target.checked) state.selectedEntryHashes.add(rawHash);
      else state.selectedEntryHashes.delete(rawHash);
      updateSelectedCount();
    }
  } else if (id === "toggleVisibleEntries") {
    selectEntries(visibleRenderedEntries(), event.target.checked);
  }
}

async function handleDetailClick(event) {
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    await handleSourceAction(actionButton.dataset.action);
    return;
  }
  const rowButton = event.target.closest("[data-row-action]");
  if (!rowButton) return;
  const rawHash = rowButton.closest("tr")?.dataset.rawHash;
  await handleRowAction(rowButton.dataset.rowAction, rawHash, rowButton.closest("tr"));
}

async function handleSourceAction(action) {
  const item = state.selected;
  const source = state.selectedSource?.source || {};
  if (!item) return;
  if (action === "copy-source-text") return copyText(source.sourceText || "");
  if (action === "copy-source-json") return copyText(JSON.stringify(state.selectedSource, null, 2));
  if (action === "reject-source") return addDraft({ action: "reject_source", videoId: item.videoId, sourceId: item.sourceId, sourceHash: item.sourceHash, reason: "review_reject_source" });
  if (action === "force-refresh") return addDraft({ action: "force_refresh", videoId: item.videoId, sourceId: item.sourceId, sourceHash: item.sourceHash, reason: "review_force_refresh" });
  if (action === "drop-video") return addDraft({ action: "drop_video", videoId: item.videoId, reason: "review_drop_video" });
  if (action === "prev-source-match") return jumpSourceMatch(-1);
  if (action === "next-source-match") return jumpSourceMatch(1);
  if (action === "select-visible") return selectEntries(visibleRenderedEntries(), true);
  if (action === "select-matches") return selectEntries(state.sourceMatches, true);
  if (action === "clear-selection") return selectEntries([], false, { clear: true });
  if (action === "batch-drop") return applyBatch("drop");
  if (action === "batch-keep") return applyBatch("keep");
  if (action === "batch-suggestions") return applyBatch("suggestions");
  if (action === "undo-batch") return undoBatch();
  if (action === "prev-unreviewed") return jumpUnreviewed(-1);
  if (action === "next-unreviewed") return jumpUnreviewed(1);
}

async function handleRowAction(action, rawHash, row) {
  const entry = entryByRawHash(rawHash);
  if (!entry) return;
  if (action === "copy") return copyText(entry.raw || `${entry.time} ${entry.title}`);
  if (action === "copy-json") return copyText(JSON.stringify(entry, null, 2));
  if (action === "open-time") return window.open(youtubeTimeUrl(state.selected.videoId, entry.seconds), "_blank", "noopener,noreferrer");
  if (action === "keep") return addEntryDraft("force_keep", entry, { reason: "review_force_keep" });
  if (action === "drop") return addEntryDraft("drop_entry", entry, { reason: "review_drop_entry" });
  if (action === "edit") {
    state.editingRawHash = rawHash;
    replaceEntryRow(rawHash);
    return;
  }
  if (action === "cancel-edit") {
    state.editingRawHash = "";
    replaceEntryRow(rawHash);
    return;
  }
  if (action === "save-edit") {
    const title = row.querySelector('[data-edit-field="title"]')?.value ?? entry.title ?? "";
    const artist = row.querySelector('[data-edit-field="artist"]')?.value ?? entry.artist ?? "";
    const secondsValue = Number(row.querySelector('[data-edit-field="seconds"]')?.value ?? entry.seconds);
    if (!Number.isInteger(secondsValue) || secondsValue < 0) return;
    state.editingRawHash = "";
    await addEntryDraft("replace_entry", entry, {
      replacement: { title, artist, seconds: secondsValue },
      reason: "review_replace_entry",
    });
    replaceEntryRow(rawHash);
    return;
  }
}

function replaceEntryRow(rawHash) {
  const row = els.detail.querySelector(`tr[data-raw-hash="${cssEscape(rawHash)}"]`);
  const entry = entryByRawHash(rawHash);
  if (!row || !entry) {
    renderDetail({ preserveScroll: true });
    return;
  }
  const wrapper = document.createElement("tbody");
  wrapper.innerHTML = renderEntryRow(entry);
  const replacement = wrapper.firstElementChild;
  if (!replacement) return;
  row.replaceWith(replacement);
  updateDraftDecorations();
}

function entryByRawHash(rawHash) {
  return (state.selectedSource?.entries || []).find((entry) => entry.rawHash === rawHash);
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
  renderAfterDraft();
  if (state.autoAdvance && isEntryAction(record.action)) await jumpUnreviewed(1);
}

function renderAfterDraft() {
  renderSummary();
  updateDraftDecorations();
  updateQueueDraftDecorations();
  renderQueueSelectionAndDrafts();
}

function updateDraftDecorations() {
  for (const row of els.detail.querySelectorAll("tr[data-raw-hash]")) {
    const entry = entryByRawHash(row.dataset.rawHash);
    const draft = entry ? draftForEntry(entry) : null;
    row.classList.toggle("is-drafted", Boolean(draft));
    const status = row.querySelector("[data-draft-status]");
    if (status) status.textContent = draftStatusText(draft);
  }
  updateSelectedCount();
}

function renderQueueSelectionAndDrafts() {
  for (const button of els.queue.querySelectorAll("[data-review-id]")) {
    const reviewId = button.dataset.reviewId;
    button.setAttribute("aria-selected", String(state.selected?.reviewId === reviewId && (!button.dataset.rawHash || state.targetRawHash === button.dataset.rawHash)));
  }
}

function updateQueueDraftDecorations() {
  for (const button of els.queue.querySelectorAll("[data-review-id]")) {
    const reviewId = button.dataset.reviewId;
    const rawHash = button.dataset.rawHash || "";
    const item = state.queueByReviewId.get(reviewId);
    if (rawHash) {
      const entry = state.entryIndex.find((candidate) => candidate.reviewId === reviewId && candidate.rawHash === rawHash);
      updateInlineDraftBadge(button, "[data-entry-draft-badge]", entry ? draftForEntry(entry) : null);
      if (els.onlyUnreviewed.checked) button.hidden = Boolean(entry && isEntryProcessed(entry));
      continue;
    }
    updateInlineDraftBadge(button, "[data-source-draft-badge]", item ? draftForSource(item) : null);
    if (els.onlyUnreviewed.checked) button.hidden = Boolean(item && isSourceProcessed(item));
  }
}

function updateInlineDraftBadge(container, selector, draft) {
  let badge = container.querySelector(selector);
  if (!draft) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "badge";
    badge.dataset[selector.includes("entry") ? "entryDraftBadge" : "sourceDraftBadge"] = "";
    container.querySelector(".toolbar")?.append(badge);
  }
  badge.textContent = draftStatusText(draft);
}

function upsertRecord(records, record) {
  const key = recordConflictKey(record);
  return [...records.filter((item) => recordConflictKey(item) !== key), record];
}

function recordConflictKey(record) {
  if (record.action === "drop_video") return `video:${record.videoId}`;
  if (record.action === "force_refresh") return `refresh:${record.videoId}`;
  if (record.action === "reject_source") return `source:${record.videoId}:${record.sourceHash || record.sourceId || ""}`;
  if (record.rawHash || record.seconds != null) return `entry:${record.videoId}:${record.sourceHash || record.sourceId || ""}:${record.rawHash || ""}:${record.seconds ?? ""}`;
  return `${record.action}:${record.videoId}:${record.sourceHash || record.sourceId || ""}`;
}

function draftForEntry(entry) {
  const key = recordConflictKey({
    action: "drop_entry",
    videoId: state.selected?.videoId,
    sourceId: state.selected?.sourceId,
    sourceHash: state.selected?.sourceHash,
    rawHash: entry.rawHash,
    seconds: entry.seconds,
  });
  return state.drafts.find((record) => recordConflictKey(record) === key) || null;
}

function draftForSource(item) {
  return state.drafts.find((record) => {
    if (record.action === "drop_video" && record.videoId === item.videoId) return true;
    if (record.action === "force_refresh" && record.videoId === item.videoId) return true;
    if (record.action === "reject_source" && record.videoId === item.videoId && (record.sourceHash === item.sourceHash || record.sourceId === item.sourceId)) return true;
    return false;
  });
}

function draftBadgeForEntry(entry) {
  const draft = draftForEntry(entry);
  return draft ? `<span class="badge" data-entry-draft-badge>${escapeHtml(draftStatusText(draft))}</span>` : "";
}

function draftBadgeForSource(item) {
  const draft = draftForSource(item);
  return draft ? `<span class="badge" data-source-draft-badge>${escapeHtml(draftStatusText(draft))}</span>` : "";
}

function draftStatusText(draft) {
  if (!draft) return "";
  if (draft.action === "drop_entry") return "已删除";
  if (draft.action === "replace_entry") return "已修改";
  if (draft.action === "force_keep") return "已保留";
  if (draft.action === "reject_source") return "来源已拒绝";
  if (draft.action === "force_refresh") return "待重新抓取";
  if (draft.action === "drop_video") return "视频已移除";
  return draft.action;
}

function isEntryAction(action) {
  return action === "drop_entry" || action === "replace_entry" || action === "force_keep";
}

function isEntryProcessed(entry) {
  return Boolean(draftForEntry(entry));
}

function isSourceProcessed(item) {
  if (draftForSource(item)) return true;
  return (state.entryIndex || []).some((entry) => entry.reviewId === item.reviewId && isEntryProcessed(entry));
}

function countProcessedRecords() {
  return state.drafts.filter((record) => isEntryAction(record.action)).length;
}

async function jumpSourceMatch(direction) {
  updateSourceMatches();
  if (!state.sourceMatches.length) return;
  state.sourceMatchIndex = wrapIndex(state.sourceMatchIndex + direction, state.sourceMatches.length);
  const entry = state.sourceMatches[state.sourceMatchIndex];
  state.targetRawHash = entry.rawHash;
  renderDetail({ preserveScroll: true, focusTarget: true });
  syncUrl();
}

async function jumpUnreviewed(direction) {
  const entries = filteredSourceEntries(state.selectedSource?.entries || []);
  const unreviewed = entries.filter((entry) => !draftForEntry(entry));
  if (!unreviewed.length) return;
  const currentIndex = unreviewed.findIndex((entry) => entry.rawHash === state.targetRawHash);
  const next = unreviewed[wrapIndex(currentIndex + direction, unreviewed.length)];
  state.targetRawHash = next.rawHash;
  renderDetail({ preserveScroll: true, focusTarget: true });
  syncUrl();
}

function selectEntries(entries, checked, options = {}) {
  if (options.clear) state.selectedEntryHashes.clear();
  else {
    for (const entry of entries || []) {
      if (!entry.rawHash) continue;
      if (checked) state.selectedEntryHashes.add(entry.rawHash);
      else state.selectedEntryHashes.delete(entry.rawHash);
    }
  }
  for (const checkbox of els.detail.querySelectorAll(".entry-select")) {
    const rawHash = checkbox.closest("tr")?.dataset.rawHash;
    checkbox.checked = state.selectedEntryHashes.has(rawHash);
  }
  updateSelectedCount();
}

function visibleRenderedEntries() {
  return [...els.detail.querySelectorAll("tr[data-raw-hash]")]
    .map((row) => entryByRawHash(row.dataset.rawHash))
    .filter(Boolean);
}

async function applyBatch(mode) {
  const entries = [...state.selectedEntryHashes].map(entryByRawHash).filter(Boolean);
  if (!entries.length) return;
  state.batchUndoStack.push([...state.drafts]);
  state.undoStack.push([...state.drafts]);
  let records = [...state.drafts];
  for (const entry of entries) {
    const record = batchRecordFor(mode, entry);
    if (record) records = upsertRecord(records, record);
  }
  state.drafts = records;
  await saveDrafts(state.drafts);
  renderAfterDraft();
}

function batchRecordFor(mode, entry) {
  if (mode === "drop") return entryRecord("drop_entry", entry, { reason: "review_batch_drop_entry" });
  if (mode === "keep") return entryRecord("force_keep", entry, { reason: "review_batch_force_keep" });
  if (mode === "suggestions") {
    if (entry.classification === "confirmed_noise" && entry.suggestedAction === "drop_entry") {
      return entryRecord("drop_entry", entry, { reason: "review_batch_confirmed_noise" });
    }
    if (entry.classification === "parser_corruption" && entry.replacementSuggestion) {
      return entryRecord("replace_entry", entry, {
        replacement: entry.replacementSuggestion,
        reason: "review_batch_parser_corruption",
      });
    }
  }
  return null;
}

function entryRecord(action, entry, extra = {}) {
  return {
    reviewedAt: new Date().toISOString(),
    reviewedBy: "review.html",
    note: "",
    action,
    videoId: state.selected.videoId,
    sourceId: state.selected.sourceId,
    sourceHash: state.selected.sourceHash,
    seconds: Number(entry.seconds),
    rawHash: entry.rawHash,
    ...extra,
  };
}

async function undoBatch() {
  if (!state.batchUndoStack.length) return;
  state.drafts = state.batchUndoStack.pop();
  await saveDrafts(state.drafts);
  renderAfterDraft();
}

async function undoDraft() {
  if (!state.undoStack.length) return;
  state.drafts = state.undoStack.pop();
  await saveDrafts(state.drafts);
  renderAfterDraft();
}

async function clearDrafts() {
  state.undoStack.push([...state.drafts]);
  state.drafts = [];
  state.selectedEntryHashes.clear();
  await saveDrafts(state.drafts);
  renderSummary();
  renderQueue();
  renderDetail({ preserveScroll: true });
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
  renderSummary();
  renderQueue();
  renderDetail({ preserveScroll: true });
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
  return `drop ${counts.drop_entry || 0}, replace ${counts.replace_entry || 0}, keep ${counts.force_keep || 0}, reject ${counts.reject_source || 0}, refresh ${
    counts.force_refresh || 0
  }, video ${counts.drop_video || 0}`;
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

function updateSelectedCount() {
  const count = document.getElementById("selectedEntryCount");
  if (count) count.textContent = String(state.selectedEntryHashes.size);
}

function scrollTargetIntoView() {
  requestAnimationFrame(() => {
    const row = els.detail.querySelector(`tr[data-raw-hash="${cssEscape(state.targetRawHash)}"]`);
    if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

function scrollSelectedQueueIntoView() {
  if (!state.selected?.reviewId) return;
  const reviewSelector = `[data-review-id="${cssEscape(state.selected.reviewId)}"]`;
  const entrySelector = state.targetRawHash ? `${reviewSelector}[data-raw-hash="${cssEscape(state.targetRawHash)}"]` : "";
  requestAnimationFrame(() => {
    const item = (entrySelector && els.queue.querySelector(entrySelector)) || els.queue.querySelector(reviewSelector);
    item?.scrollIntoView({ block: "nearest" });
  });
}

function restorePendingQueueScroll() {
  if (!state.pendingQueueScroll) return;
  const top = state.pendingQueueScroll;
  state.pendingQueueScroll = 0;
  requestAnimationFrame(() => {
    els.queue.scrollTop = top;
  });
}

function restorePendingDetailScroll() {
  if (!state.pendingDetailScroll) return;
  const top = state.pendingDetailScroll;
  state.pendingDetailScroll = 0;
  requestAnimationFrame(() => {
    els.detail.scrollTop = top;
  });
}

function setMobilePanel(panel) {
  if (!els.layout) return;
  els.layout.dataset.mobilePanel = panel;
  els.showQueuePanel?.classList.toggle("primary", panel === "queue");
  els.showDetailPanel?.classList.toggle("primary", panel === "detail");
}

function youtubeTimeUrl(videoId, seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${value}s`;
}

function isUnknownArtist(artist) {
  const value = normalizeSearch(artist);
  return !value || value === "unknown" || value === "n/a" || value === "na" || value.includes("未記載") || value.includes("待补歌手") || value.includes("待補歌手");
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
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function wrapIndex(index, length) {
  if (!length) return -1;
  return ((index % length) + length) % length;
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}
