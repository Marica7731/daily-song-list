const {
  createSongSearchLookup,
  isSongSearchKnown,
  normalizeSongSearchText,
} = require("../assets/frontend-utils");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalizeSongIdentity, loadSongAliasContext } = require("./song-aliases");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_REPOSITORY = "Marica7731/song-search";
const SOURCE_BRANCH = "main";
const PAGES_BASE_URL = "https://marica7731.github.io/song-search";
const RAW_BASE_URL = `https://raw.githubusercontent.com/${SOURCE_REPOSITORY}/${SOURCE_BRANCH}`;
const SOURCE_INDEX_URL = `${PAGES_BASE_URL}/data/index.json`;
const RAW_SOURCE_INDEX_URL = `${RAW_BASE_URL}/data/index.json`;
const SOURCE_WORKFLOW_URL = `https://github.com/${SOURCE_REPOSITORY}/actions/workflows/update.yml`;
const SUPPLEMENTAL_KNOWN_SONGS_PATH = path.join(ROOT, "config", "song-search-known-overrides.json");
const DEFAULT_CONCURRENCY = 4;

async function refreshSongSearchIndex(options = {}) {
  const previousIndex = options.previousIndex || null;
  const now = options.now || new Date();
  try {
    return mergeSupplementalKnownSongs(await fetchSongSearchIndex(options), options.supplementalKnownSongs);
  } catch (error) {
    if (isSongSearchIndexAvailable(previousIndex)) {
      return mergeSupplementalKnownSongs({
        ...previousIndex,
        stale: true,
        refreshError: error.message,
        refreshedAt: now.toISOString(),
      }, options.supplementalKnownSongs);
    }
    return mergeSupplementalKnownSongs(emptySongSearchIndex({
      generatedAt: now.toISOString(),
      refreshError: error.message,
    }), options.supplementalKnownSongs);
  }
}

async function fetchSongSearchIndex(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || new Date();
  const concurrency = positiveInteger(options.concurrency, DEFAULT_CONCURRENCY);
  const index = await fetchFirstJson(fetchImpl, [SOURCE_INDEX_URL, RAW_SOURCE_INDEX_URL]);
  const files = uniqueValues(index.files || []).filter((file) => file.endsWith(".js"));
  const entriesByKey = new Map();
  const successfulFiles = [];
  const skippedFiles = [];

  await mapWithConcurrency(files, concurrency, async (file) => {
    try {
      const filePath = encodeURIComponent(file);
      const text = await fetchFirstText(fetchImpl, [`${PAGES_BASE_URL}/data/${filePath}`, `${RAW_BASE_URL}/data/${filePath}`]);
      for (const entry of parseSongSearchDataFile(text, file)) {
        const titleKey = normalizeSongSearchText(entry.title);
        if (!titleKey) continue;
        const artistKey = normalizeSongSearchText(entry.artist);
        const existing = entriesByKey.get(entryKey(titleKey, artistKey));
        if (existing) {
          existing.sources.add(file);
          continue;
        }
        entriesByKey.set(entryKey(titleKey, artistKey), {
          titleKey,
          artistKey,
          title: cleanText(entry.title),
          artist: cleanText(entry.artist),
          sources: new Set([file]),
        });
      }
      successfulFiles.push(file);
    } catch (error) {
      skippedFiles.push({ file, reason: error.message });
    }
  });

  if (!entriesByKey.size) {
    throw new Error(`song-search index produced no entries from ${files.length} manifest file(s)`);
  }

  return buildSongSearchIndex([...entriesByKey.values()], {
    generatedAt: now.toISOString(),
    manifestFiles: files,
    files: successfulFiles.sort(),
    skippedFiles: skippedFiles.sort((a, b) => a.file.localeCompare(b.file)),
  });
}

function parseSongSearchDataFile(text, file = "") {
  const entries = [];
  for (const args of extractPushArguments(text)) {
    try {
      const parsed = JSON.parse(`[${args}]`);
      for (const item of parsed) {
        if (item && typeof item === "object") entries.push({ ...item, source: item.source || file });
      }
    } catch (error) {
      throw new Error(`${file || "song-search data"} parse failed: ${error.message}`);
    }
  }
  return entries;
}

function extractPushArguments(text) {
  const source = String(text || "");
  const marker = "window.SONG_DATA.push(";
  const results = [];
  let searchIndex = 0;
  while (searchIndex < source.length) {
    const markerIndex = source.indexOf(marker, searchIndex);
    if (markerIndex < 0) break;
    const start = markerIndex + marker.length;
    const end = findMatchingParen(source, start - 1);
    if (end < 0) throw new Error("window.SONG_DATA.push closing parenthesis not found");
    results.push(source.slice(start, end).trim());
    searchIndex = end + 1;
  }
  return results;
}

