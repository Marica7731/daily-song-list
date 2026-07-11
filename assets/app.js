const VIEWS = {
  songRank: "歌曲榜",
  artistRank: "歌手榜",
  songAz: "歌曲索引",
  videos: "视频",
};

const RANGE_LABELS = {
  "72h": "最近72小时",
  "1m": "近30天",
};

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
  range: "72h",
  view: "songRank",
  filter: "",
  expandedRows: new Set(),
};

const els = {
  status: document.querySelector("#status"),
  summary: document.querySelector("#summary"),
  content: document.querySelector("#videoList"),
  snapshotSelect: document.querySelector("#snapshotSelect"),
  filterInput: document.querySelector("#filterInput"),
  rangeTabs: Array.from(document.querySelectorAll("[data-range]")),
  viewTabs: Array.from(document.querySelectorAll("[data-view]")),
};

init().catch((error) => {
  renderLoadError(error);
});

async function init() {
  const [latest, snapshotIndex, status] = await Promise.all([
    readJson("data/latest.json"),
    readJson("data/snapshots/index.json").catch(() => ({ snapshots: [] })),
    readJson("data/status.json").catch(() => null),
  ]);
  state.payload = latest;
  state.status = status || latest.status || null;
  state.snapshots = Array.isArray(snapshotIndex.snapshots) ? snapshotIndex.snapshots : [];
  renderSnapshotOptions();
  renderStatus(state.status);
  bindEvents();
  render();
}

function bindEvents() {
  for (const tab of els.rangeTabs) {
    tab.addEventListener("click", () => {
      if (state.range === tab.dataset.range) return;
      state.range = tab.dataset.range;
      state.expandedRows.clear();
      setActiveTab(els.rangeTabs, tab);
      render();
    });
  }

  for (const tab of els.viewTabs) {
    tab.addEventListener("click", () => {
      if (state.view === tab.dataset.view) return;
      state.view = tab.dataset.view;
      state.expandedRows.clear();
      setActiveTab(els.viewTabs, tab);
      render();
    });
  }

  els.filterInput.addEventListener("input", () => {
    state.filter = normalizeSearch(els.filterInput.value.trim());
    state.expandedRows.clear();
    render();
  });

  els.snapshotSelect.addEventListener("change", async () => {
    const path = els.snapshotSelect.value;
    try {
      state.payload = await readJson(path);
      state.status = state.payload.status || state.status;
      state.expandedRows.clear();
      renderStatus(state.payload.status);
      render();
    } catch (error) {
      renderLoadError(error, "读取快照失败");
    }
  });

  els.content.addEventListener("click", (event) => {
    const clear = event.target.closest("[data-clear-search]");
    if (clear) {
      els.filterInput.value = "";
      state.filter = "";
      state.expandedRows.clear();
      render();
      els.filterInput.focus();
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
      return;
    }

    const row = event.target.closest(".rank-row.is-expandable, .index-row.is-expandable");
    if (!row || event.target.closest("a, button, input, select, textarea")) return;
    toggleSourceDrawer(row);
  });
}

function setActiveTab(tabs, activeTab) {
  for (const item of tabs) {
    item.classList.toggle("active", item === activeTab);
    item.setAttribute("aria-selected", item === activeTab ? "true" : "false");
  }
}

function renderSnapshotOptions() {
  els.snapshotSelect.replaceChildren();
  const latestOption = document.createElement("option");
  latestOption.value = "data/latest.json";
  latestOption.textContent = "最新快照";
  els.snapshotSelect.append(latestOption);

  for (const entry of state.snapshots) {
    const option = document.createElement("option");
    option.value = entry.path;
    option.textContent = entry.label || entry.id;
    els.snapshotSelect.append(option);
  }
}

function renderStatus(status) {
  if (!status) {
    els.status.textContent = "状态不可用";
    return;
  }
  const at = formatDate(status.completedAt || status.generatedAt || status.attemptedAt);
  els.status.textContent = status.status === "success" ? `更新于 ${at}` : `正在使用上次成功数据 · ${at}`;
}

