const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const INDEX_PATH = path.join(DATA_DIR, "snapshots", "index.json");
const SONG_SEARCH_INDEX_PATH = path.join(DATA_DIR, "song-search-known-songs.json");
const UI_META_PATH = path.join(DATA_DIR, "ui", "meta.json");
const DIFF_PATHS = {
  "72h": path.join(DATA_DIR, "diff", "latest-72h.json"),
  "1m": path.join(DATA_DIR, "diff", "latest-1m.json"),
};
const RUNTIME_VIDEO_FIELDS = new Set([
  "videoId",
  "title",
  "channelName",
  "channelId",
  "channelHandle",
  "channelUrl",
  "keyword",
  "publishedText",
  "thumbnailUrl",
  "songs",
]);
const RUNTIME_SONG_FIELDS = new Set(["seconds", "title", "artist", "isNiche"]);
const MONTH_SEARCH_URLS = new Set([
  "https://www.youtube.com/results?search_query=%E6%AD%8C%E6%9E%A0&sp=CAMSBggEEAEYAg%253D%253D",
  "https://www.youtube.com/results?search_query=%E5%BC%BE%E3%81%8D%E8%AA%9E%E3%82%8A&sp=CAMSBggEEAEYAg%253D%253D",
]);

const payload = readJson(LATEST_PATH);
const errors = [];

if (payload.schemaVersion !== 1) errors.push("latest.schemaVersion must be 1");
if (!payload.groups || typeof payload.groups !== "object") errors.push("latest.groups missing");
for (const groupId of ["72h", "1m"]) {
  const group = payload.groups?.[groupId];
  if (!group) {
    errors.push(`groups.${groupId} missing`);
    continue;
  }
  if (!Array.isArray(group.items)) errors.push(`groups.${groupId}.items must be array`);
  for (const [videoIndex, item] of (group.items || []).entries()) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(item.videoId || "")) errors.push(`${groupId}[${videoIndex}].videoId invalid`);
    if (!Array.isArray(item.songs) || item.songs.length <= 0) errors.push(`${groupId}[${videoIndex}].songs empty`);
    if (groupId === "1m" && !hasMonthlySearchSource(item)) {
      errors.push(`${groupId}[${videoIndex}].sourceUrls must include a YouTube monthly search URL`);
    }
    for (const [songIndex, song] of (item.songs || []).entries()) {
      if (!song.title) errors.push(`${groupId}[${videoIndex}].songs[${songIndex}].title missing`);
      if (!Number.isInteger(song.seconds) || song.seconds < 0) errors.push(`${groupId}[${videoIndex}].songs[${songIndex}].seconds invalid`);
      if (!/^\d+:\d{2}:\d{2}$/.test(song.time || "")) errors.push(`${groupId}[${videoIndex}].songs[${songIndex}].time invalid`);
      if (song.isNiche !== undefined && typeof song.isNiche !== "boolean") {
        errors.push(`${groupId}[${videoIndex}].songs[${songIndex}].isNiche must be boolean`);
      }
    }
  }
}

const index = readJson(INDEX_PATH);
if (index.cadence !== "hourly") errors.push("snapshot index cadence must be hourly");
if (!Array.isArray(index.snapshots) || !index.snapshots.length) errors.push("snapshot index has no snapshots");
for (const entry of index.snapshots || []) {
  if (!/^[0-9]{8}T[0-9]{4}00Z$/.test(entry.id || "")) errors.push(`invalid snapshot id: ${entry.id}`);
  const snapshotPath = path.join(ROOT, entry.path || "");
  if (!fs.existsSync(snapshotPath)) errors.push(`missing snapshot file: ${entry.path}`);
}

for (const [groupId, diffPath] of Object.entries(DIFF_PATHS)) {
  validateDiffFile(groupId, diffPath);
}

validateRuntimeUiFiles();

