const VIEWS = {
  songRank: "Song Rank",
  artistRank: "Artist Rank",
  songAz: "Song A-Z",
  videos: "Videos",
};

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
  snapshots: [],
  range: "72h",
  view: "songRank",
  filter: "",
};

const els = {
  status: document.querySelector("#status"),
  summary: document.querySelector("#summary"),
  videoList: document.querySelector("#videoList"),
  snapshotSelect: document.querySelector("#snapshotSelect"),
  filterInput: document.querySelector("#filterInput"),
  rangeTabs: Array.from(document.querySelectorAll("[data-range]")),
  viewTabs: Array.from(document.querySelectorAll("[data-view]")),
  videoTemplate: document.querySelector("#videoTemplate"),
  rankTemplate: document.querySelector("#rankTemplate"),
};

init().catch((error) => {
  els.status.textContent = "Load failed";
  els.summary.innerHTML = `<span class="empty">Unable to load song-list data: ${escapeHtml(error.message)}</span>`;
});

async function init() {
  const [latest, snapshotIndex, status] = await Promise.all([
    readJson("data/latest.json"),
    readJson("data/snapshots/index.json").catch(() => ({ snapshots: [] })),
    readJson("data/status.json").catch(() => null),
  ]);
  state.payload = latest;
  state.snapshots = Array.isArray(snapshotIndex.snapshots) ? snapshotIndex.snapshots : [];
  renderSnapshotOptions();
  renderStatus(status || latest.status);
  bindEvents();
  render();
}

function bindEvents() {
  for (const tab of els.rangeTabs) {
    tab.addEventListener("click", () => {
      state.range = tab.dataset.range;
      setActiveTab(els.rangeTabs, tab);
      render();
    });
  }

  for (const tab of els.viewTabs) {
    tab.addEventListener("click", () => {
      state.view = tab.dataset.view;
      setActiveTab(els.viewTabs, tab);
      render();
    });
  }

  els.filterInput.addEventListener("input", () => {
    state.filter = normalizeSearch(els.filterInput.value.trim());
    render();
  });

  els.snapshotSelect.addEventListener("change", async () => {
    const path = els.snapshotSelect.value;
    state.payload = await readJson(path);
    renderStatus(state.payload.status);
    render();
  });
}

function setActiveTab(tabs, activeTab) {
  for (const item of tabs) {
    item.classList.toggle("active", item === activeTab);
    item.setAttribute("aria-selected", item === activeTab ? "true" : "false");
  }
}

function renderSnapshotOptions() {
  const latestOption = document.createElement("option");
  latestOption.value = "data/latest.json";
  latestOption.textContent = "Latest";
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
    els.status.textContent = "Status unavailable";
    return;
  }
  const label = status.status === "success" ? "Last success" : "Using previous data";
  const at = formatDate(status.completedAt || status.generatedAt || status.attemptedAt);
  els.status.textContent = `${label}: ${at}`;
}

function render() {
  const group = state.payload?.groups?.[state.range] || { title: state.range, items: [] };
  const sourceItems = group.items || [];
  const videoItems = filterItems(sourceItems);
  const occurrences = filterOccurrences(collectSongOccurrences(sourceItems));

  els.videoList.classList.toggle("video-list", state.view === "videos");
  els.videoList.classList.toggle("rank-list", state.view !== "videos");
  els.videoList.replaceChildren();

  if (state.view === "videos") {
    renderVideoList(group, videoItems);
  } else if (state.view === "artistRank") {
    renderArtistRank(group, occurrences);
  } else if (state.view === "songAz") {
    renderSongList(group, occurrences, "az");
  } else {
    renderSongList(group, occurrences, "rank");
  }
}

function renderVideoList(group, items) {
  const allSongs = items.reduce((sum, item) => sum + (item.songs?.length || 0), 0);
  renderSummary(group, [plural(items.length, "video"), plural(allSongs, "timestamp link"), capturedLabel()]);

  if (!items.length) {
    renderEmpty(state.filter ? "No matching songs in this snapshot." : "No timestamp song lists in this range.");
    return;
  }

  for (const item of items) {
    els.videoList.append(renderVideo(item));
  }
}

function renderSongList(group, occurrences, mode) {
  const records = buildSongRecords(occurrences);
  if (mode === "az") {
    records.sort(compareSongAz);
  } else {
    records.sort(compareSongRank);
  }

  renderSummary(group, [
    plural(uniqueVideoCount(occurrences), "video"),
    plural(occurrences.length, "appearance"),
    plural(records.length, "unique song"),
    capturedLabel(),
  ]);

  if (!records.length) {
    renderEmpty(state.filter ? "No matching songs in this snapshot." : "No songs in this range.");
    return;
  }

  records.forEach((record, index) => {
    els.videoList.append(
      renderRankRecord({
        position: `#${index + 1}`,
        title: record.title,
        meta: songMeta(record),
        count: plural(record.count, "appearance"),
        occurrences: record.occurrences,
      }),
    );
  });
}