function render() {
  const group = state.payload?.groups?.[state.range] || { title: state.range, items: [] };
  const sourceItems = group.items || [];
  const videoItems = filterItems(sourceItems);
  const occurrences = filterOccurrences(collectSongOccurrences(sourceItems));

  resetContentClasses();
  els.content.replaceChildren();

  if (state.view === "videos") {
    els.content.classList.add("video-grid");
    renderVideoList(group, videoItems);
    return;
  }

  if (state.view === "artistRank") {
    els.content.classList.add("rank-panel");
    renderArtistRank(group, occurrences);
    return;
  }

  if (state.view === "songAz") {
    els.content.classList.add("song-index");
    renderSongIndexView(group, occurrences);
    return;
  }

  els.content.classList.add("rank-panel");
  renderSongRank(group, occurrences);
}

function resetContentClasses() {
  els.content.className = "content-shell";
  els.content.classList.add(`view-${state.view}`);
}

function renderVideoList(group, items) {
  const allSongs = items.reduce((sum, item) => sum + (item.songs?.length || 0), 0);
  renderSummary(group, [
    metric(items.length, "个视频"),
    metric(allSongs, "首歌曲"),
    metric(capturedDate(), "更新于"),
  ]);

  if (!items.length) {
    renderEmpty(state.filter ? "没有找到符合条件的歌曲" : "这个范围还没有时间戳歌曲列表", {
      clearable: Boolean(state.filter),
    });
    return;
  }

  for (const item of items) {
    els.content.append(renderVideo(item));
  }
}

function renderSongRank(group, occurrences) {
  const records = buildSongRecords(occurrences).sort(compareSongRank);
  const ranks = buildCompetitionRanks(records);
  const countFrequencies = buildCountFrequencies(records);

  renderSummary(group, [
    metric(uniqueVideoCount(occurrences), "个视频"),
    metric(occurrences.length, "次收录"),
    metric(records.length, "首歌曲"),
    metric(capturedDate(), "更新于"),
  ], state.filter ? `当前显示 ${records.length} 首` : "");

  if (!records.length) {
    renderEmpty(state.filter ? "没有找到符合条件的歌曲" : "这个范围还没有歌曲", {
      clearable: Boolean(state.filter),
    });
    return;
  }

  for (const record of records) {
    els.content.append(
      renderRankRecord({
        key: `song-${record.key}`,
        rank: ranks.get(record.key),
        isTied: countFrequencies.get(record.count) > 1,
        title: record.title,
        meta: songMeta(record),
        videoCount: uniqueVideoCount(record.occurrences),
        count: record.count,
        occurrences: record.occurrences,
      }),
    );
  }
}

