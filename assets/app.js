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
const QUERY_PREVIEW_INPUT_DEBOUNCE_MS = 520;
const QUERY_SUGGESTION_SCAN_LIMIT = 1200;
const ARTIST_SONG_GROUP_INITIAL_LIMIT = 8;
const ARTIST_SONG_GROUP_BATCH_SIZE = 8;
const SOURCE_TIMESTAMP_INITIAL_LIMIT = 1;
const SOURCE_INLINE_LIMIT = 3;
const SOURCE_EXPAND_CHUNK_SIZE = 12;
const MAX_COMPACT_INITIALIZED_DRAWERS = 3;
// Keep these breakpoints synchronized with assets/styles.css:
// mobile <= 720px, tablet 721-919px, desktop >= 920px.
const RESPONSIVE_BREAKPOINTS = {
  mobileMax: 720,
  tabletMax: 919,
};
const SOURCE_GROUP_LIMITS = {
  mobile: { initial: 3 },
  tablet: { initial: 6 },
  desktop: { initial: 9 },
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
const DISPLAY_TIME_ZONE = "Asia/Shanghai";
const STATUS_STALE_MINUTES = 120;
const STATUS_STALE_MS = STATUS_STALE_MINUTES * 60 * 1000;
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
  rangePrefetchTimer: 0,
  rangeCache: new Map(),
  latestRangeLoadError: null,
  statusRefreshTimer: null,
  statusSummary: null,
  songSearchIndexPromise: null,
  songSearchLookup: window.FrontendUtils.createSongSearchLookup(null),
  sourceFilterPromise: null,
  rankDiffs: {},
  rankDiffLoads: new Map(),
  loadedResources: [],
  compactDrawerLru: [],
  firstContentMeasured: false,
  eventsBound: false,
  activeOverlay: "",
  overlayTrigger: null,
  queryDraft: null,
  queryPreviewTimer: 0,
  querySuggestionTimer: 0,
  queryWorkRevision: 0,
  queryComposing: false,
  currentResultSummary: null,
  sharedUrlApplied: false,
  responsiveMode: "",
  resizeRenderFrame: 0,
};

const els = {
  controls: document.querySelector("#controls"),
  status: document.querySelector("#status"),
  statusAlerts: document.querySelector("#statusAlerts"),
  activeQueryStrip: document.querySelector("#activeQueryStrip"),
  summary: document.querySelector("#summary"),
  content: document.querySelector("#videoList"),
  queryTrigger: document.querySelector("#queryTrigger"),
  queryTriggerText: document.querySelector("#queryTriggerText"),
  queryCountBadge: document.querySelector("#queryCountBadge"),
  queryDialog: document.querySelector("#queryDialog"),
  queryPanel: document.querySelector("#queryDialog .query-panel"),
  queryInput: document.querySelector("#queryInput"),
  nicheOnlyToggle: document.querySelector("#nicheOnlyToggle"),
  hideUnknownToggle: document.querySelector("#hideUnknownToggle"),
  cancelQueryButton: document.querySelector("#cancelQueryButton"),
  clearQueryButton: document.querySelector("#clearQueryButton"),
  clearRecentSearchesButton: document.querySelector("#clearRecentSearchesButton"),
  recentSearches: document.querySelector("#recentSearches"),
  recentSearchSection: document.querySelector("#recentSearchSection"),
  searchSuggestions: document.querySelector("#searchSuggestions"),
  applyQueryButton: document.querySelector("#applyQueryButton"),
  resetQueryButton: document.querySelector("#resetQueryButton"),
  queryResultPreview: document.querySelector("#queryResultPreview"),
  queryTabButtons: Array.from(document.querySelectorAll("[data-query-panel-tab]")),
  queryTabPanels: Array.from(document.querySelectorAll(".query-tab-panel")),
  metricFilterGroup: document.querySelector("#metricFilterGroup"),
  displayFilterGroup: document.querySelector("#displayFilterGroup"),
  trendFilterGroup: document.querySelector("#trendFilterGroup"),
  trendFilterSelect: document.querySelector("#trendFilterSelect"),
  trendFilterHint: document.querySelector("#trendFilterHint"),
  minCountSelect: document.querySelector("#minCountSelect"),
  queryPageSizeSelect: document.querySelector("#queryPageSizeSelect"),
  querySnapshotDateSelect: document.querySelector("#querySnapshotDateSelect"),
  querySnapshotSelect: document.querySelector("#querySnapshotSelect"),
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
    bindRangeIntentPrefetch(tab);
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

  bindQueryOverlayEvents();

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

  els.activeQueryStrip?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-query-clear]");
    if (!button) return;
    clearQueryCondition(button.dataset.queryClear || "");
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
      applyQueryPatch({ q: "" }, { focusTrigger: true });
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
      if (sourceToggle.closest(".artist-song-group")) {
        toggleArtistSongSource(sourceToggle);
        return;
      }
      toggleSourceDrawer(sourceToggle.closest(".rank-row, .index-row"));
    }
  });

  els.content.addEventListener("change", (event) => {
    const bucketSelect = event.target.closest("[data-index-bucket-select]");
    if (bucketSelect) {
      state.indexBucket = bucketSelect.value || INDEX_ALL_BUCKET;
      state.expandedRows.clear();
      resetPagination();
      render({ focusAfterPageChange: true, urlMode: "push" });
      return;
    }

    const select = event.target.closest("[data-page-select]");
    if (!select) return;
    const page = Number.parseInt(select.value || "1", 10);
    setPage(page);
    render({ focusAfterPageChange: true, urlMode: "push" });
  });

  els.content.addEventListener("click", (event) => {
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

    const artistSongSource = event.target.closest("[data-toggle-artist-song-source]");
    if (artistSongSource) {
      event.preventDefault();
      toggleArtistSongSource(artistSongSource);
      return;
    }

    const sourceGroups = event.target.closest("[data-toggle-source-groups]");
    if (sourceGroups) {
      event.preventDefault();
      expandSourceVideoGroups(sourceGroups).catch((error) => showToast(`展开来源失败：${error.message}`));
    }
  });

  window.addEventListener("popstate", () => {
    restoreStateFromUrl();
  });

  window.addEventListener("resize", handleResponsiveResize, { passive: true });
  window.addEventListener("scroll", updateQueryAnchorPosition, { passive: true });
  window.visualViewport?.addEventListener("resize", handleResponsiveResize, { passive: true });
  window.visualViewport?.addEventListener("scroll", () => {
    updateViewportVars();
    updateQueryAnchorPosition();
  }, { passive: true });
  updateViewportVars();
  state.responsiveMode = getResponsiveMode();
}

