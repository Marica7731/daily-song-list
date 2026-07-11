const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const INDEX_PATH = path.join(DATA_DIR, "snapshots", "index.json");
const SONG_SEARCH_INDEX_PATH = path.join(DATA_DIR, "song-search-known-songs.json");

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
