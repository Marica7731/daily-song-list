const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { BLOCKLIST_HASH, BLOCKLIST_VERSION, matchBlockedSource } = require("../assets/source-filter");
const { NON_SONG_RULES_PATH, OVERRIDES_PATH, validateCurationOverrides } = require("./curation");
const { KNOWN_SONG_ARTIST_OVERRIDES_PATH, validateKnownSongArtistOverrides } = require("./entry-repair");
const { SONG_ALIASES_PATH, canonicalizeSongIdentity, loadSongAliasContext, validateSongAliasConfig } = require("./song-aliases");
const { SUPPLEMENTAL_KNOWN_SONGS_PATH, loadSupplementalKnownSongs } = require("./song-search-index");
const { CATALOG_RETENTION_POLICY, MONTH_CATALOG_DAYS, VIDEO_CATALOG_PATH, isWithinCatalogWindow } = require("./video-catalog");
const { CANONICAL_RANGES, DIFF_RANGES, groupForRange } = require("./range-config");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const INDEX_PATH = path.join(DATA_DIR, "snapshots", "index.json");
const SONG_SEARCH_INDEX_PATH = path.join(DATA_DIR, "song-search-known-songs.json");
const UI_META_PATH = path.join(DATA_DIR, "ui", "meta.json");
const RANGES = CANONICAL_RANGES;
const DIFF_PATHS = Object.fromEntries(DIFF_RANGES.map((range) => [range.id, path.join(DATA_DIR, "diff", range.file)]));
const BRACKET_PAIRS = [
  ["【", "】"],
  ["［", "］"],
  ["[", "]"],
  ["「", "」"],
  ["『", "』"],
];
const BRACKET_CLOSE_BY_OPEN = new Map(BRACKET_PAIRS);
const BRACKET_OPEN_BY_CLOSE = new Map(BRACKET_PAIRS.map(([open, close]) => [close, open]));
const RUNTIME_VIDEO_FIELDS = new Set([
  "videoId",
  "title",
  "channelName",
  "channelId",
  "channelHandle",
  "channelUrl",
  "avatarUrl",
  "sourceUrl",
  "knownSourceType",
  "isCollected",
  "keyword",
  "publishedAt",
  "publishedText",
  "publishedTimestamp",
  "timeMissingReason",
  "catalogFirstSeenAt",
  "catalogLastSeenAt",
  "catalogLastInspectedAt",
  "thumbnailUrl",
  "songs",
]);
const RUNTIME_SONG_FIELDS = new Set(["seconds", "title", "artist", "isNiche"]);
const RECENT_WINDOW_DAYS = 7;
const RECENT_WINDOW_MS = RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const scope = parseValidationScope(process.argv.slice(2));

const payload = readJson(LATEST_PATH);
const errors = [];
const songAliasContext = validateSongAliases();
const capturedMs = Date.parse(payload.capturedAt || payload.generatedAt || "");

validateCurationConfig();

