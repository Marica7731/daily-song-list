const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const DEFAULT_SCHEMA_VERSION = 1;
const DEFAULT_SOURCE_CHUNK_SIZE = 20;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/u;

function writeSourceEntityShardSet(options = {}) {
  const {
    rootDir = process.cwd(),
    rangeId = "",
    dataVersion = "",
    generatedAt = "",
    capturedAt = "",
    records = [],
    chunkSize = DEFAULT_SOURCE_CHUNK_SIZE,
    schemaVersion = DEFAULT_SCHEMA_VERSION,
  } = options;
  const mergedRecords = mergeSourceRecords(records);
  const entries = [];
  for (const record of mergedRecords) {
    const written = writeSourceEntityShard({
      rootDir,
      rangeId,
      dataVersion,
      generatedAt,
      capturedAt,
      record,
      chunkSize,
      schemaVersion,
    });
    entries.push(written);
  }
  return {
    schemaVersion,
    kind: "request-source-entity-shards",
    rangeId,
    dataVersion,
    generatedAt,
    capturedAt,
    chunkSize,
    itemCount: entries.length,
    totalSourceCount: entries.reduce((sum, entry) => sum + entry.sourceCount, 0),
    records: entries.map((entry) => ({
      key: entry.key,
      songIdentityKey: entry.songIdentityKey,
      path: entry.manifestPath,
      manifestPath: entry.manifestPath,
      sha256: entry.sha256,
      bytes: entry.bytes,
      sourceCount: entry.sourceCount,
      chunkCount: entry.chunkCount,
    })),
    pathByKey: new Map(entries.map((entry) => [entry.key, entry.manifestPath])),
  };
}

function writeSourceEntityShard(options = {}) {
  const {
    rootDir = process.cwd(),
    rangeId = "",
    dataVersion = "",
    generatedAt = "",
    capturedAt = "",
    record = {},
    chunkSize = DEFAULT_SOURCE_CHUNK_SIZE,
    schemaVersion = DEFAULT_SCHEMA_VERSION,
  } = options;
  const key = cleanText(record.key || record.songIdentityKey);
  if (!key) throw new Error("source entity shard record missing key");
  const songIdentityKey = cleanText(record.songIdentityKey || key);
  const prefix = sourceEntityPrefix(songIdentityKey);
  const segment = encodePathSegment(songIdentityKey);
  const baseDir = `data/ui/ranges/${encodePathSegment(rangeId)}/sources/${prefix}/${segment}`;
  const sources = buildSlimSourceEntries(record.occurrences || []);
  const chunks = chunkArray(sources, chunkSize);
  const chunkEntries = [];
  chunks.forEach((chunk, index) => {
    const chunkIndex = index + 1;
    const payload = {
      schemaVersion,
      kind: "source-detail-chunk-v3",
      range: rangeId,
      rangeId,
      dataVersion,
      songIdentityKey,
      chunkIndex,
      chunkCount: chunks.length,
      sourceCount: chunk.length,
      sources: chunk,
      generatedAt,
      capturedAt,
    };
    const text = stableJson(payload);
    const sha256 = sha256Text(text);
    const fileName = `chunk-${String(chunkIndex).padStart(4, "0")}.${sha256.slice(0, 12)}.json`;
    const chunkPath = `${baseDir}/${fileName}`;
    writeText(path.join(rootDir, chunkPath), text);
    chunkEntries.push({
      index: chunkIndex,
      path: chunkPath,
      sha256,
      bytes: Buffer.byteLength(text, "utf8"),
      gzipBytes: gzipBytes(text),
      sourceCount: chunk.length,
    });
  });

  const contentSha256 = sha256Text(stableJson({
    songIdentityKey,
    chunks: chunkEntries.map(({ index, sha256, sourceCount }) => ({ index, sha256, sourceCount })),
  }));
  const manifest = {
    schemaVersion,
    kind: "source-detail-manifest-v3",
    range: rangeId,
    rangeId,
    dataVersion,
    songIdentityKey,
    sourceCount: sources.length,
    chunkSize,
    chunkCount: chunkEntries.length,
    chunks: chunkEntries,
    generatedAt,
    capturedAt,
    sha256: contentSha256,
  };
  const manifestText = stableJson(manifest);
  const manifestSha256 = sha256Text(manifestText);
  const hashedManifestPath = `${baseDir}/manifest.${manifestSha256.slice(0, 12)}.json`;
  writeText(path.join(rootDir, hashedManifestPath), manifestText);
  return {
    key,
    songIdentityKey,
    prefix,
    manifestPath: hashedManifestPath,
    manifestLegacyPath: `${baseDir}/manifest.json`,
    sha256: manifestSha256,
    bytes: Buffer.byteLength(manifestText, "utf8"),
    gzipBytes: gzipBytes(manifestText),
    sourceCount: sources.length,
    chunkCount: chunkEntries.length,
    chunks: chunkEntries,
  };
}