function renderArtistRank(group, occurrences) {
  const { records, missingArtistCount } = buildArtistRecords(occurrences);
  records.sort(compareCountRecords);

  const parts = [
    plural(uniqueVideoCount(occurrences), "video"),
    plural(occurrences.length, "appearance"),
    plural(records.length, "artist"),
  ];
  if (missingArtistCount) parts.push(`${missingArtistCount} without artist`);
  parts.push(capturedLabel());
  renderSummary(group, parts);

  if (!records.length) {
    renderEmpty(
      state.filter
        ? "No matching artists in this snapshot."
        : "No artist metadata is available for this range.",
    );
    return;
  }

  records.forEach((record, index) => {
    els.videoList.append(
      renderRankRecord({
        position: `#${index + 1}`,
        title: record.name,
        meta: artistMeta(record),
        count: plural(record.count, "appearance"),
        occurrences: record.occurrences,
      }),
    );
  });
}

function renderSummary(group, parts) {
  els.summary.innerHTML = [
    `<strong>${escapeHtml(VIEWS[state.view] || state.view)}</strong>`,
    escapeHtml(group.title || state.range),
    ...parts.map(escapeHtml),
  ].join(" · ");
}

function renderEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = message;
  els.videoList.append(empty);
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
        occurrences: [],
      });
    }

    const record = records.get(key);
    record.count += 1;
    record.occurrences.push(occurrence);
    incrementCount(record.artists, cleanText(occurrence.song.artist));
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
        occurrences: [],
      });
    }

    const record = records.get(key);
    record.count += 1;
    record.occurrences.push(occurrence);
    incrementCount(record.songs, cleanText(occurrence.song.title));
  }

  return { records: Array.from(records.values()), missingArtistCount };
}

function incrementCount(map, name) {
  if (!name) return;
  const key = normalizeEntityKey(name);
  if (!key) return;
  if (!map.has(key)) map.set(key, { key, name, count: 0 });
  map.get(key).count += 1;
}

function songMeta(record) {
  const artists = sortedCountEntries(record.artists)
    .slice(0, 3)
    .map(formatCountEntry);
  return [artists.length ? `Artists: ${artists.join(", ")}` : "Artist unknown", plural(uniqueVideoCount(record.occurrences), "video")]
    .filter(Boolean)
    .join(" · ");
}

function artistMeta(record) {
  const songs = sortedCountEntries(record.songs)
    .slice(0, 4)
    .map(formatCountEntry);
  return [plural(record.songs.size, "song"), songs.length ? songs.join(", ") : ""]
    .filter(Boolean)
    .join(" · ");
}

function sortedCountEntries(map) {
  return Array.from(map.values()).sort(compareCountRecords);
}

function formatCountEntry(entry) {
  return entry.count > 1 ? `${entry.name} (${entry.count})` : entry.name;
}

function renderRankRecord({ position, title, meta, count, occurrences }) {
  const node = els.rankTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".rank-position").textContent = position;
  node.querySelector(".rank-title").textContent = title;
  node.querySelector(".rank-meta").textContent = meta;
  node.querySelector(".rank-count").textContent = count;
  renderSourceLinks(node.querySelector(".source-list"), occurrences);
  return node;
}

function renderSourceLinks(container, occurrences) {
  const shown = occurrences.slice(0, 5);
  for (const { item, song } of shown) {
    const link = document.createElement("a");
    link.className = "source-chip";
    link.href = youtubeTimeUrl(item.videoId, song.seconds);
    link.target = "_blank";
    link.rel = "noreferrer";
    link.title = item.title || item.videoId;
    link.textContent = [song.time, item.channelName || item.title || item.videoId].filter(Boolean).join(" · ");
    container.append(link);
  }

  const hiddenCount = occurrences.length - shown.length;
  if (hiddenCount > 0) {
    const more = document.createElement("span");
    more.className = "source-more";
    more.textContent = `+${hiddenCount} more`;
    container.append(more);
  }
}

function renderVideo(item) {
  const node = els.videoTemplate.content.firstElementChild.cloneNode(true);
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`;
  const thumbLink = node.querySelector(".thumb-link");
  const thumb = node.querySelector(".thumb");
  const title = node.querySelector(".video-title");
  const meta = node.querySelector(".video-meta");
  const count = node.querySelector(".song-count");
  const list = node.querySelector(".song-list");

  thumbLink.href = url;
  thumb.src = item.thumbnailUrl || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
  thumb.alt = "";
  title.href = url;
  title.textContent = item.title || item.videoId;
  meta.textContent = [item.channelName, item.publishedText, item.keyword].filter(Boolean).join(" · ");
  count.textContent = `${item.songs?.length || 0} songs`;

  for (const song of item.songs || []) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = youtubeTimeUrl(item.videoId, song.seconds);
    link.target = "_blank";
    link.rel = "noreferrer";
    link.innerHTML = `<span class="time">${escapeHtml(song.time)}</span> ${escapeHtml(song.title)}${song.artist ? ` / ${escapeHtml(song.artist)}` : ""}`;
    li.append(link);
    list.append(li);
  }

  return node;
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

function capturedLabel() {
  return `captured ${formatDate(state.payload?.capturedAt || state.payload?.generatedAt)}`;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
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

function formatDate(value) {
  if (!value) return "unknown";
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