function findMatchingParen(source, openIndex) {
  let depth = 0;
  let quote = "";
  let escape = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function buildSongSearchIndex(entries, options = {}) {
  const titleKeys = new Set();
  const titleArtistKeys = new Set();
  const samples = [];

  for (const entry of entries || []) {
    const titleKey = entry.titleKey || normalizeSongSearchText(entry.title);
    const artistKey = entry.artistKey || normalizeSongSearchText(entry.artist);
    if (!titleKey) continue;
    titleKeys.add(titleKey);
    if (artistKey && !isUnknownArtistKey(artistKey)) titleArtistKeys.add(`${titleKey}::${artistKey}`);
    if (samples.length < 8) {
      samples.push({
        title: cleanText(entry.title),
        artist: cleanText(entry.artist),
        sources: entry.sources ? [...entry.sources].sort() : uniqueValues([entry.source]),
      });
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt || new Date().toISOString(),
    source: {
      repository: SOURCE_REPOSITORY,
      branch: SOURCE_BRANCH,
      indexUrl: SOURCE_INDEX_URL,
      rawIndexUrl: RAW_SOURCE_INDEX_URL,
      pagesBaseUrl: PAGES_BASE_URL,
      rawBaseUrl: RAW_BASE_URL,
      workflowUrl: SOURCE_WORKFLOW_URL,
    },
    manifestFileCount: (options.manifestFiles || options.files || []).length,
    fileCount: (options.files || []).length,
    files: options.files || [],
    skippedFileCount: (options.skippedFiles || []).length,
    skippedFiles: options.skippedFiles || [],
    recordCount: entries.length,
    titleKeyCount: titleKeys.size,
    titleArtistKeyCount: titleArtistKeys.size,
    titleKeys: [...titleKeys].sort(),
    titleArtistKeys: [...titleArtistKeys].sort(),
    samples,
  };
}

function loadSupplementalKnownSongs(filePath = SUPPLEMENTAL_KNOWN_SONGS_PATH) {
  if (!fs.existsSync(filePath)) return [];
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Number(payload.schemaVersion) !== 1) throw new Error(`${path.relative(ROOT, filePath)} schemaVersion must be 1`);
  if (!Array.isArray(payload.records)) throw new Error(`${path.relative(ROOT, filePath)} records must be an array`);
  return normalizeSupplementalKnownSongs(payload.records);
}

function mergeSupplementalKnownSongs(index, recordsInput = undefined) {
  const records = recordsInput === undefined ? loadSupplementalKnownSongs() : normalizeSupplementalKnownSongs(recordsInput);
  if (!records.length) return index;

  const titleKeys = new Set(index?.titleKeys || []);
  const titleArtistKeys = new Set(index?.titleArtistKeys || []);
  let addedRecordCount = 0;
  for (const record of records) {
    const titleKey = normalizeSongSearchText(record.title);
    const artistKey = normalizeSongSearchText(record.artist);
    if (!titleKey) continue;
    const hadTitle = titleKeys.has(titleKey);
    const titleArtistKey = artistKey && !isUnknownArtistKey(artistKey) ? `${titleKey}::${artistKey}` : "";
    const hadTitleArtist = titleArtistKey ? titleArtistKeys.has(titleArtistKey) : true;
    titleKeys.add(titleKey);
    if (titleArtistKey) titleArtistKeys.add(titleArtistKey);
    if (!hadTitle || !hadTitleArtist) addedRecordCount += 1;
  }

  return {
    ...index,
    source: {
      ...(index?.source || {}),
      supplementalKnownSongsPath: "config/song-search-known-overrides.json",
    },
    recordCount: (Number(index?.recordCount) || 0) + addedRecordCount,
    titleKeyCount: titleKeys.size,
    titleArtistKeyCount: titleArtistKeys.size,
    titleKeys: [...titleKeys].sort(),
    titleArtistKeys: [...titleArtistKeys].sort(),
    supplementalKnownSongCount: records.length,
    supplementalKnownSongs: records,
  };
}

function normalizeSupplementalKnownSongs(records) {
  return (Array.isArray(records) ? records : [])
    .map((record) => ({
      title: cleanText(record?.title),
      artist: cleanText(record?.artist),
      reason: cleanText(record?.reason),
      reviewedAt: cleanText(record?.reviewedAt),
    }))
    .filter((record) => record.title);
}

function annotatePayloadWithSongSearchNiche(payload, index, aliasContext = loadSongAliasContext()) {
  const lookup = createSongSearchLookup(index);
  if (!payload || !lookup.available) return payload;
  return {
    ...payload,
    groups: Object.fromEntries(
      Object.entries(payload.groups || {}).map(([groupId, group]) => [groupId, annotateGroupWithSongSearchNiche(group, lookup, aliasContext)]),
    ),
  };
}

function annotateGroupWithSongSearchNiche(group, lookup, aliasContext = null) {
  return {
    ...group,
    items: (group.items || []).map((item) => ({
      ...item,
      songs: (item.songs || []).map((song) => {
        const canonical = canonicalizeSongIdentity(song, aliasContext);
        return {
          ...canonical,
          isNiche: !isKnownSong(canonical, lookup),
        };
      }),
    })),
  };
}

function isKnownSong(song, lookup) {
  return isSongSearchKnown(song, lookup);
}

function isSongSearchIndexAvailable(index) {
  return Boolean(index?.titleKeys?.length || index?.titleArtistKeys?.length);
}

function songSearchSourceSummary(index) {
  return {
    repository: SOURCE_REPOSITORY,
    indexUrl: SOURCE_INDEX_URL,
    rawIndexUrl: RAW_SOURCE_INDEX_URL,
    pagesBaseUrl: PAGES_BASE_URL,
    workflowUrl: SOURCE_WORKFLOW_URL,
    generatedAt: index?.generatedAt || "",
    stale: Boolean(index?.stale),
    refreshError: index?.refreshError || "",
    manifestFileCount: index?.manifestFileCount || index?.fileCount || 0,
    fileCount: index?.fileCount || 0,
    skippedFileCount: index?.skippedFileCount || 0,
    recordCount: index?.recordCount || 0,
    titleKeyCount: index?.titleKeyCount || 0,
    titleArtistKeyCount: index?.titleArtistKeyCount || 0,
    supplementalKnownSongCount: index?.supplementalKnownSongCount || 0,
  };
}

function emptySongSearchIndex(options = {}) {
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt || new Date().toISOString(),
    source: {
      repository: SOURCE_REPOSITORY,
      branch: SOURCE_BRANCH,
      indexUrl: SOURCE_INDEX_URL,
      rawIndexUrl: RAW_SOURCE_INDEX_URL,
      pagesBaseUrl: PAGES_BASE_URL,
      rawBaseUrl: RAW_BASE_URL,
      workflowUrl: SOURCE_WORKFLOW_URL,
    },
    manifestFileCount: 0,
    fileCount: 0,
    files: [],
    skippedFileCount: 0,
    skippedFiles: [],
    recordCount: 0,
    titleKeyCount: 0,
    titleArtistKeyCount: 0,
    titleKeys: [],
    titleArtistKeys: [],
    samples: [],
    refreshError: options.refreshError || "",
  };
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: headers() });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: headers() });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.text();
}