function renderArtistRank(group, occurrences) {
  const { records, missingArtistCount } = buildArtistRecords(occurrences);
  records.sort(compareCountRecords);
  const ranks = buildCompetitionRanks(records);
  const countFrequencies = buildCountFrequencies(records);

  const searchInfo = state.filter ? `当前显示 ${records.length} 位` : "";
  const extraInfo = missingArtistCount ? `${missingArtistCount} 条待补歌手` : "";
  renderSummary(group, [
    metric(uniqueVideoCount(occurrences), "个视频"),
    metric(occurrences.length, "次收录"),
    metric(records.length, "位歌手"),
    metric(capturedDate(), "更新于"),
  ], [searchInfo, extraInfo].filter(Boolean).join(" · "));

  if (!records.length) {
    renderEmpty(state.filter ? "没有找到符合条件的歌曲" : "这个范围还没有歌手资料", {
      clearable: Boolean(state.filter),
    });
    return;
  }

  for (const record of records) {
    els.content.append(
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
}

function renderSongIndexView(group, occurrences) {
  const records = buildSongRecords(occurrences).sort(compareSongAz);

  renderSummary(group, [
    metric(uniqueVideoCount(occurrences), "个视频"),
    metric(occurrences.length, "次收录"),
    metric(records.length, "首歌曲"),
    metric(capturedDate(), "更新于"),
  ], state.filter ? `当前显示 ${records.length} 首` : "");

  if (!records.length) {
    renderEmpty(state.filter ? "没有找到符合条件的歌曲" : "这个范围还没有歌曲索引", {
      clearable: Boolean(state.filter),
    });
    return;
  }

  const groups = groupSongIndex(records);
  const nav = document.createElement("nav");
  nav.className = "index-nav";
  nav.setAttribute("aria-label", "歌曲快速索引");

  for (const groupEntry of groups) {
    const link = document.createElement("a");
    link.href = `#${groupEntry.id}`;
    link.textContent = groupEntry.label;
    nav.append(link);
  }
  els.content.append(nav);

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
    for (const record of groupEntry.records) {
      list.append(renderIndexRecord(record));
    }
    section.append(list);
    els.content.append(section);
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

  for (const item of metrics) {
    const chip = document.createElement("span");
    chip.className = "summary-chip";
    chip.textContent = item;
    els.summary.append(chip);
  }

  if (!isLatestSnapshot()) {
    const history = document.createElement("span");
    history.className = "summary-chip history-chip";
    history.textContent = `历史快照 ${capturedDate()}`;
    els.summary.append(history);
  }

  if (note) {
    const noteNode = document.createElement("span");
    noteNode.className = "summary-note";
    noteNode.textContent = note;
    els.summary.append(noteNode);
  }
}

function renderEmpty(message, options = {}) {
  els.content.classList.remove("rank-panel", "video-grid", "song-index");
  els.content.classList.add("empty-state");

  const empty = document.createElement("div");
  empty.className = "empty";

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

  els.content.append(empty);
}

function renderLoadError(error, prefix = "读取失败") {
  els.status.textContent = prefix;
  els.summary.replaceChildren();
  resetContentClasses();
  els.content.replaceChildren();
  renderEmpty(`${prefix}: ${error.message}`);
}

function filterItems(items) {
  if (!state.filter) return items;
  return items.filter((item) => {
    const songParts = (item.songs || []).flatMap((song) => [song.title, song.artist]);
    return matchesSearch([item.title, item.channelName, item.keyword, ...songParts]);
  });
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
  if (!state.filter) return occurrences;
  return occurrences.filter(({ item, song }) =>
    matchesSearch([item.title, item.channelName, item.keyword, song.title, song.artist]),
  );
}

function matchesSearch(parts) {
  return normalizeSearch(parts.filter(Boolean).join(" ")).includes(state.filter);
}

function buildSongRecords(occurrences) {
  const records = new Map();
  for (const occurrence of occurrences) {
    const title = cleanText(occurrence.song.title);
    const key = normalizeEntityKey(title);
    if (!key) continue;

    if (!records.has(key)) {
      records.set(key, {
        key,
        title,
        sortKey: makeSongSortKey(title),
        count: 0,
        artists: new Map(),
        channels: new Map(),
        occurrences: [],
      });
    }

    const record = records.get(key);
    record.count += 1;
    record.occurrences.push(occurrence);
    incrementCount(record.artists, cleanText(occurrence.song.artist));
    incrementCount(record.channels, cleanText(occurrence.item.channelName));
  }

  return Array.from(records.values());
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
  const ranks = new Map();
  let previousCount = null;
  let currentRank = 0;

  records.forEach((record, index) => {
    if (record.count !== previousCount) {
      currentRank = index + 1;
      previousCount = record.count;
    }
    ranks.set(record.key, currentRank);
  });

  return ranks;
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
  const channels = sortedCountEntries(record.channels);
  return {
    primary: artists.length ? artists.slice(0, 2).map(formatCountEntry).join("、") : "待补歌手",
    missingPrimary: !artists.length,
    details: [
      `${uniqueVideoCount(record.occurrences)} 个视频`,
      channels.length ? channels[0].name : "",
    ].filter(Boolean),
  };
}

function artistMeta(record) {
  const songs = sortedCountEntries(record.songs);
  const channels = sortedCountEntries(record.channels);
  return {
    primary: `${record.songs.size} 首歌曲`,
    missingPrimary: false,
    details: [
      songs.length ? songs.slice(0, 3).map(formatCountEntry).join("、") : "",
      channels.length ? channels[0].name : "",
    ].filter(Boolean),
  };
}

function sortedCountEntries(map) {
  return Array.from(map.values()).sort(compareCountRecords);
}

function formatCountEntry(entry) {
  return entry.count > 1 ? `${entry.name} (${entry.count})` : entry.name;
}

function renderRankRecord({ key, rank, isTied, title, meta, videoCount, count, occurrences }) {
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
    rank <= 3 ? `rank-top-${rank}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  row.dataset.rowKey = rowKey;

  const rankNumber = document.createElement("div");
  rankNumber.className = "rank-number";
  rankNumber.textContent = formatRank(rank);
  rankNumber.setAttribute("aria-label", `第 ${rank} 名`);
  row.append(rankNumber);

  row.append(renderRecordContent(title, meta, occurrences, drawerId, isExpanded));
  row.append(renderVideoCount(videoCount));
  row.append(renderCount(count));
  row.append(renderRowAction({ occurrences, drawerId, isExpanded, expandable }));
  if (expandable) row.append(renderSourceDrawer(occurrences, drawerId, isExpanded));

  return row;
}

function renderIndexRecord(record) {
  const row = document.createElement("article");
  const rowKey = makeDomId(`index-${record.key}`);
  const drawerId = `source-drawer-${rowKey}`;
  const expandable = record.occurrences.length > 1;
  const isExpanded = state.expandedRows.has(rowKey);

  row.className = ["index-row", expandable ? "is-expandable" : "", isExpanded ? "is-expanded" : ""]
    .filter(Boolean)
    .join(" ");
  row.dataset.rowKey = rowKey;

  row.append(renderRecordContent(record.title, songMeta(record), record.occurrences, drawerId, isExpanded));
  row.append(renderCount(record.count));
  row.append(renderRowAction({ occurrences: record.occurrences, drawerId, isExpanded, expandable }));
  if (expandable) row.append(renderSourceDrawer(record.occurrences, drawerId, isExpanded));

  return row;
}

function renderRecordContent(title, meta, occurrences, drawerId, isExpanded) {
  const content = document.createElement("div");
  content.className = "rank-content";

  const heading = document.createElement("h2");
  heading.className = "rank-title";
  heading.textContent = title;
  content.append(heading);

  const metaNode = document.createElement("div");
  metaNode.className = "rank-meta";
  appendMetaPart(metaNode, meta.primary, meta.missingPrimary);
  for (const detail of meta.details) appendMetaPart(metaNode, detail);
  content.append(metaNode);

  content.append(renderSourcePreview(occurrences, drawerId, isExpanded));
  return content;
}

function appendMetaPart(container, text, isMissing = false) {
  if (!text) return;
  if (container.childNodes.length) {
    const separator = document.createElement("span");
    separator.className = "meta-separator";
    separator.textContent = "·";
    container.append(separator);
  }
  const part = document.createElement("span");
  part.className = isMissing ? "artist-missing" : "";
  part.textContent = text;
  container.append(part);
}

function renderVideoCount(count) {
  const node = document.createElement("div");
  node.className = "rank-video-count";
  node.textContent = `${count} 个视频`;
  return node;
}

function renderCount(count) {
  const node = document.createElement("div");
  node.className = count > 1 ? "rank-count is-strong" : "rank-count";
  node.textContent = `${count} 次`;
  return node;
}

function renderRowAction({ occurrences, drawerId, isExpanded, expandable }) {
  const action = document.createElement("div");
  action.className = "rank-action";

  if (!expandable) {
    const source = occurrences[0];
    const link = document.createElement("a");
    link.className = "rank-open";
    link.href = youtubeTimeUrl(source.item.videoId, source.song.seconds);
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "打开";
    link.setAttribute("aria-label", `打开 ${cleanText(source.song.title)} 的时间戳`);
    action.append(link);
    return action;
  }

  const button = document.createElement("button");
  button.className = "rank-expand";
  button.type = "button";
  button.dataset.toggleSource = "true";
  button.setAttribute("aria-expanded", isExpanded ? "true" : "false");
  button.setAttribute("aria-controls", drawerId);
  button.setAttribute("aria-label", isExpanded ? "收起来源" : "展开来源");
  button.textContent = isExpanded ? "收起" : "展开";
  action.append(button);
  return action;
}

function renderSourcePreview(occurrences, drawerId, isExpanded) {
  const preview = document.createElement("div");
  preview.className = "source-preview";

  if (!occurrences.length) {
    preview.textContent = "无来源";
    return preview;
  }

  const first = occurrences[0];
  const link = document.createElement("a");
  link.className = "source-preview-link";
  link.href = youtubeTimeUrl(first.item.videoId, first.song.seconds);
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = sourceLabel(first);
  preview.append(link);

  const hiddenCount = occurrences.length - 1;
  if (hiddenCount > 0) {
    const more = document.createElement("button");
    more.className = "source-preview-more";
    more.type = "button";
    more.dataset.toggleSource = "true";
    more.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    more.setAttribute("aria-controls", drawerId);
    more.setAttribute("aria-label", isExpanded ? "收起全部来源" : `展开其余 ${hiddenCount} 个来源`);
    more.textContent = `另有 ${hiddenCount} 个来源`;
    preview.append(more);
  }

  return preview;
}

function renderSourceDrawer(occurrences, drawerId, isExpanded) {
  const drawer = document.createElement("div");
  drawer.className = "source-drawer";
  drawer.id = drawerId;
  drawer.hidden = !isExpanded;

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

  return drawer;
}

function toggleSourceDrawer(row) {
  if (!row) return;
  const drawer = row.querySelector(".source-drawer");
  const buttons = Array.from(row.querySelectorAll("[data-toggle-source]"));
  if (!drawer || !buttons.length) return;

  const nextExpanded = drawer.hidden;
  drawer.hidden = !nextExpanded;
  row.classList.toggle("is-expanded", nextExpanded);
  for (const button of buttons) {
    button.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
    if (button.classList.contains("rank-expand")) {
      button.setAttribute("aria-label", nextExpanded ? "收起来源" : "展开来源");
      button.textContent = nextExpanded ? "收起" : "展开";
    } else {
      button.setAttribute("aria-label", nextExpanded ? "收起全部来源" : button.textContent);
    }
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

  const thumb = document.createElement("img");
  thumb.className = "thumb";
  thumb.alt = "";
  thumb.loading = "lazy";
  thumb.src = youtubeThumbnailUrl(item.videoId);
  const fallbackThumbnail = () => {
    if (thumb.dataset.fallback === "true") return;
    thumb.dataset.fallback = "true";
    thumb.src = placeholderThumbnail();
  };
  thumb.addEventListener("error", fallbackThumbnail, { once: true });
  window.setTimeout(() => {
    if (!thumb.complete || thumb.naturalWidth === 0) fallbackThumbnail();
  }, 1200);
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
  const songs = item.songs || [];
  songs.forEach((song, index) => {
    const li = document.createElement("li");
    if (index >= 3) li.hidden = true;
    li.className = index >= 3 ? "video-song-extra" : "";

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

    li.append(link);
    list.append(li);
  });
  body.append(list);

  if (songs.length > 3) {
    const more = document.createElement("button");
    more.className = "video-more";
    more.type = "button";
    more.dataset.toggleVideoSongs = "true";
    more.setAttribute("aria-expanded", "false");
    more.textContent = `展开其余 ${songs.length - 3} 首`;
    body.append(more);
  }

  card.append(body);
  return card;
}

function toggleVideoSongs(card) {
  if (!card) return;
  const button = card.querySelector(".video-more");
  const extras = Array.from(card.querySelectorAll(".video-song-extra"));
  const nextExpanded = button.getAttribute("aria-expanded") !== "true";

  for (const item of extras) item.hidden = !nextExpanded;
  button.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
  button.textContent = nextExpanded ? "收起歌曲" : `展开其余 ${extras.length} 首`;
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
  const titleFirst = toHiragana(firstMeaningfulChar(record.title));
  for (const bucket of KANA_BUCKETS) {
    if (bucket.pattern.test(titleFirst)) return bucket.label;
  }

  const sortFirst = cleanText(record.sortKey)[0] || "";
  if (/^[a-z]$/i.test(sortFirst)) return sortFirst.toUpperCase();
  if (/^\d$/u.test(sortFirst)) return "0-9";
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
  return 99;
}

async function readJson(path) {
  const response = await fetch(path, { cache: "no-store" });
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

function metric(value, label) {
  if (typeof value === "number") return `${value} ${label}`;
  return `${label} ${value}`;
}

function capturedDate() {
  return formatDate(state.payload?.capturedAt || state.payload?.generatedAt);
}

function isLatestSnapshot() {
  return els.snapshotSelect.value === "data/latest.json";
}

function sourceLabel({ item, song }) {
  return [song.time || formatSeconds(song.seconds), item.channelName || item.title || item.videoId]
    .filter(Boolean)
    .join(" · ");
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

function youtubeThumbnailUrl(videoId) {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
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
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-Hant", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeEntityKey(value) {
  return cleanText(value).normalize("NFKC").toLocaleLowerCase();
}

function normalizeSearch(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase();
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
