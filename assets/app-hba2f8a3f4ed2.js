const VIEWS = {
  songRank: "歌曲榜",
  artistRank: "歌手榜",
  vtuberRank: "VTuber频道",
  songAz: "歌曲索引",
  videos: "视频",
};

const RANGE_LABELS = {
  "7d": "最近7天",
  all: "本月",
};
const RANGE_ALIASES = {
  "72h": "7d",
  "1m": "all",
};
const LEGACY_RANGE_IDS = {
  "7d": ["72h"],
  all: ["1m"],
};

const SNAPSHOT_LATEST_PATH = "data/latest.json";
const UI_META_PATH = "data/ui/meta.json";
const API_META_PATH = "/api/meta";
const API_RANKINGS_PATH = "/api/rankings";
const STATUS_PATH = "data/status.json";
const SONG_SEARCH_INDEX_PATH = "data/song-search-known-songs.json";
const SNAPSHOT_CACHE_LIMIT = 5;
const SEARCH_DEBOUNCE_MS = 140;
const QUERY_PREVIEW_INPUT_DEBOUNCE_MS = 520;
const QUERY_SUGGESTION_SCAN_LIMIT = 360;
const ARTIST_SONG_GROUP_INITIAL_LIMIT = 8;
const ARTIST_SONG_GROUP_BATCH_SIZE = 8;
const SOURCE_TIMESTAMP_INITIAL_LIMIT = 3;
const SOURCE_TIMESTAMP_DEDUP_WINDOW_SECONDS = 30;
const SOURCE_INLINE_LIMITS = {
  mobile: 2,
  tablet: 3,
  desktop: 3,
};
const MAX_COMPACT_INITIALIZED_DRAWERS = 3;
// Keep these breakpoints synchronized with assets/styles.css:
// mobile <= 720px, tablet 721-919px, desktop >= 920px.
const RESPONSIVE_BREAKPOINTS = {
  mobileMax: 720,
  tabletMax: 919,
};
const MOBILE_PAGE_SIZE = 20;
const DESKTOP_PAGE_SIZE = 30;
const LIST_PAGE_SIZE_OPTIONS = [MOBILE_PAGE_SIZE, DESKTOP_PAGE_SIZE];
const DEFAULT_LIST_PAGE_SIZE = DESKTOP_PAGE_SIZE;
const VIDEO_PAGE_SIZE = DESKTOP_PAGE_SIZE;
const LIST_PAGE_SIZE_BY_MODE = {
  mobile: MOBILE_PAGE_SIZE,
  tablet: MOBILE_PAGE_SIZE,
  desktop: DESKTOP_PAGE_SIZE,
};
const SOURCE_DRAWER_PAGE_SIZE_BY_MODE = {
  mobile: MOBILE_PAGE_SIZE,
  tablet: MOBILE_PAGE_SIZE,
  desktop: DESKTOP_PAGE_SIZE,
};
const VTUBER_SONG_GROUP_INITIAL_LIMIT = MOBILE_PAGE_SIZE;
const VTUBER_SONG_GROUP_BATCH_SIZE = MOBILE_PAGE_SIZE;
const CURRENT_FILTER_VERSION = 4;
const RANK_METRICS = {
  occurrences: "次数",
  songs: "歌曲数",
  videos: "视频数",
};
const VTUBER_CHANNEL_EVIDENCE_BY_VIDEO_ID = new Map([
  ["27ciaztchCQ", "/@mizusawa_opera"],
  ["P9HZGLHFi5c", "/@mokankamo"],
  ["jOzbHf8nHYA", "/@mikumitani"],
  ["ByaypQqmirQ", "/@FujiotoKanade"],
]);
const SEARCH_SCOPES = {
  all: "全部字段",
  song: "歌曲/歌手",
  title: "标题",
  artist: "歌手",
  channel: "频道",
  video: "视频",
  source: "来源",
};
const SEARCH_FIELDS = {
  title: "歌名",
  artist: "歌手",
  channel: "频道",
  video: "视频",
};
const DEFAULT_SEARCH_FIELDS = ["title", "artist", "channel"];
const VIEW_RANK_METRIC_ORDER = {
  songRank: ["occurrences", "videos"],
  artistRank: ["occurrences", "videos"],
  vtuberRank: ["occurrences", "songs", "videos"],
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
  vtuberRank: DEFAULT_LIST_PAGE_SIZE,
  songAz: DEFAULT_LIST_PAGE_SIZE,
  videos: VIDEO_PAGE_SIZE,
};
const INDEX_ALL_BUCKET = "全部";
const DISPLAY_TIME_ZONE = "Asia/Shanghai";
const DEBUG_MODE = new URLSearchParams(window.location.search).get("debug") === "1";
let pageInputRestoreToken = 0;
let pageInputInteractionToken = 0;
let pageInputPointerActive = false;

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
  range: "7d",
  rangeIntent: "7d",
  initializationMetaPending: true,
  view: "songRank",
  filter: "",
  searchScope: "all",
  searchFields: [...DEFAULT_SEARCH_FIELDS],
  nicheOnly: false,
  hideUnknownArtist: false,
  indexBucket: INDEX_ALL_BUCKET,
  pageSize: defaultListPageSizeForMode(),
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
  sourceDetailCache: new Map(),
  sourceDetailLoads: new Map(),
  requestRuntime: {
    summaryCache: new Map(),
    viewManifestCache: new Map(),
    viewIndexCache: new Map(),
    detailShardCache: new Map(),
    searchManifestCache: new Map(),
    searchShardCache: new Map(),
    pageResultCache: new Map(),
    disabledRanges: new Set(),
    activeController: null,
    revision: 0,
    lastResult: null,
  },
  runtimeApi: {
    available: false,
    meta: null,
  },
  loadedResources: [],
  compactDrawerLru: [],
  firstContentMeasured: false,
  eventsBound: false,
  activeOverlay: "",
  overlayTrigger: null,
  queryDraft: null,
  queryPreviewTimer: 0,
  queryPreviewController: null,
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
  querySearchForm: document.querySelector("#querySearchForm"),
  queryTrigger: document.querySelector("#queryTrigger"),
  queryTriggerText: document.querySelector("#queryTriggerText"),
  queryFieldBar: document.querySelector(".query-field-bar"),
  queryDialog: document.querySelector("#queryDialog"),
  queryPanel: document.querySelector("#queryDialog .query-panel"),
  queryInput: document.querySelector("#queryInput"),
  searchFieldToggles: Array.from(document.querySelectorAll("input[name='searchField']")),
  nicheOnlyToggle: document.querySelector("#nicheOnlyToggle"),
  hideUnknownToggle: document.querySelector("#hideUnknownToggle"),
  cancelQueryButton: document.querySelector("#cancelQueryButton"),
  clearQueryButton: document.querySelector("#clearQueryButton"),
  applyQueryButton: document.querySelector("#applyQueryButton"),
  resetQueryButton: document.querySelector("#resetQueryButton"),
  queryResultPreview: document.querySelector("#queryResultPreview"),
  metricFilterGroup: document.querySelector("#metricFilterGroup"),
  displayFilterGroup: document.querySelector("#displayFilterGroup"),
  trendFilterGroup: document.querySelector("#trendFilterGroup"),
  trendFilterSelect: document.querySelector("#trendFilterSelect"),
  trendFilterHint: document.querySelector("#trendFilterHint"),
  minCountFilterGroup: document.querySelector("#minCountFilterGroup"),
  minCountSelect: document.querySelector("#minCountSelect"),
  queryPageSizeSelect: document.querySelector("#queryPageSizeSelect"),
  queryHistorySection: document.querySelector(".query-history-section"),
  querySnapshotDateSelect: document.querySelector("#querySnapshotDateSelect"),
  querySnapshotSelect: document.querySelector("#querySnapshotSelect"),
  querySnapshotSummary: document.querySelector("#querySnapshotSummary"),
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
    rangePath: runtimeRangeMeta(state.range)?.path || "",
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
  state.rangeIntent = canonicalRangeId(state.range);
  state.initializationMetaPending = true;
  bindEvents();
  syncControlsFromState();
  setupBackToTopButton();
  setSnapshotBusy(true, "正在载入数据");
  renderInitialSkeleton();
  await yieldToBrowser();
  const initialRange = state.range;
  const apiMetaPromise = measureAsync("fetch-api-meta", () => readJson(API_META_PATH, { cache: "no-cache" })).catch(() => null);
  const statusPromise = readJson(STATUS_PATH, { cache: "no-cache" }).catch(() => null);
  const snapshotIndexPromise = readJson("data/snapshots/index.json").catch(() => ({ snapshots: [] }));
  const apiMeta = await apiMetaPromise;
  if (isRuntimeApiMeta(apiMeta)) {
    state.runtimeApi.available = true;
    state.runtimeApi.meta = apiMeta;
    state.runtimeMeta = runtimeMetaFromApiMeta(apiMeta);
  } else {
    const staticMetaResult = await measureAsync("fetch-meta", () => readJson(UI_META_PATH, { cache: "no-cache" })).catch((error) => ({ __error: error }));
    const staticMeta = staticMetaResult && !staticMetaResult.__error ? staticMetaResult : null;
    if (!staticMeta) {
      throw staticMetaResult?.__error || new Error("runtime meta missing");
    }
    state.runtimeMeta = staticMeta;
  }
  const meta = state.runtimeMeta;
  state.initializationMetaPending = false;
  const requestedRange = canonicalRangeId(state.rangeIntent || initialRange);
  state.range = requestedRange;
  state.status = mergeRuntimeStatus(meta.status || null, await statusPromise, meta);
  startStatusTicker();
  renderStatus(state.status);
  const snapshotIndex = await snapshotIndexPromise;
  state.snapshots = Array.isArray(snapshotIndex.snapshots) ? snapshotIndex.snapshots : [];
  renderSnapshotOptions();
  applyInitialUrlState();
  normalizeTrendStateForRuntime();
  syncControlsFromState();
  const requestedSnapshotPath = state.currentSnapshotPath;
  setActiveTab(els.rangeTabs, els.rangeTabs.find((tab) => tab.dataset.range === requestedRange) || els.rangeTabs[0]);
  if (requestedSnapshotPath === SNAPSHOT_LATEST_PATH && canUseRequestRuntime(requestedRange)) {
    applyRequestRuntimeShell();
    render({ syncUrl: false });
  } else {
    const rangePayload = await measureAsync("fetch-active-range", () => loadRuntimeRange(requestedRange));
    const activeRange = canonicalRangeId(state.rangeIntent || state.range || requestedRange);
    if (activeRange !== requestedRange) await loadRuntimeRange(activeRange);
    const activePayload = state.runtimeRangePayloads.get(activeRange) || rangePayload;
    if (isCurrentRangeIntent(activeRange)) {
      await applyRuntimeRangePayload(activePayload, {
        resetPage: false,
        syncUrl: false,
        expectedRange: activeRange,
      });
    }
  }
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
      state.rankMetric = rankMetricForView(state.view, rankMetric.dataset.rankMetric || "occurrences");
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
    const link = event.target.closest("a[href]");
    if (
      link?.dataset.rankSearchLink === "true" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      window.location.assign(link.href);
      return;
    }
    if (link && handleContentLinkNavigation(event, link)) return;

    const copySetlist = event.target.closest("[data-copy-setlist]");
    if (copySetlist) {
      event.preventDefault();
      event.stopPropagation();
      copyVideoSetlist(copySetlist._videoItem, { button: copySetlist }).catch((error) => showToast(`复制失败：${error.message}`));
      return;
    }

    const copySongLinks = event.target.closest("[data-copy-song-links]");
    if (copySongLinks) {
      event.preventDefault();
      event.stopPropagation();
      copySongSourceLinksFromButton(copySongLinks).catch((error) => showToast(`复制失败：${error.message}`));
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

    const sourcePageButton = event.target.closest("[data-source-page]");
    if (sourcePageButton) {
      event.preventDefault();
      setSourceDrawerPage(sourcePageButton).catch((error) => showToast(`来源翻页失败：${error.message}`));
      return;
    }

    const sourcePageSubmit = event.target.closest("[data-source-page-submit]");
    if (sourcePageSubmit) {
      event.preventDefault();
      submitSourceDrawerPageForm(sourcePageSubmit.closest("[data-source-page-form]")).catch((error) =>
        showToast(`来源翻页失败：${error.message}`),
      );
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
      toggleArtistSongLimit(artistMore);
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
        toggleArtistSongSource(sourceToggle).catch((error) => showToast(`展开来源失败：${error.message}`));
        return;
      }
      toggleSourceDrawer(sourceToggle.closest(".rank-row, .index-row"));
      return;
    }

    if (link) return;
  });

  els.content.addEventListener("change", (event) => {
    const bucketSelect = event.target.closest("[data-index-bucket-select]");
    if (bucketSelect) {
      state.indexBucket = bucketSelect.value || INDEX_ALL_BUCKET;
      state.expandedRows.clear();
      resetPagination();
      render({ focusAfterPageChange: true, urlMode: "push" });
    }
  });

  els.content.addEventListener("submit", (event) => {
    const sourceForm = event.target.closest("[data-source-page-form]");
    if (!sourceForm) return;
    event.preventDefault();
    submitSourceDrawerPageForm(sourceForm).catch((error) => showToast(`来源翻页失败：${error.message}`));
  });

  els.content.addEventListener("submit", (event) => {
    if (event.defaultPrevented || !event.target.closest("[data-page-form]")) return;
    handlePaginationFormSubmit(event);
  });

  els.content.addEventListener("submit", (event) => {
    if (event.defaultPrevented || !event.target.closest("[data-page-jump-form]")) return;
    handlePaginationFormSubmit(event);
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
      toggleArtistSongSource(artistSongSource).catch((error) => showToast(`展开来源失败：${error.message}`));
      return;
    }

    const link = event.target.closest("a[href]");
    if (link) return;
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
  state.rankMetric = rankMetricForView(nextView, state.rankMetric);
  state.expandedRows.clear();
  resetPagination();
  syncControlsFromState();
  renderOrSyncUrl({ urlMode: options.urlMode || "push" });
  restoreViewPosition();
}

function handleContentLinkNavigation(event, link) {
  if (!link || link.dataset.rankSearchLink === "true" || event.defaultPrevented || !isSourceOrVideoContentLink(link)) return false;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  event.preventDefault();
  window.open(link.href, "_blank", "noopener,noreferrer");
  return true;
}

function isSourceOrVideoContentLink(link) {
  return Boolean(
    link.closest(".source-inline-strip, .source-drawer, .inline-source, .video-card, .artist-song-group-vtuber") ||
      link.matches(
        ".source-link, .source-video-title, .source-video-thumb-link, .source-inline-channel, .video-title, .thumb-link, .video-song-link, .artist-song-title, .artist-song-thumb, .vtuber-title-link, .vtuber-display-link",
      ),
  );
}