if (fs.existsSync(SONG_SEARCH_INDEX_PATH)) {
  const songSearchIndex = readJson(SONG_SEARCH_INDEX_PATH);
  if (songSearchIndex.schemaVersion !== 1) errors.push("song-search index schemaVersion must be 1");
  if (!Array.isArray(songSearchIndex.titleKeys)) errors.push("song-search index titleKeys must be array");
  if (!Array.isArray(songSearchIndex.titleArtistKeys)) errors.push("song-search index titleArtistKeys must be array");
}

if (errors.length) {
  for (const error of errors) console.error(`[validate] ${error}`);
  process.exit(1);
}

console.log(
  `[validate] ok 72h=${payload.groups["72h"].items.length} 1m=${payload.groups["1m"].items.length} snapshots=${index.snapshots.length}`,
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function hasMonthlySearchSource(item) {
  return listValues(item.sourceUrls).some((url) => MONTH_SEARCH_URLS.has(url));
}

function listValues(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function validateDiffFile(groupId, diffPath) {
  if (!fs.existsSync(diffPath)) {
    errors.push(`missing diff file: data/diff/latest-${groupId}.json`);
    return;
  }
  const diff = readJson(diffPath);
  if (diff.schemaVersion !== 1) errors.push(`diff.${groupId}.schemaVersion must be 1`);
  if (diff.range !== groupId) errors.push(`diff.${groupId}.range must be ${groupId}`);
  if (typeof diff.generatedAt !== "string") errors.push(`diff.${groupId}.generatedAt must be string`);
  if (typeof diff.capturedAt !== "string") errors.push(`diff.${groupId}.capturedAt must be string`);
  if (!diff.current || typeof diff.current !== "object") errors.push(`diff.${groupId}.current must be object`);
  if (diff.previous !== null && (typeof diff.previous !== "object" || Array.isArray(diff.previous))) {
    errors.push(`diff.${groupId}.previous must be object or null`);
  }
  validateDiffRankList(groupId, "songRank", diff.songRank);
  validateDiffRankList(groupId, "artistRank", diff.artistRank);
}

function validateDiffRankList(groupId, listName, entries) {
  if (!Array.isArray(entries)) {
    errors.push(`diff.${groupId}.${listName} must be array`);
    return;
  }
  for (const [entryIndex, entry] of entries.entries()) {
    validateDiffRankEntry(`diff.${groupId}.${listName}[${entryIndex}]`, entry);
  }
}

function validateDiffRankEntry(label, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push(`${label} must be object`);
    return;
  }
  if (typeof entry.entityKey !== "string" || !entry.entityKey) errors.push(`${label}.entityKey must be non-empty string`);
  for (const removedField of ["label", "previousRank", "currentRank", "previousCount", "currentCount"]) {
    if (removedField in entry) errors.push(`${label}.${removedField} must not be present in compact diff`);
  }
  if (!isNullableInteger(entry.rankDelta)) errors.push(`${label}.rankDelta must be integer or null`);
  if (!Number.isInteger(entry.countDelta)) errors.push(`${label}.countDelta must be integer`);
  if (typeof entry.isNew !== "boolean") errors.push(`${label}.isNew must be boolean`);
  if (entry.rankDelta === 0 && entry.countDelta === 0 && entry.isNew === false) {
    errors.push(`${label} must omit unchanged compact diff entries`);
  }
}

function validateRuntimeUiFiles() {
  if (!fs.existsSync(UI_META_PATH)) {
    errors.push("missing runtime UI meta: data/ui/meta.json");
    return;
  }
  const meta = readJson(UI_META_PATH);
  if (meta.schemaVersion !== 1) errors.push("ui.meta.schemaVersion must be 1");
  if (typeof meta.generatedAt !== "string") errors.push("ui.meta.generatedAt must be string");
  if (typeof meta.capturedAt !== "string") errors.push("ui.meta.capturedAt must be string");
  if (meta.status !== null && (typeof meta.status !== "object" || Array.isArray(meta.status))) {
    errors.push("ui.meta.status must be object or null");
  }
  if (!Number.isInteger(meta.filterVersion)) errors.push("ui.meta.filterVersion must be integer");
  if (typeof meta.nicheAnnotated !== "boolean") errors.push("ui.meta.nicheAnnotated must be boolean");

  for (const groupId of ["72h", "1m"]) {
    const rangeMeta = meta.ranges?.[groupId];
    if (!rangeMeta) {
      errors.push(`ui.meta.ranges.${groupId} missing`);
      continue;
    }
    const expectedPath = `data/ui/${groupId}.json`;
    if (rangeMeta.path !== expectedPath) errors.push(`ui.meta.ranges.${groupId}.path must be ${expectedPath}`);
    if (!Number.isInteger(rangeMeta.itemCount) || rangeMeta.itemCount < 0) {
      errors.push(`ui.meta.ranges.${groupId}.itemCount must be non-negative integer`);
    }
    if (meta.diffs?.[groupId]?.path !== `data/diff/latest-${groupId}.json`) {
      errors.push(`ui.meta.diffs.${groupId}.path invalid`);
    }
    validateRuntimeRangeFile(groupId, rangeMeta);
  }
}

function validateRuntimeRangeFile(groupId, rangeMeta) {
  const relativePath = rangeMeta?.path || `data/ui/${groupId}.json`;
  const filePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(filePath)) {
    errors.push(`missing runtime UI range: ${relativePath}`);
    return;
  }
  const range = readJson(filePath);
  if (range.schemaVersion !== 1) errors.push(`ui.${groupId}.schemaVersion must be 1`);
  if (range.id !== groupId) errors.push(`ui.${groupId}.id must be ${groupId}`);
  if (typeof range.generatedAt !== "string") errors.push(`ui.${groupId}.generatedAt must be string`);
  if (typeof range.capturedAt !== "string") errors.push(`ui.${groupId}.capturedAt must be string`);
  if (!Number.isInteger(range.filterVersion)) errors.push(`ui.${groupId}.filterVersion must be integer`);
  if (typeof range.nicheAnnotated !== "boolean") errors.push(`ui.${groupId}.nicheAnnotated must be boolean`);
  if (!Array.isArray(range.items)) {
    errors.push(`ui.${groupId}.items must be array`);
    return;
  }
  if (Number.isInteger(rangeMeta?.itemCount) && range.items.length !== rangeMeta.itemCount) {
    errors.push(`ui.${groupId}.items length must match meta itemCount`);
  }
  for (const [videoIndex, item] of range.items.entries()) {
    validateAllowedFields(`ui.${groupId}.items[${videoIndex}]`, item, RUNTIME_VIDEO_FIELDS);
    if (!/^[A-Za-z0-9_-]{11}$/.test(item.videoId || "")) errors.push(`ui.${groupId}[${videoIndex}].videoId invalid`);
    if (!Array.isArray(item.songs) || item.songs.length <= 0) errors.push(`ui.${groupId}[${videoIndex}].songs empty`);
    for (const [songIndex, song] of (item.songs || []).entries()) {
      validateAllowedFields(`ui.${groupId}.items[${videoIndex}].songs[${songIndex}]`, song, RUNTIME_SONG_FIELDS);
      if (!Number.isInteger(song.seconds) || song.seconds < 0) {
        errors.push(`ui.${groupId}[${videoIndex}].songs[${songIndex}].seconds invalid`);
      }
      if (!song.title) errors.push(`ui.${groupId}[${videoIndex}].songs[${songIndex}].title missing`);
      if (typeof song.isNiche !== "boolean") errors.push(`ui.${groupId}[${videoIndex}].songs[${songIndex}].isNiche must be boolean`);
      for (const removedField of ["index", "time", "raw"]) {
        if (removedField in song) errors.push(`ui.${groupId}[${videoIndex}].songs[${songIndex}].${removedField} must not be present`);
      }
    }
  }
}

function validateAllowedFields(label, value, allowedFields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be object`);
    return;
  }
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) errors.push(`${label}.${field} is not allowed in runtime UI data`);
  }
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isNullablePositiveInteger(value) {
  return value === null || isPositiveInteger(value);
}

function isNullableInteger(value) {
  return value === null || Number.isInteger(value);
}
