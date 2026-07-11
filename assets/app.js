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
const SONG_SEARCH_INDEX_PATH = "data/song-search-known-songs.json";
const SEARCH_DEBOUNCE_MS = 140;
const INLINE_SOURCE_PREVIEW_LIMIT = 1;
const LIST_PAGE_SIZE_KEY = "dailySongList.pageSize";
const LIST_PAGE_SIZE_OPTIONS = [50, 100];
const DEFAULT_LIST_PAGE_SIZE = 50;
const VIDEO_PAGE_SIZE = 24;
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
  indexBucket: INDEX_ALL_BUCKET,
  pageSize: DEFAULT_LIST_PAGE_SIZE,
  expandedRows: new Set(),
  filterTimer: null,
  page: 1,
  renderRevision: 0,
  snapshotLoader: null,
  songSearchLookup: window.FrontendUtils.createSongSearchLookup(null),
};

const els = {
  controls: document.querySelector("#controls"),
  status: document.querySelector("#status"),
  summary: document.querySelector("#summary"),
  content: document.querySelector("#videoList"),
  snapshotSelect: document.querySelector("#snapshotSelect"),
  filterInput: document.querySelector("#filterInput"),
  nicheOnlyToggle: document.querySelector("#nicheOnlyToggle"),
  backToTop: document.querySelector("#backToTop"),
  toast: document.querySelector("#toast"),
  rangeTabs: Array.from(document.querySelectorAll("[data-range]")),
  viewTabs: Array.from(document.querySelectorAll("[data-view]")),
};

init().catch((error) => {
  setSnapshotBusy(false);
  renderLoadError(error);
});

async function init() {
  setupSnapshotLoader();
  setupControlsObserver();
  setSnapshotBusy(true, "正在载入数据");
  const [latest, snapshotIndex, status, songSearchIndex] = await Promise.all([
    readJson(SNAPSHOT_LATEST_PATH),
    readJson("data/snapshots/index.json").catch(() => ({ snapshots: [] })),
    readJson("data/status.json").catch(() => null),
    readJson(SONG_SEARCH_INDEX_PATH).catch(() => null),
  ]);
  state.songSearchLookup = window.FrontendUtils.createSongSearchLookup(songSearchIndex);
  state.status = status || latest.status || null;
  state.snapshots = Array.isArray(snapshotIndex.snapshots) ? snapshotIndex.snapshots : [];
  renderSnapshotOptions();
  applyInitialUrlState();
  bindEvents();
  syncControlsFromState();
  setupBackToTopButton();
  const requestedSnapshotPath = state.currentSnapshotPath;
  applySnapshotPayload(latest, SNAPSHOT_LATEST_PATH, { resetPage: false, syncUrl: false });
  if (requestedSnapshotPath !== SNAPSHOT_LATEST_PATH) {
    await state.snapshotLoader.loadSnapshot({ path: requestedSnapshotPath, previousPath: SNAPSHOT_LATEST_PATH });
  } else {
    syncUrlState();
  }
}

