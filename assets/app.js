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
const SONG_SEARCH_INDEX_PATH = "data/song-search-known-songs.json";
const SNAPSHOT_CACHE_LIMIT = 5;
const SEARCH_DEBOUNCE_MS = 140;
const INLINE_SOURCE_PREVIEW_LIMIT = 1;
const ARTIST_SONG_GROUP_INITIAL_LIMIT = 8;
const ARTIST_SOURCE_INITIAL_LIMIT = 3;
const LIST_PAGE_SIZE_KEY = "dailySongList.pageSize";
const LIST_PAGE_SIZE_OPTIONS = [50, 100];
const DEFAULT_LIST_PAGE_SIZE = 50;
const VIDEO_PAGE_SIZE = 24;
const CURRENT_FILTER_VERSION = 3;
const RANK_METRICS = {
  occurrences: "收录次数",
  videos: "不同视频数",
};
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
  rangeCache: new Map(),
  latestRangeLoadError: null,
  songSearchIndexPromise: null,
  songSearchLookup: window.FrontendUtils.createSongSearchLookup(null),
  rankDiffs: {},
  rankDiffLoads: new Map(),
  loadedResources: [],
  firstContentMeasured: false,
  eventsBound: false,
};

const els = {
  controls: document.querySelector("#controls"),
  status: document.querySelector("#status"),
  summary: document.querySelector("#summary"),
  content: document.querySelector("#videoList"),
  snapshotSelect: document.querySelector("#snapshotSelect"),
  snapshotDateSelect: document.querySelector("#snapshotDateSelect"),
  filterInput: document.querySelector("#filterInput"),
  nicheOnlyToggle: document.querySelector("#nicheOnlyToggle"),
  hideUnknownToggle: document.querySelector("#hideUnknownToggle"),
  backToTop: document.querySelector("#backToTop"),
  toast: document.querySelector("#toast"),
  rangeTabs: Array.from(document.querySelectorAll("[data-range]")),
  viewTabs: Array.from(document.querySelectorAll("[data-view]")),
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
  if (typeof console?.table === "function") {
    console.table(measures);
    console.table(resources);
  }
  return { measures, resources };
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
  const [meta, snapshotIndex, rangePayload] = await Promise.all([
    measureAsync("fetch-meta", () => readJson(UI_META_PATH, { cache: "no-cache" })),
    readJson("data/snapshots/index.json").catch(() => ({ snapshots: [] })),
    measureAsync("fetch-active-range", () => loadRuntimeRange(initialRange)),
  ]);
  state.runtimeMeta = meta;
  state.status = meta.status || null;
  state.snapshots = Array.isArray(snapshotIndex.snapshots) ? snapshotIndex.snapshots : [];
  renderSnapshotOptions();
  applyInitialUrlState();
  syncControlsFromState();
  const requestedSnapshotPath = state.currentSnapshotPath;
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
    syncUrlState();
    scheduleCurrentRankDiffLoad();
    scheduleOtherRangePrefetch();
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
      if (state.view === tab.dataset.view) return;
      state.view = tab.dataset.view;
      state.expandedRows.clear();
      resetPagination();
      setActiveTab(els.viewTabs, tab);
      renderOrSyncUrl({ urlMode: "push" });
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

  els.nicheOnlyToggle?.addEventListener("change", () => {
    state.nicheOnly = Boolean(els.nicheOnlyToggle.checked);
    state.expandedRows.clear();
    resetPagination();
    renderOrSyncUrl({ urlMode: "push" });
  });

  els.hideUnknownToggle?.addEventListener("change", () => {
    state.hideUnknownArtist = Boolean(els.hideUnknownToggle.checked);
    state.expandedRows.clear();
    resetPagination();
    renderOrSyncUrl({ urlMode: "push" });
  });

  els.summary?.addEventListener("click", async (event) => {
    const copy = event.target.closest("[data-copy-link]");
    if (copy) {
      await copyCurrentLink();
      return;
    }

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
        writeStoredPageSize(state.pageSize);
        state.expandedRows.clear();
        resetPagination();
        render({ focusAfterPageChange: true, urlMode: "push" });
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

    const artistSources = event.target.closest("[data-toggle-artist-sources]");
    if (artistSources) {
      event.preventDefault();
      expandArtistSongSources(artistSources);
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

  window.addEventListener("popstate", () => {
    restoreStateFromUrl();
  });
}

function setActiveTab(tabs, activeTab) {
  for (const item of tabs) {
    item.classList.toggle("active", item === activeTab);
    item.setAttribute("aria-pressed", item === activeTab ? "true" : "false");
  }
}

function applyInitialUrlState() {
  const defaults = {
    ...defaultUrlState(),
    pageSize: readStoredPageSize(),
  };
  const parsed = window.FrontendUtils.parseUrlState(window.location.search, {
    defaults,
    validRanges: Object.keys(RANGE_LABELS),
    validViews: Object.keys(VIEWS),
    validPageSizes: LIST_PAGE_SIZE_OPTIONS,
    validRankMetrics: Object.keys(RANK_METRICS),
    validVideoLayouts: Object.keys(VIDEO_LAYOUTS),
    latestSnapshotPath: SNAPSHOT_LATEST_PATH,
    snapshots: state.snapshots,
  });

  state.range = parsed.range;
  state.view = parsed.view;
  state.page = parsed.page;
  state.pageSize = parsed.pageSize;
  state.indexBucket = parsed.bucket;
  state.rankMetric = parsed.rankMetric;
  state.videoLayout = parsed.videoLayout;
  state.nicheOnly = parsed.outside;
  state.hideUnknownArtist = !parsed.showUnknown;
  state.filter = parsed.q;
  state.currentSnapshotPath = parsed.snapshotPath;
  writeStoredPageSize(state.pageSize);
}

function syncControlsFromState() {
  setActiveTab(els.rangeTabs, els.rangeTabs.find((tab) => tab.dataset.range === state.range) || els.rangeTabs[0]);
  setActiveTab(els.viewTabs, els.viewTabs.find((tab) => tab.dataset.view === state.view) || els.viewTabs[0]);
  if (els.filterInput) els.filterInput.value = state.filter;
  if (els.nicheOnlyToggle) els.nicheOnlyToggle.checked = state.nicheOnly;
  if (els.hideUnknownToggle) els.hideUnknownToggle.checked = state.hideUnknownArtist;
  syncSnapshotControlsFromState();
}

function syncUrlState(mode = "replace") {
  if (!window.history?.replaceState) return;
  const query = window.FrontendUtils.serializeUrlState(
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
    },
    {
      defaults: defaultUrlState(),
      latestSnapshotPath: SNAPSHOT_LATEST_PATH,
      snapshots: state.snapshots,
    },
  );
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash || ""}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash || ""}`;
  if (nextUrl === currentUrl) return;
  const method = mode === "push" && window.history.pushState ? "pushState" : "replaceState";
  window.history[method]({ dailySongList: true }, "", nextUrl);
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
    videoLayout: "cards",
    outside: false,
    showUnknown: false,
    q: "",
  };
}

async function restoreStateFromUrl() {
  const previousPath = state.currentSnapshotPath;
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

function readStoredPageSize() {
  try {
    const value = Number.parseInt(window.localStorage?.getItem(LIST_PAGE_SIZE_KEY) || "", 10);
    return LIST_PAGE_SIZE_OPTIONS.includes(value) ? value : DEFAULT_LIST_PAGE_SIZE;
  } catch {
    return DEFAULT_LIST_PAGE_SIZE;
  }
}

function writeStoredPageSize(pageSize) {
  if (!LIST_PAGE_SIZE_OPTIONS.includes(pageSize)) return;
  try {
    window.localStorage?.setItem(LIST_PAGE_SIZE_KEY, String(pageSize));
  } catch {
    // localStorage can be unavailable in restricted browser modes.
  }
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
  const path = runtimeRangePath(rangeId);
  const promise = readJson(path, { cache: "default" })
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
  return window.FrontendUtils.runtimeRangePath(rangeId, state.runtimeMeta);
}

async function applyRuntimeRangePayload(rangePayload, options = {}) {
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
    status: meta?.status || null,
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
    state.songSearchIndexPromise = readJson(SONG_SEARCH_INDEX_PATH, { cache: "default" })
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
  if (!isLatestSnapshot()) {
    els.status.textContent = "正在查看历史快照";
    return;
  }
  if (!status) {
    els.status.textContent = "状态不可用";
    return;
  }
  const at = formatDate(status.rebuiltDerivedAt || status.completedAt || status.generatedAt || status.attemptedAt);
  els.status.textContent = status.status === "success" ? `更新于 ${at}` : `正在使用上次成功数据 · ${at}`;
}

function render(options = {}) {
  const renderMark = perfMark("render-dom:start");
  const group = currentGroup();
  const rangeCache = getRangeCache(group);
  const selection = currentSelection(rangeCache);
  if (state.view !== "songAz") ensureIndexBucketExists(selection.songRecords);

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
  const allSongRecords = measureSync("build-song-records", () => buildSongRecords(occurrences));
  await yieldToBrowser();
  const nicheSongRecords = buildSongRecords(nicheOccurrences);
  const visibleSongRecords = buildSongRecords(visibleOccurrences);
  const visibleNicheSongRecords = buildSongRecords(visibleNicheOccurrences);
  await yieldToBrowser();
  const allArtistResult = measureSync("build-artist-records", () => buildArtistRecords(occurrences));
  await yieldToBrowser();
  const nicheArtistResult = buildArtistRecords(nicheOccurrences);
  const cache = createRangeCacheObject({
    items,
    occurrences,
    nicheOccurrences,
    visibleOccurrences,
    visibleNicheOccurrences,
    allSongRecords,
    nicheSongRecords,
    visibleSongRecords,
    visibleNicheSongRecords,
    allArtistResult,
    nicheArtistResult,
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
  const artistRecords = state.nicheOnly ? cache.nicheArtistRecords : cache.allArtistRecords;
  if (state.view === "artistRank") {
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
  const allSongRecords = measureSync("build-song-records", () => buildSongRecords(occurrences));
  const nicheSongRecords = buildSongRecords(nicheOccurrences);
  const visibleSongRecords = buildSongRecords(visibleOccurrences);
  const visibleNicheSongRecords = buildSongRecords(visibleNicheOccurrences);
  const allArtistResult = measureSync("build-artist-records", () => buildArtistRecords(occurrences));
  const nicheArtistResult = buildArtistRecords(nicheOccurrences);
  return createRangeCacheObject({
    items,
    occurrences,
    nicheOccurrences,
    visibleOccurrences,
    visibleNicheOccurrences,
    allSongRecords,
    nicheSongRecords,
    visibleSongRecords,
    visibleNicheSongRecords,
    allArtistResult,
    nicheArtistResult,
  });
}

function createRangeCacheObject({
  items,
  occurrences,
  nicheOccurrences,
  visibleOccurrences,
  visibleNicheOccurrences,
  allSongRecords,
  nicheSongRecords,
  visibleSongRecords,
  visibleNicheSongRecords,
  allArtistResult,
  nicheArtistResult,
}) {
  return {
    items,
    occurrences,
    nicheOccurrences,
    visibleOccurrences,
    visibleNicheOccurrences,
    allSongRecords,
    nicheSongRecords,
    visibleSongRecords,
    visibleNicheSongRecords,
    allArtistRecords: allArtistResult.records,
    nicheArtistRecords: nicheArtistResult.records,
    allMissingArtistCount: allArtistResult.missingArtistCount,
    nicheMissingArtistCount: nicheArtistResult.missingArtistCount,
    allVideoCount: uniqueVideoCount(occurrences),
    nicheVideoCount: uniqueVideoCount(nicheOccurrences),
    visibleVideoCount: uniqueVideoCount(visibleOccurrences),
    visibleNicheVideoCount: uniqueVideoCount(visibleNicheOccurrences),
    normalizedVideoSearchData: items.map((item) => ({
      item,
      searchText: normalizeSearch([item.title, item.channelName, item.keyword, ...(item.songs || []).flatMap((song) => [song.title, song.artist])].join(" ")),
    })),
    sortedRecords: new Map(),
    selectionCache: new Map(),
  };
}

function currentSelection(rangeCache) {
  const filterKey = normalizeSearch(state.filter);
  const hideUnknownForView = shouldHideUnknownForCurrentView();
  const key = `${state.nicheOnly ? "niche" : "all"}::${hideUnknownForView ? "hide-unknown" : "show-unknown"}::${filterKey}`;
  if (rangeCache.selectionCache.has(key)) return rangeCache.selectionCache.get(key);

  const baseOccurrences = selectedOccurrences(rangeCache, { hideUnknownForView });
  const baseSongRecords = selectedSongRecords(rangeCache, { hideUnknownForView });
  const baseArtistRecords = state.nicheOnly ? rangeCache.nicheArtistRecords : rangeCache.allArtistRecords;
  const baseMissingArtistCount = state.nicheOnly ? rangeCache.nicheMissingArtistCount : rangeCache.allMissingArtistCount;
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
  ], hiddenUnknownNote(selection));

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
  const { records, ranks, countFrequencies } = rankingModelForSelection(rangeCache, selection, "song-rank", compareSongRank);

  renderSummary(group, [
    visibilityMetric(records.length, allRecords.length, nicheRecords.length, "首歌曲", "首小众歌曲"),
    occurrenceVisibilityMetric(occurrences.length, sourceVisibleOccurrences.length, hideUnknownForView ? rangeCache.visibleNicheOccurrences.length : rangeCache.nicheOccurrences.length),
    metric(selection.videoCount, "个视频"),
  ], hiddenUnknownNote(selection));

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
  const { records, ranks, countFrequencies } = rankingModelForSelection(rangeCache, selection, "artist-rank", compareRankRecords);
  const missingArtistCount = selection.missingArtistCount;

  renderSummary(group, [
    visibilityMetric(records.length, allArtistRecords.length, nicheArtistRecords.length, "位歌手", "位小众歌曲歌手"),
    occurrenceVisibilityMetric(occurrences.length, sourceOccurrences.length, rangeCache.nicheOccurrences.length),
    metric(selection.videoCount, "个视频"),
  ], missingArtistCount ? `${missingArtistCount} 条待补歌手` : "");

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
  const records = sortedSelectionRecords(rangeCache, selection, "song-az", compareSongAz);

  renderSummary(group, [
    visibilityMetric(records.length, allRecords.length, nicheRecords.length, "首歌曲", "首小众歌曲"),
    occurrenceVisibilityMetric(occurrences.length, sourceVisibleOccurrences.length, hideUnknownForView ? rangeCache.visibleNicheOccurrences.length : rangeCache.nicheOccurrences.length),
    metric(selection.videoCount, "个视频"),
  ], hiddenUnknownNote(selection));

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

  const title = document.createElement("strong");
  title.className = "summary-title";
  title.textContent = VIEWS[state.view] || state.view;
  els.summary.append(title);

  const range = document.createElement("span");
  range.className = "summary-chip summary-range";
  range.textContent = RANGE_LABELS[state.range] || group.title || state.range;
  els.summary.append(range);

  if (state.nicheOnly) {
    const niche = document.createElement("span");
    niche.className = "summary-chip niche-summary";
    niche.textContent = "小众歌曲";
    els.summary.append(niche);
  }

  for (const item of metrics.filter(Boolean)) {
    const chip = document.createElement("span");
    chip.className = "summary-chip";
    chip.textContent = item;
    els.summary.append(chip);
  }

  if (!isLatestSnapshot()) {
    const history = document.createElement("span");
    history.className = "summary-chip history-chip";
    history.textContent = `历史快照 · ${capturedDate()}`;
    els.summary.append(history);
  }

  if (note) {
    const noteNode = document.createElement("span");
    noteNode.className = "summary-note";
    noteNode.textContent = note;
    els.summary.append(noteNode);
  }

  els.summary.append(renderSummaryActions());
}

function hiddenUnknownNote(selection) {
  const count = Number(selection?.hiddenUnknownCount) || 0;
  return state.hideUnknownArtist && count > 0 ? `已隐藏 ${count} 条无歌手收录` : "";
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

  const copy = document.createElement("button");
  copy.className = "summary-action copy-link";
  copy.type = "button";
  copy.dataset.copyLink = "true";
  copy.textContent = "复制链接";
  actions.append(copy);
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
  note.textContent = `第 ${pageInfo.page} / ${pageInfo.pageCount} 页 · ${pageInfo.startIndex + 1}-${pageInfo.endIndex} / ${pageInfo.total} ${unit}`;
  footer.append(note);

  if (showPageSizeControl) {
    footer.append(renderPageSizeControl());
  }

  const controls = document.createElement("div");
  controls.className = "pagination-controls";

  if (variant === "top") {
    if (!showPageControls) return footer;
    controls.append(
      renderPageButton("上一页", pageInfo.page - 1, pageInfo.page === 1),
      renderPageStatus(pageInfo),
      renderPageButton("下一页", pageInfo.page + 1, pageInfo.page === pageInfo.pageCount),
    );
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
    footer.append(controls);
  }

  return footer;
}

function shouldShowPageSizeControl(pageInfo) {
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

function renderPageButton(label, page, disabled, isCurrent = false) {
  const button = document.createElement("button");
  button.className = isCurrent ? "pagination-button is-current" : "pagination-button";
  button.type = "button";
  button.dataset.page = String(page);
  button.disabled = disabled;
  if (isCurrent) button.setAttribute("aria-current", "page");
  button.textContent = label;
  return button;
}

function renderPageStatus(pageInfo) {
  const status = document.createElement("span");
  status.className = "pagination-status";
  status.textContent = `第 ${pageInfo.page} / ${pageInfo.pageCount} 页`;
  return status;
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
    if (!normalizedFilter) {
      result.push({ ...item, songs: sourceSongs, _displaySongs: sourceSongs, _songSearchMatchCount: 0 });
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
  const expandable = mode === "artist" ? artistSongCount > 1 || occurrences.length > 1 : occurrences.length > 1;
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
  row.append(renderCount(count, countUnit));
  if (expandable) row.append(renderSourceDrawer({ mode, occurrences, songGroups, drawerId, isExpanded, getSongGroups }));

  return row;
}

function renderIndexRecord(record) {
  const row = document.createElement("article");
  const rowKey = makeDomId(`index-${record.key}`);
  const drawerId = `source-drawer-${rowKey}`;
  const expandable = record.occurrences.length > 1;
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
  if (mode === "artist") {
    appendArtistSubline(subline, { occurrences, songCount, songPreview, drawerId, isExpanded, videoCount });
  } else {
    appendSublinePart(subline, meta.primary, meta.missingPrimary ? "artist-missing" : "subline-primary");
    appendSublinePart(subline, `${videoCount} 个视频`, "subline-video-count");
    appendSublineSource(subline, { mode, occurrences, drawerId, isExpanded });
  }
  if (trend) appendSublineNode(subline, renderTrendBadge(trend));
  content.append(subline);

  return content;
}

function appendArtistSubline(container, { occurrences, songCount, songPreview, drawerId, isExpanded, videoCount }) {
  appendSublinePart(container, `${songCount}首歌曲`, "subline-song-count");
  appendSublinePart(container, (songPreview || []).slice(0, 2).join("、"), "subline-primary artist-song-preview");
  if (songCount === 1 && occurrences.length === 1) {
    appendSublineNode(container, renderInlineSource(occurrences[0]));
  }
  appendSublinePart(container, `${videoCount} 个视频`, "subline-video-count");

  if (songCount > 1 || occurrences.length > 1) {
    const button = renderSourceToggleButton({ mode: "artist", drawerId, isExpanded, songCount });
    appendSublineNode(container, button);
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
  node.textContent = `${count}${unit}`;
  return node;
}

function appendSublineSource(container, { mode, occurrences, drawerId, isExpanded }) {
  if (!occurrences.length) {
    appendSublinePart(container, "无来源");
    return;
  }
  if (occurrences.length === 1) {
    appendSublineNode(container, renderInlineSource(occurrences[0]));
    return;
  }

  const sourcePreview = window.FrontendUtils.buildSourcePreview(occurrences, {
    limit: INLINE_SOURCE_PREVIEW_LIMIT,
  });
  appendSublineNode(container, renderSourcePreviewLinks(sourcePreview.preview));

  const button = renderSourceToggleButton({
    mode,
    drawerId,
    isExpanded,
    hiddenCount: sourcePreview.hiddenCount,
    total: sourcePreview.total,
  });
  appendSublineNode(container, button);
}

function renderSourceToggleButton({ mode, drawerId, isExpanded, hiddenCount = 0, total = 0, songCount = 0 }) {
  const model = window.FrontendUtils.rankToggleModel({ mode, isExpanded, hiddenCount, total, songCount });
  const button = document.createElement("button");
  button.className = "rank-expand";
  button.type = "button";
  button.dataset.toggleSource = "true";
  button.dataset.sourceMode = mode;
  button.dataset.sourceTotal = String(total);
  button.dataset.sourceHiddenCount = String(hiddenCount);
  button.dataset.songCount = String(songCount);
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
  appendSourceDrawerLinks(drawer, occurrences);
}

function appendSourceDrawerLinks(drawer, occurrences) {
  for (const occurrence of occurrences) {
    const link = document.createElement("a");
    link.className = "source-link";
    link.href = youtubeTimeUrl(occurrence.item.videoId, occurrence.song.seconds);
    link.target = "_blank";
    link.rel = "noreferrer";

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = occurrence.song.time || formatSeconds(occurrence.song.seconds);

    const source = document.createElement("span");
    source.className = "source-name";
    source.textContent = occurrence.item.channelName || occurrence.item.title || occurrence.item.videoId;

    const video = document.createElement("span");
    video.className = "source-video";
    video.textContent = occurrence.item.title || occurrence.item.videoId;

    link.append(time, source, video);
    drawer.append(link);
  }
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
    const visibleOccurrences = group.occurrences.slice(0, ARTIST_SOURCE_INITIAL_LIMIT);
    appendSourceDrawerLinks(sources, visibleOccurrences);
    if (group.occurrences.length > visibleOccurrences.length) {
      const sourceMore = document.createElement("button");
      sourceMore.className = "artist-source-more";
      sourceMore.type = "button";
      sourceMore.dataset.toggleArtistSources = "true";
      sourceMore._remainingOccurrences = group.occurrences.slice(visibleOccurrences.length);
      sourceMore.textContent = `显示其余 ${group.occurrences.length - visibleOccurrences.length} 个来源`;
      sources.append(sourceMore);
    }
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
}

function toggleSourceDrawer(row) {
  if (!row) return;
  const drawer = row.querySelector(".source-drawer");
  const buttons = Array.from(row.querySelectorAll("[data-toggle-source]"));
  if (!drawer || !buttons.length) return;

  const nextExpanded = drawer.hidden;
  if (nextExpanded && drawer.dataset.sourceDeferred === "true") {
    const mode = row.dataset.drawerMode || drawer.dataset.sourceMode || "song";
    const songGroups =
      mode === "artist" ? row._artistSongGroups || row._getArtistSongGroups?.() || [] : row._artistSongGroups || [];
    if (mode === "artist") row._artistSongGroups = songGroups;
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
    const mode = button.dataset.sourceMode || row.dataset.drawerMode || "song";
    const model = window.FrontendUtils.rankToggleModel({ mode, isExpanded: nextExpanded, total, hiddenCount, songCount });
    button.setAttribute("aria-label", model.ariaLabel);
    button.textContent = model.text;
  }

  if (nextExpanded) {
    state.expandedRows.add(row.dataset.rowKey);
  } else {
    state.expandedRows.delete(row.dataset.rowKey);
  }
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

function expandArtistSongSources(button) {
  const sources = button.closest(".artist-song-sources");
  const occurrences = button._remainingOccurrences || [];
  if (!sources || !occurrences.length) return;
  button.remove();
  appendSourceDrawerLinks(sources, occurrences);
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
  heading.append(count);
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
  if (path === UI_META_PATH || path === SNAPSHOT_LATEST_PATH || path === "data/status.json" || path === "data/snapshots/index.json") return "no-cache";
  if (/^data\/ui\/(?:72h|1m)\.json$/u.test(path)) return "default";
  if (/^data\/diff\/latest-(?:72h|1m)\.json$/u.test(path)) return "no-cache";
  if (path === SONG_SEARCH_INDEX_PATH) return "default";
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
  const badge = document.createElement("span");
  badge.className = "trend-badge";
  if (trend.isNew) {
    badge.classList.add("trend-new");
    badge.textContent = "NEW";
    return badge;
  }

  const rankDelta = Number(trend.rankDelta) || 0;
  const countDelta = Number(trend.countDelta) || 0;
  if (rankDelta > 0) {
    badge.classList.add("trend-up");
    badge.textContent = `↑${rankDelta}`;
  } else if (rankDelta < 0) {
    badge.classList.add("trend-down");
    badge.textContent = `↓${Math.abs(rankDelta)}`;
  } else {
    badge.classList.add("trend-flat");
    badge.textContent = "→";
  }

  if (countDelta) {
    const countNode = document.createElement("span");
    countNode.className = "trend-count";
    countNode.textContent = countDelta > 0 ? `+${countDelta}` : String(countDelta);
    badge.append(countNode);
  }
  return badge;
}

async function copyCurrentLink() {
  syncUrlState("replace");
  const href = window.location.href;
  try {
    await navigator.clipboard?.writeText(href);
    showToast("已复制当前视图链接");
  } catch {
    showToast(href);
  }
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