function writeVideoSetlistFiles(options = {}) {
  const {
    rootDir = process.cwd(),
    items = [],
    dataVersion = "",
    generatedAt = "",
    schemaVersion = DEFAULT_SCHEMA_VERSION,
  } = options;
  const bestByVideoId = new Map();
  for (const item of items || []) {
    const videoId = cleanText(item?.videoId);
    if (!VIDEO_ID_RE.test(videoId)) continue;
    const current = bestByVideoId.get(videoId);
    if (!current || (item.songs || []).length > (current.songs || []).length) bestByVideoId.set(videoId, item);
  }
  const records = [];
  for (const [videoId, item] of [...bestByVideoId.entries()].sort(([a], [b]) => compareValues(a, b))) {
    const payload = {
      schemaVersion,
      kind: "video-setlist",
      videoId,
      title: cleanText(item.title),
      channelName: cleanText(item.channelName),
      songs: normalizeSetlistSongs(item.songs || []),
      dataVersion,
      generatedAt,
    };
    const text = stableJson(payload);
    const filePath = videoSetlistPath(videoId);
    writeText(path.join(rootDir, filePath), text);
    records.push({
      videoId,
      path: filePath,
      sha256: sha256Text(text),
      bytes: Buffer.byteLength(text, "utf8"),
      gzipBytes: gzipBytes(text),
      songCount: payload.songs.length,
    });
  }
  return {
    schemaVersion,
    kind: "video-setlists",
    dataVersion,
    generatedAt,
    itemCount: records.length,
    records,
  };
}

function mergeSourceRecords(records = []) {
  const byKey = new Map();
  for (const record of records || []) {
    const key = cleanText(record?.key || record?.songIdentityKey);
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        songIdentityKey: cleanText(record.songIdentityKey || key),
        occurrences: [],
      });
    }
    byKey.get(key).occurrences.push(...(record.occurrences || []));
  }
  return [...byKey.values()].sort((a, b) => compareValues(a.key, b.key));
}

function buildSlimSourceEntries(occurrences = []) {
  const groups = new Map();
  for (const occurrence of occurrences || []) {
    const item = occurrence?.item || {};
    const videoId = cleanText(item.videoId);
    const fallbackKey = `${cleanText(item.channelName)}::${cleanText(item.title)}`;
    const key = videoId || fallbackKey;
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        item,
        timepoints: [],
      });
    }
    groups.get(key).timepoints.push(buildTimepoint(occurrence?.song || {}));
  }
  return [...groups.values()]
    .map((group) => buildSlimSourceEntry(group))
    .sort(compareSlimSources);
}

function buildSlimSourceEntry(group) {
  const item = group.item || {};
  const entry = {
    videoId: cleanText(item.videoId),
    channelName: cleanText(item.channelName),
    publishedTimestamp: finiteTimestamp(item.publishedTimestamp ?? item.publishedAt ?? item.publishedTime),
    videoTitle: summarizeText(item.title || item.videoTitle || item.videoId, 96),
    timepoints: normalizeTimepoints(group.timepoints),
    firstSeenAt: cleanText(item.catalogFirstSeenAt || item.firstSeenAt || item.discoveredAt),
  };
  const channelId = cleanText(item.channelId);
  const channelHandle = cleanText(item.channelHandle);
  if (channelId) entry.channelId = channelId;
  if (!channelId && channelHandle) entry.channelHandle = channelHandle;
  const status = compactSourceStatus(item);
  if (Object.keys(status).length) entry.status = status;
  return removeEmptyFields(entry);
}