function bindEvents() {
  for (const tab of els.rangeTabs) {
    tab.addEventListener("click", () => {
      if (state.range === tab.dataset.range) return;
      state.range = tab.dataset.range;
      state.expandedRows.clear();
      resetPagination();
      setActiveTab(els.rangeTabs, tab);
      render();
    });
  }

  for (const tab of els.viewTabs) {
    tab.addEventListener("click", () => {
      if (state.view === tab.dataset.view) return;
      state.view = tab.dataset.view;
      state.expandedRows.clear();
      resetPagination();
      setActiveTab(els.viewTabs, tab);
      render();
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
      render();
      return;
    }
    state.filterTimer = window.setTimeout(() => {
      if (renderRevision === state.renderRevision) render();
    }, SEARCH_DEBOUNCE_MS);
  });

  els.snapshotSelect.addEventListener("change", async () => {
    const path = els.snapshotSelect.value;
    resetPagination();
    await state.snapshotLoader.loadSnapshot({ path, previousPath: state.currentSnapshotPath });
  });

  els.nicheOnlyToggle?.addEventListener("change", () => {
    state.nicheOnly = Boolean(els.nicheOnlyToggle.checked);
    state.expandedRows.clear();
    resetPagination();
    render();
  });

  els.content.addEventListener("click", (event) => {
    const clear = event.target.closest("[data-clear-search]");
    if (clear) {
      els.filterInput.value = "";
      state.filter = "";
      state.expandedRows.clear();
      resetPagination();
      advanceRenderRevision();
      render();
      els.filterInput.focus();
      return;
    }

    const pageButton = event.target.closest("[data-page]");
    if (pageButton) {
      const nextPage = Number.parseInt(pageButton.dataset.page || "1", 10);
      setPage(nextPage);
      render({ focusAfterPageChange: true });
      return;
    }

    const bucketButton = event.target.closest("[data-index-bucket]");
    if (bucketButton) {
      state.indexBucket = bucketButton.dataset.indexBucket || INDEX_ALL_BUCKET;
      state.expandedRows.clear();
      resetPagination();
      render({ focusAfterPageChange: true });
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
}

function setActiveTab(tabs, activeTab) {
  for (const item of tabs) {
    item.classList.toggle("active", item === activeTab);
    item.setAttribute("aria-pressed", item === activeTab ? "true" : "false");
  }
}

function applyInitialUrlState() {
  const parsed = window.FrontendUtils.parseUrlState(window.location.search, {
    defaults: {
      range: state.range,
      view: state.view,
      page: state.page,
      pageSize: readStoredPageSize(),
      bucket: state.indexBucket,
      outside: state.nicheOnly,
      q: state.filter,
    },
    validRanges: Object.keys(RANGE_LABELS),
    validViews: Object.keys(VIEWS),
    validPageSizes: LIST_PAGE_SIZE_OPTIONS,
    latestSnapshotPath: SNAPSHOT_LATEST_PATH,
    snapshots: state.snapshots,
  });

  state.range = parsed.range;
  state.view = parsed.view;
  state.page = parsed.page;
  state.pageSize = parsed.pageSize;
  state.indexBucket = parsed.bucket;
  state.nicheOnly = parsed.outside;
  state.filter = parsed.q;
  state.currentSnapshotPath = parsed.snapshotPath;
  writeStoredPageSize(state.pageSize);
}

function syncControlsFromState() {
  setActiveTab(els.rangeTabs, els.rangeTabs.find((tab) => tab.dataset.range === state.range) || els.rangeTabs[0]);
  setActiveTab(els.viewTabs, els.viewTabs.find((tab) => tab.dataset.view === state.view) || els.viewTabs[0]);
  if (els.filterInput) els.filterInput.value = state.filter;
  if (els.nicheOnlyToggle) els.nicheOnlyToggle.checked = state.nicheOnly;
  if (els.snapshotSelect) els.snapshotSelect.value = state.currentSnapshotPath;
}

function syncUrlState() {
  if (!window.history?.replaceState) return;
  const query = window.FrontendUtils.serializeUrlState(
    {
      range: state.range,
      view: state.view,
      page: state.page,
      pageSize: state.pageSize,
      bucket: state.indexBucket,
      outside: state.nicheOnly,
      q: state.filter,
      snapshotPath: state.currentSnapshotPath,
    },
    {
      latestSnapshotPath: SNAPSHOT_LATEST_PATH,
      snapshots: state.snapshots,
    },
  );
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash || ""}`;
  window.history.replaceState(null, "", nextUrl);
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
    onSuccess: ({ payload, path }) => {
      applySnapshotPayload(payload, path);
    },
    onFailure: () => {
      els.snapshotSelect.value = state.currentSnapshotPath;
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

function applySnapshotPayload(payload, path, options = {}) {
  state.payload = preparePayload(payload);
  state.status = payload.status || state.status;
  state.currentSnapshotPath = path;
  state.expandedRows.clear();
  if (options.resetPage !== false) resetPagination();
  els.snapshotSelect.value = path;
  syncNicheToggle();
  renderStatus(state.status);
  render({ syncUrl: options.syncUrl !== false });
  setSnapshotBusy(false);
}

function preparePayload(payload) {
  if (window.FrontendUtils.hasNicheAnnotations(payload) || !state.songSearchLookup.available) return payload;
  return window.FrontendUtils.annotatePayloadWithNiche(payload, state.songSearchLookup);
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

function setSnapshotBusy(isBusy, message = "") {
  els.content.setAttribute("aria-busy", isBusy ? "true" : "false");
  if (els.snapshotSelect) els.snapshotSelect.disabled = isBusy;
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
  els.snapshotSelect.replaceChildren();
  const latestOption = document.createElement("option");
  latestOption.value = SNAPSHOT_LATEST_PATH;
  latestOption.textContent = "最新快照";
  els.snapshotSelect.append(latestOption);

  const grouped = new Map();
  for (const entry of state.snapshots) {
    const dateKey = snapshotDateLabel(entry);
    if (!grouped.has(dateKey)) {
      const group = document.createElement("optgroup");
      group.label = dateKey;
      grouped.set(dateKey, group);
      els.snapshotSelect.append(group);
    }

    const option = document.createElement("option");
    option.value = entry.path;
    option.textContent = snapshotOptionLabel(entry);
    grouped.get(dateKey).append(option);
  }
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
  const at = formatDate(status.completedAt || status.generatedAt || status.attemptedAt);
  els.status.textContent = status.status === "success" ? `更新于 ${at}` : `正在使用上次成功数据 · ${at}`;
}

function render(options = {}) {
  const group = state.payload?.groups?.[state.range] || { title: state.range, items: [] };
  const sourceItems = group.items || [];
  const videoItems = filterItems(sourceItems);
  const occurrences = filterOccurrences(collectSongOccurrences(sourceItems));
  if (state.view !== "songAz") ensureIndexBucketExists(occurrences);

  resetContentClasses();
  els.content.replaceChildren();

  if (state.view === "videos") {
    els.content.classList.add("video-grid");
    renderVideoList(group, videoItems);
  } else if (state.view === "artistRank") {
    els.content.classList.add("rank-panel");
    renderArtistRank(group, occurrences);
  } else if (state.view === "songAz") {
    els.content.classList.add("song-index");
    renderSongIndexView(group, occurrences);
  } else {
    els.content.classList.add("rank-panel");
    renderSongRank(group, occurrences);
  }

  if (options.syncUrl !== false) syncUrlState();
  if (options.focusAfterPageChange) schedulePageChangeFocus();
  updateBackToTopVisibility();
}

function resetContentClasses() {
  els.content.className = "content-shell";
  els.content.classList.add(`view-${state.view}`);
}

function renderVideoList(group, items) {
  const allSongs = items.reduce((sum, item) => sum + (item.songs?.length || 0), 0);
  renderSummary(group, [
    metric(items.length, "个视频"),
    metric(allSongs, "个时间戳"),
    searchMetric(items.length, "个视频"),
  ]);

  if (!items.length) {
    renderEmpty(emptyMessage("这个范围还没有时间戳歌曲列表", "没有找到符合条件的视频", "没有找到曲库外歌曲视频"), {
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

function renderSongRank(group, occurrences) {
  const records = buildSongRecords(occurrences).sort(compareSongRank);
  const ranks = buildCompetitionRanks(records);
  const countFrequencies = buildCountFrequencies(records);

  renderSummary(group, [
    metric(uniqueVideoCount(occurrences), "个视频"),
    metric(occurrences.length, "次收录"),
    metric(records.length, "首唯一歌曲"),
    searchMetric(records.length, "首"),
  ]);

  if (!records.length) {
    renderEmpty(emptyMessage("这个范围还没有歌曲", "没有找到符合条件的歌曲", "没有找到曲库外歌曲"), {
      clearable: Boolean(state.filter),
    });
    return;
  }

  const pageInfo = pagedSlice(records);
  const fragment = document.createDocumentFragment();
  appendPagination(fragment, { pageInfo, unit: "首歌曲", variant: "top" });
  fragment.append(renderRankHeader());
  for (const record of pageInfo.visible) {
    fragment.append(
      renderRankRecord({
        key: `song-${record.key}`,
        rank: ranks.get(record.key),
        isTied: countFrequencies.get(record.count) > 1,
        title: record.title,
        meta: songMeta(record),
        isNiche: isNicheRecord(record),
        videoCount: uniqueVideoCount(record.occurrences),
        count: record.count,
        occurrences: record.occurrences,
      }),
    );
  }
  appendPagination(fragment, { pageInfo, unit: "首歌曲", variant: "bottom" });
  els.content.append(fragment);
}

function renderArtistRank(group, occurrences) {
  const { records, missingArtistCount } = buildArtistRecords(occurrences);
  records.sort(compareCountRecords);
  const ranks = buildCompetitionRanks(records);
  const countFrequencies = buildCountFrequencies(records);

  renderSummary(group, [
    metric(uniqueVideoCount(occurrences), "个视频"),
    metric(occurrences.length, "次收录"),
    metric(records.length, "位歌手"),
    searchMetric(records.length, "位"),
  ], missingArtistCount ? `${missingArtistCount} 条待补歌手` : "");

  if (!records.length) {
    renderEmpty(emptyMessage("这个范围还没有歌手资料", "没有找到符合条件的歌手", "没有找到曲库外歌曲歌手"), {
      clearable: Boolean(state.filter),
    });
    return;
  }

  const pageInfo = pagedSlice(records);
  const fragment = document.createDocumentFragment();
  appendPagination(fragment, { pageInfo, unit: "位歌手", variant: "top" });
  fragment.append(renderRankHeader());
  for (const record of pageInfo.visible) {
    fragment.append(
      renderRankRecord({
        key: `artist-${record.key}`,
        rank: ranks.get(record.key),
        isTied: countFrequencies.get(record.count) > 1,
        title: record.name,
        meta: artistMeta(record),
        videoCount: uniqueVideoCount(record.occurrences),
        count: record.count,
        occurrences: record.occurrences,
      }),
    );
  }
  appendPagination(fragment, { pageInfo, unit: "位歌手", variant: "bottom" });
  els.content.append(fragment);
}

function renderSongIndexView(group, occurrences) {
  const records = buildSongRecords(occurrences).sort(compareSongAz);

  renderSummary(group, [
    metric(uniqueVideoCount(occurrences), "个视频"),
    metric(occurrences.length, "次收录"),
    metric(records.length, "首唯一歌曲"),
    searchMetric(records.length, "首"),
  ]);

  if (!records.length) {
    renderEmpty(emptyMessage("这个范围还没有歌曲索引", "没有找到符合条件的歌曲", "没有找到曲库外歌曲"), {
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

function ensureIndexBucketExists(occurrences) {
  if (state.indexBucket === INDEX_ALL_BUCKET) return;
  const records = buildSongRecords(occurrences);
  if (!records.some((record) => songIndexBucket(record) === state.indexBucket)) {
    state.indexBucket = INDEX_ALL_BUCKET;
  }
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
    niche.textContent = "曲库外歌曲";
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
  const button = document.createElement("button");
  button.className = isCurrent ? "index-bucket is-current" : "index-bucket";
  button.type = "button";
  button.dataset.indexBucket = bucket;
  button.textContent = label;
  button.setAttribute("aria-pressed", isCurrent ? "true" : "false");
  if (isCurrent) button.setAttribute("aria-current", "page");
  return button;
}

function appendPagination(container, options) {
  const node = renderPaginationControl(options);
  if (node) container.append(node);
}

function renderPaginationControl({ pageInfo, unit, variant = "bottom" }) {
  if (pageInfo.total <= pageInfo.pageSize) return null;

  const footer = document.createElement("div");
  footer.className = `pagination-row pagination-${variant}`;

  const note = document.createElement("span");
  note.className = "pagination-note";
  note.textContent = `第 ${pageInfo.page} / ${pageInfo.pageCount} 页 · ${pageInfo.startIndex + 1}-${pageInfo.endIndex} / ${pageInfo.total} ${unit}`;
  footer.append(note);

  const controls = document.createElement("div");
  controls.className = "pagination-controls";

  if (variant === "top") {
    controls.append(
      renderPageButton("上一页", pageInfo.page - 1, pageInfo.page === 1),
      renderPageStatus(pageInfo),
      renderPageButton("下一页", pageInfo.page + 1, pageInfo.page === pageInfo.pageCount),
    );
    footer.append(controls);
    return footer;
  }

  controls.append(
    renderPageButton("首页", 1, pageInfo.page === 1),
    renderPageButton("上一页", pageInfo.page - 1, pageInfo.page === 1),
  );

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

  return footer;
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

function filterItems(items) {
  const searched = window.FrontendUtils.filterItemsBySearch(items, state.filter);
  if (!state.nicheOnly) return searched;
  return window.FrontendUtils
    .filterItemsByNiche(searched, true)
    .map((item) => ({ ...item, songs: (item.songs || []).filter((song) => window.FrontendUtils.isNicheSong(song)) }))
    .filter((item) => item.songs.length);
}

function collectSongOccurrences(items) {
  const occurrences = [];
  for (const item of items) {
    for (const song of item.songs || []) {
      if (!cleanText(song.title)) continue;
      occurrences.push({ item, song });
    }
  }
  return occurrences;
}

function filterOccurrences(occurrences) {
  return window.FrontendUtils.filterOccurrencesByNiche(
    window.FrontendUtils.filterOccurrencesBySearch(occurrences, state.filter),
    state.nicheOnly,
  );
}

function matchesSearch(parts) {
  return window.FrontendUtils.matchesSearch(parts, state.filter);
}

function buildSongRecords(occurrences) {
  return window.RankingUtils.buildSongRecords(occurrences, {
    cleanText,
    incrementCount,
    makeSongSortKey,
    normalizeEntityKey,
  });
}

function buildArtistRecords(occurrences) {
  const records = new Map();
  let missingArtistCount = 0;

  for (const occurrence of occurrences) {
    const artist = cleanText(occurrence.song.artist);
    if (!artist) {
      missingArtistCount += 1;
      continue;
    }

    const key = normalizeEntityKey(artist);
    if (!records.has(key)) {
      records.set(key, {
        key,
        name: artist,
        count: 0,
        songs: new Map(),
        channels: new Map(),
        occurrences: [],
      });
    }

    const record = records.get(key);
    record.count += 1;
    record.occurrences.push(occurrence);
    incrementCount(record.songs, cleanText(occurrence.song.title));
    incrementCount(record.channels, cleanText(occurrence.item.channelName));
  }

  return { records: Array.from(records.values()), missingArtistCount };
}

function buildCompetitionRanks(records) {
  return window.RankingUtils.buildCompetitionRanks(records);
}

function buildCountFrequencies(records) {
  const frequencies = new Map();
  for (const record of records) {
    frequencies.set(record.count, (frequencies.get(record.count) || 0) + 1);
  }
  return frequencies;
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
    badges: isNicheRecord(record) ? ["曲库外"] : [],
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

function renderRankRecord({ key, rank, isTied, title, meta, videoCount, count, occurrences, isNiche = false }) {
  const row = document.createElement("article");
  const rowKey = makeDomId(key);
  const drawerId = `source-drawer-${rowKey}`;
  const expandable = occurrences.length > 1;
  const isExpanded = state.expandedRows.has(rowKey);

  row.className = [
    "rank-row",
    expandable ? "is-expandable" : "",
    isExpanded ? "is-expanded" : "",
    isTied ? "is-tied" : "",
    isNiche ? "is-niche" : "",
    rank <= 3 ? `rank-top-${rank}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  row.dataset.rowKey = rowKey;
  row._sourceOccurrences = occurrences;
  if (isTied) row.title = "同收录次数共享名次";

  const rankNumber = document.createElement("div");
  rankNumber.className = "rank-number";
  rankNumber.textContent = formatRank(rank);
  rankNumber.setAttribute("aria-label", `第 ${rank} 名`);
  row.append(rankNumber);

  row.append(renderRecordContent(title, meta, { occurrences, drawerId, isExpanded, videoCount }));
  row.append(renderCount(count));
  if (expandable) row.append(renderSourceDrawer(occurrences, drawerId, isExpanded));

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
  row._sourceOccurrences = record.occurrences;

  row.append(
    renderRecordContent(record.title, songMeta(record), {
      occurrences: record.occurrences,
      drawerId,
      isExpanded,
      videoCount: uniqueVideoCount(record.occurrences),
      headingLevel: 3,
    }),
  );
  row.append(renderCount(record.count));
  if (expandable) row.append(renderSourceDrawer(record.occurrences, drawerId, isExpanded));

  return row;
}

function renderRankHeader() {
  const header = document.createElement("div");
  header.className = "rank-header";

  for (const label of ["排名", "歌曲与来源", "收录"]) {
    const item = document.createElement("span");
    item.textContent = label;
    header.append(item);
  }

  return header;
}

function renderRecordContent(title, meta, options) {
  const { occurrences, drawerId, isExpanded, videoCount, headingLevel = 2 } = options;
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
  appendSublinePart(subline, meta.primary, meta.missingPrimary ? "artist-missing" : "subline-primary");
  appendSublinePart(subline, `${videoCount} 个视频`, "subline-video-count");
  appendSublineSource(subline, occurrences, drawerId, isExpanded);
  content.append(subline);

  return content;
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

function renderCount(count) {
  const node = document.createElement("div");
  node.className = count > 1 ? "rank-count is-strong" : "rank-count";
  node.textContent = `${count}次`;
  return node;
}

function appendSublineSource(container, occurrences, drawerId, isExpanded) {
  if (!occurrences.length) {
    appendSublinePart(container, "无来源");
    return;
  }
  if (occurrences.length === 1) {
    appendSublineNode(container, renderInlineSourceLink(occurrences[0], { compact: true }));
    return;
  }

  const sourcePreview = window.FrontendUtils.buildSourcePreview(occurrences, {
    limit: INLINE_SOURCE_PREVIEW_LIMIT,
  });
  appendSublineNode(container, renderSourcePreviewLinks(sourcePreview.preview));

  const button = document.createElement("button");
  button.className = "rank-expand";
  button.type = "button";
  button.dataset.toggleSource = "true";
  button.dataset.sourceTotal = String(sourcePreview.total);
  button.dataset.sourceHiddenCount = String(sourcePreview.hiddenCount);
  button.setAttribute("aria-expanded", isExpanded ? "true" : "false");
  button.setAttribute("aria-controls", drawerId);
  button.setAttribute("aria-label", sourceToggleAriaLabel(isExpanded, sourcePreview.total, sourcePreview.hiddenCount));
  button.textContent = sourceToggleText(isExpanded, sourcePreview.hiddenCount);
  appendSublineNode(container, button);
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
    preview.append(renderInlineSourceLink(occurrence, { compact: true }));
  });
  return preview;
}

function renderInlineSourceLink(occurrence, options = {}) {
  const label = options.compact ? sourceLabel(occurrence) : sourceLabel(occurrence);
  const channelLink = youtubeChannelLink(occurrence.item);
  const link = document.createElement("a");
  link.className = "source-link-inline";
  link.href = channelLink.href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = label;
  const channelName = occurrence.item.channelName || occurrence.item.title || occurrence.item.videoId || label;
  link.title = channelLink.isFallbackSearch ? `搜索频道：${channelName}` : `打开频道：${channelName}`;
  link.setAttribute("aria-label", link.title);
  return link;
}

function sourceToggleText(isExpanded, hiddenCount) {
  if (isExpanded) return "收起来源";
  return hiddenCount > 0 ? `+${hiddenCount} 来源` : "来源详情";
}

function sourceToggleAriaLabel(isExpanded, total, hiddenCount) {
  if (isExpanded) return "收起来源";
  if (hiddenCount > 0) return `查看全部 ${total} 个来源，另有 ${hiddenCount} 个未显示`;
  return `查看 ${total} 个来源详情`;
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

function renderSourceDrawer(occurrences, drawerId, isExpanded) {
  const drawer = document.createElement("div");
  drawer.className = "source-drawer";
  drawer.id = drawerId;
  drawer.hidden = !isExpanded;
  if (!isExpanded) {
    drawer.dataset.sourceDeferred = "true";
    return drawer;
  }

  appendSourceDrawerLinks(drawer, occurrences);
  return drawer;
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

function toggleSourceDrawer(row) {
  if (!row) return;
  const drawer = row.querySelector(".source-drawer");
  const buttons = Array.from(row.querySelectorAll("[data-toggle-source]"));
  if (!drawer || !buttons.length) return;

  const nextExpanded = drawer.hidden;
  if (nextExpanded && drawer.dataset.sourceDeferred === "true") {
    drawer.replaceChildren();
    appendSourceDrawerLinks(drawer, row._sourceOccurrences || []);
    delete drawer.dataset.sourceDeferred;
  }
  drawer.hidden = !nextExpanded;
  row.classList.toggle("is-expanded", nextExpanded);
  for (const button of buttons) {
    button.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
    const count = row._sourceOccurrences?.length || 0;
    const total = Number(button.dataset.sourceTotal || count);
    const hiddenCount = Number(button.dataset.sourceHiddenCount || Math.max(0, count - INLINE_SOURCE_PREVIEW_LIMIT));
    button.setAttribute("aria-label", sourceToggleAriaLabel(nextExpanded, total, hiddenCount));
    button.textContent = sourceToggleText(nextExpanded, hiddenCount);
  }

  if (nextExpanded) {
    state.expandedRows.add(row.dataset.rowKey);
  } else {
    state.expandedRows.delete(row.dataset.rowKey);
  }
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
  count.textContent = `${item.songs?.length || 0} 首`;
  heading.append(count);
  body.append(heading);

  const list = document.createElement("ol");
  list.className = "song-list";
  list.id = `video-songs-${makeDomId(item.videoId || item.title)}`;
  const songs = item.songs || [];
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
      badge.textContent = "曲库外";
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
  const response = await fetch(path, { cache: "no-store", signal: options.signal });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function compareSongRank(a, b) {
  return b.count - a.count || compareValues(a.sortKey, b.sortKey) || compareValues(a.title, b.title);
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

function searchMetric(value, label) {
  return state.filter ? `搜索结果 ${value} ${label}` : "";
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

function sourceLabel({ item, song }) {
  return [song.time || formatSeconds(song.seconds), item.channelName || item.title || item.videoId]
    .filter(Boolean)
    .join(" · ");
}

function compactSourceLabel({ item }) {
  return item.channelName || item.title || item.videoId || "来源";
}

function youtubeChannelLink(item = {}) {
  const channelHandle = cleanText(item.channelHandle);
  const handleUrl = youtubeChannelHandleUrl(channelHandle);
  if (handleUrl) {
    return { href: handleUrl, isFallbackSearch: false };
  }

  const channelId = cleanText(item.channelId);
  if (channelId) {
    return {
      href: `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`,
      isFallbackSearch: false,
    };
  }

  const channelName = cleanText(item.channelName);
  if (channelName) {
    return {
      href: `https://www.youtube.com/results?search_query=${encodeURIComponent(channelName)}`,
      isFallbackSearch: true,
    };
  }

  return {
    href: item.videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}` : "https://www.youtube.com/",
    isFallbackSearch: true,
  };
}

function youtubeChannelHandleUrl(value) {
  if (!value) return "";
  if (/^https?:\/\/(www\.)?youtube\.com\//i.test(value)) return value;
  if (value.startsWith("/")) return `https://www.youtube.com${value}`;
  if (value.startsWith("@")) return `https://www.youtube.com/${value}`;
  if (value.startsWith("channel/") || value.startsWith("c/") || value.startsWith("user/")) {
    return `https://www.youtube.com/${value}`;
  }
  return "";
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
    videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : "",
    videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "",
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
