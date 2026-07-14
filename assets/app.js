const VIEWS = {
  songRank: "歌曲榜",
  artistRank: "歌手榜",
  songAz: "歌曲索引",
  videos: "视频",
};

const RANGE_LABELS = {
  "72h": "最近72小时",
  "1m": "月度",
};

const SNAPSHOT_LATEST_PATH = "data/latest.json";
const UI_META_PATH = "data/ui/meta.json";
const STATUS_PATH = "data/status.json";
const SONG_SEARCH_INDEX_PATH = "data/song-search-known-songs.json";
const SNAPSHOT_CACHE_LIMIT = 5;
const SEARCH_DEBOUNCE_MS = 140;
const INLINE_SOURCE_PREVIEW_LIMIT = 1;
const ARTIST_SONG_GROUP_INITIAL_LIMIT = 8;
const SOURCE_TIMESTAMP_INITIAL_LIMIT = 10;
// Keep these breakpoints synchronized with assets/styles.css:
// mobile <= 720px, tablet 721-919px, desktop >= 920px.
const RESPONSIVE_BREAKPOINTS = {
  mobileMax: 720,
  tabletMax: 919,
};
const SOURCE_GROUP_LIMITS = {
  mobile: { initial: 3, batch: 3 },
  tablet: { initial: 6, batch: 6 },
  desktop: { initial: 9, batch: 9 },
};
const LIST_PAGE_SIZE_OPTIONS = [50, 100];
const DEFAULT_LIST_PAGE_SIZE = 50;
const VIDEO_PAGE_SIZE = 24;
const CURRENT_FILTER_VERSION = 3;
const RECENT_SEARCHES_KEY = "dailySongList.recentSearches";
const RANK_METRICS = {
  occurrences: "收录次数",
  videos: "不同视频数",
};
const TREND_FILTERS = {
  all: "全部",
  new: "新上榜",
  up: "上升",
  down: "下降",
};
const MIN_COUNT_OPTIONS = [1, 2, 5, 10];
const VIDEO_LAYOUTS = {
  cards: "卡片",
  compact: "紧凑",
};
const PAGE_SIZES = {
  songRank: DEFAULT_LIST_PAGE_SIZE,
  artistRank: DEFAULT_LIST_PAGE_SIZE,
  songAz: DEFAULT_LIST_PAGE_SIZE,
  videos: VIDEO_PAGE_SIZE,
};
const INDEX_ALL_BUCKET = "全部";
const STATUS_STALE_MS = 90 * 60 * 1000;
const DEBUG_MODE = new URLSearchParams(window.location.search).get("debug") === "1";

const KANA_BUCKETS = [
  { label: "あ", pattern: /^[ぁ-お]/u },
  { label: "か", pattern: /^[か-ご]/u },
  { label: "さ", pattern: /^[さ-ぞ]/u },
  { label: "た", pattern: /^[た-ど]/u },
  { label: "な", pattern: /^[な-の]/u },
  { label: "は", pattern: /^[は-ぽ]/u },
  { label: "ま", pattern: /^[ま-も]/u },
  { label: "や", pattern: /^[ゃ-よ]/u },
  { label: "ら", pattern: /^[ら-ろ]/u },
  { label: "わ", pattern: /^[わ-ん]/u },
];

const KANA_DIGRAPHS = {
  きゃ: "kya",
  きゅ: "kyu",
  きょ: "kyo",
  ぎゃ: "gya",
  ぎゅ: "gyu",
  ぎょ: "gyo",
  しゃ: "sha",
  しゅ: "shu",
  しょ: "sho",
  しぇ: "she",
  じゃ: "ja",
  じゅ: "ju",
  じょ: "jo",
  じぇ: "je",
  ちゃ: "cha",
  ちゅ: "chu",
  ちょ: "cho",
  ちぇ: "che",
  にゃ: "nya",
  にゅ: "nyu",
  にょ: "nyo",
  ひゃ: "hya",
  ひゅ: "hyu",
  ひょ: "hyo",
  びゃ: "bya",
  びゅ: "byu",
  びょ: "byo",
  ぴゃ: "pya",
  ぴゅ: "pyu",
  ぴょ: "pyo",
  みゃ: "mya",
  みゅ: "myu",
  みょ: "myo",
  りゃ: "rya",
  りゅ: "ryu",
  りょ: "ryo",
  ゔぁ: "va",
  ゔぃ: "vi",
  ゔぇ: "ve",
  ゔぉ: "vo",
  ふぁ: "fa",
  ふぃ: "fi",
  ふぇ: "fe",
  ふぉ: "fo",
  てぃ: "ti",
  でぃ: "di",
  とぅ: "tu",
  どぅ: "du",
};

const KANA_ROMAJI = {
  あ: "a",
  い: "i",
  う: "u",
  え: "e",
  お: "o",
  ぁ: "a",
  ぃ: "i",
  ぅ: "u",
  ぇ: "e",
  ぉ: "o",
  か: "ka",
  き: "ki",
  く: "ku",
  け: "ke",
  こ: "ko",
  が: "ga",
  ぎ: "gi",
  ぐ: "gu",
  げ: "ge",
  ご: "go",
  さ: "sa",
  し: "shi",
  す: "su",
  せ: "se",
  そ: "so",
  ざ: "za",
  じ: "ji",
  ず: "zu",
  ぜ: "ze",
  ぞ: "zo",
  た: "ta",
  ち: "chi",
  つ: "tsu",
  て: "te",
  と: "to",
  だ: "da",
  ぢ: "ji",
  づ: "zu",
  で: "de",
  ど: "do",
  な: "na",
  に: "ni",
  ぬ: "nu",
  ね: "ne",
  の: "no",
  は: "ha",
  ひ: "hi",
  ふ: "fu",
  へ: "he",
  ほ: "ho",
  ば: "ba",
  び: "bi",
  ぶ: "bu",
  べ: "be",
  ぼ: "bo",
  ぱ: "pa",
  ぴ: "pi",
  ぷ: "pu",
  ぺ: "pe",
  ぽ: "po",
  ま: "ma",
  み: "mi",
  む: "mu",
  め: "me",
  も: "mo",
  や: "ya",
  ゆ: "yu",
  よ: "yo",
  ゃ: "ya",
  ゅ: "yu",
  ょ: "yo",
  ら: "ra",
  り: "ri",
  る: "ru",
  れ: "re",
  ろ: "ro",
  わ: "wa",
  を: "o",
  ん: "n",
  ゔ: "vu",
};

const sortCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
  ignorePunctuation: true,
});

const state = {
  payload: null,
  status: null,
  snapshots: [],
  currentSnapshotPath: SNAPSHOT_LATEST_PATH,
  range: "72h",
  view: "songRank",
  filter: "",
  nicheOnly: false,
  hideUnknownArtist: true,
  indexBucket: INDEX_ALL_BUCKET,
  pageSize: DEFAULT_LIST_PAGE_SIZE,
  rankMetric: "occurrences",
  trend: "all",
  minCount: 1,
  videoLayout: "cards",
  expandedRows: new Set(),
  filterTimer: null,
  page: 1,
  renderRevision: 0,
  snapshotLoader: null,
  snapshotApplyOptions: null,
  preparedPayloadCache: new Map(),
  runtimeMeta: null,
  runtimeRangePayloads: new Map(),
  runtimeRangeLoads: new Map(),
  runtimeWarnings: new Map(),
  rangeCache: new Map(),
  latestRangeLoadError: null,
  statusRefreshTimer: null,
  songSearchIndexPromise: null,
  songSearchLookup: window.FrontendUtils.createSongSearchLookup(null),
  rankDiffs: {},
  rankDiffLoads: new Map(),
  loadedResources: [],
  firstContentMeasured: false,
  eventsBound: false,
  activeOverlay: "",
  overlayTrigger: null,
  filterDraft: null,
  sharedUrlApplied: false,
  responsiveMode: "",
  resizeRenderFrame: 0,
};

const els = {
  controls: document.querySelector("#controls"),
  status: document.querySelector("#status"),
  statusAlerts: document.querySelector("#statusAlerts"),
  summary: document.querySelector("#summary"),
  content: document.querySelector("#videoList"),
  snapshotSelect: document.querySelector("#snapshotSelect"),
  snapshotDateSelect: document.querySelector("#snapshotDateSelect"),
  filterInput: document.querySelector("#filterInput"),
  nicheOnlyToggle: document.querySelector("#nicheOnlyToggle"),
  hideUnknownToggle: document.querySelector("#hideUnknownToggle"),
  openSearchButton: document.querySelector("#openSearchButton"),
  searchDialog: document.querySelector("#searchDialog"),
  searchPanel: document.querySelector("#searchDialog .search-panel"),
  searchPanelInput: document.querySelector("#searchPanelInput"),
  cancelSearchButton: document.querySelector("#cancelSearchButton"),
  clearSearchButton: document.querySelector("#clearSearchButton"),
  clearRecentSearchesButton: document.querySelector("#clearRecentSearchesButton"),
  recentSearches: document.querySelector("#recentSearches"),
  recentSearchSection: document.querySelector("#recentSearchSection"),
  searchSuggestions: document.querySelector("#searchSuggestions"),
  openFilterButton: document.querySelector("#openFilterButton"),
  desktopFilterButton: document.querySelector("#desktopFilterButton"),
  filterDialog: document.querySelector("#filterDialog"),
  filterSheet: document.querySelector("#filterDialog .filter-sheet"),
  filterCountBadge: document.querySelector("#filterCountBadge"),
  mobileFilterCountBadge: document.querySelector("#mobileFilterCountBadge"),
  cancelFilterButton: document.querySelector("#cancelFilterButton"),
  applyFiltersButton: document.querySelector("#applyFiltersButton"),
  resetFiltersButton: document.querySelector("#resetFiltersButton"),
  metricFilterGroup: document.querySelector("#metricFilterGroup"),
  trendFilterGroup: document.querySelector("#trendFilterGroup"),
  trendFilterSelect: document.querySelector("#trendFilterSelect"),
  trendFilterHint: document.querySelector("#trendFilterHint"),
  minCountSelect: document.querySelector("#minCountSelect"),
  filterPageSizeSelect: document.querySelector("#filterPageSizeSelect"),
  filterSnapshotDateSelect: document.querySelector("#filterSnapshotDateSelect"),
  filterSnapshotSelect: document.querySelector("#filterSnapshotSelect"),
  mobileBottomNav: document.querySelector("#mobileBottomNav"),
  backToTop: document.querySelector("#backToTop"),
  toast: document.querySelector("#toast"),
  debugPanel: null,
  rangeTabs: Array.from(document.querySelectorAll("[data-range]")),
  viewTabs: Array.from(document.querySelectorAll("[data-view]")),
  bottomViewTabs: Array.from(document.querySelectorAll("#mobileBottomNav [data-view]")),
};

window.printSongListPerformance = function printSongListPerformance() {
  const measures = performanceAvailable()
    ? performance.getEntriesByType("measure")
        .filter((entry) => entry.name.startsWith("song-list:"))
        .map((entry) => ({
          stage: entry.name.replace(/^song-list:/, ""),
          durationMs: Math.round(entry.duration * 10) / 10,
        }))
    : [];
  const resources = state.loadedResources.map((entry) => ({ ...entry }));
  const runtime = {
    dataVersion: state.runtimeMeta?.dataVersion || "",
    range: state.range,
    rangePath: state.runtimeMeta?.ranges?.[state.range]?.path || "",
    rangeDataVersion: state.runtimeRangePayloads.get(state.range)?.dataVersion || "",
    status: state.status || null,
    warning: state.runtimeWarnings.get(state.range) || null,
  };
  if (typeof console?.table === "function") {
    console.table(measures);
    console.table(resources);
  }
  return { measures, resources, runtime };
};

init().catch((error) => {
  setSnapshotBusy(false);
  renderLoadError(error);
});

function performanceAvailable() {
  return typeof performance !== "undefined" && typeof performance.mark === "function" && typeof performance.measure === "function";
}

function perfMark(name) {
  if (!performanceAvailable()) return "";
  const markName = `song-list:${name}:${performance.now()}`;
  performance.mark(markName);
  return markName;
}

function perfMeasure(name, startMark, endMark = "") {
  if (!performanceAvailable() || !startMark) return;
  const finalEndMark = endMark || `song-list:${name}:end:${performance.now()}`;
  if (!endMark) performance.mark(finalEndMark);
  try {
    performance.measure(`song-list:${name}`, startMark, finalEndMark);
  } catch {
    // Performance marks are diagnostic only.
  }
}

async function measureAsync(name, callback) {
  const start = perfMark(`${name}:start`);
  try {
    return await callback();
  } finally {
    perfMeasure(name, start);
  }
}

function measureSync(name, callback) {
  const start = perfMark(`${name}:start`);
  try {
    return callback();
  } finally {
    perfMeasure(name, start);
  }
}

async function init() {
  const initMark = perfMark("app-init:start");
  setupSnapshotLoader();
  setupControlsObserver();
  applyInitialUrlState();
  bindEvents();
  syncControlsFromState();
  setupBackToTopButton();
  setSnapshotBusy(true, "正在载入数据");
  renderInitialSkeleton();
  await yieldToBrowser();
  const initialRange = state.range;
  const metaPromise = measureAsync("fetch-meta", () => readJson(UI_META_PATH, { cache: "no-cache" }));
  const statusPromise = readJson(STATUS_PATH, { cache: "no-cache" }).catch(() => null);
  const snapshotIndexPromise = readJson("data/snapshots/index.json").catch(() => ({ snapshots: [] }));
  const meta = await metaPromise;
  state.runtimeMeta = meta;
  state.status = mergeRuntimeStatus(meta.status || null, await statusPromise, meta);
  startStatusTicker();
  const snapshotIndex = await snapshotIndexPromise;
  state.snapshots = Array.isArray(snapshotIndex.snapshots) ? snapshotIndex.snapshots : [];
  renderSnapshotOptions();
  applyInitialUrlState();
  syncControlsFromState();
  const requestedSnapshotPath = state.currentSnapshotPath;
  const rangePayload = await measureAsync("fetch-active-range", () => loadRuntimeRange(initialRange));
  if (state.range !== initialRange) {
    await loadRuntimeRange(state.range);
  }
  await applyRuntimeRangePayload(state.runtimeRangePayloads.get(state.range) || rangePayload, {
    resetPage: false,
    syncUrl: false,
  });
  if (requestedSnapshotPath !== SNAPSHOT_LATEST_PATH) {
    await loadSnapshotPath(requestedSnapshotPath, SNAPSHOT_LATEST_PATH);
  } else {
    scheduleCurrentRankDiffLoad();
    scheduleOtherRangePrefetch();
    cleanSharedUrlAfterRender();
  }
  perfMeasure("app-init", initMark);
}

function bindEvents() {
  if (state.eventsBound) return;
  state.eventsBound = true;
  for (const tab of els.rangeTabs) {
    tab.addEventListener("click", async () => {
      if (state.range === tab.dataset.range) return;
      await switchRange(tab.dataset.range, { urlMode: "push" });
    });
  }

  for (const tab of els.viewTabs) {
    tab.addEventListener("click", () => {
      switchView(tab.dataset.view, { urlMode: "push" });
    });
  }

  for (const tab of els.bottomViewTabs) {
    tab.addEventListener("click", () => {
      switchView(tab.dataset.view, { urlMode: "push" });
    });
  }

  els.filterInput.addEventListener("input", () => {
    const rawValue = els.filterInput.value;
    state.filter = rawValue.trim();
    state.expandedRows.clear();
    resetPagination();
    const renderRevision = advanceRenderRevision();
    window.clearTimeout(state.filterTimer);
    if (!state.filter) {
      renderOrSyncUrl({ urlMode: "replace" });
      return;
    }
    state.filterTimer = window.setTimeout(() => {
      if (renderRevision === state.renderRevision) renderOrSyncUrl({ urlMode: "replace" });
    }, SEARCH_DEBOUNCE_MS);
  });

  els.snapshotDateSelect?.addEventListener("change", async () => {
    const path = firstSnapshotPathForDate(els.snapshotDateSelect.value);
    resetPagination();
    await loadSnapshotPath(path, state.currentSnapshotPath, { urlMode: "push" });
  });

  els.snapshotSelect.addEventListener("change", async () => {
    const path = els.snapshotSelect.value;
    resetPagination();
    await loadSnapshotPath(path, state.currentSnapshotPath, { urlMode: "push" });
  });

  bindSearchOverlayEvents();
  bindFilterOverlayEvents();

  els.summary?.addEventListener("click", async (event) => {
    const rankMetric = event.target.closest("[data-rank-metric]");
    if (rankMetric) {
      state.rankMetric = rankMetric.dataset.rankMetric || "occurrences";
      state.expandedRows.clear();
      resetPagination();
      render({ urlMode: "push" });
      return;
    }

    const videoLayout = event.target.closest("[data-video-layout]");
    if (videoLayout) {
      state.videoLayout = videoLayout.dataset.videoLayout || "cards";
      state.expandedRows.clear();
      render({ urlMode: "push" });
    }
  });

  els.content.addEventListener("click", (event) => {
    const copySetlist = event.target.closest("[data-copy-setlist]");
    if (copySetlist) {
      event.preventDefault();
      event.stopPropagation();
      copyVideoSetlist(copySetlist._videoItem).catch((error) => showToast(`复制失败：${error.message}`));
      return;
    }

    const copySongLinks = event.target.closest("[data-copy-song-links]");
    if (copySongLinks) {
      event.preventDefault();
      event.stopPropagation();
      copySongSourceLinks(copySongLinks._sourceOccurrences).catch((error) => showToast(`复制失败：${error.message}`));
      return;
    }

    const clear = event.target.closest("[data-clear-search]");
    if (clear) {
      els.filterInput.value = "";
      state.filter = "";
      state.expandedRows.clear();
      resetPagination();
      advanceRenderRevision();
      render({ urlMode: "push" });
      els.filterInput.focus();
      return;
    }

    const pageButton = event.target.closest("[data-page]");
    if (pageButton) {
      const nextPage = Number.parseInt(pageButton.dataset.page || "1", 10);
      setPage(nextPage);
      render({ focusAfterPageChange: true, urlMode: "push" });
      return;
    }

    const pageSizeButton = event.target.closest("[data-page-size]");
    if (pageSizeButton) {
      const nextPageSize = Number.parseInt(pageSizeButton.dataset.pageSize || "", 10);
      if (LIST_PAGE_SIZE_OPTIONS.includes(nextPageSize) && state.pageSize !== nextPageSize) {
        state.pageSize = nextPageSize;
        state.expandedRows.clear();
        resetPagination();
        render({ focusAfterPageChange: true });
      }
      return;
    }

    const bucketButton = event.target.closest("[data-index-bucket]");
    if (bucketButton) {
      state.indexBucket = bucketButton.dataset.indexBucket || INDEX_ALL_BUCKET;
      state.expandedRows.clear();
      resetPagination();
      render({ focusAfterPageChange: true, urlMode: "push" });
      return;
    }

    const artistMore = event.target.closest("[data-toggle-artist-songs]");
    if (artistMore) {
      event.preventDefault();
      toggleArtistSongLimit(artistMore.closest(".rank-row"));
      return;
    }

    const videoToggle = event.target.closest("[data-toggle-video-songs]");
    if (videoToggle) {
      event.preventDefault();
      toggleVideoSongs(videoToggle.closest(".video-card"));
      return;
    }

    const sourceToggle = event.target.closest("[data-toggle-source]");
    if (sourceToggle) {
      event.preventDefault();
      toggleSourceDrawer(sourceToggle.closest(".rank-row, .index-row"));
    }
  });

  els.content.addEventListener("keydown", (event) => {
    const input = event.target.closest("[data-jump-page]");
    if (!input || event.key !== "Enter") return;
    event.preventDefault();
    const page = Number.parseInt(input.value || "1", 10);
    setPage(page);
    render({ focusAfterPageChange: true });
  });

  els.content.addEventListener("click", (event) => {
    const jump = event.target.closest("[data-jump-page-button]");
    if (jump) {
      event.preventDefault();
      const input = jump.closest(".page-jump")?.querySelector("[data-jump-page]");
      const page = Number.parseInt(input?.value || "1", 10);
      setPage(page);
      render({ focusAfterPageChange: true });
      return;
    }

    const sourceCollapse = event.target.closest("[data-collapse-source]");
    if (sourceCollapse) {
      event.preventDefault();
      collapseSourceDrawer(sourceCollapse.closest(".rank-row, .index-row"), { keepVisible: true });
      return;
    }

    const sourceTimes = event.target.closest("[data-toggle-source-times]");
    if (sourceTimes) {
      event.preventDefault();
      expandSourceGroupTimestamps(sourceTimes);
      return;
    }

    const sourceGroups = event.target.closest("[data-toggle-source-groups]");
    if (sourceGroups) {
      event.preventDefault();
      expandSourceVideoGroups(sourceGroups);
    }
  });

  window.addEventListener("popstate", () => {
    restoreStateFromUrl();
  });

  window.addEventListener("resize", handleResponsiveResize, { passive: true });
  window.visualViewport?.addEventListener("resize", handleResponsiveResize, { passive: true });
  window.visualViewport?.addEventListener("scroll", updateViewportVars, { passive: true });
  updateViewportVars();
  state.responsiveMode = getResponsiveMode();
}