function bindRangeIntentPrefetch(tab) {
  const prefetch = () => prefetchRuntimeRangeOnIntent(tab.dataset.range);
  for (const eventName of ["pointerdown", "touchstart", "mousedown", "focus"]) {
    tab.addEventListener(eventName, prefetch, { passive: true });
  }
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

function bindQueryOverlayEvents() {
  els.queryTrigger?.addEventListener("click", () => openQueryOverlay(els.queryTrigger));
  els.cancelQueryButton?.addEventListener("click", () => closeOverlay("query"));
  els.queryDialog?.querySelector("[data-close-overlay='query']")?.addEventListener("click", () => closeOverlay("query"));
  els.clearQueryButton?.addEventListener("click", () => {
    updateQueryDraft({ q: "" }, { sync: "input" });
    if (els.queryInput) els.queryInput.focus();
  });
  els.clearRecentSearchesButton?.addEventListener("click", () => {
    writeRecentSearches([]);
    renderRecentSearches();
  });
  for (const tab of els.queryTabButtons) {
    tab.addEventListener("click", () => setQueryPanelTab(tab.dataset.queryPanelTab || "search", { focusTab: true }));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tabs = els.queryTabButtons;
      const index = tabs.indexOf(tab);
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : event.key === "ArrowLeft"
              ? Math.max(0, index - 1)
              : Math.min(tabs.length - 1, index + 1);
      const next = tabs[nextIndex];
      if (next) setQueryPanelTab(next.dataset.queryPanelTab || "search", { focusTab: true });
    });
  }
  els.queryInput?.addEventListener("compositionstart", () => {
    state.queryComposing = true;
  });
  els.queryInput?.addEventListener("compositionend", () => {
    state.queryComposing = false;
    setQueryPanelTab("search");
    updateQueryDraft({ q: els.queryInput.value }, { sync: "input" });
  });
  els.queryInput?.addEventListener("input", (event) => {
    setQueryPanelTab("search");
    updateQueryDraft({ q: els.queryInput.value }, {
      sync: "input",
      schedule: !(event.isComposing || state.queryComposing),
    });
  });
  els.queryInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      if (event.isComposing || state.queryComposing) return;
      event.preventDefault();
      applyQueryDraft().catch((error) => showToast(`查询应用失败：${error.message}`));
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeOverlay("query");
    }
  });
  els.searchSuggestions?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-search-value]");
    if (!button) return;
    updateQueryDraft({ q: button.dataset.searchValue || button.textContent || "" }, { sync: "input" });
    els.queryInput?.focus();
  });
  els.recentSearches?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-search-value]");
    if (!button) return;
    updateQueryDraft({ q: button.dataset.searchValue || button.textContent || "" }, { sync: "input" });
    els.queryInput?.focus();
  });
  for (const element of [
    els.nicheOnlyToggle,
    els.hideUnknownToggle,
    els.trendFilterSelect,
    els.minCountSelect,
    els.queryPageSizeSelect,
    els.querySnapshotSelect,
  ]) {
    element?.addEventListener("change", () => {
      setQueryPanelTab("filter");
      setQueryDraft(readQueryDraftFromControls(), { sync: "controls" });
    });
  }
  document.querySelectorAll("input[name='queryMetric']").forEach((input) => {
    input.addEventListener("change", () => {
      setQueryPanelTab("filter");
      setQueryDraft(readQueryDraftFromControls(), { sync: "controls" });
    });
  });
  els.querySnapshotDateSelect?.addEventListener("change", () => {
    const path = firstSnapshotPathForDate(els.querySnapshotDateSelect.value);
    updateQueryDraft({ snapshotPath: path }, { sync: "snapshot" });
  });
  els.resetQueryButton?.addEventListener("click", () => {
    setQueryPanelTab("search");
    setQueryDraft(defaultQueryDraft(), { sync: "full" });
  });
  els.applyQueryButton?.addEventListener("click", () => {
    applyQueryDraft().catch((error) => showToast(`查询应用失败：${error.message}`));
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

function openQueryOverlay(trigger) {
  const openMark = perfMark("query-open:start");
  state.overlayTrigger = trigger || document.activeElement;
  state.queryDraft = makeQueryDraftFromState();
  const revision = advanceQueryWorkRevision();
  state.activeOverlay = "query";
  setDialogOpen(els.queryDialog, true);
  setPageInert(true);
  setQueryPanelTab("search");
  syncQueryControlsFromDraft(state.queryDraft, { light: true, forceSnapshot: false });
  prepareQuerySearchShell(state.queryDraft);
  prepareQueryPreviewShell(state.queryDraft);
  perfMeasure("query-open-visible", openMark);
  window.requestAnimationFrame(() => {
    if (!isCurrentQueryWork(revision)) return;
    updateQueryAnchorPosition();
    focusWithoutScrolling(els.queryInput || els.queryPanel || els.queryDialog);
    window.setTimeout(() => hydrateQueryOverlayAfterFirstFrame(revision), 0);
  });
}

function closeOverlay(kind) {
  if (kind && state.activeOverlay !== kind) return;
  const overlay = state.activeOverlay;
  if (!overlay) return;
  setDialogOpen(els.queryDialog, false);
  state.activeOverlay = "";
  state.queryDraft = null;
  window.clearTimeout(state.queryPreviewTimer);
  state.queryPreviewTimer = 0;
  window.clearTimeout(state.querySuggestionTimer);
  state.querySuggestionTimer = 0;
  state.queryComposing = false;
  advanceQueryWorkRevision();
  setPageInert(false);
  const trigger = state.overlayTrigger;
  state.overlayTrigger = null;
  if (trigger && document.contains(trigger)) focusWithoutScrolling(trigger);
}

function advanceQueryWorkRevision() {
  state.queryWorkRevision += 1;
  return state.queryWorkRevision;
}

function isCurrentQueryWork(revision) {
  return state.activeOverlay === "query" && revision === state.queryWorkRevision;
}

function hydrateQueryOverlayAfterFirstFrame(revision) {
  if (!isCurrentQueryWork(revision)) return;
  renderRecentSearches();
  scheduleSearchSuggestions({ revision });
  scheduleQueryDraftPreview({ revision });
}

function setDialogOpen(dialog, isOpen) {
  if (!dialog) return;
  dialog.hidden = !isOpen;
  document.body.classList.toggle("is-modal-open", isOpen);
}

function setPageInert(isInert) {
  for (const element of [document.querySelector(".layout"), els.mobileBottomNav, els.backToTop]) {
    if (!element) continue;
    if ("inert" in element) element.inert = isInert;
    element.setAttribute("aria-hidden", isInert ? "true" : "false");
  }
}

function activeModalElement() {
  if (state.activeOverlay === "query") return els.queryDialog;
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

function renderRecentSearches() {
  if (!els.recentSearches || !els.recentSearchSection) return;
  const recent = readRecentSearches();
  els.recentSearchSection.hidden = Boolean(state.queryDraft?.q?.trim()) || !recent.length;
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

function prepareQuerySearchShell(draft) {
  const hasQuery = Boolean(String(draft?.q || "").trim());
  const suggestionsSection = els.searchSuggestions?.closest(".suggestions-section");
  if (suggestionsSection) suggestionsSection.hidden = !hasQuery;
  if (els.recentSearchSection) els.recentSearchSection.hidden = hasQuery;
  if (!els.searchSuggestions) return;
  els.searchSuggestions.replaceChildren();
  if (hasQuery) {
    const pending = document.createElement("p");
    pending.className = "suggestion-empty";
    pending.textContent = "正在匹配建议";
    els.searchSuggestions.append(pending);
  }
}

function scheduleSearchSuggestions(options = {}) {
  window.clearTimeout(state.querySuggestionTimer);
  const draft = sanitizeQueryDraft(state.queryDraft || makeQueryDraftFromState());
  const revision = options.revision || advanceQueryWorkRevision();
  const hasQuery = Boolean(String(draft.q || "").trim());
  if (!hasQuery) {
    renderSearchSuggestions("", draft);
    return;
  }
  if (els.searchSuggestions && !els.searchSuggestions.childElementCount) prepareQuerySearchShell(draft);
  state.querySuggestionTimer = window.setTimeout(() => {
    if (!isCurrentQueryWork(revision)) return;
    renderSearchSuggestions(draft.q, draft);
  }, options.immediate ? 0 : SEARCH_DEBOUNCE_MS);
}

function renderSearchSuggestions(query, draft = state.queryDraft || makeQueryDraftFromState()) {
  if (!els.searchSuggestions) return;
  const hasQuery = Boolean(String(query || "").trim());
  const suggestionsSection = els.searchSuggestions.closest(".suggestions-section");
  if (suggestionsSection) suggestionsSection.hidden = !hasQuery;
  if (els.recentSearchSection) els.recentSearchSection.hidden = hasQuery || !readRecentSearches().length;
  els.searchSuggestions.replaceChildren();
  if (!hasQuery) return;
  const suggestions = measureSync("search-suggest", () => buildSearchSuggestions(query, draft));
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

function setQueryPanelTab(tabName = "search", options = {}) {
  const targetName = tabName === "filter" ? "filter" : "search";
  for (const tab of els.queryTabButtons) {
    const active = (tab.dataset.queryPanelTab || "search") === targetName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
    if (active && options.focusTab) focusWithoutScrolling(tab);
  }
  for (const panel of els.queryTabPanels) {
    const active = panel.id === (targetName === "filter" ? "queryFilterPanel" : "querySearchPanel");
    panel.hidden = !active;
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

function buildSearchSuggestions(query, draft = state.queryDraft || makeQueryDraftFromState()) {
  const filterKey = normalizeSearch(query);
  if (!filterKey || !state.payload) return [];
  const rangeCache = getRangeCache(currentGroup());
  const key = queryIndexKey(draft);
  const index = rangeCache.queryIndexes.get(key) || buildFastSearchSuggestionIndex(filterKey, rangeCache, draft);
  const songSuggestions = index.songs
    .filter((entry) => entry.normalizedText.includes(filterKey))
    .slice(0, 5)
    .map((entry) => ({
      label: entry.label,
      value: entry.value,
      meta: entry.meta,
    }));

  const artistSuggestions = index.artists
    .filter((entry) => entry.normalizedText.includes(filterKey))
    .slice(0, 3)
    .map((entry) => ({
      label: entry.label,
      value: entry.value,
      meta: entry.meta,
    }));

  const channelSuggestions = index.channels
    .filter((entry) => entry.normalizedText.includes(filterKey))
    .slice(0, 3)
    .map((entry) => ({
      label: entry.label,
      value: entry.value,
      meta: entry.meta,
    }));

  return [
    { label: "歌曲", items: songSuggestions },
    { label: "歌手", items: artistSuggestions },
    { label: "频道", items: channelSuggestions },
  ];
}

function buildFastSearchSuggestionIndex(filterKey, rangeCache, draft) {
  const occurrences = queryDraftBaseOccurrences(rangeCache, draft);
  const songs = [];
  const artists = [];
  const channels = [];
  const seenSongs = new Set();
  const seenArtists = new Set();
  const seenChannels = new Set();
  const maxScan = Math.min(occurrences.length, QUERY_SUGGESTION_SCAN_LIMIT);
  for (let index = 0; index < maxScan; index += 1) {
    const occurrence = occurrences[index];
    const song = occurrence?.song || {};
    const item = occurrence?.item || {};
    const title = cleanText(song.title || "");
    const artist = cleanText(song.artist || "");
    const channel = cleanText(item.channelName || "");
    if (title && songs.length < 5) {
      const normalizedText = normalizeSearch([title, artist].join(" "));
      const key = normalizeEntityKey([title, artist].join("\n"));
      if (normalizedText.includes(filterKey) && !seenSongs.has(key)) {
        seenSongs.add(key);
        songs.push({
          label: title,
          value: title,
          meta: window.RankingUtils.isUnknownArtistName(artist) ? "" : artist,
          normalizedText,
        });
      }
    }
    if (artist && artists.length < 3 && !window.RankingUtils.isUnknownArtistName(artist)) {
      const normalizedText = normalizeSearch(artist);
      const key = normalizeEntityKey(artist);
      if (normalizedText.includes(filterKey) && !seenArtists.has(key)) {
        seenArtists.add(key);
        artists.push({
          label: artist,
          value: artist,
          meta: "歌手",
          normalizedText,
        });
      }
    }
    if (channel && channels.length < 3) {
      const normalizedText = normalizeSearch(channel);
      const key = normalizeEntityKey(channel);
      if (normalizedText.includes(filterKey) && !seenChannels.has(key)) {
        seenChannels.add(key);
        channels.push({
          label: channel,
          value: channel,
          meta: "频道",
          normalizedText,
        });
      }
    }
    if (songs.length >= 5 && artists.length >= 3 && channels.length >= 3) break;
    if (songs.length >= 5 && index >= 480 && (artists.length || channels.length)) break;
  }
  return { songs, artists, channels };
}

function prewarmQueryIndexForDraft(draft, options = {}) {
  if (!state.payload || !draft) return;
  const rangeCache = getRangeCache(currentGroup());
  const key = queryIndexKey(draft);
  if (rangeCache.queryIndexes.has(key) || rangeCache.queryIndexLoads.has(key)) return;
  const run = () => {
    if (options.revision && !isCurrentQueryWork(options.revision)) return;
    try {
      getQueryIndex(rangeCache, draft);
    } finally {
      rangeCache.queryIndexLoads.delete(key);
    }
  };
  const load = Promise.resolve().then(() => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 600 });
    } else {
      window.setTimeout(run, 0);
    }
  });
  rangeCache.queryIndexLoads.set(key, load);
}

function getQueryIndex(rangeCache, draft) {
  const key = queryIndexKey(draft);
  if (rangeCache.queryIndexes.has(key)) return rangeCache.queryIndexes.get(key);
  const occurrences = queryDraftBaseOccurrences(rangeCache, draft);
  const songRecords = queryDraftSongRecords(rangeCache, { ...draft, q: "" }, occurrences);
  const artistRecords = queryDraftArtistRecords(rangeCache, { ...draft, q: "" }, occurrences);
  const channelMap = new Map();
  for (const occurrence of occurrences) {
    const channel = cleanText(occurrence?.item?.channelName || "");
    if (!channel) continue;
    channelMap.set(channel, (channelMap.get(channel) || 0) + 1);
  }
  const index = {
    songs: songRecords.map((record) => {
      const meta = songMeta(record).primary;
      return {
        label: record.title,
        value: record.title,
        meta,
        normalizedText: normalizeSearch([record.title, meta].join(" ")),
      };
    }),
    artists: artistRecords
      .filter((record) => !draft.hideUnknownArtist || !window.RankingUtils.isUnknownArtistName(record.name))
      .map((record) => ({
        label: record.name,
        value: record.name,
        meta: `${record.count}次`,
        normalizedText: normalizeSearch(record.name),
      })),
    channels: Array.from(channelMap.entries())
      .sort((a, b) => b[1] - a[1] || compareValues(a[0], b[0]))
      .map(([channel, count]) => ({
        label: channel,
        value: channel,
        meta: `${count}次`,
        normalizedText: normalizeSearch(channel),
      })),
  };
  rangeCache.queryIndexes.set(key, index);
  return index;
}

function queryIndexKey(draft) {
  return `query-index::${draft.nicheOnly ? "niche" : "all"}::${queryDraftHideUnknownForView(draft) ? "hide-unknown" : "show-unknown"}::${state.view}`;
}

function queryDraftOptions(extra = {}) {
  return {
    defaults: {
      pageSize: DEFAULT_LIST_PAGE_SIZE,
      snapshotPath: SNAPSHOT_LATEST_PATH,
    },
    validRankMetrics: Object.keys(RANK_METRICS),
    validTrendFilters: Object.keys(TREND_FILTERS),
    validMinCounts: MIN_COUNT_OPTIONS,
    validPageSizes: LIST_PAGE_SIZE_OPTIONS,
    latestSnapshotPath: SNAPSHOT_LATEST_PATH,
    snapshots: state.snapshots,
    ...extra,
  };
}

function makeQueryDraftFromState() {
  return window.FrontendUtils.makeQueryDraftFromState(state, queryDraftOptions());
}

function defaultQueryDraft() {
  return window.FrontendUtils.defaultQueryDraft({
    pageSize: DEFAULT_LIST_PAGE_SIZE,
    snapshotPath: SNAPSHOT_LATEST_PATH,
  });
}

function sanitizeQueryDraft(draft) {
  return window.FrontendUtils.sanitizeQueryDraft(draft, queryDraftOptions());
}

function syncQueryControlsFromDraft(draft, options = {}) {
  return syncQueryPanelFromDraft(draft, {
    ...options,
    syncMode: options.light ? "light" : options.syncMode || "full",
  });
}

function syncQueryPanelFromDraft(draft, options = {}) {
  if (!draft) return null;
  const next = sanitizeQueryDraft(draft);
  const previous = options.previousDraft || state.queryDraft;
  state.queryDraft = next;
  syncQueryInputValue(next);
  syncQueryClearButton(next);
  if (options.syncMode === "input") return next;
  syncQueryToggleValues(next);
  syncQuerySelectValues(next);
  syncQuerySnapshotControls(next, previous, options);
  updateQueryAvailability(next);
  return next;
}

function syncQueryInputValue(draft) {
  if (els.queryInput && els.queryInput.value !== draft.q) els.queryInput.value = draft.q;
}

function syncQueryToggleValues(draft) {
  if (els.nicheOnlyToggle) els.nicheOnlyToggle.checked = Boolean(draft.nicheOnly);
  if (els.hideUnknownToggle) els.hideUnknownToggle.checked = Boolean(draft.hideUnknownArtist);
  for (const input of document.querySelectorAll("input[name='queryMetric']")) {
    input.checked = input.value === draft.rankMetric;
  }
}

function syncQuerySelectValues(draft) {
  if (els.trendFilterSelect) els.trendFilterSelect.value = draft.trend;
  if (els.minCountSelect) els.minCountSelect.value = String(draft.minCount);
  if (els.queryPageSizeSelect) els.queryPageSizeSelect.value = String(draft.pageSize);
}

function syncQuerySnapshotControls(draft, previousDraft = null, options = {}) {
  const dateValue = snapshotDateValueForPath(draft.snapshotPath);
  if (els.querySnapshotDateSelect && els.querySnapshotDateSelect.value !== dateValue) {
    els.querySnapshotDateSelect.value = dateValue;
  }
  const previousDateValue = previousDraft ? snapshotDateValueForPath(previousDraft.snapshotPath) : "";
  const mustRebuild =
    options.forceSnapshot === true ||
    !els.querySnapshotSelect?.options?.length ||
    previousDateValue !== dateValue ||
    (els.querySnapshotSelect && !Array.from(els.querySnapshotSelect.options).some((option) => option.value === draft.snapshotPath));
  if (mustRebuild) {
    syncDraftSnapshotTimes(dateValue, draft.snapshotPath);
  } else if (els.querySnapshotSelect && els.querySnapshotSelect.value !== draft.snapshotPath) {
    els.querySnapshotSelect.value = draft.snapshotPath;
  }
}

function syncQueryClearButton(draft) {
  if (!els.clearQueryButton) return;
  const hasQuery = Boolean(String(draft?.q || "").trim());
  els.clearQueryButton.hidden = !hasQuery;
  els.clearQueryButton.tabIndex = hasQuery ? 0 : -1;
}

function syncDraftSnapshotTimes(dateValue, selectedPath = "") {
  if (!els.querySnapshotSelect) return;
  els.querySnapshotSelect.replaceChildren();
  if (dateValue === "latest") {
    const option = document.createElement("option");
    option.value = SNAPSHOT_LATEST_PATH;
    option.textContent = "最新快照";
    els.querySnapshotSelect.append(option);
    els.querySnapshotSelect.value = SNAPSHOT_LATEST_PATH;
    return;
  }
  for (const entry of snapshotEntriesForDate(dateValue)) {
    const option = document.createElement("option");
    option.value = entry.path;
    option.textContent = snapshotOptionLabel(entry);
    els.querySnapshotSelect.append(option);
  }
  els.querySnapshotSelect.value = selectedPath || firstSnapshotPathForDate(dateValue);
}

function readQueryDraftFromControls() {
  const selectedMetric = document.querySelector("input[name='queryMetric']:checked")?.value || "occurrences";
  return sanitizeQueryDraft({
    q: els.queryInput?.value || "",
    nicheOnly: Boolean(els.nicheOnlyToggle?.checked),
    hideUnknownArtist: Boolean(els.hideUnknownToggle?.checked),
    rankMetric: Object.hasOwn(RANK_METRICS, selectedMetric) ? selectedMetric : "occurrences",
    trend: Object.hasOwn(TREND_FILTERS, els.trendFilterSelect?.value) ? els.trendFilterSelect.value : "all",
    minCount: MIN_COUNT_OPTIONS.includes(Number(els.minCountSelect?.value)) ? Number(els.minCountSelect.value) : 1,
    pageSize: LIST_PAGE_SIZE_OPTIONS.includes(Number(els.queryPageSizeSelect?.value)) ? Number(els.queryPageSizeSelect.value) : DEFAULT_LIST_PAGE_SIZE,
    snapshotPath: els.querySnapshotSelect?.value || SNAPSHOT_LATEST_PATH,
  });
}

async function applyQueryDraft() {
  const draft = readQueryDraftFromControls();
  const previousPath = state.currentSnapshotPath;
  closeOverlay("query");
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
  if (draft.q) writeRecentSearches([draft.q, ...readRecentSearches().filter((item) => item !== draft.q)].slice(0, 10));
  if (previousPath !== draft.snapshotPath) {
    await applySnapshotPath(draft.snapshotPath, previousPath, { urlMode: "push" });
    return;
  }
  measureSync("query-apply", () => render({ urlMode: "push" }));
}

function updateQueryDraft(patch, options = {}) {
  return setQueryDraft(
    {
      ...(state.queryDraft || makeQueryDraftFromState()),
      ...patch,
    },
    options,
  );
}

function setQueryDraft(draft, options = {}) {
  const previousDraft = state.queryDraft || makeQueryDraftFromState();
  const nextDraft = sanitizeQueryDraft(draft);
  const revision = advanceQueryWorkRevision();
  const syncMode = options.sync || "full";
  syncQueryPanelFromDraft(nextDraft, {
    previousDraft,
    syncMode,
    forceSnapshot: syncMode === "snapshot" || syncMode === "full",
  });
  if (options.schedule === false || state.queryComposing) return nextDraft;
  scheduleSearchSuggestions({ revision });
  scheduleQueryDraftPreview({
    revision,
    delay: syncMode === "input" ? QUERY_PREVIEW_INPUT_DEBOUNCE_MS : SEARCH_DEBOUNCE_MS,
  });
  if (syncMode !== "input") prewarmQueryIndexForDraft(nextDraft, { revision });
  return nextDraft;
}

function applyQueryPatch(patch, options = {}) {
  const draft = sanitizeQueryDraft({
    ...makeQueryDraftFromState(),
    ...patch,
  });
  const previousPath = state.currentSnapshotPath;
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
  const afterRender = () => {
    if (options.focusTrigger) focusWithoutScrolling(els.queryTrigger || els.controls || document.body);
  };
  if (previousPath !== draft.snapshotPath) {
    applySnapshotPath(draft.snapshotPath, previousPath, { urlMode: "push" }).then(afterRender).catch((error) => showToast(`查询应用失败：${error.message}`));
    return;
  }
  render({ urlMode: "push" });
  afterRender();
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

function updateQueryAvailability(draft = state.queryDraft || makeQueryDraftFromState()) {
  const rankView = state.view === "songRank" || state.view === "artistRank";
  if (els.metricFilterGroup) els.metricFilterGroup.hidden = state.view === "videos";
  if (els.displayFilterGroup) els.displayFilterGroup.hidden = state.view === "videos";
  if (els.trendFilterGroup) els.trendFilterGroup.hidden = state.view === "songAz" || state.view === "videos";
  if (els.minCountSelect?.closest(".query-field")) els.minCountSelect.closest(".query-field").hidden = state.view === "videos";
  if (els.trendFilterSelect) {
    const isLatestDraft = draft.snapshotPath === SNAPSHOT_LATEST_PATH;
    const disabled = !rankView || !isLatestDraft || state.rankDiffLoads.has(state.range) || state.rankDiffs[state.range] === null;
    els.trendFilterSelect.disabled = disabled;
    if (els.trendFilterHint) {
      els.trendFilterHint.textContent = !isLatestDraft
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
  return window.FrontendUtils.activeQueryConditionCount(makeQueryDraftFromState(), {
    ...queryDraftOptions(),
    view: state.view,
  });
}

function syncQueryTriggerState() {
  const draft = makeQueryDraftFromState();
  const items = activeQueryItems(draft);
  const count = items.length;
  if (els.queryCountBadge) {
    els.queryCountBadge.hidden = count <= 0;
    els.queryCountBadge.textContent = count > 0 ? String(count) : "";
    els.queryCountBadge.setAttribute("aria-label", `当前有 ${count} 个搜索与筛选条件`);
  }
  if (els.queryTriggerText) {
    els.queryTriggerText.textContent = state.filter || "搜索歌曲、歌手、频道或视频";
    els.queryTriggerText.title = state.filter || "";
  }
  if (els.queryTrigger) {
    els.queryTrigger.classList.toggle("has-active-query", count > 0);
    els.queryTrigger.dataset.activeQueryCount = String(count);
    const labels = items.map((item) => item.fullLabel || item.label).filter(Boolean);
    els.queryTrigger.setAttribute("aria-label", count > 0 ? `打开搜索与筛选，当前有 ${count} 个条件：${labels.join("、")}` : "打开搜索与筛选");
  }
}

function renderActiveQueryStrip() {
  if (!els.activeQueryStrip) return;
  const items = activeQueryItems(makeQueryDraftFromState());
  els.activeQueryStrip.replaceChildren();
  if (!items.length) {
    els.activeQueryStrip.hidden = true;
    return;
  }
  els.activeQueryStrip.hidden = false;
  for (const item of items) {
    const button = document.createElement("button");
    button.className = "active-query-chip";
    button.type = "button";
    button.dataset.queryClear = item.key;
    button.title = item.fullLabel || item.label;
    button.setAttribute("aria-label", `清除条件：${item.fullLabel || item.label}`);
    const text = document.createElement("span");
    text.textContent = item.label;
    const close = document.createElement("span");
    close.className = "active-query-chip-close";
    close.setAttribute("aria-hidden", "true");
    close.textContent = "×";
    button.append(text, close);
    els.activeQueryStrip.append(button);
  }
  const clearAll = document.createElement("button");
  clearAll.className = "active-query-clear";
  clearAll.type = "button";
  clearAll.dataset.queryClear = "all";
  clearAll.textContent = "清除全部";
  els.activeQueryStrip.append(clearAll);
}

function activeQueryItems(draft) {
  const items = [];
  if (draft.q) items.push({ key: "q", label: draft.q, fullLabel: draft.q });
  if (draft.nicheOnly) items.push({ key: "nicheOnly", label: "只看小众" });
  if (!draft.hideUnknownArtist) items.push({ key: "hideUnknownArtist", label: "显示无歌手" });
  if ((state.view === "songRank" || state.view === "artistRank") && draft.rankMetric !== "occurrences") items.push({ key: "rankMetric", label: "按视频" });
  if ((state.view === "songRank" || state.view === "artistRank") && draft.trend !== "all") items.push({ key: "trend", label: TREND_FILTERS[draft.trend] || "趋势" });
  if (state.view !== "videos" && draft.minCount > 1) items.push({ key: "minCount", label: `${draft.minCount}次以上` });
  if (draft.snapshotPath !== SNAPSHOT_LATEST_PATH) items.push({ key: "snapshotPath", label: `历史 ${snapshotDateOptionLabel(snapshotDateValueForPath(draft.snapshotPath))}` });
  return items;
}

function clearQueryCondition(key) {
  if (key === "all") {
    applyQueryPatch(defaultQueryDraft(), { focusTrigger: true });
    return;
  }
  const patch = {};
  if (key === "q") patch.q = "";
  else if (key === "nicheOnly") patch.nicheOnly = false;
  else if (key === "hideUnknownArtist") patch.hideUnknownArtist = true;
  else if (key === "rankMetric") patch.rankMetric = "occurrences";
  else if (key === "trend") patch.trend = "all";
  else if (key === "minCount") patch.minCount = 1;
  else if (key === "snapshotPath") patch.snapshotPath = SNAPSHOT_LATEST_PATH;
  applyQueryPatch(patch, { focusTrigger: true });
}

function scheduleQueryDraftPreview(options = {}) {
  window.clearTimeout(state.queryPreviewTimer);
  const draft = sanitizeQueryDraft(state.queryDraft || makeQueryDraftFromState());
  const revision = options.revision || advanceQueryWorkRevision();
  prepareQueryPreviewShell(draft);
  const delay = Number.isFinite(options.delay) ? options.delay : options.immediate ? 0 : SEARCH_DEBOUNCE_MS;
  state.queryPreviewTimer = window.setTimeout(() => {
    renderQueryDraftPreview(revision).catch((error) => {
      if (isCurrentQueryWork(revision)) {
        if (els.queryResultPreview) els.queryResultPreview.textContent = "计算失败";
        if (els.applyQueryButton) els.applyQueryButton.textContent = "应用查询";
      }
      console.warn("query preview failed", error);
    });
  }, delay);
}

function prepareQueryPreviewShell(draft) {
  if (!els.queryResultPreview || !els.applyQueryButton) return;
  if (draft.snapshotPath !== state.currentSnapshotPath) {
    els.queryResultPreview.textContent = "将载入快照";
    els.applyQueryButton.textContent = "应用并载入快照";
    return;
  }
  const cached = currentResultCountForDraft(draft);
  if (cached !== null) {
    const unit = queryResultUnit();
    els.queryResultPreview.textContent = `${cached} ${unit}`;
    els.applyQueryButton.textContent = `查看 ${cached} ${unit}`;
    return;
  }
  els.queryResultPreview.textContent = "计算中";
  els.applyQueryButton.textContent = "查看结果";
}

async function renderQueryDraftPreview(revision = state.queryWorkRevision) {
  const draft = sanitizeQueryDraft(state.queryDraft || readQueryDraftFromControls());
  if (!els.queryResultPreview || !els.applyQueryButton || !isCurrentQueryWork(revision)) return;
  if (draft.snapshotPath !== state.currentSnapshotPath) {
    els.queryResultPreview.textContent = "将载入快照";
    els.applyQueryButton.textContent = "应用并载入快照";
    return;
  }
  await yieldToBrowser();
  if (!isCurrentQueryWork(revision)) return;
  const count = queryDraftResultCount(draft);
  const unit = queryResultUnit();
  els.queryResultPreview.textContent = `${count} ${unit}`;
  els.applyQueryButton.textContent = `查看 ${count} ${unit}`;
}

function queryResultUnit() {
  if (state.view === "artistRank") return "位歌手";
  if (state.view === "videos") return "个视频";
  return "首歌曲";
}

function queryDraftResultCount(draft) {
  if (!state.payload) return 0;
  const rangeCache = getRangeCache(currentGroup());
  const cachedCurrent = currentResultCountForDraft(draft);
  if (cachedCurrent !== null) return cachedCurrent;
  const cacheKey = queryResultCountKey(draft);
  if (rangeCache.queryResultCountCache.has(cacheKey)) return rangeCache.queryResultCountCache.get(cacheKey);
  let count = 0;
  if (state.view === "videos") {
    count = videoItemsForRange(rangeCache, {
      filter: draft.q,
      nicheOnly: draft.nicheOnly,
      hideUnknownArtists: draft.hideUnknownArtist,
    }).length;
    rangeCache.queryResultCountCache.set(cacheKey, count);
    return count;
  }
  const occurrences = queryDraftOccurrences(rangeCache, draft);
  if (state.view === "artistRank") {
    count = queryDraftRankRecords(queryDraftArtistRecords(rangeCache, draft, occurrences), draft, "artistRank").length;
    rangeCache.queryResultCountCache.set(cacheKey, count);
    return count;
  }
  const songRecords = queryDraftSongRecords(rangeCache, draft, occurrences);
  if (state.view === "songAz") {
    count = queryDraftMinCountRecords(songRecords, draft).length;
    rangeCache.queryResultCountCache.set(cacheKey, count);
    return count;
  }
  count = queryDraftRankRecords(songRecords, draft, "songRank").length;
  rangeCache.queryResultCountCache.set(cacheKey, count);
  return count;
}

function queryDraftBaseOccurrences(rangeCache, draft) {
  const hideUnknownForView = draft.hideUnknownArtist && state.view !== "artistRank";
  return draft.nicheOnly
    ? hideUnknownForView
      ? rangeCache.visibleNicheOccurrences
      : rangeCache.nicheOccurrences
    : hideUnknownForView
      ? rangeCache.visibleOccurrences
      : rangeCache.occurrences;
}

function queryDraftHideUnknownForView(draft) {
  return draft.hideUnknownArtist && state.view !== "artistRank";
}

function queryDraftOccurrences(rangeCache, draft) {
  const base = queryDraftBaseOccurrences(rangeCache, draft);
  const filterKey = normalizeSearch(draft.q);
  if (!filterKey) return base;
  return base.filter((occurrence) => occurrence.searchText.includes(filterKey));
}

function queryDraftSongRecords(rangeCache, draft, occurrences = queryDraftOccurrences(rangeCache, draft)) {
  const filterKey = normalizeSearch(draft.q);
  if (!filterKey) return draftScopedSongRecords(rangeCache, draft);
  const key = `query-records::song::${draft.nicheOnly ? "niche" : "all"}::${queryDraftHideUnknownForView(draft) ? "hide-unknown" : "show-unknown"}::${filterKey}`;
  if (!rangeCache.queryRecordCache.has(key)) {
    rangeCache.queryRecordCache.set(key, buildSongRecords(occurrences));
  }
  return rangeCache.queryRecordCache.get(key);
}

function queryDraftArtistRecords(rangeCache, draft, occurrences = queryDraftOccurrences(rangeCache, draft)) {
  const filterKey = normalizeSearch(draft.q);
  if (!filterKey) return draft.nicheOnly ? rangeCache.nicheArtistRecords : rangeCache.allArtistRecords;
  const key = `query-records::artist::${draft.nicheOnly ? "niche" : "all"}::${filterKey}`;
  if (!rangeCache.queryRecordCache.has(key)) {
    rangeCache.queryRecordCache.set(key, buildArtistRecords(occurrences).records);
  }
  return rangeCache.queryRecordCache.get(key);
}

function draftScopedSongRecords(rangeCache, draft) {
  if (draft.nicheOnly) return queryDraftHideUnknownForView(draft) ? rangeCache.visibleNicheSongRecords : rangeCache.nicheSongRecords;
  return queryDraftHideUnknownForView(draft) ? rangeCache.visibleSongRecords : rangeCache.allSongRecords;
}

function queryDraftMinCountRecords(records, draft) {
  if (state.view === "videos" || draft.minCount <= 1) return records;
  return records.filter((record) => queryDraftRankValue(record, draft) >= draft.minCount);
}

function queryDraftRankRecords(records, draft, mode) {
  const minFiltered = queryDraftMinCountRecords(records, draft);
  if (draft.trend === "all" || draft.snapshotPath !== SNAPSHOT_LATEST_PATH || (mode !== "songRank" && mode !== "artistRank")) return minFiltered;
  const diff = state.rankDiffs?.[state.range]?.[mode];
  if (!(diff instanceof Map)) return minFiltered;
  return minFiltered.filter((record) => {
    const trend = diff.get(record.key);
    if (!trend) return false;
    if (draft.trend === "new") return trend.isNew === true;
    const rankDelta = Number(trend.rankDelta) || 0;
    if (draft.trend === "up") return rankDelta > 0;
    if (draft.trend === "down") return rankDelta < 0;
    return true;
  });
}

function queryDraftRankValue(record, draft) {
  return draft.rankMetric === "videos" ? record.videoCount || 0 : record.count;
}

function queryResultCountKey(draft) {
  const trendState =
    draft.trend === "all"
      ? "all"
      : state.rankDiffs?.[state.range]?.[state.view] instanceof Map
        ? "ready"
        : state.rankDiffLoads.has(state.range)
          ? "loading"
          : "missing";
  return [
    "query-count",
    state.currentSnapshotPath,
    state.range,
    state.view,
    draft.nicheOnly ? "niche" : "all",
    queryDraftHideUnknownForView(draft) ? "hide-unknown" : "show-unknown",
    normalizeSearch(draft.q),
    draft.rankMetric,
    draft.trend,
    trendState,
    draft.minCount,
  ].join("::");
}

function currentResultCountForDraft(draft) {
  const key = queryResultCountKey(draft);
  return state.currentResultSummary?.key === key ? state.currentResultSummary.count : null;
}

function setCurrentResultSummary(draft, count) {
  state.currentResultSummary = {
    key: queryResultCountKey(draft),
    count: Math.max(0, Number(count) || 0),
  };
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
  const viewportHeight = viewport?.height || window.innerHeight || 0;
  const offsetTop = viewport?.offsetTop || 0;
  const offsetBottom = Math.max(0, (window.innerHeight || viewportHeight) - viewportHeight - offsetTop);
  document.documentElement.style.setProperty("--visual-viewport-height", `${Math.round(viewportHeight)}px`);
  document.documentElement.style.setProperty("--visual-viewport-offset-top", `${Math.round(offsetTop)}px`);
  document.documentElement.style.setProperty("--visual-viewport-bottom", `${Math.round(offsetBottom)}px`);
}

function updateQueryAnchorPosition() {
  if (state.activeOverlay !== "query" || !els.queryPanel || isMobileViewport()) return;
  const trigger = state.overlayTrigger && document.contains(state.overlayTrigger) ? state.overlayTrigger : els.queryTrigger || els.controls;
  const triggerRect = trigger?.getBoundingClientRect?.();
  const controlsRect = els.controls?.getBoundingClientRect?.();
  const anchorBottom = Math.max(triggerRect?.bottom || 0, controlsRect?.bottom || 0);
  const top = Math.max(8, Math.round(anchorBottom + 8));
  const right = Math.max(16, Math.round((window.innerWidth || document.documentElement.clientWidth || 0) - (triggerRect?.right || 0)));
  document.documentElement.style.setProperty("--query-anchor-top", `${top}px`);
  document.documentElement.style.setProperty("--query-anchor-right", `${right}px`);
}

function handleResponsiveResize() {
  updateViewportVars();
  updateQueryAnchorPosition();
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
  const stateParamKeys = [
    "range",
    "view",
    "page",
    "pageSize",
    "bucket",
    "metric",
    "layout",
    "outside",
    "libraryOutside",
    "showUnknown",
    "q",
    "snapshot",
    "trend",
    "minCount",
  ];
  const hasStateParams = stateParamKeys.some((key) => urlParams.has(key));
  if (!shouldApplySharedState && !hasStateParams) {
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
  state.sharedUrlApplied = shouldApplySharedState;
}

function syncControlsFromState() {
  setActiveTab(els.rangeTabs, els.rangeTabs.find((tab) => tab.dataset.range === state.range) || els.rangeTabs[0]);
  setActiveTab(els.viewTabs, els.viewTabs.find((tab) => tab.dataset.view === state.view) || els.viewTabs[0]);
  syncBottomNavFromState();
  if (els.nicheOnlyToggle) els.nicheOnlyToggle.checked = state.nicheOnly;
  if (els.hideUnknownToggle) els.hideUnknownToggle.checked = state.hideUnknownArtist;
  syncSnapshotControlsFromState();
  syncQueryTriggerState();
  renderActiveQueryStrip();
}

function syncUrlState(urlMode = "replace") {
  if (!window.history?.pushState || !window.history?.replaceState) return;
  const serialized = window.FrontendUtils.serializeUrlState(
    {
      range: state.range,
      view: state.view,
      page: state.page,
      pageSize: state.pageSize,
      bucket: state.indexBucket,
      rankMetric: state.rankMetric,
      videoLayout: state.videoLayout,
      outside: state.nicheOnly,
      showUnknown: !state.hideUnknownArtist,
      q: state.filter,
      snapshotPath: state.currentSnapshotPath,
      trend: state.trend,
      minCount: state.minCount,
    },
    {
      defaults: defaultUrlState(),
      latestSnapshotPath: SNAPSHOT_LATEST_PATH,
      snapshots: state.snapshots,
    },
  );
  const nextUrl = `${window.location.pathname}${serialized ? `?${serialized}` : ""}${window.location.hash}`;
  if (nextUrl === `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    state.sharedUrlApplied = false;
    return;
  }
  const mode = urlMode === "push" ? "pushState" : "replaceState";
  window.history[mode]({ dailySongList: true }, "", nextUrl);
  state.sharedUrlApplied = false;
}

function cleanSharedUrlAfterRender() {
  if (!state.sharedUrlApplied || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  url.searchParams.delete("shared");
  const cleanUrl = `${url.pathname}${url.search}${url.hash}`;
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
        filterVersion: Number.isInteger(raw.filterVersion) ? raw.filterVersion : 0,
        blocklistVersion: raw.blocklistVersion || "",
        blocklistHash: raw.blocklistHash || "",
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
    blocklistVersion: rangePayload?.blocklistVersion || meta?.blocklistVersion || "",
    blocklistHash: rangePayload?.blocklistHash || meta?.blocklistHash || "",
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
  const sourceFiltered = await applySourceFilterIfNeeded(payload);
  if (window.FrontendUtils.hasNicheAnnotations(sourceFiltered)) return sourceFiltered;
  await ensureSongSearchLookup();
  if (!state.songSearchLookup.available) return sourceFiltered;
  return window.FrontendUtils.annotatePayloadWithNiche(sourceFiltered, state.songSearchLookup);
}

async function applySourceFilterIfNeeded(payload) {
  if (shouldSkipSourceFilter(payload) && isLatestSnapshot()) return payload;
  const sourceFilter = await ensureSourceFilterLoaded();
  if (!sourceFilter?.filterPayloadBlockedSources) {
    throw new Error("source-filter 加载失败，已停止展示未过滤数据");
  }
  return measureSync("source-filter", () => sourceFilter.filterPayloadBlockedSources(payload));
}

function shouldSkipSourceFilter(payload) {
  return window.FrontendUtils.shouldSkipSourceFilter(payload, CURRENT_FILTER_VERSION, currentBlocklistHash());
}

function currentBlocklistHash() {
  return window.SourceFilter?.BLOCKLIST_HASH || window.BlockedVtuberMeta?.blocklistHash || "";
}

async function ensureSourceFilterLoaded() {
  if (window.SourceFilter?.filterPayloadBlockedSources) return window.SourceFilter;
  if (!state.sourceFilterPromise) {
    state.sourceFilterPromise = loadScript(versionedAssetPath("assets/blocked-vtuber-channels.js"))
      .then(() => {
        if (!window.BlockedVtuberChannels?.blocklistHash) throw new Error("blocked-vtuber-channels 加载失败");
        if (window.BlockedVtuberMeta?.blocklistHash && window.BlockedVtuberChannels.blocklistHash !== window.BlockedVtuberMeta.blocklistHash) {
          throw new Error("blocked-vtuber-channels hash 与 meta 不一致");
        }
        return loadScript(versionedAssetPath("assets/source-filter.js"));
      })
      .then(() => {
        if (!window.SourceFilter?.filterPayloadBlockedSources) throw new Error("source-filter 未导出过滤器");
        if (window.BlockedVtuberMeta?.blocklistHash && window.SourceFilter.BLOCKLIST_HASH !== window.BlockedVtuberMeta.blocklistHash) {
          throw new Error("source-filter hash 与 meta 不一致");
        }
        return window.SourceFilter;
      })
      .catch((error) => {
        state.sourceFilterPromise = null;
        throw error;
      });
  }
  return state.sourceFilterPromise;
}

function versionedAssetPath(path) {
  const version = currentAssetVersion();
  return version ? `${path}?v=${encodeURIComponent(version)}` : path;
}

function currentAssetVersion() {
  const script = document.querySelector('script[src^="assets/app.js"]');
  const src = script?.getAttribute("src") || "";
  const match = src.match(/[?&]v=([^&]+)/u);
  return match ? decodeURIComponent(match[1]) : "";
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = Array.from(document.scripts || []).find((script) => script.getAttribute("src") === src);
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error(`${src}: script load failed`)), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.dataset.dynamicAsset = "true";
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        state.loadedResources.push({ path: src, bytes: 0, cache: "script", durationMs: 0 });
        resolve();
      },
      { once: true },
    );
    script.addEventListener("error", () => reject(new Error(`${src}: script load failed`)), { once: true });
    document.head.append(script);
  });
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
      if (!loaded || !isLatestSnapshot()) return;
      if (state.trend === "all") {
        updateVisibleTrendBadges();
        updateQueryAvailability();
      } else {
        render({ syncUrl: false });
      }
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

function updateVisibleTrendBadges() {
  if (!isLatestSnapshot() || state.rankMetric !== "occurrences") return;
  const rows = els.content?.querySelectorAll(".rank-row[data-trend-mode][data-trend-key]") || [];
  for (const row of rows) {
    const trend = trendForKey(row.dataset.trendMode, row.dataset.trendKey);
    const trendSlot = row.querySelector(".rank-side-trend");
    if (!trendSlot) continue;
    const badge = renderTrendBadge(trend);
    trendSlot.replaceChildren();
    if (badge) {
      trendSlot.append(badge);
      trendSlot.removeAttribute("aria-hidden");
    } else {
      trendSlot.setAttribute("aria-hidden", "true");
    }
  }
}

function scheduleOtherRangePrefetch() {
  if (!isLatestSnapshot() || !canPrefetchOtherRange()) return;
  const otherRange = Object.keys(RANGE_LABELS).find((rangeId) => rangeId !== state.range);
  if (!otherRange || state.runtimeRangePayloads.has(otherRange)) return;
  if (state.rangePrefetchTimer) window.clearTimeout(state.rangePrefetchTimer);
  const run = () => {
    state.rangePrefetchTimer = 0;
    if (!canPrefetchOtherRange() || state.runtimeRangePayloads.has(otherRange)) return;
    loadRuntimeRange(otherRange).catch(() => {});
  };
  state.rangePrefetchTimer = window.setTimeout(() => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 1200 });
    } else {
      run();
    }
  }, 300);
}

function prefetchRuntimeRangeOnIntent(rangeId) {
  if (!rangeId || rangeId === state.range || state.runtimeRangePayloads.has(rangeId)) return;
  if (!isLatestSnapshot() || !canPrefetchOtherRange()) return;
  loadRuntimeRange(rangeId).catch(() => {});
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
  if (els.querySnapshotSelect) els.querySnapshotSelect.disabled = isBusy;
  if (els.querySnapshotDateSelect) els.querySnapshotDateSelect.disabled = isBusy;
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
  renderSnapshotDateOptions();
  renderSnapshotTimeOptions(selectedSnapshotDateValue());
  syncSnapshotControlsFromState();
}

function renderSnapshotDateOptions() {
  if (!els.querySnapshotDateSelect) return;
  els.querySnapshotDateSelect.replaceChildren();
  const latestOption = document.createElement("option");
  latestOption.value = "latest";
  latestOption.textContent = "最新";
  els.querySnapshotDateSelect.append(latestOption);

  for (const dateValue of snapshotDateValues()) {
    const option = document.createElement("option");
    option.value = dateValue;
    option.textContent = snapshotDateOptionLabel(dateValue);
    els.querySnapshotDateSelect.append(option);
  }
}

function renderSnapshotTimeOptions(dateValue) {
  if (!els.querySnapshotSelect) return;
  els.querySnapshotSelect.replaceChildren();
  if (dateValue === "latest") {
    const latestOption = document.createElement("option");
    latestOption.value = SNAPSHOT_LATEST_PATH;
    latestOption.textContent = "最新快照";
    els.querySnapshotSelect.append(latestOption);
    els.querySnapshotSelect.disabled = false;
    return;
  }

  for (const entry of snapshotEntriesForDate(dateValue)) {
    const option = document.createElement("option");
    option.value = entry.path;
    option.textContent = snapshotOptionLabel(entry);
    els.querySnapshotSelect.append(option);
  }
  els.querySnapshotSelect.disabled = !els.querySnapshotSelect.options.length;
}

function syncSnapshotControlsFromState() {
  const dateValue = selectedSnapshotDateValue();
  if (els.querySnapshotDateSelect && els.querySnapshotDateSelect.value !== dateValue) {
    els.querySnapshotDateSelect.value = dateValue;
  }
  renderSnapshotTimeOptions(dateValue);
  if (els.querySnapshotSelect) els.querySnapshotSelect.value = state.currentSnapshotPath;
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
  const parts = dateParts(entry?.capturedAt || entry?.generatedAt || entry?.id || "");
  if (!parts) return "";
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function snapshotDateOptionLabel(dateValue) {
  const [, month, day] = String(dateValue).split("-");
  return month && day ? `${month}月${day}日` : dateValue;
}

function renderStatus(status) {
  renderStatusAlerts([]);
  if (!isLatestSnapshot()) {
    const snapshotEntry = snapshotEntryForPath(state.currentSnapshotPath);
    const capturedAt = snapshotEntry?.capturedAt || snapshotEntry?.generatedAt || state.payload?.capturedAt || state.payload?.generatedAt || "";
    setStatusSummary({
      text: `历史 ${formatDate(capturedAt)}`,
      kind: "snapshot",
      dateTime: capturedAt,
      title: [`历史快照 · ${formatDate(capturedAt)}`, `path=${state.currentSnapshotPath}`].filter(Boolean).join("\n"),
    });
    renderDebugPanel();
    return;
  }
  const currentStatus = mergeRuntimeStatus(state.runtimeMeta?.status || null, status || state.status, state.runtimeMeta);
  if (!currentStatus) {
    setStatusSummary({
      text: "状态不可用",
      kind: "unavailable",
      title: "状态不可用",
    });
    renderDebugPanel();
    return;
  }
  const capturedAt = currentStatus.capturedAt || currentStatus.dataCapturedAt || state.runtimeMeta?.capturedAt || "";
  const completedAt = currentStatus.completedAt || "";
  const attemptedAt = currentStatus.attemptedAt || "";
  const rebuiltDerivedAt = currentStatus.rebuiltDerivedAt || state.runtimeMeta?.rebuiltDerivedAt || "";
  const parts = [];
  if (currentStatus.status === "success") {
    parts.push(`数据抓取于 ${formatDate(capturedAt)}`);
  } else {
    const failureAt = attemptedAt ? `最近尝试 ${formatDate(attemptedAt)}` : "最近尝试时间不可用";
    parts.push(`正在使用上次成功数据 · ${failureAt}`);
    if (capturedAt) parts.push(`上次成功 ${formatDate(capturedAt)}`);
  }
  if (rebuiltDerivedAt && rebuiltDerivedAt !== capturedAt) parts.push(`页面数据重建于 ${formatDate(rebuiltDerivedAt)}`);
  const staleAge = capturedAt ? Date.now() - Date.parse(capturedAt) : 0;
  const alerts = [];
  if (Number.isFinite(staleAge) && staleAge > STATUS_STALE_MS) {
    parts.push(`超过${STATUS_STALE_MINUTES}分钟未更新`);
    alerts.push(`数据已超过${staleThresholdLabel()}未更新`);
  }
  const warning = state.runtimeWarnings.get(state.range);
  if (warning?.fallbackPath) {
    parts.push("当前使用备用数据");
    alerts.push("精简数据读取失败，当前使用备用数据");
  }
  const displayAt = capturedAt || rebuiltDerivedAt || attemptedAt;
  const statusText = currentStatus.status === "success" ? `更新 ${formatDate(displayAt)}` : capturedAt ? `上次成功 ${formatDate(capturedAt)}` : "状态异常";
  setStatusSummary({
    text: statusText,
    kind: currentStatus.status === "success" ? "success" : "fallback",
    dateTime: displayAt,
    title: [
      parts.filter(Boolean).join(" · "),
      `status=${currentStatus.status || "unknown"}`,
      `capturedAt=${capturedAt || ""}`,
      `completedAt=${completedAt || ""}`,
      `attemptedAt=${attemptedAt || ""}`,
      `rebuiltDerivedAt=${rebuiltDerivedAt || ""}`,
      `dataVersion=${state.runtimeMeta?.dataVersion || ""}`,
      warning?.primaryError ? `warning=${warning.primaryError}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  });
  renderStatusAlerts(alerts);
  renderDebugPanel();
}

function setStatusSummary(model) {
  state.statusSummary = model || null;
  if (els.status) {
    els.status.textContent = model?.text || "";
    if (model?.title) {
      els.status.title = model.title;
    } else {
      els.status.removeAttribute("title");
    }
  }
  refreshSummaryStatusNode();
}

function refreshSummaryStatusNode() {
  const oldNode = els.summary?.querySelector(".summary-status");
  if (!oldNode) return;
  const nextNode = renderSummaryStatusNode();
  if (nextNode) {
    oldNode.replaceWith(nextNode);
  } else {
    oldNode.remove();
  }
}

function renderSummaryStatusNode() {
  if (!state.statusSummary?.text) return null;
  const node = document.createElement(state.statusSummary.dateTime ? "time" : "span");
  node.className = `summary-status summary-status-${state.statusSummary.kind || "info"}`;
  node.textContent = state.statusSummary.text;
  node.dataset.statusKind = state.statusSummary.kind || "info";
  if (state.statusSummary.dateTime) node.dateTime = state.statusSummary.dateTime;
  if (state.statusSummary.title) node.title = state.statusSummary.title;
  return node;
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

function staleThresholdLabel() {
  if (STATUS_STALE_MINUTES % 60 === 0) return `${STATUS_STALE_MINUTES / 60}小时`;
  return `${STATUS_STALE_MINUTES}分钟`;
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
  state.compactDrawerLru = [];
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
  syncQueryTriggerState();
  renderActiveQueryStrip();
  updateQueryAvailability();
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
  if (state.view === "videos") return;
  const hideUnknownForView = shouldHideUnknownForCurrentView();
  const scope = `${state.nicheOnly ? "niche" : "all"}::${hideUnknownForView ? "hide-unknown" : "show-unknown"}`;
  if (state.view === "artistRank") {
    const artistRecords = state.nicheOnly ? cache.nicheArtistRecords : cache.allArtistRecords;
    cacheRankModel(cache, `artist-rank::${scope}::${filterKey}::${state.rankMetric}`, [...artistRecords].sort(compareRankRecords));
  } else if (state.view === "songAz") {
    const songRecords = selectedSongRecords(cache, { hideUnknownForView });
    cache.sortedRecords.set(`song-az::${scope}::${filterKey}::${state.rankMetric}`, [...songRecords].sort(compareSongAz));
  } else {
    const songRecords = selectedSongRecords(cache, { hideUnknownForView });
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
    queryIndexes: new Map(),
    queryIndexLoads: new Map(),
    queryRecordCache: new Map(),
    queryResultCountCache: new Map(),
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
  const key = `${state.view}::${state.nicheOnly ? "niche" : "all"}::${hideUnknownForView ? "hide-unknown" : "show-unknown"}::${filterKey}`;
  if (rangeCache.selectionCache.has(key)) return rangeCache.selectionCache.get(key);

  const baseOccurrences = selectedOccurrences(rangeCache, { hideUnknownForView });
  const hiddenUnknownCount = hideUnknownForView ? hiddenUnknownOccurrenceCount(rangeCache) : 0;
  const baseVideoCount = state.nicheOnly
    ? hideUnknownForView
      ? rangeCache.visibleNicheVideoCount
      : rangeCache.nicheVideoCount
    : hideUnknownForView
      ? rangeCache.visibleVideoCount
      : rangeCache.allVideoCount;

  const selection = {
    occurrences: baseOccurrences,
    videoCount: baseVideoCount,
    hiddenUnknownCount,
    videoItems: null,
  };
  if (!filterKey) {
    attachSelectionRecordGetters(selection, rangeCache, baseOccurrences, { hideUnknownForView, filtered: false });
  } else {
    const occurrences = baseOccurrences.filter((occurrence) => occurrence.searchText.includes(filterKey));
    selection.occurrences = occurrences;
    selection.videoCount = uniqueVideoCount(occurrences);
    attachSelectionRecordGetters(selection, rangeCache, occurrences, { hideUnknownForView, filtered: true });
  }
  rangeCache.selectionCache.set(key, selection);
  return selection;
}

function attachSelectionRecordGetters(selection, rangeCache, occurrences, options = {}) {
  const filtered = Boolean(options.filtered);
  const hideUnknownForView = Boolean(options.hideUnknownForView);
  if (state.view === "artistRank") {
    defineLazyValue(selection, "artistResult", () =>
      filtered
        ? measureSync("build-artist-records", () => buildArtistRecords(occurrences))
        : {
            records: state.nicheOnly ? rangeCache.nicheArtistRecords : rangeCache.allArtistRecords,
            missingArtistCount: state.nicheOnly ? rangeCache.nicheMissingArtistCount : rangeCache.allMissingArtistCount,
          },
    );
    Object.defineProperty(selection, "artistRecords", {
      configurable: true,
      enumerable: true,
      get() {
        return selection.artistResult.records;
      },
    });
    Object.defineProperty(selection, "missingArtistCount", {
      configurable: true,
      enumerable: true,
      get() {
        return selection.artistResult.missingArtistCount;
      },
    });
    return;
  }

  if (state.view === "songRank" || state.view === "songAz") {
    defineLazyValue(selection, "songRecords", () =>
      filtered ? measureSync("build-song-records", () => buildSongRecords(occurrences)) : selectedSongRecords(rangeCache, { hideUnknownForView }),
    );
  }
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
  setCurrentResultSummary(makeQueryDraftFromState(), items.length);
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
  setCurrentResultSummary(makeQueryDraftFromState(), records.length);

  renderSummary(group, [
    recordVisibilityMetric(records.length, baseModel.records.length, allRecords.length, nicheRecords.length, "首歌曲", "首小众歌曲"),
    occurrenceVisibilityMetric(occurrences.length, sourceVisibleOccurrences.length, hideUnknownForView ? rangeCache.visibleNicheOccurrences.length : rangeCache.nicheOccurrences.length),
    summaryVideoMetric(rangeCache, selection),
  ], summaryNote(selection, filterStatusNote("songRank", filteredModel), rangeCache));

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
  setCurrentResultSummary(makeQueryDraftFromState(), records.length);

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
  setCurrentResultSummary(makeQueryDraftFromState(), records.length);

  renderSummary(group, [
    recordVisibilityMetric(records.length, baseRecords.length, allRecords.length, nicheRecords.length, "首歌曲", "首小众歌曲"),
    occurrenceVisibilityMetric(occurrences.length, sourceVisibleOccurrences.length, hideUnknownForView ? rangeCache.visibleNicheOccurrences.length : rangeCache.nicheOccurrences.length),
    summaryVideoMetric(rangeCache, selection),
  ], summaryNote(selection, "", rangeCache));

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
  fragment.append(renderIndexToolbar(bucketModel, pageInfo));

  if (bucketModel.currentBucket === INDEX_ALL_BUCKET) {
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
  } else {
    const list = document.createElement("div");
    list.className = "index-list index-list-flat";
    const listFragment = document.createDocumentFragment();
    for (const record of pageInfo.visible) {
      listFragment.append(renderIndexRecord(record));
    }
    list.append(listFragment);
    fragment.append(list);
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

  if (state.nicheOnly) {
    const niche = document.createElement("span");
    niche.className = "summary-chip niche-summary";
    niche.textContent = "小众";
    main.append(niche);
  }
  if (!isLatestSnapshot()) {
    const snapshot = document.createElement("span");
    snapshot.className = "summary-chip summary-status-chip";
    snapshot.textContent = "历史快照";
    main.append(snapshot);
  }
  if (state.runtimeWarnings.get(state.range)?.fallbackPath) {
    const fallback = document.createElement("span");
    fallback.className = "summary-chip summary-status-chip";
    fallback.textContent = "备用数据";
    main.append(fallback);
  }

  const metricParts = metrics.filter(Boolean);
  if (metricParts.length) {
    const metricNode = document.createElement("span");
    metricNode.className = "summary-metrics";
    metricParts.forEach((part, index) => {
      if (index) {
        const separator = document.createElement("span");
        separator.className = "summary-separator";
        separator.textContent = " · ";
        metricNode.append(separator);
      }
      const item = document.createElement("span");
      item.className = "summary-metric";
      item.textContent = part;
      metricNode.append(item);
    });
    const statusNode = renderSummaryStatusNode();
    if (statusNode) {
      const separator = document.createElement("span");
      separator.className = "summary-separator";
      separator.textContent = " · ";
      metricNode.append(separator, statusNode);
    }
    main.append(metricNode);
  } else {
    const statusNode = renderSummaryStatusNode();
    if (statusNode) main.append(statusNode);
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

function summaryNote(selection, extra = "", rangeCache = null) {
  return [extra, summaryVideoVisibilityNote(rangeCache, selection), hiddenUnknownNote(selection), monthlyCoverageNote()].filter(Boolean).join(" · ");
}

function summaryVideoMetric(rangeCache, selection) {
  const model = summaryVideoCountModel(rangeCache, selection);
  return model.usesSourceCount ? `可见${model.visibleCount}视频` : metric(model.visibleCount, "个视频");
}

function summaryVideoVisibilityNote(rangeCache, selection) {
  return summaryVideoCountModel(rangeCache, selection).note;
}

function summaryVideoCountModel(rangeCache, selection) {
  if (!rangeCache) return { count: Number(selection?.videoCount) || 0, note: "" };
  return window.FrontendUtils.summaryVideoCountModel({
    visibleCount: selection?.videoCount,
    sourceCount: sourceVideoCountForSummary(rangeCache),
    hideUnknownArtist: shouldHideUnknownForCurrentView(),
    filter: state.filter,
  });
}

function sourceVideoCountForSummary(rangeCache) {
  if (state.nicheOnly) return rangeCache.nicheVideoCount;
  return Array.isArray(rangeCache.items) ? rangeCache.items.length : rangeCache.allVideoCount;
}

function monthlyCoverageNote() {
  if (state.range !== "1m" || !isLatestSnapshot()) return "";
  const catalog = state.runtimeMeta?.catalog;
  const catalogVideoCount = Number(catalog?.catalogVideoCount);
  const retentionDays = Number(catalog?.retentionDays) || 35;
  if (!Number.isFinite(catalogVideoCount) || catalogVideoCount <= 0) return "最近35天累计";
  return `最近${retentionDays}天累计 · 总目录${catalogVideoCount}视频`;
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

function renderIndexToolbar(bucketModel, pageInfo) {
  const toolbar = document.createElement("div");
  toolbar.className = "index-toolbar";
  toolbar.append(renderIndexBucketSelect(bucketModel));
  toolbar.append(renderIndexBucketNav(bucketModel.buckets));
  const pager = renderPaginationControl({ pageInfo, unit: "首歌曲", variant: "top" });
  if (pager) {
    pager.classList.add("index-pagination");
    const mobileControls = pager.querySelector(".pagination-controls");
    if (mobileControls && getResponsiveMode() === "mobile") {
      mobileControls.replaceWith(renderMobileTopPagination(pageInfo, { index: true }));
    }
    toolbar.append(pager);
  }
  return toolbar;
}

function renderIndexBucketSelect(bucketModel) {
  const label = document.createElement("label");
  label.className = "index-bucket-select";
  const text = document.createElement("span");
  text.textContent = "首字母";
  const select = document.createElement("select");
  select.dataset.indexBucketSelect = "true";
  select.setAttribute("aria-label", "选择歌曲索引首字母");
  const options = [{ label: INDEX_ALL_BUCKET, value: INDEX_ALL_BUCKET }, ...bucketModel.buckets.map((bucket) => ({ label: bucket.label, value: bucket.label }))];
  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    select.append(option);
  }
  select.value = bucketModel.currentBucket;
  label.append(text, select);
  return label;
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
  const mode = getResponsiveMode();

  const footer = document.createElement("div");
  footer.className = `pagination-row pagination-${variant}`;
  if (mode === "mobile") footer.classList.add("pagination-mobile");

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

  if (showPageControls) {
    const controls =
      mode === "mobile"
        ? variant === "top"
          ? renderMobileTopPagination(pageInfo)
          : renderMobileBottomPagination(pageInfo)
        : renderDesktopPaginationControls(pageInfo);
    footer.append(controls);
  }

  if (mode !== "mobile" && variant === "bottom" && showPageControls) footer.append(renderPageSelectControl(pageInfo));
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
  if (options.className) button.classList.add(options.className);
  button.type = "button";
  button.dataset.page = String(page);
  button.disabled = disabled;
  if (isCurrent) button.setAttribute("aria-current", "page");
  if (options.icon) {
    button.classList.add("pagination-icon-button");
    button.setAttribute("aria-label", label);
    button.title = label;
    button.append(renderPaginationIcon(options.icon));
  } else {
    button.textContent = label;
    button.title = label;
  }
  return button;
}

function renderDesktopPaginationControls(pageInfo) {
  const controls = document.createElement("div");
  controls.className = "pagination-controls";
  controls.append(
    renderPageButton("上一页", pageInfo.page - 1, pageInfo.page === 1, false, { icon: "prev" }),
    ...renderPageTokenButtons(pageInfo),
    renderPageButton("下一页", pageInfo.page + 1, pageInfo.page === pageInfo.pageCount, false, { icon: "next" }),
  );
  return controls;
}

function renderMobileTopPagination(pageInfo, options = {}) {
  const model = window.FrontendUtils.mobilePageModel(pageInfo.page, pageInfo.pageCount);
  const controls = document.createElement("div");
  controls.className = options.index ? "pagination-controls pagination-stepper pagination-stepper-index" : "pagination-controls pagination-stepper";
  controls.append(renderPageButton("上一页", model.previousPage || 1, !model.hasPrevious, false, { icon: "prev" }));
  for (const page of options.index ? [] : model.previousNeighbors) {
    controls.append(renderPageButton(String(page), page, false, false, { className: "pagination-neighbor" }));
  }
  controls.append(renderPageSelectControl(pageInfo, { compact: true }));
  for (const page of options.index ? [] : model.nextNeighbors) {
    controls.append(renderPageButton(String(page), page, false, false, { className: "pagination-neighbor" }));
  }
  controls.append(renderPageButton("下一页", model.nextPage || model.pageCount, !model.hasNext, false, { icon: "next" }));
  return controls;
}

function renderMobileBottomPagination(pageInfo) {
  const controls = document.createElement("div");
  controls.className = "pagination-controls pagination-bottom-stepper";
  controls.append(
    renderPageButton("首页", 1, pageInfo.page === 1, false, { icon: "first" }),
    renderPageButton("上一页", pageInfo.page - 1, pageInfo.page === 1, false, { icon: "prev" }),
    renderPageSelectControl(pageInfo, { compact: true }),
    renderPageButton("下一页", pageInfo.page + 1, pageInfo.page === pageInfo.pageCount, false, { icon: "next" }),
    renderPageButton("末页", pageInfo.pageCount, pageInfo.page === pageInfo.pageCount, false, { icon: "last" }),
  );
  return controls;
}

function renderPaginationIcon(direction) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const paths = {
    first: ["m11 18-6-6 6-6", "m19 18-6-6 6-6"],
    prev: ["m15 18-6-6 6-6"],
    next: ["m9 6 6 6-6 6"],
    last: ["m5 6 6 6-6 6", "m13 6 6 6-6 6"],
  }[direction] || ["m9 6 6 6-6 6"];
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function renderPageTokenButtons(pageInfo) {
  const options = paginationTokenOptions();
  return window.FrontendUtils.desktopPageTokens(pageInfo.page, pageInfo.pageCount, options).map((token) => {
    if (token.type === "ellipsis") return renderPageEllipsisToken(token);
    return renderPageButton(String(token.page), token.page, false, token.current);
  });
}

function paginationTokenOptions() {
  const mode = getResponsiveMode();
  if (mode === "mobile") return { maxTokens: 5 };
  if (mode === "tablet") return { maxTokens: 7 };
  return { maxTokens: 9 };
}

function renderPageEllipsisToken(token) {
  const item = document.createElement("span");
  item.className = "pagination-ellipsis";
  item.setAttribute("aria-hidden", "true");
  item.dataset.ellipsisSide = token.side || "";
  item.textContent = "…";
  return item;
}

function renderPageSelectControl(pageInfo, options = {}) {
  const label = document.createElement("label");
  label.className = options.compact ? "page-select page-select-compact" : "page-select";
  const text = document.createElement("span");
  text.textContent = options.compact ? `${pageInfo.page}/${pageInfo.pageCount}` : "跳至";
  const select = document.createElement("select");
  select.dataset.pageSelect = "true";
  select.setAttribute("aria-label", `当前第 ${pageInfo.page} 页，共 ${pageInfo.pageCount} 页，选择其他页`);
  for (let page = 1; page <= pageInfo.pageCount; page += 1) {
    const option = document.createElement("option");
    option.value = String(page);
    option.textContent = `${page}`;
    select.append(option);
  }
  select.value = String(pageInfo.page);
  label.append(text, select);
  return label;
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

    const videoMatched = matchesSearch([item.title, item.channelName, item.keyword], filter);
    const matchedSongs = sourceSongs.filter((song) => matchesSearch([song.title, song.artist], filter));
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

function matchesSearch(parts, filter = state.filter) {
  return window.FrontendUtils.matchesSearch(parts, filter);
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
  const sourceVideoCount = Math.max(0, Number(videoCount) || 0);
  const safeOccurrences = occurrences || [];
  const occurrenceCount = safeOccurrences.length;
  const isExpanded = state.expandedRows.has(rowKey);
  const sourcePresentation =
    mode === "artist"
      ? null
      : window.FrontendUtils.sourcePresentationModel(safeOccurrences, {
          expanded: isExpanded,
          inlineLimit: SOURCE_INLINE_LIMIT,
        });
  const expandable = mode === "artist" ? artistSongCount > 1 || sourceVideoCount > 1 || occurrenceCount > 1 : Boolean(sourcePresentation?.canExpand);

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
  row.dataset.trendMode = mode === "artist" ? "artistRank" : "songRank";
  row.dataset.trendKey = record?.key || key;
  row._sourceOccurrences = safeOccurrences;
  row._sourceDetailOccurrences = sourcePresentation?.hiddenGroups?.flatMap((group) => group.occurrences) || [];
  row._sourceVideoCount = sourceVideoCount;
  row._artistSongGroups = songGroups.length ? songGroups : null;
  row._getArtistSongGroups = getSongGroups;
  row._artistSongCount = artistSongCount;
  if (isTied) row.title = "同收录次数共享名次";

  const rankNumber = document.createElement("div");
  rankNumber.className = "rank-number";
  rankNumber.textContent = formatRank(rank);
  rankNumber.setAttribute("aria-label", `第 ${rank} 名`);
  row.append(rankNumber);

  row.append(
    renderRecordContent(title, meta, {
      mode,
      occurrences: safeOccurrences,
      songGroups,
      songCount,
      songPreview,
      drawerId,
      isExpanded,
      videoCount,
      sourcePresentation,
      trend,
      rankCount: count,
      rankMetric: state.rankMetric,
    }),
  );
  row.append(
    renderRankSide({
      mode,
      drawerId,
      isExpanded,
      expandable,
      occurrences: safeOccurrences,
      songCount: artistSongCount,
      videoCount: sourceVideoCount,
      count,
      countUnit,
      rankCount: count,
      rankMetric: state.rankMetric,
      trend,
    }),
  );
  if (expandable) {
    row.append(
      renderSourceDrawer({
        mode,
        occurrences: mode === "artist" ? safeOccurrences : row._sourceDetailOccurrences,
        copyOccurrences: safeOccurrences,
        songGroups,
        drawerId,
        isExpanded,
        getSongGroups,
      }),
    );
  }

  return row;
}

function renderIndexRecord(record) {
  const row = document.createElement("article");
  const rowKey = makeDomId(`index-${record.key}`);
  const drawerId = `source-drawer-${rowKey}`;
  const sourceVideoCount = Math.max(0, Number(record.videoCount) || 0);
  const isExpanded = state.expandedRows.has(rowKey);
  const sourcePresentation = window.FrontendUtils.sourcePresentationModel(record.occurrences, {
    expanded: isExpanded,
    inlineLimit: SOURCE_INLINE_LIMIT,
  });
  const expandable = sourcePresentation.canExpand;

  row.className = ["index-row", expandable ? "is-expandable" : "", isExpanded ? "is-expanded" : "", isNicheRecord(record) ? "is-niche" : ""]
    .filter(Boolean)
    .join(" ");
  row.dataset.rowKey = rowKey;
  row.dataset.drawerMode = "index";
  row._sourceOccurrences = record.occurrences;
  row._sourceDetailOccurrences = sourcePresentation.hiddenGroups.flatMap((group) => group.occurrences);
  row._sourceVideoCount = sourceVideoCount;

  row.append(
    renderRecordContent(record.title, songMeta(record), {
      mode: "index",
      occurrences: record.occurrences,
      drawerId,
      isExpanded,
      videoCount: record.videoCount,
      sourcePresentation,
      rankCount: record.count,
      rankMetric: "occurrences",
      headingLevel: 3,
    }),
  );
  row.append(
    renderRankSide({
      mode: "index",
      drawerId,
      isExpanded,
      expandable,
      occurrences: record.occurrences,
      videoCount: sourceVideoCount,
      count: record.count,
      rankCount: record.count,
      rankMetric: "occurrences",
    }),
  );
  if (expandable) {
    row.append(
      renderSourceDrawer({
        mode: "index",
        occurrences: row._sourceDetailOccurrences,
        copyOccurrences: record.occurrences,
        drawerId,
        isExpanded,
      }),
    );
  }

  return row;
}

function renderRankHeader(mode = "song") {
  const header = document.createElement("div");
  header.className = "rank-header";

  const contentLabel = mode === "artist" ? "歌手与曲目" : "歌曲与歌手";
  const countLabel = state.rankMetric === "videos" ? "视频与来源" : "次数与来源";
  for (const label of ["排名", contentLabel, countLabel]) {
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
    sourcePresentation = null,
    rankCount = 0,
    rankMetric = state.rankMetric,
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
  if (mode === "artist") {
    appendArtistSubline(metaLine, { occurrences, songCount, songPreview, videoCount });
  } else {
    appendSublinePart(metaLine, meta.primary, meta.missingPrimary ? "artist-missing" : "subline-primary");
    appendSublinePart(metaLine, `${videoCount} 个视频`, "subline-video-count");
  }
  if (metaLine.childNodes.length) subline.append(metaLine);
  content.append(subline);

  if (mode !== "artist") {
    content.append(
      renderSourceInlineStrip(sourcePresentation || window.FrontendUtils.sourcePresentationModel(occurrences, { expanded: isExpanded, inlineLimit: SOURCE_INLINE_LIMIT }), {
        drawerId,
        isExpanded,
        occurrences,
        mode,
        rankCount,
        rankMetric,
      }),
    );
  }

  return content;
}

function appendArtistSubline(metaContainer, { occurrences, songCount, songPreview, videoCount }) {
  appendSublinePart(metaContainer, (songPreview || []).slice(0, 2).join("、"), "subline-primary artist-song-preview");
  appendSublinePart(metaContainer, `${songCount} 首歌曲`, "subline-song-count");
  appendSublinePart(metaContainer, `${videoCount} 个视频`, "subline-video-count");
  if (songCount === 1 && occurrences.length === 1) {
    appendSublineNode(metaContainer, renderInlineSource(occurrences[0]));
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

function renderSourceToggleButton({
  mode,
  drawerId,
  isExpanded,
  hiddenCount = 0,
  total = 0,
  songCount = 0,
  videoCount = 0,
  occurrenceCount = 0,
  rankCount = 0,
  rankMetric = "occurrences",
}) {
  const model = window.FrontendUtils.rankToggleModel({
    mode,
    isExpanded,
    hiddenCount,
    total,
    songCount,
    videoCount,
    occurrenceCount,
    rankCount,
    rankMetric,
    compact: isCompactRankMode(),
  });
  const button = document.createElement("button");
  button.className = "rank-expand ui-chip";
  button.type = "button";
  button.dataset.toggleSource = "true";
  button.dataset.sourceMode = mode;
  button.dataset.sourceTotal = String(total);
  button.dataset.sourceHiddenCount = String(hiddenCount);
  button.dataset.songCount = String(songCount);
  button.dataset.videoCount = String(videoCount);
  button.dataset.occurrenceCount = String(occurrenceCount || total);
  button.dataset.rankCount = String(rankCount);
  button.dataset.rankMetric = rankMetric;
  button.setAttribute("aria-expanded", isExpanded ? "true" : "false");
  button.setAttribute("aria-controls", drawerId);
  button.setAttribute("aria-label", model.ariaLabel);
  button.textContent = model.text;
  return button;
}

function renderRankSide({
  mode = "song",
  drawerId,
  isExpanded,
  expandable,
  occurrences = [],
  songCount = 0,
  videoCount = 0,
  count = 0,
  countUnit = "次",
  rankCount = 0,
  rankMetric = "occurrences",
  trend = null,
}) {
  const side = document.createElement("div");
  side.className = "rank-side";

  const top = document.createElement("div");
  top.className = "rank-side-top";
  top.append(renderCount(count, countUnit));
  const trendSlot = document.createElement("span");
  trendSlot.className = "rank-side-trend";
  const trendBadge = renderTrendBadge(trend);
  if (trendBadge) {
    trendSlot.append(trendBadge);
  } else {
    trendSlot.setAttribute("aria-hidden", "true");
  }
  top.append(trendSlot);
  side.append(top);

  if (mode === "artist") {
    if (expandable) {
      side.append(renderSourceToggleButton({ mode, drawerId, isExpanded, songCount, occurrenceCount: occurrences.length, videoCount }));
    } else {
      side.append(renderStaticSideChip(`${songCount}首曲目`));
    }
    return side;
  }

  return side;
}

function renderStaticSideChip(text) {
  const chip = document.createElement("span");
  chip.className = "rank-expand rank-expand-static ui-chip ui-chip-muted";
  chip.textContent = text;
  return chip;
}

function renderSourceInlineStrip(model, options = {}) {
  const strip = document.createElement("div");
  strip.className = `source-inline-strip source-inline-${model.mode}`;
  strip.dataset.sourceVideoCount = String(model.videoCount || 0);
  strip.dataset.inlineVisibleCount = String(model.inlineVisibleCount || model.inlineGroups?.length || 0);
  if (model.canExpand) strip.classList.add("has-more");

  if (!model.videoCount) {
    const empty = document.createElement("span");
    empty.className = "source-inline-empty";
    empty.textContent = "无来源";
    strip.append(empty);
    return strip;
  }

  const rail = document.createElement("div");
  rail.className = "source-inline-preview-rail";
  rail.setAttribute("aria-label", "来源预览");
  const list = document.createElement("div");
  list.className = "source-inline-preview-list";

  for (const group of model.inlineGroups) {
    list.append(renderSourceInlineGroup(group));
  }
  rail.append(list);
  strip.append(rail);

  const actions = document.createElement("div");
  actions.className = "source-inline-actions";

  if (model.canExpand) {
    actions.append(
      renderSourceInlineMoreButton({
        drawerId: options.drawerId,
        isExpanded: options.isExpanded,
        remainingCount: model.remainingCount,
        videoCount: model.videoCount,
        occurrenceCount: model.occurrenceCount,
        rankCount: options.rankCount,
        rankMetric: options.rankMetric,
        mode: options.mode || "song",
      }),
    );
  }

  if (model.showCopyAll && !model.canExpand && options.showCopyAll !== false) {
    actions.append(renderInlineCopySongLinksButton(options.occurrences || []));
  }
  if (actions.childElementCount) strip.append(actions);

  return strip;
}

function renderSourceInlineGroup(group) {
  const item = group.item || group.occurrences?.[0]?.item || {};
  const firstOccurrence = group.occurrences?.[0];
  const videoId = item.videoId || group.videoId || "";
  const firstSeconds = firstOccurrence?.song?.seconds ?? group.firstSeconds ?? 0;
  const wrapper = document.createElement("span");
  wrapper.className = "source-inline-item";
  wrapper.dataset.videoId = videoId;

  if (firstOccurrence) {
    wrapper.append(renderSourceTimestampLink(firstOccurrence, "source-inline-time"));
  } else {
    const fallback = document.createElement("a");
    fallback.className = "source-link source-inline-time";
    fallback.href = youtubeTimeUrl(videoId, firstSeconds);
    fallback.target = "_blank";
    fallback.rel = "noreferrer";
    fallback.textContent = formatSeconds(firstSeconds);
    wrapper.append(fallback);
  }

  const extraTimes = (group.occurrences || []).slice(SOURCE_TIMESTAMP_INITIAL_LIMIT);
  if (extraTimes.length) {
    const extraTimesId = `source-inline-extra-${makeDomId(`${videoId}-${firstSeconds}-${group.channelName || ""}`)}`;
    const more = document.createElement("button");
    more.className = "source-inline-time-more";
    more.type = "button";
    more.dataset.toggleSourceTimes = "true";
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-controls", extraTimesId);
    more.setAttribute("aria-label", `显示另外 ${extraTimes.length} 个时间点`);
    more.title = `另外 ${extraTimes.length} 个时间点`;
    more.append(document.createTextNode(`+${extraTimes.length}`));
    const unit = document.createElement("span");
    unit.className = "source-inline-time-more-unit";
    unit.textContent = "时间点";
    more.append(unit);
    wrapper.append(more);

    const extra = document.createElement("span");
    extra.className = "source-extra-times source-inline-extra-times";
    extra.id = extraTimesId;
    extra.hidden = true;
    for (const occurrence of extraTimes) extra.append(renderSourceTimestampLink(occurrence, "source-inline-extra-time"));
    wrapper.append(extra);
  }

  const channelLink = window.FrontendUtils.youtubeChannelLink({ ...item, channelName: group.channelName });
  const channel = document.createElement("a");
  channel.className = "source-inline-channel";
  channel.href = channelLink.href;
  channel.target = "_blank";
  channel.rel = "noreferrer";
  channel.textContent = group.channelName || "未知频道";
  channel.setAttribute("aria-label", channelLink.isFallbackSearch ? `搜索频道：${channel.textContent}` : `打开频道：${channel.textContent}`);
  channel.title = channelLink.isFallbackSearch ? `搜索频道：${channel.textContent}` : `打开频道：${channel.textContent}`;
  wrapper.append(channel);

  wrapper.append(renderCopySetlistButton(item, "复制歌单", "source-inline-copy source-copy-icon ui-chip ui-chip-icon"));
  wrapper.title = [firstOccurrence ? formatSeconds(firstSeconds) : "", group.channelName || "未知频道", group.title || item.title || videoId].filter(Boolean).join(" · ");
  wrapper.setAttribute("aria-label", wrapper.title);
  return wrapper;
}

function renderSourceInlineMoreButton({
  drawerId,
  isExpanded,
  remainingCount = 0,
  videoCount = 0,
  occurrenceCount = 0,
  rankCount = 0,
  rankMetric = "occurrences",
  mode = "song",
}) {
  const button = document.createElement("button");
  button.className = "source-inline-more ui-chip";
  button.type = "button";
  button.dataset.toggleSource = "true";
  button.dataset.sourceSummaryToggle = "true";
  button.dataset.sourceMode = mode;
  button.dataset.remainingCount = String(remainingCount);
  button.dataset.videoCount = String(videoCount);
  button.dataset.occurrenceCount = String(occurrenceCount);
  button.dataset.rankCount = String(rankCount);
  button.dataset.rankMetric = rankMetric;
  button.setAttribute("aria-expanded", isExpanded ? "true" : "false");
  button.setAttribute("aria-controls", drawerId);
  updateSourceInlineMoreButton(button, isExpanded);
  return button;
}

function updateSourceInlineMoreButton(button, isExpanded) {
  const remaining = Math.max(0, Number(button.dataset.remainingCount) || 0);
  const label = isExpanded ? "收起" : `+${remaining}来源`;
  const fullLabel = isExpanded ? "收起其余来源" : `查看其余 ${remaining} 个来源`;
  button.textContent = label;
  button.title = fullLabel;
  button.setAttribute("aria-label", fullLabel);
}

function renderInlineCopySongLinksButton(occurrences) {
  const button = renderCopySongLinksButton(occurrences, "", "source-inline-copy-all source-copy-icon ui-chip ui-chip-icon");
  button.title = "复制全部链接";
  button.append(renderLinkListIcon());
  return button;
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

function renderSourceDrawer({ mode, occurrences, copyOccurrences = occurrences, songGroups = [], drawerId, isExpanded, getSongGroups = null }) {
  const drawer = document.createElement("div");
  drawer.className = mode === "artist" ? "source-drawer artist-song-drawer" : "source-drawer";
  drawer.id = drawerId;
  drawer.dataset.sourceMode = mode;
  drawer.dataset.sourceDeferred = "true";
  drawer.hidden = !isExpanded;
  drawer._getArtistSongGroups = getSongGroups;
  drawer._sourceOccurrences = occurrences || [];
  drawer._songSourceOccurrences = copyOccurrences || occurrences || [];
  if (isExpanded) {
    initializeSourceDrawer(drawer, {
      mode,
      occurrences,
      copyOccurrences,
      songGroups: songGroups.length ? songGroups : getSongGroups?.() || [],
    });
  }
  return drawer;
}

function initializeSourceDrawer(drawer, { mode, occurrences, copyOccurrences = occurrences, songGroups = [] }) {
  if (!drawer || drawer.dataset.sourceDeferred !== "true") return;
  if (mode === "artist") {
    appendArtistSongGroups(drawer, songGroups);
  } else {
    appendSourceDrawerLinks(drawer, occurrences, { showToolbar: true, copyOccurrences });
  }
  delete drawer.dataset.sourceDeferred;
}

function appendSourceDrawerContent(drawer, { mode, occurrences, songGroups = [] }) {
  initializeSourceDrawer(drawer, { mode, occurrences, songGroups });
}

function appendSourceDrawerLinks(drawer, occurrences, options = {}) {
  drawer._sourceOccurrences = occurrences;
  drawer._songSourceOccurrences = options.copyOccurrences || drawer._songSourceOccurrences || occurrences;
  const groups = window.FrontendUtils.groupOccurrencesByVideo(occurrences);
  drawer._sourceGroups = groups;
  if (options.toolbarVariant) drawer.dataset.toolbarVariant = options.toolbarVariant;
  const showAllOnOpen = drawer.dataset.sourceMode === "song" || drawer.dataset.sourceMode === "index" || drawer.dataset.sourceMode === "artist-song";
  const allGroups = window.FrontendUtils.groupOccurrencesByVideo(drawer._songSourceOccurrences || occurrences);
  const isRemainderDrawer = showAllOnOpen && allGroups.length > groups.length;
  drawer.dataset.sourceRemainder = isRemainderDrawer ? "true" : "false";
  const visibleCount = showAllOnOpen ? groups.length : sourceVisibleGroupCount(drawer, groups.length);
  if (showAllOnOpen) drawer.dataset.visibleSourceGroups = String(visibleCount);
  const shouldShowToolbar = options.showToolbar !== false;
  if (shouldShowToolbar && !drawer.querySelector(":scope > .source-drawer-toolbar")) {
    drawer.append(renderSourceDrawerToolbar(drawer, drawer._songSourceOccurrences, { visibleCount, totalCount: groups.length, remainder: isRemainderDrawer }));
  } else {
    updateSourceDrawerCount(drawer, visibleCount, groups.length);
  }

  appendSourceGroupRange(drawer, groups, sourceRenderedGroupCount(drawer), visibleCount);
  syncSourceGroupMoreButton(drawer, visibleCount, groups.length);
  appendMobileSourceCollapse(drawer);
}

function sourceRenderedGroupCount(drawer) {
  return drawer.querySelectorAll(":scope > .source-video-group").length;
}

function appendSourceGroupRange(drawer, groups, start, end) {
  const fragment = document.createDocumentFragment();
  const safeStart = Math.max(0, start);
  const safeEnd = Math.min(groups.length, Math.max(safeStart, end));
  let firstAppended = null;
  for (const group of groups.slice(safeStart, safeEnd)) {
    const node = renderSourceVideoGroup(group);
    if (!firstAppended) firstAppended = node;
    fragment.append(node);
  }
  const anchor = sourceGroupInsertAnchor(drawer);
  drawer.insertBefore(fragment, anchor);
  return firstAppended;
}

function sourceGroupInsertAnchor(drawer) {
  return drawer.querySelector(":scope > .source-group-more") || drawer.querySelector(":scope > .source-collapse-bottom") || null;
}

function syncSourceGroupMoreButton(drawer, visibleCount, totalCount) {
  let more = drawer.querySelector(":scope > .source-group-more");
  if (visibleCount >= totalCount) {
    more?.remove();
    return null;
  }
  const remaining = totalCount - visibleCount;
  if (!more) {
    more = document.createElement("button");
    more.className = "source-group-more ui-chip";
    more.type = "button";
    more.dataset.toggleSourceGroups = "true";
    drawer.insertBefore(more, drawer.querySelector(":scope > .source-collapse-bottom") || null);
  }
  more.textContent = `查看更多 ${remaining}个来源`;
  more.setAttribute("aria-label", `查看更多 ${remaining} 个来源`);
  return more;
}

function convertSourceGroupMoreToCollapse(button, drawer) {
  if (!button || !drawer) return null;
  delete button.dataset.toggleSourceGroups;
  button.dataset.collapseSource = "true";
  button.classList.remove("source-group-more");
  button.classList.add("source-collapse-bottom");
  button.disabled = false;
  button.removeAttribute("aria-busy");
  button.removeAttribute("aria-label");
  button.setAttribute("aria-label", "收起来源抽屉");
  button.setAttribute("aria-controls", drawer.id);
  button.textContent = "收起";
  return button;
}

function renderSourceDrawerToolbar(drawer, occurrences, options = {}) {
  const totalCount = Number.isFinite(options.totalCount)
    ? options.totalCount
    : window.FrontendUtils.groupOccurrencesByVideo(occurrences).length;
  const visibleCount = Number.isFinite(options.visibleCount) ? options.visibleCount : totalCount;
  const isRemainder = Boolean(options.remainder) || drawer.dataset.sourceRemainder === "true";
  const toolbar = document.createElement("div");
  toolbar.className = "source-drawer-toolbar";
  if (drawer.dataset.toolbarVariant === "artist") toolbar.classList.add("artist-source-toolbar");

  const count = document.createElement("span");
  count.className = "source-drawer-count";
  count.textContent = sourceDrawerCountText(visibleCount, totalCount, { remainder: isRemainder });
  toolbar.append(count);

  const actions = document.createElement("div");
  actions.className = "source-drawer-actions";
  actions.append(renderCopySongLinksButton(occurrences));
  actions.append(renderSourceCollapseButton(drawer.id, drawer.dataset.sourceMode || "song", "source-action source-collapse-top ui-chip"));
  toolbar.append(actions);
  return toolbar;
}

function updateSourceDrawerCount(drawer, visibleCount, totalCount) {
  const count = drawer.querySelector(":scope > .source-drawer-toolbar .source-drawer-count");
  if (count) count.textContent = sourceDrawerCountText(visibleCount, totalCount, { remainder: drawer.dataset.sourceRemainder === "true" });
}

function sourceDrawerCountText(visibleCount, totalCount, options = {}) {
  const suffix = options.remainder ? "个其余来源" : "个来源";
  if (visibleCount < totalCount) return `已显示 ${visibleCount}/${totalCount} ${suffix}`;
  return options.remainder ? `其余 ${totalCount} 个来源` : `${totalCount} 个来源`;
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
  if (!drawer.classList.contains("source-drawer")) return;
  const existing = drawer.querySelector(":scope > .source-collapse-bottom");
  if (drawer.querySelector(":scope > [data-toggle-source-groups]")) {
    existing?.remove();
    return;
  }
  if (!isCompactRankMode()) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const mode = drawer.dataset.sourceMode || "song";
  drawer.append(renderSourceCollapseButton(drawer.id, mode));
}

function renderSourceCollapseButton(drawerId, mode = "song", className = "source-collapse-bottom ui-chip") {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.dataset.collapseSource = "true";
  button.setAttribute("aria-controls", drawerId);
  button.setAttribute("aria-label", mode === "artist" ? "收起该歌手曲目" : "收起来源抽屉");
  button.textContent = "收起";
  return button;
}

function renderSourceVideoGroup(group) {
  const section = document.createElement("section");
  section.className = "source-video-group";

  const firstOccurrence = group.occurrences[0];
  const videoItem = group.item || firstOccurrence?.item || {};
  const videoId = videoItem.videoId || group.videoId || "";
  const firstSeconds = firstOccurrence?.song?.seconds || 0;

  const thumbLink = document.createElement("a");
  thumbLink.className = "source-video-thumb-link";
  thumbLink.href = youtubeTimeUrl(videoId, firstSeconds);
  thumbLink.target = "_blank";
  thumbLink.rel = "noreferrer";
  thumbLink.setAttribute("aria-label", `打开来源视频时间戳：${group.title || videoId || "来源视频"}`);
  thumbLink.append(createThumbnailImage({ ...videoItem, videoId, thumbnailUrl: videoItem.thumbnailUrl || group.thumbnailUrl }, "source-video-thumb", { preferCompact: true }));
  section.append(thumbLink);

  const main = document.createElement("div");
  main.className = "source-video-main";

  const topline = document.createElement("div");
  topline.className = "source-video-topline";

  const identity = document.createElement("div");
  identity.className = "source-video-identity";
  if (firstOccurrence) identity.append(renderSourceTimestampLink(firstOccurrence, "source-time-primary"));
  const extraTimes = group.occurrences.slice(SOURCE_TIMESTAMP_INITIAL_LIMIT);
  let extraTimesId = "";
  if (extraTimes.length) {
    extraTimesId = `source-extra-times-${makeDomId(`${videoId}-${firstSeconds}-${group.channelName || ""}`)}`;
    const more = document.createElement("button");
    more.className = "source-time-extra-toggle";
    more.type = "button";
    more.dataset.toggleSourceTimes = "true";
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-controls", extraTimesId);
    more.setAttribute("aria-label", `显示其余 ${extraTimes.length} 个时间点`);
    more.textContent = `+${extraTimes.length}`;
    identity.append(more);
  }

  const channelLink = window.FrontendUtils.youtubeChannelLink({ ...videoItem, channelName: group.channelName });
  const channel = document.createElement("a");
  channel.className = "source-video-channel";
  channel.href = channelLink.href;
  channel.target = "_blank";
  channel.rel = "noreferrer";
  channel.textContent = group.channelName || "未知频道";
  identity.append(channel);
  topline.append(identity);
  main.append(topline);

  const title = document.createElement("a");
  title.className = "source-video-title";
  title.href = youtubeTimeUrl(videoId, firstSeconds);
  title.target = "_blank";
  title.rel = "noreferrer";
  title.textContent = group.title || videoId || "来源视频";
  title.setAttribute("aria-label", `打开来源视频时间戳：${title.textContent}`);
  main.append(title);

  const extra = document.createElement("div");
  extra.className = "source-extra-times";
  if (extraTimesId) extra.id = extraTimesId;
  extra.hidden = true;
  for (const occurrence of extraTimes) extra.append(renderSourceTimestampLink(occurrence, "source-time-extra"));
  main.append(extra);
  section.append(main);

  section.append(renderCopySetlistIconButton(videoItem));
  return section;
}

function renderSourceTimestampLink(occurrence, className = "source-link source-time-link") {
  const link = document.createElement("a");
  link.className = className.includes("source-link") ? className : `source-link ${className}`;
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
  button.title = label || "复制歌单";
  button.setAttribute("aria-label", `复制该视频歌单：${item?.title || item?.videoId || "来源视频"}`);
  button.append(renderMusicNoteIcon());
  return button;
}

function renderCopySetlistIconButton(item) {
  return renderCopySetlistButton(item, "复制歌单", "source-copy-icon source-copy ui-chip ui-chip-icon");
}

function renderMusicNoteIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const paths = ["M9 18V5l10-2v13", "M9 9l10-2", "M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3Zm10-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3Z"];
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function renderCopySongLinksButton(occurrences, label = "复制全部链接", className = "source-action source-copy-all ui-chip") {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.dataset.copySongLinks = "true";
  button._sourceOccurrences = occurrences || [];
  button.textContent = label;
  button.setAttribute("aria-label", "复制同一首歌全部来源时间点链接");
  return button;
}

function renderCopySongLinksIconButton(occurrences) {
  const button = renderCopySongLinksButton(occurrences, "", "artist-song-copy source-copy-icon ui-chip");
  button.title = "复制全部链接";
  button.append(renderLinkListIcon());
  return button;
}

function renderLinkListIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const paths = ["M10 13a5 5 0 0 0 7.1 0l1.4-1.4a5 5 0 0 0-7.1-7.1L10.6 5.3", "M14 11a5 5 0 0 0-7.1 0L5.5 12.4a5 5 0 0 0 7.1 7.1l.8-.8", "M8 16l8-8"];
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function appendArtistSongGroups(drawer, songGroups) {
  drawer._artistSongGroups = songGroups;
  const visibleCount = artistVisibleSongCount(drawer, songGroups.length);
  appendArtistSongGroupRange(drawer, songGroups, artistRenderedSongCount(drawer), visibleCount);
  syncArtistSongMoreButton(drawer, visibleCount, songGroups.length);
  appendMobileSourceCollapse(drawer);
}

function artistRenderedSongCount(drawer) {
  return drawer.querySelectorAll(":scope > .artist-song-group").length;
}

function artistVisibleSongCount(drawer, total) {
  const parsed = Number.parseInt(drawer.dataset.visibleArtistSongs || "", 10);
  const requested = Number.isFinite(parsed) && parsed > 0 ? parsed : ARTIST_SONG_GROUP_INITIAL_LIMIT;
  const visibleCount = Math.min(total, Math.max(ARTIST_SONG_GROUP_INITIAL_LIMIT, requested));
  drawer.dataset.visibleArtistSongs = String(visibleCount);
  return visibleCount;
}

function appendArtistSongGroupRange(drawer, songGroups, start, end) {
  const fragment = document.createDocumentFragment();
  const safeStart = Math.max(0, start);
  const safeEnd = Math.min(songGroups.length, Math.max(safeStart, end));
  let firstAppended = null;
  for (const group of songGroups.slice(safeStart, safeEnd)) {
    const node = renderArtistSongGroup(group);
    if (!firstAppended) firstAppended = node;
    fragment.append(node);
  }
  drawer.insertBefore(fragment, drawer.querySelector(":scope > .artist-song-more") || drawer.querySelector(":scope > .source-collapse-bottom") || null);
  return firstAppended;
}

function renderArtistSongGroup(group) {
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

  const meta = document.createElement("div");
  meta.className = "artist-song-summary-actions";

  const count = document.createElement("span");
  count.className = "artist-song-count";
  count.textContent = `${group.count}次`;
  meta.append(count);

  const sources = document.createElement("div");
  sources.className = "artist-song-sources";
  sources.id = `artist-song-sources-${makeDomId(`${group.key}-${firstOccurrence.item.videoId}`)}`;
  sources.dataset.sourceMode = "artist-song";
  sources.dataset.sourceDeferred = "true";
  sources.hidden = true;
  section._artistSongSources = sources;

  const sourcePresentation = window.FrontendUtils.sourcePresentationModel(group.occurrences, {
    expanded: false,
    inlineLimit: SOURCE_INLINE_LIMIT,
  });
  sources._sourceOccurrences = sourcePresentation.hiddenGroups.flatMap((sourceGroup) => sourceGroup.occurrences);
  sources._songSourceOccurrences = group.occurrences;

  meta.append(renderCopySongLinksIconButton(group.occurrences));
  header.append(meta);
  section.append(header);
  section.append(
    renderSourceInlineStrip(sourcePresentation, {
      drawerId: sources.id,
      isExpanded: false,
      occurrences: group.occurrences,
      mode: "artist-song",
      rankCount: group.count,
      rankMetric: "occurrences",
      showCopyAll: false,
    }),
  );
  if (sourcePresentation.canExpand) section.append(sources);
  return section;
}

function syncArtistSongMoreButton(drawer, visibleCount, totalCount) {
  let more = drawer.querySelector(":scope > .artist-song-more");
  if (visibleCount >= totalCount) {
    more?.remove();
    return null;
  }
  const remaining = totalCount - visibleCount;
  const batch = Math.min(ARTIST_SONG_GROUP_BATCH_SIZE, remaining);
  if (!more) {
    more = document.createElement("button");
    more.className = "artist-song-more";
    more.type = "button";
    more.dataset.toggleArtistSongs = "true";
    drawer.insertBefore(more, drawer.querySelector(":scope > .source-collapse-bottom") || null);
  }
  more.textContent = `再显示 ${batch} 首（剩余 ${remaining} 首）`;
  more.setAttribute("aria-label", `再显示 ${batch} 首歌曲，剩余 ${remaining} 首`);
  return more;
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

  if (nextExpanded && drawer.dataset.sourceDeferred === "true") {
    const mode = row.dataset.drawerMode || drawer.dataset.sourceMode || "song";
    const songGroups =
      mode === "artist" ? row._artistSongGroups || row._getArtistSongGroups?.() || [] : row._artistSongGroups || [];
    if (mode === "artist") row._artistSongGroups = songGroups;
    const drawerOccurrences = mode === "artist" ? row._sourceOccurrences || [] : row._sourceDetailOccurrences || row._sourceOccurrences || [];
    initializeSourceDrawer(drawer, {
      mode,
      occurrences: drawerOccurrences,
      copyOccurrences: row._sourceOccurrences || drawerOccurrences,
      songGroups,
    });
  }
  if (nextExpanded) appendMobileSourceCollapse(drawer);
  drawer.hidden = !nextExpanded;
  row.classList.toggle("is-expanded", nextExpanded);
  for (const button of buttons) {
    button.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
    if (button.dataset.sourceSummaryToggle === "true") {
      updateSourceInlineMoreButton(button, nextExpanded);
      continue;
    }
    const count = row._sourceOccurrences?.length || 0;
    const total = Number(button.dataset.sourceTotal || count);
    const hiddenCount = Number(button.dataset.sourceHiddenCount || 0);
    const songCount = Number(button.dataset.songCount || row._artistSongCount || row._artistSongGroups?.length || 0);
    const videoCount = Number(button.dataset.videoCount || window.FrontendUtils.groupOccurrencesByVideo(row._sourceOccurrences || []).length);
    const occurrenceCount = Number(button.dataset.occurrenceCount || count);
    const rankCount = Number(button.dataset.rankCount || 0);
    const rankMetric = button.dataset.rankMetric || "occurrences";
    const mode = button.dataset.sourceMode || row.dataset.drawerMode || "song";
    const model = window.FrontendUtils.rankToggleModel({
      mode,
      isExpanded: nextExpanded,
      total,
      hiddenCount,
      songCount,
      videoCount,
      occurrenceCount,
      rankCount,
      rankMetric,
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
  trackCompactInitializedDrawer(row, nextExpanded);

  if (!nextExpanded && options.keepVisible) {
    window.requestAnimationFrame(() => keepSourceRowVisible(row));
  }
}

function trackCompactInitializedDrawer(row, isExpanded) {
  if (!row || !isCompactRankMode()) return;
  const key = row.dataset.rowKey;
  if (!key) return;
  state.compactDrawerLru = [key, ...state.compactDrawerLru.filter((value) => value !== key)].slice(0, 20);
  if (isExpanded) {
    pruneCompactInitializedDrawers(row);
    return;
  }
  pruneCompactInitializedDrawers();
}

function pruneCompactInitializedDrawers(currentRow = null) {
  if (!isCompactRankMode()) return;
  const rows = Array.from(els.content?.querySelectorAll(".rank-row, .index-row") || []);
  const keep = new Set();
  if (currentRow?.dataset?.rowKey) keep.add(currentRow.dataset.rowKey);
  for (const row of rows) {
    if (row.classList.contains("is-expanded") && row.dataset.rowKey) keep.add(row.dataset.rowKey);
  }
  for (const key of state.compactDrawerLru) {
    if (keep.size >= MAX_COMPACT_INITIALIZED_DRAWERS) break;
    keep.add(key);
  }
  for (const row of rows) {
    const key = row.dataset.rowKey;
    if (!key || keep.has(key) || row.classList.contains("is-expanded")) continue;
    resetSourceDrawerToDeferred(row);
  }
  state.compactDrawerLru = state.compactDrawerLru.filter((key) => keep.has(key));
}

function resetSourceDrawerToDeferred(row) {
  const drawer = row?.querySelector(".source-drawer");
  if (!drawer || drawer.dataset.sourceDeferred === "true" || !drawer.hidden) return;
  drawer.replaceChildren();
  drawer.dataset.sourceDeferred = "true";
  delete drawer.dataset.visibleSourceGroups;
  delete drawer.dataset.visibleArtistSongs;
  delete drawer.dataset.lastMoreScrollY;
  delete drawer.dataset.lastMoreScrollDelta;
  delete drawer._sourceGroups;
  delete drawer._songSourceOccurrences;
  delete drawer._sourceOccurrences;
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
  const current = artistRenderedSongCount(drawer);
  const nextVisible = Math.min(songGroups.length, current + ARTIST_SONG_GROUP_BATCH_SIZE);
  drawer.dataset.visibleArtistSongs = String(nextVisible);
  const firstNewGroup = appendArtistSongGroupRange(drawer, songGroups, current, nextVisible);
  syncArtistSongMoreButton(drawer, nextVisible, songGroups.length);
  appendMobileSourceCollapse(drawer);
  window.requestAnimationFrame(() => focusWithoutScrolling(firstNewGroup || drawer));
}

function toggleArtistSongSource(button) {
  const section = button.closest(".artist-song-group");
  const sources = document.getElementById(button.getAttribute("aria-controls")) || section?._artistSongSources;
  if (!section || !sources) return;
  const nextExpanded = sources.hidden;
  if (nextExpanded && isCompactRankMode()) closeSiblingArtistSongSources(section);
  if (nextExpanded && sources.dataset.sourceDeferred === "true") {
    appendSourceDrawerLinks(sources, sources._sourceOccurrences || [], {
      copyOccurrences: sources._songSourceOccurrences || sources._sourceOccurrences || [],
      showToolbar: false,
    });
    delete sources.dataset.sourceDeferred;
  }
  sources.hidden = !nextExpanded;
  section.classList.toggle("is-expanded", nextExpanded);
  button.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
  if (button.dataset.sourceSummaryToggle === "true") updateSourceInlineMoreButton(button, nextExpanded);
  else updateArtistSongSourceButton(button, nextExpanded);
}

function closeSiblingArtistSongSources(section) {
  const drawer = section.closest(".artist-song-drawer");
  const siblings = drawer?.querySelectorAll(":scope > .artist-song-group.is-expanded") || [];
  for (const sibling of siblings) {
    if (sibling === section) continue;
    const button = sibling.querySelector("[data-toggle-artist-song-source]");
    const sources = sibling.querySelector(".artist-song-sources");
    if (sources) sources.hidden = true;
    sibling.classList.remove("is-expanded");
    if (button) {
      button.setAttribute("aria-expanded", "false");
      if (button.dataset.sourceSummaryToggle === "true") updateSourceInlineMoreButton(button, false);
      else updateArtistSongSourceButton(button, false);
    }
  }
}

function updateArtistSongSourceButton(button, isExpanded) {
  const videoCount = Math.max(0, Number(button.dataset.sourceVideoCount) || 0);
  const occurrenceCount = Math.max(0, Number(button.dataset.occurrenceCount) || 0);
  const model = window.FrontendUtils.compactSourceToggleModel({
    isExpanded,
    rankMetric: "occurrences",
    videoCount,
    occurrenceCount,
  });
  button.textContent = model.text;
  button.setAttribute(
    "aria-label",
    isExpanded
      ? "收起这首歌的来源"
      : model.kind === "source"
        ? `查看这首歌的 ${videoCount} 个来源视频`
        : `查看这首歌的 ${occurrenceCount} 个时间点`,
  );
}

function expandSourceGroupTimestamps(button) {
  const group = button.closest(".source-video-group");
  if (!group) return;
  const panel = document.getElementById(button.getAttribute("aria-controls")) || group.querySelector(".source-extra-times");
  if (!panel) return;
  const expanded = button.getAttribute("aria-expanded") === "true";
  const nextExpanded = !expanded;
  button.setAttribute("aria-expanded", String(nextExpanded));
  const count = panel.querySelectorAll("a").length;
  button.setAttribute("aria-label", `${nextExpanded ? "收起" : "显示"}其余 ${count} 个时间点`);
  button.textContent = `${nextExpanded ? "−" : "+"}${count}`;
  panel.hidden = expanded;
}

async function expandSourceVideoGroups(button) {
  const drawer = button.closest(".artist-song-sources, .source-drawer");
  if (!drawer) return;
  const occurrences = drawer._sourceOccurrences || [];
  const groups = drawer._sourceGroups || window.FrontendUtils.groupOccurrencesByVideo(occurrences);
  const current = Math.min(sourceRenderedGroupCount(drawer), groups.length);
  const nextVisible = groups.length;
  const scrollBefore = Math.round(window.scrollY || 0);
  const remaining = Math.max(0, nextVisible - current);
  const originalText = button.textContent;
  const originalLabel = button.getAttribute("aria-label");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = `正在展开${remaining}个来源…`;
  drawer.setAttribute("aria-busy", "true");
  let firstNewGroup = null;
  try {
    for (let start = current; start < nextVisible; start += SOURCE_EXPAND_CHUNK_SIZE) {
      const end = Math.min(nextVisible, start + SOURCE_EXPAND_CHUNK_SIZE);
      const appended = appendSourceGroupRange(drawer, groups, start, end);
      if (!firstNewGroup) firstNewGroup = appended;
      if (end < nextVisible) await yieldToBrowser();
    }
  } catch (error) {
    button.textContent = originalText;
    if (originalLabel) button.setAttribute("aria-label", originalLabel);
    throw error;
  } finally {
    drawer.removeAttribute("aria-busy");
    button.removeAttribute("aria-busy");
    button.disabled = false;
  }
  drawer.dataset.visibleSourceGroups = String(nextVisible);
  updateSourceDrawerCount(drawer, nextVisible, groups.length);
  convertSourceGroupMoreToCollapse(button, drawer);
  drawer.dataset.lastMoreScrollY = String(scrollBefore);
  drawer.dataset.lastMoreScrollDelta = String(Math.round((window.scrollY || 0) - scrollBefore));
  window.requestAnimationFrame(() => {
    focusWithoutScrolling(button.isConnected ? button : firstNewGroup || drawer);
  });
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

  thumbLink.append(createThumbnailImage(item, "thumb"));
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
  headingActions.append(count, renderCopySetlistButton(item, "复制歌单", "video-copy-setlist ui-chip ui-chip-icon"));
  heading.append(headingActions);
  body.append(heading);

  const list = document.createElement("ol");
  list.className = "song-list";
  list.id = `video-songs-${makeDomId(item.videoId || item.title)}`;
  const songs = item._displaySongs || item.songs || [];

  if (songs.length > 3) {
    const topMore = document.createElement("button");
    topMore.className = "video-more video-more-top";
    topMore.type = "button";
    topMore.dataset.toggleVideoSongs = "true";
    topMore.setAttribute("aria-expanded", "false");
    topMore.setAttribute("aria-controls", list.id);
    topMore.hidden = true;
    topMore.textContent = "收起歌曲";
    body.append(topMore);
  }

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
  const button = card.querySelector(".video-more:not(.video-more-top)");
  const buttons = Array.from(card.querySelectorAll(".video-more"));
  const nextExpanded = button.getAttribute("aria-expanded") !== "true";
  if (nextExpanded && card._remainingSongs?.length) {
    appendVideoSongLinks(card._songList, card._videoItem, card._remainingSongs, "video-song-extra");
    card._remainingSongs = [];
  }

  const extras = Array.from(card.querySelectorAll(".video-song-extra"));

  for (const item of extras) item.hidden = !nextExpanded;
  for (const control of buttons) {
    control.hidden = control.classList.contains("video-more-top") ? !nextExpanded : false;
    control.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
    control.textContent = nextExpanded ? "收起歌曲" : `展开其余 ${extras.length} 首`;
  }
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
  return trendForKey(mode, record?.key);
}

function trendForKey(mode, key) {
  if (!isLatestSnapshot() || state.rankMetric !== "occurrences") return null;
  const diff = state.rankDiffs?.[state.range]?.[mode];
  if (!(diff instanceof Map)) return null;
  return diff.get(key) || null;
}

function renderTrendBadge(trend) {
  const model = window.FrontendUtils.trendDisplayModel(trend);
  if (!model) return null;
  const badge = document.createElement("span");
  badge.className = `trend-badge trend-${model.kind}`;
  badge.textContent = model.text;
  badge.title = model.title;
  badge.setAttribute("aria-label", model.ariaLabel);
  return badge;
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
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${safeSeconds}s`;
}

function videoThumbnailCandidates(item, options = {}) {
  const videoId = item.videoId ? encodeURIComponent(item.videoId) : "";
  const mqdefault = videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : "";
  const hqdefault = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
  const preferred = options.preferCompact ? [mqdefault, item.thumbnailUrl, hqdefault] : [item.thumbnailUrl, mqdefault, hqdefault];
  return uniqueStrings([...preferred, placeholderThumbnail()]);
}

function createThumbnailImage(item, className, optionsOrWidth = {}, height = 90) {
  const options = typeof optionsOrWidth === "object" && optionsOrWidth !== null ? optionsOrWidth : {};
  const width = typeof optionsOrWidth === "number" ? optionsOrWidth : options.width || 160;
  const resolvedHeight = typeof optionsOrWidth === "number" ? height : options.height || 90;
  const img = document.createElement("img");
  img.className = className;
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.width = width;
  img.height = resolvedHeight;
  const thumbnailCandidates = videoThumbnailCandidates(item || {}, options);
  let thumbnailIndex = 0;
  img.src = thumbnailCandidates[thumbnailIndex] || placeholderThumbnail();
  img.addEventListener("error", () => {
    thumbnailIndex += 1;
    if (thumbnailIndex < thumbnailCandidates.length) img.src = thumbnailCandidates[thumbnailIndex];
  });
  return img;
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
    timeZone: DISPLAY_TIME_ZONE,
    year: "numeric",
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
    year: parts.year,
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
