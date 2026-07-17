const { sha256, stableStringify } = require("./cache");

const SOURCE_SYSTEM = "vsinger-moment.mcp-public";
const EXTERNAL_SONG_SCHEMA_VERSION = "vsinger-moment.external-song.v1";
const FORBIDDEN_RANKING_FACT_FIELDS = [
  "rank",
  "ranking",
  "score",
  "internalCount",
  "songCount",
  "singingCount",
  "performanceCount",
  "viewCount",
  "publishedTimestamp",
  "videoValid",
];

function rawHash(value) {
  return sha256(stableStringify(value));
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values.flatMap((item) => (Array.isArray(item) ? item : [item]))) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function pickString(source, keys, fallback = null) {
  for (const key of keys) {
    const value = source && source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

function pickNumber(source, keys) {
  for (const key of keys) {
    const value = source && source[key];
    if (Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function getCandidateSongId(raw) {
  return pickString(raw, ["externalSongId", "songId", "id", "slug", "sourceId"]);
}

function getSourcePageUrl(raw, externalSongId) {
  const directUrl = pickString(raw, ["sourcePageUrl", "pageUrl", "url", "songUrl", "sourceUrl"]);
  if (directUrl) {
    return directUrl.startsWith("http") ? directUrl : `https://vsinger-moment.jp${directUrl}`;
  }
  return externalSongId ? `https://vsinger-moment.jp/songs/${encodeURIComponent(externalSongId)}` : null;
}

function latestPerformanceAt(raw) {
  const direct = pickString(raw, ["latestPerformanceAt", "lastPerformanceAt", "latestSungAt", "lastSungAt", "latestSungDate"]);
  if (direct) {
    return direct;
  }
  const performances = Array.isArray(raw && raw.performances)
    ? raw.performances
    : Array.isArray(raw && raw.singingHistory)
      ? raw.singingHistory
      : [];
  const timestamps = performances
    .map((item) => pickString(item, ["performedAt", "sungAt", "streamedAt", "date", "publishedAt"]))
    .filter(Boolean)
    .sort();
  return timestamps.length ? timestamps[timestamps.length - 1] : null;
}

function singingCountReference(raw) {
  const count = pickNumber(raw, [
    "singingCountReference",
    "singingCount",
    "streamCount",
    "performanceCount",
    "totalPerformances",
    "count",
  ]);
  if (count === null) {
    return null;
  }
  return {
    value: count,
    purpose: "quality_reference_only",
    note: "Reference only for data quality, prioritization, and conflict reports. It must not feed local ranking or local collection counts.",
  };
}

function normalizeExternalSong(raw, options = {}) {
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  const externalSongId = getCandidateSongId(raw);
  const title = pickString(raw, ["title", "songTitle", "name"]);
  const artist = pickString(raw, ["artist", "artistName", "originalArtist", "originalArtistName", "composer"]);
  const sourcePageUrl = getSourcePageUrl(raw, externalSongId);
  const titleAliases = uniqueStrings([raw && raw.titleAliases, raw && raw.aliases, raw && raw.kanaTitle, raw && raw.romajiTitle]);
  const artistAliases = uniqueStrings([
    raw && raw.artistAliases,
    raw && raw.originalArtistAliases,
    raw && raw.artistKana,
    raw && raw.artistRomaji,
  ]);

  return {
    externalSongId,
    title,
    artist,
    titleAliases,
    artistAliases,
    latestPerformanceAt: latestPerformanceAt(raw),
    singingCountReference: singingCountReference(raw),
    sourcePageUrl,
    sourceSystem: SOURCE_SYSTEM,
    fetchedAt,
    rawHash: rawHash(raw),
    schemaVersion: EXTERNAL_SONG_SCHEMA_VERSION,
  };
}

function validateExternalSong(song) {
  const errors = [];
  for (const key of ["externalSongId", "title", "sourceSystem", "fetchedAt", "rawHash", "schemaVersion"]) {
    if (!song[key]) {
      errors.push(`${key} is required`);
    }
  }
  if (song.sourceSystem !== SOURCE_SYSTEM) {
    errors.push(`sourceSystem must be ${SOURCE_SYSTEM}`);
  }
  if (song.schemaVersion !== EXTERNAL_SONG_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${EXTERNAL_SONG_SCHEMA_VERSION}`);
  }
  return errors;
}

function assertNoRankingFactFields(value, path = "external") {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RANKING_FACT_FIELDS.includes(key)) {
      throw new Error(`${path}.${key} must not be exported from VSinger Moment adapter as a local ranking or fact field`);
    }
    assertNoRankingFactFields(child, `${path}.${key}`);
  }
}

function buildProvenanceEnvelope({ toolName, arguments: args, result, fetchedAt = new Date().toISOString() }) {
  return {
    sourceSystem: SOURCE_SYSTEM,
    endpoint: "https://vsinger-moment.jp/api/mcp-public",
    toolName,
    arguments: args || {},
    fetchedAt,
    rawHash: rawHash(result),
    result,
  };
}

module.exports = {
  EXTERNAL_SONG_SCHEMA_VERSION,
  FORBIDDEN_RANKING_FACT_FIELDS,
  SOURCE_SYSTEM,
  assertNoRankingFactFields,
  buildProvenanceEnvelope,
  normalizeExternalSong,
  rawHash,
  singingCountReference,
  stableStringify,
  uniqueStrings,
  validateExternalSong,
};