if (payload.schemaVersion !== 1) errors.push("latest.schemaVersion must be 1");
if (payload.blocklistVersion !== BLOCKLIST_VERSION) errors.push("latest.blocklistVersion must match current blocklist");
if (payload.blocklistHash !== BLOCKLIST_HASH) errors.push("latest.blocklistHash must match current blocklist");
if (!payload.groups || typeof payload.groups !== "object") errors.push("latest.groups missing");
for (const groupId of RANGES) {
  const group = groupForRange(payload.groups, groupId);
  if (!group) {
    errors.push(`groups.${groupId} missing`);
    continue;
  }
  if (!Array.isArray(group.items)) errors.push(`groups.${groupId}.items must be array`);
  for (const [videoIndex, item] of (group.items || []).entries()) {
    validateNotBlockedSource(`groups.${groupId}[${videoIndex}]`, item);
    if (!/^[A-Za-z0-9_-]{11}$/.test(item.videoId || "")) errors.push(`${groupId}[${videoIndex}].videoId invalid`);
    if (!Array.isArray(item.songs) || item.songs.length <= 0) errors.push(`${groupId}[${videoIndex}].songs empty`);
    if (groupId === "7d" && Number.isFinite(capturedMs) && !isWithinWindow(item.publishedTimestamp, capturedMs, RECENT_WINDOW_MS)) {
      errors.push(`${groupId}[${videoIndex}].publishedTimestamp must be within ${RECENT_WINDOW_DAYS} days`);
    }
    if (groupId === "all" && Number.isFinite(capturedMs) && !isWithinCatalogWindow(item.publishedTimestamp, capturedMs)) {
      errors.push(`${groupId}[${videoIndex}].publishedTimestamp must not be in the future`);
    }
    for (const [songIndex, song] of (item.songs || []).entries()) {
      if (!song.title) errors.push(`${groupId}[${videoIndex}].songs[${songIndex}].title missing`);
      if (!Number.isInteger(song.seconds) || song.seconds < 0) errors.push(`${groupId}[${videoIndex}].songs[${songIndex}].seconds invalid`);
      if (!/^\d+:\d{2}:\d{2}$/.test(song.time || "")) errors.push(`${groupId}[${videoIndex}].songs[${songIndex}].time invalid`);
      if (song.isNiche !== undefined && typeof song.isNiche !== "boolean") {
        errors.push(`${groupId}[${videoIndex}].songs[${songIndex}].isNiche must be boolean`);
      }
      validateSongIdentity(groupId, videoIndex, songIndex, item, song, songAliasContext);
    }
  }
}

const index = readJson(INDEX_PATH);
if (index.cadence !== "hourly") errors.push("snapshot index cadence must be hourly");
if (index.retentionPolicy && index.retentionPolicy !== CATALOG_RETENTION_POLICY) {
  errors.push(`snapshot index retentionPolicy must be ${CATALOG_RETENTION_POLICY}`);
}
if (!index.retentionPolicy && !Number.isInteger(index.retentionDays)) {
  errors.push("snapshot index retentionDays must be integer for legacy indexes");
}
if (!Array.isArray(index.snapshots) || !index.snapshots.length) errors.push("snapshot index has no snapshots");
for (const entry of index.snapshots || []) {
  if (!/^[0-9]{8}T[0-9]{4}00Z$/.test(entry.id || "")) errors.push(`invalid snapshot id: ${entry.id}`);
  const snapshotPath = path.join(ROOT, entry.path || "");
  if (!fs.existsSync(snapshotPath)) errors.push(`missing snapshot file: ${entry.path}`);
}

for (const [groupId, diffPath] of Object.entries(DIFF_PATHS)) {
  if (!shouldValidateDiffFile(groupId, diffPath)) continue;
  validateDiffFile(groupId, diffPath);
}

if (scope !== "review") {
  validateRuntimeUiFiles();
  validateVideoCatalog();
}
if (scope !== "core") validateReviewFiles();

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
  `[validate] ok scope=${scope} 7d=${groupForRange(payload.groups, "7d")?.items?.length || 0} all=${groupForRange(payload.groups, "all")?.items?.length || 0} snapshots=${index.snapshots.length}`,
);