function compactSourceStatus(item = {}) {
  const status = {};
  if (item.carriedFromPrevious === true) status.carriedFromPrevious = true;
  const sourceType = cleanText(item.sourceQuality?.sourceType || item.sourceType);
  if (sourceType) status.sourceType = sourceType;
  return status;
}

function buildTimepoint(song = {}) {
  return {
    seconds: Math.max(0, Math.floor(Number(song.seconds) || 0)),
    title: cleanText(song.title),
    artist: cleanText(song.artist),
    isNiche: song.isNiche === true,
  };
}

function normalizeTimepoints(timepoints = []) {
  const seen = new Set();
  const result = [];
  for (const timepoint of timepoints || []) {
    const seconds = Math.max(0, Math.floor(Number(timepoint.seconds) || 0));
    const title = cleanText(timepoint.title);
    if (!title) continue;
    const artist = cleanText(timepoint.artist);
    const key = `${seconds}::${title}::${artist}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const normalized = { seconds, title };
    if (artist) normalized.artist = artist;
    if (timepoint.isNiche === true) normalized.isNiche = true;
    result.push(normalized);
  }
  return result.sort((a, b) => a.seconds - b.seconds || compareValues(a.title, b.title) || compareValues(a.artist, b.artist));
}

function normalizeSetlistSongs(songs = []) {
  return normalizeTimepoints(songs).map((song) => ({
    seconds: song.seconds,
    title: song.title,
    ...(song.artist ? { artist: song.artist } : {}),
    ...(song.isNiche ? { isNiche: true } : {}),
  }));
}

function compareSlimSources(a, b) {
  return (
    compareTimestampDesc(a.publishedTimestamp, b.publishedTimestamp) ||
    compareTimestampDesc(a.firstSeenAt, b.firstSeenAt) ||
    compareValues(a.videoId, b.videoId) ||
    compareValues(a.channelName, b.channelName)
  );
}

function compareTimestampDesc(a, b) {
  const timeA = timestampValue(a);
  const timeB = timestampValue(b);
  if (timeA === timeB) return 0;
  if (timeA === null) return 1;
  if (timeB === null) return -1;
  return timeB - timeA;
}

function timestampValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteTimestamp(value) {
  const time = timestampValue(value);
  return time === null ? null : time;
}

function sourceEntityPrefix(songIdentityKey) {
  return sha256Text(String(songIdentityKey || "")).slice(0, 2);
}

function videoSetlistPath(videoId) {
  const safeVideoId = cleanText(videoId);
  const prefix = encodePathSegment(safeVideoId.slice(0, 2) || "__");
  return `data/ui/video-setlists/${prefix}/${encodePathSegment(safeVideoId)}.json`;
}

function summarizeText(value, maxLength) {
  const text = cleanText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function removeEmptyFields(value) {
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === "" || item === undefined) continue;
    if (item === null && key !== "publishedTimestamp") continue;
    if (Array.isArray(item) && item.length === 0) continue;
    result[key] = item;
  }
  return result;
}

function chunkArray(items, pageSize) {
  const size = Math.max(1, Number(pageSize) || DEFAULT_SOURCE_CHUNK_SIZE);
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks.length ? chunks : [[]];
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function stableJson(value) {
  return JSON.stringify(value);
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function gzipBytes(text) {
  return zlib.gzipSync(Buffer.from(String(text), "utf8")).length;
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value || ""));
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function compareValues(a, b) {
  return String(a || "").localeCompare(String(b || ""), "en", {
    numeric: true,
    sensitivity: "base",
  });
}

module.exports = {
  DEFAULT_SOURCE_CHUNK_SIZE,
  buildSlimSourceEntries,
  mergeSourceRecords,
  sourceEntityPrefix,
  videoSetlistPath,
  writeSourceEntityShardSet,
  writeVideoSetlistFiles,
};
