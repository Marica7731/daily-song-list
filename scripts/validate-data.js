const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const INDEX_PATH = path.join(DATA_DIR, "snapshots", "index.json");
const SONG_SEARCH_INDEX_PATH = path.join(DATA_DIR, "song-search-known-songs.json");
const DIFF_PATHS = {
  "72h": path.join(DATA_DIR, "diff", "latest-72h.json"),
  "1m": path.join(DATA_DIR, "diff", "latest-1m.json"),
};

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
  if (entry.label !== undefined && typeof entry.label !== "string") errors.push(`${label}.label must be string`);
  if (!isNullablePositiveInteger(entry.previousRank)) errors.push(`${label}.previousRank must be positive integer or null`);
  if (!isPositiveInteger(entry.currentRank)) errors.push(`${label}.currentRank must be positive integer`);
  if (!isNullableInteger(entry.rankDelta)) errors.push(`${label}.rankDelta must be integer or null`);
  if (!isNonNegativeInteger(entry.previousCount)) errors.push(`${label}.previousCount must be non-negative integer`);
  if (!isNonNegativeInteger(entry.currentCount)) errors.push(`${label}.currentCount must be non-negative integer`);
  if (!Number.isInteger(entry.countDelta)) errors.push(`${label}.countDelta must be integer`);
  if (typeof entry.isNew !== "boolean") errors.push(`${label}.isNew must be boolean`);
  if (Number.isInteger(entry.currentCount) && Number.isInteger(entry.previousCount) && entry.countDelta !== entry.currentCount - entry.previousCount) {
    errors.push(`${label}.countDelta must equal currentCount - previousCount`);
  }
  if (entry.previousRank === null && entry.rankDelta !== null) errors.push(`${label}.rankDelta must be null when previousRank is null`);
  if (Number.isInteger(entry.previousRank) && Number.isInteger(entry.currentRank) && entry.rankDelta !== entry.previousRank - entry.currentRank) {
    errors.push(`${label}.rankDelta must equal previousRank - currentRank`);
  }
  if (entry.isNew !== (entry.previousRank === null)) errors.push(`${label}.isNew must match previousRank null state`);
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