async function fetchFirstJson(fetchImpl, urls) {
  return fetchFirst(urls, (url) => fetchJson(fetchImpl, url));
}

async function fetchFirstText(fetchImpl, urls) {
  return fetchFirst(urls, (url) => fetchText(fetchImpl, url));
}

async function fetchFirst(urls, loader) {
  const errors = [];
  for (const url of urls) {
    try {
      return await loader(url);
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(errors.join("; "));
}

async function mapWithConcurrency(items, concurrency, handler) {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await handler(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

function entryKey(titleKey, artistKey) {
  return `${titleKey}::${artistKey || ""}`;
}

function isUnknownArtistKey(value) {
  return new Set(["", "unknown", "na", "n/a", "none", "null", "未記載", "未记载", "不明", "なし", "无"]).has(value);
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function uniqueValues(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function positiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function headers() {
  return {
    "user-agent": "daily-song-list song-search-index",
    accept: "application/vnd.github.raw, text/plain;q=0.9, */*;q=0.8",
  };
}

module.exports = {
  SOURCE_INDEX_URL,
  SOURCE_REPOSITORY,
  SUPPLEMENTAL_KNOWN_SONGS_PATH,
  SOURCE_WORKFLOW_URL,
  annotatePayloadWithSongSearchNiche,
  buildSongSearchIndex,
  fetchSongSearchIndex,
  isSongSearchIndexAvailable,
  loadSupplementalKnownSongs,
  mergeSupplementalKnownSongs,
  parseSongSearchDataFile,
  refreshSongSearchIndex,
  songSearchSourceSummary,
};