function switchView(nextView, options = {}) {
  if (!nextView || state.view === nextView) return;
  storeViewPosition();
  state.view = nextView;
  state.expandedRows.clear();
  resetPagination();
  syncControlsFromState();
  renderOrSyncUrl({ urlMode: options.urlMode || "push" });
  restoreViewPosition();
}

function bindSearchOverlayEvents() {
  els.openSearchButton?.addEventListener("click", () => openSearchOverlay(els.openSearchButton));
  els.cancelSearchButton?.addEventListener("click", () => closeOverlay("search"));
  els.clearSearchButton?.addEventListener("click", () => {
    if (!els.searchPanelInput) return;
    els.searchPanelInput.value = "";
    renderSearchSuggestions("");
    els.searchPanelInput.focus();
  });
  els.clearRecentSearchesButton?.addEventListener("click", () => {
    writeRecentSearches([]);
    renderRecentSearches();
  });
  els.searchDialog?.querySelector("[data-close-overlay='search']")?.addEventListener("click", () => closeOverlay("search"));
  els.searchPanelInput?.addEventListener("input", () => renderSearchSuggestions(els.searchPanelInput.value));
  els.searchPanelInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applySearchFromOverlay(els.searchPanelInput.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeOverlay("search");
    }
  });
  els.searchSuggestions?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-search-value]");
    if (!button) return;
    applySearchFromOverlay(button.dataset.searchValue || button.textContent || "");
  });
  els.recentSearches?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-search-value]");
    if (!button) return;
    applySearchFromOverlay(button.dataset.searchValue || button.textContent || "");
  });
}

function bindFilterOverlayEvents() {
  els.openFilterButton?.addEventListener("click", () => openFilterOverlay(els.openFilterButton));
  els.desktopFilterButton?.addEventListener("click", () => openFilterOverlay(els.desktopFilterButton));
  els.cancelFilterButton?.addEventListener("click", () => closeOverlay("filter"));
  els.filterDialog?.querySelector("[data-close-overlay='filter']")?.addEventListener("click", () => closeOverlay("filter"));
  els.applyFiltersButton?.addEventListener("click", () => {
    applyFilterDraft().catch((error) => showToast(`筛选应用失败：${error.message}`));
  });
  els.resetFiltersButton?.addEventListener("click", () => {
    state.filterDraft = defaultFilterDraft();
    syncFilterControlsFromDraft(state.filterDraft);
  });
  els.filterSnapshotDateSelect?.addEventListener("change", () => {
    syncDraftSnapshotTimes(els.filterSnapshotDateSelect.value);
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.activeOverlay) {
    event.preventDefault();
    closeOverlay(state.activeOverlay);
    return;
  }
  if (event.key === "Tab") trapModalFocus(event);
});

function openSearchOverlay(trigger) {
  state.overlayTrigger = trigger || document.activeElement;
  state.activeOverlay = "search";
  if (els.searchPanelInput) els.searchPanelInput.value = state.filter;
  renderRecentSearches();
  renderSearchSuggestions(state.filter);
  setDialogOpen(els.searchDialog, true);
  setPageInert(true);
  window.requestAnimationFrame(() => {
    focusWithoutScrolling(els.searchPanelInput || els.searchPanel);
  });
}

function openFilterOverlay(trigger) {
  state.overlayTrigger = trigger || document.activeElement;
  state.activeOverlay = "filter";
  state.filterDraft = makeFilterDraftFromState();
  syncFilterControlsFromDraft(state.filterDraft);
  updateFilterAvailability();
  setDialogOpen(els.filterDialog, true);
  setPageInert(true);
  measureSync("sheet-open", () => {});
  window.requestAnimationFrame(() => {
    focusWithoutScrolling(els.filterSheet || els.filterDialog);
  });
}

function closeOverlay(kind) {
  if (kind && state.activeOverlay !== kind) return;
  const overlay = state.activeOverlay;
  if (!overlay) return;
  setDialogOpen(overlay === "search" ? els.searchDialog : els.filterDialog, false);
  state.activeOverlay = "";
  state.filterDraft = null;
  setPageInert(false);
  const trigger = state.overlayTrigger;
  state.overlayTrigger = null;
  if (trigger && document.contains(trigger)) focusWithoutScrolling(trigger);
}

function setDialogOpen(dialog, isOpen) {
  if (!dialog) return;
  dialog.hidden = !isOpen;
  document.body.classList.toggle("is-modal-open", isOpen);
}

function setPageInert(isInert) {
  for (const element of [document.querySelector(".topbar"), document.querySelector(".layout"), els.mobileBottomNav, els.backToTop]) {
    if (!element) continue;
    if ("inert" in element) element.inert = isInert;
    element.setAttribute("aria-hidden", isInert ? "true" : "false");
  }
}

function activeModalElement() {
  if (state.activeOverlay === "search") return els.searchDialog;
  if (state.activeOverlay === "filter") return els.filterDialog;
  return null;
}

function trapModalFocus(event) {
  const root = activeModalElement();
  if (!root || root.hidden) return;
  const focusable = Array.from(
    root.querySelectorAll("a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"),
  ).filter((node) => node.offsetParent !== null || node === document.activeElement);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function applySearchFromOverlay(value) {
  const next = String(value || "").trim().slice(0, 200);
  state.filter = next;
  if (els.filterInput) els.filterInput.value = next;
  if (next) writeRecentSearches([next, ...readRecentSearches().filter((item) => item !== next)].slice(0, 10));
  state.expandedRows.clear();
  resetPagination();
  advanceRenderRevision();
  closeOverlay("search");
  render({ urlMode: "push" });
}

function renderRecentSearches() {
  if (!els.recentSearches || !els.recentSearchSection) return;
  const recent = readRecentSearches();
  els.recentSearchSection.hidden = !recent.length;
  els.recentSearches.replaceChildren();
  for (const item of recent) {
    const button = document.createElement("button");
    button.className = "search-chip";
    button.type = "button";
    button.dataset.searchValue = item;
    button.textContent = item;
    els.recentSearches.append(button);
  }
}

function readRecentSearches() {
  try {
    const value = JSON.parse(window.localStorage?.getItem(RECENT_SEARCHES_KEY) || "[]");
    return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 10) : [];
  } catch {
    return [];
  }
}

function writeRecentSearches(items) {
  try {
    window.localStorage?.setItem(RECENT_SEARCHES_KEY, JSON.stringify(items.slice(0, 10)));
  } catch {
    // localStorage can be unavailable in restricted browser modes.
  }
}

function renderSearchSuggestions(query) {
  if (!els.searchSuggestions) return;
  const suggestions = measureSync("search-suggest", () => buildSearchSuggestions(query));
  els.searchSuggestions.replaceChildren();
  if (!String(query || "").trim()) {
    const empty = document.createElement("p");
    empty.className = "suggestion-empty";
    empty.textContent = "输入关键词后显示建议";
    els.searchSuggestions.append(empty);
    return;
  }
  for (const group of suggestions) {
    if (!group.items.length) continue;
    const section = document.createElement("section");
    section.className = "suggestion-group";
    const title = document.createElement("h4");
    title.textContent = group.label;
    section.append(title);
    for (const item of group.items) {
      const button = document.createElement("button");
      button.className = "suggestion-item";
      button.type = "button";
      button.dataset.searchValue = item.value;
      appendHighlightedText(button, item.label, query);
      if (item.meta) {
        const meta = document.createElement("span");
        meta.textContent = item.meta;
        button.append(meta);
      }
      section.append(button);
    }
    els.searchSuggestions.append(section);
  }
  if (!els.searchSuggestions.childElementCount) {
    const empty = document.createElement("p");
    empty.className = "suggestion-empty";
    empty.textContent = "没有匹配建议";
    els.searchSuggestions.append(empty);
  }
}

function appendHighlightedText(container, text, query) {
  const source = String(text || "");
  const needle = String(query || "").trim();
  if (!needle) {
    container.append(document.createTextNode(source));
    return;
  }
  const haystack = source.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const index = haystack.indexOf(lowerNeedle);
  if (index < 0) {
    container.append(document.createTextNode(source));
    return;
  }
  container.append(document.createTextNode(source.slice(0, index)));
  const mark = document.createElement("mark");
  mark.textContent = source.slice(index, index + needle.length);
  container.append(mark, document.createTextNode(source.slice(index + needle.length)));
}

function buildSearchSuggestions(query) {
  const filterKey = normalizeSearch(query);
  if (!filterKey || !state.payload) return [];
  const rangeCache = getRangeCache(currentGroup());
  const hideUnknownForView = shouldHideUnknownForCurrentView();
  const baseOccurrences = selectedOccurrences(rangeCache, { hideUnknownForView });
  const songRecords = selectedSongRecords(rangeCache, { hideUnknownForView });
  const songSuggestions = songRecords
    .filter((record) => normalizeSearch([record.title, songMeta(record).primary].join(" ")).includes(filterKey))
    .slice(0, 5)
    .map((record) => ({
      label: record.title,
      value: record.title,
      meta: songMeta(record).primary,
    }));

  const artistRecords = (state.nicheOnly ? rangeCache.nicheArtistRecords : rangeCache.allArtistRecords)
    .filter((record) => normalizeSearch(record.name).includes(filterKey))
    .slice(0, 3)
    .map((record) => ({
      label: record.name,
      value: record.name,
      meta: `${record.count}次`,
    }));

  const channelMap = new Map();
  for (const occurrence of baseOccurrences) {
    const channel = cleanText(occurrence?.item?.channelName || "");
    if (!channel || !normalizeSearch(channel).includes(filterKey)) continue;
    channelMap.set(channel, (channelMap.get(channel) || 0) + 1);
  }
  const channelSuggestions = Array.from(channelMap.entries())
    .sort((a, b) => b[1] - a[1] || compareValues(a[0], b[0]))
    .slice(0, 3)
    .map(([channel, count]) => ({
      label: channel,
      value: channel,
      meta: `${count}次`,
    }));

  return [
    { label: "歌曲", items: songSuggestions },
    { label: "歌手", items: artistRecords },
    { label: "频道", items: channelSuggestions },
  ];
}

function makeFilterDraftFromState() {
  return {
    q: state.filter,
    nicheOnly: state.nicheOnly,
    hideUnknownArtist: state.hideUnknownArtist,
    rankMetric: state.rankMetric,
    trend: state.trend,
    minCount: state.minCount,
    pageSize: state.pageSize,
    snapshotPath: state.currentSnapshotPath,
  };
}

function defaultFilterDraft() {
  return {
    q: "",
    nicheOnly: false,
    hideUnknownArtist: true,
    rankMetric: "occurrences",
    trend: "all",
    minCount: 1,
    pageSize: state.pageSize,
    snapshotPath: SNAPSHOT_LATEST_PATH,
  };
}

function syncFilterControlsFromDraft(draft) {
  if (!draft) return;
  if (els.nicheOnlyToggle) els.nicheOnlyToggle.checked = Boolean(draft.nicheOnly);
  if (els.hideUnknownToggle) els.hideUnknownToggle.checked = Boolean(draft.hideUnknownArtist);
  for (const input of document.querySelectorAll("input[name='filterMetric']")) {
    input.checked = input.value === draft.rankMetric;
  }
  if (els.trendFilterSelect) els.trendFilterSelect.value = draft.trend;
  if (els.minCountSelect) els.minCountSelect.value = String(draft.minCount);
  if (els.filterPageSizeSelect) els.filterPageSizeSelect.value = String(draft.pageSize);
  const dateValue = snapshotDateValueForPath(draft.snapshotPath);
  if (els.filterSnapshotDateSelect) els.filterSnapshotDateSelect.value = dateValue;
  syncDraftSnapshotTimes(dateValue, draft.snapshotPath);
  updateFilterAvailability();
}

function syncDraftSnapshotTimes(dateValue, selectedPath = "") {
  if (!els.filterSnapshotSelect) return;
  els.filterSnapshotSelect.replaceChildren();
  if (dateValue === "latest") {
    const option = document.createElement("option");
    option.value = SNAPSHOT_LATEST_PATH;
    option.textContent = "最新快照";
    els.filterSnapshotSelect.append(option);
    els.filterSnapshotSelect.value = SNAPSHOT_LATEST_PATH;
    return;
  }
  for (const entry of snapshotEntriesForDate(dateValue)) {
    const option = document.createElement("option");
    option.value = entry.path;
    option.textContent = snapshotOptionLabel(entry);
    els.filterSnapshotSelect.append(option);
  }
  els.filterSnapshotSelect.value = selectedPath || firstSnapshotPathForDate(dateValue);
}

function readFilterDraftFromControls() {
  const selectedMetric = document.querySelector("input[name='filterMetric']:checked")?.value || "occurrences";
  return {
    q: state.filter,
    nicheOnly: Boolean(els.nicheOnlyToggle?.checked),
    hideUnknownArtist: Boolean(els.hideUnknownToggle?.checked),
    rankMetric: Object.hasOwn(RANK_METRICS, selectedMetric) ? selectedMetric : "occurrences",
    trend: Object.hasOwn(TREND_FILTERS, els.trendFilterSelect?.value) ? els.trendFilterSelect.value : "all",
    minCount: MIN_COUNT_OPTIONS.includes(Number(els.minCountSelect?.value)) ? Number(els.minCountSelect.value) : 1,
    pageSize: LIST_PAGE_SIZE_OPTIONS.includes(Number(els.filterPageSizeSelect?.value)) ? Number(els.filterPageSizeSelect.value) : DEFAULT_LIST_PAGE_SIZE,
    snapshotPath: els.filterSnapshotSelect?.value || SNAPSHOT_LATEST_PATH,
  };
}

async function applyFilterDraft() {
  const draft = readFilterDraftFromControls();
  const previousPath = state.currentSnapshotPath;
  closeOverlay("filter");
  state.filter = draft.q;
  state.nicheOnly = draft.nicheOnly;
  state.hideUnknownArtist = draft.hideUnknownArtist;
  state.rankMetric = draft.rankMetric;
  state.trend = draft.trend;
  state.minCount = draft.minCount;
  state.pageSize = draft.pageSize;
  state.expandedRows.clear();
  resetPagination();
  syncControlsFromState();
  if (previousPath !== draft.snapshotPath) {
    await applySnapshotPath(draft.snapshotPath, previousPath, { urlMode: "push" });
    return;
  }
  measureSync("filter-apply", () => render({ urlMode: "push" }));
}

async function applySnapshotPath(path, previousPath, options = {}) {
  const nextPath = path || SNAPSHOT_LATEST_PATH;
  if (nextPath === SNAPSHOT_LATEST_PATH) {
    state.currentSnapshotPath = SNAPSHOT_LATEST_PATH;
    const rangePayload = await loadRuntimeRange(state.range);
    await applyRuntimeRangePayload(rangePayload, { resetPage: false, syncUrl: options.syncUrl !== false, urlMode: options.urlMode || "replace" });
    scheduleCurrentRankDiffLoad();
    scheduleOtherRangePrefetch();
    return;
  }
  await loadSnapshotPath(nextPath, previousPath, options);
}

function updateFilterAvailability() {
  const rankView = state.view === "songRank" || state.view === "artistRank";
  if (els.metricFilterGroup) els.metricFilterGroup.hidden = !rankView || state.view === "videos";
  if (els.trendFilterGroup) els.trendFilterGroup.hidden = state.view === "songAz" || state.view === "videos";
  if (els.trendFilterSelect) {
    const disabled = !rankView || !isLatestSnapshot() || state.rankDiffLoads.has(state.range) || state.rankDiffs[state.range] === null;
    els.trendFilterSelect.disabled = disabled;
    if (els.trendFilterHint) {
      els.trendFilterHint.textContent = !isLatestSnapshot()
        ? "历史快照不支持趋势筛选"
        : state.rankDiffLoads.has(state.range)
          ? "趋势载入中"
          : state.rankDiffs[state.range] === null
            ? "趋势读取失败"
            : "";
    }
  }
}

function syncBottomNavFromState() {
  for (const tab of els.bottomViewTabs) {
    const active = tab.dataset.view === state.view;
    tab.classList.toggle("active", active);
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
}

function activeFilterCount() {
  let count = 0;
  if (state.nicheOnly) count += 1;
  if (!state.hideUnknownArtist) count += 1;
  if ((state.view === "songRank" || state.view === "artistRank") && state.rankMetric !== "occurrences") count += 1;
  if ((state.view === "songRank" || state.view === "artistRank") && state.trend !== "all") count += 1;
  if (state.view !== "videos" && state.minCount > 1) count += 1;
  if (!isLatestSnapshot()) count += 1;
  return count;
}

function syncFilterButtonCount() {
  const count = activeFilterCount();
  for (const badge of [els.filterCountBadge, els.mobileFilterCountBadge]) {
    if (!badge) continue;
    badge.hidden = count <= 0;
    badge.textContent = count > 0 ? String(count) : "";
  }
}

function snapshotDateValueForPath(path) {
  if (path === SNAPSHOT_LATEST_PATH) return "latest";
  const entry = snapshotEntryForPath(path);
  return entry ? snapshotDateValue(entry) : "latest";
}

function storeViewPosition() {
  try {
    window.sessionStorage?.setItem(`dailySongList.scroll.${state.view}`, String(Math.max(0, window.scrollY)));
    window.sessionStorage?.setItem(`dailySongList.page.${state.view}`, String(state.page));
  } catch {
    // sessionStorage can be unavailable in restricted browser modes.
  }
}

function restoreViewPosition() {
  window.requestAnimationFrame(() => {
    try {
      const raw = window.sessionStorage?.getItem(`dailySongList.scroll.${state.view}`);
      const top = Number(raw);
      if (Number.isFinite(top) && top > 0) window.scrollTo({ top, behavior: "auto" });
    } catch {
      // sessionStorage can be unavailable in restricted browser modes.
    }
  });
}

function updateViewportVars() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  document.documentElement.style.setProperty("--visual-viewport-height", `${Math.round(viewport.height)}px`);
  document.documentElement.style.setProperty("--visual-viewport-offset-top", `${Math.round(viewport.offsetTop)}px`);
}

function handleResponsiveResize() {
  updateViewportVars();
  const nextMode = getResponsiveMode();
  if (!state.responsiveMode) {
    state.responsiveMode = nextMode;
    return;
  }
  if (nextMode === state.responsiveMode || state.resizeRenderFrame) return;
  state.resizeRenderFrame = window.requestAnimationFrame(() => {
    state.resizeRenderFrame = 0;
    const currentMode = getResponsiveMode();
    if (currentMode === state.responsiveMode) return;
    state.responsiveMode = currentMode;
    state.expandedRows.clear();
    renderOrSyncUrl({ syncUrl: false });
  });
}