function parseValidationScope(args) {
  if (args.includes("--core")) return "core";
  if (args.includes("--review")) return "review";
  const scopeArg = args.find((arg) => arg.startsWith("--scope="));
  if (scopeArg) {
    const value = scopeArg.slice("--scope=".length);
    if (["all", "core", "review"].includes(value)) return value;
  }
  return "all";
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonIfExists(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function shouldValidateDiffFile(groupId, diffPath) {
  if (fs.existsSync(diffPath)) return true;
  const meta = readJsonIfExists(UI_META_PATH);
  return Boolean(meta?.diffs?.[groupId]);
}

function isWithinWindow(publishedTimestamp, nowMs, windowMs) {
  const time = Number(publishedTimestamp);
  if (!Number.isFinite(time)) return false;
  const age = nowMs - time;
  return age >= 0 && age <= windowMs;
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
  if (!isSha256(meta.dataVersion)) errors.push("ui.meta.dataVersion must be sha256 string");
  if (typeof meta.generatedAt !== "string") errors.push("ui.meta.generatedAt must be string");
  if (typeof meta.capturedAt !== "string") errors.push("ui.meta.capturedAt must be string");
  if (typeof meta.dataCapturedAt !== "string") errors.push("ui.meta.dataCapturedAt must be string");
  if (typeof meta.derivedBuiltAt !== "string") errors.push("ui.meta.derivedBuiltAt must be string");
  if (meta.latestCapture !== null && (typeof meta.latestCapture !== "object" || Array.isArray(meta.latestCapture))) {
    errors.push("ui.meta.latestCapture must be object or null");
  }
  if (meta.latestDerived !== null && (typeof meta.latestDerived !== "object" || Array.isArray(meta.latestDerived))) {
    errors.push("ui.meta.latestDerived must be object or null");
  }
  if (meta.status !== null && (typeof meta.status !== "object" || Array.isArray(meta.status))) {
    errors.push("ui.meta.status must be object or null");
  }
  if (!Number.isInteger(meta.filterVersion)) errors.push("ui.meta.filterVersion must be integer");
  if (typeof meta.nicheAnnotated !== "boolean") errors.push("ui.meta.nicheAnnotated must be boolean");
  if ("curationVersion" in meta && typeof meta.curationVersion !== "string") errors.push("ui.meta.curationVersion must be string");
  if ("curationHash" in meta && typeof meta.curationHash !== "string") errors.push("ui.meta.curationHash must be string");
  if (meta.blocklistVersion !== BLOCKLIST_VERSION) errors.push("ui.meta.blocklistVersion must match current blocklist");
  if (meta.blocklistHash !== BLOCKLIST_HASH) errors.push("ui.meta.blocklistHash must match current blocklist");

  for (const groupId of runtimeRangeIds(meta)) {
    const rangeMeta = meta.ranges?.[groupId];
    if (!rangeMeta) {
      errors.push(`ui.meta.ranges.${groupId} missing`);
      continue;
    }
    const expectedPathPattern = new RegExp(`^data/ui/${groupId}\\.[0-9a-f]{12}\\.json$`, "u");
    if (!expectedPathPattern.test(rangeMeta.path || "")) {
      errors.push(`ui.meta.ranges.${groupId}.path must be content-hashed runtime path`);
    }
    if (rangeMeta.legacyPath !== `data/ui/${groupId}.json`) {
      errors.push(`ui.meta.ranges.${groupId}.legacyPath must be data/ui/${groupId}.json`);
    }
    if (!isSha256(rangeMeta.sha256)) errors.push(`ui.meta.ranges.${groupId}.sha256 must be sha256 string`);
    if (rangeMeta.dataVersion !== meta.dataVersion) {
      errors.push(`ui.meta.ranges.${groupId}.dataVersion must match ui.meta.dataVersion`);
    }
    if (typeof rangeMeta.generatedAt !== "string") errors.push(`ui.meta.ranges.${groupId}.generatedAt must be string`);
    if (!Number.isInteger(rangeMeta.bytes) || rangeMeta.bytes <= 0) {
      errors.push(`ui.meta.ranges.${groupId}.bytes must be positive integer`);
    }
    if (!Number.isInteger(rangeMeta.itemCount) || rangeMeta.itemCount < 0) {
      errors.push(`ui.meta.ranges.${groupId}.itemCount must be non-negative integer`);
    }
    if (meta.diffs?.[groupId] && meta.diffs[groupId].path !== `data/diff/latest-${groupId}.json`) {
      errors.push(`ui.meta.diffs.${groupId}.path invalid`);
    }
    validateRuntimeRangeFile(groupId, rangeMeta, meta);
    validateRuntimeRangeFile(groupId, { ...rangeMeta, path: rangeMeta.legacyPath, sha256: null }, meta, {
      label: `ui.${groupId}.legacy`,
    });
    validateRuntimeShardSet(groupId, rangeMeta, meta);
  }
}

function runtimeRangeIds(meta) {
  const ids = Object.keys(meta.ranges || {});
  return ids.length ? ids : RANGES;
}

function validateRuntimeShardSet(groupId, rangeMeta, meta) {
  const shards = rangeMeta.shards || meta.shards?.ranges?.[groupId] || null;
  if (!shards) return;
  validateRuntimeShardManifest(`${groupId}.runtime`, shards.runtime, groupId, "runtime-page-manifest", "items", meta);
  validateRuntimeShardManifest(`${groupId}.sourceDetails`, shards.sourceDetails, groupId, "source-detail-manifest", "sources", meta);
  validateRuntimeShardManifest(`${groupId}.search`, shards.search, groupId, "search-manifest", "records", meta);
}

function validateRuntimeShardManifest(label, shardMeta, groupId, expectedKind, recordField, meta) {
  if (!shardMeta) {
    errors.push(`ui.shards.${label} missing`);
    return;
  }
  for (const field of ["manifestPath", "manifestLegacyPath", "sha256"]) {
    if (typeof shardMeta[field] !== "string" || !shardMeta[field]) errors.push(`ui.shards.${label}.${field} must be string`);
  }
  if (!Number.isInteger(shardMeta.pageSize) || shardMeta.pageSize <= 0) errors.push(`ui.shards.${label}.pageSize must be positive integer`);
  if (!Number.isInteger(shardMeta.itemCount) || shardMeta.itemCount < 0) errors.push(`ui.shards.${label}.itemCount must be non-negative integer`);
  if (!Number.isInteger(shardMeta.pageCount) || shardMeta.pageCount <= 0) errors.push(`ui.shards.${label}.pageCount must be positive integer`);
  const manifestPath = path.join(ROOT, shardMeta.manifestPath || "");
  if (!fs.existsSync(manifestPath)) {
    errors.push(`missing runtime shard manifest: ${shardMeta.manifestPath}`);
    return;
  }
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  if (isSha256(shardMeta.sha256) && sha256Text(manifestText) !== shardMeta.sha256) {
    errors.push(`ui.shards.${label}.sha256 must match manifest contents`);
  }
  const manifest = JSON.parse(manifestText);
  if (manifest.kind !== expectedKind) errors.push(`ui.shards.${label}.kind must be ${expectedKind}`);
  if (manifest.rangeId !== groupId) errors.push(`ui.shards.${label}.rangeId must be ${groupId}`);
  if (manifest.dataVersion !== meta.dataVersion) errors.push(`ui.shards.${label}.dataVersion must match ui.meta.dataVersion`);
  if (manifest.itemCount !== shardMeta.itemCount) errors.push(`ui.shards.${label}.itemCount must match manifest`);
  if (manifest.pageCount !== shardMeta.pageCount) errors.push(`ui.shards.${label}.pageCount must match manifest`);
  if (!Array.isArray(manifest.pages) || manifest.pages.length !== manifest.pageCount) {
    errors.push(`ui.shards.${label}.pages length must match pageCount`);
    return;
  }
  let itemTotal = 0;
  for (const [pageIndex, pageMeta] of manifest.pages.entries()) {
    const pagePath = path.join(ROOT, pageMeta.path || "");
    if (!fs.existsSync(pagePath)) {
      errors.push(`missing runtime shard page: ${pageMeta.path}`);
      continue;
    }
    const pageText = fs.readFileSync(pagePath, "utf8");
    if (!isSha256(pageMeta.sha256) || sha256Text(pageText) !== pageMeta.sha256) {
      errors.push(`ui.shards.${label}.pages[${pageIndex}].sha256 must match page contents`);
    }
    const page = JSON.parse(pageText);
    if (page.rangeId !== groupId) errors.push(`ui.shards.${label}.pages[${pageIndex}].rangeId must be ${groupId}`);
    if (page.dataVersion !== meta.dataVersion) errors.push(`ui.shards.${label}.pages[${pageIndex}].dataVersion must match ui.meta.dataVersion`);
    if (page.pageIndex !== pageIndex + 1) errors.push(`ui.shards.${label}.pages[${pageIndex}].pageIndex invalid`);
    if (!Array.isArray(page[recordField])) errors.push(`ui.shards.${label}.pages[${pageIndex}].${recordField} must be array`);
    itemTotal += Array.isArray(page[recordField]) ? page[recordField].length : 0;
  }
  if (itemTotal !== manifest.itemCount) errors.push(`ui.shards.${label}.pages item total must match manifest.itemCount`);
}

function validateVideoCatalog() {
  if (!fs.existsSync(VIDEO_CATALOG_PATH)) {
    errors.push("missing video catalog: data/video-catalog.json");
    return;
  }
  const catalog = readJson(VIDEO_CATALOG_PATH);
  if (catalog.schemaVersion !== 1) errors.push("video-catalog.schemaVersion must be 1");
  if (catalog.retentionPolicy === CATALOG_RETENTION_POLICY) {
    if (catalog.retentionDays !== null) errors.push("video-catalog.retentionDays must be null for permanent catalogs");
  } else if (catalog.retentionDays !== MONTH_CATALOG_DAYS) {
    errors.push(`video-catalog.retentionDays must be ${MONTH_CATALOG_DAYS} for legacy catalogs`);
  }
  if (!Array.isArray(catalog.videos)) {
    errors.push("video-catalog.videos must be array");
    return;
  }
  const seen = new Set();
  const catalogIds = new Set();
  for (const [index, item] of catalog.videos.entries()) {
    const label = `video-catalog.videos[${index}]`;
    validateNotBlockedSource(label, item);
    if (!/^[A-Za-z0-9_-]{11}$/.test(item.videoId || "")) errors.push(`${label}.videoId invalid`);
    if (seen.has(item.videoId)) errors.push(`${label}.videoId duplicated: ${item.videoId}`);
    seen.add(item.videoId);
    catalogIds.add(item.videoId);
    if (Number.isFinite(capturedMs) && !isWithinCatalogWindow(item.publishedTimestamp, capturedMs)) {
      errors.push(`${label}.publishedTimestamp must not be in the future`);
    }
    for (const field of ["title", "channelName", "firstSeenAt", "lastSeenAt", "lastInspectedAt", "qualityStatus"]) {
      if (typeof item[field] !== "string") errors.push(`${label}.${field} must be string`);
    }
    if (item.qualityStatus !== "usable") errors.push(`${label}.qualityStatus must be usable`);
    if (!Array.isArray(item.discoveryGroups)) errors.push(`${label}.discoveryGroups must be array`);
    if (!Array.isArray(item.sourceUrls)) errors.push(`${label}.sourceUrls must be array`);
    if (!Array.isArray(item.songs) || item.songs.length <= 0) errors.push(`${label}.songs must be non-empty array`);
  }
  for (const [videoIndex, item] of (groupForRange(payload.groups, "all")?.items || []).entries()) {
    if (!catalogIds.has(item.videoId)) errors.push(`all[${videoIndex}].videoId missing from video catalog: ${item.videoId}`);
  }
}

function validateCurationConfig() {
  if (!fs.existsSync(OVERRIDES_PATH)) {
    errors.push("missing curation overrides: config/curation-overrides.json");
  } else {
    const validation = validateCurationOverrides(readJson(OVERRIDES_PATH));
    for (const error of validation.errors) errors.push(`curation-overrides: ${error}`);
  }

  if (!fs.existsSync(NON_SONG_RULES_PATH)) {
    errors.push("missing non-song rules: config/non-song-rules.json");
  } else {
    const rules = readJson(NON_SONG_RULES_PATH);
    if (rules.schemaVersion !== 1) errors.push("non-song-rules.schemaVersion must be 1");
    for (const field of ["exactUnknownArtistTitles", "candidateActivityTitles", "activityTitlePatterns", "channelScopedExactTitles", "channelScopedPatterns"]) {
      if (!Array.isArray(rules[field])) errors.push(`non-song-rules.${field} must be array`);
    }
    const requiredExactTitles = ["曲紹介", "離席", "曲終わり", "曲紹介タイム", "休憩入り", "スパチャ・メンシ読み", "配信開始", "マイクテスト"];
    const missingExactTitles = requiredExactTitles.filter((title) => !rules.exactUnknownArtistTitles?.includes(title));
    if (missingExactTitles.length) {
      errors.push(`non-song-rules.exactUnknownArtistTitles missing required titles: ${missingExactTitles.join(", ")}`);
    }
    for (const [index, pattern] of (rules.activityTitlePatterns || []).entries()) {
      try {
        new RegExp(pattern, "iu");
      } catch (error) {
        errors.push(`non-song-rules.activityTitlePatterns[${index}] invalid regex: ${error.message}`);
      }
    }
  }

  if (!fs.existsSync(SUPPLEMENTAL_KNOWN_SONGS_PATH)) {
    errors.push("missing song-search known overrides: config/song-search-known-overrides.json");
  } else {
    try {
      const records = loadSupplementalKnownSongs();
      for (const [index, record] of records.entries()) {
        if (!record.title) errors.push(`song-search-known-overrides.records[${index}].title missing`);
        if (record.reviewedAt && Number.isNaN(Date.parse(record.reviewedAt))) {
          errors.push(`song-search-known-overrides.records[${index}].reviewedAt invalid`);
        }
      }
    } catch (error) {
      errors.push(`song-search-known-overrides: ${error.message}`);
    }
  }

  if (!fs.existsSync(KNOWN_SONG_ARTIST_OVERRIDES_PATH)) {
    errors.push("missing known song artist overrides: config/known-song-artist-overrides.json");
  } else {
    const validation = validateKnownSongArtistOverrides(readJson(KNOWN_SONG_ARTIST_OVERRIDES_PATH));
    for (const error of validation.errors) errors.push(`known-song-artist-overrides: ${error}`);
  }
}

function validateSongAliases() {
  if (!fs.existsSync(SONG_ALIASES_PATH)) {
    errors.push("missing song aliases: config/song-aliases.json");
    return loadSongAliasContext();
  }
  const config = readJson(SONG_ALIASES_PATH);
  const validation = validateSongAliasConfig(config);
  for (const error of validation.errors) errors.push(`song-aliases: ${error}`);
  return validation.context;
}

function validateSongIdentity(groupId, videoIndex, songIndex, item, song, aliasContext) {
  const label = `${groupId}[${videoIndex}].songs[${songIndex}]`;
  const context = `videoId=${item.videoId || ""} seconds=${song.seconds ?? ""} title=${JSON.stringify(song.title || "")} artist=${JSON.stringify(song.artist || "")}`;
  const title = String(song.title || "").trim();
  const artist = String(song.artist || "").trim();
  const splitWrapper = splitBracketWrapper(title, artist);
  if (splitWrapper) {
    errors.push(`${label} has split ${splitWrapper} wrapper across title/artist: ${context}`);
  }
  if (hasUnpairedLeadingBracket(title)) {
    errors.push(`${label}.title has unpaired leading bracket: ${context}`);
  }
  if (hasUnpairedTrailingBracket(artist)) {
    errors.push(`${label}.artist has unpaired trailing bracket: ${context}`);
  }
  const canonical = canonicalizeSongIdentity(song, aliasContext);
  if (canonical?.title && canonical.title !== song.title) {
    errors.push(`${label} must use canonical song alias title ${JSON.stringify(canonical.title)}: ${context}`);
  }
}

function splitBracketWrapper(title, artist) {
  for (const [open, close] of BRACKET_PAIRS) {
    if (title.startsWith(open) && artist.endsWith(close)) return `${open}${close}`;
  }
  return "";
}

function hasUnpairedLeadingBracket(value) {
  const text = String(value || "").trim();
  const open = text[0];
  const close = BRACKET_CLOSE_BY_OPEN.get(open);
  return Boolean(close && !text.includes(close));
}

function hasUnpairedTrailingBracket(value) {
  const text = String(value || "").trim();
  const close = text[text.length - 1];
  const open = BRACKET_OPEN_BY_CLOSE.get(close);
  return Boolean(open && !text.includes(open));
}

function validateReviewFiles() {
  const reviewDir = path.join(DATA_DIR, "review");
  const queuePath = path.join(reviewDir, "queue.json");
  const manifestPath = path.join(reviewDir, "manifest.json");
  if (!fs.existsSync(queuePath)) {
    errors.push("missing review queue: data/review/queue.json");
  } else {
    const queue = readJson(queuePath);
    if (queue.schemaVersion !== 1) errors.push("review.queue.schemaVersion must be 1");
    if (!Array.isArray(queue.items)) errors.push("review.queue.items must be array");
  }
  if (!fs.existsSync(manifestPath)) {
    errors.push("missing review manifest: data/review/manifest.json");
  } else {
    const manifest = readJson(manifestPath);
    if (manifest.schemaVersion !== 1) errors.push("review.manifest.schemaVersion must be 1");
    for (const field of ["currentQueuePath", "historyQueuePath", "legacyQueuePath", "currentEntryIndexPath", "qualityReportPath", "sourceDir"]) {
      if (typeof manifest[field] !== "string" || !manifest[field]) errors.push(`review.manifest.${field} must be string`);
    }
    for (const field of ["currentSourceCount", "currentEntryCount", "historySourceCount", "historyEntryCount", "itemCount"]) {
      if (!Number.isInteger(manifest[field]) || manifest[field] < 0) errors.push(`review.manifest.${field} must be non-negative integer`);
    }
  }
}

function validateRuntimeRangeFile(groupId, rangeMeta, meta, options = {}) {
  const label = options.label || `ui.${groupId}`;
  const relativePath = rangeMeta?.path || `data/ui/${groupId}.json`;
  const filePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(filePath)) {
    errors.push(`missing runtime UI range: ${relativePath}`);
    return;
  }
  const text = fs.readFileSync(filePath, "utf8");
  if (rangeMeta?.sha256 && sha256Text(text) !== rangeMeta.sha256) {
    errors.push(`${label}.sha256 must match file contents`);
  }
  const range = JSON.parse(text);
  if (range.schemaVersion !== 1) errors.push(`${label}.schemaVersion must be 1`);
  if (range.id !== groupId) errors.push(`${label}.id must be ${groupId}`);
  if (typeof range.generatedAt !== "string") errors.push(`${label}.generatedAt must be string`);
  if (typeof range.capturedAt !== "string") errors.push(`${label}.capturedAt must be string`);
  if (range.dataVersion !== meta.dataVersion) errors.push(`${label}.dataVersion must match ui.meta.dataVersion`);
  if (!Number.isInteger(range.filterVersion)) errors.push(`${label}.filterVersion must be integer`);
  if (range.blocklistVersion !== BLOCKLIST_VERSION) errors.push(`${label}.blocklistVersion must match current blocklist`);
  if (range.blocklistHash !== BLOCKLIST_HASH) errors.push(`${label}.blocklistHash must match current blocklist`);
  if (typeof range.nicheAnnotated !== "boolean") errors.push(`${label}.nicheAnnotated must be boolean`);
  if (!Array.isArray(range.items)) {
    errors.push(`${label}.items must be array`);
    return;
  }
  if (Number.isInteger(rangeMeta?.itemCount) && range.items.length !== rangeMeta.itemCount) {
    errors.push(`${label}.items length must match meta itemCount`);
  }
  for (const [videoIndex, item] of range.items.entries()) {
    validateAllowedFields(`${label}.items[${videoIndex}]`, item, RUNTIME_VIDEO_FIELDS);
    validateNotBlockedSource(`${label}.items[${videoIndex}]`, item);
    if (!/^[A-Za-z0-9_-]{11}$/.test(item.videoId || "")) errors.push(`${label}[${videoIndex}].videoId invalid`);
    if (!Array.isArray(item.songs) || item.songs.length <= 0) errors.push(`${label}[${videoIndex}].songs empty`);
    for (const [songIndex, song] of (item.songs || []).entries()) {
      validateAllowedFields(`${label}.items[${videoIndex}].songs[${songIndex}]`, song, RUNTIME_SONG_FIELDS);
      if (!Number.isInteger(song.seconds) || song.seconds < 0) {
        errors.push(`${label}[${videoIndex}].songs[${songIndex}].seconds invalid`);
      }
      if (!song.title) errors.push(`${label}[${videoIndex}].songs[${songIndex}].title missing`);
      if (typeof song.isNiche !== "boolean") errors.push(`${label}[${videoIndex}].songs[${songIndex}].isNiche must be boolean`);
      for (const removedField of ["index", "time", "raw"]) {
        if (removedField in song) errors.push(`${label}[${videoIndex}].songs[${songIndex}].${removedField} must not be present`);
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

function validateNotBlockedSource(label, item) {
  const match = matchBlockedSource(item);
  if (!match) return;
  errors.push(
    `${label} blocked source ${match.name} via ${match.matchedField}=${match.matchedValue || ""} (${match.entryId || "unknown"})`,
  );
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

function isSha256(value) {
  return /^[0-9a-f]{64}$/u.test(String(value || ""));
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