function bindQueryOverlayEvents() {
  const querySubmitButton = els.querySearchForm?.querySelector(".query-submit-button");
  querySubmitButton?.addEventListener("click", (event) => {
    if (cleanText(els.queryInput?.value) || document.activeElement === els.queryInput) return;
    event.preventDefault();
    focusWithoutScrolling(els.queryInput);
  });
  els.querySearchForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const submittedBySearchButton =
      event.submitter?.classList?.contains("query-submit-button") ||
      document.activeElement?.classList?.contains("query-submit-button");
    if (submittedBySearchButton && !cleanText(els.queryInput?.value) && document.activeElement !== els.queryInput) {
      focusWithoutScrolling(els.queryInput);
      return;
    }
    applyQueryDraft().catch((error) => showToast(`查询应用失败：${error.message}`));
  });
  els.queryTrigger?.addEventListener("click", () => openQueryOverlay(els.queryTrigger));
  els.cancelQueryButton?.addEventListener("click", () => closeOverlay("query"));
  els.queryDialog?.querySelector("[data-close-overlay='query']")?.addEventListener("click", () => closeOverlay("query"));
  els.clearQueryButton?.addEventListener("click", () => {
    updateQueryDraft({ q: "" }, { sync: "input" });
    if (els.queryInput) els.queryInput.focus();
  });
  els.queryInput?.addEventListener("compositionstart", () => {
    state.queryComposing = true;
  });
  els.queryInput?.addEventListener("compositionend", () => {
    state.queryComposing = false;
    updateQueryDraft({ q: els.queryInput.value }, { sync: "input", schedule: false });
  });
  els.queryInput?.addEventListener("input", (event) => {
    if (event.isComposing || state.queryComposing) return;
    updateQueryDraft({ q: els.queryInput.value }, {
      sync: "input",
      schedule: false,
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
  for (const element of [
    els.nicheOnlyToggle,
    els.hideUnknownToggle,
    els.trendFilterSelect,
    els.minCountSelect,
    els.queryPageSizeSelect,
    els.querySnapshotSelect,
  ]) {
    element?.addEventListener("change", () => {
      setQueryDraft(readQueryDraftFromControls(), { sync: "controls" });
    });
  }
  for (const element of els.searchFieldToggles) {
    element.addEventListener("change", () => {
      setQueryDraft(readQueryDraftFromControls(), { sync: "controls", schedule: false });
    });
  }
  document.querySelectorAll("input[name='queryMetric']").forEach((input) => {
    input.addEventListener("change", () => {
      setQueryDraft(readQueryDraftFromControls(), { sync: "controls" });
    });
  });
  els.querySnapshotDateSelect?.addEventListener("change", () => {
    const path = firstSnapshotPathForDate(els.querySnapshotDateSelect.value);
    updateQueryDraft({ snapshotPath: path }, { sync: "snapshot" });
  });
  els.resetQueryButton?.addEventListener("click", () => {
    setQueryDraft(window.FrontendUtils.clearAllRestrictiveFilters(state.queryDraft || makeQueryDraftFromState(), queryDraftOptions()), { sync: "full" });
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
  syncQueryControlsFromDraft(state.queryDraft, { light: true, forceSnapshot: false });
  if (typeof window.__queryPanelVisibleAt === "number" && !window.__queryPanelVisibleAt) {
    window.__queryPanelVisibleAt = performance.now();
  }
  perfMeasure("query-open-visible", openMark);
  window.requestAnimationFrame(() => {
    if (!isCurrentQueryWork(revision)) return;
    updateQueryAnchorPosition();
    focusWithoutScrolling(els.queryInput || els.queryPanel || els.queryDialog);
    window.setTimeout(() => {
      if (!isCurrentQueryWork(revision)) return;
      setPageInert(true);
      hydrateQueryOverlayAfterFirstFrame(revision);
    }, 0);
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
  abortQueryPreviewWork();
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
  syncQueryPanelFromDraft(state.queryDraft || makeQueryDraftFromState(), { syncMode: "full", forceSnapshot: false });
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

function searchTextMatchesQuery(searchText, query) {
  return window.FrontendUtils.matchesSearch([searchText], query);
}

function buildSearchSuggestions(query, draft = state.queryDraft || makeQueryDraftFromState()) {
  const filterKey = normalizeSearch(query);
  if (!window.FrontendUtils.searchTokens(query).length || !state.payload) return [];
  const rangeCache = getRangeCache(currentGroup());
  const key = queryIndexKey(draft);
  const index = rangeCache.queryIndexes.get(key) || buildFastSearchSuggestionIndex(filterKey, rangeCache, draft);
  const songSuggestions = index.songs
    .filter((entry) => searchTextMatchesQuery(entry.normalizedText, query))
    .slice(0, 5)
    .map((entry) => ({
      label: entry.label,
      value: entry.value,
      meta: entry.meta,
    }));

  const artistSuggestions = index.artists
    .filter((entry) => searchTextMatchesQuery(entry.normalizedText, query))
    .slice(0, 3)
    .map((entry) => ({
      label: entry.label,
      value: entry.value,
      meta: entry.meta,
    }));

  const channelSuggestions = index.channels
    .filter((entry) => searchTextMatchesQuery(entry.normalizedText, query))
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
      const normalizedText = normalizeSearch([title, artist, channel].join(" "));
      const key = normalizeEntityKey([title, artist].join("\n"));
      if (searchTextMatchesQuery(normalizedText, filterKey) && !seenSongs.has(key)) {
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
      if (searchTextMatchesQuery(normalizedText, filterKey) && !seenArtists.has(key)) {
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
      if (searchTextMatchesQuery(normalizedText, filterKey) && !seenChannels.has(key)) {
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
      pageSize: defaultListPageSizeForMode(),
      snapshotPath: SNAPSHOT_LATEST_PATH,
      searchFields: DEFAULT_SEARCH_FIELDS,
    },
    validRankMetrics: Object.keys(RANK_METRICS),
    validSearchScopes: Object.keys(SEARCH_SCOPES),
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
    pageSize: defaultListPageSizeForMode(),
    snapshotPath: SNAPSHOT_LATEST_PATH,
    searchFields: DEFAULT_SEARCH_FIELDS,
  });
}

function sanitizeQueryDraft(draft) {
  const next = window.FrontendUtils.sanitizeQueryDraft(draft, queryDraftOptions());
  next.rankMetric = rankMetricForView(state.view, next.rankMetric);
  next.trend = "all";
  next.minCount = 1;
  next.snapshotPath = SNAPSHOT_LATEST_PATH;
  return next;
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
  syncQueryInputValue(next, { syncMode: options.syncMode });
  syncQueryClearButton(next);
  if (options.syncMode === "input") return next;
  if (options.syncMode === "light") return next;
  syncQueryToggleValues(next);
  syncQuerySelectValues(next);
  syncQuerySnapshotControls(next, previous, options);
  updateQueryAvailability(next);
  return next;
}

function syncQueryInputValue(draft, options = {}) {
  if (!els.queryInput) return;
  const nextValue = draft.q || "";
  if (
    options.syncMode === "input" &&
    document.activeElement === els.queryInput &&
    cleanText(els.queryInput.value) === cleanText(nextValue) &&
    els.queryInput.value.length >= nextValue.length
  ) {
    return;
  }
  if (els.queryInput.value !== nextValue) els.queryInput.value = nextValue;
}

function syncQueryToggleValues(draft) {
  if (els.nicheOnlyToggle) els.nicheOnlyToggle.checked = Boolean(draft.nicheOnly);
  if (els.hideUnknownToggle) els.hideUnknownToggle.checked = Boolean(draft.hideUnknownArtist);
  const selectedFields = Array.isArray(draft.searchFields) ? draft.searchFields : DEFAULT_SEARCH_FIELDS;
  for (const input of els.searchFieldToggles) {
    input.checked = selectedFields.includes(input.value);
    const label = input.closest("label");
    if (label) label.classList.toggle("is-selected", input.checked);
  }
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
  updateQuerySnapshotSummary(draft.snapshotPath);
}

function syncQueryClearButton(draft) {
  if (!els.clearQueryButton) return;
  const hasQuery = Boolean(String(draft?.q || "").trim());
  els.clearQueryButton.hidden = !hasQuery;
  els.clearQueryButton.tabIndex = hasQuery ? 0 : -1;
  els.querySearchForm?.classList.toggle("has-query-text", hasQuery);
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

function updateQuerySnapshotSummary(path = SNAPSHOT_LATEST_PATH) {
  if (!els.querySnapshotSummary) return;
  if (!path || path === SNAPSHOT_LATEST_PATH) {
    els.querySnapshotSummary.textContent = "最新数据";
    return;
  }
  const entry = snapshotEntryForPath(path);
  els.querySnapshotSummary.textContent = entry?.label || "历史数据";
}

function readQueryDraftFromControls() {
  const selectedMetric = document.querySelector("input[name='queryMetric']:checked")?.value || "occurrences";
  const selectedPageSize = Number(els.queryPageSizeSelect?.value || state.pageSize);
  return sanitizeQueryDraft({
    q: els.queryInput?.value || "",
    searchScope: "all",
    searchFields: readSearchFieldsFromControls(),
    nicheOnly: Boolean(els.nicheOnlyToggle?.checked),
    hideUnknownArtist: Boolean(els.hideUnknownToggle?.checked),
    rankMetric: rankMetricForView(state.view, selectedMetric),
    trend: "all",
    minCount: 1,
    pageSize: LIST_PAGE_SIZE_OPTIONS.includes(selectedPageSize) ? selectedPageSize : defaultListPageSizeForMode(),
    snapshotPath: SNAPSHOT_LATEST_PATH,
  });
}

function readSearchFieldsFromControls() {
  const root = els.querySearchForm || document;
  return Array.from(root.querySelectorAll("input[name='searchField']"))
    .filter((input) => input.checked && Object.hasOwn(SEARCH_FIELDS, input.value))
    .map((input) => input.value);
}

function normalizedSearchFieldKey(fields = DEFAULT_SEARCH_FIELDS) {
  const normalized = fields.filter((field) => Object.hasOwn(SEARCH_FIELDS, field));
  return normalized.length ? normalized.join(",") : "all";
}

async function applyQueryDraft() {
  const draft = readQueryDraftFromControls();
  const previousPath = state.currentSnapshotPath;
  closeOverlay("query");
  state.filter = draft.q;
  state.searchScope = draft.searchScope;
  state.searchFields = [...draft.searchFields];
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
  scheduleQueryDraftPreview({
    revision,
    delay: syncMode === "input" ? QUERY_PREVIEW_INPUT_DEBOUNCE_MS : SEARCH_DEBOUNCE_MS,
  });
  return nextDraft;
}

function applyQueryPatch(patch, options = {}) {
  const draft = sanitizeQueryDraft({
    ...makeQueryDraftFromState(),
    ...patch,
  });
  const previousPath = state.currentSnapshotPath;
  state.filter = draft.q;
  state.searchScope = draft.searchScope;
  state.searchFields = [...draft.searchFields];
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
  const hideUnknownField = els.hideUnknownToggle?.closest(".query-toggle");
  const videoLikeView = state.view === "videos";
  const vtuberView = state.view === "vtuberRank";
  if (els.metricFilterGroup) els.metricFilterGroup.hidden = videoLikeView;
  syncQueryMetricOptions();
  if (els.displayFilterGroup) els.displayFilterGroup.hidden = true;
  if (hideUnknownField) hideUnknownField.hidden = state.view === "artistRank" || state.view === "vtuberRank";
  if (els.hideUnknownToggle) els.hideUnknownToggle.disabled = state.view === "artistRank" || state.view === "vtuberRank";
  if (els.queryFieldBar) els.queryFieldBar.hidden = vtuberView;
  for (const input of els.searchFieldToggles) input.disabled = vtuberView;
  if (els.trendFilterGroup) els.trendFilterGroup.hidden = true;
  if (els.minCountFilterGroup) els.minCountFilterGroup.hidden = true;
  else if (els.minCountSelect?.closest(".query-field")) els.minCountSelect.closest(".query-field").hidden = true;
  if (els.queryHistorySection) els.queryHistorySection.hidden = true;
  if (els.trendFilterSelect) els.trendFilterSelect.value = "all";
  if (els.minCountSelect) els.minCountSelect.value = "1";
  if (els.trendFilterSelect) {
    els.trendFilterSelect.disabled = true;
    if (els.trendFilterHint) {
      els.trendFilterHint.textContent = "";
    }
  }
}

function rankMetricForView(view = state.view, metricName = state.rankMetric) {
  const allowed = VIEW_RANK_METRIC_ORDER[view] || ["occurrences"];
  return allowed.includes(metricName) ? metricName : "occurrences";
}

function rankMetricEntriesForView(view = state.view) {
  return (VIEW_RANK_METRIC_ORDER[view] || []).map((value) => [value, RANK_METRICS[value]]).filter(([, label]) => label);
}

function rankMetricButtonText(value) {
  if (value === "songs") return "按歌曲数";
  if (value === "videos") return "按视频数";
  return "按次数";
}

function syncQueryMetricOptions() {
  const allowed = new Set((VIEW_RANK_METRIC_ORDER[state.view] || []).filter((value) => Object.hasOwn(RANK_METRICS, value)));
  for (const input of document.querySelectorAll("input[name='queryMetric']")) {
    const label = input.closest("label");
    const visible = allowed.has(input.value);
    if (label) label.hidden = !visible;
    const textNode = label ? Array.from(label.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) : null;
    if (textNode) textNode.textContent = rankMetricButtonText(input.value);
    input.disabled = !visible;
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
  return activeQueryItems(makeQueryDraftFromState()).length;
}

function syncQueryTriggerState() {
  const draft = makeQueryDraftFromState();
  const items = activeQueryItems(draft);
  const count = items.length;
  if (els.queryTriggerText) {
    els.queryTriggerText.textContent = state.filter || "搜索歌曲、歌手、VTuber或视频";
    els.queryTriggerText.title = state.filter || "";
  }
  if (els.queryTrigger) {
    els.queryTrigger.classList.toggle("has-active-query", count > 0);
    els.queryTrigger.dataset.activeQueryCount = String(count);
    const labels = items.map((item) => item.fullLabel || item.label).filter(Boolean);
    els.queryTrigger.setAttribute("aria-label", count > 0 ? `打开搜索与筛选，当前有 ${count} 个筛选条件：${labels.join("、")}` : "打开搜索与筛选");
  }
  if (els.querySearchForm) {
    els.querySearchForm.classList.toggle("has-active-query", count > 0);
    els.querySearchForm.dataset.activeQueryCount = String(count);
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
  if (items.length >= 2) {
    const clearAll = document.createElement("button");
    clearAll.className = "active-query-clear";
    clearAll.type = "button";
    clearAll.dataset.queryClear = "all";
    clearAll.setAttribute("aria-label", "清除全部筛选条件");
    clearAll.textContent = "清除全部";
    els.activeQueryStrip.append(clearAll);
  }
}

function activeQueryItems(draft) {
  const items = window.FrontendUtils.activeQueryConditionItems(draft, {
    ...queryDraftOptions(),
    view: state.view,
    trendLabels: TREND_FILTERS,
  });
  if (!state.runtimeApi.available) return items;
  return items.filter((item) => item.key !== "trend" && item.key !== "minCount");
}

function clearQueryCondition(key) {
  const draft = makeQueryDraftFromState();
  if (key === "all") {
    applyQueryPatch(window.FrontendUtils.clearAllRestrictiveFilters(draft, queryDraftOptions()), { focusTrigger: true });
    return;
  }
  applyQueryPatch(window.FrontendUtils.clearRestrictiveFilter(draft, key, queryDraftOptions()), { focusTrigger: true });
}

function scheduleQueryDraftPreview(options = {}) {
  window.clearTimeout(state.queryPreviewTimer);
  abortQueryPreviewWork();
  const draft = sanitizeQueryDraft(state.queryDraft || makeQueryDraftFromState());
  options.revision || advanceQueryWorkRevision();
  prepareQueryPreviewShell(draft);
}

function abortQueryPreviewWork() {
  if (!state.queryPreviewController) return;
  state.queryPreviewController.abort();
  state.queryPreviewController = null;
}

function prepareQueryPreviewShell(draft) {
  if (!els.queryResultPreview || !els.applyQueryButton) return;
  if (draft.snapshotPath !== state.currentSnapshotPath) {
    els.queryResultPreview.textContent = "将载入快照";
    els.applyQueryButton.disabled = false;
    els.applyQueryButton.textContent = "应用并载入快照";
    return;
  }
  const cached = currentResultCountForDraft(draft);
  if (cached !== null) {
    els.queryResultPreview.textContent = "可查看结果";
    els.applyQueryButton.disabled = false;
    els.applyQueryButton.textContent = "查看结果";
    return;
  }
  els.queryResultPreview.textContent = "可查看结果";
  els.applyQueryButton.disabled = false;
  els.applyQueryButton.textContent = "查看结果";
}

async function renderQueryDraftPreview(revision = state.queryWorkRevision, options = {}) {
  const draft = sanitizeQueryDraft(state.queryDraft || readQueryDraftFromControls());
  if (!els.queryResultPreview || !els.applyQueryButton || !isCurrentQueryWork(revision)) return;
  if (draft.snapshotPath !== state.currentSnapshotPath) {
    els.queryResultPreview.textContent = "将载入快照";
    els.applyQueryButton.disabled = false;
    els.applyQueryButton.textContent = "应用并载入快照";
    return;
  }
  await yieldToBrowser();
  if (!isCurrentQueryWork(revision)) return;
  els.queryResultPreview.textContent = "可查看结果";
  els.applyQueryButton.disabled = false;
  els.applyQueryButton.textContent = "查看结果";
}

function queryResultUnit() {
  if (state.view === "artistRank") return "位歌手";
  if (state.view === "vtuberRank") return "个频道";
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
  if (state.view === "vtuberRank") {
    count = queryDraftRankRecords(queryDraftVtuberRecords(rangeCache, draft, occurrences), draft, "vtuberRank").length;
    rangeCache.queryResultCountCache.set(cacheKey, count);
    return count;
  }
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

async function resolveQueryDraftResultCount(draft, options = {}) {
  const cachedCurrent = currentResultCountForDraft(draft);
  if (cachedCurrent !== null) return cachedCurrent;
  if (canUseRequestRuntime(state.range)) return requestQueryDraftResultCount(draft, options);
  return queryDraftResultCount(draft);
}

async function requestQueryDraftResultCount(draft, options = {}) {
  const result = await requestViewPage({
    range: state.range,
    view: state.view,
    rankMetric: draft.rankMetric,
    filters: requestFilterStateFromDraft(draft),
    page: 1,
    pageSize: draft.pageSize || currentPageSize(),
    prefetch: true,
    signal: options.signal,
  });
  setCurrentResultSummary(draft, result.totalCount);
  return result.totalCount;
}

function queryDraftBaseOccurrences(rangeCache, draft) {
  const hideUnknownForView = draft.hideUnknownArtist && state.view !== "artistRank" && state.view !== "vtuberRank";
  return draft.nicheOnly
    ? hideUnknownForView
      ? rangeCache.visibleNicheOccurrences
      : rangeCache.nicheOccurrences
    : hideUnknownForView
      ? rangeCache.visibleOccurrences
      : rangeCache.occurrences;
}

function queryDraftHideUnknownForView(draft) {
  return draft.hideUnknownArtist && state.view !== "artistRank" && state.view !== "vtuberRank";
}

function queryDraftOccurrences(rangeCache, draft) {
  const base = queryDraftBaseOccurrences(rangeCache, draft);
  const filterKey = normalizeSearch(draft.q);
  if (!filterKey) return base;
  if (state.view === "artistRank") {
    return base.filter((occurrence) => searchTextMatchesQuery(artistOccurrenceSearchText(occurrence), draft.q));
  }
  if (state.view === "vtuberRank") {
    return base.filter((occurrence) => searchTextMatchesQuery(vtuberOccurrenceSearchText(occurrence), draft.q));
  }
  if (state.view === "songRank" || state.view === "songAz") {
    return base.filter((occurrence) => searchTextMatchesQuery(songOccurrenceSearchText(occurrence, draft.searchFields), draft.q));
  }
  return base.filter((occurrence) => searchTextMatchesQuery(occurrenceSearchTextForCurrentView(occurrence), draft.q));
}

function searchScopeForView(view = state.view, filters = {}) {
  if (view === "vtuberRank") return "channel";
  return filters.searchScope || "all";
}

function searchFieldsForView(view = state.view, filters = {}) {
  if (view === "vtuberRank") return ["channel"];
  return Array.isArray(filters.searchFields) ? filters.searchFields : DEFAULT_SEARCH_FIELDS;
}

function searchFieldKeyForView(view = state.view, fields = DEFAULT_SEARCH_FIELDS) {
  if (view === "vtuberRank" || view === "artistRank" || view === "videos") return "default";
  return normalizedSearchFieldKey(fields || DEFAULT_SEARCH_FIELDS);
}

function requestFiltersForView(view = state.view, filters = {}) {
  return {
    ...filters,
    searchScope: searchScopeForView(view, filters),
    searchFields: searchFieldsForView(view, filters),
  };
}

function queryDraftSongRecords(rangeCache, draft, occurrences = queryDraftOccurrences(rangeCache, draft)) {
  const filterKey = normalizeSearch(draft.q);
  if (!filterKey) return draftScopedSongRecords(rangeCache, draft);
  const key = `query-records::song::${draft.nicheOnly ? "niche" : "all"}::${queryDraftHideUnknownForView(draft) ? "hide-unknown" : "show-unknown"}::${filterKey}::${normalizedSearchFieldKey(draft.searchFields || DEFAULT_SEARCH_FIELDS)}`;
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

function queryDraftVtuberRecords(rangeCache, draft, occurrences = queryDraftOccurrences(rangeCache, draft)) {
  const filterKey = normalizeSearch(draft.q);
  if (!filterKey) return draft.nicheOnly ? rangeCache.nicheVtuberRecords : rangeCache.allVtuberRecords;
  const key = `query-records::vtuber::${draft.nicheOnly ? "niche" : "all"}::${filterKey}`;
  if (!rangeCache.queryRecordCache.has(key)) {
    rangeCache.queryRecordCache.set(key, buildVtuberRecords(occurrences));
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
    searchScopeForView(state.view, draft),
    searchFieldKeyForView(state.view, draft.searchFields || DEFAULT_SEARCH_FIELDS),
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
  if (pageInputPointerActive || document.activeElement?.matches?.('[data-page-input="true"]')) {
    cancelPendingResponsiveResize();
    return;
  }
  const nextMode = getResponsiveMode();
  if (!state.responsiveMode) {
    state.responsiveMode = nextMode;
    if (!LIST_PAGE_SIZE_OPTIONS.includes(Number(state.pageSize))) state.pageSize = defaultListPageSizeForMode(nextMode);
    return;
  }
  if (nextMode === state.responsiveMode || state.resizeRenderFrame) return;
  state.resizeRenderFrame = window.requestAnimationFrame(() => {
    state.resizeRenderFrame = 0;
    const currentMode = getResponsiveMode();
    if (currentMode === state.responsiveMode) return;
    const previousDefault = defaultListPageSizeForMode(state.responsiveMode);
    const nextDefault = defaultListPageSizeForMode(currentMode);
    if (state.view !== "videos" && Number(state.pageSize) === previousDefault) {
      state.pageSize = nextDefault;
      resetPagination();
    }
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
    "hideUnknown",
      "showUnknown",
      "q",
      "searchScope",
      "searchField",
      "searchFields",
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
      hideUnknownArtist: defaults.hideUnknown,
      filter: defaults.q,
      searchScope: defaults.searchScope,
      searchFields: [...defaults.searchFields],
      currentSnapshotPath: SNAPSHOT_LATEST_PATH,
    });
    state.sharedUrlApplied = false;
    return;
  }
  const parsed = window.FrontendUtils.parseUrlState(window.location.search, {
    defaults,
    validRanges: Object.keys(RANGE_LABELS),
    rangeAliases: RANGE_ALIASES,
    validViews: Object.keys(VIEWS),
    validPageSizes: LIST_PAGE_SIZE_OPTIONS,
    validRankMetrics: Object.keys(RANK_METRICS),
    validSearchScopes: Object.keys(SEARCH_SCOPES),
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
  state.rankMetric = rankMetricForView(parsed.view, parsed.rankMetric);
  state.trend = "all";
  state.minCount = 1;
  state.videoLayout = parsed.videoLayout;
  state.nicheOnly = parsed.outside;
  state.hideUnknownArtist = parsed.hideUnknown;
  state.filter = parsed.q;
  state.searchScope = parsed.searchScope;
  state.searchFields = [...parsed.searchFields];
  state.currentSnapshotPath = SNAPSHOT_LATEST_PATH;
  state.sharedUrlApplied = shouldApplySharedState;
}

function normalizeTrendStateForRuntime() {
  if (!state.runtimeApi.available) return false;
  let changed = false;
  if (state.trend !== "all") {
    state.trend = "all";
    changed = true;
  }
  if (state.queryDraft?.trend && state.queryDraft.trend !== "all") {
    state.queryDraft = { ...state.queryDraft, trend: "all" };
    changed = true;
  }
  if (els.trendFilterSelect && els.trendFilterSelect.value !== "all") {
    els.trendFilterSelect.value = "all";
  }
  return changed;
}

function syncControlsFromState() {
  setActiveTab(els.rangeTabs, els.rangeTabs.find((tab) => tab.dataset.range === state.range) || els.rangeTabs[0]);
  setActiveTab(els.viewTabs, els.viewTabs.find((tab) => tab.dataset.view === state.view) || els.viewTabs[0]);
  syncBottomNavFromState();
  if (els.nicheOnlyToggle) els.nicheOnlyToggle.checked = state.nicheOnly;
  if (els.hideUnknownToggle) els.hideUnknownToggle.checked = state.hideUnknownArtist;
  for (const input of els.searchFieldToggles) {
    input.checked = state.searchFields.includes(input.value);
    const label = input.closest("label");
    if (label) label.classList.toggle("is-selected", input.checked);
  }
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
      hideUnknown: state.hideUnknownArtist,
      q: state.filter,
      searchScope: state.searchScope,
      searchFields: state.searchFields,
      snapshotPath: state.currentSnapshotPath,
      trend: state.trend,
      minCount: state.minCount,
    },
    {
      defaults: defaultUrlState(),
      latestSnapshotPath: SNAPSHOT_LATEST_PATH,
      snapshots: state.snapshots,
      rangeAliases: RANGE_ALIASES,
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
    range: "7d",
    view: "songRank",
    page: 1,
    pageSize: defaultListPageSizeForMode(),
    bucket: INDEX_ALL_BUCKET,
    rankMetric: "occurrences",
    trend: "all",
    minCount: 1,
    videoLayout: "cards",
    outside: false,
    hideUnknown: false,
    q: "",
    searchScope: "all",
    searchFields: DEFAULT_SEARCH_FIELDS,
  };
}

async function restoreStateFromUrl() {
  const previousPath = state.currentSnapshotPath;
  const previousListKey = listStateKey();
  applyInitialUrlState();
  normalizeTrendStateForRuntime();
  syncControlsFromState();
  state.expandedRows.clear();
  if (state.currentSnapshotPath !== previousPath) {
    if (state.currentSnapshotPath === SNAPSHOT_LATEST_PATH) {
      if (canUseRequestRuntime(state.range)) {
        applyRequestRuntimeShell();
        render({ syncUrl: false });
        scheduleCurrentRankDiffLoad();
        scheduleOtherRangePrefetch();
        return;
      }
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
    if (canUseRequestRuntime(state.range)) {
      applyRequestRuntimeShell();
      render({ syncUrl: false });
      return;
    }
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
    state.searchScope,
    normalizedSearchFieldKey(state.searchFields),
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
  if (PAGE_SIZES[state.view]) return LIST_PAGE_SIZE_OPTIONS.includes(Number(state.pageSize)) ? Number(state.pageSize) : defaultListPageSizeForMode();
  return defaultListPageSizeForMode();
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
  nextRange = canonicalRangeId(nextRange);
  if (!nextRange || state.range === nextRange) return;
  const previousRange = state.range;
  state.range = nextRange;
  state.rangeIntent = nextRange;
  state.expandedRows.clear();
  resetPagination();
  setActiveTab(els.rangeTabs, els.rangeTabs.find((tab) => tab.dataset.range === nextRange) || els.rangeTabs[0]);
  if (!isLatestSnapshot()) {
    renderOrSyncUrl(options);
    return;
  }

  if (state.initializationMetaPending) {
    // Meta is the gate for range loading. Keep the skeleton and retain only
    // the newest intent; init loads that intent after meta becomes available.
    renderOrSyncUrl(options);
    return;
  }

  if (canUseRequestRuntime(nextRange)) {
    applyRequestRuntimeShell();
    renderOrSyncUrl(options);
    scheduleCurrentRankDiffLoad();
    return;
  }

  try {
    await ensureLatestRange(nextRange);
    renderOrSyncUrl(options);
    scheduleCurrentRankDiffLoad();
  } catch (error) {
    if (!isCurrentRangeIntent(nextRange)) return;
    state.range = previousRange;
    state.rangeIntent = previousRange;
    setActiveTab(els.rangeTabs, els.rangeTabs.find((tab) => tab.dataset.range === previousRange) || els.rangeTabs[0]);
    renderOrSyncUrl({ syncUrl: false });
    showToast(`范围读取失败，已保留当前内容：${error.message}`);
  }
}

function isCurrentRangeIntent(rangeId) {
  return canonicalRangeId(rangeId) === canonicalRangeId(state.rangeIntent || state.range);
}

async function ensureLatestRange(rangeId) {
  rangeId = canonicalRangeId(rangeId);
  if (state.payload?.groups?.[rangeId]) return state.payload.groups[rangeId];
  const payload = await loadRuntimeRange(rangeId);
  if (!isCurrentRangeIntent(rangeId)) return state.payload;
  await applyRuntimeRangePayload(payload, { resetPage: false, syncUrl: false, merge: true, expectedRange: rangeId });
  return state.payload?.groups?.[rangeId];
}

async function loadRuntimeRange(rangeId) {
  rangeId = canonicalRangeId(rangeId);
  const existing = state.runtimeRangePayloads.get(rangeId);
  if (existing) return existing;
  if (state.runtimeRangeLoads.has(rangeId)) return state.runtimeRangeLoads.get(rangeId);
  if (!state.runtimeMeta) throw new Error(`runtime meta missing before loading ${rangeId}`);
  const promise = loadRuntimeRangeStrict(rangeId)
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

function runtimeRangeMeta(rangeId) {
  return window.FrontendUtils.runtimeRangeMeta(canonicalRangeId(rangeId), state.runtimeMeta, runtimeRangeOptions());
}

function runtimeRangeShards(rangeId) {
  return window.FrontendUtils.runtimeRangeShards(canonicalRangeId(rangeId), state.runtimeMeta, runtimeRangeOptions());
}

function requestRuntimeMeta(rangeId = state.range) {
  const shards = runtimeRangeShards(rangeId);
  return shards?.request || null;
}

function isRuntimeApiMeta(payload) {
  return Boolean(payload && typeof payload === "object" && payload.schemaVersion && payload.meta && payload.counts);
}

function runtimeMetaFromApiMeta(apiMeta, fallbackMeta = null) {
  const meta = apiMeta?.meta || {};
  const builtAt = cleanText(meta.built_at || meta.generated_at || "");
  const latestGeneratedAt = cleanText(meta.latest_generated_at || fallbackMeta?.generatedAt || builtAt);
  const latestCapturedAt = cleanText(meta.latest_captured_at || fallbackMeta?.capturedAt || latestGeneratedAt);
  const dataVersion = cleanText(meta.latest_data_version || meta.data_version || builtAt || fallbackMeta?.dataVersion || "");
  const { diffs: _staticDiffs, ...fallbackRuntimeMeta } = fallbackMeta || {};
  return {
    ...fallbackRuntimeMeta,
    schemaVersion: Number(meta.schema_version) || Number(apiMeta?.schemaVersion) || Number(fallbackMeta?.schemaVersion) || 1,
    generatedAt: latestGeneratedAt,
    capturedAt: latestCapturedAt,
    dataCapturedAt: latestCapturedAt,
    rebuiltDerivedAt: builtAt || cleanText(fallbackMeta?.rebuiltDerivedAt || ""),
    dataVersion,
    filterVersion: Number.isInteger(fallbackMeta?.filterVersion) ? fallbackMeta.filterVersion : CURRENT_FILTER_VERSION,
    nicheAnnotated: fallbackMeta?.nicheAnnotated === true,
    status: {
      ...(fallbackMeta?.status || {}),
      status: "success",
      capturedAt: latestCapturedAt,
      dataCapturedAt: latestCapturedAt,
      generatedAt: latestGeneratedAt,
      completedAt: builtAt || latestGeneratedAt,
      rebuiltDerivedAt: builtAt || cleanText(fallbackMeta?.status?.rebuiltDerivedAt || ""),
    },
    api: {
      available: true,
      counts: apiMeta?.counts || {},
    },
  };
}

function canUseRequestRuntime(rangeId = state.range) {
  if (!isLatestSnapshot()) return false;
  if (state.requestRuntime.disabledRanges.has(canonicalRangeId(rangeId))) return false;
  return state.runtimeApi.available;
}

function applyRequestRuntimeShell() {
  state.payload = {
    schemaVersion: 1,
    generatedAt: state.runtimeMeta?.generatedAt || "",
    capturedAt: state.runtimeMeta?.capturedAt || "",
    dataVersion: state.runtimeMeta?.dataVersion || "",
    filterVersion: Number.isInteger(state.runtimeMeta?.filterVersion) ? state.runtimeMeta.filterVersion : CURRENT_FILTER_VERSION,
    blocklistVersion: state.runtimeMeta?.blocklistVersion || "",
    blocklistHash: state.runtimeMeta?.blocklistHash || "",
    nicheAnnotated: state.runtimeMeta?.nicheAnnotated === true,
    groups: Object.fromEntries(Object.keys(RANGE_LABELS).map((rangeId) => [
      rangeId,
      {
        id: rangeId,
        title: RANGE_LABELS[rangeId] || rangeId,
        generatedAt: state.runtimeMeta?.generatedAt || "",
        items: [],
      },
    ])),
  };
}

function runtimeRangeOptions() {
  return {
    rangeAliases: RANGE_ALIASES,
    legacyRangeIds: LEGACY_RANGE_IDS,
  };
}

function canonicalRangeId(rangeId) {
  return RANGE_ALIASES[rangeId] || rangeId || "";
}

function runtimeRangeIdCandidates(rangeId) {
  const canonical = canonicalRangeId(rangeId);
  return [canonical, ...(LEGACY_RANGE_IDS[canonical] || [])].filter(Boolean);
}

async function loadRuntimeRangeStrict(rangeId) {
  rangeId = canonicalRangeId(rangeId);
  const shards = runtimeRangeShards(rangeId);
  if (!shards.hasPageShard) {
    const error = new Error(`${rangeId} 范围缺少 page shard，已阻止读取完整 range JSON`);
    state.runtimeWarnings.set(rangeId, { message: error.message, attempts: [error.message] });
    throw error;
  }
  const errors = [];
  const manifestPath = shardManifestPath(shards.page);
  for (const cache of [cacheModeForPath(manifestPath), "reload"]) {
    try {
      const payload = await loadRuntimeRangeFromShards(rangeId, { cache });
      state.runtimeWarnings.delete(rangeId);
      return payload;
    } catch (error) {
      errors.push(error);
      console.warn(`[runtime] shard load failed for ${rangeId}: ${error?.message || error}`);
    }
  }
  const diagnostic = errors.map((error) => error?.message || String(error)).join(" | ") || rangeId;
  const error = new Error(`运行时范围读取失败：${diagnostic}`);
  error.rangeId = rangeId;
  error.attempts = errors.map((entry) => entry?.message || String(entry));
  state.runtimeWarnings.set(rangeId, {
    message: error.message,
    attempts: error.attempts,
  });
  throw error;
}

async function loadRuntimeRangeFromShards(rangeId, options = {}) {
  const rangeMeta = runtimeRangeMeta(rangeId);
  const shards = runtimeRangeShards(rangeId);
  const runtimeShard = shards.page;
  const manifestPath = shardManifestPath(runtimeShard);
  if (!manifestPath) throw new Error(`runtime shard manifest missing for ${rangeId}`);
  const cache = options.cache || cacheModeForPath(manifestPath);
  const manifest = await readJson(manifestPath, { cache });
  const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
  if (!pages.length) throw new Error(`runtime shard manifest has no pages for ${rangeId}`);
  const firstPage = pages[0];
  if (!firstPage?.path) throw new Error(`runtime shard first page missing for ${rangeId}`);
  const firstPagePayload = await readJson(firstPage.path, { cache });
  const items = Array.isArray(firstPagePayload.items) ? firstPagePayload.items : [];
  const payload = {
    schemaVersion: 1,
    id: rangeId,
    title: RANGE_LABELS[rangeId] || rangeId,
    generatedAt: manifest.generatedAt || rangeMeta?.generatedAt || state.runtimeMeta?.generatedAt || "",
    capturedAt: manifest.capturedAt || state.runtimeMeta?.capturedAt || "",
    dataVersion: manifest.dataVersion || rangeMeta?.dataVersion || state.runtimeMeta?.dataVersion || "",
    filterVersion: Number.isInteger(state.runtimeMeta?.filterVersion) ? state.runtimeMeta.filterVersion : 0,
    blocklistVersion: state.runtimeMeta?.blocklistVersion || "",
    blocklistHash: state.runtimeMeta?.blocklistHash || "",
    nicheAnnotated: state.runtimeMeta?.nicheAnnotated === true,
    items,
    shardedFrom: manifestPath,
    partialRuntimePage: firstPage.path,
  };
  return normalizeRuntimeRangePayload(window.FrontendUtils.validateRuntimeRangePayload(payload, {
    rangeId,
    meta: state.runtimeMeta,
    path: manifestPath,
    allowPartial: true,
    ...runtimeRangeOptions(),
  }), rangeId);
}

function shardManifestPath(shard) {
  if (!shard) return "";
  if (typeof shard === "string") return shard;
  if (Array.isArray(shard)) return shardManifestPath(shard[0]);
  return cleanText(shard.manifestPath || shard.manifestLegacyPath || shard.path || shard.indexPath);
}

function normalizeRuntimeRangePayload(payload, rangeId) {
  const canonical = canonicalRangeId(rangeId || payload?.id);
  if (!payload || payload.id === canonical) return payload;
  return {
    ...payload,
    id: canonical,
    title: payload.title || RANGE_LABELS[canonical] || canonical,
  };
}

function isPartialRuntimePayload(payload) {
  return Boolean(
    payload?.partial ||
      payload?.isPartial ||
      payload?.pageShard ||
      payload?.shard ||
      payload?.shardedFrom ||
      payload?.partialRuntimePage ||
      payload?.totalItemCount ||
      payload?.sourceDetailPath ||
      payload?.searchShardPath,
  );
}

async function applyRuntimeRangePayload(rangePayload, options = {}) {
  const rangeId = canonicalRangeId(rangePayload?.id || state.range);
  if (options.expectedRange && !isCurrentRangeIntent(options.expectedRange)) return;
  rangePayload = normalizeRuntimeRangePayload(rangePayload, rangeId);
  window.FrontendUtils.validateRuntimeRangePayload(rangePayload, {
    rangeId,
    meta: state.runtimeMeta,
    path: runtimeRangeMeta(rangeId)?.path,
    allowPartial: isPartialRuntimePayload(rangePayload),
    ...runtimeRangeOptions(),
  });
  const payload = latestPayloadFromRuntimeRange(rangePayload, state.runtimeMeta);
  const prepared = await measureAsync("prepare-payload", () => preparePayload(payload));
  if (!options.merge) state.rangeCache.clear();
  await prewarmRangeCache(prepared.groups?.[rangeId], SNAPSHOT_LATEST_PATH, rangeId);
  await yieldToBrowser();
  if (options.expectedRange && !isCurrentRangeIntent(options.expectedRange)) return;
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
  const rangeId = canonicalRangeId(rangePayload?.id || state.range);
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
  if (window.FrontendUtils.hasNicheAnnotations(sourceFiltered)) return normalizePayloadRangeGroups(sourceFiltered);
  await ensureSongSearchLookup();
  if (!state.songSearchLookup.available) return normalizePayloadRangeGroups(sourceFiltered);
  return normalizePayloadRangeGroups(window.FrontendUtils.annotatePayloadWithNiche(sourceFiltered, state.songSearchLookup));
}

function normalizePayloadRangeGroups(payload) {
  const groups = payload?.groups || {};
  const nextGroups = { ...groups };
  for (const [legacyId, canonicalId] of Object.entries(RANGE_ALIASES)) {
    if (!nextGroups[canonicalId] && groups[legacyId]) {
      nextGroups[canonicalId] = {
        ...groups[legacyId],
        id: canonicalId,
        title: RANGE_LABELS[canonicalId] || groups[legacyId].title || canonicalId,
      };
    }
  }
  return nextGroups === groups ? payload : { ...payload, groups: nextGroups };
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
  if (!isLatestSnapshot() || state.view === "videos" || state.runtimeApi.available) {
    updateQueryAvailability();
    return;
  }
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
  if (state.runtimeApi.available) return false;
  rangeId = canonicalRangeId(rangeId);
  if (state.rankDiffs?.[rangeId]) return false;
  if (state.rankDiffLoads.has(rangeId)) return state.rankDiffLoads.get(rangeId);
  const path = runtimeDiffPath(rangeId);
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

function runtimeDiffPath(rangeId) {
  const diffs = state.runtimeMeta?.diffs || {};
  for (const id of runtimeRangeIdCandidates(rangeId)) {
    if (diffs[id]?.path) return diffs[id].path;
  }
  return `data/diff/latest-${canonicalRangeId(rangeId)}.json`;
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
  if (canUseRequestRuntime(state.range)) return;
  if (!isLatestSnapshot() || !canPrefetchOtherRange()) return;
  const otherRange = Object.keys(RANGE_LABELS).find((rangeId) => rangeId !== state.range);
  if (!otherRange || state.runtimeRangePayloads.has(otherRange) || !canPrefetchRuntimeRange(otherRange)) return;
  if (state.rangePrefetchTimer) window.clearTimeout(state.rangePrefetchTimer);
  const run = () => {
    state.rangePrefetchTimer = 0;
    if (!canPrefetchOtherRange() || state.runtimeRangePayloads.has(otherRange) || !canPrefetchRuntimeRange(otherRange)) return;
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
  rangeId = canonicalRangeId(rangeId);
  if (canUseRequestRuntime(rangeId)) return;
  if (!rangeId || rangeId === state.range || state.runtimeRangePayloads.has(rangeId)) return;
  if (!isLatestSnapshot() || !canPrefetchOtherRange() || !canPrefetchRuntimeRange(rangeId)) return;
  loadRuntimeRange(rangeId).catch(() => {});
}

function canPrefetchOtherRange() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return window.FrontendUtils.shouldPrefetchRuntimeRange({
    connection,
    visibilityState: document.visibilityState,
  });
}

function canPrefetchRuntimeRange(rangeId) {
  const canonical = canonicalRangeId(rangeId);
  if (canonical !== "all") return true;
  return runtimeRangeShards(canonical).hasPageShard;
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
  }, 2200);
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
  const failureStage = cleanText(currentStatus.failureStage || "");
  const rebuiltDerivedAt = currentStatus.rebuiltDerivedAt || state.runtimeMeta?.rebuiltDerivedAt || "";
  const apiFreshnessAt = state.runtimeApi.available
    ? rebuiltDerivedAt || completedAt || currentStatus.generatedAt || state.runtimeMeta?.generatedAt || capturedAt
    : "";
  const freshnessAt = apiFreshnessAt || capturedAt;
  const parts = [];
  if (currentStatus.status === "success") {
    if (state.runtimeApi.available) {
      parts.push(`数据库构建于 ${formatDate(freshnessAt)}`);
      if (capturedAt && capturedAt !== freshnessAt) parts.push(`源数据采集于 ${formatDate(capturedAt)}`);
    } else {
      parts.push(`数据抓取于 ${formatDate(capturedAt)}`);
    }
  } else {
    const failureAt = attemptedAt ? `最近尝试 ${formatDate(attemptedAt)}` : "最近尝试时间不可用";
    parts.push(`最近更新失败${failureStage ? `：${failureStage}` : ""}`);
    parts.push(`正在使用上次成功数据 · ${failureAt}`);
    if (capturedAt) parts.push(`上次成功 ${formatDate(capturedAt)}`);
  }
  if (rebuiltDerivedAt && rebuiltDerivedAt !== capturedAt) parts.push(`页面数据重建于 ${formatDate(rebuiltDerivedAt)}`);
  const alerts = [];
  if (currentStatus.status !== "success") {
    alerts.push(`最近更新失败${failureStage ? `：${failureStage}` : ""}，当前数据来自 ${formatDate(capturedAt)}`);
  }
  const warning = state.runtimeWarnings.get(state.range);
  if (warning?.message) {
    alerts.push(warning.message);
  }
  const displayAt = freshnessAt || rebuiltDerivedAt || attemptedAt;
  const statusText = currentStatus.status === "success" ? `${formatUpdatedAt(displayAt)}更新` : capturedAt ? `上次成功 ${formatDate(capturedAt)}` : "状态异常";
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
      `failureStage=${failureStage || ""}`,
      `rebuiltDerivedAt=${rebuiltDerivedAt || ""}`,
      state.runtimeApi.available ? `freshnessAt=${freshnessAt || ""}` : "",
      `dataVersion=${state.runtimeMeta?.dataVersion || ""}`,
      warning?.message ? `warning=${warning.message}` : "",
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

function mergeRuntimeStatus(metaStatus, statusFile, meta) {
  if (meta?.api?.available && metaStatus?.status === "success") {
    return completeRuntimeStatus(metaStatus, metaStatus, meta);
  }
  const candidates = [metaStatus, statusFile].filter((item) => item && typeof item === "object");
  if (!candidates.length) return null;
  const newest = candidates
    .map((item) => ({
      ...item,
      _time: Date.parse(item.attemptedAt || item.completedAt || item.capturedAt || item.generatedAt || ""),
    }))
    .sort((a, b) => (Number.isFinite(b._time) ? b._time : 0) - (Number.isFinite(a._time) ? a._time : 0))[0];
  const { _time, ...status } = newest;
  return completeRuntimeStatus(status, metaStatus, meta);
}

function completeRuntimeStatus(status, metaStatus, meta) {
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
  const rangeMeta = runtimeRangeMeta(state.range);
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
  const preservedPageInputState = options.preservePageInput === false ? null : capturePageInputState();
  if (options.preservePageInput === false) cancelPageInputRestore();
  if (canUseRequestRuntime(state.range)) {
    renderRequestedRuntime(options, preservedPageInputState);
    return;
  }
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
  } else if (state.view === "vtuberRank") {
    els.content.classList.add("rank-panel");
    renderVtuberRank(group, rangeCache, selection);
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
  restorePageInputState(preservedPageInputState);
  if (!state.firstContentMeasured) {
    state.firstContentMeasured = true;
    perfMeasure("first-content", renderMark);
  }
  perfMeasure("render-dom", renderMark);
  scheduleCurrentRankDiffLoad();
}

async function renderRequestedRuntime(options = {}, preservedPageInputState = null) {
  const renderMark = perfMark("render-request:start");
  const revision = ++state.requestRuntime.revision;
  if (state.requestRuntime.activeController) state.requestRuntime.activeController.abort();
  const controller = new AbortController();
  state.requestRuntime.activeController = controller;
  const previousResult = state.requestRuntime.lastResult;

  resetContentClasses();
  els.content.classList.toggle("video-grid", state.view === "videos");
  els.content.classList.toggle("video-compact", state.view === "videos" && state.videoLayout === "compact");
  els.content.classList.toggle("rank-panel", state.view === "songRank" || state.view === "artistRank" || state.view === "vtuberRank");
  els.content.classList.toggle("song-index", state.view === "songAz");
  els.content.setAttribute("aria-busy", "true");
  if (!previousResult || requestViewFingerprint(previousResult) !== requestViewFingerprintFromState()) {
    renderInitialSkeleton();
  }

  try {
    const result = await measureAsync("request-view-page", () => requestViewPage({
      range: state.range,
      view: state.view,
      rankMetric: state.rankMetric,
      filters: requestFilterState(),
      page: state.page,
      pageSize: currentPageSize(),
      signal: controller.signal,
    }));
    if (revision !== state.requestRuntime.revision || controller.signal.aborted) return;
    state.requestRuntime.lastResult = result;
    await waitForPageInputToSettle({ allowActive: options.preservePageInput === false });
    if (revision !== state.requestRuntime.revision || controller.signal.aborted) return;
    const pageInputStateAtResponse = capturePageInputState() || preservedPageInputState;
    renderRequestedPageResult(result);
    restorePageInputState(pageInputStateAtResponse);
    setSnapshotBusy(false);
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
    perfMeasure("render-request", renderMark);
    if (result.view !== "vtuberRank")
    scheduleAdjacentRequestPagePrefetch(result);
    scheduleCurrentRankDiffLoad();
  } catch (error) {
    if (error?.name === "AbortError" || revision !== state.requestRuntime.revision) return;
    if (previousResult) {
      setSnapshotBusy(false);
      await waitForPageInputToSettle({ allowActive: options.preservePageInput === false });
      if (revision !== state.requestRuntime.revision || controller.signal.aborted) return;
      const pageInputStateAtError = capturePageInputState() || preservedPageInputState;
      renderRequestedPageResult(previousResult, { staleError: error });
      restorePageInputState(pageInputStateAtError);
    } else {
      try {
        await waitForPageInputToSettle({ allowActive: options.preservePageInput === false });
        if (revision !== state.requestRuntime.revision || controller.signal.aborted) return;
        const pageInputStateBeforeFallback = capturePageInputState() || preservedPageInputState;
        const rangeId = canonicalRangeId(state.range);
        state.requestRuntime.disabledRanges.add(rangeId);
        const fallbackPayload = await loadRuntimeRange(rangeId);
        await applyRuntimeRangePayload(fallbackPayload, {
          resetPage: false,
          syncUrl: options.syncUrl !== false,
          urlMode: options.urlMode || "replace",
        });
        restorePageInputState(pageInputStateBeforeFallback);
      } catch (fallbackError) {
        setSnapshotBusy(false);
        renderEmpty(`页面读取失败：${fallbackError.message || error.message}`, { reloadable: true, role: "alert" });
      }
    }
    showToast(`页面读取失败：${error.message}`);
  } finally {
    if (state.requestRuntime.activeController === controller) state.requestRuntime.activeController = null;
  }
}

function requestFilterState() {
  return requestFiltersForView(state.view, {
    q: state.filter || "",
    searchScope: state.searchScope || "all",
    searchFields: state.searchFields || DEFAULT_SEARCH_FIELDS,
    nicheOnly: state.nicheOnly,
    hideUnknownArtist: shouldHideUnknownForCurrentView(),
    minCount: 1,
    trend: "all",
    indexBucket: state.indexBucket,
  });
}

function requestFilterStateFromDraft(draft) {
  return requestFiltersForView(state.view, {
    q: draft.q || "",
    searchScope: draft.searchScope || "all",
    searchFields: draft.searchFields || DEFAULT_SEARCH_FIELDS,
    nicheOnly: draft.nicheOnly,
    hideUnknownArtist: queryDraftHideUnknownForView(draft),
    minCount: 1,
    trend: "all",
    indexBucket: state.indexBucket,
  });
}

function requestViewFingerprint(result) {
  return [
    result?.range,
    result?.view,
    result?.metric,
    result?.scopeKey,
    result?.filterKey,
    result?.pageSize,
  ].join("::");
}

function requestViewFingerprintFromState() {
  return [
    state.range,
    state.view,
    state.view === "artistRank" || state.view === "songRank" || state.view === "vtuberRank" ? state.rankMetric : "index",
    requestScopeKey(state.view),
    requestFilterKey(requestFilterState()),
    currentPageSize(),
  ].join("::");
}

async function requestViewPage(request) {
  const requestKey = buildRequestPageKey(request);
  if (state.requestRuntime.pageResultCache.has(requestKey)) {
    const cached = state.requestRuntime.pageResultCache.get(requestKey);
    if (!request.prefetch) state.page = cached.pageInfo.page;
    return cached;
  }

  const range = canonicalRangeId(request.range);
  if (shouldUseRuntimeApiForRequest(request)) {
    const result = await requestApiViewPage(request, range);
    state.requestRuntime.pageResultCache.set(requestKey, result);
    if (!request.prefetch) state.page = result.pageInfo.page;
    return result;
  }

  const requestMeta = requestRuntimeMeta(range);
  if (!requestMeta) throw new Error(`request runtime missing for ${range}`);
  const summary = await loadRequestSummary(range, request.signal);
  const viewRef = requestViewRef(requestMeta, request.view, request.rankMetric, requestScopeKey(request.view));
  if (!viewRef?.manifestPath) throw new Error(`request view manifest missing: ${request.view}`);
  const filters = requestFiltersForView(request.view, request.filters || {});
  const pageSize = Number(request.pageSize) || currentPageSize();
  const nativePageSize = Number(viewRef.pageSize) || pageSize;
  const directPage = canUseDirectRequestPage(request.view, filters) && pageSize === nativePageSize;
  const requestedPage = clampPage(request.page, viewRef.pageCount || 1);
  if (directPage && requestedPage === 1 && viewRef.bootstrapPath && request.view !== "songAz") {
    const pagePayload = await readCachedRequestJson(state.requestRuntime.detailShardCache, viewRef.bootstrapPath, request.signal);
    assertRequestViewPagePayload(pagePayload, viewRef.bootstrapPath);
    const records = await hydrateRequestPageRecords(pagePayload, request.view, request.signal);
    const entries = pagePayload.indexEntries || [];
    const manifest = requestManifestFromViewRef(viewRef, request);
    const result = buildRequestResult({
      request,
      summary,
      manifest,
      entries,
      records,
      page: 1,
      totalCount: pagePayload.totalCount ?? viewRef.totalCount ?? entries.length,
      filteredBaseCount: viewRef.totalCount ?? entries.length,
      filterKey: requestFilterKey(filters, request.view),
    });
    state.requestRuntime.pageResultCache.set(requestKey, result);
    if (!request.prefetch) state.page = result.pageInfo.page;
    return result;
  }

  const manifest = await loadRequestViewManifest(viewRef.manifestPath, request.signal);
  if (directPage) {
    const page = clampPage(request.page, manifest.pageCount);
    const pageRef = manifest.pages?.[page - 1] || manifest.pages?.find((entry) => entry.index === page);
    if (!pageRef?.path) throw new Error(`request page missing: ${request.view} ${page}`);
    const pagePayload = await readCachedRequestJson(state.requestRuntime.detailShardCache, pageRef.path, request.signal);
    assertRequestViewPagePayload(pagePayload, pageRef.path);
    const records = await hydrateRequestPageRecords(pagePayload, request.view, request.signal);
    const entries = pagePayload.indexEntries || [];
    const bucketEntries = request.view === "songAz"
      ? (await loadRequestViewIndex(manifest, request.signal)).records || []
      : null;
    const result = buildRequestResult({
      request,
      summary,
      manifest,
      entries,
      records,
      bucketEntries,
      page,
      totalCount: pagePayload.totalCount ?? manifest.totalCount ?? entries.length,
      filteredBaseCount: manifest.totalCount ?? entries.length,
      filterKey: requestFilterKey(filters, request.view),
    });
    state.requestRuntime.pageResultCache.set(requestKey, result);
    if (!request.prefetch) state.page = result.pageInfo.page;
    return result;
  }

  const indexPayload = await loadRequestViewIndex(manifest, request.signal);
  const sourceEntries = Array.isArray(indexPayload.records) ? indexPayload.records : [];
  let entries = sourceEntries;
  entries = await filterRequestIndexEntries(entries, {
    view: request.view,
    metric: manifest.metric || request.rankMetric,
    filters,
    signal: request.signal,
  });
  const pageInfo = window.FrontendUtils.paginateItems(entries, { page: request.page, pageSize });
  const records = await loadRequestDetailRecords(pageInfo.visible, request.signal);
  const resultOccurrenceCount = requestEntriesOccurrenceCount(entries, request.view, manifest.metric || request.rankMetric);
  const resultVideoCount = requestEntriesVideoCount(entries, request.view, manifest.metric || request.rankMetric);
  const result = buildRequestResult({
    request,
    summary,
    manifest,
    entries: pageInfo.visible,
    records,
    bucketEntries: request.view === "songAz" ? sourceEntries : null,
    page: pageInfo.page,
    totalCount: entries.length,
    filteredBaseCount: indexPayload.totalCount ?? manifest.totalCount ?? entries.length,
    filterKey: requestFilterKey(filters, request.view),
    totalOccurrenceCount: resultOccurrenceCount,
    totalVideoCount: resultVideoCount,
  });
  state.requestRuntime.pageResultCache.set(requestKey, result);
  if (!request.prefetch) state.page = result.pageInfo.page;
  return result;
}

function shouldUseRuntimeApiForRequest(request) {
  if (!state.runtimeApi.available) return false;
  return true;
}

async function requestApiViewPage(request, range) {
  const filters = requestFiltersForView(request.view, request.filters || {});
  const pageSize = Number(request.pageSize) || currentPageSize();
  const apiView = apiViewForRequestView(request.view);
  const metricName = apiMetricForRequest(request);
  const params = new URLSearchParams({
    range,
    view: apiView,
    metric: metricName,
    page: String(Number(request.page) || 1),
    pageSize: String(pageSize),
  });
  const query = cleanText(filters.q || "");
  if (query) params.set("q", query);
  if (query && filters.searchScope && filters.searchScope !== "all") {
    params.set("searchScope", filters.searchScope);
  } else if (query) {
    const searchFields = searchFieldsForView(request.view, filters);
    params.set("searchFields", searchFields.length ? searchFields.join(",") : "all");
  }
  if (Number(filters.minCount) > 1 && request.view !== "videos") params.set("minCount", String(Number(filters.minCount)));
  if (filters.nicheOnly) params.set("nicheOnly", "1");
  if (filters.hideUnknownArtist) params.set("hideUnknownArtist", "1");
  if (request.view === "vtuberRank") params.set("compact", "1");
  const payload = await readJson(`${API_RANKINGS_PATH}?${params.toString()}`, {
    cache: "no-cache",
    signal: request.signal,
  });
  assertApiRankingPayload(payload);
  const records = hydrateRequestRecords(payload.records, request.view);
  const page = Number(payload.page) || request.page || 1;
  const hasFilteredRank = Boolean(query || Number(filters.minCount) > 1);
  const pageOffset = hasFilteredRank ? (Math.max(1, page) - 1) * pageSize : 0;
  const entries = records.map((record, index) => apiIndexEntryForRecord(record, request.view, payload.metric || metricName, index, {
    rank: hasFilteredRank ? pageOffset + index + 1 : null,
  }));
  const summary = apiSummaryFromPayload(payload);
  const manifest = {
    schemaVersion: 1,
    kind: "api-view",
    rangeId: range,
    view: request.view,
    apiView,
    metric: request.view === "songRank" || request.view === "artistRank" || request.view === "vtuberRank" ? metricName : "index",
    scopeKey: "all",
    pageSize,
    totalCount: Number(payload.totalCount) || 0,
    pageCount: Number(payload.pageCount) || 1,
  };
  return buildRequestResult({
    request,
    summary,
    manifest,
    entries,
    records,
    bucketEntries: request.view === "songAz" ? entries : null,
    page,
    totalCount: Number(payload.totalCount) || 0,
    filteredBaseCount: Number(payload.filteredBaseCount ?? payload.totalCount) || 0,
    filterKey: requestFilterKey(filters, request.view),
    totalOccurrenceCount: Number(payload.totalOccurrenceCount) || 0,
    totalVideoCount: Number(payload.totalVideoCount) || 0,
  });
}

function apiViewForRequestView(view) {
  if (view === "artistRank") return "artists";
  if (view === "vtuberRank") return "vtubers";
  if (view === "songAz") return "songIndex";
  if (view === "videos") return "videos";
  return "songs";
}

function apiMetricForRequest(request) {
  if (request.view === "songRank" || request.view === "artistRank" || request.view === "vtuberRank") {
    if (request.view === "vtuberRank" && request.rankMetric === "songs") return "songs";
    return request.rankMetric === "videos" ? "videos" : "occurrences";
  }
  return "count";
}

function assertApiRankingPayload(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.records)) {
    throw new Error("api ranking payload invalid");
  }
}

function apiIndexEntryForRecord(record, view, metricName, index, options = {}) {
  const type = view === "artistRank" ? "artist" : view === "vtuberRank" ? "vtuber" : view === "videos" ? "video" : "song";
  const key = record.key || record.videoId || record.detailKey || String(index);
  const rank = Number(options.rank) || Number(record.rank) || index + 1;
  return {
    type: record.type || type,
    key,
    detailKey: key,
    rank,
    isTied: false,
    isNiche: isNicheRecord(record),
    rankValue: rankValueForRequestRecord(record, metricName),
    bucket: view === "songAz" ? songIndexBucket(record) : "",
    searchText: record.searchText || normalizeSearch([record.title, record.displayArtist, record.artist, record.name, record.channelName].filter(Boolean).join(" ")),
  };
}

function apiSummaryFromPayload(payload) {
  const scope = {
    itemCount: Number(payload.totalCount) || 0,
    occurrenceCount: Number(payload.totalOccurrenceCount) || 0,
    videoCount: Number(payload.totalVideoCount) || 0,
  };
  return {
    schemaVersion: 1,
    kind: "api-summary",
    rangeId: payload.rangeId || state.range,
    scopes: { all: scope },
  };
}

function requestEntriesOccurrenceCount(entries, view, metricName) {
  if (view === "videos") {
    return entries.reduce((total, entry) => total + (Number(entry.occurrenceCount ?? entry.count ?? entry.rankValue) || 0), 0);
  }
  return entries.reduce((total, entry) => {
    const value = metricName === "videos" || metricName === "songs" ? entry.count : entry.count ?? entry.rankValue;
    return total + (Number(value) || 0);
  }, 0);
}

function requestEntriesVideoCount(entries, view, metricName) {
  if (view === "videos") return entries.length;
  return entries.reduce((total, entry) => {
    const value = metricName === "videos" ? entry.rankValue ?? entry.videoCount : entry.videoCount;
    return total + (Number(value) || 0);
  }, 0);
}

function requestViewRef(requestMeta, view, rankMetric, scopeKey) {
  const metric = view === "songRank" || view === "artistRank" || view === "vtuberRank" ? rankMetric || "occurrences" : "index";
  if (view === "songRank") return requestMeta.views?.songRank?.[metric]?.[scopeKey];
  if (view === "artistRank") return requestMeta.views?.artistRank?.[metric]?.[scopeKey];
  if (view === "vtuberRank") {
    return requestMeta.views?.vtuberRank?.[metric]?.[scopeKey] || (metric === "occurrences" ? requestMeta.views?.vtuberRank?.index?.[scopeKey] : null);
  }
  if (view === "songAz") return requestMeta.views?.songAz?.index?.[scopeKey];
  if (view === "videos") return requestMeta.views?.videos?.index?.[scopeKey];
  return null;
}

function assertRequestViewPagePayload(payload, path) {
  if (payload?.kind !== "request-view-page" || !Array.isArray(payload.records) || !Array.isArray(payload.indexEntries)) {
    throw new Error(`request page payload invalid: ${path}`);
  }
}

async function hydrateRequestPageRecords(payload, view, signal) {
  const records = Array.isArray(payload?.records) ? payload.records : [];
  const entries = Array.isArray(payload?.indexEntries) ? payload.indexEntries : [];
  if (requestPageRecordsAreDetailed(records, view)) return hydrateRequestRecords(records, view);
  if (entries.some((entry) => entry.detailShard)) return loadRequestDetailRecords(entries, signal);
  return hydrateRequestRecords(records, view);
}

function requestPageRecordsAreDetailed(records, view) {
  if (!records.length) return false;
  return records.every((record) => {
    if (view === "artistRank") return Array.isArray(record.occurrences) && Array.isArray(record.songs);
    if (view === "vtuberRank") return Array.isArray(record.occurrences) && Array.isArray(record.songs);
    if (view === "videos") return Array.isArray(record.songs);
    return Array.isArray(record.occurrences) && Array.isArray(record.artists);
  });
}

function requestManifestFromViewRef(viewRef, request) {
  return {
    schemaVersion: 1,
    kind: "request-view-manifest",
    rangeId: canonicalRangeId(request.range),
    view: viewRef.view || request.view,
    metric: viewRef.metric || request.rankMetric || "occurrences",
    scopeKey: viewRef.scopeKey || requestScopeKey(request.view),
    pageSize: Number(viewRef.pageSize) || currentPageSize(),
    totalCount: Number(viewRef.totalCount) || 0,
    pageCount: Number(viewRef.pageCount) || 1,
    indexPath: viewRef.indexPath || "",
    bootstrapPath: viewRef.bootstrapPath || "",
    manifestPath: viewRef.manifestPath || "",
  };
}

function requestScopeKey(view = state.view) {
  const niche = state.nicheOnly;
  const hideUnknown = view === "artistRank" || view === "vtuberRank" ? false : state.hideUnknownArtist;
  if (niche && hideUnknown) return "visibleNiche";
  if (niche) return "niche";
  if (hideUnknown) return "visible";
  return "all";
}

function canUseDirectRequestPage(view, filters = {}) {
  if (normalizeSearch(filters.q)) return false;
  if (Number(filters.minCount) > 1 && view !== "videos") return false;
  if (filters.trend && filters.trend !== "all" && (view === "songRank" || view === "artistRank")) return false;
  if (view === "songAz" && filters.indexBucket && filters.indexBucket !== INDEX_ALL_BUCKET) return false;
  return true;
}

function buildRequestPageKey(request) {
  return [
    "page",
    canonicalRangeId(request.range),
    state.runtimeMeta?.dataVersion || "",
    request.view,
    request.rankMetric,
    requestScopeKey(request.view),
    requestFilterKey(request.filters, request.view),
    Number(request.page) || 1,
    Number(request.pageSize) || currentPageSize(),
  ].join("::");
}

function requestFilterKey(filters = {}, view = state.view) {
  const effectiveFilters = requestFiltersForView(view, filters);
  return [
    normalizeSearch(effectiveFilters.q || ""),
    effectiveFilters.searchScope || "all",
    searchFieldKeyForView(view, effectiveFilters.searchFields || DEFAULT_SEARCH_FIELDS),
    effectiveFilters.nicheOnly ? "niche" : "all",
    effectiveFilters.hideUnknownArtist ? "hide" : "show",
    effectiveFilters.trend || "all",
    Number(effectiveFilters.minCount) || 1,
    effectiveFilters.indexBucket || INDEX_ALL_BUCKET,
  ].join("|");
}

async function loadRequestSummary(range, signal) {
  if (state.runtimeApi.available) {
    return apiSummaryFromPayload({
      rangeId: range,
      totalCount: Number(state.runtimeApi.meta?.counts?.ranking_rows) || 0,
      totalOccurrenceCount: Number(state.runtimeApi.meta?.counts?.occurrences) || 0,
      totalVideoCount: Number(state.runtimeApi.meta?.counts?.videos) || 0,
    });
  }
  const requestMeta = requestRuntimeMeta(range);
  const path = requestMeta?.summary?.path;
  if (!path) throw new Error(`request summary missing for ${range}`);
  return readCachedRequestJson(state.requestRuntime.summaryCache, path, signal);
}

async function loadRequestViewManifest(path, signal) {
  return readCachedRequestJson(state.requestRuntime.viewManifestCache, path, signal);
}

async function loadRequestViewIndex(manifest, signal) {
  if (!manifest?.indexPath) throw new Error("request view index missing");
  const payload = await readCachedRequestJson(state.requestRuntime.viewIndexCache, manifest.indexPath, signal);
  if (Array.isArray(payload?.records)) return payload;
  const pages = Array.isArray(payload?.pages) && payload.pages.length ? payload.pages : manifest.indexPages || [];
  if (!pages.length) return { ...payload, records: [] };
  const records = [];
  const pagePayloads = await Promise.all(
    pages.map((page) => readCachedRequestJson(state.requestRuntime.viewIndexCache, page.path, signal)),
  );
  for (const pagePayload of pagePayloads) {
    if (Array.isArray(pagePayload?.records)) records.push(...pagePayload.records);
  }
  return {
    ...payload,
    records,
    totalCount: Number(payload?.totalCount) || records.length,
  };
}

async function readCachedRequestJson(cache, path, signal) {
  if (cache.has(path)) return cache.get(path);
  const payload = await readJson(path, { cache: cacheModeForPath(path), signal });
  cache.set(path, payload);
  return payload;
}

async function filterRequestIndexEntries(entries, options = {}) {
  const filters = options.filters || {};
  const query = normalizeSearch(filters.q || "");
  let result = entries;
  if (query) {
    const candidates = await loadRequestSearchCandidates(query, filters, options.signal);
    const allowEntryTextFallback = candidates === null || searchUsesAllFields(filters);
    result = result.filter((entry) => (candidates?.has?.(`${entry.type}:${entry.detailKey}`) || false) || (allowEntryTextFallback && searchTextMatchesQuery(entry.searchText, query)));
  }
  if (options.view === "songAz" && filters.indexBucket && filters.indexBucket !== INDEX_ALL_BUCKET) {
    result = result.filter((entry) => entry.bucket === filters.indexBucket);
  }
  if (Number(filters.minCount) > 1 && options.view !== "videos") {
    const minCount = Number(filters.minCount) || 1;
    result = result.filter((entry) => Number(entry.rankValue) >= minCount);
  }
  if (!state.runtimeApi.available && filters.trend && filters.trend !== "all" && (options.view === "songRank" || options.view === "artistRank")) {
    try {
      await loadRankDiffForRange(state.range);
      const trendMode = options.view === "artistRank" ? "artistRank" : "songRank";
      result = result.filter((entry) => requestEntryMatchesTrend(entry, trendMode, filters.trend));
    } catch {
      result = [];
    }
  }
  if (options.view === "songRank" || options.view === "artistRank" || options.view === "vtuberRank") {
    return applyRequestRanks(result);
  }
  return result;
}

function requestEntryMatchesTrend(entry, mode, trendFilter) {
  const trend = state.rankDiffs?.[state.range]?.[mode]?.get(entry.key);
  if (!trend) return false;
  if (trendFilter === "new") return trend.isNew === true;
  const rankDelta = Number(trend.rankDelta) || 0;
  if (trendFilter === "up") return rankDelta > 0;
  if (trendFilter === "down") return rankDelta < 0;
  return true;
}

function applyRequestRanks(entries) {
  const rankedEntries = [...entries].sort(compareRequestRankEntries);
  const frequencies = new Map();
  for (const entry of rankedEntries) frequencies.set(entry.rankValue, (frequencies.get(entry.rankValue) || 0) + 1);
  let previousValue = null;
  let rank = 0;
  return rankedEntries.map((entry, index) => {
    if (entry.rankValue !== previousValue) {
      rank = index + 1;
      previousValue = entry.rankValue;
    }
    return {
      ...entry,
      rank,
      isTied: (frequencies.get(entry.rankValue) || 0) > 1,
    };
  });
}

function compareRequestRankEntries(a, b) {
  return Number(b.rankValue) - Number(a.rankValue) || Number(a.rank || 0) - Number(b.rank || 0) || compareValues(a.searchText || a.key, b.searchText || b.key);
}

async function loadRequestSearchCandidates(query, filters = {}, signal) {
  const records = await loadRequestSearchRecords(query, signal);
  if (records === null) return null;
  const candidates = new Set();
  for (const record of records) {
    if (!requestSearchRecordMatchesFields(record, filters)) continue;
    candidates.add(`${record.type}:${record.detailKey}`);
  }
  return candidates;
}

function requestSearchRecordMatchesFields(record, filters = {}) {
  if (filters.searchScope && filters.searchScope !== "all") return true;
  const fields = Array.isArray(filters.searchFields) ? filters.searchFields : DEFAULT_SEARCH_FIELDS;
  if (!fields.length) return true;
  if (record.type === "song") return fields.includes("title");
  if (record.type === "artist") return fields.includes("artist");
  if (record.type === "vtuber" || record.type === "channel") return fields.includes("channel");
  if (record.type === "video") return fields.includes("video");
  return fields.includes("channel") || fields.includes("video");
}

function searchUsesAllFields(filters = {}) {
  if (filters.searchScope && filters.searchScope !== "all") return true;
  return !(filters.searchFields || DEFAULT_SEARCH_FIELDS).length;
}

async function buildRequestSearchSuggestions(query, options = {}) {
  const filterKey = normalizeSearch(query);
  if (!filterKey) return [];
  const records = await loadRequestSearchRecords(filterKey, options.signal);
  if (records === null) return [];
  const groups = {
    songs: [],
    artists: [],
    channels: [],
  };
  const seen = {
    songs: new Set(),
    artists: new Set(),
    channels: new Set(),
  };
  for (const record of records) {
    if (record.type === "song" && groups.songs.length < 5) {
      pushSuggestion(groups.songs, seen.songs, {
        label: record.label || "",
        value: record.label || "",
        meta: record.meta || "",
      });
    } else if (record.type === "artist" && groups.artists.length < 3) {
      pushSuggestion(groups.artists, seen.artists, {
        label: record.label || "",
        value: record.label || "",
        meta: "歌手",
      });
    } else if (record.meta && groups.channels.length < 3) {
      pushSuggestion(groups.channels, seen.channels, {
        label: record.meta,
        value: record.meta,
        meta: "频道",
      });
    }
    if (groups.songs.length >= 5 && groups.artists.length >= 3 && groups.channels.length >= 3) break;
  }
  return [
    { label: "歌曲", items: groups.songs },
    { label: "歌手", items: groups.artists },
    { label: "频道", items: groups.channels },
  ];
}

function pushSuggestion(target, seen, item) {
  const key = normalizeEntityKey(item.value || item.label);
  if (!key || seen.has(key)) return;
  seen.add(key);
  target.push(item);
}

async function loadRequestSearchRecords(query, signal) {
  const range = state.range;
  if (state.runtimeApi.available) {
    const params = new URLSearchParams({
      range,
      view: "songs",
      metric: "occurrences",
      page: "1",
      pageSize: "12",
      q: cleanText(query),
    });
    const payload = await readJson(`${API_RANKINGS_PATH}?${params.toString()}`, {
      cache: "no-cache",
      signal,
    });
    if (!Array.isArray(payload?.records)) return [];
    return payload.records.map((record) => ({
      type: "song",
      label: record.title || "",
      value: record.title || "",
      meta: record.displayArtist || record.artist || "",
      searchText: record.searchText || normalizeSearch([record.title, record.displayArtist, record.artist].filter(Boolean).join(" ")),
    }));
  }
  const requestMeta = requestRuntimeMeta(range);
  const manifestPath = requestMeta?.search?.manifestPath;
  if (!manifestPath) return null;
  const manifest = await readCachedRequestJson(state.requestRuntime.searchManifestCache, manifestPath, signal);
  if (manifest?.disabled) return null;
  const bucketIds = Array.from(requestSearchBuckets(query));
  const bucketMetas = bucketIds.map((bucket) => manifest.buckets?.[bucket]).filter((bucketMeta) => bucketMeta?.pages?.length);
  if (!bucketMetas.length && manifest.buckets?._?.pages?.length) bucketMetas.push(manifest.buckets._);
  if (!bucketMetas.length) return [];
  const records = [];
  const seenPages = new Set();
  const seenRecords = new Set();
  for (const bucketMeta of bucketMetas) {
    for (const page of bucketMeta.pages) {
      if (!page?.path || seenPages.has(page.path)) continue;
      seenPages.add(page.path);
      const payload = await readCachedRequestJson(state.requestRuntime.searchShardCache, page.path, signal);
      for (const record of payload.records || []) {
        const key = `${record.type || ""}:${record.detailKey || record.key || record.label || ""}`;
        if (seenRecords.has(key)) continue;
        if (!searchTextMatchesQuery(record.searchText, query)) continue;
        seenRecords.add(key);
        records.push(record);
      }
    }
  }
  return records;
}

function requestSearchBuckets(query) {
  const buckets = new Set();
  for (const token of window.FrontendUtils.searchTokens(query)) {
    buckets.add(requestSearchBucket(token));
    if (buckets.size >= 64) break;
  }
  if (!buckets.size) buckets.add("_");
  return buckets;
}

function requestSearchBucket(query) {
  const normalized = normalizeSearch(query).trim();
  const char = normalized[0] || "_";
  const code = char.codePointAt(0) || 95;
  return `b${String(code % 64).padStart(2, "0")}`;
}

async function loadRequestDetailRecords(entries, signal) {
  const byShard = new Map();
  for (const entry of entries || []) {
    if (!entry.detailShard) continue;
    if (!byShard.has(entry.detailShard)) byShard.set(entry.detailShard, []);
    byShard.get(entry.detailShard).push(entry);
  }
  const recordByKey = new Map();
  for (const [path, pathEntries] of byShard.entries()) {
    const payload = await readCachedRequestJson(state.requestRuntime.detailShardCache, path, signal);
    for (const record of payload.records || []) {
      recordByKey.set(record.detailKey, record);
    }
    for (const entry of pathEntries) {
      if (!recordByKey.has(entry.detailKey)) throw new Error(`detail record missing: ${entry.detailKey}`);
    }
  }
  return (entries || []).map((entry) => hydrateRequestRecord(recordByKey.get(entry.detailKey), entry.type)).filter(Boolean);
}

function hydrateRequestRecords(records, view) {
  const type = view === "artistRank" ? "artist" : view === "vtuberRank" ? "vtuber" : view === "videos" ? "video" : "song";
  return (records || []).map((record) => hydrateRequestRecord(record, record.type || type)).filter(Boolean);
}

function hydrateRequestRecord(record, type) {
  if (!record) return null;
  if (type === "artist") return hydrateRequestArtistRecord(record);
  if (type === "vtuber") return hydrateRequestVtuberRecord(record);
  if (type === "video") return hydrateRequestVideoRecord(record);
  return hydrateRequestSongRecord(record);
}

function hydrateRequestSongRecord(record) {
  return {
    ...record,
    artists: hydrateCountMap(record.artists),
    channels: hydrateCountMap(record.channels),
    occurrences: hydrateOccurrences(record.occurrences),
  };
}

function hydrateRequestArtistRecord(record) {
  return {
    ...record,
    songs: hydrateCountMap(record.songs),
    channels: hydrateCountMap(record.channels),
    occurrences: hydrateOccurrences(record.occurrences),
  };
}

function hydrateRequestVideoRecord(record) {
  const songs = Array.isArray(record.songs) ? record.songs : [];
  const allSongs = Array.isArray(record._allSongs) ? record._allSongs : songs;
  return {
    ...record,
    songs,
    _displaySongs: Array.isArray(record._displaySongs) ? record._displaySongs : songs,
    _allSongs: allSongs,
    _sourceItem: record,
  };
}

function hydrateRequestVtuberRecord(record) {
  return {
    ...record,
    songs: normalizeVtuberSongCountMap(hydrateCountMap(record.songs)),
    occurrences: hydrateOccurrences(record.occurrences),
  };
}

function normalizeVtuberSongCountMap(map) {
  const normalized = new Map();
  for (const entry of map?.values?.() || []) {
    const name = cleanText(entry?.name);
    if (!name || !shouldShowSongGroupTitle(name)) continue;
    const key = songWorkKeyForTitle(name) || normalizeEntityKey(name);
    if (!key) continue;
    const existing = normalized.get(key);
    if (existing) {
      existing.count += Math.max(0, Number(entry.count) || 0);
      continue;
    }
    normalized.set(key, {
      key,
      name,
      count: Math.max(0, Number(entry.count) || 0),
    });
  }
  return normalized;
}

function hydrateOccurrences(occurrences) {
  return (occurrences || []).filter(isOccurrenceLike);
}

function hydrateCountMap(values) {
  const map = new Map();
  for (const entry of values || []) {
    if (!entry?.key && !entry?.name) continue;
    const key = entry.key || normalizeEntityKey(entry.name);
    if (!key) continue;
    map.set(key, {
      key,
      name: entry.name || entry.title || "",
      count: Number(entry.count) || 0,
    });
  }
  return map;
}

function buildRequestResult({
  request,
  summary,
  manifest,
  entries,
  records,
  bucketEntries = null,
  page,
  totalCount,
  filteredBaseCount,
  filterKey,
  totalOccurrenceCount = null,
  totalVideoCount = null,
}) {
  const pageSize = Number(request.pageSize) || currentPageSize();
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = clampPage(page, pageCount);
  const pageInfo = {
    page: currentPage,
    pageSize,
    total: totalCount,
    totalCount,
    pageCount,
    visible: records,
    startIndex: totalCount ? (currentPage - 1) * pageSize : 0,
    endIndex: Math.min(totalCount, (currentPage - 1) * pageSize + records.length),
    hasPrevious: currentPage > 1,
    hasNext: currentPage < pageCount,
    previousPage: currentPage > 1 ? currentPage - 1 : null,
    nextPage: currentPage < pageCount ? currentPage + 1 : null,
    currentLabel: `${currentPage}/${pageCount}`,
  };
  return {
    range: canonicalRangeId(request.range),
    view: request.view,
    metric: manifest.metric || request.rankMetric || "occurrences",
    scopeKey: manifest.scopeKey || requestScopeKey(request.view),
    filterKey,
    summary,
    manifest,
    entries,
    bucketEntries,
    records,
    pageInfo,
    totalCount,
    filteredBaseCount,
    totalOccurrenceCount,
    totalVideoCount,
    pageSize,
  };
}

function clampPage(page, pageCount) {
  const maxPage = Math.max(1, Number(pageCount) || 1);
  const nextPage = Number.isFinite(Number(page)) ? Math.floor(Number(page)) : 1;
  return Math.min(maxPage, Math.max(1, nextPage));
}

function renderRequestedPageResult(result, options = {}) {
  resetContentClasses();
  state.compactDrawerLru = [];
  els.content.replaceChildren();
  if (result.view === "videos") {
    els.content.classList.add("video-grid");
    if (state.videoLayout === "compact") els.content.classList.add("video-compact");
  } else if (result.view === "songAz") {
    els.content.classList.add("song-index");
  } else {
    els.content.classList.add("rank-panel");
  }
  setCurrentResultSummary(makeQueryDraftFromState(), result.totalCount);
  renderRequestSummary(result);
  if (options.staleError) renderRequestInlineWarning(options.staleError);
  if (!result.records.length) {
    renderEmpty(emptyMessage(
      result.view === "videos" ? "这个范围还没有时间戳歌曲列表" : result.view === "artistRank" ? "这个范围还没有歌手资料" : result.view === "vtuberRank" ? "这个范围还没有VTuber频道资料" : result.view === "songAz" ? "这个范围还没有歌曲索引" : "这个范围还没有歌曲",
      result.view === "videos" ? "没有找到符合条件的视频" : result.view === "artistRank" ? "没有找到符合条件的歌手" : result.view === "vtuberRank" ? "没有找到符合条件的频道" : "没有找到符合条件的歌曲",
      result.view === "videos" ? "没有找到小众歌曲视频" : result.view === "artistRank" ? "没有找到小众歌曲歌手" : result.view === "vtuberRank" ? "没有找到小众歌曲频道" : "没有找到小众歌曲",
    ), { clearable: Boolean(state.filter) });
    return;
  }
  const fragment = document.createDocumentFragment();
  const unit = requestPageUnit(result.view);
  appendPagination(fragment, { pageInfo: result.pageInfo, unit, variant: "top" });
  if (result.view === "songRank") {
    fragment.append(renderRankHeader("song"));
    for (const [index, record] of result.records.entries()) {
      const entry = result.entries[index] || {};
      fragment.append(renderRankRecord({
        mode: "song",
        key: `song-${record.key}`,
        rank: entry.rank || record.rank || 0,
        isTied: entry.isTied === true,
        title: record.title,
        record,
        meta: songMeta(record),
        isNiche: entry.isNiche ?? isNicheRecord(record),
        videoCount: record.videoCount,
        count: rankValueForRequestRecord(record, result.metric),
        countUnit: result.metric === "videos" ? "视频" : "次",
        occurrences: record.occurrences,
        trend: trendForKey("songRank", record.key),
        priorityInlineMedia: index < 8,
      }));
    }
  } else if (result.view === "artistRank") {
    fragment.append(renderRankHeader("artist"));
    for (const [index, record] of result.records.entries()) {
      const entry = result.entries[index] || {};
      fragment.append(renderRankRecord({
        mode: "artist",
        key: `artist-${record.key}`,
        rank: entry.rank || record.rank || 0,
        isTied: entry.isTied === true,
        title: record.name,
        record,
        meta: artistMeta(record),
        videoCount: record.videoCount,
        count: rankValueForRequestRecord(record, result.metric),
        countUnit: result.metric === "videos" ? "视频" : "次",
        occurrences: record.occurrences,
        songCount: record.songs.size,
        songPreview: artistSongPreview(record),
        getSongGroups: () => getArtistSongGroups(record),
        trend: trendForKey("artistRank", record.key),
        priorityInlineMedia: index < 8,
      }));
    }
  } else if (result.view === "vtuberRank") {
    fragment.append(renderRankHeader("vtuber"));
    for (const [index, record] of result.records.entries()) {
      const entry = result.entries[index] || {};
      const songGroups = getVtuberSongGroups(record);
      fragment.append(renderRankRecord({
        mode: "vtuber",
        key: `vtuber-${record.key}`,
        rank: entry.rank || record.rank || 0,
        isTied: entry.isTied === true,
        title: record.name,
        record,
        meta: vtuberMeta(record),
        videoCount: record.videoCount,
        count: rankValueForRequestRecord(record, result.metric),
        countUnit: result.metric === "songs" ? "首歌" : result.metric === "videos" ? "视频" : "次",
        occurrences: record.occurrences,
        songCount: songCountForRecord(record),
        songGroups,
        songPreview: songGroups.slice(0, 2).map((group) => group.title),
        getSongGroups: () => getVtuberSongGroups(record),
        priorityInlineMedia: index < 8,
      }));
    }
  } else if (result.view === "songAz") {
    const bucketModel = requestIndexBucketModel(result);
    fragment.append(renderIndexToolbar(bucketModel, result.pageInfo));
    const list = document.createElement("div");
    list.className = "index-list index-list-flat";
    for (const [index, record] of result.records.entries()) {
      list.append(renderIndexRecord(record, { priorityInlineMedia: index < 8 }));
    }
    fragment.append(list);
  } else {
    for (const item of result.records) fragment.append(renderVideo(item));
  }
  appendPagination(fragment, { pageInfo: result.pageInfo, unit, variant: "bottom" });
  els.content.append(fragment);
}

function renderRequestSummary(result) {
  const scope = result.summary?.scopes?.[result.scopeKey] || {};
  const occurrenceCount = summaryMetricValue(result.totalOccurrenceCount, scope.occurrenceCount);
  const metrics = [];
  if (result.view === "artistRank") {
    metrics.push(metric(result.totalCount, "位歌手"));
    metrics.push(metric(occurrenceCount, "条歌曲收录"));
  } else if (result.view === "vtuberRank") {
    metrics.push(metric(result.totalCount, "个频道"));
    metrics.push(metric(occurrenceCount, "条歌曲收录"));
  } else if (result.view === "videos") {
    metrics.push(metric(result.totalCount, "个视频"));
    metrics.push(metric(occurrenceCount, "个时间戳"));
  } else {
    metrics.push(metric(result.totalCount, "首歌曲"));
    metrics.push(metric(occurrenceCount, "条歌曲收录"));
  }
  renderSummary(currentGroup(), metrics, requestSummaryNote(result));
}

function summaryMetricValue(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const fallbackNumeric = Number(fallback);
  return Number.isFinite(fallbackNumeric) && fallbackNumeric >= 0 ? fallbackNumeric : 0;
}

function requestSummaryNote(result) {
  const parts = [];
  if (result.totalCount !== result.filteredBaseCount) parts.push(`已筛选 ${result.totalCount} / ${result.filteredBaseCount}`);
  if (state.minCount > 1 && result.view !== "videos") parts.push(`最低${state.minCount}${rankCountUnit()}以上`);
  if (state.trend !== "all" && (result.view === "songRank" || result.view === "artistRank")) parts.push(`趋势：${TREND_FILTERS[state.trend] || state.trend}`);
  if (state.hideUnknownArtist && result.view !== "artistRank" && result.view !== "vtuberRank") parts.push("已隐藏无歌手");
  return parts.join(" · ");
}

function renderRequestInlineWarning(error) {
  const warning = document.createElement("div");
  warning.className = "content-warning";
  warning.setAttribute("role", "status");
  warning.setAttribute("aria-live", "polite");

  const copy = document.createElement("div");
  copy.className = "content-warning-copy";
  const title = document.createElement("strong");
  title.className = "content-warning-title";
  title.textContent = "数据暂时不可用，已保留当前内容";
  const message = document.createElement("span");
  message.className = "content-warning-message";
  message.textContent = requestErrorFriendlyMessage(error);
  copy.append(title, message);

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "content-warning-retry";
  retry.textContent = "重试";
  retry.addEventListener("click", async () => {
    retry.disabled = true;
    retry.textContent = "重试中…";
    try {
      await renderRequestedRuntime({ syncUrl: false, preservePageInput: true });
    } finally {
      retry.disabled = false;
      retry.textContent = "重试";
    }
  });

  const details = document.createElement("details");
  details.className = "content-warning-details";
  const summary = document.createElement("summary");
  summary.textContent = "诊断详情";
  const diagnostic = document.createElement("pre");
  diagnostic.textContent = requestErrorDiagnostic(error);
  details.append(summary, diagnostic);

  warning.append(copy, retry, details);
  els.content.append(warning);
}

function requestErrorFriendlyMessage(error) {
  const status = Number(error?.status) || 0;
  if (status === 400) return "查询条件有误，请调整后重试。";
  if (status === 404) return "请求的数据不存在或尚未生成。";
  if (status === 502 || status === 503) return "数据服务暂时不可用，请稍后重试。";
  if (status === 504) return "查询处理超时，请稍后重试。";
  return "网络或数据服务发生异常，请稍后重试。";
}

function requestErrorDiagnostic(error) {
  const lines = [];
  if (Number(error?.status)) lines.push(`HTTP ${Number(error.status)}`);
  if (error?.requestPath) lines.push(`请求：${error.requestPath}`);
  const detail = cleanText(error?.diagnosticDetail || error?.body || "");
  if (detail) lines.push(`详情：${detail.slice(0, 240)}`);
  return lines.length ? lines.join("\n") : "暂无更多诊断信息";
}

function requestPageUnit(view) {
  if (view === "videos") return "个视频";
  if (view === "artistRank") return "位歌手";
  if (view === "vtuberRank") return "个频道";
  return "首歌曲";
}

function rankValueForRequestRecord(record, metricName) {
  if (metricName === "songs") return songCountForRecord(record);
  return metricName === "videos" ? Number(record.videoCount) || 0 : Number(record.count) || 0;
}

function requestIndexBucketModel(result) {
  const entries = Array.isArray(result.bucketEntries) ? result.bucketEntries : result.entries || [];
  return window.FrontendUtils.buildIndexBucketModel(entries, {
    bucket: state.indexBucket,
    getBucketLabel: (entry) => entry.bucket || "其他",
    compareBuckets: compareIndexBuckets,
  });
}

function scheduleAdjacentRequestPagePrefetch(result) {
  if (result?.view === "vtuberRank") return;
  if (!result || !canUseRequestRuntime(result.range)) return;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (connection?.saveData) return;
  const run = () => {
    for (const page of [result.pageInfo.page - 1, result.pageInfo.page + 1]) {
      if (page < 1 || page > result.pageInfo.pageCount) continue;
      requestViewPage({
        range: result.range,
        view: result.view,
        rankMetric: result.metric,
        filters: requestFilterState(),
        page,
        pageSize: result.pageSize,
        prefetch: true,
      }).catch(() => {});
    }
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 1400 });
  else window.setTimeout(run, 300);
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
  } else if (state.view === "vtuberRank") {
    const vtuberRecords = state.nicheOnly ? cache.nicheVtuberRecords : cache.allVtuberRecords;
    cacheRankModel(cache, `vtuber-rank::${scope}::${filterKey}::${state.rankMetric}`, [...vtuberRecords].sort(compareRankRecords));
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
  defineLazyVtuberCache(cache, "all", occurrences);
  defineLazyVtuberCache(cache, "niche", nicheOccurrences);
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

function defineLazyVtuberCache(cache, prefix, occurrences) {
  const recordsKey = `${prefix}VtuberRecords`;
  defineLazyValue(cache, recordsKey, () => measureSync("build-vtuber-records", () => buildVtuberRecords(occurrences)));
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
  const searchFieldKey = searchFieldKeyForView(state.view, state.searchFields || DEFAULT_SEARCH_FIELDS);
  const key = `${state.view}::${state.nicheOnly ? "niche" : "all"}::${hideUnknownForView ? "hide-unknown" : "show-unknown"}::${filterKey}::${searchFieldKey}`;
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
    const occurrences = baseOccurrences.filter((occurrence) => searchTextMatchesQuery(occurrenceSearchTextForCurrentView(occurrence), state.filter));
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

  if (state.view === "vtuberRank") {
    defineLazyValue(selection, "vtuberRecords", () =>
      filtered ? measureSync("build-vtuber-records", () => buildVtuberRecords(occurrences)) : state.nicheOnly ? rangeCache.nicheVtuberRecords : rangeCache.allVtuberRecords,
    );
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
  return state.hideUnknownArtist && state.view !== "artistRank" && state.view !== "vtuberRank";
}

function occurrenceSearchTextForCurrentView(occurrence) {
  if (state.view === "artistRank") return artistOccurrenceSearchText(occurrence);
  if (state.view === "vtuberRank") return vtuberOccurrenceSearchText(occurrence);
  if (state.view === "songRank" || state.view === "songAz") return songOccurrenceSearchText(occurrence, state.searchFields || DEFAULT_SEARCH_FIELDS);
  return occurrence?.searchText || "";
}

function hiddenUnknownOccurrenceCount(rangeCache) {
  if (state.nicheOnly) return Math.max(0, rangeCache.nicheOccurrences.length - rangeCache.visibleNicheOccurrences.length);
  return Math.max(0, rangeCache.occurrences.length - rangeCache.visibleOccurrences.length);
}

function sortedSelectionRecords(rangeCache, selection, type, compare) {
  const key = sortedRecordsKey(type);
  if (!rangeCache.sortedRecords.has(key)) {
    const source = type.startsWith("artist") ? selection.artistRecords : type.startsWith("vtuber") ? selection.vtuberRecords : selection.songRecords;
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
  const metricKey = state.rankMetric;
  return `${type}::${state.nicheOnly ? "niche" : "all"}::${hideKey}::${normalizeSearch(state.filter)}::${metricKey}`;
}

function filteredRankModel(records, mode) {
  const minFiltered = filterRecordsByMinCount(records);
  const trendFiltered = filterRecordsByTrend(minFiltered, mode);
  return {
    records: trendFiltered,
    ranks: buildCompetitionRanks(trendFiltered),
    countFrequencies: buildCountFrequencies(trendFiltered, rankValue),
    baseCount: records.length,
    minCountApplied: mode !== "vtuberRank" && state.minCount > 1,
    trendApplied: state.trend !== "all" && trendFiltered.length !== minFiltered.length,
  };
}

function filterRecordsByMinCount(records) {
  if (state.view === "videos" || state.view === "vtuberRank" || state.minCount <= 1) return records;
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

function songRecordSummaryTotals(rangeCache, baseRecords, options = {}) {
  const hideUnknownForView = Boolean(options.hideUnknownForView);
  const needsAllRecordDenominator = Boolean(state.filter || state.nicheOnly);
  const needsNicheRecordDenominator = Boolean(state.filter && state.nicheOnly);
  return {
    total: needsAllRecordDenominator
      ? hideUnknownForView
        ? rangeCache.visibleSongRecords.length
        : rangeCache.allSongRecords.length
      : baseRecords.length,
    nicheTotal: needsNicheRecordDenominator
      ? hideUnknownForView
        ? rangeCache.visibleNicheSongRecords.length
        : rangeCache.nicheSongRecords.length
      : 0,
  };
}

function renderSongRank(group, rangeCache, selection) {
  const sourceOccurrences = rangeCache.occurrences;
  const hideUnknownForView = shouldHideUnknownForCurrentView();
  const sourceVisibleOccurrences = hideUnknownForView ? rangeCache.visibleOccurrences : sourceOccurrences;
  const occurrences = selection.occurrences;
  const baseModel = rankingModelForSelection(rangeCache, selection, "song-rank", compareSongRank);
  const filteredModel = filteredRankModel(baseModel.records, "songRank");
  const { records, ranks, countFrequencies } = filteredModel;
  const summaryTotals = songRecordSummaryTotals(rangeCache, baseModel.records, { hideUnknownForView });
  setCurrentResultSummary(makeQueryDraftFromState(), records.length);

  renderSummary(group, [
    recordVisibilityMetric(records.length, baseModel.records.length, summaryTotals.total, summaryTotals.nicheTotal, "首歌曲", "首小众歌曲"),
    occurrenceVisibilityMetric(occurrences.length, sourceVisibleOccurrences.length, hideUnknownForView ? rangeCache.visibleNicheOccurrences.length : rangeCache.nicheOccurrences.length),
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
  for (const [index, record] of pageInfo.visible.entries()) {
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
        priorityInlineMedia: index < 8,
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

function renderVtuberRank(group, rangeCache, selection) {
  const sourceOccurrences = rangeCache.occurrences;
  const allVtuberRecords = rangeCache.allVtuberRecords;
  const nicheVtuberRecords = rangeCache.nicheVtuberRecords;
  const baseModel = rankingModelForSelection(rangeCache, selection, "vtuber-rank", compareRankRecords);
  const filteredModel = filteredRankModel(baseModel.records, "vtuberRank");
  const { records, ranks, countFrequencies } = filteredModel;
  setCurrentResultSummary(makeQueryDraftFromState(), records.length);

  renderSummary(group, [
    recordVisibilityMetric(records.length, baseModel.records.length, allVtuberRecords.length, nicheVtuberRecords.length, "个频道", "个小众歌曲频道"),
    occurrenceVisibilityMetric(selection.occurrences.length, sourceOccurrences.length, rangeCache.nicheOccurrences.length),
  ], summaryNote(selection, filterStatusNote("vtuberRank", filteredModel)));

  if (!records.length) {
    renderEmpty(emptyMessage("这个范围还没有VTuber频道资料", "没有找到符合条件的频道", "没有找到小众歌曲频道"), {
      clearable: Boolean(state.filter),
    });
    return;
  }

  const pageInfo = pagedSlice(records);
  const fragment = document.createDocumentFragment();
  appendPagination(fragment, { pageInfo, unit: "个频道", variant: "top" });
  fragment.append(renderRankHeader("vtuber"));
  for (const [index, record] of pageInfo.visible.entries()) {
    const songGroups = getVtuberSongGroups(record);
    fragment.append(
      renderRankRecord({
        mode: "vtuber",
        key: `vtuber-${record.key}`,
        rank: ranks.get(record.key),
        isTied: countFrequencies.get(rankValue(record)) > 1,
        title: record.name,
        record,
        meta: vtuberMeta(record),
        videoCount: record.videoCount,
        count: rankValue(record),
        countUnit: state.rankMetric === "songs" ? "首歌" : state.rankMetric === "videos" ? "视频" : "次",
        occurrences: record.occurrences,
        songCount: songCountForRecord(record),
        songGroups,
        getSongGroups: () => getVtuberSongGroups(record),
        priorityInlineMedia: index < 8,
      }),
    );
  }
  appendPagination(fragment, { pageInfo, unit: "个频道", variant: "bottom" });
  els.content.append(fragment);
}

function renderSongIndexView(group, rangeCache, selection) {
  const sourceOccurrences = rangeCache.occurrences;
  const hideUnknownForView = shouldHideUnknownForCurrentView();
  const sourceVisibleOccurrences = hideUnknownForView ? rangeCache.visibleOccurrences : sourceOccurrences;
  const occurrences = selection.occurrences;
  const baseRecords = sortedSelectionRecords(rangeCache, selection, "song-az", compareSongAz);
  const records = filterRecordsByMinCount(baseRecords);
  const summaryTotals = songRecordSummaryTotals(rangeCache, baseRecords, { hideUnknownForView });
  setCurrentResultSummary(makeQueryDraftFromState(), records.length);

  renderSummary(group, [
    recordVisibilityMetric(records.length, baseRecords.length, summaryTotals.total, summaryTotals.nicheTotal, "首歌曲", "首小众歌曲"),
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
  const priorityIndexRecords = new Set(pageInfo.visible.slice(0, 8));
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
        listFragment.append(renderIndexRecord(record, { priorityInlineMedia: priorityIndexRecords.has(record) }));
      }
      list.append(listFragment);
      section.append(list);
      fragment.append(section);
    }
  } else {
    const list = document.createElement("div");
    list.className = "index-list index-list-flat";
    const listFragment = document.createDocumentFragment();
    for (const [index, record] of pageInfo.visible.entries()) {
      listFragment.append(renderIndexRecord(record, { priorityInlineMedia: index < 8 }));
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
  els.summary.classList.toggle("summary--compact", hasSummaryFilterContext());

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
  const metricParts = compactSummaryMetrics(metrics);
  if (metricParts.length) {
    const metricNode = document.createElement("span");
    metricNode.className = "summary-metrics";
    metricParts.forEach((part) => {
      const item = document.createElement("span");
      item.className = "summary-metric";
      item.textContent = part;
      metricNode.append(item);
    });
    const statusNode = renderSummaryStatusNode();
    if (statusNode) {
      metricNode.append(statusNode);
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
    noteNode.textContent = compactSummaryNote(note);
    noteNode.title = note;
    els.summary.append(noteNode);
  }

  const actions = renderSummaryActions();
  if (actions.childElementCount) els.summary.append(actions);
}

function hasSummaryFilterContext() {
  return Boolean(state.filter || state.nicheOnly || shouldHideUnknownForCurrentView() || state.minCount > 1 || state.trend !== "all");
}

function compactSummaryMetrics(metrics) {
  const hasSearchOrFilter = hasSummaryFilterContext();
  return metrics
    .filter(Boolean)
    .map((part) => {
      const text = String(part);
      if (hasSearchOrFilter) {
        return text
          .replace(/^显示\s+/u, "")
          .replace(/\s*\/\s*[0-9,]+/u, "")
          .replace(/([0-9,])\s+(首歌曲|首小众歌曲|位歌手|个频道|个小众歌曲频道|歌曲收录|小众歌曲收录|个视频|个小众视频|个时间戳)/gu, "$1$2");
      }
      return text.replace(/([0-9,])\s+(首歌曲|位歌手|个频道|歌曲收录|个视频|个时间戳)/gu, "$1$2");
    });
}

function compactSummaryNote(note) {
  let text = String(note);
  return text
    .replace(/隐藏([0-9,]+)条无歌手收录/u, "已隐藏无歌手")
    .replace(/隐藏([0-9,]+)条无歌手/u, "已隐藏无歌手")
    .replace(/最近([0-9]+)天累计/u, "近$1天")
    .replace(/\s*·\s*/gu, " · ");
}

function hiddenUnknownNote(selection) {
  const count = Number(selection?.hiddenUnknownCount) || 0;
  return state.hideUnknownArtist && count > 0 ? `隐藏${count}条无歌手收录` : "";
}

function summaryNote(selection, extra = "", rangeCache = null) {
  return [extra, summaryVideoVisibilityNote(rangeCache, selection), hiddenUnknownNote(selection)].filter(Boolean).join(" · ");
}

function summaryVideoMetric(rangeCache, selection) {
  const model = summaryVideoCountModel(rangeCache, selection);
  return model.usesSourceCount ? `${model.ratioText} 个视频` : metric(model.visibleCount, "个视频");
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

function renderSummaryActions() {
  const actions = document.createElement("div");
  actions.className = "summary-actions";

  const rankMetricEntries = rankMetricEntriesForView(state.view);
  if (rankMetricEntries.length > 1) {
    const metricGroup = document.createElement("div");
    metricGroup.className = "summary-segmented";
    metricGroup.setAttribute("role", "group");
    metricGroup.setAttribute("aria-label", "排行口径");
    for (const [value, label] of rankMetricEntries) {
      const button = document.createElement("button");
      const current = state.rankMetric === value;
      button.className = current ? "summary-action is-current" : "summary-action";
      button.type = "button";
      button.dataset.rankMetric = value;
      button.setAttribute("aria-pressed", current ? "true" : "false");
      button.textContent = rankMetricButtonText(value);
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
  void pageInfo;
  void variant;
  return false;
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
  controls.append(renderPageSelectControl(pageInfo, { compact: true }));
  controls.append(renderPageButton("下一页", model.nextPage || model.pageCount, !model.hasNext, false, { icon: "next" }));
  return controls;
}

function renderMobileBottomPagination(pageInfo) {
  const controls = document.createElement("div");
  controls.className = "pagination-controls pagination-bottom-stepper";
  controls.append(
    renderPageButton("上一页", pageInfo.page - 1, pageInfo.page === 1, false, { icon: "prev" }),
    renderPageSelectControl(pageInfo, { compact: true }),
    renderPageButton("下一页", pageInfo.page + 1, pageInfo.page === pageInfo.pageCount, false, { icon: "next" }),
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

function renderPageSelectControl(pageInfo, options) {
  options = options || {};
  if (!options.compact) return renderPageJumpControl(pageInfo);
  const label = document.createElement("form");
  label.className = options.compact ? "page-select page-select-compact" : "page-select";
  label.dataset.pageForm = "true";
  label.setAttribute("aria-label", `跳至页码，当前第 ${pageInfo.page} 页，共 ${pageInfo.pageCount} 页`);
  const text = document.createElement("span");
  text.className = "page-select-label";
  text.textContent = options.compact ? "第" : "跳至";
  const input = document.createElement("input");
  input.type = "text";
  input.min = "1";
  input.max = String(pageInfo.pageCount);
  input.step = "1";
  input.value = String(pageInfo.page);
  input.inputMode = "numeric";
  input.pattern = "[0-9]*";
  input.dataset.pageInput = "true";
  input.setAttribute("aria-label", `输入页码，范围 1 到 ${pageInfo.pageCount}`);
  bindPaginationInput(input);
  const total = document.createElement("span");
  total.className = "page-select-total";
  total.textContent = `/ ${pageInfo.pageCount}`;
  const submit = document.createElement("button");
  submit.className = "pagination-button page-select-submit";
  submit.type = "submit";
  submit.textContent = "选页";
  submit.setAttribute("aria-label", "跳转到输入页码");
  submit.addEventListener("click", handlePaginationFormSubmit);
  label.addEventListener("submit", handlePaginationFormSubmit);
  label.append(text, input, total, submit);
  return label;
}

function renderPageJumpControl(pageInfo) {
  const form = document.createElement("form");
  form.className = "page-jump";
  form.dataset.pageJumpForm = "true";

  const label = document.createElement("label");
  label.className = "page-jump-label";
  const text = document.createElement("span");
  text.textContent = "跳至";
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.pattern = "[0-9]*";
  input.min = "1";
  input.max = String(pageInfo.pageCount);
  input.value = String(pageInfo.page);
  input.dataset.pageInput = "true";
  input.setAttribute("aria-label", `输入页码，当前第 ${pageInfo.page} 页，共 ${pageInfo.pageCount} 页`);
  bindPaginationInput(input);
  label.append(text, input);

  const button = document.createElement("button");
  button.className = "pagination-button page-jump-button";
  button.type = "submit";
  button.textContent = "跳转";
  button.addEventListener("click", handlePaginationFormSubmit);
  form.addEventListener("submit", handlePaginationFormSubmit);
  form.append(label, button);
  return form;
}

function bindPaginationInput(input) {
  bindPageInputInteraction(input);
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    handlePaginationFormSubmit(event);
  });
}

function bindPageInputInteraction(input) {
  input.autocomplete = "off";
  input.spellcheck = false;
  const stopPageInputPropagation = (event) => {
    protectPageInputFromResize(input);
    event.stopPropagation();
  };
  input.addEventListener("pointerdown", stopPageInputPropagation);
  input.addEventListener("mousedown", stopPageInputPropagation);
  input.addEventListener("touchstart", stopPageInputPropagation, { passive: true });
  input.addEventListener("click", stopPageInputPropagation);
  input.addEventListener("focus", () => releasePageInputResizeProtection(input));
  bindPageInputSelection(input);
}

function cancelPendingResponsiveResize() {
  if (!state.resizeRenderFrame) return;
  window.cancelAnimationFrame(state.resizeRenderFrame);
  state.resizeRenderFrame = 0;
}

function protectPageInputFromResize(input) {
  pageInputPointerActive = true;
  const token = ++pageInputInteractionToken;
  cancelPendingResponsiveResize();
  window.setTimeout(() => {
    if (token !== pageInputInteractionToken || document.activeElement === input) return;
    pageInputPointerActive = false;
  }, 1000);
}

function releasePageInputResizeProtection(input) {
  if (document.activeElement !== input) return;
  pageInputInteractionToken += 1;
  pageInputPointerActive = false;
  cancelPendingResponsiveResize();
}

function bindPageInputSelection(input) {
  const selectValue = () => {
    if (document.activeElement !== input) return;
    try {
      input.select();
    } catch {
      // Embedded browsers may not expose a selectable range consistently.
    }
  };
  input.addEventListener("focus", () => window.requestAnimationFrame(selectValue));
  input.addEventListener("click", () => window.requestAnimationFrame(selectValue));
}

function capturePageInputState() {
  const active = document.activeElement;
  if (!active?.matches?.('[data-page-input="true"]')) return null;
  const form = active.closest("[data-page-form], [data-page-jump-form]");
  if (!form) return null;
  const forms = Array.from(document.querySelectorAll("[data-page-form], [data-page-jump-form]"));
  return {
    formIndex: forms.indexOf(form),
    value: active.value,
    selectionStart: active.selectionStart,
    selectionEnd: active.selectionEnd,
    selectionDirection: active.selectionDirection || "none",
  };
}

function cancelPageInputRestore() {
  pageInputRestoreToken += 1;
}

function restorePageInputState(snapshot) {
  if (!snapshot || snapshot.formIndex < 0) return;
  const token = ++pageInputRestoreToken;
  window.requestAnimationFrame(() => {
    if (token !== pageInputRestoreToken) return;
    const forms = Array.from(document.querySelectorAll("[data-page-form], [data-page-jump-form]"));
    const input = forms[snapshot.formIndex]?.querySelector('[data-page-input="true"]');
    if (!input) return;
    input.value = snapshot.value;
    try {
      input.focus({ preventScroll: true });
      const valueLength = input.value.length;
      const start = Math.min(valueLength, Math.max(0, Number(snapshot.selectionStart) || 0));
      const end = Math.min(valueLength, Math.max(start, Number(snapshot.selectionEnd) || start));
      input.setSelectionRange(start, end, snapshot.selectionDirection);
    } catch {
      // Some embedded browsers do not expose focus or selection APIs consistently.
    }
  });
}

function activePageInputElement() {
  const active = document.activeElement;
  return active?.matches?.('[data-page-input="true"]') ? active : null;
}

async function waitForPageInputToSettle(options = {}) {
  if (options.allowActive === true) return;
  const input = activePageInputElement();
  if (!input) return;
  await new Promise((resolve) => {
    const finish = () => {
      input.removeEventListener("blur", finish);
      resolve();
    };
    input.addEventListener("blur", finish, { once: true });
    if (document.activeElement !== input) finish();
  });
}

function handlePaginationFormSubmit(event) {
  const form = event.currentTarget?.matches?.("[data-page-form], [data-page-jump-form]")
    ? event.currentTarget
    : event.target?.closest?.("[data-page-form], [data-page-jump-form]");
  if (!form) return;
  event.preventDefault();
  event.stopPropagation();
  const input = form.querySelector("[data-page-input]");
  const page = Number.parseInt(input?.value || "1", 10);
  setPage(page);
  render({ focusAfterPageChange: true, preservePageInput: false, urlMode: "push" });
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
  const width = window.innerWidth || document.documentElement.clientWidth || 0;
  if (width && width <= RESPONSIVE_BREAKPOINTS.mobileMax) return "mobile";
  if (width && width <= RESPONSIVE_BREAKPOINTS.tabletMax) return "tablet";
  return "desktop";
}

function defaultListPageSizeForMode(mode = getResponsiveMode()) {
  return window.FrontendUtils.responsiveListPageSize(mode, LIST_PAGE_SIZE_BY_MODE);
}

function sourceDrawerPageSizeForMode(mode = getResponsiveMode()) {
  return window.FrontendUtils.responsiveListPageSize(mode, SOURCE_DRAWER_PAGE_SIZE_BY_MODE);
}

function isCompactRankMode() {
  return getResponsiveMode() !== "desktop";
}

function sourceInlineLimitForMode(mode = getResponsiveMode()) {
  return SOURCE_INLINE_LIMITS[mode] || SOURCE_INLINE_LIMITS.desktop;
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
    const nicheSongs = (item.songs || []).filter((song) => !nicheOnly || window.FrontendUtils.isNicheSong(song));
    const sourceSongs = hideUnknownArtists ? nicheSongs.filter((song) => !window.RankingUtils.isUnknownArtistName(song?.artist)) : nicheSongs;
    const originalSongs = item._allSongs || item.songs || [];
    const sourceItem = item._sourceItem || item;
    if (!normalizedFilter) {
      if (!sourceSongs.length) continue;
      result.push({ ...item, songs: sourceSongs, _displaySongs: sourceSongs, _allSongs: originalSongs, _sourceItem: sourceItem, _songSearchMatchCount: 0 });
      continue;
    }

    const videoMatched = matchesSearch([item.videoId, item.title, item.channelName, item.keyword], filter);
    const matchedSongs = sourceSongs.filter((song) => matchesSearch([item.videoId, song.title, song.artist], filter));
    if (!videoMatched && !matchedSongs.length) continue;

    const matchedSongSet = new Set(matchedSongs);
    if (!sourceSongs.length) continue;
    const displaySongs = [...matchedSongs, ...sourceSongs.filter((song) => !matchedSongSet.has(song))];
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

function buildVtuberRecords(occurrences) {
  const records = new Map();
  const identityLookup = buildVtuberIdentityLookup(occurrences);
  for (const occurrence of occurrences || []) {
    const item = occurrence.item || {};
    const song = occurrence.song || {};
    const key = vtuberRecordKey(item, identityLookup);
    if (!key) continue;
    if (!records.has(key)) {
      records.set(key, {
        type: "vtuber",
        key,
        name: preferredVtuberChannelName("未知频道", item.channelName || cleanVtuberChannelHandle(item.channelHandle) || item.channelId),
        channelName: cleanText(item.channelName),
        channelId: cleanText(item.channelId),
        channelHandle: cleanVtuberChannelHandle(item.channelHandle),
        channelUrl: vtuberChannelUrlCandidate(item),
        sourceUrl: cleanText(item.sourceUrl),
        avatarUrl: cleanText(item.avatarUrl || item.channelAvatarUrl || item.authorAvatarUrl || item.profileImageUrl),
        channelAvatarUrl: cleanText(item.channelAvatarUrl),
        knownSourceType: cleanText(item.knownSourceType || item.sourceType || item.collectionType),
        isCollected: false,
        thumbnailUrl: vtuberThumbnailCandidate(item),
        videoThumbnailUrl: vtuberThumbnailCandidate(item),
        displayImageUrl: "",
        displayImageKind: "",
        count: 0,
        videos: new Set(),
        songs: new Map(),
        occurrences: [],
        aliases: new Set(),
      });
    }
    const record = records.get(key);
    mergeVtuberRecordIdentity(record, item);
    mergeVtuberRecordMetadata(record, item, song);
    const videoKey = cleanText(item.videoId) || `${cleanText(item.channelName)}::${cleanText(item.title)}::${cleanText(item.publishedTimestamp)}`;
    if (videoKey) record.videos.add(videoKey);
    record.count += 1;
    record.occurrences.push(occurrence);
    incrementCanonicalSongCount(record.songs, cleanText(song.title));
  }
  return addRecordRuntimeFields(Array.from(records.values()).map((record) => {
    record.videoCount = record.videos.size;
    record.timestampCount = record.count;
    record.aliases = Array.from(record.aliases.values());
    const media = window.FrontendUtils.vtuberDisplayImageModel(record);
    record.displayImageUrl = media.src;
    record.displayImageKind = media.kind;
    record.searchText = vtuberRecordSearchText(record);
    return record;
  }));
}

function buildVtuberIdentityLookup(occurrences) {
  const nameToKey = new Map();
  const ambiguousNames = new Set();
  for (const occurrence of occurrences || []) {
    const item = occurrence?.item || {};
    const nameKey = vtuberNameIdentityKey(item);
    const directKey = directVtuberRecordKey(item);
    if (!nameKey || !directKey) continue;
    const existing = nameToKey.get(nameKey);
    if (existing && existing !== directKey) {
      ambiguousNames.add(nameKey);
      continue;
    }
    nameToKey.set(nameKey, directKey);
  }
  for (const nameKey of ambiguousNames) nameToKey.delete(nameKey);
  return { nameToKey };
}

function vtuberRecordKey(item, identityLookup = null) {
  const nameKey = vtuberNameIdentityKey(item);
  if (nameKey && identityLookup?.nameToKey?.has(nameKey)) return identityLookup.nameToKey.get(nameKey);
  const directKey = directVtuberRecordKey(item);
  if (directKey) return directKey;
  if (isCompositeChannelName(item?.channelName)) return "";
  return nameKey;
}

function directVtuberRecordKey(item) {
  const channelId = cleanText(item?.channelId);
  if (channelId) return channelId;
  const handle = cleanVtuberChannelHandle(item?.channelHandle).replace(/^\/+/, "") || vtuberHandleFromChannelUrl(vtuberChannelUrlCandidate(item)).replace(/^\/+/, "");
  if (handle) return normalizeEntityKey(handle);
  return "";
}

function vtuberNameIdentityKey(item) {
  const name = cleanText(item?.channelName);
  return name ? normalizeEntityKey(name) : "";
}

function isCompositeChannelName(value) {
  const text = cleanText(value);
  if (!text) return false;
  return /(?:、|，|,|\s+\+\s+|\s+×\s+)/u.test(text) && /(?:ch\.?|channel|ちゃんねる|チャンネル)/iu.test(text);
}

function mergeVtuberRecordIdentity(record, item) {
  const channelName = cleanText(item.channelName);
  const channelId = cleanText(item.channelId);
  const channelHandle = cleanVtuberChannelHandle(item.channelHandle);
  const channelUrl = vtuberChannelUrlCandidate(item);
  const sourceUrl = cleanText(item.sourceUrl);
  const avatarUrl = cleanText(item.avatarUrl || item.channelAvatarUrl);
  const thumbnailUrl = vtuberThumbnailCandidate(item);
  if (channelName) {
    record.aliases.add(channelName);
    record.channelName = preferredVtuberChannelName(record.channelName, channelName);
    record.name = preferredVtuberChannelName(record.name, channelName);
  }
  if (channelId) {
    record.aliases.add(channelId);
    if (!record.channelId) record.channelId = channelId;
  }
  if (channelHandle) {
    record.aliases.add(channelHandle);
    record.aliases.add(channelHandle.replace(/^\/?@/u, ""));
    if (!record.channelHandle) record.channelHandle = channelHandle;
  }
  if (channelUrl) {
    record.aliases.add(channelUrl);
    if (!record.channelUrl) record.channelUrl = channelUrl;
  }
  if (sourceUrl) {
    record.aliases.add(sourceUrl);
    if (!record.sourceUrl) record.sourceUrl = sourceUrl;
  }
  if (avatarUrl && !record.avatarUrl) record.avatarUrl = avatarUrl;
  if (thumbnailUrl && shouldUseVtuberThumbnail(record, item)) {
    record.thumbnailUrl = thumbnailUrl;
    record.videoThumbnailUrl = thumbnailUrl;
  }
  for (const alias of knownVtuberSearchAliases(channelName)) record.aliases.add(alias);
}

function vtuberThumbnailCandidate(item) {
  const explicit = cleanText(item.thumbnailUrl || item.videoThumbnail || item.videoThumbnailUrl || item.thumbnail);
  if (explicit) return explicit;
  const videoId = cleanText(item.videoId);
  return /^[A-Za-z0-9_-]{11}$/u.test(videoId) ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg` : "";
}

function shouldUseVtuberThumbnail(record, item) {
  if (!record.thumbnailUrl) {
    record.thumbnailPublishedTimestamp = Number(item.publishedTimestamp) || 0;
    return true;
  }
  const incomingTimestamp = Number(item.publishedTimestamp) || 0;
  const currentTimestamp = Number(record.thumbnailPublishedTimestamp) || 0;
  if (incomingTimestamp >= currentTimestamp) {
    record.thumbnailPublishedTimestamp = incomingTimestamp;
    return true;
  }
  return false;
}

function vtuberChannelUrlCandidate(item = {}) {
  const values = [
    item.channelUrl,
    item.authorUrl,
    item.ownerUrl,
    item.sourceUrl,
    ...(Array.isArray(item.sourceUrls) ? item.sourceUrls : []),
  ];
  return values.map(cleanText).find(isYoutubeChannelUrl) || "";
}

function isYoutubeChannelUrl(value) {
  const text = cleanText(value);
  return /^https?:\/\/(www\.)?youtube\.com\/(?:@|channel\/|c\/|user\/)/iu.test(text);
}

function vtuberHandleFromChannelUrl(value) {
  const text = cleanText(value);
  const match = text.match(/youtube\.com\/(@[^/?#]+)/iu);
  return match ? cleanVtuberChannelHandle(match[1]) : "";
}

function cleanVtuberChannelHandle(value) {
  const text = cleanText(value);
  if (!text) return "";
  if (/^\/?@[A-Za-z0-9._%~-]+$/u.test(text)) return text.startsWith("/") ? text : `/${text}`;
  const match = text.match(/^https?:\/\/(?:www\.)?youtube\.com\/(@[A-Za-z0-9._%~-]+)(?:[/?#]|$)/iu);
  return match ? `/${match[1]}` : "";
}

function vtuberChannelIdentity(record = {}) {
  const displayName = vtuberReliableDisplayName(record);
  return {
    displayName,
    handle: displayName ? vtuberReliableHandle(record) : "",
  };
}

function vtuberReliableDisplayName(record = {}) {
  const metadata = vtuberChannelMetadataRecords(record);
  const occurrenceItems = vtuberOccurrenceItems(record);
  const candidateTiers = [
    metadata.flatMap((item) => [item.displayName, item.channelDisplayName, item.channelName, item.name, item.title]),
    [record.displayName, record.channelDisplayName, record.channelName, record.name],
    occurrenceItems.flatMap((item) => [item.channelDisplayName, item.channelName, item.authorName, item.ownerName]),
  ];
  for (const candidates of candidateTiers) {
    let selected = "";
    for (const candidate of candidates) {
      if (!isReliableVtuberDisplayName(candidate, record)) continue;
      selected = preferredVtuberChannelName(selected, candidate);
    }
    if (selected) return selected;
  }
  return "";
}

function vtuberChannelMetadataRecords(record = {}) {
  return [
    record.channelMetadata,
    record.channelMeta,
    record.youtubeChannel,
    record.metadata?.channel,
    record._record?.channelMetadata,
    record._record?.channelMeta,
  ].filter((value) => value && typeof value === "object" && !Array.isArray(value));
}

function vtuberOccurrenceItems(record = {}) {
  const values = [
    record._record,
    ...(Array.isArray(record.occurrences) ? record.occurrences.map((occurrence) => occurrence?.item) : []),
    ...(Array.isArray(record.videos) ? record.videos : []),
  ];
  return values.filter((value) => value && typeof value === "object" && !Array.isArray(value));
}

function isReliableVtuberDisplayName(value, record = {}) {
  const text = cleanText(value);
  if (!text || text === "未知频道" || /^unknown channel$/iu.test(text)) return false;
  if (text === cleanText(record.channelId)) return false;
  if (/^https?:\/\//iu.test(text) || /^\/?@/u.test(text)) return false;
  if (/^\/?(?:channel\/)?UC[A-Za-z0-9_-]{20,}$/iu.test(text)) return false;
  if (isCompositeChannelName(text)) return false;
  return true;
}

function vtuberReliableHandle(record = {}) {
  const metadata = vtuberChannelMetadataRecords(record);
  const occurrenceItems = vtuberOccurrenceItems(record);
  const candidates = [
    ...metadata.flatMap((item) => [item.handle, item.channelHandle, item.channelUrl, item.sourceUrl, item.url]),
    record.channelHandle,
    record.channelUrl,
    record.authorUrl,
    record.ownerUrl,
    record.sourceUrl,
    ...(Array.isArray(record.sourceUrls) ? record.sourceUrls : []),
    ...occurrenceItems.flatMap((item) => [
      item.channelHandle,
      item.channelUrl,
      item.authorUrl,
      item.ownerUrl,
      item.sourceUrl,
      ...(Array.isArray(item.sourceUrls) ? item.sourceUrls : []),
    ]),
    ...(Array.isArray(record.aliases) ? record.aliases : []),
  ];
  for (const candidate of candidates) {
    const handle = cleanVtuberChannelHandle(candidate) || vtuberHandleFromChannelUrl(candidate);
    if (isReliableVtuberHandle(handle)) return handle;
  }
  return vtuberEvidenceHandle(record);
}

function isReliableVtuberHandle(value) {
  const handle = cleanVtuberChannelHandle(value).replace(/^\/+/u, "");
  if (!/^@[A-Za-z0-9._~-]{3,64}$/u.test(handle)) return false;
  return !/^@UC[A-Za-z0-9_-]{20,}$/iu.test(handle);
}

function vtuberEvidenceHandle(record = {}) {
  const candidates = [record, ...vtuberOccurrenceItems(record)];
  for (const item of candidates) {
    const videoId = cleanText(item?.videoId);
    const handle = VTUBER_CHANNEL_EVIDENCE_BY_VIDEO_ID.get(videoId) || "";
    if (isReliableVtuberHandle(handle)) return cleanVtuberChannelHandle(handle);
  }
  return "";
}

function vtuberChannelLinkModel(record = {}, identity = vtuberChannelIdentity(record)) {
  if (!identity.displayName) return null;
  return window.FrontendUtils.youtubeChannelLink({
    ...record,
    channelName: identity.displayName,
    channelHandle: identity.handle,
  });
}

function preferredVtuberChannelName(current, candidate) {
  const currentText = cleanText(current);
  const candidateText = cleanText(candidate);
  if (!currentText || currentText === "未知频道") return candidateText || currentText;
  if (!candidateText) return currentText;
  return vtuberChannelDisplayNameScore(candidateText) > vtuberChannelDisplayNameScore(currentText) ? candidateText : currentText;
}

function vtuberChannelDisplayNameScore(value) {
  const text = cleanText(value);
  if (!text) return -1;
  let score = Math.min(text.length, 80);
  if (/[ぁ-ゖァ-ヺ一-龯々〆〤]/u.test(text)) score += 1000;
  if (/^\/?@[A-Za-z0-9._%~-]+$/u.test(text) || /^\/channel\/UC[A-Za-z0-9_-]+$/u.test(text) || /^UC[A-Za-z0-9_-]{20,}$/u.test(text)) score -= 1000;
  return score;
}

function knownVtuberSearchAliases(channelName) {
  const key = normalizeSearch(channelName);
  if (key === normalizeSearch("Haru Ch. 花前ハル")) return ["HanamaeHaru", "Hanamae Haru", "花前ハル"];
  return [];
}

function artistOccurrenceSearchText(occurrence) {
  const song = occurrence?.song || {};
  return normalizeSearch(song.artist || "");
}

function songOccurrenceSearchText(occurrence, searchFields = DEFAULT_SEARCH_FIELDS) {
  const song = occurrence?.song || {};
  const item = occurrence?.item || {};
  const fields = Array.isArray(searchFields) ? searchFields : DEFAULT_SEARCH_FIELDS;
  if (!fields.length) {
    return normalizeSearch([
      item.videoId,
      item.title,
      item.channelName,
      item.channelHandle,
      item.channelId,
      item.keyword,
      song.title,
      song.artist,
    ].join(" "));
  }
  const parts = [];
  if (fields.includes("title")) parts.push(song.title);
  if (fields.includes("artist")) parts.push(song.artist);
  if (fields.includes("channel")) parts.push(item.channelName, item.channelHandle, item.channelId, item.channelUrl, item.authorUrl, item.ownerUrl);
  if (fields.includes("video")) parts.push(item.videoId, item.title);
  return normalizeSearch(parts.join(" "));
}

function vtuberOccurrenceSearchText(occurrence) {
  const item = occurrence?.item || {};
  return normalizeSearch([
    item.channelName,
    item.channelId,
    item.channelHandle,
    item.channelUrl,
    item.authorUrl,
    item.ownerUrl,
    item.sourceUrl,
    ...(Array.isArray(item.sourceUrls) ? item.sourceUrls : []),
    ...knownVtuberSearchAliases(item.channelName),
  ].join(" "));
}

function vtuberRecordSearchText(record) {
  return normalizeSearch([record.name, record.channelName, record.channelId, record.channelHandle, record.channelUrl, record.sourceUrl, ...(record.aliases || [])].join(" "));
}

function collectSongOccurrences(items) {
  const occurrences = [];
  for (const item of items) {
    for (const song of item.songs || []) {
      if (!cleanText(song.title)) continue;
      occurrences.push({
        item,
        song,
        searchText: normalizeSearch([item.videoId, item.title, item.channelName, item.keyword, song.title, song.artist].join(" ")),
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

function buildArtistSongGroups(occurrences, extraOptions = {}) {
  return window.RankingUtils.buildArtistSongGroups(occurrences, {
    cleanText,
    compareValues,
    incrementCount,
    isNicheSong: window.FrontendUtils.isNicheSong,
    makeSongSortKey,
    normalizeEntityKey,
    ...extraOptions,
  });
}

function addRecordRuntimeFields(records) {
  for (const record of records || []) {
    if (typeof record.videoCount !== "number") record.videoCount = uniqueVideoCount(record.occurrences || []);
    if (!record.searchText) {
      if (record.type === "vtuber" || record.channelName || record.channelId || record.channelHandle) {
        record.searchText = vtuberRecordSearchText(record);
      } else if (record.name) {
        record.searchText = normalizeSearch([record.name, ...(record.aliases || [])].join(" "));
      } else {
        record.searchText = normalizeSearch([
          record.title,
          record.displayArtist,
          ...Array.from(record.artists?.values?.() || []).map((entry) => entry.name),
          ...Array.from(record.channels?.values?.() || []).map((entry) => entry.name),
          ...(record.variantLabels || []),
        ].join(" "));
      }
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
  if (state.rankMetric === "songs") return songCountForRecord(record);
  return state.rankMetric === "videos" ? record.videoCount || 0 : record.count;
}

function rankCountUnit() {
  if (state.rankMetric === "songs") return "曲目";
  return state.rankMetric === "videos" ? "视频" : "次";
}

function songCountForRecord(record) {
  const explicit = Number(record?.songCount ?? record?.uniqueSongCount ?? record?.songsCount);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  if (record?.type === "vtuber" && record?.songs instanceof Map) return record.songs.size;
  if (record?.songs instanceof Map) return record.songs.size;
  if (Array.isArray(record?.songs)) return record.songs.length;
  const size = Number(record?.songs?.size);
  return Number.isFinite(size) && size >= 0 ? size : 0;
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

function incrementCanonicalSongCount(map, title) {
  const name = cleanText(title);
  if (!name || !shouldShowSongGroupTitle(name)) return;
  const key = window.RankingUtils?.songWorkTitleKey?.(name) || normalizeEntityKey(name);
  if (!key) return;
  if (!map.has(key)) map.set(key, { key, name, count: 0 });
  map.get(key).count += 1;
}

function validSongArtistCandidate(value) {
  const candidate = cleanText(value);
  return candidate && !window.RankingUtils.isUnknownArtistName(candidate) ? candidate : "";
}

function fallbackSongArtist(record) {
  const displayArtist = validSongArtistCandidate(record?.displayArtist);
  if (displayArtist) return displayArtist;
  const occurrences = Array.isArray(record?.occurrences) ? record.occurrences : [];
  for (const occurrence of occurrences) {
    const artist = validSongArtistCandidate(occurrence?.song?.artist);
    if (artist) return artist;
  }
  return "";
}

function songMeta(record) {
  const artists = sortedCountEntries(record.artists);
  const knownArtists = artists.filter((entry) => !window.RankingUtils.isUnknownArtistName(entry.name));
  const dominantArtist = knownArtists[0]?.name || "";
  const fallbackArtist = dominantArtist ? "" : fallbackSongArtist(record);
  return {
    primary: dominantArtist || fallbackArtist || "待补歌手",
    missingPrimary: !dominantArtist && !fallbackArtist,
    badges: isNicheRecord(record) ? ["小众"] : [],
  };
}

function artistMeta(record) {
  const songs = sortedDisplaySongEntries(record.songs);
  return {
    primary: songs.length ? songs.slice(0, 3).map(formatCountEntry).join("、") : `${record.songs.size} 首歌曲`,
    missingPrimary: false,
  };
}

function vtuberMeta(record) {
  const songs = sortedDisplaySongEntries(record.songs);
  return {
    primary: songs.length ? songs.slice(0, 3).map(formatCountEntry).join("、") : `${record.songs.size} 首歌曲`,
    missingPrimary: false,
  };
}

function sortedCountEntries(map) {
  return Array.from(map?.values?.() || []).sort(compareCountRecords);
}

function sortedDisplaySongEntries(map) {
  return sortedCountEntries(map).filter((entry) => shouldShowSongGroupTitle(entry.name));
}

function shouldShowSongGroupTitle(title) {
  const text = cleanText(title);
  if (!text) return false;
  if (/エンドカード|end\s*card|endcard|オープニング|エンディング/u.test(text)) return false;
  const compactText = text.replace(/[\s._:：・･\/\\\-ー—–~〜～!！?？()[\]【】「」『』"'“”‘’]+/gu, "");
  if (/^(op|ed|end|start|opening|ending|intro|outro|setlist|endcard|オープニング|エンド|エンディング|アウトロ|エンドカード|開始|終了|おわり|終わり|セットリスト|セトリ|タイムスタンプ|曲名)$/iu.test(compactText)) return false;
  if (/^(op|ed|end|start|opening|ending|intro|outro|オープニング|エンド|エンディング|アウトロ)[0-9０-９]*$/iu.test(compactText)) return false;
  if (/エンドカード|endcard/iu.test(compactText)) return false;
  const normalized = normalizeSearch(text).replace(/[\s._:：・･\/\\\-ー—–~〜～!！?？()[\]【】「」『』"'“”‘’]+/gu, "");
  if (!normalized) return false;
  if (/^(op|ed|end|start|opening|ending|intro|outro|setlist|endcard|おーぷにんぐ|えんど|えんでぃんぐ|あうとろ|えんどかーど|開始|終了|おわり|終わり|せっとりすと|せとり|たいむすたんぷ|曲名)$/iu.test(normalized)) return false;
  if (/^(op|ed|end|start|opening|ending|intro|outro|おーぷにんぐ|えんど|えんでぃんぐ|あうとろ)[0-9０-９]*$/iu.test(normalized)) return false;
  if (/えんどかーど|えんどかど|endcard/iu.test(normalized)) return false;
  return true;
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
  priorityInlineMedia = false,
}) {
  const row = document.createElement("article");
  const rowKey = makeDomId(key);
  const drawerId = `source-drawer-${rowKey}`;
  const artistSongCount = songCount;
  const sourceVideoCount = Math.max(0, Number(videoCount) || 0);
  const safeOccurrences = occurrences || [];
  const occurrenceCount = safeOccurrences.length;
  const totalOccurrenceCount =
    mode === "vtuber"
      ? Math.max(0, Number(record?.count ?? record?.timestampCount ?? occurrenceCount) || occurrenceCount)
      : occurrenceCount;
  const isExpanded = state.expandedRows.has(rowKey);
  const sourceDetailPath = sourceDetailPathForRecord(record, safeOccurrences);
  const sourcePresentation =
    mode === "artist" || mode === "vtuber"
      ? null
      : window.FrontendUtils.sourcePresentationModel(safeOccurrences, {
          expanded: isExpanded,
          inlineLimit: sourceInlineLimitForMode(),
          totalVideoCount: sourceVideoCount,
          hasExternalDetails: Boolean(sourceDetailPath),
          occurrencePreviewLimited: Boolean(record?.occurrencePreviewLimited),
          detailCountKnown: !record?.occurrencePreviewLimited,
        });
  const expandable =
    mode === "artist" || mode === "vtuber"
      ? artistSongCount > 1 || sourceVideoCount > 1 || occurrenceCount > 1
      : Boolean(sourcePresentation?.canExpand);

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
  row.dataset.trendMode = mode === "artist" ? "artistRank" : mode === "vtuber" ? "vtuberRank" : "songRank";
  row.dataset.trendKey = record?.key || key;
  row._sourceOccurrences = safeOccurrences;
  row._sourceDetailOccurrences = safeOccurrences;
  row._sourceDetailPath = sourceDetailPath;
  row._sourceDetailKey = record?.sourceDetailKey || "";
  row._sourceVideoCount = sourceVideoCount;
  row._artistSongGroups = songGroups.length ? songGroups : null;
  row._getArtistSongGroups = getSongGroups;
  row._artistSongCount = artistSongCount;
  if (isTied) row.title = `同${rankCountUnit()}共享名次`;

  const rankNumber = document.createElement("div");
  rankNumber.className = "rank-number";
  rankNumber.textContent = formatRank(rank);
  rankNumber.setAttribute("aria-label", `第 ${rank} 名`);
  row.append(rankNumber);

  row.append(
    renderRecordContent(title, meta, {
      mode,
      record,
      occurrences: safeOccurrences,
      songGroups,
      songCount,
      songPreview,
      videoCount,
      occurrenceCount: totalOccurrenceCount,
      rankMetric: state.rankMetric,
      sourceDetailPath,
      priorityMedia: priorityInlineMedia,
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
      occurrenceCount: totalOccurrenceCount,
      count,
      countUnit,
      rankCount: count,
      rankMetric: state.rankMetric,
      trend,
    }),
  );
  if (mode !== "artist" && mode !== "vtuber") {
    row.append(
      renderSourceInlineStrip(sourcePresentation, {
        drawerId,
        isExpanded,
        occurrences: safeOccurrences,
        mode,
        rankCount: count,
        rankMetric: state.rankMetric,
        priorityMedia: priorityInlineMedia,
      }),
    );
  }
  if (expandable) {
    row.append(
      renderSourceDrawer({
        mode,
        occurrences: row._sourceDetailOccurrences,
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

function renderIndexRecord(record, options = {}) {
  const row = document.createElement("article");
  const rowKey = makeDomId(`index-${record.key}`);
  const drawerId = `source-drawer-${rowKey}`;
  const sourceVideoCount = Math.max(0, Number(record.videoCount) || 0);
  const isExpanded = state.expandedRows.has(rowKey);
  const sourceDetailPath = sourceDetailPathForRecord(record, record.occurrences);
  const sourcePresentation = window.FrontendUtils.sourcePresentationModel(record.occurrences, {
    expanded: isExpanded,
    inlineLimit: sourceInlineLimitForMode(),
    totalVideoCount: sourceVideoCount,
    hasExternalDetails: Boolean(sourceDetailPath),
    occurrencePreviewLimited: Boolean(record?.occurrencePreviewLimited),
    detailCountKnown: !record?.occurrencePreviewLimited,
  });
  const expandable = sourcePresentation.canExpand;

  row.className = ["index-row", expandable ? "is-expandable" : "", isExpanded ? "is-expanded" : "", isNicheRecord(record) ? "is-niche" : ""]
    .filter(Boolean)
    .join(" ");
  row.dataset.rowKey = rowKey;
  row.dataset.drawerMode = "index";
  row._sourceOccurrences = record.occurrences;
  row._sourceDetailOccurrences = record.occurrences;
  row._sourceDetailPath = sourceDetailPath;
  row._sourceDetailKey = record?.sourceDetailKey || "";
  row._sourceVideoCount = sourceVideoCount;

  row.append(
    renderRecordContent(record.title, songMeta(record), {
      mode: "index",
      occurrences: record.occurrences,
      videoCount: record.videoCount,
      sourceDetailPath,
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
  row.append(
    renderSourceInlineStrip(sourcePresentation, {
      drawerId,
      isExpanded,
      occurrences: record.occurrences,
      mode: "index",
      rankCount: record.count,
      rankMetric: "occurrences",
      priorityMedia: Boolean(options.priorityInlineMedia),
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

  const contentLabel = mode === "artist" ? "歌手与曲目" : mode === "vtuber" ? "VTuber频道与曲目" : "歌曲、歌手与来源";
  const countLabel =
    mode === "vtuber"
      ? state.rankMetric === "songs"
        ? "歌曲数"
        : state.rankMetric === "videos"
          ? "视频数"
          : "次数"
      : state.rankMetric === "videos"
        ? "歌曲收录 / 趋势"
        : "次数 / 趋势";
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
    record = null,
    occurrences,
    songGroups = [],
    songCount = songGroups.length,
    songPreview = songGroups.slice(0, 2).map((group) => group.title),
    videoCount,
    occurrenceCount = occurrences?.length || 0,
    rankMetric = state.rankMetric,
    sourceDetailPath = "",
    headingLevel = 2,
    priorityMedia = false,
  } = options;
  const content = document.createElement("div");
  content.className = "rank-content";
  const channelIdentity = mode === "vtuber" ? vtuberChannelIdentity(record || {}) : null;
  const displayTitle = mode === "vtuber" ? channelIdentity.displayName || "未知频道" : title;

  if (mode === "vtuber") {
    const media = renderVtuberDisplayImage(record || {}, { priority: priorityMedia });
    if (media) content.append(wrapVtuberChannelLink(media, record || {}, "vtuber-display-link", channelIdentity));
  }

  const heading = document.createElement(`h${headingLevel}`);
  heading.className = mode === "vtuber" ? "rank-title vtuber-title" : "rank-title";
  if (mode === "vtuber") {
    const titleLink = renderVtuberChannelTextLink(record || {}, displayTitle, channelIdentity);
    heading.append(titleLink || document.createTextNode(displayTitle));
  } else {
    heading.append(document.createTextNode(displayTitle));
  }
  for (const badgeText of meta.badges || []) {
    const badge = document.createElement("span");
    badge.className = "song-badge niche-badge";
    badge.textContent = badgeText;
    heading.append(" ", badge);
  }
  if (mode === "vtuber") {
    const titleLine = document.createElement("div");
    titleLine.className = "vtuber-title-line";
    titleLine.append(heading);
    content.append(titleLine);
  } else {
    content.append(heading);
  }

  const subline = document.createElement("div");
  subline.className = "rank-subline";
  const metaLine = document.createElement("div");
  metaLine.className = "rank-meta-line";
  if (mode === "artist") {
    appendArtistSubline(metaLine, { occurrences, songCount, songPreview, videoCount });
  } else if (mode === "vtuber") {
    const collectedBadge = renderVtuberCollectionBadge(record);
    if (collectedBadge) metaLine.append(collectedBadge);
    const handle = renderVtuberHandle(record, channelIdentity);
    if (handle) appendSublineNode(metaLine, handle);
  } else {
    appendSublinePart(metaLine, meta.primary, meta.missingPrimary ? "artist-missing" : "subline-primary");
    appendSublinePart(metaLine, sourceVideoCountSubline(record, videoCount, sourceDetailPath), "subline-video-count");
  }
  if (metaLine.childNodes.length) {
    subline.append(metaLine);
    content.append(subline);
  }
  if (mode === "vtuber") {
    content.append(renderVtuberStats({ songCount, videoCount, occurrenceCount, rankMetric }));
  }

  return content;
}

function renderVtuberStats({ songCount = 0, videoCount = 0, occurrenceCount = 0, rankMetric = "occurrences" } = {}) {
  const container = document.createElement("div");
  container.className = "vtuber-card-stats";
  const items = [
    { metric: "videos", label: "视频", value: videoCount, ariaLabel: "视频数量" },
    { metric: "songs", label: "歌曲", value: songCount, ariaLabel: "歌曲数量" },
    { metric: "occurrences", label: "次数", value: occurrenceCount, ariaLabel: "次数" },
  ];
  for (const item of items) {
    const stat = document.createElement("span");
    stat.className = `vtuber-card-stat${rankMetric === item.metric ? " is-active" : ""}`;
    stat.dataset.metric = item.metric;
    const value = Math.max(0, Number(item.value) || 0);
    stat.setAttribute("aria-label", `${item.ariaLabel}：${value}`);

    const label = document.createElement("span");
    label.className = "vtuber-card-stat-label";
    label.textContent = item.label;
    const number = document.createElement("span");
    number.className = "vtuber-card-stat-value";
    number.textContent = String(value);
    stat.append(label, number);
    container.append(stat);
  }
  return container;
}

function renderVtuberHandle(record = {}, identity = vtuberChannelIdentity(record)) {
  const handle = identity.handle.replace(/^\/+/u, "");
  if (!identity.displayName || !handle) return null;
  const link = vtuberChannelLinkModel(record, identity);
  if (!link?.href || link.isFallbackSearch) return null;
  const anchor = document.createElement("a");
  anchor.className = "vtuber-handle";
  anchor.href = link.href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = handle;
  anchor.setAttribute("aria-label", link.isFallbackSearch ? `搜索频道：${handle}` : `打开频道：${handle}`);
  return anchor;
}

function renderVtuberChannelTextLink(record, title, identity = vtuberChannelIdentity(record || {})) {
  if (!identity.displayName) return null;
  const link = vtuberChannelLinkModel(record, identity);
  if (!link?.href || link.isFallbackSearch) return null;
  const anchor = document.createElement("a");
  anchor.className = "vtuber-title-link";
  anchor.href = link.href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = title;
  return anchor;
}

function wrapVtuberChannelLink(node, record, className, identity = vtuberChannelIdentity(record || {})) {
  if (!identity.displayName) return node;
  const link = vtuberChannelLinkModel(record, identity);
  if (!node || !link?.href || link.isFallbackSearch) return node;
  const anchor = document.createElement("a");
  anchor.className = className;
  anchor.href = link.href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.append(node);
  return anchor;
}

function sourceVideoCountSubline(record, videoCount, sourceDetailPath = "") {
  const count = Math.max(0, Number(videoCount) || 0);
  const globalVideoCount = Math.max(0, Number(record?.globalVideoCount) || 0);
  if (globalVideoCount > count) return `${count}/${globalVideoCount} 个视频`;
  if (record?.occurrencePreviewLimited && sourceDetailPath) return `${count} 个预览视频`;
  return `${count} 个视频`;
}

function renderVtuberDisplayImage(record, options = {}) {
  const media = window.FrontendUtils.vtuberDisplayImageModel(record || {});
  if (!media.src) {
    const marker = document.createElement("span");
    marker.className = "vtuber-display-image vtuber-display-image-missing";
    marker.dataset.displayImageKind = media.kind;
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }

  const img = document.createElement("img");
  img.className =
    media.kind === "realAvatar"
      ? "vtuber-display-image vtuber-display-image-avatar"
      : "vtuber-display-image vtuber-display-image-thumbnail";
  img.dataset.displayImageKind = media.kind;
  img.alt = "";
  const priority = Boolean(options.priority);
  img.loading = priority ? "eager" : "lazy";
  img.fetchPriority = priority ? "high" : "low";
  img.decoding = "async";
  img.width = 44;
  img.height = 44;
  img.src = media.src;
  img.addEventListener("error", () => {
    if (media.kind === "realAvatar") {
      const fallback = window.FrontendUtils.vtuberDisplayImageModel(record || {}, { excludeAvatarUrls: [media.src] });
      if (fallback.src) {
        img.src = fallback.src;
        img.className = "vtuber-display-image vtuber-display-image-thumbnail";
        img.dataset.displayImageKind = fallback.kind;
        return;
      }
    }
    img.replaceWith(renderVtuberDisplayImage({}));
  });
  return img;
}

function appendArtistSubline(metaContainer, { occurrences, songCount, songPreview, videoCount }) {
  appendSublinePart(metaContainer, (songPreview || []).slice(0, 2).join("、"), "subline-primary artist-song-preview");
  appendSublinePart(metaContainer, `${songCount} 首歌曲`, "subline-song-count");
  appendSublinePart(metaContainer, `${videoCount} 个视频`, "subline-video-count");
  if (songCount === 1 && occurrences.length === 1) {
    appendSublineNode(metaContainer, renderInlineSource(occurrences[0]));
  }
}

function mergeVtuberRecordMetadata(record, item, song = {}) {
  for (const [target, sources] of [
    ["avatarUrl", [item.avatarUrl, item.channelAvatarUrl, item.authorAvatarUrl, item.profileImageUrl]],
    ["channelAvatarUrl", [item.channelAvatarUrl, item.avatarUrl]],
    ["knownSourceType", [item.knownSourceType, item.sourceType, item.collectionType, song.knownSourceType, song.sourceType]],
  ]) {
    const value = sources.map(cleanText).find(Boolean);
    if (target === "knownSourceType") {
      if (shouldReplaceVtuberKnownSourceType(record[target], value)) record[target] = value;
    } else if (!record[target] && value) {
      record[target] = value;
    }
  }
  const badge = window.FrontendUtils.vtuberCollectionBadgeModel({
    occurrences: [{ item, song }],
  });
  if (badge.isCollected) {
    if (!record.isCollected || shouldReplaceVtuberKnownSourceType(record.knownSourceType, badge.sourceType)) {
      record.knownSourceType = badge.sourceType;
    }
    record.isCollected = true;
  }
}

function shouldReplaceVtuberKnownSourceType(current, next) {
  const nextType = cleanText(next);
  if (!nextType) return false;
  const currentType = cleanText(current);
  if (!currentType) return true;
  return isMomentKnownSourceType(currentType) && !isMomentKnownSourceType(nextType);
}

function isMomentKnownSourceType(value) {
  const type = cleanText(value).toLocaleLowerCase();
  return type === "vsinger_moment_http" || type === "vsinger-moment" || type === "moment";
}

function renderVtuberAvatar(record) {
  return renderVtuberDisplayImage(record);
}

function renderVtuberCollectionBadge(record) {
  const model = window.FrontendUtils.vtuberCollectionBadgeModel(record || {});
  if (!model.isCollected) return null;
  const badge = document.createElement("span");
  badge.className = "vtuber-collected-badge";
  badge.textContent = model.text;
  if (model.sourceType) badge.title = `收录来源：${model.sourceType}`;
  return badge;
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
  button.dataset.sourceRankMetric = rankMetric;
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
  occurrenceCount = occurrences.length,
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

  if (mode === "artist" || mode === "vtuber") {
    if (expandable) {
      side.append(renderSourceToggleButton({ mode, drawerId, isExpanded, songCount, occurrenceCount, videoCount, rankCount, rankMetric }));
    } else if (mode !== "vtuber") {
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
    const hasUnresolvedCount = Number(options.rankCount || options.occurrenceCount || 0) > 0;
    if (hasUnresolvedCount) empty.classList.add("source-inline-missing");
    empty.textContent = "无来源";
    strip.append(empty);
    return strip;
  }

  const rail = document.createElement("div");
  rail.className = "source-inline-preview-rail";
  rail.setAttribute("aria-label", "来源预览");
  const list = document.createElement("div");
  list.className = "source-inline-preview-list";

  const showInlineCopyAll = Boolean(model.showCopyAll && options.showCopyAll !== false && !options.isExpanded);
  const hasActions = Boolean(model.canExpand || showInlineCopyAll);
  for (const group of model.inlineGroups) {
    list.append(renderSourceInlineGroup(group, { priorityMedia: Boolean(options.priorityMedia) }));
  }
  rail.append(list);
  strip.append(rail);

  const actions = document.createElement("div");
  actions.className = "source-inline-actions";
  if (hasActions) {
    strip.classList.add("has-tail-action");
  }

  if (model.canExpand) {
    actions.append(
      renderSourceInlineMoreButton({
        drawerId: options.drawerId,
        isExpanded: options.isExpanded,
        remainingCount: model.remainingCount,
        videoCount: model.videoCount,
        occurrenceCount: model.occurrenceCount,
        detailCountKnown: model.detailCountKnown,
        rankCount: options.rankCount,
        rankMetric: options.rankMetric,
        mode: options.mode || "song",
      }),
    );
  }

  if (showInlineCopyAll) {
    actions.append(renderInlineCopySongLinksButton(options.occurrences || []));
  }
  if (actions.childElementCount) {
    strip.append(actions);
  }

  return strip;
}

function renderSourceInlineGroup(group, options = {}) {
  const item = group.item || group.occurrences?.[0]?.item || {};
  const setlistItem = window.FrontendUtils.sourceGroupSetlistItem(hydrateSetlistVideoItem(item, group), group);
  const displayOccurrences = uniqueSourceTimeOccurrences(group.occurrences || []);
  const firstOccurrence = displayOccurrences[0] || group.occurrences?.[0];
  const videoId = item.videoId || group.videoId || "";
  const firstSeconds = firstOccurrence?.song?.seconds ?? group.firstSeconds ?? 0;
  const wrapper = document.createElement("span");
  wrapper.className = "source-inline-item";
  wrapper.dataset.videoId = videoId;

  const thumb = document.createElement("a");
  thumb.className = "source-inline-thumb source-link";
  thumb.href = youtubeTimeUrl(videoId, firstSeconds);
  thumb.target = "_blank";
  thumb.rel = "noopener noreferrer";
  thumb.tabIndex = -1;
  thumb.setAttribute("aria-label", `打开来源视频时间戳：${group.title || videoId || "来源视频"}`);
  thumb.append(
    createThumbnailImage({ ...item, videoId, thumbnailUrl: item.thumbnailUrl || group.thumbnailUrl }, "source-inline-thumb-image", {
      preferCompact: true,
      width: 56,
      height: 32,
      priority: options.priorityMedia ? "high" : "auto",
    }),
  );
  wrapper.append(thumb);

  const visibleTimes = displayOccurrences.slice(0, SOURCE_TIMESTAMP_INITIAL_LIMIT);
  const extraTimes = displayOccurrences.slice(SOURCE_TIMESTAMP_INITIAL_LIMIT);
  let extraTimesNode = null;
  let extraTimeButton = null;
  const main = document.createElement("span");
  main.className = "source-inline-main";
  if (extraTimes.length) {
    const extraTimesId = `source-inline-extra-${makeDomId(`${videoId}-${firstSeconds}-${group.channelName || ""}`)}`;
    const more = document.createElement("button");
    more.className = "source-inline-time-more";
    more.type = "button";
    more.dataset.toggleSourceTimes = "true";
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-controls", extraTimesId);
    more.setAttribute("aria-label", `显示另外${extraTimes.length}个时间点`);
    more.title = `另外${extraTimes.length}个时间点`;
    more.append(document.createTextNode(`+${extraTimes.length}`));
    const unit = document.createElement("span");
    unit.className = "source-inline-time-more-unit";
    unit.textContent = "时间点";
    more.append(unit);

    const extra = document.createElement("span");
    extra.className = "source-extra-times source-inline-extra-times";
    extra.id = extraTimesId;
    extra.hidden = true;
    for (const occurrence of extraTimes) extra.append(renderSourceTimestampLink(occurrence, "source-inline-extra-time"));
    extraTimesNode = extra;
    extraTimeButton = more;
  }

  const channelLink = window.FrontendUtils.youtubeChannelLink({ ...item, channelName: group.channelName });
  const channel = document.createElement("a");
  channel.className = "source-inline-channel";
  channel.href = channelLink.href;
  channel.target = "_blank";
  channel.rel = "noopener noreferrer";
  channel.textContent = group.channelName || "未知频道";
  channel.setAttribute("aria-label", channelLink.isFallbackSearch ? `搜索频道：${channel.textContent}` : `打开频道：${channel.textContent}`);
  channel.title = channelLink.isFallbackSearch ? `搜索频道：${channel.textContent}` : `打开频道：${channel.textContent}`;
  main.append(channel);

  const meta = document.createElement("span");
  meta.className = "source-inline-meta";
  if (visibleTimes.length) {
    for (const occurrence of visibleTimes) meta.append(renderSourceTimestampLink(occurrence, "source-inline-time"));
  } else {
    const time = document.createElement("a");
    time.className = "source-link source-inline-time";
    time.href = youtubeTimeUrl(videoId, firstSeconds);
    time.target = "_blank";
    time.rel = "noopener noreferrer";
    time.textContent = formatSeconds(firstSeconds);
    time.title = [group.title || item.title || videoId || "来源视频", time.textContent].filter(Boolean).join(" · ");
    time.setAttribute("aria-label", `打开时间戳：${time.title}`);
    meta.append(time);
  }
  if (extraTimeButton) meta.append(extraTimeButton);
  main.append(meta);
  wrapper.append(main);

  wrapper.append(renderCopySetlistButton(setlistItem, "复制歌单", "source-inline-copy source-copy-icon ui-chip ui-chip-icon"));
  if (extraTimesNode) wrapper.append(extraTimesNode);
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
  detailCountKnown = true,
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
  button.dataset.detailCountKnown = detailCountKnown === false ? "false" : "true";
  button.dataset.rankCount = String(rankCount);
  button.dataset.sourceRankMetric = rankMetric;
  button.setAttribute("aria-expanded", isExpanded ? "true" : "false");
  button.setAttribute("aria-controls", drawerId);
  updateSourceInlineMoreButton(button, isExpanded);
  return button;
}

function updateSourceInlineMoreButton(button, isExpanded) {
  const videoCount = Math.max(0, Number(button.dataset.videoCount) || 0);
  const songCount = Math.max(0, Number(button.dataset.songCount) || 0);
  const detailCountKnown = button.dataset.detailCountKnown !== "false";
  const mode = button.dataset.sourceMode || "song";
  const isSongGroupMode = mode === "artist" || mode === "vtuber";
  const label = isExpanded ? "收起" : isSongGroupMode ? `${songCount}首歌` : "查看全部来源";
  const fullLabel = isExpanded
    ? isSongGroupMode
      ? `收起，当前共 ${songCount} 首歌`
      : "收起来源"
    : isSongGroupMode
      ? `展开全部 ${songCount} 首歌`
      : detailCountKnown
        ? `查看该歌曲的全部 ${videoCount} 个来源`
        : "查看该歌曲的全部来源";
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
  time.rel = "noopener noreferrer";
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
  channel.rel = "noopener noreferrer";
  channel.textContent = model.channel.text;
  channel.title = model.channel.ariaLabel;
  channel.setAttribute("aria-label", model.channel.ariaLabel);

  wrapper.append(time, separator, channel);
  return wrapper;
}

function sourceDetailPathForRecord(record, occurrences = []) {
  const ownerRecord = record?._record || {};
  const explicitPath = cleanText(record?.sourceDetailPath || ownerRecord?.sourceDetailPath);
  if (explicitPath) return explicitPath;
  const detailKey = cleanText(record?.sourceDetailKey || ownerRecord?.sourceDetailKey);
  const vtuberAlias = cleanText(record?.channelId || ownerRecord?.channelId || (record?.type === "vtuber" ? record?.key : "") || (ownerRecord?.type === "vtuber" ? ownerRecord?.key : ""));
  if (detailKey || vtuberAlias) {
    return `/api/sources/${encodeURIComponent(detailKey || vtuberAlias)}`;
  }
  const candidates = [
    record?.sourceDetail?.path,
    record?.sourceDetails?.path,
    record?.detailPath,
    record?.detail?.path,
    ownerRecord?.sourceDetail?.path,
    ownerRecord?.sourceDetails?.path,
    ownerRecord?.detailPath,
    ownerRecord?.detail?.path,
    occurrences?.[0]?.sourceDetailPath,
    occurrences?.[0]?.sourceDetail?.path,
    occurrences?.[0]?.item?.sourceDetailPath,
    occurrences?.[0]?.item?.sourceDetail?.path,
    sourceDetailPathFromShard(record, occurrences),
  ];
  return cleanText(candidates.find(Boolean));
}

function sourceDetailPathFromShard(record, occurrences = []) {
  const shard = runtimeRangeShards(state.range).sourceDetail;
  if (!shard) return "";
  const key = cleanText(record?.key || record?.sourceKey || record?.entityKey || occurrences?.[0]?.sourceKey);
  if (key && shard.byKey?.[key]) return shardInitialPath(shard.byKey[key]);
  if (key && shard.pathPattern) {
    return String(shard.pathPattern)
      .replaceAll("{range}", encodeURIComponent(state.range))
      .replaceAll("{key}", encodeURIComponent(key));
  }
  return "";
}

async function sourceDetailOccurrencesForContainer(container, currentOccurrences = []) {
  const path = cleanText(container?._sourceDetailPath);
  if (container?._sourceDetailLoaded && Array.isArray(container._sourceDetailOccurrences) && container._sourceDetailOccurrences.length) {
    return filterSourceDetailOccurrences(container._sourceDetailOccurrences);
  }
  if (!path || container?._sourceDetailLoaded) return filterSourceDetailOccurrences(currentOccurrences || []);
  const loaded = await loadSourceDetailOccurrences(path, cleanText(container?._sourceDetailKey));
  container._sourceDetailLoaded = true;
  if (!loaded.length) return filterSourceDetailOccurrences(currentOccurrences || []);
  const merged = window.FrontendUtils.mergeCompleteSourceOccurrences(
    loaded,
    container._sourceOccurrences || container._songSourceOccurrences || currentOccurrences,
  );
  container._sourceDetailOccurrences = merged;
  return filterSourceDetailOccurrences(merged);
}

async function sourceDetailPageForContainer(container, currentOccurrences = [], options = {}) {
  const page = Math.max(1, Math.floor(Number(options.page) || Number(container?.dataset?.sourcePage) || 1));
  const pageSize = Math.max(1, Math.floor(Number(options.pageSize) || sourceDrawerPageSizeForMode()));
  const path = cleanText(container?._sourceDetailPath);
  const songKey = cleanText(container?._sourceSongKey);
  const songTitle = cleanText(container?._sourceSongTitle);
  if (path && (songKey || songTitle)) {
    const loaded = await sourceDetailOccurrencesForContainer(container, currentOccurrences);
    return localSourceDetailPage(filterOccurrencesForSongKey(loaded, songKey, songTitle), { page, pageSize });
  }
  if (path) {
    const result = await loadSourceDetailPage(path, cleanText(container?._sourceDetailKey), {
      page,
      pageSize,
      filters: sourceDetailFiltersForCurrentView(),
    });
    if (result.found === false) throw new Error("来源详情不存在");
    if (!isRuntimeSourceDetailPath(path)) {
      return localSourceDetailPage(filterSourceDetailOccurrences(result.completeOccurrences || result.occurrences), { page, pageSize });
    }
    return result;
  }
  return localSourceDetailPage(filterSourceDetailOccurrences(currentOccurrences), { page, pageSize });
}

function filterSourceDetailOccurrences(occurrences = []) {
  const filters = sourceDetailFiltersForCurrentView();
  let result = occurrences || [];
  if (filters.nicheOnly) result = filterNicheOccurrences(result);
  if (filters.hideUnknownArtist) result = filterUnknownArtistOccurrences(result);
  return result;
}

function filterOccurrencesForSongKey(occurrences = [], songKey = "", songTitle = "") {
  const keys = songMatchKeys(songKey, songTitle);
  if (!keys.size) return occurrences || [];
  return (occurrences || []).filter((occurrence) => occurrenceSongMatchesAnyKey(occurrence, keys));
}

function songMatchKeys(...values) {
  const keys = new Set();
  for (const value of values) {
    const text = cleanText(value);
    if (!text) continue;
    keys.add(normalizeEntityKey(text));
    const workKey = window.RankingUtils?.songWorkTitleKey?.(text);
    if (workKey) keys.add(workKey);
  }
  return keys;
}

function occurrenceSongMatchesAnyKey(occurrence, keys) {
  if (!keys?.size) return true;
  return Array.from(songMatchKeys(
    occurrence?.song?.key,
    occurrence?.song?.title,
    occurrence?.song?.workTitle,
    occurrence?.song?.canonicalTitle,
    occurrence?.song?.displayTitle,
  )).some((key) => keys.has(key));
}

async function loadSourceDetailOccurrences(path, key = "") {
  const requestPath = sourceDetailPathWithRange(path);
  const cacheKey = key ? `${requestPath}#${key}` : requestPath;
  if (state.sourceDetailCache.has(cacheKey)) return state.sourceDetailCache.get(cacheKey);
  if (state.sourceDetailLoads.has(cacheKey)) return state.sourceDetailLoads.get(cacheKey);
  const load = readJson(requestPath, { cache: cacheModeForPath(path) })
    .then((payload) => normalizeSourceDetailOccurrences(payload, key))
    .then((occurrences) => {
      state.sourceDetailCache.set(cacheKey, occurrences);
      return occurrences;
    })
    .finally(() => {
      state.sourceDetailLoads.delete(cacheKey);
    });
  state.sourceDetailLoads.set(cacheKey, load);
  return load;
}

async function loadSourceDetailPage(path, key = "", options = {}) {
  const page = Math.max(1, Math.floor(Number(options.page) || 1));
  const pageSize = Math.max(1, Math.floor(Number(options.pageSize) || sourceDrawerPageSizeForMode()));
  const requestPath = sourceDetailPagePath(path, page, pageSize, options.filters);
  const cacheKey = key ? `page:${requestPath}#${key}` : `page:${requestPath}`;
  if (state.sourceDetailCache.has(cacheKey)) return state.sourceDetailCache.get(cacheKey);
  if (state.sourceDetailLoads.has(cacheKey)) return state.sourceDetailLoads.get(cacheKey);
  const load = readJson(requestPath, { cache: cacheModeForPath(path) })
    .then((payload) => {
      const occurrences = normalizeSourceDetailOccurrences(payload, key);
      if (!isRuntimeSourceDetailPath(path)) {
        return localSourceDetailPage(filterSourceDetailOccurrences(occurrences), { page, pageSize });
      }
      return normalizeSourceDetailPagePayload(payload, key, { page, pageSize });
    })
    .then((result) => {
      state.sourceDetailCache.set(cacheKey, result);
      return result;
    })
    .finally(() => {
      state.sourceDetailLoads.delete(cacheKey);
    });
  state.sourceDetailLoads.set(cacheKey, load);
  return load;
}

function sourceDetailPagePath(path, page, pageSize, filters = {}) {
  const requestPath = sourceDetailPathWithRange(path);
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  if (isRuntimeSourceDetailPath(path)) {
    if (filters.nicheOnly) params.set("nicheOnly", "1");
    if (filters.hideUnknownArtist) params.set("hideUnknownArtist", "1");
  }
  const separator = requestPath.includes("?") ? "&" : "?";
  return `${requestPath}${separator}${params.toString()}`;
}

function sourceDetailPathWithRange(path) {
  const requestPath = String(path || "");
  if (!isRuntimeSourceDetailPath(requestPath)) return requestPath;
  const [pathname, query = ""] = requestPath.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("range", cleanText(state.range) || "all");
  const suffix = params.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}

function isRuntimeSourceDetailPath(path) {
  return String(path || "").includes("/api/sources/");
}

function sourceDetailFiltersForCurrentView() {
  return {
    nicheOnly: Boolean(state.nicheOnly),
    hideUnknownArtist: shouldHideUnknownForCurrentView(),
  };
}

function normalizeSourceDetailPagePayload(payload, key = "", options = {}) {
  const occurrences = normalizeSourceDetailOccurrences(payload, key);
  const hasServerPaging =
    Number.isFinite(Number(payload?.page)) ||
    Number.isFinite(Number(payload?.pageSize)) ||
    Number.isFinite(Number(payload?.totalCount)) ||
    Number.isFinite(Number(payload?.totalVideoCount));
  if (!hasServerPaging) return localSourceDetailPage(occurrences, options);
  const groups = window.FrontendUtils.groupOccurrencesByVideo(occurrences);
  const totalVideoCount = Number(payload?.totalVideoCount ?? payload?.record?.videoCount ?? payload?.videoCount);
  const totalCount = Number.isFinite(totalVideoCount) && totalVideoCount >= groups.length ? totalVideoCount : groups.length;
  const pageInfo = window.FrontendUtils.sourceDrawerPageModel({
    page: Number(payload?.page) || options.page || 1,
    pageSize: Number(payload?.pageSize) || options.pageSize || sourceDrawerPageSizeForMode(),
    totalCount,
    visibleCount: groups.length,
  });
  return {
    found: payload?.found !== false,
    occurrences,
    groups,
    pageInfo,
    totalOccurrenceCount: Number(payload?.totalOccurrenceCount ?? payload?.record?.timestampCount ?? payload?.record?.count) || occurrences.length,
  };
}

function localSourceDetailPage(occurrences, options = {}) {
  const allGroups = window.FrontendUtils.groupOccurrencesByVideo(occurrences);
  const pageInfo = window.FrontendUtils.paginateItems(allGroups, {
    page: options.page,
    pageSize: options.pageSize,
  });
  const groups = pageInfo.visible;
  return {
    found: true,
    occurrences: groups.flatMap((group) => group.occurrences || []),
    completeOccurrences: occurrences || [],
    groups,
    pageInfo: window.FrontendUtils.sourceDrawerPageModel({
      page: pageInfo.page,
      pageSize: pageInfo.pageSize,
      totalCount: pageInfo.total,
      visibleCount: groups.length,
    }),
    totalOccurrenceCount: occurrences?.length || 0,
  };
}

function normalizeSourceDetailOccurrences(payload, key = "") {
  if (Array.isArray(payload)) return normalizeSourceOccurrences(payload);
  if (Array.isArray(payload?.record?.occurrences)) return normalizeSourceOccurrences(payload.record.occurrences);
  if (Array.isArray(payload?.occurrences)) return normalizeSourceOccurrences(payload.occurrences);
  if (Array.isArray(payload?.sourceOccurrences)) return normalizeSourceOccurrences(payload.sourceOccurrences);
  if (Array.isArray(payload?.groups)) return normalizeSourceOccurrences(payload.groups.flatMap((group) => group?.occurrences || []));
  if (Array.isArray(payload?.items)) return collectSongOccurrences(payload.items);
  if (Array.isArray(payload?.sources)) return collectSongOccurrences(payload.sources);
  if (Array.isArray(payload?.records)) {
    const matched = key ? payload.records.find((record) => record?.key === key) : null;
    const source = matched || (payload.records.length === 1 ? payload.records[0] : null);
    return normalizeSourceOccurrences(source?.occurrences || []);
  }
  return [];
}

function isOccurrenceLike(value) {
  return Boolean(value?.song && (value?.item || value?.videoId || value?.title || value?.channelName));
}

function normalizeSourceOccurrences(values) {
  return (values || []).filter(isOccurrenceLike).map(normalizeSourceOccurrence);
}

function normalizeSourceOccurrence(value) {
  if (value?.item) return value;
  return {
    item: {
      videoId: cleanText(value?.videoId),
      title: cleanText(value?.title || value?.videoTitle),
      channelName: cleanText(value?.channelName),
      channelId: cleanText(value?.channelId),
      channelHandle: cleanText(value?.channelHandle),
      channelUrl: cleanText(value?.channelUrl),
      thumbnailUrl: cleanText(value?.thumbnailUrl || value?.videoThumbnailUrl || value?.thumbnail),
      publishedTimestamp: Number(value?.publishedTimestamp) || 0,
    },
    song: value?.song || {},
  };
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
  drawer.className = mode === "artist" || mode === "vtuber" ? "source-drawer artist-song-drawer" : "source-drawer";
  drawer.id = drawerId;
  drawer.dataset.sourceMode = mode;
  drawer.dataset.sourceDeferred = "true";
  drawer.dataset.sourcePage = "1";
  drawer.dataset.sourcePageSize = String(sourceDrawerPageSizeForMode());
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

function initializeSourceDrawer(drawer, { mode, occurrences, copyOccurrences = occurrences, songGroups = [], sourceGroups = null, sourcePageInfo = null }) {
  if (!drawer || drawer.dataset.sourceDeferred !== "true") return;
  if (mode === "vtuber") {
    appendPagedVtuberSongGroups(drawer, completeSongGroupsForDrawer(occurrences, songGroups, mode));
  } else if (mode === "artist") {
    appendArtistSongGroups(drawer, completeSongGroupsForDrawer(occurrences, songGroups, mode));
  } else {
    appendSourceDrawerLinks(drawer, occurrences, { showToolbar: true, copyOccurrences, groups: sourceGroups, pageInfo: sourcePageInfo });
  }
  delete drawer.dataset.sourceDeferred;
}

function appendSourceDrawerContent(drawer, { mode, occurrences, songGroups = [] }) {
  initializeSourceDrawer(drawer, { mode, occurrences, songGroups });
}

function appendSourceDrawerLinks(drawer, occurrences, options = {}) {
  drawer._sourceOccurrences = occurrences;
  drawer._songSourceOccurrences = options.copyOccurrences || drawer._songSourceOccurrences || occurrences;
  const groups = Array.isArray(options.groups) ? options.groups : window.FrontendUtils.groupOccurrencesByVideo(occurrences);
  clearSourceDrawerPageContent(drawer);
  drawer._sourceGroups = groups;
  if (options.toolbarVariant) drawer.dataset.toolbarVariant = options.toolbarVariant;
  const pageInfo =
    options.pageInfo ||
    window.FrontendUtils.sourceDrawerPageModel({
      page: Number(drawer.dataset.sourcePage) || 1,
      pageSize: Number(drawer.dataset.sourcePageSize) || sourceDrawerPageSizeForMode(),
      totalCount: groups.length,
      visibleCount: groups.length,
    });
  drawer._sourcePageInfo = pageInfo;
  drawer.dataset.sourcePage = String(pageInfo.page);
  drawer.dataset.sourcePageSize = String(pageInfo.pageSize);
  const visibleCount = groups.length;
  drawer.dataset.visibleSourceGroups = String(visibleCount);
  const shouldShowToolbar = options.showToolbar !== false;
  if (shouldShowToolbar && !drawer.querySelector(":scope > .source-drawer-toolbar")) {
    drawer.append(renderSourceDrawerToolbar(drawer, drawer._songSourceOccurrences, { visibleCount, totalCount: pageInfo.total, pageInfo }));
  } else {
    updateSourceDrawerCount(drawer, visibleCount, pageInfo.total, pageInfo);
  }

  if (groups.length) {
    appendSourceGroupRange(drawer, groups, 0, visibleCount);
  } else {
    showSourceDrawerStatus(drawer, "没有可显示的来源", "empty");
  }
  appendSourceDrawerPager(drawer, pageInfo);
  appendMobileSourceCollapse(drawer);
}

function sourceRenderedGroupCount(drawer) {
  return drawer.querySelectorAll(":scope > .source-video-group").length;
}

function clearSourceDrawerPageContent(drawer) {
  for (const node of drawer.querySelectorAll(":scope > .source-video-group, :scope > .source-drawer-pagination, :scope > .source-drawer-status")) {
    node.remove();
  }
}

function appendSourceGroupRange(drawer, groups, start, end) {
  const fragment = document.createDocumentFragment();
  const safeStart = Math.max(0, start);
  const safeEnd = Math.min(groups.length, Math.max(safeStart, end));
  let firstAppended = null;
  for (const [offset, group] of groups.slice(safeStart, safeEnd).entries()) {
    const node = renderSourceVideoGroup(group, { priorityMedia: safeStart + offset < 6 });
    if (!firstAppended) firstAppended = node;
    fragment.append(node);
  }
  const anchor = drawer.querySelector(":scope > .source-collapse-bottom") || null;
  drawer.insertBefore(fragment, anchor);
  return firstAppended;
}

function renderSourceDrawerToolbar(drawer, occurrences, options = {}) {
  const totalCount = Number.isFinite(options.totalCount)
    ? options.totalCount
    : window.FrontendUtils.groupOccurrencesByVideo(occurrences).length;
  const visibleCount = Number.isFinite(options.visibleCount) ? options.visibleCount : totalCount;
  const pageInfo = options.pageInfo || null;
  const toolbar = document.createElement("div");
  toolbar.className = "source-drawer-toolbar";
  if (drawer.dataset.toolbarVariant === "artist") toolbar.classList.add("artist-source-toolbar");

  const count = document.createElement("span");
  count.className = "source-drawer-count";
  count.textContent =
    drawer.dataset.sourceMode === "artist" || drawer.dataset.sourceMode === "vtuber"
      ? artistSongDrawerCountText(visibleCount, totalCount, pageInfo)
      : sourceDrawerCountText(visibleCount, totalCount, pageInfo);
  toolbar.append(count);

  const actions = document.createElement("div");
  actions.className = "source-drawer-actions";
  if (drawer.dataset.sourceMode !== "vtuber") {
    const copyAll = renderCopySongLinksButton(occurrences);
    copyAll.title = "复制全部链接";
    copyAll.textContent = "";
    copyAll.append(renderLinkListIcon());
    actions.append(copyAll);
  }
  actions.append(renderSourceCollapseButton(drawer.id, drawer.dataset.sourceMode || "song", "source-collapse-top ui-chip"));
  toolbar.append(actions);
  return toolbar;
}

function updateSourceDrawerCount(drawer, visibleCount, totalCount, pageInfo = null) {
  const count = drawer.querySelector(":scope > .source-drawer-toolbar .source-drawer-count");
  if (count) {
    count.textContent =
      drawer.dataset.sourceMode === "artist" || drawer.dataset.sourceMode === "vtuber"
        ? artistSongDrawerCountText(visibleCount, totalCount, pageInfo)
        : sourceDrawerCountText(visibleCount, totalCount, pageInfo);
  }
}

function sourceDrawerCountText(visibleCount, totalCount, pageInfo = null) {
  const suffix = "个来源";
  if (pageInfo && pageInfo.pageCount > 1) {
    const start = pageInfo.total ? pageInfo.startIndex + 1 : 0;
    return `全部 ${pageInfo.total} ${suffix} · ${start}-${pageInfo.endIndex}`;
  }
  if (visibleCount < totalCount) return `已显示 ${visibleCount}/${totalCount} ${suffix}`;
  return `全部 ${totalCount} 个来源`;
}

function artistSongDrawerCountText(visibleCount, totalCount, pageInfo = null) {
  if (pageInfo && pageInfo.pageCount > 1) {
    const start = pageInfo.total ? pageInfo.startIndex + 1 : 0;
    return `全部 ${pageInfo.total} 首歌 · ${start}-${pageInfo.endIndex}`;
  }
  if (visibleCount < totalCount) return `已显示 ${visibleCount}/${totalCount} 首歌`;
  return `全部 ${totalCount} 首歌`;
}

function appendSourceDrawerPager(drawer, pageInfo) {
  if (!pageInfo || pageInfo.pageCount <= 1) return;
  const pager = document.createElement("div");
  pager.className = "source-drawer-pagination";
  const isSongGroupMode = drawer.dataset.sourceMode === "artist" || drawer.dataset.sourceMode === "vtuber";
  pager.setAttribute("aria-label", `${isSongGroupMode ? "曲目" : "来源"}分页，第 ${pageInfo.page} 页，共 ${pageInfo.pageCount} 页`);
  pager.append(
    renderSourcePageButton("上一页", pageInfo.previousPage || 1, !pageInfo.hasPrevious, drawer.id),
    renderSourcePageSummary(pageInfo, drawer.id),
    renderSourcePageButton("下一页", pageInfo.nextPage || pageInfo.pageCount, !pageInfo.hasNext, drawer.id),
  );
  const anchor = drawer.querySelector(":scope > .source-collapse-bottom") || null;
  drawer.insertBefore(pager, anchor);
}

function renderSourcePageSummary(pageInfo, drawerId) {
  const form = document.createElement("form");
  form.className = "source-page-summary source-page-jump";
  form.dataset.sourcePageForm = "true";
  form.setAttribute("aria-controls", drawerId);
  form.setAttribute("aria-label", `跳至曲目页码，当前第 ${pageInfo.page} 页，共 ${pageInfo.pageCount} 页`);

  const input = document.createElement("input");
  input.type = "text";
  input.min = "1";
  input.max = String(pageInfo.pageCount);
  input.step = "1";
  input.value = String(pageInfo.page);
  input.inputMode = "numeric";
  input.pattern = "[0-9]*";
  input.dataset.pageInput = "true";
  input.setAttribute("aria-label", `输入页码，范围 1 到 ${pageInfo.pageCount}`);
  bindPageInputInteraction(input);

  const total = document.createElement("span");
  total.className = "source-page-total";
  total.textContent = `/ ${pageInfo.pageCount}`;

  const submit = document.createElement("button");
  submit.className = "source-page-button source-page-submit ui-chip";
  submit.type = "submit";
  submit.dataset.sourcePageSubmit = "true";
  submit.textContent = "选页";
  submit.setAttribute("aria-label", "跳转到输入的曲目页码");

  form.append(input, total, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    submitSourceDrawerPageForm(form).catch((error) => showToast(`来源翻页失败：${error.message}`));
  });
  submit.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    submitSourceDrawerPageForm(form).catch((error) => showToast(`来源翻页失败：${error.message}`));
  });
  return form;
}

function renderSourcePageButton(label, page, disabled, drawerId) {
  const button = document.createElement("button");
  button.className = "source-page-button ui-chip";
  button.type = "button";
  button.dataset.sourcePage = String(page);
  button.setAttribute("aria-controls", drawerId);
  button.disabled = Boolean(disabled);
  button.textContent = label;
  return button;
}

function showSourceDrawerStatus(drawer, message, kind = "loading") {
  clearSourceDrawerStatus(drawer);
  const status = document.createElement("p");
  status.className = `source-drawer-status source-drawer-status-${kind}`;
  status.setAttribute("role", kind === "error" ? "alert" : "status");
  status.textContent = message;
  const anchor =
    drawer.querySelector(":scope > .source-drawer-pagination") ||
    drawer.querySelector(":scope > .source-collapse-bottom") ||
    null;
  drawer.insertBefore(status, anchor);
  return status;
}

function clearSourceDrawerStatus(drawer) {
  drawer.querySelector(":scope > .source-drawer-status")?.remove();
}

function appendMobileSourceCollapse(drawer) {
  if (!drawer.classList.contains("source-drawer")) return;
  const existing = drawer.querySelector(":scope > .source-collapse-bottom");
  if (!isCompactRankMode()) {
    existing?.remove();
    return;
  }
  const groupCount = drawer._sourceGroups?.length || drawer.querySelectorAll(":scope > .source-video-group").length;
  if (groupCount < 8) {
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
  const isSongGroupMode = mode === "artist" || mode === "vtuber";
  button.setAttribute("aria-label", isSongGroupMode ? "收起曲目" : "收起来源");
  button.textContent = isSongGroupMode ? "收起" : "收起来源";
  return button;
}

function renderSourceVideoGroup(group, options = {}) {
  const section = document.createElement("section");
  section.className = "source-video-group";

  const displayOccurrences = uniqueSourceTimeOccurrences(group.occurrences || []);
  const firstOccurrence = displayOccurrences[0] || group.occurrences[0];
  const videoItem = group.item || firstOccurrence?.item || {};
  const setlistItem = window.FrontendUtils.sourceGroupSetlistItem(hydrateSetlistVideoItem(videoItem, group), group);
  const videoId = videoItem.videoId || group.videoId || "";
  const firstSeconds = firstOccurrence?.song?.seconds || 0;

  const thumbLink = document.createElement("a");
  thumbLink.className = "source-video-thumb-link";
  thumbLink.href = youtubeTimeUrl(videoId, firstSeconds);
  thumbLink.target = "_blank";
  thumbLink.rel = "noopener noreferrer";
  thumbLink.setAttribute("aria-label", `打开来源视频时间戳：${group.title || videoId || "来源视频"}`);
  thumbLink.append(
    createThumbnailImage({ ...videoItem, videoId, thumbnailUrl: videoItem.thumbnailUrl || group.thumbnailUrl }, "source-video-thumb", {
      preferCompact: true,
      priority: options.priorityMedia ? "high" : "auto",
    }),
  );
  section.append(thumbLink);

  const main = document.createElement("div");
  main.className = "source-video-main";

  const topline = document.createElement("div");
  topline.className = "source-video-topline";

  const identity = document.createElement("div");
  identity.className = "source-video-identity";
  const visibleTimes = displayOccurrences.slice(0, SOURCE_TIMESTAMP_INITIAL_LIMIT);
  const extraTimes = displayOccurrences.slice(SOURCE_TIMESTAMP_INITIAL_LIMIT);
  const times = document.createElement("div");
  times.className = "source-video-times";
  visibleTimes.forEach((occurrence, index) => {
    times.append(renderSourceTimestampLink(occurrence, index === 0 ? "source-time-primary" : "source-time-extra"));
  });
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
    times.append(more);
  }
  if (times.childNodes.length) identity.append(times);

  const channelLink = window.FrontendUtils.youtubeChannelLink({ ...videoItem, channelName: group.channelName });
  const channel = document.createElement("a");
  channel.className = "source-video-channel";
  channel.href = channelLink.href;
  channel.target = "_blank";
  channel.rel = "noopener noreferrer";
  channel.textContent = group.channelName || "未知频道";
  channel.setAttribute("aria-label", channelLink.isFallbackSearch ? `搜索频道：${channel.textContent}` : `打开频道：${channel.textContent}`);
  channel.title = channelLink.isFallbackSearch ? `搜索频道：${channel.textContent}` : `打开频道：${channel.textContent}`;
  identity.append(channel);
  topline.append(identity);
  main.append(topline);

  const title = document.createElement("a");
  title.className = "source-video-title";
  title.href = youtubeTimeUrl(videoId, firstSeconds);
  title.target = "_blank";
  title.rel = "noopener noreferrer";
  title.textContent = group.title || videoId || "来源视频";
  title.setAttribute("aria-label", `打开来源视频时间戳：${title.textContent}`);
  main.append(title);

  const publishedText = sourcePublishedText(group, videoItem);
  if (publishedText) {
    const published = document.createElement("div");
    published.className = "source-video-date";
    published.textContent = publishedText;
    main.append(published);
  }

  const extra = document.createElement("div");
  extra.className = "source-extra-times";
  if (extraTimesId) extra.id = extraTimesId;
  extra.hidden = true;
  for (const occurrence of extraTimes) extra.append(renderSourceTimestampLink(occurrence, "source-time-extra"));
  main.append(extra);
  section.append(main);

  section.append(renderCopySetlistIconButton(setlistItem));
  return section;
}

function sourcePublishedText(group = {}, item = {}) {
  const explicit = cleanText(item.publishedText || group.publishedText);
  const value = item.publishedAt || group.publishedAt || item.publishedTimestamp || group.publishedTimestamp;
  if (value) return formatCalendarDate(value);
  return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/u.test(explicit) ? explicit.replaceAll("/", "-") : "";
}

function uniqueSourceTimeOccurrences(occurrences = []) {
  const unique = [];
  for (const occurrence of occurrences || []) {
    const videoId = cleanText(occurrence?.item?.videoId) || cleanText(occurrence?.item?.title);
    const seconds = Math.max(0, Number(occurrence?.song?.seconds) || 0);
    const duplicate = unique.some((accepted) => {
      const acceptedVideoId = cleanText(accepted?.item?.videoId) || cleanText(accepted?.item?.title);
      const acceptedSeconds = Math.max(0, Number(accepted?.song?.seconds) || 0);
      return acceptedVideoId === videoId && Math.abs(acceptedSeconds - seconds) <= SOURCE_TIMESTAMP_DEDUP_WINDOW_SECONDS;
    });
    if (duplicate) continue;
    unique.push(occurrence);
  }
  return unique;
}

function renderSourceTimestampLink(occurrence, className = "source-link source-time-link") {
  const link = document.createElement("a");
  link.className = className.includes("source-link") ? className : `source-link ${className}`;
  link.href = youtubeTimeUrl(occurrence.item.videoId, occurrence.song.seconds);
  link.target = "_blank";
  link.rel = "noopener noreferrer";

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

function hydrateSetlistVideoItem(videoItem = {}, group = {}) {
  const videoId = cleanText(videoItem.videoId || group.videoId);
  const known = videoId ? findVideoItemById(videoId) : null;
  const knownSongs = Array.isArray(known?._allSongs) ? known._allSongs : Array.isArray(known?.songs) ? known.songs : [];
  if (knownSongs.length) {
    return {
      ...known,
      ...videoItem,
      songs: knownSongs,
      _allSongs: knownSongs,
      _sourceOccurrences: group?.occurrences || [],
    };
  }
  const groupedSongs = Array.isArray(group?.occurrences)
    ? group.occurrences.map((occurrence) => occurrence?.song).filter(Boolean)
    : [];
  if (groupedSongs.length > 1) {
    return {
      ...videoItem,
      songs: groupedSongs,
      _allSongs: groupedSongs,
      _sourceOccurrences: group?.occurrences || [],
    };
  }
  return { ...videoItem, _sourceOccurrences: group?.occurrences || [] };
}

function findVideoItemById(videoId) {
  const target = cleanText(videoId);
  if (!target) return null;
  const stack = Array.isArray(state.payload?.items) ? [...state.payload.items] : [];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    if (cleanText(item.videoId) === target) return item;
    if (Array.isArray(item.items)) stack.push(...item.items);
    if (Array.isArray(item.videos)) stack.push(...item.videos);
    if (Array.isArray(item.sources)) stack.push(...item.sources);
  }
  return null;
}

function renderCopySetlistButton(item, label = "复制歌单", className = "copy-setlist-button") {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.dataset.copySetlist = "true";
  button._videoItem = item || {};
  button._sourceOccurrences = item?._sourceOccurrences || [];
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

function renderArtistSongSourceToggleButton(sourcePresentation, sourcesId, group) {
  const button = document.createElement("button");
  button.className = "artist-song-source-toggle";
  button.type = "button";
  button.dataset.toggleArtistSongSource = "true";
  button.dataset.sourceVideoCount = String(sourcePresentation?.videoCount || group?.videoCount || 0);
  button.dataset.occurrenceCount = String(sourcePresentation?.occurrenceCount || group?.count || 0);
  button.setAttribute("aria-controls", sourcesId);
  button.setAttribute("aria-expanded", "false");
  updateArtistSongSourceButton(button, false);
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
  if (drawer?.dataset?.sourceMode === "vtuber") {
    appendPagedVtuberSongGroups(drawer, songGroups);
    return;
  }
  clearSourceDrawerStatus(drawer);
  drawer._artistSongGroups = songGroups;
  const visibleCount = artistVisibleSongCount(drawer, songGroups.length);
  if (!drawer.querySelector(":scope > .source-drawer-toolbar")) {
    drawer.append(renderSourceDrawerToolbar(drawer, drawer._songSourceOccurrences || [], { visibleCount, totalCount: songGroups.length }));
  } else {
    updateSourceDrawerCount(drawer, visibleCount, songGroups.length);
  }
  appendArtistSongGroupRange(drawer, songGroups, artistRenderedSongCount(drawer), visibleCount);
  if (artistRenderedSongCount(drawer) > 0) {
    syncArtistSongMoreButton(drawer, visibleCount, songGroups.length);
  } else {
    syncArtistSongMoreButton(drawer, songGroups.length, songGroups.length);
    showSourceDrawerStatus(drawer, "没有可显示的曲目", "empty");
  }
  appendMobileSourceCollapse(drawer);
}

function appendPagedVtuberSongGroups(drawer, songGroups) {
  clearVtuberSongPageContent(drawer);
  const safeGroups = Array.isArray(songGroups) ? songGroups : [];
  drawer._artistSongGroups = safeGroups;
  const pageSize = vtuberSongGroupPageSizeForMode();
  const pageInfo = window.FrontendUtils.sourceDrawerPageModel({
    page: Number(drawer.dataset.sourcePage) || 1,
    pageSize,
    totalCount: safeGroups.length,
    visibleCount: Math.min(pageSize, safeGroups.length),
  });
  drawer.dataset.sourcePage = String(pageInfo.page);
  drawer.dataset.sourcePageSize = String(pageInfo.pageSize);
  drawer._artistSongPageInfo = pageInfo;
  if (!drawer.querySelector(":scope > .source-drawer-toolbar")) {
    drawer.append(renderSourceDrawerToolbar(drawer, drawer._songSourceOccurrences || [], { visibleCount: pageInfo.visibleCount, totalCount: safeGroups.length, pageInfo }));
  } else {
    updateSourceDrawerCount(drawer, pageInfo.visibleCount, safeGroups.length, pageInfo);
  }
  appendArtistSongGroupRange(drawer, safeGroups, pageInfo.startIndex, pageInfo.endIndex);
  if (artistRenderedSongCount(drawer) > 0) {
    appendSourceDrawerPager(drawer, pageInfo);
  } else {
    showSourceDrawerStatus(drawer, "没有可显示的曲目", "empty");
  }
  appendMobileSourceCollapse(drawer);
}

function clearVtuberSongPageContent(drawer) {
  for (const node of drawer.querySelectorAll(":scope > .artist-song-group, :scope > .artist-song-more, :scope > .source-drawer-pagination, :scope > .source-drawer-status")) {
    node.remove();
  }
}

function completeSongGroupsForDrawer(occurrences, fallbackGroups = [], mode = "") {
  const completeGroups = buildArtistSongGroups(filterDisplaySongOccurrences(occurrences || []), {
    mergeSameWorkTitle: mode === "vtuber",
  });
  if (mode === "vtuber") return mergeVtuberSongGroupsForDrawer(completeGroups, fallbackGroups);
  return completeGroups.length ? completeGroups : fallbackGroups || [];
}

function mergeVtuberSongGroupsForDrawer(completeGroups = [], fallbackGroups = []) {
  const byKey = new Map();
  const addGroup = (group) => {
    if (!group) return;
    const key = sourceSongKeyForGroup(group) || group.key || normalizeEntityKey(group.title);
    if (!key) return;
    const next = markVtuberSongGroup(group);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, next);
      return;
    }
    if ((next.occurrences?.length || 0) > (existing.occurrences?.length || 0)) {
      existing.occurrences = next.occurrences;
    }
    existing.count = Math.max(Number(existing.count) || 0, Number(next.count) || 0, next.occurrences?.length || 0);
    existing.videoCount = Math.max(Number(existing.videoCount) || 0, Number(next.videoCount) || 0);
    existing.isNiche = Boolean(existing.isNiche || next.isNiche);
    existing._record = existing._record || next._record;
    existing._sourceResolver = existing._sourceResolver || next._sourceResolver;
  };
  for (const group of fallbackGroups || []) addGroup(group);
  for (const group of completeGroups || []) addGroup(group);
  return sortVtuberSongGroups(
    Array.from(byKey.values())
      .map((group) => normalizeArtistSongGroupCount(hydrateArtistSongGroup(group)))
      .filter((group) => group.sourceMode === "vtuber" || group.occurrences?.length),
  );
}

function markVtuberSongGroup(group) {
  group.sourceMode = "vtuber";
  return group;
}

function normalizeArtistSongGroupCount(group) {
  group.count = Math.max(Number(group.count) || 0, group.occurrences?.length || 0);
  group.videoCount = Math.max(Number(group.videoCount) || 0, uniqueVideoCount(group.occurrences || []));
  return group;
}

function sortVtuberSongGroups(groups) {
  return (groups || []).map(markVtuberSongGroup).sort(compareArtistSongGroupRank);
}

function compareArtistSongGroupRank(a, b) {
  return (
    (Number(b?.count) || 0) - (Number(a?.count) || 0) ||
    (Number(b?.videoCount) || 0) - (Number(a?.videoCount) || 0) ||
    compareValues(a?.title || a?.key, b?.title || b?.key)
  );
}

function artistRenderedSongCount(drawer) {
  return drawer.querySelectorAll(":scope > .artist-song-group").length;
}

function artistVisibleSongCount(drawer, total) {
  const parsed = Number.parseInt(drawer.dataset.visibleArtistSongs || "", 10);
  const initialLimit = artistSongInitialLimit(drawer);
  const requested = Number.isFinite(parsed) && parsed > 0 ? parsed : initialLimit;
  const visibleCount = Math.min(total, Math.max(initialLimit, requested));
  drawer.dataset.visibleArtistSongs = String(visibleCount);
  return visibleCount;
}

function artistSongInitialLimit(drawer) {
  return drawer?.dataset?.sourceMode === "vtuber" ? VTUBER_SONG_GROUP_INITIAL_LIMIT : ARTIST_SONG_GROUP_INITIAL_LIMIT;
}

function artistSongBatchSize(drawer) {
  return drawer?.dataset?.sourceMode === "vtuber" ? VTUBER_SONG_GROUP_BATCH_SIZE : ARTIST_SONG_GROUP_BATCH_SIZE;
}

function vtuberSongGroupPageSizeForMode(mode = getResponsiveMode()) {
  return sourceDrawerPageSizeForMode(mode);
}

function appendArtistSongGroupRange(drawer, songGroups, start, end) {
  const fragment = document.createDocumentFragment();
  const safeStart = Math.max(0, start);
  const safeEnd = Math.min(songGroups.length, Math.max(safeStart, end));
  let firstAppended = null;
  for (const group of songGroups.slice(safeStart, safeEnd)) {
    const node = renderArtistSongGroup(group);
    if (!node) continue;
    if (!firstAppended) firstAppended = node;
    fragment.append(node);
  }
  drawer.insertBefore(fragment, drawer.querySelector(":scope > .artist-song-more") || drawer.querySelector(":scope > .source-collapse-bottom") || null);
  return firstAppended;
}

function renderArtistSongGroup(group) {
  hydrateArtistSongGroup(group);
  const hasOccurrences = Boolean(group.occurrences?.length);
  if (!hasOccurrences && group.sourceMode !== "vtuber") return null;
  const section = document.createElement("section");
  section.className = "artist-song-group";
  if (group.sourceMode === "vtuber") section.classList.add("artist-song-group-vtuber");

  const header = document.createElement("div");
  header.className = "artist-song-header";

  const firstOccurrence = group.occurrences?.[0] || null;
  const previewOccurrence = latestOccurrenceByVideoDate(group.occurrences) || firstOccurrence;
  const previewItem = previewOccurrence?.item || group._record || {};
  const previewSong = previewOccurrence?.song || { seconds: 0, title: group.title };
  const rankSearchUrl = group.sourceMode === "vtuber" ? buildSearchUrlForSongGroup(group) : "";
  const thumbTag = rankSearchUrl || previewItem.videoId ? "a" : "span";
  const thumb = document.createElement(thumbTag);
  thumb.className =
    rankSearchUrl || previewItem.videoId ? "artist-song-thumb source-link" : "artist-song-thumb artist-song-thumb-static";
  if (rankSearchUrl) {
    thumb.href = rankSearchUrl;
    thumb.dataset.rankSearchLink = "true";
    thumb.setAttribute("aria-label", `在歌曲榜搜索：${group.title}`);
  } else if (previewItem.videoId) {
    thumb.href = youtubeTimeUrl(previewItem.videoId, previewSong.seconds);
    thumb.target = "_blank";
    thumb.rel = "noopener noreferrer";
    thumb.setAttribute("aria-label", `打开最新来源：${group.title}`);
  } else {
    thumb.setAttribute("aria-hidden", "true");
  }
  thumb.append(createThumbnailImage(previewItem, "artist-song-thumb-image", {
    alt: group.title,
    preferCompact: true,
    priority: "auto",
  }));
  header.append(thumb);

  const titleWrap = document.createElement("div");
  titleWrap.className = "artist-song-title-wrap";
  const title = document.createElement("a");
  title.className = "artist-song-title";
  title.textContent = group.title;
  if (rankSearchUrl) {
    title.href = rankSearchUrl;
    title.dataset.rankSearchLink = "true";
    title.setAttribute("aria-label", `在歌曲榜搜索：${group.title}`);
  } else if (firstOccurrence?.item?.videoId) {
    title.href = youtubeTimeUrl(firstOccurrence.item.videoId, firstOccurrence.song.seconds);
    title.target = "_blank";
    title.rel = "noopener noreferrer";
    title.setAttribute("aria-label", `打开歌曲首次来源：${group.title}`);
  } else {
    title.href = buildSearchUrlForSongGroup(group);
    title.setAttribute("aria-label", `搜索歌曲：${group.title}`);
  }
  titleWrap.append(title);

  if (group.isNiche && group.sourceMode !== "vtuber") {
    const badge = document.createElement("span");
    badge.className = "song-badge niche-badge";
    badge.textContent = "小众";
    titleWrap.append(badge);
  }
  const artistLabel = artistLabelForSongGroup(group);
  if (artistLabel) {
    const artist = document.createElement("span");
    artist.className = "artist-song-artist";
    artist.textContent = artistLabel;
    titleWrap.append(artist);
  }
  const publishedDate = formatCalendarDate(
    previewItem.publishedAt ||
      previewItem.publishedTimestamp ||
      group.publishedAt ||
      group.publishedTimestamp,
  );
  header.append(titleWrap);

  const sourceDetailPath = sourceDetailPathForRecord(group, group.occurrences);
  const meta = document.createElement("div");
  meta.className = "artist-song-summary-actions";
  if (publishedDate && group.sourceMode === "vtuber") {
    const date = document.createElement("span");
    date.className = "artist-song-date";
    date.textContent = publishedDate;
    meta.append(date);
  }
  if (group.isNiche && group.sourceMode === "vtuber") {
    const badge = document.createElement("span");
    badge.className = "song-badge niche-badge";
    badge.textContent = "小众";
    meta.append(badge);
  }

  const count = document.createElement(group.sourceMode === "vtuber" ? "button" : "span");
  count.className = "artist-song-count";
  count.textContent =
    group.sourceMode === "vtuber" ? vtuberSongGroupMetaLabel(group) : artistSongCountLabel(group);
  if (group.sourceMode === "vtuber") {
    count.type = "button";
    count.dataset.copySongLinks = "true";
    count.dataset.copyUrlsOnly = "true";
    count._sourceOccurrences = group.occurrences || [];
    count.title = `复制《${group.title}》全部场次链接`;
    count.setAttribute("aria-label", `复制《${group.title}》全部场次链接`);
    if (!hasOccurrences && !sourceDetailPath) count.disabled = true;
  }
  meta.append(count);
  if (group.sourceMode !== "vtuber" && group.videoCount > 0) {
    const videoCount = document.createElement("span");
    videoCount.className = "artist-song-video-count";
    videoCount.textContent = `${group.videoCount}个视频`;
    meta.append(videoCount);
  }

  const sources = document.createElement("div");
  sources.className = "artist-song-sources";
  sources.id = `artist-song-sources-${makeDomId(`${group.key}-${firstOccurrence?.item?.videoId || "song"}`)}`;
  sources.dataset.sourceMode = "artist-song";
  sources.dataset.sourceDeferred = "true";
  sources.dataset.sourcePage = "1";
  sources.dataset.sourcePageSize = String(sourceDrawerPageSizeForMode());
  sources.hidden = true;
  section._artistSongSources = sources;

  const expectedSourceCount =
    group.sourceMode === "vtuber" && !(Number(group.videoCount) > 0)
      ? Math.max(0, Number(group.count) || 0)
      : group.videoCount;
  const sourcePresentation = window.FrontendUtils.sourcePresentationModel(group.occurrences, {
    expanded: false,
    inlineLimit: sourceInlineLimitForMode(),
    totalVideoCount: expectedSourceCount,
    hasExternalDetails: Boolean(sourceDetailPath),
  });
  sources._sourceOccurrences = group.occurrences;
  sources._songSourceOccurrences = group.occurrences;
  sources._sourceResolver = group._sourceResolver || null;
  sources._sourceDetailPath = sourceDetailPath;
  sources._sourceDetailKey = cleanText(group._record?.sourceDetailKey || "");
  sources._sourceSongKey = sourceSongKeyForGroup(group);
  sources._sourceSongTitle = group.title;

  if (sourcePresentation.canExpand && group.sourceMode !== "vtuber") {
    meta.append(renderArtistSongSourceToggleButton(sourcePresentation, sources.id, group));
  }
  if (hasOccurrences && group.sourceMode !== "vtuber") {
    meta.append(renderCopySongLinksIconButton(group.occurrences));
  }
  header.append(meta);
  section.append(header);
  if (group.sourceMode !== "vtuber") {
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
  }
  if (sourcePresentation.canExpand && group.sourceMode !== "vtuber") section.append(sources);
  return section;
}

function buildSearchUrlForSongGroup(group) {
  const params = new URLSearchParams(window.location.search);
  const record = group?._record || {};
  const occurrenceItem = group?.occurrences?.[0]?.item || {};
  const handle = vtuberReliableHandle(record) || cleanVtuberChannelHandle(occurrenceItem.channelHandle);
  const channelName = vtuberReliableDisplayName(record) || cleanText(occurrenceItem.channelName);
  const artist = artistLabelForSongGroup(group);
  const query = window.FrontendUtils.vtuberSongSearchQueryModel({
    title: group?.title,
    channelHandle: handle,
    channelName,
    artist: artist && !window.RankingUtils.isUnknownArtistName(artist) ? artist : "",
  });
  params.set("view", "songRank");
  params.set("metric", "occurrences");
  params.set("q", query.q);
  params.set("searchFields", query.searchFields.join(","));
  params.delete("searchScope");
  params.delete("page");
  params.delete("bucket");
  params.delete("layout");
  params.delete("outside");
  params.delete("libraryOutside");
  params.delete("hideUnknown");
  params.delete("showUnknown");
  params.delete("trend");
  params.delete("minCount");
  params.delete("shared");
  return `${window.location.pathname}?${params.toString()}`;
}

function artistLabelForSongGroup(group) {
  const counts = new Map();
  for (const occurrence of group?.occurrences || []) {
    const rawName = cleanText(occurrence?.song?.artist);
    const name = window.RankingUtils.canonicalizeArtistName(rawName) || rawName;
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || compareValues(a[0], b[0]));
  const knownEntries = entries.filter(([name]) => !window.RankingUtils.isUnknownArtistName(name));
  if (knownEntries.length) return knownEntries[0][0];
  if (entries.length) return entries[0][0];
  const displayArtist = cleanText(group?.displayArtist);
  if (!displayArtist || window.RankingUtils.isUnknownArtistName(displayArtist)) return "";
  return displayArtist.split(/[、，]/u)[0].replace(/\s*\(\d+\)\s*$/u, "").trim();
}

function artistSongCountLabel(group) {
  const count = Math.max(0, Number(group?.count) || 0);
  const videoCount = Math.max(0, Number(group?.videoCount) || uniqueVideoCount(group?.occurrences || []));
  if (group?.sourceMode === "vtuber") return `${count}次`;
  if (videoCount > 0 && videoCount !== count) return `${count}次 · ${videoCount}来源`;
  return `${count}次`;
}

function vtuberSongGroupMetaLabel(group) {
  const count = Math.max(0, Number(group?.count) || 0);
  return `${count}次`;
}

function hydrateArtistSongGroup(group) {
  if (Array.isArray(group.occurrences)) {
    group.occurrences = filterDisplaySongOccurrences(group.occurrences);
    group.videoCount = group.videoCount || uniqueVideoCount(group.occurrences);
    return group;
  }
  const record = group._record || {};
  const key = group.key || normalizeEntityKey(group.title);
  const occurrences = filterOccurrencesForSongKey(filterDisplaySongOccurrences(record.occurrences || []), key, group.title);
  group.occurrences = occurrences;
  group.videoCount = uniqueVideoCount(occurrences);
  group.isNiche = occurrences.length > 0 && occurrences.every(({ song }) => window.FrontendUtils.isNicheSong(song));
  return group;
}

function syncArtistSongMoreButton(drawer, visibleCount, totalCount) {
  updateSourceDrawerCount(drawer, Math.min(visibleCount, totalCount), totalCount);
  let more = drawer.querySelector(":scope > .artist-song-more");
  if (visibleCount >= totalCount) {
    more?.remove();
    return null;
  }
  const remaining = totalCount - visibleCount;
  const batch = Math.min(artistSongBatchSize(drawer), remaining);
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
  setSourceDrawerExpanded(row, nextExpanded).catch((error) => showToast(`展开来源失败：${error.message}`));
}

function collapseSourceDrawer(row, options = {}) {
  setSourceDrawerExpanded(row, false, options).catch((error) => showToast(`收起来源失败：${error.message}`));
}

function closeOtherMobileSourceDrawers(currentRow) {
  const rows = els.content?.querySelectorAll(".rank-row.is-expanded, .index-row.is-expanded") || [];
  for (const row of rows) {
    if (row !== currentRow) setSourceDrawerExpanded(row, false);
  }
}

async function setSourceDrawerExpanded(row, nextExpanded, options = {}) {
  if (!row) return;
  const drawer = row.querySelector(".source-drawer");
  const buttons = Array.from(row.querySelectorAll("[data-toggle-source]"));
  if (!drawer || !buttons.length) return;

  if (nextExpanded) {
    drawer.hidden = false;
    row.classList.add("is-expanded");
    syncInlineCopyAllButton(row, true);
  }

  if (nextExpanded && drawer.dataset.sourceDeferred === "true") {
    const mode = row.dataset.drawerMode || drawer.dataset.sourceMode || "song";
    const isSongGroupMode = mode === "artist" || mode === "vtuber";
    let songGroups =
      isSongGroupMode ? row._artistSongGroups || row._getArtistSongGroups?.() || [] : row._artistSongGroups || [];
    if (isSongGroupMode) row._artistSongGroups = songGroups;
    let drawerOccurrences = row._sourceDetailOccurrences || row._sourceOccurrences || [];
    drawer.setAttribute("aria-busy", "true");
    showSourceDrawerStatus(drawer, "正在加载来源...");
    try {
      const pageState = isSongGroupMode
        ? { occurrences: await sourceDetailOccurrencesForContainer(row, drawerOccurrences), groups: null, pageInfo: null }
        : await sourceDetailPageForContainer(row, drawerOccurrences, {
            page: Number(drawer.dataset.sourcePage) || 1,
            pageSize: sourceDrawerPageSizeForMode(),
          });
      const visibleOccurrences = pageState.occurrences;
      row._sourceDetailOccurrences = pageState.completeOccurrences || visibleOccurrences || drawerOccurrences;
      if (isSongGroupMode) {
        songGroups = completeSongGroupsForDrawer(row._sourceDetailOccurrences || visibleOccurrences, songGroups, mode);
        row._artistSongGroups = songGroups;
      }
      clearSourceDrawerStatus(drawer);
      initializeSourceDrawer(drawer, {
        mode,
        occurrences: visibleOccurrences,
        copyOccurrences: visibleOccurrences,
        songGroups,
        sourceGroups: pageState.groups,
        sourcePageInfo: pageState.pageInfo,
      });
    } catch (error) {
      clearSourceDrawerPageContent(drawer);
      showSourceDrawerStatus(drawer, `来源读取失败：${error.message || "未知错误"}`, "error");
      throw error;
    } finally {
      drawer.setAttribute("aria-busy", "false");
    }
  }
  if (nextExpanded) appendMobileSourceCollapse(drawer);
  drawer.hidden = !nextExpanded;
  row.classList.toggle("is-expanded", nextExpanded);
  syncInlineCopyAllButton(row, nextExpanded);
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
    const rankMetric = button.dataset.sourceRankMetric || "occurrences";
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

async function setSourceDrawerPage(button) {
  const drawer = document.getElementById(button.getAttribute("aria-controls")) || button.closest(".source-drawer");
  const page = Math.max(1, Math.floor(Number(button.dataset.sourcePage) || 1));
  await setSourceDrawerPageForDrawer(drawer, page);
}

async function submitSourceDrawerPageForm(form) {
  const drawer = document.getElementById(form?.getAttribute("aria-controls")) || form?.closest(".source-drawer");
  const input = form?.querySelector("[data-page-input]");
  const page = Math.max(1, Math.floor(Number(input?.value) || 1));
  await setSourceDrawerPageForDrawer(drawer, page);
}

async function setSourceDrawerPageForDrawer(drawer, page) {
  const row = drawer?.closest(".rank-row, .index-row");
  if (!drawer || !row) return;
  if (drawer.dataset.sourceMode === "vtuber") {
    drawer.dataset.sourcePage = String(page);
    const songGroups = row._artistSongGroups || (typeof row._getArtistSongGroups === "function" ? row._getArtistSongGroups() : []);
    row._artistSongGroups = songGroups;
    appendPagedVtuberSongGroups(drawer, songGroups);
    window.requestAnimationFrame(() => focusWithoutScrolling(drawer.querySelector(":scope > .artist-song-group") || drawer));
    return;
  }
  const sourceContainer = drawer.dataset.sourceMode === "artist-song" ? drawer : row;
  const pageSize = sourceDrawerPageSizeForMode();
  drawer.dataset.sourcePage = String(page);
  drawer.dataset.sourcePageSize = String(pageSize);
  drawer.setAttribute("aria-busy", "true");
  showSourceDrawerStatus(drawer, "正在加载来源...");
  try {
    const pageState = await sourceDetailPageForContainer(sourceContainer, sourceContainer._sourceDetailOccurrences || sourceContainer._sourceOccurrences || [], { page, pageSize });
    sourceContainer._sourceDetailOccurrences = pageState.completeOccurrences || sourceContainer._sourceDetailOccurrences || pageState.occurrences;
    appendSourceDrawerLinks(drawer, pageState.occurrences, {
      showToolbar: true,
      copyOccurrences: sourceContainer._songSourceOccurrences || pageState.occurrences,
      groups: pageState.groups,
      pageInfo: pageState.pageInfo,
    });
  } catch (error) {
    clearSourceDrawerPageContent(drawer);
    showSourceDrawerStatus(drawer, `来源读取失败：${error.message || "未知错误"}`, "error");
    throw error;
  } finally {
    drawer.setAttribute("aria-busy", "false");
  }
}

function syncInlineCopyAllButton(row, isExpanded) {
  const actions = row?.querySelector(":scope .source-inline-strip > .source-inline-actions");
  if (!actions) return;
  const existing = actions.querySelector(":scope > [data-copy-song-links]");
  if (isExpanded) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const occurrences = row._sourceOccurrences || [];
  const groupCount = Math.max(Number(row._sourceVideoCount) || 0, window.FrontendUtils.groupOccurrencesByVideo(occurrences).length);
  if (groupCount <= 1 || groupCount > sourceInlineLimitForMode()) return;
  actions.append(renderInlineCopySongLinksButton(occurrences));
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
  delete drawer.dataset.sourceRemainder;
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

function toggleArtistSongLimit(target) {
  const drawer = target?.closest?.(".artist-song-drawer") || target?.querySelector?.(".artist-song-drawer");
  if (!drawer) return;
  const row = drawer.closest(".rank-row, .index-row");
  if (!row) return;
  const songGroups = row._artistSongGroups || row._getArtistSongGroups?.() || [];
  row._artistSongGroups = songGroups;
  const current = artistRenderedSongCount(drawer);
  const nextVisible = Math.min(songGroups.length, current + artistSongBatchSize(drawer));
  drawer.dataset.visibleArtistSongs = String(nextVisible);
  const firstNewGroup = appendArtistSongGroupRange(drawer, songGroups, current, nextVisible);
  syncArtistSongMoreButton(drawer, nextVisible, songGroups.length);
  appendMobileSourceCollapse(drawer);
  window.requestAnimationFrame(() => focusWithoutScrolling(firstNewGroup || drawer));
}

async function toggleArtistSongSource(button) {
  const section = button.closest(".artist-song-group");
  const sources = document.getElementById(button.getAttribute("aria-controls")) || section?._artistSongSources;
  if (!section || !sources) return;
  const nextExpanded = sources.hidden;
  if (nextExpanded && isCompactRankMode()) closeSiblingArtistSongSources(section);
  if (nextExpanded && sources.dataset.sourceDeferred === "true") {
    const pageSize = sourceDrawerPageSizeForMode();
    sources.dataset.sourcePage = sources.dataset.sourcePage || "1";
    sources.dataset.sourcePageSize = String(pageSize);
    const pageState = await sourceDetailPageForContainer(sources, sources._sourceOccurrences || [], {
      page: Number(sources.dataset.sourcePage) || 1,
      pageSize,
    });
    sources._sourceDetailOccurrences = pageState.completeOccurrences || sources._sourceOccurrences || pageState.occurrences;
    appendSourceDrawerLinks(sources, pageState.occurrences, {
      copyOccurrences: sources._songSourceOccurrences || sources._sourceOccurrences || [],
      showToolbar: false,
      groups: pageState.groups,
      pageInfo: pageState.pageInfo,
    });
    delete sources.dataset.sourceDeferred;
  }
  sources.hidden = !nextExpanded;
  section.classList.toggle("is-expanded", nextExpanded);
  button.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
  if (button.dataset.sourceSummaryToggle === "true") updateSourceInlineMoreButton(button, nextExpanded);
  else updateArtistSongSourceButton(button, nextExpanded);
}

function syncArtistSongGroupSourceSummary(section, sources, occurrences) {
  const sourceOccurrences = occurrences || [];
  if (!section || !sourceOccurrences.length) return;
  const group = section._songGroup || {};
  const latestOccurrence = latestOccurrenceByVideoDate(sourceOccurrences) || sourceOccurrences[0];
  const videoCount = uniqueVideoCount(sourceOccurrences);
  group.occurrences = sourceOccurrences;
  group.videoCount = videoCount;
  group.latestOccurrence = latestOccurrence;
  group.artistSummary = artistSummaryForOccurrences(sourceOccurrences) || group.artistSummary || "";
  group.sourceIncomplete = false;
  section._songGroup = group;
  if (sources) {
    sources._sourceOccurrences = sourceOccurrences;
    sources._songSourceOccurrences = sourceOccurrences;
  }
  syncArtistSongGroupThumb(section, group);
  syncArtistSongGroupTitleLink(section, group);
  syncArtistSongGroupArtist(section, group.artistSummary);
  syncArtistSongGroupVideoCount(section, videoCount);
  const button = section.querySelector("[data-toggle-artist-song-source]");
  if (button) {
    button.dataset.sourceVideoCount = String(videoCount);
    button.dataset.occurrenceCount = String(sourceOccurrences.length);
    updateArtistSongSourceButton(button, button.getAttribute("aria-expanded") === "true");
  }
}

function syncArtistSongGroupThumb(section, group) {
  const header = section.querySelector(":scope > .artist-song-header");
  const latestOccurrence = group?.latestOccurrence;
  if (!header || !latestOccurrence?.item?.videoId) return;
  let thumb = header.querySelector(":scope > .artist-song-thumb");
  if (!thumb || thumb.tagName !== "A") {
    const nextThumb = document.createElement("a");
    nextThumb.className = "artist-song-thumb source-link";
    if (thumb) thumb.replaceWith(nextThumb);
    else header.insertBefore(nextThumb, header.firstChild);
    thumb = nextThumb;
  }
  thumb.href = youtubeTimeUrl(latestOccurrence.item.videoId, latestOccurrence.song?.seconds || 0);
  thumb.target = "_blank";
  thumb.rel = "noopener noreferrer";
  thumb.setAttribute("aria-label", `打开最新来源：${group.title}`);
  thumb.textContent = "";
  thumb.append(
    createThumbnailImage(latestOccurrence.item, "artist-song-thumb-image", {
      preferCompact: true,
      width: 72,
      height: 40,
    }),
  );
}

function syncArtistSongGroupTitleLink(section, group) {
  const title = section.querySelector(":scope .artist-song-title");
  const firstOccurrence = group?.occurrences?.[0];
  if (!title || !firstOccurrence?.item?.videoId) return;
  title.href = youtubeTimeUrl(firstOccurrence.item.videoId, firstOccurrence.song?.seconds || 0);
  title.target = "_blank";
  title.rel = "noopener noreferrer";
  title.setAttribute("aria-label", `打开歌曲来源：${group.title}`);
}

function syncArtistSongGroupArtist(section, artistSummary) {
  const meta = section.querySelector(":scope .artist-song-summary-actions");
  if (!meta || !artistSummary) return;
  let artist = meta.querySelector(":scope > .artist-song-artist");
  if (!artist) {
    artist = document.createElement("span");
    artist.className = "artist-song-artist";
    meta.insertBefore(artist, meta.firstChild);
  }
  artist.textContent = artistSummary;
}

function syncArtistSongGroupVideoCount(section, videoCount) {
  const meta = section.querySelector(":scope .artist-song-summary-actions");
  if (!meta || !videoCount) return;
  let count = meta.querySelector(":scope > .artist-song-video-count");
  if (!count) {
    count = document.createElement("span");
    count.className = "artist-song-video-count";
    const copyButton = meta.querySelector(":scope > [data-copy-song-links]");
    meta.insertBefore(count, copyButton || null);
  }
  count.textContent = `${videoCount}个视频`;
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

function renderVideo(item) {
  const card = document.createElement("article");
  card.className = "video-card";

  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`;
  const thumbLink = document.createElement("a");
  thumbLink.className = "thumb-link";
  thumbLink.href = url;
  thumbLink.target = "_blank";
  thumbLink.rel = "noopener noreferrer";
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
  title.rel = "noopener noreferrer";
  title.textContent = item.title || item.videoId;
  title.title = `打开视频：${item.title || item.videoId}`;
  title.setAttribute("aria-label", `打开视频：${item.title || item.videoId}`);
  titleWrap.append(title);

  const meta = document.createElement("div");
  meta.className = "video-meta";
  meta.textContent = [item.channelName, item.publishedText, item.keyword].filter(Boolean).join(" · ");
  titleWrap.append(meta);
  heading.append(titleWrap);

  const count = document.createElement("div");
  count.className = "song-count";
  const matchCount = item._songSearchMatchCount || 0;
  const declaredCount = Number(item.count) || Number(item.songCount) || item.songs?.length || 0;
  count.textContent = matchCount && !item._videoSearchMatched ? `匹配 ${matchCount} 首` : `${declaredCount} 首`;
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
    link.rel = "noopener noreferrer";

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
  const text = await response.text();
  if (!response.ok) {
    let detail = "";
    try {
      const payload = JSON.parse(text);
      detail = cleanText(payload?.message || payload?.error);
    } catch {
      // Keep the status diagnostic even when a proxy returns HTML or plain text.
    }
    const label = response.status === 400
      ? "请求参数错误"
      : response.status === 404
        ? "请求资源不存在"
        : response.status === 502
          ? "数据服务暂时不可用"
        : response.status === 504
          ? "查询超时"
          : "请求失败";
    const error = new Error(`${label}（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
    error.status = response.status;
    error.requestPath = path;
    error.diagnosticDetail = detail;
    error.body = text.slice(0, 512);
    throw error;
  }
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
  if (/^data\/ui\/(?:7d|all|72h|1m)\.[0-9a-f]{12}\.json$/u.test(path)) return "force-cache";
  if (/^data\/ui\/(?:ranges|source-details|search)\/(?:7d|all)\/(?:manifest|page-\d{4})\.[0-9a-f]{12}\.json$/u.test(path)) return "force-cache";
  if (/^data\/ui\/(?:ranges|source-details|search)\/(?:7d|all)\/manifest\.json$/u.test(path)) return "no-cache";
  if (/^data\/ui\/ranges\/(?:7d|all)\/summary\.[0-9a-f]{12}\.json$/u.test(path)) return "force-cache";
  if (/^data\/ui\/ranges\/(?:7d|all)\/views\/.+\/(?:index|index-page-\d{4}|manifest|page-\d{4})\.[0-9a-f]{12}\.json$/u.test(path)) return "force-cache";
  if (/^data\/ui\/ranges\/(?:7d|all)\/records\/(?:song|artist|video)\/shard-\d{4}\.[0-9a-f]{12}\.json$/u.test(path)) return "force-cache";
  if (/^data\/ui\/ranges\/(?:7d|all)\/sources\/[^/]+\.[0-9a-f]{12}\.json$/u.test(path)) return "force-cache";
  if (/^data\/ui\/ranges\/(?:7d|all)\/search\/.+\/page-\d{4}\.[0-9a-f]{12}\.json$/u.test(path)) return "force-cache";
  if (/^data\/ui\/ranges\/(?:7d|all)\/(?:views|records|sources|search)\/.+\/manifest\.json$/u.test(path)) return "no-cache";
  if (/^data\/ui\/(?:7d|all|72h|1m)\.json$/u.test(path)) return "no-cache";
  if (/^data\/diff\/latest-(?:7d|all|72h|1m)\.json$/u.test(path)) return "no-cache";
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

function latestOccurrenceByVideoDate(occurrences) {
  let latest = null;
  let latestValue = -1;
  for (const occurrence of occurrences || []) {
    const item = occurrence?.item || {};
    const numeric = Number(item.publishedTimestamp);
    const value = Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(item.publishedAt || "") || 0;
    if (!latest || value >= latestValue) {
      latest = occurrence;
      latestValue = value;
    }
  }
  return latest;
}

function isNicheRecord(record) {
  const occurrences = record.occurrences || [];
  return occurrences.length > 0 && occurrences.every(({ song }) => window.FrontendUtils.isNicheSong(song));
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
  if (state.filter && state.nicheOnly) return `显示 ${visible} / ${nicheTotal} 条小众歌曲收录`;
  if (state.filter || state.nicheOnly) return `${state.nicheOnly ? "小众" : "显示"} ${visible} / ${total} 条歌曲收录`;
  return `${total} 条歌曲收录`;
}

function artistSongPreview(record) {
  return sortedDisplaySongEntries(record.songs)
    .slice(0, 2)
    .map((entry) => entry.name);
}

function vtuberSongPreview(record) {
  return sortedDisplaySongEntries(record.songs)
    .slice(0, 2)
    .map((entry) => entry.name);
}

function getArtistSongGroups(record) {
  if (!record._songGroups) record._songGroups = lightweightSongGroupsForRecord(record);
  return record._songGroups;
}

function getVtuberSongGroups(record) {
  if (!record._vtuberSongGroups) {
    const occurrences = filterDisplaySongOccurrences(record?.occurrences || []);
    const fallbackGroups = lightweightSongGroupsForRecord(record, { mergeSameWorkTitle: true });
    const occurrenceGroups = buildArtistSongGroups(occurrences, { mergeSameWorkTitle: true });
    const groups = fallbackGroups.length ? mergeVtuberSongGroupsForDrawer(occurrenceGroups, fallbackGroups) : occurrenceGroups;
    record._vtuberSongGroups = sortVtuberSongGroups(groups.map(markVtuberSongGroup));
  }
  return record._vtuberSongGroups;
}

function lightweightSongGroupsForRecord(record, options = {}) {
  const entries = record?.songs instanceof Map ? sortedDisplaySongEntries(record.songs) : [];
  if (!entries.length) return buildArtistSongGroups(filterDisplaySongOccurrences(record?.occurrences || []), options);
  const occurrenceGroups = buildArtistSongGroups(filterDisplaySongOccurrences(record?.occurrences || []), options);
  const matchedOccurrenceGroups = new Set();
  return entries.map((entry) => ({
    ...lightweightSongGroupForEntry(entry, occurrenceGroups, matchedOccurrenceGroups),
    count: entry.count,
    _record: record,
  }));
}

function lightweightSongGroupForEntry(entry, occurrenceGroups, matchedOccurrenceGroups) {
  const matched = uniqueOccurrenceGroupForSongEntry(entry, occurrenceGroups, matchedOccurrenceGroups);
  if (!matched) {
    return {
      key: songWorkKeyForTitle(entry.name) || entry.key || normalizeEntityKey(entry.name),
      title: entry.name,
      canonicalWorkTitleKey: songWorkKeyForTitle(entry.name),
      isNiche: false,
      occurrences: null,
      videoCount: 0,
    };
  }
  matchedOccurrenceGroups.add(matched);
  return {
    key: matched.key,
    title: matched.title || entry.name,
    canonicalWorkTitleKey: matched.canonicalWorkTitleKey || songWorkKeyForTitle(matched.title || entry.name),
    titleKey: matched.titleKey,
    artistIdentityKey: matched.artistIdentityKey,
    songIdentityKey: matched.songIdentityKey,
    displayArtist: matched.displayArtist,
    isNiche: matched.isNiche,
    occurrences: matched.occurrences,
    videoCount: matched.videoCount || uniqueVideoCount(matched.occurrences || []),
  };
}

function uniqueOccurrenceGroupForSongEntry(entry, occurrenceGroups, matchedOccurrenceGroups) {
  const entryKeys = songMatchKeys(entry.key, entry.name);
  if (!entryKeys.size) return null;
  const matches = [];
  for (const group of occurrenceGroups || []) {
    if (matchedOccurrenceGroups?.has(group)) continue;
    if (setsIntersect(entryKeys, songKeysForGroup(group))) matches.push(group);
  }
  return matches.length === 1 ? matches[0] : null;
}

function songKeysForGroup(group) {
  return songMatchKeys(group?.canonicalWorkTitleKey, group?.titleKey, group?.songKey, group?.title);
}

function sourceSongKeyForGroup(group) {
  return (
    cleanText(group?.canonicalWorkTitleKey) ||
    cleanText(group?.titleKey) ||
    cleanText(group?.songKey) ||
    songWorkKeyForTitle(group?.title) ||
    normalizeEntityKey(group?.title)
  );
}

function songWorkKeyForTitle(title) {
  return window.RankingUtils?.songWorkTitleKey?.(title) || "";
}

function setsIntersect(left, right) {
  for (const value of left || []) {
    if (right?.has(value)) return true;
  }
  return false;
}

function filterDisplaySongOccurrences(occurrences) {
  return (occurrences || []).filter((occurrence) => shouldShowSongGroupTitle(occurrence?.song?.title));
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

async function copyVideoSetlist(item, options = {}) {
  const fullItem = await resolveFullVideoSetlistItem(item, options);
  const text = buildSetlistLinkText(fullItem, {
    isUnknownArtistName: window.RankingUtils.isUnknownArtistName,
  });
  if (!text) {
    showToast("这场视频没有可复制的歌单");
    return;
  }
  await writeClipboardText(text);
  const count = Math.max(0, text.split("\n").filter(Boolean).length - (cleanText(fullItem?.videoId) ? 1 : 0));
  if (fullItem._setlistResolution === "visible") {
    showToast(`已复制可见同场歌单 · ${count}首（来源详情不足）`);
    return;
  }
  showToast(`已复制整场歌单 · ${count}首`);
}

function buildSetlistLinkText(item, options = {}) {
  const songs = window.FrontendUtils.normalizeSetlistSongs(item?._allSongs || item?.songs || [], options);
  const videoId = cleanText(item?.videoId);
  const videoUrl = videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : "";
  const rows = songs
    .map((song, index) => {
      const ordinal = String(index + 1).padStart(2, "0");
      const base = `${window.FrontendUtils.formatSetlistTime(song.seconds)} ${ordinal}. ${song.title}`;
      return song.artist ? `${base} - ${song.artist}` : base;
    });
  return [videoUrl, ...rows].filter(Boolean).join("\n");
}

async function resolveFullVideoSetlistItem(item, options = {}) {
  const videoId = cleanText(item?.videoId);
  let best = resolveVisibleVideoSetlistItem(item, videoId, options);
  if (videoId && state.runtimeApi.available) {
    try {
      const request = {
        view: "videos",
        rankMetric: "occurrences",
        page: 1,
        pageSize: 5,
        filters: {
          q: videoId,
          searchScope: "all",
          searchFields: ["video"],
          minCount: 1,
          trend: "all",
        },
        signal: null,
      };
      const result = await requestApiViewPage(request, canonicalRangeId(state.range));
      const match = (result.records || []).find((record) => cleanText(record.videoId) === videoId);
      const matchSongs = Array.isArray(match?._allSongs) ? match._allSongs : match?.songs;
      if (match && Array.isArray(matchSongs) && matchSongs.length > setlistSongCount(best)) {
        best = { ...best, ...match, songs: matchSongs, _allSongs: matchSongs, _setlistResolution: "api" };
      }
    } catch (error) {
      console.warn("full video setlist lookup failed", error);
    }
  }
  return best;
}

function resolveVisibleVideoSetlistItem(item = {}, videoId = cleanText(item?.videoId), options = {}) {
  if (!videoId) return item || {};
  const known = findVideoItemById(videoId) || {};
  const sourceOccurrences = options.button?._sourceOccurrences || item?._sourceOccurrences || [];
  const songs = collectKnownVideoSetlistSongs(videoId, [item, known], sourceOccurrences);
  if (!songs.length) return item || {};
  const baseCount = setlistSongCount(item);
  return {
    ...known,
    ...item,
    videoId,
    songs,
    _allSongs: songs,
    _setlistResolution: songs.length > baseCount ? "visible" : item?._setlistResolution || "",
  };
}

function collectKnownVideoSetlistSongs(videoId, items = [], occurrences = []) {
  const songs = [];
  const addSong = (song) => {
    if (song) songs.push(song);
  };
  const addItem = (item) => {
    for (const song of item?._allSongs || item?.songs || []) addSong(song);
  };
  const addOccurrence = (occurrence) => {
    if (cleanText(occurrence?.item?.videoId || occurrence?.videoId) === videoId) addSong(occurrence?.song);
  };
  for (const item of items) addItem(item);
  for (const occurrence of occurrences || []) addOccurrence(occurrence);
  collectKnownVideoSetlistSongsFromPayload(videoId, addItem, addOccurrence);
  collectKnownVideoSetlistSongsFromDom(videoId, addOccurrence);
  collectKnownVideoSetlistSongsFromCache(videoId, addOccurrence);
  collectKnownVideoSetlistSongsFromRequestCache(videoId, addItem, addOccurrence);
  return window.FrontendUtils.normalizeSetlistSongs(songs, {
    isUnknownArtistName: window.RankingUtils.isUnknownArtistName,
  });
}

function collectKnownVideoSetlistSongsFromPayload(videoId, addItem, addOccurrence) {
  const stack = Array.isArray(state.payload?.items) ? [...state.payload.items] : [];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    if (cleanText(item.videoId) === videoId) addItem(item);
    if (Array.isArray(item.occurrences)) {
      for (const occurrence of item.occurrences) addOccurrence(occurrence);
    }
    for (const key of ["items", "videos", "sources", "records"]) {
      if (Array.isArray(item[key])) stack.push(...item[key]);
    }
  }
}

function collectKnownVideoSetlistSongsFromDom(videoId, addOccurrence) {
  if (!els.content) return;
  const containers = els.content.querySelectorAll(".rank-row, .index-row, .source-drawer, .artist-song-sources");
  for (const container of containers) {
    for (const key of ["_sourceDetailOccurrences", "_sourceOccurrences", "_songSourceOccurrences"]) {
      for (const occurrence of container[key] || []) addOccurrence(occurrence);
    }
  }
}

function collectKnownVideoSetlistSongsFromCache(videoId, addOccurrence) {
  for (const value of state.sourceDetailCache.values()) {
    if (Array.isArray(value)) {
      for (const occurrence of value) addOccurrence(occurrence);
    } else if (Array.isArray(value?.completeOccurrences)) {
      for (const occurrence of value.completeOccurrences) addOccurrence(occurrence);
    } else if (Array.isArray(value?.occurrences)) {
      for (const occurrence of value.occurrences) addOccurrence(occurrence);
    }
  }
}

function collectKnownVideoSetlistSongsFromRequestCache(videoId, addItem, addOccurrence) {
  for (const result of state.requestRuntime.pageResultCache.values()) {
    for (const record of result?.records || []) {
      if (cleanText(record?.videoId) === videoId) addItem(record);
      if (Array.isArray(record?.occurrences)) {
        for (const occurrence of record.occurrences) addOccurrence(occurrence);
      }
    }
  }
}

function setlistSongCount(item) {
  const songs = Array.isArray(item?._allSongs) ? item._allSongs : item?.songs;
  return Array.isArray(songs) ? songs.length : 0;
}

async function copySongSourceLinks(occurrences, options = {}) {
  const text = window.FrontendUtils.buildSongSourceLinksText(occurrences, {
    urlsOnly: Boolean(options.urlsOnly),
  });
  if (!text) {
    showToast("当前歌曲没有可复制的来源链接");
    return;
  }
  await writeClipboardText(text);
  const count = text.split("\n").filter(Boolean).length;
  showToast(`已复制 ${count} 个来源链接`);
}

async function copySongSourceLinksFromButton(button) {
  if (button.getAttribute("aria-busy") === "true") return;
  button.setAttribute("aria-busy", "true");
  try {
    const container = songSourceContainerForCopyButton(button);
    let occurrences =
      button._sourceOccurrences ||
      container?._sourceDetailOccurrences ||
      container?._sourceOccurrences ||
      container?._songSourceOccurrences ||
      [];
    if (container) {
      occurrences = await sourceDetailOccurrencesForContainer(container, occurrences);
      const songKey = cleanText(container._sourceSongKey);
      const songTitle = cleanText(container._sourceSongTitle);
      if (songKey || songTitle) {
        occurrences = filterOccurrencesForSongKey(occurrences, songKey, songTitle);
      }
    }
    button._sourceOccurrences = occurrences || [];
    await copySongSourceLinks(button._sourceOccurrences, {
      urlsOnly: button.dataset.copyUrlsOnly === "true",
    });
  } finally {
    button.removeAttribute("aria-busy");
  }
}

function songSourceContainerForCopyButton(button) {
  const group = button.closest(".artist-song-group");
  return (
    group?._artistSongSources ||
    group?.querySelector(".artist-song-sources") ||
    button.closest(".artist-song-sources") ||
    button.closest(".rank-row, .index-row")
  );
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
  const h7 = rangeItemCount(counts, "7d");
  const month = rangeItemCount(counts, "all");
  return `${time} · 7天 ${h7} · 本月 ${month}`;
}

function rangeItemCount(counts, rangeId) {
  for (const id of runtimeRangeIdCandidates(rangeId)) {
    const value = Number(counts?.[id]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
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
  const videoId = cleanText(item.videoId);
  const relayQuality = options.preferCompact ? "mqdefault" : "hqdefault";
  const sameOrigin = sameOriginThumbnailUrl(videoId, relayQuality);
  const compactRelay = sameOriginThumbnailUrl(videoId, "mqdefault");
  const encodedVideoId = videoId ? encodeURIComponent(videoId) : "";
  const mqdefault = encodedVideoId ? `https://i.ytimg.com/vi/${encodedVideoId}/mqdefault.jpg` : "";
  const hqdefault = encodedVideoId ? `https://i.ytimg.com/vi/${encodedVideoId}/hqdefault.jpg` : "";
  const explicit = [
    item.thumbnailUrl,
    item.videoThumbnailUrl,
    item.videoThumbnail,
    item.displayThumbnailUrl,
    item.thumbnail,
    item.source?.thumbnailUrl,
    item.source?.videoThumbnailUrl,
    item.source?.thumbnail,
  ];
  const preferred = options.preferCompact
    ? [sameOrigin, compactRelay, ...explicit, hqdefault, mqdefault]
    : [sameOrigin, compactRelay, ...explicit, hqdefault, mqdefault];
  return uniqueStrings(preferred.map(cleanText));
}

function sameOriginThumbnailUrl(videoId, quality = "hqdefault") {
  const safeVideoId = cleanText(videoId);
  const safeQuality = cleanText(quality);
  if (!/^[A-Za-z0-9_-]{11}$/u.test(safeVideoId)
    || !["mqdefault", "hqdefault"].includes(safeQuality)) return "";
  return "/api/thumbnails/" + safeVideoId + "/" + safeQuality + ".jpg";
}

function createThumbnailImage(item, className, optionsOrWidth = {}, height = 90) {
  const options = typeof optionsOrWidth === "object" && optionsOrWidth !== null ? optionsOrWidth : {};
  const width = typeof optionsOrWidth === "number" ? optionsOrWidth : options.width || 160;
  const resolvedHeight = typeof optionsOrWidth === "number" ? height : options.height || 90;
  const img = document.createElement("img");
  img.className = className;
  img.alt = "";
  const highPriority = options.priority === "high";
  img.loading = highPriority ? "eager" : "lazy";
  img.decoding = "async";
  img.fetchPriority = highPriority ? "high" : "low";
  img.width = width;
  img.height = resolvedHeight;
  const thumbnailCandidates = videoThumbnailCandidates(item || {}, options);
  let thumbnailIndex = 0;
  if (!thumbnailCandidates.length) {
    img.hidden = true;
    img.dataset.thumbnailMissing = "true";
    return img;
  }
  img.src = thumbnailCandidates[thumbnailIndex];
  img.addEventListener("error", () => {
    thumbnailIndex += 1;
    if (thumbnailIndex < thumbnailCandidates.length) {
      img.src = thumbnailCandidates[thumbnailIndex];
      return;
    }
    img.hidden = true;
    img.dataset.thumbnailMissing = "true";
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

function formatCalendarDate(value) {
  const parts = dateParts(value);
  if (!parts) return "";
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatTime(value) {
  const parts = dateParts(value);
  if (!parts) return value ? String(value) : "未知";
  return `${parts.hour}:${parts.minute}`;
}

function formatUpdatedAt(value) {
  const parts = dateParts(value);
  if (!parts) return value ? String(value) : "未知";
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function dateParts(value) {
  if (!value) return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric < 100000000000 ? numeric * 1000 : numeric)
    : new Date(value);
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