function setActiveTab(tabs, activeTab) {
  for (const item of tabs) {
    item.classList.toggle("active", item === activeTab);
    item.setAttribute("aria-pressed", item === activeTab ? "true" : "false");
  }
}

function applyInitialUrlState() {
  const defaults = defaultUrlState();
  const urlParams = new URLSearchParams(window.location.search);
  const shouldApplySharedState = urlParams.get("shared") === "1";
  if (!shouldApplySharedState) {
    Object.assign(state, {
      range: defaults.range,
      view: defaults.view,
      page: defaults.page,
      pageSize: defaults.pageSize,
      indexBucket: defaults.bucket,
      rankMetric: defaults.rankMetric,
      trend: defaults.trend,
      minCount: defaults.minCount,
      videoLayout: defaults.videoLayout,
      nicheOnly: defaults.outside,
      hideUnknownArtist: !defaults.showUnknown,
      filter: defaults.q,
      currentSnapshotPath: SNAPSHOT_LATEST_PATH,
    });
    state.sharedUrlApplied = false;
    return;
  }
  const parsed = window.FrontendUtils.parseUrlState(window.location.search, {
    defaults,
    validRanges: Object.keys(RANGE_LABELS),
    validViews: Object.keys(VIEWS),
    validPageSizes: LIST_PAGE_SIZE_OPTIONS,
    validRankMetrics: Object.keys(RANK_METRICS),
    validVideoLayouts: Object.keys(VIDEO_LAYOUTS),
    validTrendFilters: Object.keys(TREND_FILTERS),
    validMinCounts: MIN_COUNT_OPTIONS,
    latestSnapshotPath: SNAPSHOT_LATEST_PATH,
    snapshots: state.snapshots,
  });

  state.range = parsed.range;
  state.view = parsed.view;
  state.page = parsed.page;
  state.pageSize = parsed.pageSize;
  state.indexBucket = parsed.bucket;
  state.rankMetric = parsed.rankMetric;
  state.trend = parsed.trend;
  state.minCount = parsed.minCount;
  state.videoLayout = parsed.videoLayout;
  state.nicheOnly = parsed.outside;
  state.hideUnknownArtist = !parsed.showUnknown;
  state.filter = parsed.q;
  state.currentSnapshotPath = parsed.snapshotPath;
  state.sharedUrlApplied = true;
}

function syncControlsFromState() {
  setActiveTab(els.rangeTabs, els.rangeTabs.find((tab) => tab.dataset.range === state.range) || els.rangeTabs[0]);
  setActiveTab(els.viewTabs, els.viewTabs.find((tab) => tab.dataset.view === state.view) || els.viewTabs[0]);
  syncBottomNavFromState();
  if (els.filterInput) els.filterInput.value = state.filter;
  if (els.nicheOnlyToggle) els.nicheOnlyToggle.checked = state.nicheOnly;
  if (els.hideUnknownToggle) els.hideUnknownToggle.checked = state.hideUnknownArtist;
  syncSnapshotControlsFromState();
  syncFilterButtonCount();
}

function syncUrlState() {
  return;
}

function cleanSharedUrlAfterRender() {
  if (!state.sharedUrlApplied || !window.history?.replaceState) return;
  const cleanUrl = `${window.location.pathname}${window.location.hash || ""}`;
  window.history.replaceState({ dailySongList: true }, "", cleanUrl);
  state.sharedUrlApplied = false;
}

function renderOrSyncUrl(options = {}) {
  if (state.payload) {
    render(options);
    return;
  }
  if (options.syncUrl !== false) syncUrlState(options.urlMode || "replace");
}

function defaultUrlState() {
  return {
    range: "72h",
    view: "songRank",
    page: 1,
    pageSize: DEFAULT_LIST_PAGE_SIZE,
    bucket: INDEX_ALL_BUCKET,
    rankMetric: "occurrences",
    trend: "all",
    minCount: 1,
    videoLayout: "cards",
    outside: false,
    showUnknown: false,
    q: "",
  };
}

async function restoreStateFromUrl() {
  const previousPath = state.currentSnapshotPath;
  const previousListKey = listStateKey();
  applyInitialUrlState();
  syncControlsFromState();
  state.expandedRows.clear();
  if (state.currentSnapshotPath !== previousPath) {
    if (state.currentSnapshotPath === SNAPSHOT_LATEST_PATH) {
      const rangePayload = await loadRuntimeRange(state.range);
      await applyRuntimeRangePayload(rangePayload, { resetPage: false, syncUrl: false });
      scheduleCurrentRankDiffLoad();
      scheduleOtherRangePrefetch();
      return;
    }
    await loadSnapshotPath(state.currentSnapshotPath, previousPath, { syncUrl: false });
    return;
  }
  if (isLatestSnapshot()) {
    try {
      await ensureLatestRange(state.range);
    } catch (error) {
      showToast(`范围读取失败：${error.message}`);
      return;
    }
  }
  render({ syncUrl: false });
}

function listStateKey() {
  return [
    state.range,
    state.view,
    state.page,
    state.pageSize,
    state.indexBucket,
    state.rankMetric,
    state.trend,
    state.minCount,
    state.videoLayout,
    state.nicheOnly ? "outside" : "inside",
    state.hideUnknownArtist ? "hide" : "show",
    state.filter,
  ].join("::");
}

function resetPagination() {
  state.page = 1;
}

function setPage(page) {
  state.page = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  state.expandedRows.clear();
}

function currentPageSize() {
  if (state.view === "videos") return VIDEO_PAGE_SIZE;
  return PAGE_SIZES[state.view] ? state.pageSize : DEFAULT_LIST_PAGE_SIZE;
}

function pagedSlice(items) {
  const pageInfo = window.FrontendUtils.paginateItems(items, {
    page: state.page,
    pageSize: currentPageSize(),
  });
  state.page = pageInfo.page;
  return pageInfo;
}

function setupSnapshotLoader() {
  state.snapshotLoader = window.FrontendUtils.createSnapshotLoader({
    readJson,
    onBusy: (busy) => {
      setSnapshotBusy(busy, busy ? "正在读取快照" : "");
    },
    onSuccess: async ({ payload, path }) => {
      const applyOptions = state.snapshotApplyOptions || {};
      state.snapshotApplyOptions = null;
      await applySnapshotPayload(payload, path, applyOptions);
    },
    onFailure: () => {
      state.snapshotApplyOptions = null;
      syncSnapshotControlsFromState();
      renderStatus(state.status);
      showToast("快照读取失败，已保留当前数据");
    },
    onFirstFailure: ({ error }) => {
      renderLoadError(error);
    },
  });
}

function setupControlsObserver() {
  if (!els.controls || typeof ResizeObserver !== "function") return;
  const updateControlsHeight = () => {
    const height = Math.ceil(els.controls.getBoundingClientRect().height);
    document.documentElement.style.setProperty("--controls-height", `${height}px`);
  };
  const observer = new ResizeObserver(updateControlsHeight);
  observer.observe(els.controls);
  updateControlsHeight();
}

async function loadSnapshotPath(path, previousPath = state.currentSnapshotPath, options = {}) {
  const cached = state.preparedPayloadCache.get(path);
  if (cached) {
    applyPreparedSnapshotPayload(cached, path, options);
    return { status: "cached", payload: cached };
  }
  state.snapshotApplyOptions = options;
  return state.snapshotLoader.loadSnapshot({ path, previousPath });
}

async function switchRange(nextRange, options = {}) {
  if (!nextRange || state.range === nextRange) return;
  const previousRange = state.range;
  state.range = nextRange;
  state.expandedRows.clear();
  resetPagination();
  setActiveTab(els.rangeTabs, els.rangeTabs.find((tab) => tab.dataset.range === nextRange) || els.rangeTabs[0]);
  if (!isLatestSnapshot()) {
    renderOrSyncUrl(options);
    return;
  }

  try {
    await ensureLatestRange(nextRange);
    renderOrSyncUrl(options);
    scheduleCurrentRankDiffLoad();
  } catch (error) {
    state.range = previousRange;
    setActiveTab(els.rangeTabs, els.rangeTabs.find((tab) => tab.dataset.range === previousRange) || els.rangeTabs[0]);
    renderOrSyncUrl({ syncUrl: false });
    showToast(`范围读取失败，已保留当前内容：${error.message}`);
  }
}

async function ensureLatestRange(rangeId) {
  if (state.payload?.groups?.[rangeId]) return state.payload.groups[rangeId];
  const payload = await loadRuntimeRange(rangeId);
  await applyRuntimeRangePayload(payload, { resetPage: false, syncUrl: false, merge: true });
  return state.payload?.groups?.[rangeId];
}

async function loadRuntimeRange(rangeId) {
  const existing = state.runtimeRangePayloads.get(rangeId);
  if (existing) return existing;
  if (state.runtimeRangeLoads.has(rangeId)) return state.runtimeRangeLoads.get(rangeId);
  if (!state.runtimeMeta) throw new Error(`runtime meta missing before loading ${rangeId}`);
  const promise = loadRuntimeRangeWithFallback(rangeId)
    .then((payload) => {
      state.runtimeRangePayloads.set(rangeId, payload);
      return payload;
    })
    .finally(() => {
      state.runtimeRangeLoads.delete(rangeId);
    });
  state.runtimeRangeLoads.set(rangeId, promise);
  return promise;
}

function runtimeRangePath(rangeId) {
  return window.FrontendUtils.runtimeRangePath(rangeId, state.runtimeMeta, { requireMeta: true });
}

async function loadRuntimeRangeWithFallback(rangeId) {
  const primaryPath = runtimeRangePath(rangeId);
  const primaryError = await tryRuntimeRangeLoad(rangeId, primaryPath, { cache: cacheModeForPath(primaryPath) });
  if (primaryError.ok) {
    state.runtimeWarnings.delete(rangeId);
    return primaryError.payload;
  }

  const retry = await tryRuntimeRangeLoad(rangeId, primaryPath, { cache: "reload" });
  if (retry.ok) {
    state.runtimeWarnings.delete(rangeId);
    return retry.payload;
  }

  const fallback = await loadRuntimeRangeFallback(rangeId, [primaryError.error, retry.error]);
  if (fallback) return fallback;
  throw new Error(`运行时范围读取失败：${retry.error?.message || primaryError.error?.message || primaryPath}`);
}

async function tryRuntimeRangeLoad(rangeId, path, options = {}) {
  try {
    const payload = await readJson(path, options);
    return {
      ok: true,
      payload: window.FrontendUtils.validateRuntimeRangePayload(payload, {
        rangeId,
        meta: state.runtimeMeta,
        path,
      }),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

async function loadRuntimeRangeFallback(rangeId, errors) {
  const attempts = [`data/${rangeId}.json`, SNAPSHOT_LATEST_PATH];
  for (const fallbackPath of attempts) {
    try {
      const raw = await readJson(fallbackPath, { cache: "no-cache" });
      const group = fallbackPath === SNAPSHOT_LATEST_PATH ? raw.groups?.[rangeId] : raw;
      const payload = window.FrontendUtils.runtimeRangePayloadFromGroup(group, {
        rangeId,
        generatedAt: raw.generatedAt || group?.generatedAt || state.runtimeMeta?.generatedAt || "",
        capturedAt: raw.capturedAt || state.runtimeMeta?.capturedAt || "",
        filterVersion: Number.isInteger(state.runtimeMeta?.filterVersion) ? state.runtimeMeta.filterVersion : CURRENT_FILTER_VERSION,
        fallbackFrom: fallbackPath,
      });
      window.FrontendUtils.validateRuntimeRangePayload(payload, {
        rangeId,
        path: fallbackPath,
        allowLegacyDataVersion: true,
      });
      const message = `${RANGE_LABELS[rangeId] || rangeId}精简数据读取失败，当前使用备用数据 ${fallbackPath}`;
      state.runtimeWarnings.set(rangeId, {
        message,
        fallbackPath,
        primaryError: errors.map((error) => error?.message || String(error)).filter(Boolean).join(" | "),
      });
      showToast(message);
      return payload;
    } catch {
      // Try the next fallback source.
    }
  }
  return null;
}

async function applyRuntimeRangePayload(rangePayload, options = {}) {
  const isFallbackPayload = Boolean(rangePayload?.fallbackFrom);
  window.FrontendUtils.validateRuntimeRangePayload(rangePayload, {
    rangeId: rangePayload?.id || state.range,
    meta: isFallbackPayload ? null : state.runtimeMeta,
    path: rangePayload?.fallbackFrom || state.runtimeMeta?.ranges?.[rangePayload?.id || state.range]?.path,
    allowLegacyDataVersion: isFallbackPayload,
  });
  const payload = latestPayloadFromRuntimeRange(rangePayload, state.runtimeMeta);
  const prepared = await measureAsync("prepare-payload", () => preparePayload(payload));
  const rangeId = rangePayload.id;
  if (!options.merge) state.rangeCache.clear();
  await prewarmRangeCache(prepared.groups?.[rangeId], SNAPSHOT_LATEST_PATH, rangeId);
  await yieldToBrowser();
  if (options.merge && state.payload?.groups) {
    const merged = {
      ...state.payload,
      ...prepared,
      groups: {
        ...state.payload.groups,
        ...prepared.groups,
      },
    };
    applyPreparedSnapshotPayload(merged, SNAPSHOT_LATEST_PATH, { ...options, preserveRangeCache: true });
    return;
  }
  applyPreparedSnapshotPayload(prepared, SNAPSHOT_LATEST_PATH, { ...options, preserveRangeCache: true });
  if (rangeId && prepared.groups?.[rangeId]) {
    state.runtimeRangePayloads.set(rangeId, rangePayload);
  }
}

function latestPayloadFromRuntimeRange(rangePayload, meta) {
  const rangeId = rangePayload?.id || state.range;
  const group = {
    id: rangeId,
    title: rangePayload?.title || RANGE_LABELS[rangeId] || rangeId,
    generatedAt: rangePayload?.generatedAt || meta?.generatedAt || "",
    updatedAt: rangePayload?.generatedAt || meta?.generatedAt || "",
    items: Array.isArray(rangePayload?.items) ? rangePayload.items : [],
  };
  return {
    schemaVersion: rangePayload?.schemaVersion || meta?.schemaVersion || 1,
    generatedAt: meta?.generatedAt || rangePayload?.generatedAt || "",
    capturedAt: meta?.capturedAt || rangePayload?.capturedAt || rangePayload?.generatedAt || "",
    status: mergeRuntimeStatus(meta?.status || null, state.status, meta),
    filterVersion: rangePayload?.filterVersion ?? meta?.filterVersion ?? 0,
    nicheAnnotated: rangePayload?.nicheAnnotated === true || meta?.nicheAnnotated === true,
    groups: {
      [rangeId]: group,
    },
  };
}

async function applySnapshotPayload(payload, path, options = {}) {
  const prepared = await measureAsync("prepare-payload", () => preparePayload(payload));
  state.rangeCache.clear();
  await prewarmRangeCache(prepared.groups?.[state.range], path, state.range);
  await yieldToBrowser();
  cachePreparedPayload(path, prepared);
  applyPreparedSnapshotPayload(prepared, path, { ...options, preserveRangeCache: true });
}

function applyPreparedSnapshotPayload(payload, path, options = {}) {
  state.payload = payload;
  state.status = payload.status || state.status;
  state.currentSnapshotPath = path;
  state.expandedRows.clear();
  if (!options.preserveRangeCache) state.rangeCache.clear();
  if (options.resetPage !== false) resetPagination();
  syncSnapshotControlsFromState();
  syncNicheToggle();
  renderStatus(state.status);
  render({ syncUrl: options.syncUrl !== false, urlMode: options.urlMode || "replace" });
  setSnapshotBusy(false);
}

async function preparePayload(payload) {
  const sourceFiltered =
    shouldSkipSourceFilter(payload) || !window.SourceFilter?.filterPayloadBlockedSources
      ? payload
      : measureSync("source-filter", () => window.SourceFilter.filterPayloadBlockedSources(payload));
  if (window.FrontendUtils.hasNicheAnnotations(sourceFiltered)) return sourceFiltered;
  await ensureSongSearchLookup();
  if (!state.songSearchLookup.available) return sourceFiltered;
  return window.FrontendUtils.annotatePayloadWithNiche(sourceFiltered, state.songSearchLookup);
}

function shouldSkipSourceFilter(payload) {
  return window.FrontendUtils.shouldSkipSourceFilter(payload, CURRENT_FILTER_VERSION);
}

async function ensureSongSearchLookup() {
  if (state.songSearchLookup.available) return state.songSearchLookup;
  if (!state.songSearchIndexPromise) {
    state.songSearchIndexPromise = readJson(SONG_SEARCH_INDEX_PATH, { cache: "no-cache" })
      .then((index) => {
        state.songSearchLookup = window.FrontendUtils.createSongSearchLookup(index);
        return state.songSearchLookup;
      })
      .catch(() => {
        state.songSearchLookup = window.FrontendUtils.createSongSearchLookup(null);
        return state.songSearchLookup;
      });
  }
  return state.songSearchIndexPromise;
}

function cachePreparedPayload(path, payload) {
  if (!path || !payload) return;
  if (state.preparedPayloadCache.has(path)) state.preparedPayloadCache.delete(path);
  state.preparedPayloadCache.set(path, payload);
  while (state.preparedPayloadCache.size > SNAPSHOT_CACHE_LIMIT) {
    const oldestKey = state.preparedPayloadCache.keys().next().value;
    state.preparedPayloadCache.delete(oldestKey);
  }
}

function syncNicheToggle() {
  if (!els.nicheOnlyToggle) return;
  const enabled = window.FrontendUtils.hasNicheAnnotations(state.payload);
  els.nicheOnlyToggle.disabled = !enabled;
  if (!enabled) {
    state.nicheOnly = false;
    els.nicheOnlyToggle.checked = false;
  } else {
    els.nicheOnlyToggle.checked = state.nicheOnly;
  }
}

function renderInitialSkeleton() {
  resetContentClasses();
  els.content.classList.add("rank-panel", "skeleton-panel");
  els.summary.replaceChildren();
  const summarySkeleton = document.createElement("div");
  summarySkeleton.className = "summary-skeleton";
  summarySkeleton.setAttribute("aria-hidden", "true");
  els.summary.append(summarySkeleton);
  const fragment = document.createDocumentFragment();
  const header = document.createElement("div");
  header.className = "rank-header skeleton-header";
  header.setAttribute("aria-hidden", "true");
  for (const label of ["排名", "歌曲", "次数"]) {
    const item = document.createElement("span");
    item.textContent = label;
    header.append(item);
  }
  fragment.append(header);
  for (let index = 0; index < 8; index += 1) {
    const row = document.createElement("div");
    row.className = "rank-row skeleton-row";
    row.setAttribute("aria-hidden", "true");
    row.innerHTML = '<span class="skeleton-rank"></span><span class="skeleton-lines"><span></span><span></span></span><span class="skeleton-count"></span>';
    fragment.append(row);
  }
  els.content.replaceChildren(fragment);
}

async function yieldToBrowser() {
  if (typeof scheduler !== "undefined" && typeof scheduler.yield === "function") {
    await scheduler.yield();
    return;
  }
  if (typeof requestAnimationFrame === "function") {
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function scheduleCurrentRankDiffLoad() {
  if (!isLatestSnapshot() || state.view === "videos") return;
  loadRankDiffForRange(state.range)
    .then((loaded) => {
      if (loaded && isLatestSnapshot()) render({ syncUrl: false, lowPriority: true });
    })
    .catch((error) => {
      showToast(`趋势读取失败，榜单已正常显示：${error.message}`);
    });
}

async function loadRankDiffForRange(rangeId) {
  if (state.rankDiffs?.[rangeId]) return false;
  if (state.rankDiffLoads.has(rangeId)) return state.rankDiffLoads.get(rangeId);
  const path = state.runtimeMeta?.diffs?.[rangeId]?.path || `data/diff/latest-${rangeId}.json`;
  const promise = measureAsync("load-rank-diff", () => readJson(path, { cache: "no-cache" }))
    .then((diff) => {
      state.rankDiffs = {
        ...state.rankDiffs,
        [rangeId]: buildRankDiffLookup(diff),
      };
      return true;
    })
    .catch((error) => {
      state.rankDiffs = {
        ...state.rankDiffs,
        [rangeId]: null,
      };
      throw error;
    })
    .finally(() => {
      state.rankDiffLoads.delete(rangeId);
    });
  state.rankDiffLoads.set(rangeId, promise);
  return promise;
}

function buildRankDiffLookup(diff) {
  return window.FrontendUtils.createTrendLookup(diff);
}

function scheduleOtherRangePrefetch() {
  if (!isLatestSnapshot() || !canPrefetchOtherRange()) return;
  const otherRange = Object.keys(RANGE_LABELS).find((rangeId) => rangeId !== state.range);
  if (!otherRange || state.runtimeRangePayloads.has(otherRange)) return;
  const run = () => {
    if (document.visibilityState === "hidden" || state.runtimeRangePayloads.has(otherRange)) return;
    loadRuntimeRange(otherRange).catch(() => {});
  };
  setTimeout(() => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 6000 });
    } else {
      run();
    }
  }, 1800);
}

function canPrefetchOtherRange() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return window.FrontendUtils.shouldPrefetchRuntimeRange({
    connection,
    visibilityState: document.visibilityState,
  });
}

function setSnapshotBusy(isBusy, message = "") {
  els.content.setAttribute("aria-busy", isBusy ? "true" : "false");
  if (els.snapshotSelect) els.snapshotSelect.disabled = isBusy;
  if (els.snapshotDateSelect) els.snapshotDateSelect.disabled = isBusy;
  if (els.filterSnapshotSelect) els.filterSnapshotSelect.disabled = isBusy;
  if (els.filterSnapshotDateSelect) els.filterSnapshotDateSelect.disabled = isBusy;
  if (isBusy && message) els.status.textContent = message;
}

function showToast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.hidden = false;
  window.clearTimeout(els.toast._timer);
  els.toast._timer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 3200);
}

function setupBackToTopButton() {
  if (!els.backToTop) return;
  els.backToTop.addEventListener("click", () => {
    window.scrollTo({
      top: 0,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    focusWithoutScrolling(els.controls || document.body);
    updateBackToTopVisibility();
  });
  window.addEventListener("scroll", updateBackToTopVisibility, { passive: true });
  updateBackToTopVisibility();
}

function updateBackToTopVisibility() {
  if (!els.backToTop) return;
  const visible = window.scrollY > 700;
  els.backToTop.hidden = !visible;
  els.backToTop.setAttribute("aria-hidden", visible ? "false" : "true");
}

function advanceRenderRevision() {
  state.renderRevision += 1;
  return state.renderRevision;
}

function renderSnapshotOptions() {
  if (!els.snapshotSelect) return;
  renderSnapshotDateOptions();
  renderSnapshotTimeOptions(selectedSnapshotDateValue());
  syncSnapshotControlsFromState();
  syncFilterSnapshotControlsFromState();
}

function renderSnapshotDateOptions() {
  if (!els.snapshotDateSelect) return;
  els.snapshotDateSelect.replaceChildren();
  const latestOption = document.createElement("option");
  latestOption.value = "latest";
  latestOption.textContent = "最新";
  els.snapshotDateSelect.append(latestOption);

  for (const dateValue of snapshotDateValues()) {
    const option = document.createElement("option");
    option.value = dateValue;
    option.textContent = snapshotDateOptionLabel(dateValue);
    els.snapshotDateSelect.append(option);
  }
}

function renderSnapshotTimeOptions(dateValue) {
  els.snapshotSelect.replaceChildren();
  if (dateValue === "latest") {
    const latestOption = document.createElement("option");
    latestOption.value = SNAPSHOT_LATEST_PATH;
    latestOption.textContent = "最新快照";
    els.snapshotSelect.append(latestOption);
    els.snapshotSelect.disabled = false;
    return;
  }

  for (const entry of snapshotEntriesForDate(dateValue)) {
    const option = document.createElement("option");
    option.value = entry.path;
    option.textContent = snapshotOptionLabel(entry);
    els.snapshotSelect.append(option);
  }
  els.snapshotSelect.disabled = !els.snapshotSelect.options.length;
}

function syncSnapshotControlsFromState() {
  const dateValue = selectedSnapshotDateValue();
  if (els.snapshotDateSelect && els.snapshotDateSelect.value !== dateValue) {
    els.snapshotDateSelect.value = dateValue;
  }
  renderSnapshotTimeOptions(dateValue);
  if (els.snapshotSelect) els.snapshotSelect.value = state.currentSnapshotPath;
  syncFilterSnapshotControlsFromState();
}

function syncFilterSnapshotControlsFromState() {
  if (!els.filterSnapshotDateSelect || !els.filterSnapshotSelect || !els.snapshotDateSelect || !els.snapshotSelect) return;
  els.filterSnapshotDateSelect.replaceChildren(...Array.from(els.snapshotDateSelect.options).map((option) => option.cloneNode(true)));
  els.filterSnapshotSelect.replaceChildren(...Array.from(els.snapshotSelect.options).map((option) => option.cloneNode(true)));
  els.filterSnapshotDateSelect.value = els.snapshotDateSelect.value;
  els.filterSnapshotSelect.value = els.snapshotSelect.value;
  els.filterSnapshotDateSelect.disabled = els.snapshotDateSelect.disabled;
  els.filterSnapshotSelect.disabled = els.snapshotSelect.disabled;
}

function selectedSnapshotDateValue() {
  if (state.currentSnapshotPath === SNAPSHOT_LATEST_PATH) return "latest";
  const entry = snapshotEntryForPath(state.currentSnapshotPath);
  return entry ? snapshotDateValue(entry) : "latest";
}

function firstSnapshotPathForDate(dateValue) {
  if (dateValue === "latest") return SNAPSHOT_LATEST_PATH;
  return snapshotEntriesForDate(dateValue)[0]?.path || SNAPSHOT_LATEST_PATH;
}

function snapshotEntryForPath(path) {
  return state.snapshots.find((entry) => entry.path === path) || null;
}

function snapshotDateValues() {
  return [...new Set(state.snapshots.map(snapshotDateValue).filter(Boolean))];
}

function snapshotEntriesForDate(dateValue) {
  return state.snapshots.filter((entry) => snapshotDateValue(entry) === dateValue);
}

function snapshotDateValue(entry) {
  const date = new Date(entry?.capturedAt || entry?.generatedAt || entry?.id || "");
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function snapshotDateOptionLabel(dateValue) {
  const [, month, day] = String(dateValue).split("-");
  return month && day ? `${month}月${day}日` : dateValue;
}

function renderStatus(status) {
  renderStatusAlerts([]);
  if (!isLatestSnapshot()) {
    els.status.textContent = "历史快照";
    els.status.title = `历史快照 · ${capturedDate()}`;
    renderStatusAlerts([`历史快照 · ${capturedDate()}`]);
    renderDebugPanel();
    return;
  }
  const currentStatus = mergeRuntimeStatus(state.runtimeMeta?.status || null, status || state.status, state.runtimeMeta);
  if (!currentStatus) {
    els.status.textContent = "状态不可用";
    renderDebugPanel();
    return;
  }
  const capturedAt = currentStatus.completedAt || currentStatus.capturedAt || currentStatus.dataCapturedAt || state.runtimeMeta?.capturedAt || "";
  const attemptedAt = currentStatus.attemptedAt || "";
  const rebuiltDerivedAt = currentStatus.rebuiltDerivedAt || state.runtimeMeta?.rebuiltDerivedAt || "";
  const parts = [];
  if (currentStatus.status === "success") {
    parts.push(`数据抓取于 ${formatDate(capturedAt)}`);
  } else {
    const failureAt = attemptedAt ? `最近尝试 ${formatDate(attemptedAt)}` : "最近尝试时间不可用";
    parts.push(`正在使用上次成功数据 · ${failureAt}`);
    if (capturedAt) parts.push(`上次抓取 ${formatDate(capturedAt)}`);
  }
  if (rebuiltDerivedAt && rebuiltDerivedAt !== capturedAt) parts.push(`页面数据重建于 ${formatDate(rebuiltDerivedAt)}`);
  const staleAge = capturedAt ? Date.now() - Date.parse(capturedAt) : 0;
  const alerts = [];
  if (Number.isFinite(staleAge) && staleAge > STATUS_STALE_MS) {
    parts.push("超过90分钟未更新");
    alerts.push("数据已超过2小时未更新");
  }
  const warning = state.runtimeWarnings.get(state.range);
  if (warning?.fallbackPath) {
    parts.push("当前使用备用数据");
    alerts.push("精简数据读取失败，当前使用备用数据");
  }
  els.status.textContent = relativeUpdateLabel(capturedAt || rebuiltDerivedAt || attemptedAt);
  els.status.title = [
    parts.filter(Boolean).join(" · "),
    `status=${currentStatus.status || "unknown"}`,
    `capturedAt=${capturedAt || ""}`,
    `attemptedAt=${attemptedAt || ""}`,
    `rebuiltDerivedAt=${rebuiltDerivedAt || ""}`,
    `dataVersion=${state.runtimeMeta?.dataVersion || ""}`,
    warning?.primaryError ? `warning=${warning.primaryError}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  renderStatusAlerts(alerts);
  renderDebugPanel();
}

function renderStatusAlerts(messages) {
  if (!els.statusAlerts) return;
  els.statusAlerts.replaceChildren();
  for (const message of messages.filter(Boolean)) {
    const item = document.createElement("div");
    item.className = "status-alert";
    item.textContent = message;
    els.statusAlerts.append(item);
  }
}

function relativeUpdateLabel(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "状态不可用";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "刚刚更新";
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return formatDate(value);
}

function mergeRuntimeStatus(metaStatus, statusFile, meta) {
  const candidates = [metaStatus, statusFile].filter((item) => item && typeof item === "object");
  if (!candidates.length) return null;
  const newest = candidates
    .map((item) => ({
      ...item,
      _time: Date.parse(item.attemptedAt || item.completedAt || item.capturedAt || item.generatedAt || ""),
    }))
    .sort((a, b) => (Number.isFinite(b._time) ? b._time : 0) - (Number.isFinite(a._time) ? a._time : 0))[0];
  const { _time, ...status } = newest;
  return {
    ...status,
    capturedAt: status.capturedAt || status.dataCapturedAt || meta?.capturedAt || metaStatus?.capturedAt || "",
    dataCapturedAt: status.dataCapturedAt || status.capturedAt || meta?.capturedAt || metaStatus?.dataCapturedAt || "",
    rebuiltDerivedAt: status.rebuiltDerivedAt || meta?.rebuiltDerivedAt || metaStatus?.rebuiltDerivedAt || "",
    dataVersion: status.dataVersion || meta?.dataVersion || metaStatus?.dataVersion || "",
  };
}

function startStatusTicker() {
  if (state.statusRefreshTimer) window.clearInterval(state.statusRefreshTimer);
  state.statusRefreshTimer = window.setInterval(() => renderStatus(state.status), 60_000);
}

function renderDebugPanel() {
  if (!DEBUG_MODE) return;
  if (!els.debugPanel) {
    els.debugPanel = document.createElement("pre");
    els.debugPanel.id = "debugPanel";
    els.debugPanel.className = "debug-panel";
    els.debugPanel.setAttribute("aria-label", "运行时诊断");
    els.summary?.after(els.debugPanel);
  }
  const rangeMeta = state.runtimeMeta?.ranges?.[state.range] || null;
  const rangePayload = state.runtimeRangePayloads.get(state.range) || null;
  els.debugPanel.textContent = JSON.stringify(
    {
      dataVersion: state.runtimeMeta?.dataVersion || "",
      range: state.range,
      rangePath: rangeMeta?.path || "",
      rangeItemCount: rangeMeta?.itemCount ?? null,
      rangeDataVersion: rangePayload?.dataVersion || "",
      status: state.status || null,
      warning: state.runtimeWarnings.get(state.range) || null,
      resources: state.loadedResources.slice(-8),
    },
    null,
    2,
  );
}

function render(options = {}) {
  const renderMark = perfMark("render-dom:start");
  const group = currentGroup();
  const rangeCache = getRangeCache(group);
  const selection = currentSelection(rangeCache);
  if (state.view === "songAz") ensureIndexBucketExists(selection.songRecords);

  resetContentClasses();
  els.content.replaceChildren();

  if (state.view === "videos") {
    els.content.classList.add("video-grid");
    if (state.videoLayout === "compact") els.content.classList.add("video-compact");
    renderVideoList(group, rangeCache, selection);
  } else if (state.view === "artistRank") {
    els.content.classList.add("rank-panel");
    renderArtistRank(group, rangeCache, selection);
  } else if (state.view === "songAz") {
    els.content.classList.add("song-index");
    renderSongIndexView(group, rangeCache, selection);
  } else {
    els.content.classList.add("rank-panel");
    renderSongRank(group, rangeCache, selection);
  }

  if (options.syncUrl !== false) syncUrlState(options.urlMode || "replace");
  if (options.focusAfterPageChange) schedulePageChangeFocus();
  syncFilterButtonCount();
  updateFilterAvailability();
  cleanSharedUrlAfterRender();
  updateBackToTopVisibility();
  if (!state.firstContentMeasured) {
    state.firstContentMeasured = true;
    perfMeasure("first-content", renderMark);
  }
  perfMeasure("render-dom", renderMark);
  scheduleCurrentRankDiffLoad();
}

function currentGroup() {
  return state.payload?.groups?.[state.range] || { id: state.range, title: state.range, items: [] };
}

function getRangeCache(group) {
  const key = rangeCacheKey(state.currentSnapshotPath, state.range);
  const cached = state.rangeCache.get(key);
  if (cached && cached.items === group.items) return cached;
  const next = createRangeCache(group);
  state.rangeCache.set(key, next);
  return next;
}

function rangeCacheKey(snapshotPath, rangeId) {
  return `${snapshotPath}::${rangeId}`;
}

async function prewarmRangeCache(group, snapshotPath, rangeId) {
  if (!group) return;
  const key = rangeCacheKey(snapshotPath, rangeId);
  const existing = state.rangeCache.get(key);
  if (existing && existing.items === group.items) return;
  const items = group.items || [];
  const occurrences = measureSync("collect-occurrences", () => collectSongOccurrences(items));
  await yieldToBrowser();
  const nicheOccurrences = filterNicheOccurrences(occurrences);
  const visibleOccurrences = filterUnknownArtistOccurrences(occurrences);
  const visibleNicheOccurrences = filterUnknownArtistOccurrences(nicheOccurrences);
  const cache = createRangeCacheObject({
    items,
    occurrences,
    nicheOccurrences,
    visibleOccurrences,
    visibleNicheOccurrences,
  });
  state.rangeCache.set(key, cache);
  await prewarmDefaultSorts(cache);
}

async function prewarmDefaultSorts(cache) {
  const filterKey = normalizeSearch(state.filter);
  if (filterKey) return;
  const hideUnknownForView = shouldHideUnknownForCurrentView();
  const scope = `${state.nicheOnly ? "niche" : "all"}::${hideUnknownForView ? "hide-unknown" : "show-unknown"}`;
  const songRecords = selectedSongRecords(cache, { hideUnknownForView });
  if (state.view === "artistRank") {
    const artistRecords = state.nicheOnly ? cache.nicheArtistRecords : cache.allArtistRecords;
    cacheRankModel(cache, `artist-rank::${scope}::${filterKey}::${state.rankMetric}`, [...artistRecords].sort(compareRankRecords));
  } else if (state.view === "songAz") {
    cache.sortedRecords.set(`song-az::${scope}::${filterKey}::${state.rankMetric}`, [...songRecords].sort(compareSongAz));
  } else {
    cacheRankModel(cache, `song-rank::${scope}::${filterKey}::${state.rankMetric}`, [...songRecords].sort(compareSongRank));
  }
}

function createRangeCache(group) {
  const items = group.items || [];
  const occurrences = measureSync("collect-occurrences", () => collectSongOccurrences(items));
  const nicheOccurrences = filterNicheOccurrences(occurrences);
  const visibleOccurrences = filterUnknownArtistOccurrences(occurrences);
  const visibleNicheOccurrences = filterUnknownArtistOccurrences(nicheOccurrences);
  return createRangeCacheObject({
    items,
    occurrences,
    nicheOccurrences,
    visibleOccurrences,
    visibleNicheOccurrences,
  });
}

function createRangeCacheObject({
  items,
  occurrences,
  nicheOccurrences,
  visibleOccurrences,
  visibleNicheOccurrences,
}) {
  const cache = {
    items,
    occurrences,
    nicheOccurrences,
    visibleOccurrences,
    visibleNicheOccurrences,
    allVideoCount: uniqueVideoCount(occurrences),
    nicheVideoCount: uniqueVideoCount(nicheOccurrences),
    visibleVideoCount: uniqueVideoCount(visibleOccurrences),
    visibleNicheVideoCount: uniqueVideoCount(visibleNicheOccurrences),
    sortedRecords: new Map(),
    selectionCache: new Map(),
  };
  defineLazySongCache(cache, "allSongRecords", occurrences);
  defineLazySongCache(cache, "nicheSongRecords", nicheOccurrences);
  defineLazySongCache(cache, "visibleSongRecords", visibleOccurrences);
  defineLazySongCache(cache, "visibleNicheSongRecords", visibleNicheOccurrences);
  defineLazyArtistCache(cache, "all", occurrences);
  defineLazyArtistCache(cache, "niche", nicheOccurrences);
  defineLazyValue(cache, "normalizedVideoSearchData", () =>
    items.map((item) => ({
      item,
      searchText: normalizeSearch([item.title, item.channelName, item.keyword, ...(item.songs || []).flatMap((song) => [song.title, song.artist])].join(" ")),
    })),
  );
  return cache;
}

function defineLazySongCache(cache, key, occurrences) {
  defineLazyValue(cache, key, () => measureSync("build-song-records", () => buildSongRecords(occurrences)));
}

function defineLazyArtistCache(cache, prefix, occurrences) {
  const resultKey = `${prefix}ArtistResult`;
  const recordsKey = `${prefix}ArtistRecords`;
  const missingKey = `${prefix}MissingArtistCount`;
  defineLazyValue(cache, resultKey, () => measureSync("build-artist-records", () => buildArtistRecords(occurrences)));
  Object.defineProperty(cache, recordsKey, {
    configurable: true,
    enumerable: true,
    get() {
      return cache[resultKey].records;
    },
  });
  Object.defineProperty(cache, missingKey, {
    configurable: true,
    enumerable: true,
    get() {
      return cache[resultKey].missingArtistCount;
    },
  });
}

function defineLazyValue(target, key, factory) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      const value = factory();
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value,
      });
      return value;
    },
  });
}

function currentSelection(rangeCache) {
  const filterKey = normalizeSearch(state.filter);
  const hideUnknownForView = shouldHideUnknownForCurrentView();
  const key = `${state.nicheOnly ? "niche" : "all"}::${hideUnknownForView ? "hide-unknown" : "show-unknown"}::${filterKey}`;
  if (rangeCache.selectionCache.has(key)) return rangeCache.selectionCache.get(key);

  const baseOccurrences = selectedOccurrences(rangeCache, { hideUnknownForView });
  const baseSongRecords = selectedSongRecords(rangeCache, { hideUnknownForView });
  const needsArtistRecords = state.view === "artistRank";
  const baseArtistRecords = needsArtistRecords ? (state.nicheOnly ? rangeCache.nicheArtistRecords : rangeCache.allArtistRecords) : [];
  const baseMissingArtistCount = needsArtistRecords ? (state.nicheOnly ? rangeCache.nicheMissingArtistCount : rangeCache.allMissingArtistCount) : 0;
  const hiddenUnknownCount = hideUnknownForView ? hiddenUnknownOccurrenceCount(rangeCache) : 0;

  let selection;
  if (!filterKey) {
    selection = {
      occurrences: baseOccurrences,
      songRecords: baseSongRecords,
      artistRecords: baseArtistRecords,
      missingArtistCount: baseMissingArtistCount,
      videoCount: state.nicheOnly
        ? hideUnknownForView
          ? rangeCache.visibleNicheVideoCount
          : rangeCache.nicheVideoCount
        : hideUnknownForView
          ? rangeCache.visibleVideoCount
          : rangeCache.allVideoCount,
      hiddenUnknownCount,
      videoItems: null,
    };
  } else {
    const occurrences = baseOccurrences.filter((occurrence) => occurrence.searchText.includes(filterKey));
    const artistResult = buildArtistRecords(occurrences);
    selection = {
      occurrences,
      songRecords: buildSongRecords(occurrences),
      artistRecords: artistResult.records,
      missingArtistCount: artistResult.missingArtistCount,
      videoCount: uniqueVideoCount(occurrences),
      hiddenUnknownCount,
      videoItems: null,
    };
  }
  rangeCache.selectionCache.set(key, selection);
  return selection;
}

function selectedOccurrences(rangeCache, options = {}) {
  if (state.nicheOnly) return options.hideUnknownForView ? rangeCache.visibleNicheOccurrences : rangeCache.nicheOccurrences;
  return options.hideUnknownForView ? rangeCache.visibleOccurrences : rangeCache.occurrences;
}

function selectedSongRecords(rangeCache, options = {}) {
  if (state.nicheOnly) return options.hideUnknownForView ? rangeCache.visibleNicheSongRecords : rangeCache.nicheSongRecords;
  return options.hideUnknownForView ? rangeCache.visibleSongRecords : rangeCache.allSongRecords;
}

function shouldHideUnknownForCurrentView() {
  return state.hideUnknownArtist && state.view !== "artistRank";
}

function hiddenUnknownOccurrenceCount(rangeCache) {
  if (state.nicheOnly) return Math.max(0, rangeCache.nicheOccurrences.length - rangeCache.visibleNicheOccurrences.length);
  return Math.max(0, rangeCache.occurrences.length - rangeCache.visibleOccurrences.length);
}

function sortedSelectionRecords(rangeCache, selection, type, compare) {
  const key = sortedRecordsKey(type);
  if (!rangeCache.sortedRecords.has(key)) {
    const source = type.startsWith("artist") ? selection.artistRecords : selection.songRecords;
    rangeCache.sortedRecords.set(key, [...source].sort(compare));
  }
  return rangeCache.sortedRecords.get(key);
}

function rankingModelForSelection(rangeCache, selection, type, compare) {
  const key = sortedRecordsKey(type);
  const modelKey = `model::${key}`;
  if (rangeCache.sortedRecords.has(modelKey)) return rangeCache.sortedRecords.get(modelKey);
  const records = sortedSelectionRecords(rangeCache, selection, type, compare);
  return cacheRankModel(rangeCache, key, records);
}

function cacheRankModel(rangeCache, key, records) {
  rangeCache.sortedRecords.set(key, records);
  const model = {
    records,
    ranks: buildCompetitionRanks(records),
    countFrequencies: buildCountFrequencies(records, rankValue),
  };
  rangeCache.sortedRecords.set(`model::${key}`, model);
  return model;
}

function sortedRecordsKey(type) {
  const hideKey = shouldHideUnknownForCurrentView() ? "hide-unknown" : "show-unknown";
  return `${type}::${state.nicheOnly ? "niche" : "all"}::${hideKey}::${normalizeSearch(state.filter)}::${state.rankMetric}`;
}

function filteredRankModel(records, mode) {
  const minFiltered = filterRecordsByMinCount(records);
  const trendFiltered = filterRecordsByTrend(minFiltered, mode);
  return {
    records: trendFiltered,
    ranks: buildCompetitionRanks(trendFiltered),
    countFrequencies: buildCountFrequencies(trendFiltered, rankValue),
    baseCount: records.length,
    minCountApplied: state.minCount > 1,
    trendApplied: state.trend !== "all" && trendFiltered.length !== minFiltered.length,
  };
}

function filterRecordsByMinCount(records) {
  if (state.view === "videos" || state.minCount <= 1) return records;
  return records.filter((record) => rankValue(record) >= state.minCount);
}

function filterRecordsByTrend(records, mode) {
  if (state.trend === "all" || !canApplyTrendFilter(mode)) return records;
  return records.filter((record) => recordMatchesTrendFilter(record, mode));
}

function canApplyTrendFilter(mode) {
  if (!isLatestSnapshot()) return false;
  if (mode !== "songRank" && mode !== "artistRank") return false;
  const diff = state.rankDiffs?.[state.range]?.[mode];
  return diff instanceof Map;
}

function recordMatchesTrendFilter(record, mode) {
  const trend = state.rankDiffs?.[state.range]?.[mode]?.get(record.key);
  if (!trend) return false;
  if (state.trend === "new") return trend.isNew === true;
  const rankDelta = Number(trend.rankDelta) || 0;
  if (state.trend === "up") return rankDelta > 0;
  if (state.trend === "down") return rankDelta < 0;
  return true;
}

function filterStatusNote(mode, filteredModel) {
  const parts = [];
  if (filteredModel?.minCountApplied) parts.push(`最低${state.minCount}${rankCountUnit()}以上`);
  if (state.trend !== "all") {
    if (canApplyTrendFilter(mode)) {
      parts.push(`趋势：${TREND_FILTERS[state.trend] || state.trend}`);
    } else if (!isLatestSnapshot()) {
      parts.push("历史快照不支持趋势筛选");
    } else if (state.rankDiffLoads.has(state.range)) {
      parts.push("趋势载入中");
    } else if (state.rankDiffs[state.range] === null) {
      parts.push("趋势读取失败，暂未过滤");
    } else {
      parts.push("趋势载入中");
    }
  }
  return parts.join(" · ");
}

function resetContentClasses() {
  els.content.className = "content-shell";
  els.content.classList.add(`view-${state.view}`);
}

function renderVideoList(group, rangeCache, selection) {
  const sourceItems = videoItemsForRange(rangeCache, { nicheOnly: false, hideUnknownArtists: shouldHideUnknownForCurrentView(), ignoreSearch: true });
  const items = videoItemsForSelection(rangeCache, selection);
  const nicheItems = videoItemsForRange(rangeCache, { nicheOnly: true, hideUnknownArtists: shouldHideUnknownForCurrentView(), ignoreSearch: true });
  const denominatorItems = state.filter && state.nicheOnly ? nicheItems : sourceItems;
  const visibleSongs = items.reduce((sum, item) => sum + (item._displaySongs?.length || item.songs?.length || 0), 0);
  const denominatorSongs = denominatorItems.reduce((sum, item) => sum + (item._displaySongs?.length || item.songs?.length || 0), 0);
  renderSummary(group, [
    visibilityMetric(items.length, sourceItems.length, nicheItems.length, "个视频", "个小众视频"),
    countRatioMetric(visibleSongs, denominatorSongs, "个时间戳"),
  ], summaryNote(selection));

  if (!items.length) {
    renderEmpty(emptyMessage("这个范围还没有时间戳歌曲列表", "没有找到符合条件的视频", "没有找到小众歌曲视频"), {
      clearable: Boolean(state.filter),
    });
    return;
  }

  const pageInfo = pagedSlice(items);
  const fragment = document.createDocumentFragment();
  appendPagination(fragment, { pageInfo, unit: "个视频", variant: "top" });
  for (const item of pageInfo.visible) {
    fragment.append(renderVideo(item));
  }
  appendPagination(fragment, { pageInfo, unit: "个视频", variant: "bottom" });
  els.content.append(fragment);
}

function renderSongRank(group, rangeCache, selection) {
  const sourceOccurrences = rangeCache.occurrences;
  const hideUnknownForView = shouldHideUnknownForCurrentView();
  const sourceVisibleOccurrences = hideUnknownForView ? rangeCache.visibleOccurrences : sourceOccurrences;
  const allRecords = hideUnknownForView ? rangeCache.visibleSongRecords : rangeCache.allSongRecords;
  const nicheRecords = hideUnknownForView ? rangeCache.visibleNicheSongRecords : rangeCache.nicheSongRecords;
  const occurrences = selection.occurrences;
  const baseModel = rankingModelForSelection(rangeCache, selection, "song-rank", compareSongRank);
  const filteredModel = filteredRankModel(baseModel.records, "songRank");
  const { records, ranks, countFrequencies } = filteredModel;

  renderSummary(group, [
    recordVisibilityMetric(records.length, baseModel.records.length, allRecords.length, nicheRecords.length, "首歌曲", "首小众歌曲"),
    occurrenceVisibilityMetric(occurrences.length, sourceVisibleOccurrences.length, hideUnknownForView ? rangeCache.visibleNicheOccurrences.length : rangeCache.nicheOccurrences.length),
    metric(selection.videoCount, "个视频"),
  ], summaryNote(selection, filterStatusNote("songRank", filteredModel)));

  if (!records.length) {
    renderEmpty(emptyMessage("这个范围还没有歌曲", "没有找到符合条件的歌曲", "没有找到小众歌曲"), {
      clearable: Boolean(state.filter),
    });
    return;
  }

  const pageInfo = pagedSlice(records);
  const fragment = document.createDocumentFragment();
  appendPagination(fragment, { pageInfo, unit: "首歌曲", variant: "top" });
  fragment.append(renderRankHeader("song"));
  for (const record of pageInfo.visible) {
    fragment.append(
      renderRankRecord({
        mode: "song",
        key: `song-${record.key}`,
        rank: ranks.get(record.key),
        isTied: countFrequencies.get(rankValue(record)) > 1,
        title: record.title,
        record,
        meta: songMeta(record),
        isNiche: isNicheRecord(record),
        videoCount: record.videoCount,
        count: rankValue(record),
        countUnit: rankCountUnit(),
        occurrences: record.occurrences,
        trend: trendForRecord("songRank", record),
      }),
    );
  }
  appendPagination(fragment, { pageInfo, unit: "首歌曲", variant: "bottom" });
  els.content.append(fragment);
}

function renderArtistRank(group, rangeCache, selection) {
  const sourceOccurrences = rangeCache.occurrences;
  const allArtistRecords = rangeCache.allArtistRecords;
  const nicheArtistRecords = rangeCache.nicheArtistRecords;
  const occurrences = selection.occurrences;
  const baseModel = rankingModelForSelection(rangeCache, selection, "artist-rank", compareRankRecords);
  const filteredModel = filteredRankModel(baseModel.records, "artistRank");
  const { records, ranks, countFrequencies } = filteredModel;
  const missingArtistCount = selection.missingArtistCount;

  renderSummary(group, [
    recordVisibilityMetric(records.length, baseModel.records.length, allArtistRecords.length, nicheArtistRecords.length, "位歌手", "位小众歌曲歌手"),
    occurrenceVisibilityMetric(occurrences.length, sourceOccurrences.length, rangeCache.nicheOccurrences.length),
    metric(selection.videoCount, "个视频"),
  ], summaryNote(selection, [missingArtistCount ? `${missingArtistCount} 条待补歌手` : "", filterStatusNote("artistRank", filteredModel)].filter(Boolean).join(" · ")));

  if (!records.length) {
    renderEmpty(emptyMessage("这个范围还没有歌手资料", "没有找到符合条件的歌手", "没有找到小众歌曲歌手"), {
      clearable: Boolean(state.filter),
    });
    return;
  }

  const pageInfo = pagedSlice(records);
  const fragment = document.createDocumentFragment();
  appendPagination(fragment, { pageInfo, unit: "位歌手", variant: "top" });
  fragment.append(renderRankHeader("artist"));
  for (const record of pageInfo.visible) {
    fragment.append(
      renderRankRecord({
        mode: "artist",
        key: `artist-${record.key}`,
        rank: ranks.get(record.key),
        isTied: countFrequencies.get(rankValue(record)) > 1,
        title: record.name,
        record,
        meta: artistMeta(record),
        videoCount: record.videoCount,
        count: rankValue(record),
        countUnit: rankCountUnit(),
        occurrences: record.occurrences,
        songCount: record.songs.size,
        songPreview: artistSongPreview(record),
        getSongGroups: () => getArtistSongGroups(record),
        trend: trendForRecord("artistRank", record),
      }),
    );
  }
  appendPagination(fragment, { pageInfo, unit: "位歌手", variant: "bottom" });
  els.content.append(fragment);
}

function renderSongIndexView(group, rangeCache, selection) {
  const sourceOccurrences = rangeCache.occurrences;
  const hideUnknownForView = shouldHideUnknownForCurrentView();
  const sourceVisibleOccurrences = hideUnknownForView ? rangeCache.visibleOccurrences : sourceOccurrences;
  const allRecords = hideUnknownForView ? rangeCache.visibleSongRecords : rangeCache.allSongRecords;
  const nicheRecords = hideUnknownForView ? rangeCache.visibleNicheSongRecords : rangeCache.nicheSongRecords;
  const occurrences = selection.occurrences;
  const baseRecords = sortedSelectionRecords(rangeCache, selection, "song-az", compareSongAz);
  const records = filterRecordsByMinCount(baseRecords);

  renderSummary(group, [
    recordVisibilityMetric(records.length, baseRecords.length, allRecords.length, nicheRecords.length, "首歌曲", "首小众歌曲"),
    occurrenceVisibilityMetric(occurrences.length, sourceVisibleOccurrences.length, hideUnknownForView ? rangeCache.visibleNicheOccurrences.length : rangeCache.nicheOccurrences.length),
    metric(selection.videoCount, "个视频"),
  ], summaryNote(selection));

  if (!records.length) {
    renderEmpty(emptyMessage("这个范围还没有歌曲索引", "没有找到符合条件的歌曲", "没有找到小众歌曲"), {
      clearable: Boolean(state.filter),
    });
    return;
  }

  const bucketModel = window.FrontendUtils.buildIndexBucketModel(records, {
    bucket: state.indexBucket,
    getBucketLabel: songIndexBucket,
    compareBuckets: compareIndexBuckets,
  });
  if (state.indexBucket !== bucketModel.currentBucket) {
    state.indexBucket = bucketModel.currentBucket;
    resetPagination();
  }

  const pageInfo = pagedSlice(bucketModel.records);
  const groups = groupSongIndex(pageInfo.visible);
  const fragment = document.createDocumentFragment();
  fragment.append(renderIndexBucketNav(bucketModel.buckets));
  appendPagination(fragment, { pageInfo, unit: "首歌曲", variant: "top" });

  for (const groupEntry of groups) {
    const section = document.createElement("section");
    section.className = "index-section";
    section.id = groupEntry.id;

    const heading = document.createElement("h2");
    heading.className = "index-heading";
    heading.textContent = groupEntry.label;
    section.append(heading);

    const list = document.createElement("div");
    list.className = "index-list";
    const listFragment = document.createDocumentFragment();
    for (const record of groupEntry.records) {
      listFragment.append(renderIndexRecord(record));
    }
    list.append(listFragment);
    section.append(list);
    fragment.append(section);
  }
  appendPagination(fragment, { pageInfo, unit: "首歌曲", variant: "bottom" });
  els.content.append(fragment);
}

function ensureIndexBucketExists(records) {
  if (state.indexBucket === INDEX_ALL_BUCKET) return;
  if (!records.some((record) => songIndexBucket(record) === state.indexBucket)) {
    state.indexBucket = INDEX_ALL_BUCKET;
  }
}

function videoItemsForSelection(rangeCache, selection) {
  if (selection.videoItems) return selection.videoItems;
  selection.videoItems = videoItemsForRange(rangeCache, {
    filter: state.filter,
    nicheOnly: state.nicheOnly,
    hideUnknownArtists: shouldHideUnknownForCurrentView(),
  });
  return selection.videoItems;
}

function videoItemsForRange(rangeCache, options = {}) {
  const filter = options.ignoreSearch ? "" : options.filter ?? state.filter;
  const nicheOnly = options.nicheOnly ?? state.nicheOnly;
  const hideUnknownArtists = options.hideUnknownArtists ?? shouldHideUnknownForCurrentView();
  const key = `videos::${nicheOnly ? "niche" : "all"}::${hideUnknownArtists ? "hide-unknown" : "show-unknown"}::${normalizeSearch(filter)}`;
  if (!rangeCache.sortedRecords.has(key)) {
    rangeCache.sortedRecords.set(key, buildVideoViewItems(rangeCache.items, { filter, nicheOnly, hideUnknownArtists }));
  }
  return rangeCache.sortedRecords.get(key);
}

function renderSummary(group, metrics, note = "") {
  els.summary.replaceChildren();

  const main = document.createElement("div");
  main.className = "summary-main";

  const title = document.createElement("strong");
  title.className = "summary-title";
  title.textContent = VIEWS[state.view] || state.view;
  main.append(title);

  const range = document.createElement("span");
  range.className = "summary-chip summary-range";
  range.textContent = RANGE_LABELS[state.range] || group.title || state.range;
  main.append(range);

  if (state.nicheOnly) {
    const niche = document.createElement("span");
    niche.className = "summary-chip niche-summary";
    niche.textContent = "小众";
    main.append(niche);
  }

  const metricText = metrics.filter(Boolean).join(" · ");
  if (metricText) {
    const metricNode = document.createElement("span");
    metricNode.className = "summary-metrics";
    metricNode.textContent = metricText;
    main.append(metricNode);
  }
  els.summary.append(main);

  if (note) {
    const noteNode = document.createElement("span");
    noteNode.className = "summary-note";
    noteNode.textContent = note;
    els.summary.append(noteNode);
  }

  const actions = renderSummaryActions();
  if (actions.childElementCount) els.summary.append(actions);
}

function hiddenUnknownNote(selection) {
  const count = Number(selection?.hiddenUnknownCount) || 0;
  return state.hideUnknownArtist && count > 0 ? `已隐藏 ${count} 条无歌手收录` : "";
}

function summaryNote(selection, extra = "") {
  return [extra, hiddenUnknownNote(selection), monthlyCoverageNote()].filter(Boolean).join(" · ");
}

function monthlyCoverageNote() {
  if (state.range !== "1m" || !isLatestSnapshot()) return "";
  const catalog = state.runtimeMeta?.catalog;
  const catalogVideoCount = Number(catalog?.catalogVideoCount);
  const retentionDays = Number(catalog?.retentionDays) || 35;
  if (!Number.isFinite(catalogVideoCount) || catalogVideoCount <= 0) return "最近35天累计";
  return `最近${retentionDays}天累计 · 视频目录 ${catalogVideoCount} 个`;
}

function rangeFallbackNote() {
  const warning = state.runtimeWarnings.get(state.range);
  return warning?.fallbackPath ? `备用数据：${warning.fallbackPath}` : "";
}

function renderSummaryActions() {
  const actions = document.createElement("div");
  actions.className = "summary-actions";

  if (state.view === "songRank" || state.view === "artistRank") {
    const metricGroup = document.createElement("div");
    metricGroup.className = "summary-segmented";
    metricGroup.setAttribute("role", "group");
    metricGroup.setAttribute("aria-label", "排行口径");
    for (const [value, label] of Object.entries(RANK_METRICS)) {
      const button = document.createElement("button");
      const current = state.rankMetric === value;
      button.className = current ? "summary-action is-current" : "summary-action";
      button.type = "button";
      button.dataset.rankMetric = value;
      button.setAttribute("aria-pressed", current ? "true" : "false");
      button.textContent = value === "occurrences" ? "按收录" : "按视频";
      button.title = label;
      metricGroup.append(button);
    }
    actions.append(metricGroup);
  }

  if (state.view === "videos") {
    const layoutGroup = document.createElement("div");
    layoutGroup.className = "summary-segmented";
    layoutGroup.setAttribute("role", "group");
    layoutGroup.setAttribute("aria-label", "视频布局");
    for (const [value, label] of Object.entries(VIDEO_LAYOUTS)) {
      const button = document.createElement("button");
      const current = state.videoLayout === value;
      button.className = current ? "summary-action is-current" : "summary-action";
      button.type = "button";
      button.dataset.videoLayout = value;
      button.setAttribute("aria-pressed", current ? "true" : "false");
      button.textContent = label;
      layoutGroup.append(button);
    }
    actions.append(layoutGroup);
  }

  return actions;
}

function renderIndexBucketNav(buckets) {
  const nav = document.createElement("nav");
  nav.className = "index-nav";
  nav.setAttribute("aria-label", "歌曲快速索引");

  const allButton = renderIndexBucketButton(INDEX_ALL_BUCKET, INDEX_ALL_BUCKET, state.indexBucket === INDEX_ALL_BUCKET);
  nav.append(allButton);
  for (const bucket of buckets) {
    nav.append(renderIndexBucketButton(bucket.label, bucket.label, state.indexBucket === bucket.label));
  }
  return nav;
}

function renderIndexBucketButton(label, bucket, isCurrent) {
  const model = window.FrontendUtils.indexBucketButtonModel(label, bucket, isCurrent);
  const button = document.createElement("button");
  button.className = model.className;
  button.type = model.type;
  button.dataset.indexBucket = model.dataset.indexBucket;
  button.textContent = model.text;
  button.setAttribute("aria-pressed", model.ariaPressed);
  if (model.ariaCurrent) button.setAttribute("aria-current", model.ariaCurrent);
  return button;
}

function appendPagination(container, options) {
  const node = renderPaginationControl(options);
  if (node) container.append(node);
}

function renderPaginationControl({ pageInfo, unit, variant = "bottom" }) {
  const showPageControls = pageInfo.total > pageInfo.pageSize;
  const showPageSizeControl = shouldShowPageSizeControl(pageInfo, variant);
  if (!showPageControls && !showPageSizeControl) return null;

  const footer = document.createElement("div");
  footer.className = `pagination-row pagination-${variant}`;

  const note = document.createElement("span");
  note.className = "pagination-note";
  note.textContent =
    variant === "top"
      ? `${pageInfo.startIndex + 1}-${pageInfo.endIndex} / ${pageInfo.total} ${unit}`
      : `第 ${pageInfo.page} / ${pageInfo.pageCount} 页 · ${pageInfo.startIndex + 1}-${pageInfo.endIndex} / ${pageInfo.total} ${unit}`;
  footer.append(note);

  if (showPageSizeControl) {
    footer.append(renderPageSizeControl());
  }

  const controls = document.createElement("div");
  controls.className = "pagination-controls";

  if (variant === "top") {
    if (!showPageControls) return footer;
    const compactTop = isCompactRankMode();
    controls.append(
      renderPageButton("上一页", pageInfo.page - 1, pageInfo.page === 1, false, compactTop ? { icon: "prev" } : {}),
      renderPageStatus(pageInfo, { compact: compactTop }),
    );
    controls.append(renderPageButton("下一页", pageInfo.page + 1, pageInfo.page === pageInfo.pageCount, false, compactTop ? { icon: "next" } : {}));
    footer.append(controls);
    return footer;
  }

  controls.append(
    ...(showPageControls ? [renderPageButton("首页", 1, pageInfo.page === 1), renderPageButton("上一页", pageInfo.page - 1, pageInfo.page === 1)] : []),
  );

  if (showPageControls) {
    for (const token of window.FrontendUtils.visiblePageTokens(pageInfo.page, pageInfo.pageCount)) {
      if (token === "ellipsis") {
        controls.append(renderPageEllipsis());
      } else {
        controls.append(renderPageButton(String(token), token, token === pageInfo.page, token === pageInfo.page));
      }
    }

    controls.append(
      renderPageButton("下一页", pageInfo.page + 1, pageInfo.page === pageInfo.pageCount),
      renderPageButton("末页", pageInfo.pageCount, pageInfo.page === pageInfo.pageCount),
    );
    controls.append(renderPageJumpControl(pageInfo));
    footer.append(controls);
  }

  return footer;
}

function shouldShowPageSizeControl(pageInfo, variant = "bottom") {
  if (variant === "top") return false;
  if (state.view === "videos") return false;
  return pageInfo.total > Math.min(...LIST_PAGE_SIZE_OPTIONS);
}

function renderPageSizeControl() {
  const group = document.createElement("div");
  group.className = "page-size-control";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "每页数量");

  for (const option of LIST_PAGE_SIZE_OPTIONS) {
    const button = document.createElement("button");
    const current = state.pageSize === option;
    button.className = current ? "page-size-button is-current" : "page-size-button";
    button.type = "button";
    button.dataset.pageSize = String(option);
    button.setAttribute("aria-pressed", current ? "true" : "false");
    const full = document.createElement("span");
    full.className = "page-size-full";
    full.textContent = `每页 ${option}`;
    const short = document.createElement("span");
    short.className = "page-size-short";
    short.textContent = `${option}条`;
    button.append(full, short);
    group.append(button);
  }

  return group;
}

function renderPageButton(label, page, disabled, isCurrent = false, options = {}) {
  const button = document.createElement("button");
  button.className = isCurrent ? "pagination-button is-current" : "pagination-button";
  button.type = "button";
  button.dataset.page = String(page);
  button.disabled = disabled;
  if (isCurrent) button.setAttribute("aria-current", "page");
  if (options.icon) {
    button.classList.add("pagination-icon-button");
    button.setAttribute("aria-label", label);
    button.append(renderPaginationIcon(options.icon));
  } else {
    button.textContent = label;
  }
  return button;
}

function renderPaginationIcon(direction) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", direction === "prev" ? "m15 18-6-6 6-6" : "m9 6 6 6-6 6");
  svg.append(path);
  return svg;
}

function renderPageStatus(pageInfo, options = {}) {
  const status = document.createElement("span");
  status.className = "pagination-status";
  status.textContent = options.compact ? `${pageInfo.page}/${pageInfo.pageCount}` : `第 ${pageInfo.page} / ${pageInfo.pageCount} 页`;
  return status;
}

function renderPageJumpControl(pageInfo) {
  const label = document.createElement("label");
  label.className = "page-jump";
  const text = document.createElement("span");
  text.textContent = "跳转到第";
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.max = String(pageInfo.pageCount);
  input.inputMode = "numeric";
  input.dataset.jumpPage = "true";
  input.value = String(pageInfo.page);
  input.setAttribute("aria-label", `跳转到第几页，范围 1 到 ${pageInfo.pageCount}`);
  const suffix = document.createElement("span");
  suffix.textContent = "页";
  const button = document.createElement("button");
  button.className = "pagination-button page-jump-button";
  button.type = "button";
  button.dataset.jumpPageButton = "true";
  button.textContent = "跳转";
  label.append(text, input, suffix, button);
  return label;
}

function renderPageEllipsis() {
  const ellipsis = document.createElement("span");
  ellipsis.className = "pagination-ellipsis";
  ellipsis.setAttribute("aria-hidden", "true");
  ellipsis.textContent = "…";
  return ellipsis;
}

function schedulePageChangeFocus() {
  window.requestAnimationFrame(() => {
    const target = pageScrollTarget();
    scrollToElement(target);
    const focusTarget =
      els.content.querySelector(".rank-title, .index-heading, .video-title, .pagination-button[aria-current='page']") ||
      target;
    focusWithoutScrolling(focusTarget);
  });
}

function pageScrollTarget() {
  return els.summary || els.content;
}

function scrollToElement(element) {
  if (!element) return;
  const controlsHeight = controlsHeightPx();
  const top = Math.max(0, element.getBoundingClientRect().top + window.scrollY - controlsHeight - 8);
  window.scrollTo({
    top,
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
}

function focusWithoutScrolling(element) {
  if (!element) return;
  if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function controlsHeightPx() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--controls-height");
  return Number.parseFloat(raw) || els.controls?.getBoundingClientRect().height || 0;
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

function getResponsiveMode() {
  if (window.matchMedia?.(`(max-width: ${RESPONSIVE_BREAKPOINTS.mobileMax}px)`)?.matches) return "mobile";
  if (window.matchMedia?.(`(max-width: ${RESPONSIVE_BREAKPOINTS.tabletMax}px)`)?.matches) return "tablet";
  const width = document.documentElement.clientWidth || window.innerWidth || 0;
  if (width && width <= RESPONSIVE_BREAKPOINTS.mobileMax) return "mobile";
  if (width && width <= RESPONSIVE_BREAKPOINTS.tabletMax) return "tablet";
  return "desktop";
}

function isCompactRankMode() {
  return getResponsiveMode() !== "desktop";
}

function sourceInitialLimitForMode(mode = getResponsiveMode()) {
  return SOURCE_GROUP_LIMITS[mode]?.initial || SOURCE_GROUP_LIMITS.desktop.initial;
}

function sourceBatchSizeForMode(mode = getResponsiveMode()) {
  return SOURCE_GROUP_LIMITS[mode]?.batch || SOURCE_GROUP_LIMITS.desktop.batch;
}

function shouldKeepSingleDrawerOpen() {
  return isCompactRankMode();
}

function isMobileViewport() {
  return getResponsiveMode() === "mobile";
}

function emptyMessage(defaultMessage, searchMessage, nicheMessage) {
  if (state.filter) return searchMessage;
  if (state.nicheOnly) return nicheMessage;
  return defaultMessage;
}

function renderEmpty(message, options = {}) {
  els.content.classList.remove("rank-panel", "video-grid", "song-index");
  els.content.classList.add("empty-state");

  const empty = document.createElement("div");
  empty.className = "empty";
  if (options.role) empty.setAttribute("role", options.role);

  const title = document.createElement("p");
  title.textContent = message;
  empty.append(title);

  if (options.clearable) {
    const button = document.createElement("button");
    button.className = "clear-search";
    button.type = "button";
    button.dataset.clearSearch = "true";
    button.textContent = "清除搜索条件";
    empty.append(button);
  }

  if (options.reloadable) {
    const button = document.createElement("button");
    button.className = "clear-search";
    button.type = "button";
    button.addEventListener("click", () => window.location.reload());
    button.textContent = "重新读取";
    empty.append(button);
  }

  els.content.append(empty);
}

function renderLoadError(error, prefix = "读取失败") {
  els.status.textContent = prefix;
  els.summary.replaceChildren();
  resetContentClasses();
  els.content.replaceChildren();
  setSnapshotBusy(false);
  renderEmpty(`${prefix}: ${error.message}`, { reloadable: true, role: "alert" });
}

function buildVideoViewItems(items, options = {}) {
  const filter = options.ignoreSearch ? "" : options.filter ?? state.filter;
  const nicheOnly = options.nicheOnly ?? state.nicheOnly;
  const hideUnknownArtists = options.hideUnknownArtists ?? shouldHideUnknownForCurrentView();
  const normalizedFilter = normalizeSearch(filter);
  const result = [];
  for (const item of items || []) {
    const sourceSongs = (item.songs || []).filter(
      (song) =>
        (!nicheOnly || window.FrontendUtils.isNicheSong(song)) &&
        (!hideUnknownArtists || !window.RankingUtils.isUnknownArtistName(song?.artist)),
    );
    if (!sourceSongs.length) continue;
    const originalSongs = item._allSongs || item.songs || [];
    const sourceItem = item._sourceItem || item;
    if (!normalizedFilter) {
      result.push({ ...item, songs: sourceSongs, _displaySongs: sourceSongs, _allSongs: originalSongs, _sourceItem: sourceItem, _songSearchMatchCount: 0 });
      continue;
    }

    const videoMatched = matchesSearch([item.title, item.channelName, item.keyword]);
    const matchedSongs = sourceSongs.filter((song) => matchesSearch([song.title, song.artist]));
    if (!videoMatched && !matchedSongs.length) continue;

    const matchedSongSet = new Set(matchedSongs);
    const displaySongs = videoMatched
      ? sourceSongs
      : [...matchedSongs, ...sourceSongs.filter((song) => !matchedSongSet.has(song))];
    result.push({
      ...item,
      songs: sourceSongs,
      _displaySongs: displaySongs,
      _allSongs: originalSongs,
      _sourceItem: sourceItem,
      _songSearchMatchCount: matchedSongs.length,
      _videoSearchMatched: videoMatched,
    });
  }
  return result;
}

function collectSongOccurrences(items) {
  const occurrences = [];
  for (const item of items) {
    for (const song of item.songs || []) {
      if (!cleanText(song.title)) continue;
      occurrences.push({
        item,
        song,
        searchText: normalizeSearch([item.title, item.channelName, item.keyword, song.title, song.artist].join(" ")),
      });
    }
  }
  return occurrences;
}

function filterNicheOccurrences(occurrences) {
  return window.FrontendUtils.filterOccurrencesByNiche(occurrences, true);
}

function filterUnknownArtistOccurrences(occurrences) {
  return (occurrences || []).filter(({ song }) => !window.RankingUtils.isUnknownArtistName(song?.artist));
}

function matchesSearch(parts) {
  return window.FrontendUtils.matchesSearch(parts, state.filter);
}

function buildSongRecords(occurrences) {
  return addRecordRuntimeFields(window.RankingUtils.buildSongRecords(occurrences, {
    cleanText,
    incrementCount,
    makeSongSortKey,
    normalizeEntityKey,
  }));
}

function buildArtistRecords(occurrences) {
  const result = window.RankingUtils.buildArtistRecords(occurrences, {
    cleanText,
    incrementCount,
    normalizeEntityKey,
  });
  return {
    ...result,
    records: addRecordRuntimeFields(result.records),
  };
}

function buildArtistSongGroups(occurrences) {
  return window.RankingUtils.buildArtistSongGroups(occurrences, {
    cleanText,
    compareValues,
    incrementCount,
    isNicheSong: window.FrontendUtils.isNicheSong,
    makeSongSortKey,
    normalizeEntityKey,
  });
}

function addRecordRuntimeFields(records) {
  for (const record of records || []) {
    if (typeof record.videoCount !== "number") record.videoCount = uniqueVideoCount(record.occurrences || []);
    if (!record.searchText) {
      record.searchText = normalizeSearch([
        record.title,
        record.name,
        ...Array.from(record.artists?.values?.() || []).map((entry) => entry.name),
        ...Array.from(record.songs?.values?.() || []).map((entry) => entry.name),
      ].join(" "));
    }
  }
  return records;
}

function buildCompetitionRanks(records) {
  const ranks = new Map();
  let previousValue = null;
  let currentRank = 0;
  records.forEach((record, index) => {
    const value = rankValue(record);
    if (value !== previousValue) {
      currentRank = index + 1;
      previousValue = value;
    }
    ranks.set(record.key, currentRank);
  });
  return ranks;
}

function buildCountFrequencies(records, valueFn = (record) => record.count) {
  const frequencies = new Map();
  for (const record of records) {
    const value = valueFn(record);
    frequencies.set(value, (frequencies.get(value) || 0) + 1);
  }
  return frequencies;
}

function rankValue(record) {
  return state.rankMetric === "videos" ? record.videoCount || 0 : record.count;
}

function rankCountUnit() {
  return state.rankMetric === "videos" ? "视频" : "次";
}

function compareRankRecords(a, b) {
  return rankValue(b) - rankValue(a) || compareValues(a.name || a.title || a.key, b.name || b.title || b.key);
}

function incrementCount(map, name) {
  if (!name) return;
  const key = normalizeEntityKey(name);
  if (!key) return;
  if (!map.has(key)) map.set(key, { key, name, count: 0 });
  map.get(key).count += 1;
}

function songMeta(record) {
  const artists = sortedCountEntries(record.artists);
  return {
    primary: artists.length ? artists.slice(0, 2).map(formatCountEntry).join("、") : "待补歌手",
    missingPrimary: !artists.length,
    badges: isNicheRecord(record) ? ["小众"] : [],
  };
}

function artistMeta(record) {
  const songs = sortedCountEntries(record.songs);
  return {
    primary: songs.length ? songs.slice(0, 3).map(formatCountEntry).join("、") : `${record.songs.size} 首歌曲`,
    missingPrimary: false,
  };
}

function sortedCountEntries(map) {
  return Array.from(map.values()).sort(compareCountRecords);
}

function formatCountEntry(entry) {
  return entry.count > 1 ? `${entry.name} (${entry.count})` : entry.name;
}

function renderRankRecord({
  mode = "song",
  key,
  rank,
  isTied,
  title,
  record = null,
  meta,
  videoCount,
  count,
  countUnit = "次",
  occurrences,
  songGroups = [],
  songCount = songGroups.length,
  songPreview = songGroups.slice(0, 2).map((group) => group.title),
  getSongGroups = null,
  trend = null,
  isNiche = false,
}) {
  const row = document.createElement("article");
  const rowKey = makeDomId(key);
  const drawerId = `source-drawer-${rowKey}`;
  const artistSongCount = songCount;
  const sourceVideoCount = mode === "artist" ? videoCount : window.FrontendUtils.groupOccurrencesByVideo(occurrences).length;
  const expandable = mode === "artist" ? artistSongCount > 1 || sourceVideoCount > 1 : sourceVideoCount > 1;
  const isExpanded = state.expandedRows.has(rowKey);

  row.className = [
    "rank-row",
    `rank-row-${mode}`,
    expandable ? "is-expandable" : "",
    isExpanded ? "is-expanded" : "",
    isTied ? "is-tied" : "",
    isNiche ? "is-niche" : "",
    rank <= 3 ? `rank-top-${rank}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  row.dataset.rowKey = rowKey;
  row.dataset.drawerMode = mode;
  row._sourceOccurrences = occurrences;
  row._artistSongGroups = songGroups.length ? songGroups : null;
  row._getArtistSongGroups = getSongGroups;
  row._artistSongCount = artistSongCount;
  if (isTied) row.title = "同收录次数共享名次";

  const rankNumber = document.createElement("div");
  rankNumber.className = "rank-number";
  rankNumber.textContent = formatRank(rank);
  rankNumber.setAttribute("aria-label", `第 ${rank} 名`);
  row.append(rankNumber);

  row.append(renderRecordContent(title, meta, { mode, occurrences, songGroups, songCount, songPreview, drawerId, isExpanded, videoCount, trend }));
  row.append(renderTrend(trend));
  row.append(renderCount(count, countUnit));
  if (expandable) row.append(renderSourceDrawer({ mode, occurrences, songGroups, drawerId, isExpanded, getSongGroups }));

  return row;
}

function renderIndexRecord(record) {
  const row = document.createElement("article");
  const rowKey = makeDomId(`index-${record.key}`);
  const drawerId = `source-drawer-${rowKey}`;
  const sourceVideoCount = window.FrontendUtils.groupOccurrencesByVideo(record.occurrences).length;
  const expandable = sourceVideoCount > 1;
  const isExpanded = state.expandedRows.has(rowKey);

  row.className = ["index-row", expandable ? "is-expandable" : "", isExpanded ? "is-expanded" : "", isNicheRecord(record) ? "is-niche" : ""]
    .filter(Boolean)
    .join(" ");
  row.dataset.rowKey = rowKey;
  row.dataset.drawerMode = "index";
  row._sourceOccurrences = record.occurrences;

  row.append(
    renderRecordContent(record.title, songMeta(record), {
      mode: "index",
      occurrences: record.occurrences,
      drawerId,
      isExpanded,
      videoCount: record.videoCount,
      headingLevel: 3,
    }),
  );
  row.append(renderCount(record.count));
  if (expandable) row.append(renderSourceDrawer({ mode: "index", occurrences: record.occurrences, drawerId, isExpanded }));

  return row;
}

function renderRankHeader(mode = "song") {
  const header = document.createElement("div");
  header.className = "rank-header";

  const contentLabel = mode === "artist" ? "歌手与曲目" : "歌曲与来源";
  const countLabel = state.rankMetric === "videos" ? "视频" : "收录";
  for (const label of ["排名", contentLabel, "趋势", countLabel]) {
    const item = document.createElement("span");
    item.textContent = label;
    header.append(item);
  }

  return header;
}

function renderRecordContent(title, meta, options) {
  const {
    mode = "song",
    occurrences,
    songGroups = [],
    songCount = songGroups.length,
    songPreview = songGroups.slice(0, 2).map((group) => group.title),
    drawerId,
    isExpanded,
    videoCount,
    trend,
    headingLevel = 2,
  } = options;
  const content = document.createElement("div");
  content.className = "rank-content";

  const heading = document.createElement(`h${headingLevel}`);
  heading.className = "rank-title";
  heading.append(document.createTextNode(title));
  for (const badgeText of meta.badges || []) {
    const badge = document.createElement("span");
    badge.className = "song-badge niche-badge";
    badge.textContent = badgeText;
    heading.append(" ", badge);
  }
  content.append(heading);

  const subline = document.createElement("div");
  subline.className = "rank-subline";
  const metaLine = document.createElement("div");
  metaLine.className = "rank-meta-line";
  const actionsLine = document.createElement("div");
  actionsLine.className = "rank-actions-line";
  if (mode === "artist") {
    appendArtistSubline(metaLine, actionsLine, { occurrences, songCount, songPreview, drawerId, isExpanded, videoCount });
  } else {
    appendSublinePart(metaLine, meta.primary, meta.missingPrimary ? "artist-missing" : "subline-primary");
    appendSublinePart(metaLine, `${videoCount} 个视频`, "subline-video-count");
    appendSublineSource(metaLine, actionsLine, { mode, occurrences, drawerId, isExpanded });
  }
  const inlineTrend = renderTrendBadge(trend);
  if (inlineTrend) {
    inlineTrend.classList.add("rank-trend-inline");
    appendActionNode(actionsLine, inlineTrend);
  }
  if (metaLine.childNodes.length) subline.append(metaLine);
  if (actionsLine.childNodes.length) subline.append(actionsLine);
  content.append(subline);

  return content;
}

function appendArtistSubline(metaContainer, actionContainer, { occurrences, songCount, songPreview, drawerId, isExpanded, videoCount }) {
  appendSublinePart(metaContainer, (songPreview || []).slice(0, 2).join("、"), "subline-primary artist-song-preview");
  appendSublinePart(metaContainer, `${songCount} 首歌曲`, "subline-song-count");
  appendSublinePart(metaContainer, `${videoCount} 个视频`, "subline-video-count");
  if (songCount === 1 && occurrences.length === 1) {
    appendSublineNode(metaContainer, renderInlineSource(occurrences[0]));
  }

  if (songCount > 1 || occurrences.length > 1) {
    const button = renderSourceToggleButton({ mode: "artist", drawerId, isExpanded, songCount, occurrenceCount: occurrences.length, videoCount });
    appendActionNode(actionContainer, button);
  }
}

function appendSublinePart(container, text, className = "") {
  if (!text) return;
  if (container.childNodes.length) {
    const separator = document.createElement("span");
    separator.className = "meta-separator";
    separator.textContent = "·";
    container.append(separator);
  }
  const part = document.createElement("span");
  if (className) part.className = className;
  part.textContent = text;
  container.append(part);
}

function renderCount(count, unit = "次") {
  const node = document.createElement("div");
  node.className = count > 1 ? "rank-count is-strong" : "rank-count";
  const value = document.createElement("span");
  value.className = "rank-count-value";
  value.textContent = `${count}${unit}`;
  node.append(value);
  return node;
}

function renderTrend(trend) {
  const node = document.createElement("div");
  node.className = "rank-trend";
  const badge = renderTrendBadge(trend);
  if (badge) {
    node.append(badge);
  } else {
    node.setAttribute("aria-hidden", "true");
  }
  return node;
}

function appendSublineSource(metaContainer, actionContainer, { mode, occurrences, drawerId, isExpanded }) {
  if (!occurrences.length) {
    appendSublinePart(metaContainer, "无来源");
    return;
  }
  const groupedSources = window.FrontendUtils.groupOccurrencesByVideo(occurrences);
  if (groupedSources.length <= 1) {
    appendSublineNode(metaContainer, renderInlineSource(occurrences[0]));
    return;
  }

  const sourcePreview = window.FrontendUtils.buildSourcePreview(occurrences, {
    limit: INLINE_SOURCE_PREVIEW_LIMIT,
  });
  const button = renderSourceToggleButton({
    mode,
    drawerId,
    isExpanded,
    hiddenCount: sourcePreview.hiddenCount,
    total: sourcePreview.total,
    videoCount: groupedSources.length,
    occurrenceCount: occurrences.length,
  });
  const sourceLine = document.createElement("span");
  sourceLine.className = "source-line";
  sourceLine.append(renderSourcePreviewLinks(sourcePreview.preview));
  appendSublineNode(metaContainer, sourceLine);
  appendActionNode(actionContainer, button);
}

function renderSourceToggleButton({ mode, drawerId, isExpanded, hiddenCount = 0, total = 0, songCount = 0, videoCount = 0, occurrenceCount = 0 }) {
  const model = window.FrontendUtils.rankToggleModel({
    mode,
    isExpanded,
    hiddenCount,
    total,
    songCount,
    videoCount,
    occurrenceCount,
    compact: isCompactRankMode(),
  });
  const button = document.createElement("button");
  button.className = "rank-expand";
  button.type = "button";
  button.dataset.toggleSource = "true";
  button.dataset.sourceMode = mode;
  button.dataset.sourceTotal = String(total);
  button.dataset.sourceHiddenCount = String(hiddenCount);
  button.dataset.songCount = String(songCount);
  button.dataset.videoCount = String(videoCount);
  button.dataset.occurrenceCount = String(occurrenceCount || total);
  button.setAttribute("aria-expanded", isExpanded ? "true" : "false");
  button.setAttribute("aria-controls", drawerId);
  button.setAttribute("aria-label", model.ariaLabel);
  button.textContent = model.text;
  return button;
}

function renderSourcePreviewLinks(occurrences) {
  const preview = document.createElement("span");
  preview.className = "source-preview-list";
  preview.setAttribute("aria-label", "来源预览");
  occurrences.forEach((occurrence, index) => {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "source-preview-separator";
      separator.setAttribute("aria-hidden", "true");
      separator.textContent = "/";
      preview.append(separator);
    }
    preview.append(renderInlineSource(occurrence));
  });
  return preview;
}

function renderInlineSource(occurrence) {
  const model = window.FrontendUtils.buildInlineSourceModel(occurrence);
  const wrapper = document.createElement("span");
  wrapper.className = "inline-source";

  const time = document.createElement("a");
  time.className = "inline-source-time";
  time.href = model.time.href;
  time.target = "_blank";
  time.rel = "noreferrer";
  time.textContent = model.time.text;
  time.setAttribute("aria-label", model.time.ariaLabel);

  const separator = document.createElement("span");
  separator.className = "inline-source-separator";
  separator.setAttribute("aria-hidden", "true");
  separator.textContent = "·";

  const channel = document.createElement("a");
  channel.className = "inline-source-channel";
  channel.href = model.channel.href;
  channel.target = "_blank";
  channel.rel = "noreferrer";
  channel.textContent = model.channel.text;
  channel.title = model.channel.ariaLabel;
  channel.setAttribute("aria-label", model.channel.ariaLabel);

  wrapper.append(time, separator, channel);
  return wrapper;
}

function appendSublineNode(container, node) {
  if (container.childNodes.length) {
    const separator = document.createElement("span");
    separator.className = "meta-separator";
    separator.textContent = "·";
    container.append(separator);
  }
  container.append(node);
}

function appendActionNode(container, node) {
  if (node) container.append(node);
}

function renderSourceDrawer({ mode, occurrences, songGroups = [], drawerId, isExpanded, getSongGroups = null }) {
  const drawer = document.createElement("div");
  drawer.className = mode === "artist" ? "source-drawer artist-song-drawer" : "source-drawer";
  drawer.id = drawerId;
  drawer.dataset.sourceMode = mode;
  drawer.hidden = !isExpanded;
  drawer._getArtistSongGroups = getSongGroups;
  if (!isExpanded) {
    drawer.dataset.sourceDeferred = "true";
    return drawer;
  }

  appendSourceDrawerContent(drawer, { mode, occurrences, songGroups: songGroups.length ? songGroups : getSongGroups?.() || [] });
  return drawer;
}

function appendSourceDrawerContent(drawer, { mode, occurrences, songGroups = [] }) {
  if (mode === "artist") {
    appendArtistSongGroups(drawer, songGroups);
    return;
  }
  appendSourceDrawerLinks(drawer, occurrences, { showToolbar: true });
}

function appendSourceDrawerLinks(drawer, occurrences, options = {}) {
  drawer._sourceOccurrences = occurrences;
  drawer._songSourceOccurrences = options.copyOccurrences || drawer._songSourceOccurrences || occurrences;
  const groups = window.FrontendUtils.groupOccurrencesByVideo(occurrences);
  drawer._sourceGroups = groups;
  if (options.toolbarVariant) drawer.dataset.toolbarVariant = options.toolbarVariant;
  const visibleCount = sourceVisibleGroupCount(drawer, groups.length);
  const visibleGroups = groups.slice(0, visibleCount);
  const shouldShowToolbar = options.showToolbar !== false;
  if (shouldShowToolbar && !drawer.querySelector(":scope > .source-drawer-toolbar")) {
    drawer.append(renderSourceDrawerToolbar(drawer, drawer._songSourceOccurrences, { visibleCount, totalCount: groups.length }));
  } else {
    updateSourceDrawerCount(drawer, visibleCount, groups.length);
  }

  for (const group of visibleGroups) {
    drawer.append(renderSourceVideoGroup(group, drawer._songSourceOccurrences));
  }

  if (groups.length > visibleGroups.length) {
    const remaining = groups.length - visibleGroups.length;
    const more = document.createElement("button");
    more.className = "source-group-more";
    more.type = "button";
    more.dataset.toggleSourceGroups = "true";
    more.textContent = `查看更多来源（剩余 ${remaining}）`;
    drawer.append(more);
  }

  appendMobileSourceCollapse(drawer);
}

function renderSourceDrawerToolbar(drawer, occurrences, options = {}) {
  const totalCount = Number.isFinite(options.totalCount)
    ? options.totalCount
    : window.FrontendUtils.groupOccurrencesByVideo(occurrences).length;
  const visibleCount = Number.isFinite(options.visibleCount) ? options.visibleCount : totalCount;
  const toolbar = document.createElement("div");
  toolbar.className = "source-drawer-toolbar";
  if (drawer.dataset.toolbarVariant === "artist") toolbar.classList.add("artist-source-toolbar");

  const count = document.createElement("span");
  count.className = "source-drawer-count";
  count.textContent = sourceDrawerCountText(visibleCount, totalCount);
  toolbar.append(count);

  const actions = document.createElement("div");
  actions.className = "source-drawer-actions";
  actions.append(renderCopySongLinksButton(occurrences));
  toolbar.append(actions);
  return toolbar;
}

function updateSourceDrawerCount(drawer, visibleCount, totalCount) {
  const count = drawer.querySelector(":scope > .source-drawer-toolbar .source-drawer-count");
  if (count) count.textContent = sourceDrawerCountText(visibleCount, totalCount);
}

function sourceDrawerCountText(visibleCount, totalCount) {
  return visibleCount < totalCount ? `已显示${visibleCount}/${totalCount}个来源` : `${totalCount} 个来源`;
}

function sourceVisibleGroupCount(drawer, total) {
  const parsed = Number.parseInt(drawer.dataset.visibleSourceGroups || "", 10);
  const initial = sourceInitialLimitForMode();
  const requested = Number.isFinite(parsed) && parsed > 0 ? parsed : initial;
  const visibleCount = Math.min(total, Math.max(initial, requested));
  drawer.dataset.visibleSourceGroups = String(visibleCount);
  return visibleCount;
}

function appendMobileSourceCollapse(drawer) {
  if (!isCompactRankMode() || !drawer.classList.contains("source-drawer")) return;
  const mode = drawer.dataset.sourceMode || "song";
  drawer.append(renderSourceCollapseButton(drawer.id, mode));
}

function renderSourceCollapseButton(drawerId, mode = "song", className = "source-collapse-bottom") {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.dataset.collapseSource = "true";
  button.setAttribute("aria-controls", drawerId);
  button.textContent = mode === "artist" ? "收起曲目" : "收起来源";
  return button;
}

function renderSourceVideoGroup(group, songOccurrences = group.occurrences) {
  const section = document.createElement("section");
  section.className = "source-video-group";

  const header = document.createElement("div");
  header.className = "source-video-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "source-video-title-wrap";
  const title = document.createElement("a");
  title.className = "source-video-title";
  title.href = youtubeTimeUrl(group.item?.videoId || group.videoId, 0);
  title.target = "_blank";
  title.rel = "noreferrer";
  title.textContent = group.title || group.videoId || "来源视频";
  title.setAttribute("aria-label", `打开来源视频：${title.textContent}`);
  const channelLink = window.FrontendUtils.youtubeChannelLink({ ...(group.item || {}), channelName: group.channelName });
  const channel = document.createElement("a");
  channel.className = "source-video-channel";
  channel.href = channelLink.href;
  channel.target = "_blank";
  channel.rel = "noreferrer";
  channel.textContent = group.channelName || "未知频道";
  titleWrap.append(channel);
  titleWrap.append(title);
  header.append(titleWrap);

  const actions = document.createElement("div");
  actions.className = "source-video-actions";
  actions.append(renderCopySetlistButton(group.item, "复制歌单", "source-action source-copy"));
  header.append(actions);
  section.append(header);

  const timestamps = document.createElement("div");
  timestamps.className = "source-timestamps";
  group.occurrences.forEach((occurrence, index) => {
    const link = renderSourceTimestampLink(occurrence);
    if (index >= SOURCE_TIMESTAMP_INITIAL_LIMIT) {
      link.hidden = true;
      link.dataset.sourceTimeOverflow = "true";
    }
    timestamps.append(link);
  });

  if (group.occurrences.length > SOURCE_TIMESTAMP_INITIAL_LIMIT) {
    const more = document.createElement("button");
    more.className = "source-time-more";
    more.type = "button";
    more.dataset.toggleSourceTimes = "true";
    more.textContent = `显示其余 ${group.occurrences.length - SOURCE_TIMESTAMP_INITIAL_LIMIT} 个时间戳`;
    timestamps.append(more);
  }

  section.append(timestamps);
  return section;
}

function renderSourceTimestampLink(occurrence) {
  const link = document.createElement("a");
  link.className = "source-link source-time-link";
  link.href = youtubeTimeUrl(occurrence.item.videoId, occurrence.song.seconds);
  link.target = "_blank";
  link.rel = "noreferrer";

  const timeText = occurrence.song.time || formatSeconds(occurrence.song.seconds);
  const songTitle = cleanText(occurrence.song.title) || "未命名歌曲";
  const artist = cleanText(occurrence.song.artist);
  const channel = cleanText(occurrence.item.channelName);
  link.textContent = timeText;
  const context = [songTitle, artist, channel, timeText].filter(Boolean).join(" · ");
  link.title = context;
  link.setAttribute("aria-label", `打开时间戳：${context}`);
  return link;
}

function renderCopySetlistButton(item, label = "复制歌单", className = "copy-setlist-button") {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.dataset.copySetlist = "true";
  button._videoItem = item || {};
  button.textContent = label;
  button.setAttribute("aria-label", `复制整场歌单：${item?.title || item?.videoId || "来源视频"}`);
  return button;
}

function renderCopySongLinksButton(occurrences, label = "复制全部链接", className = "source-action source-copy-all") {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.dataset.copySongLinks = "true";
  button._sourceOccurrences = occurrences || [];
  button.textContent = label;
  button.setAttribute("aria-label", "复制同一首歌全部来源链接");
  return button;
}

function appendArtistSongGroups(drawer, songGroups) {
  const showAll = drawer.dataset.artistSongsExpanded === "true";
  const visibleGroups = showAll ? songGroups : songGroups.slice(0, ARTIST_SONG_GROUP_INITIAL_LIMIT);
  for (const group of visibleGroups) {
    const section = document.createElement("section");
    section.className = "artist-song-group";

    const header = document.createElement("div");
    header.className = "artist-song-header";

    const firstOccurrence = group.occurrences[0];
    const titleWrap = document.createElement("div");
    titleWrap.className = "artist-song-title-wrap";
    const title = document.createElement("a");
    title.className = "artist-song-title";
    title.href = youtubeTimeUrl(firstOccurrence.item.videoId, firstOccurrence.song.seconds);
    title.target = "_blank";
    title.rel = "noreferrer";
    title.textContent = group.title;
    title.setAttribute("aria-label", `打开歌曲首次来源：${group.title}`);
    titleWrap.append(title);

    if (group.isNiche) {
      const badge = document.createElement("span");
      badge.className = "song-badge niche-badge";
      badge.textContent = "小众";
      titleWrap.append(badge);
    }
    header.append(titleWrap);

    const count = document.createElement("span");
    count.className = "artist-song-count";
    count.textContent = `${group.count}次`;
    header.append(count);
    section.append(header);

    const sources = document.createElement("div");
    sources.className = "artist-song-sources";
    sources.dataset.sourceMode = "artist-song";
    appendSourceDrawerLinks(sources, group.occurrences, {
      copyOccurrences: group.occurrences,
      showToolbar: true,
      toolbarVariant: "artist",
    });
    section.append(sources);
    drawer.append(section);
  }

  if (songGroups.length > visibleGroups.length) {
    const more = document.createElement("button");
    more.className = "artist-song-more";
    more.type = "button";
    more.dataset.toggleArtistSongs = "true";
    more.textContent = `显示其余 ${songGroups.length - visibleGroups.length} 首`;
    drawer.append(more);
  }

  appendMobileSourceCollapse(drawer);
}

function toggleSourceDrawer(row) {
  if (!row) return;
  const drawer = row.querySelector(".source-drawer");
  const nextExpanded = Boolean(drawer?.hidden);
  if (nextExpanded && shouldKeepSingleDrawerOpen()) closeOtherMobileSourceDrawers(row);
  setSourceDrawerExpanded(row, nextExpanded);
}

function collapseSourceDrawer(row, options = {}) {
  setSourceDrawerExpanded(row, false, options);
}

function closeOtherMobileSourceDrawers(currentRow) {
  const rows = els.content?.querySelectorAll(".rank-row.is-expanded, .index-row.is-expanded") || [];
  for (const row of rows) {
    if (row !== currentRow) setSourceDrawerExpanded(row, false);
  }
}

function setSourceDrawerExpanded(row, nextExpanded, options = {}) {
  if (!row) return;
  const drawer = row.querySelector(".source-drawer");
  const buttons = Array.from(row.querySelectorAll("[data-toggle-source]"));
  if (!drawer || !buttons.length) return;

  if (nextExpanded && (drawer.dataset.sourceDeferred === "true" || isCompactRankMode())) {
    const mode = row.dataset.drawerMode || drawer.dataset.sourceMode || "song";
    const songGroups =
      mode === "artist" ? row._artistSongGroups || row._getArtistSongGroups?.() || [] : row._artistSongGroups || [];
    if (mode === "artist") row._artistSongGroups = songGroups;
    if (isCompactRankMode()) {
      delete drawer.dataset.visibleSourceGroups;
      delete drawer.dataset.videoGroupsExpanded;
    }
    drawer.replaceChildren();
    appendSourceDrawerContent(drawer, {
      mode,
      occurrences: row._sourceOccurrences || [],
      songGroups,
    });
    delete drawer.dataset.sourceDeferred;
  }
  drawer.hidden = !nextExpanded;
  row.classList.toggle("is-expanded", nextExpanded);
  for (const button of buttons) {
    button.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
    const count = row._sourceOccurrences?.length || 0;
    const total = Number(button.dataset.sourceTotal || count);
    const hiddenCount = Number(button.dataset.sourceHiddenCount || Math.max(0, count - INLINE_SOURCE_PREVIEW_LIMIT));
    const songCount = Number(button.dataset.songCount || row._artistSongCount || row._artistSongGroups?.length || 0);
    const videoCount = Number(button.dataset.videoCount || window.FrontendUtils.groupOccurrencesByVideo(row._sourceOccurrences || []).length);
    const occurrenceCount = Number(button.dataset.occurrenceCount || count);
    const mode = button.dataset.sourceMode || row.dataset.drawerMode || "song";
    const model = window.FrontendUtils.rankToggleModel({
      mode,
      isExpanded: nextExpanded,
      total,
      hiddenCount,
      songCount,
      videoCount,
      occurrenceCount,
      compact: isCompactRankMode(),
    });
    button.setAttribute("aria-label", model.ariaLabel);
    button.textContent = model.text;
  }

  if (nextExpanded) {
    state.expandedRows.add(row.dataset.rowKey);
  } else {
    state.expandedRows.delete(row.dataset.rowKey);
  }

  if (!nextExpanded && options.keepVisible) {
    window.requestAnimationFrame(() => keepSourceRowVisible(row));
  }
}

function keepSourceRowVisible(row) {
  if (!row || !document.contains(row)) return;
  const rect = row.getBoundingClientRect();
  const topLimit = controlsHeightPx() + 8;
  const bottomLimit = window.innerHeight - (isCompactRankMode() ? 76 : 16);
  if (rect.top < topLimit || rect.bottom > bottomLimit) scrollToElement(row);
}

function toggleArtistSongLimit(row) {
  if (!row) return;
  const drawer = row.querySelector(".artist-song-drawer");
  if (!drawer) return;
  const songGroups = row._artistSongGroups || row._getArtistSongGroups?.() || [];
  row._artistSongGroups = songGroups;
  drawer.dataset.artistSongsExpanded = "true";
  drawer.replaceChildren();
  appendArtistSongGroups(drawer, songGroups);
}

function expandSourceGroupTimestamps(button) {
  const group = button.closest(".source-video-group");
  if (!group) return;
  for (const link of group.querySelectorAll("[data-source-time-overflow]")) {
    link.hidden = false;
    delete link.dataset.sourceTimeOverflow;
  }
  button.remove();
}

function expandSourceVideoGroups(button) {
  const drawer = button.closest(".artist-song-sources, .source-drawer");
  if (!drawer) return;
  const occurrences = drawer._sourceOccurrences || [];
  const groups = drawer._sourceGroups || window.FrontendUtils.groupOccurrencesByVideo(occurrences);
  const current = sourceVisibleGroupCount(drawer, groups.length);
  drawer.dataset.visibleSourceGroups = String(Math.min(groups.length, current + sourceBatchSizeForMode()));
  drawer.replaceChildren();
  appendSourceDrawerLinks(drawer, occurrences);
}

function renderVideo(item) {
  const card = document.createElement("article");
  card.className = "video-card";

  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`;
  const thumbLink = document.createElement("a");
  thumbLink.className = "thumb-link";
  thumbLink.href = url;
  thumbLink.target = "_blank";
  thumbLink.rel = "noreferrer";
  thumbLink.setAttribute("aria-label", `打开视频：${item.title || item.videoId}`);

  const thumb = document.createElement("img");
  thumb.className = "thumb";
  thumb.alt = "";
  thumb.loading = "lazy";
  const thumbnailCandidates = videoThumbnailCandidates(item);
  let thumbnailIndex = 0;
  thumb.src = thumbnailCandidates[thumbnailIndex];
  thumb.addEventListener("error", () => {
    thumbnailIndex += 1;
    if (thumbnailIndex < thumbnailCandidates.length) thumb.src = thumbnailCandidates[thumbnailIndex];
  });
  thumbLink.append(thumb);
  card.append(thumbLink);

  const body = document.createElement("div");
  body.className = "video-body";

  const heading = document.createElement("div");
  heading.className = "video-heading";

  const titleWrap = document.createElement("div");
  titleWrap.className = "video-title-wrap";
  const title = document.createElement("a");
  title.className = "video-title";
  title.href = url;
  title.target = "_blank";
  title.rel = "noreferrer";
  title.textContent = item.title || item.videoId;
  titleWrap.append(title);

  const meta = document.createElement("div");
  meta.className = "video-meta";
  meta.textContent = [item.channelName, item.publishedText, item.keyword].filter(Boolean).join(" · ");
  titleWrap.append(meta);
  heading.append(titleWrap);

  const count = document.createElement("div");
  count.className = "song-count";
  const matchCount = item._songSearchMatchCount || 0;
  count.textContent = matchCount && !item._videoSearchMatched ? `匹配 ${matchCount} 首` : `${item.songs?.length || 0} 首`;
  const headingActions = document.createElement("div");
  headingActions.className = "video-heading-actions";
  headingActions.append(count, renderCopySetlistButton(item, "复制歌单", "video-copy-setlist"));
  heading.append(headingActions);
  body.append(heading);

  const list = document.createElement("ol");
  list.className = "song-list";
  list.id = `video-songs-${makeDomId(item.videoId || item.title)}`;
  const songs = item._displaySongs || item.songs || [];
  appendVideoSongLinks(list, item, songs.slice(0, 3));
  body.append(list);

  if (songs.length > 3) {
    const more = document.createElement("button");
    more.className = "video-more";
    more.type = "button";
    more.dataset.toggleVideoSongs = "true";
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-controls", list.id);
    card._remainingSongs = songs.slice(3);
    card._songList = list;
    card._videoItem = item;
    more.textContent = `展开其余 ${songs.length - 3} 首`;
    body.append(more);
  }

  card.append(body);
  return card;
}

function toggleVideoSongs(card) {
  if (!card) return;
  const button = card.querySelector(".video-more");
  const nextExpanded = button.getAttribute("aria-expanded") !== "true";
  if (nextExpanded && card._remainingSongs?.length) {
    appendVideoSongLinks(card._songList, card._videoItem, card._remainingSongs, "video-song-extra");
    card._remainingSongs = [];
  }

  const extras = Array.from(card.querySelectorAll(".video-song-extra"));

  for (const item of extras) item.hidden = !nextExpanded;
  button.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
  button.textContent = nextExpanded ? "收起歌曲" : `展开其余 ${extras.length} 首`;
}

function appendVideoSongLinks(list, item, songs, extraClass = "") {
  const fragment = document.createDocumentFragment();
  for (const song of songs) {
    const li = document.createElement("li");
    if (extraClass) li.className = extraClass;

    const link = document.createElement("a");
    link.href = youtubeTimeUrl(item.videoId, song.seconds);
    link.target = "_blank";
    link.rel = "noreferrer";

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = song.time || formatSeconds(song.seconds);
    const titleText = document.createTextNode(` ${cleanText(song.title)}`);
    link.append(time, titleText);

    const artist = cleanText(song.artist);
    if (artist) {
      const artistNode = document.createElement("span");
      artistNode.className = "song-artist";
      artistNode.textContent = ` / ${artist}`;
      link.append(artistNode);
    }

    if (window.FrontendUtils.isNicheSong(song)) {
      const badge = document.createElement("span");
      badge.className = "song-badge niche-badge";
      badge.textContent = "小众";
      link.append(" ", badge);
    }

    li.append(link);
    fragment.append(li);
  }
  list.append(fragment);
}

function groupSongIndex(records) {
  const buckets = new Map();
  for (const record of records) {
    const label = songIndexBucket(record);
    if (!buckets.has(label)) {
      buckets.set(label, {
        label,
        id: `song-index-${makeDomId(label)}`,
        records: [],
      });
    }
    buckets.get(label).records.push(record);
  }

  return Array.from(buckets.values()).sort(compareIndexBuckets);
}

function songIndexBucket(record) {
  const titleFirst = toHiragana(firstMeaningfulChar(record.title).normalize("NFKC"));
  for (const bucket of KANA_BUCKETS) {
    if (bucket.pattern.test(titleFirst)) return bucket.label;
  }

  const sortFirst = cleanText(record.sortKey)[0] || "";
  if (/^[a-z]$/i.test(sortFirst)) return sortFirst.toUpperCase();
  if (/^\d$/u.test(sortFirst)) return "0-9";
  if (/^\p{Script=Han}$/u.test(titleFirst)) return "汉字";
  return "其他";
}

function compareIndexBuckets(a, b) {
  return indexBucketWeight(a.label) - indexBucketWeight(b.label) || compareValues(a.label, b.label);
}

function indexBucketWeight(label) {
  if (/^[A-Z]$/u.test(label)) return label.charCodeAt(0) - 65;
  if (label === "0-9") return 30;
  const kanaIndex = KANA_BUCKETS.findIndex((bucket) => bucket.label === label);
  if (kanaIndex >= 0) return 40 + kanaIndex;
  if (label === "汉字") return 60;
  return 99;
}

async function readJson(path, options = {}) {
  const startedAt = performanceAvailable() ? performance.now() : 0;
  const response = await fetch(path, { cache: options.cache || cacheModeForPath(path), signal: options.signal });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const text = await response.text();
  const parseMark = perfMark("json-parse:start");
  try {
    return JSON.parse(text);
  } finally {
    perfMeasure("json-parse", parseMark);
    state.loadedResources.push({
      path,
      bytes: text.length,
      cache: options.cache || cacheModeForPath(path),
      durationMs: startedAt ? Math.round((performance.now() - startedAt) * 10) / 10 : 0,
    });
  }
}

function cacheModeForPath(path) {
  if (/^data\/snapshots\/[^/]+\.json$/u.test(path)) return "force-cache";
  if (path === UI_META_PATH || path === SNAPSHOT_LATEST_PATH || path === STATUS_PATH || path === "data/snapshots/index.json") return "no-cache";
  if (/^data\/ui\/(?:72h|1m)\.[0-9a-f]{12}\.json$/u.test(path)) return "force-cache";
  if (/^data\/ui\/(?:72h|1m)\.json$/u.test(path)) return "no-cache";
  if (/^data\/diff\/latest-(?:72h|1m)\.json$/u.test(path)) return "no-cache";
  if (path === SONG_SEARCH_INDEX_PATH) return "no-cache";
  return "no-cache";
}

function compareSongRank(a, b) {
  return rankValue(b) - rankValue(a) || compareValues(a.sortKey, b.sortKey) || compareValues(a.title, b.title);
}

function compareSongAz(a, b) {
  return compareValues(a.sortKey, b.sortKey) || b.count - a.count || compareValues(a.title, b.title);
}

function compareCountRecords(a, b) {
  return b.count - a.count || compareValues(a.name || a.title || a.key, b.name || b.title || b.key);
}

function compareValues(a, b) {
  return sortCollator.compare(String(a || ""), String(b || ""));
}

function uniqueVideoCount(occurrences) {
  return new Set(occurrences.map(({ item }) => item.videoId)).size;
}

function isNicheRecord(record) {
  return (record.occurrences || []).some(({ song }) => window.FrontendUtils.isNicheSong(song));
}

function metric(value, label) {
  if (typeof value === "number") return `${value} ${label}`;
  return `${label} ${value}`;
}

function visibilityMetric(visible, total, nicheTotal, label, nicheLabel = label) {
  if (state.filter && state.nicheOnly) return `显示 ${visible} / ${nicheTotal} ${nicheLabel}`;
  if (state.filter || state.nicheOnly) return `${state.nicheOnly ? "小众" : "显示"} ${visible} / ${total} ${label}`;
  return `${total} ${label}`;
}

function recordVisibilityMetric(visible, baseVisible, total, nicheTotal, label, nicheLabel = label) {
  if (visible !== baseVisible) return `${visible} / ${baseVisible} ${label}`;
  return visibilityMetric(visible, total, nicheTotal, label, nicheLabel);
}

function countRatioMetric(visible, total, label) {
  if (state.filter || state.nicheOnly) return `显示 ${visible} / ${total} ${label}`;
  return `${total} ${label}`;
}

function occurrenceVisibilityMetric(visible, total, nicheTotal) {
  if (state.filter && state.nicheOnly) return `显示 ${visible} / ${nicheTotal} 次小众收录`;
  if (state.filter || state.nicheOnly) return `${state.nicheOnly ? "小众" : "显示"} ${visible} / ${total} 次收录`;
  return `${total} 次收录`;
}

function artistSongPreview(record) {
  return sortedCountEntries(record.songs)
    .slice(0, 2)
    .map((entry) => entry.name);
}

function getArtistSongGroups(record) {
  if (!record._songGroups) record._songGroups = buildArtistSongGroups(record.occurrences);
  return record._songGroups;
}

function trendForRecord(mode, record) {
  if (!isLatestSnapshot() || state.rankMetric !== "occurrences") return null;
  const diff = state.rankDiffs?.[state.range]?.[mode];
  if (!(diff instanceof Map)) return null;
  return diff.get(record.key) || null;
}

function renderTrendBadge(trend) {
  if (!trend) return null;
  const badge = document.createElement("span");
  badge.className = "trend-badge";
  if (trend.isNew) {
    badge.classList.add("trend-new");
    badge.textContent = "新上榜";
    badge.title = "本期新进入榜单";
    return badge;
  }

  const rankDelta = Number(trend.rankDelta) || 0;
  const countDelta = Number(trend.countDelta) || 0;
  if (rankDelta > 0) {
    badge.classList.add("trend-up");
    badge.textContent = `升 ${rankDelta}`;
    badge.title = countDelta ? `排名上升 ${rankDelta}，收录 ${formatSignedDelta(countDelta)}` : `排名上升 ${rankDelta}`;
  } else if (rankDelta < 0) {
    badge.classList.add("trend-down");
    badge.textContent = `降 ${Math.abs(rankDelta)}`;
    badge.title = countDelta ? `排名下降 ${Math.abs(rankDelta)}，收录 ${formatSignedDelta(countDelta)}` : `排名下降 ${Math.abs(rankDelta)}`;
  } else if (countDelta) {
    badge.classList.add(countDelta > 0 ? "trend-up" : "trend-down");
    badge.textContent = `收录 ${formatSignedDelta(countDelta)}`;
    badge.title = `收录变化 ${formatSignedDelta(countDelta)}`;
  } else {
    return null;
  }
  return badge;
}

function formatSignedDelta(value) {
  const delta = Number(value) || 0;
  return delta > 0 ? `+${delta}` : String(delta);
}

async function copyVideoSetlist(item) {
  const text = window.FrontendUtils.buildSetlistText(item, {
    isUnknownArtistName: window.RankingUtils.isUnknownArtistName,
  });
  if (!text) {
    showToast("这场视频没有可复制的歌单");
    return;
  }
  await writeClipboardText(text);
  const count = text.split("\n").filter(Boolean).length;
  showToast(`已复制整场歌单 · ${count}首`);
}

async function copySongSourceLinks(occurrences) {
  const text = window.FrontendUtils.buildSongSourceLinksText(occurrences);
  if (!text) {
    showToast("当前歌曲没有可复制的来源链接");
    return;
  }
  await writeClipboardText(text);
  const count = text.split("\n").filter(Boolean).length;
  showToast(`已复制 ${count} 个来源链接`);
}

async function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (copyWithHiddenTextarea(text)) return;
  showManualCopyTextarea(text);
  throw new Error("需要手动复制");
}

function copyWithHiddenTextarea(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "readonly");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.append(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

function showManualCopyTextarea(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.className = "manual-copy-textarea";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
}

function capturedDate() {
  return formatDate(state.payload?.capturedAt || state.payload?.generatedAt);
}

function isLatestSnapshot() {
  return state.currentSnapshotPath === SNAPSHOT_LATEST_PATH;
}

function snapshotDateLabel(entry) {
  const parts = dateParts(entry.capturedAt || entry.generatedAt || entry.id);
  if (!parts) return "未知日期";
  return `${parts.month}月${parts.day}日`;
}

function snapshotOptionLabel(entry) {
  const parts = dateParts(entry.capturedAt || entry.generatedAt || entry.id);
  const counts = entry.itemCounts || {};
  const time = parts ? `${parts.hour}:${parts.minute}` : "未知时间";
  const h72 = Number.isFinite(Number(counts["72h"])) ? Number(counts["72h"]) : 0;
  const month = Number.isFinite(Number(counts["1m"])) ? Number(counts["1m"]) : 0;
  return `${time} · 72H ${h72} · 月度 ${month}`;
}

function formatRank(rank) {
  return String(rank).padStart(2, "0");
}

function makeSongSortKey(value) {
  const normalized = romanizeJapaneseKana(cleanText(value))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
  const key = normalized
    .replace(/^[\s"'`.,:;!?()[\]{}<>「」『』【】]+/u, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
  return key || normalizeSearch(value);
}

function romanizeJapaneseKana(value) {
  const normalized = String(value ?? "").normalize("NFKC");
  let result = "";
  let doubleNext = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = toHiragana(normalized[index]);

    if (char === "っ") {
      doubleNext = true;
      continue;
    }

    if (char === "ー") {
      result += lastVowel(result);
      doubleNext = false;
      continue;
    }

    const next = toHiragana(normalized[index + 1] || "");
    const pair = char + next;
    let romanized = KANA_DIGRAPHS[pair];
    if (romanized) {
      index += 1;
    } else {
      romanized = KANA_ROMAJI[char];
    }

    if (romanized) {
      if (doubleNext) result += firstConsonant(romanized);
      result += romanized;
      doubleNext = false;
      continue;
    }

    result += char;
    doubleNext = false;
  }

  return result;
}

function toHiragana(char) {
  const code = char.charCodeAt(0);
  if (code >= 0x30a1 && code <= 0x30f6) return String.fromCharCode(code - 0x60);
  return char;
}

function firstMeaningfulChar(value) {
  const match = cleanText(value).normalize("NFKC").match(/[\p{Letter}\p{Number}]/u);
  return match ? match[0] : "";
}

function firstConsonant(value) {
  const match = value.match(/^[bcdfghjklmnpqrstvwxyz]/);
  return match ? match[0] : "";
}

function lastVowel(value) {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if ("aeiou".includes(value[index])) return value[index];
  }
  return "";
}

function youtubeTimeUrl(videoId, seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${safeSeconds}s`;
}

function videoThumbnailCandidates(item) {
  const videoId = item.videoId ? encodeURIComponent(item.videoId) : "";
  return uniqueStrings([
    item.thumbnailUrl,
    videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "",
    videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : "",
    placeholderThumbnail(),
  ]);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function formatSeconds(value) {
  const total = Math.max(0, Number(value) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDate(value) {
  const parts = dateParts(value);
  if (!parts) return value ? String(value) : "未知";
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function dateParts(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});
  return {
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeEntityKey(value) {
  return cleanText(value).normalize("NFKC").toLocaleLowerCase();
}

function normalizeSearch(value) {
  return window.FrontendUtils.normalizeSearch(value);
}

function makeDomId(value) {
  const normalized = normalizeEntityKey(value)
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `item-${Math.random().toString(36).slice(2)}`;
}

function placeholderThumbnail() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
      <rect width="640" height="360" fill="#E4E7EC"/>
      <rect x="282" y="142" width="76" height="76" rx="38" fill="#98A2B3"/>
      <path d="M310 164v32l28-16z" fill="#fff"/>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}
