const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { BLOCKLIST_HASH, BLOCKLIST_VERSION } = require("../assets/source-filter");
const {
  CANONICAL_RANGES,
  LEGACY_RANGE_ALIASES,
  LEGACY_RANGE_IDS,
  RANGE_TITLES,
  canonicalRangeId,
  groupForRange,
} = require("./range-config");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const UI_DIR = path.join(DATA_DIR, "ui");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const META_PATH = path.join(UI_DIR, "meta.json");
const RANGES = CANONICAL_RANGES;
const LEGACY_RANGES = Object.keys(LEGACY_RANGE_ALIASES);
const CURRENT_FILTER_VERSION = 4;
const RUNTIME_SCHEMA_VERSION = 1;
const RUNTIME_RANK_DIFF_LIMIT = 200;
const RUNTIME_PAGE_SIZE = positiveInteger(process.env.DAILY_SONG_RUNTIME_PAGE_SIZE, 80);
const SOURCE_DETAIL_PAGE_SIZE = positiveInteger(process.env.DAILY_SONG_SOURCE_DETAIL_PAGE_SIZE, 120);
const SEARCH_PAGE_SIZE = positiveInteger(process.env.DAILY_SONG_SEARCH_PAGE_SIZE, 240);

if (require.main === module) {
  main();
}

function main() {
  const payload = readJson(LATEST_PATH);
  const baseRangePayloads = Object.fromEntries(RANGES.map((rangeId) => [rangeId, buildRuntimeRangePayload(payload, rangeId)]));
  const dataVersion = computeRuntimeDataVersion(payload, baseRangePayloads);
  const rangePayloads = Object.fromEntries(
    RANGES.map((rangeId) => [rangeId, { ...baseRangePayloads[rangeId], dataVersion }]),
  );
  const rangeFiles = {};
  const shardFiles = {};
  for (const [rangeId, rangePayload] of Object.entries(rangePayloads)) {
    const rangeJson = stringifyRuntimeJson(rangePayload);
    const sha256 = sha256Text(rangeJson);
    const shortHash = sha256.slice(0, 12);
    const hashedPath = `data/ui/${rangeId}.${shortHash}.json`;
    const legacyPath = `data/ui/${rangeId}.json`;
    rangeFiles[rangeId] = {
      path: hashedPath,
      legacyPath,
      sha256,
      bytes: Buffer.byteLength(rangeJson, "utf8"),
      generatedAt: rangePayload.generatedAt || "",
      itemCount: rangePayload.items?.length || 0,
      dataVersion,
    };
    writeRuntimeJsonText(path.join(ROOT, hashedPath), rangeJson);
    writeRuntimeJsonText(path.join(ROOT, legacyPath), rangeJson);
    shardFiles[rangeId] = writeRuntimeShardSet(payload, rangePayload, rangeId, { dataVersion });
  }
  writeRuntimeAliasFiles(rangeFiles, rangePayloads);
  cleanupOldRuntimeRangeFiles(rangeFiles);

  for (const rangeId of RANGES) {
    const diffPath = diffPathForRange(rangeId);
    if (!fs.existsSync(diffPath)) continue;
    writeRuntimeJson(diffPath, compactRankDiff(readJson(diffPath)));
  }

  writeRuntimeJson(META_PATH, buildRuntimeMeta(payload, rangePayloads, { dataVersion, rangeFiles, shardFiles }));
  console.log(
    `[runtime-data] wrote ${path.relative(ROOT, META_PATH)} ${RANGES.map((rangeId) => rangeFiles[rangeId].path).join(" ")}`,
  );
}

function buildRuntimeMeta(payload, rangePayloads, options = {}) {
  const dataVersion = options.dataVersion || commonRangeDataVersion(rangePayloads) || computeRuntimeDataVersion(payload, rangePayloads);
  const rangeFiles = options.rangeFiles || {};
  const shardFiles = options.shardFiles || {};
  const rangeIds = runtimeRangeIds(rangePayloads, rangeFiles);
  const itemCounts = Object.fromEntries(rangeIds.map((rangeId) => [rangeId, rangePayloads[rangeId]?.items?.length || 0]));
  const capturedAt = payload.capturedAt || payload.generatedAt || "";
  const rebuiltDerivedAt = payload.source?.rebuiltDerivedAt || "";
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    dataVersion,
    generatedAt: payload.generatedAt || "",
    capturedAt,
    dataCapturedAt: capturedAt,
    rebuiltDerivedAt,
    derivedBuiltAt: payload.generatedAt || rebuiltDerivedAt || capturedAt,
    curationVersion: payload.curationVersion || "",
    curationHash: payload.curationHash || "",
    blocklistVersion: payload.blocklistVersion || payload.source?.blocklistVersion || BLOCKLIST_VERSION,
    blocklistHash: payload.blocklistHash || payload.source?.blocklistHash || BLOCKLIST_HASH,
    catalog: payload.source?.videoCatalog || null,
    status: runtimeStatus(payload, { capturedAt, rebuiltDerivedAt, dataVersion, itemCounts }),
    latestCapture: {
      capturedAt,
      completedAt: payload.status?.completedAt || capturedAt,
      itemCounts,
    },
    latestDerived: {
      builtAt: payload.generatedAt || rebuiltDerivedAt || capturedAt,
      rebuiltDerivedAt,
      dataVersion,
      itemCounts,
    },
    rangeAliases: LEGACY_RANGE_ALIASES,
    canonicalRanges: CANONICAL_RANGES,
    legacyRanges: LEGACY_RANGE_IDS,
    filterVersion: CURRENT_FILTER_VERSION,
    nicheAnnotated: rangeIds.every((rangeId) => rangePayloads[rangeId]?.nicheAnnotated === true),
    ranges: Object.fromEntries(
      rangeIds.map((rangeId) => [
        rangeId,
        {
          canonicalRangeId: canonicalRangeId(rangeId),
          legacyRangeIds: LEGACY_RANGE_IDS[rangeId] || [],
          path: rangeFiles[rangeId]?.path || `data/ui/${rangeId}.json`,
          legacyPath: rangeFiles[rangeId]?.legacyPath || `data/ui/${rangeId}.json`,
          sha256: rangeFiles[rangeId]?.sha256 || sha256Text(stringifyRuntimeJson(rangePayloads[rangeId] || {})),
          bytes: rangeFiles[rangeId]?.bytes || Buffer.byteLength(stringifyRuntimeJson(rangePayloads[rangeId] || {}), "utf8"),
          generatedAt: rangeFiles[rangeId]?.generatedAt || rangePayloads[rangeId]?.generatedAt || "",
          dataVersion,
          itemCount: itemCounts[rangeId],
          shards: shardFiles[rangeId] || null,
        },
      ]),
    ),
    diffs: Object.fromEntries(
      rangeIds.map((rangeId) => [
        rangeId,
        {
          path: `data/diff/latest-${rangeId}.json`,
        },
      ]),
    ),
  };
}

function runtimeRangeIds(rangePayloads, rangeFiles = {}) {
  const ids = RANGES.filter((rangeId) => rangePayloads?.[rangeId] || rangeFiles?.[rangeId]);
  return ids.length ? ids : LEGACY_RANGES;
}

function runtimeStatus(payload, runtime = {}) {
  if (!payload.status) return null;
  return {
    ...payload.status,
    capturedAt: runtime.capturedAt || payload.capturedAt || payload.generatedAt || "",
    dataCapturedAt: runtime.capturedAt || payload.capturedAt || payload.generatedAt || "",
    rebuiltDerivedAt: runtime.rebuiltDerivedAt || payload.source?.rebuiltDerivedAt || payload.status.rebuiltDerivedAt || "",
    dataVersion: runtime.dataVersion || "",
    itemCounts: runtime.itemCounts || null,
  };
}

function buildRuntimeRangePayload(payload, rangeId) {
  const group = groupForRange(payload.groups, rangeId) || { id: rangeId, title: rangeId, items: [] };
  const clientGroup = buildClientGroup(group);
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    id: rangeId,
    canonicalRangeId: canonicalRangeId(rangeId),
    legacyRangeIds: LEGACY_RANGE_IDS[rangeId] || [],
    title: RANGE_TITLES[rangeId] || clientGroup.title,
    generatedAt: clientGroup.generatedAt || payload.generatedAt || "",
    capturedAt: payload.capturedAt || payload.generatedAt || "",
    curationVersion: payload.curationVersion || "",
    blocklistVersion: payload.blocklistVersion || payload.source?.blocklistVersion || BLOCKLIST_VERSION,
    blocklistHash: payload.blocklistHash || payload.source?.blocklistHash || BLOCKLIST_HASH,
    filterVersion: CURRENT_FILTER_VERSION,
    nicheAnnotated: groupHasNicheAnnotations(clientGroup),
    items: clientGroup.items,
  };
}

function buildClientGroup(group) {
  return {
    id: group.id || "",
    title: group.title || group.id || "",
    generatedAt: group.generatedAt || "",
    updatedAt: group.updatedAt || "",
    items: (group.items || []).map(buildClientVideo),
  };
}

function buildClientVideo(item) {
  const result = {
    videoId: item.videoId || "",
    title: item.title || "",
    channelName: item.channelName || "",
    channelId: item.channelId || "",
    channelHandle: item.channelHandle || "",
    channelUrl: item.channelUrl || item.authorUrl || item.ownerUrl || "",
    keyword: item.keyword || "",
    publishedText: item.publishedText || "",
    publishedTimestamp: finiteTimestamp(item.publishedTimestamp),
    catalogFirstSeenAt: item.catalogFirstSeenAt || item.firstSeenAt || "",
    catalogLastSeenAt: item.catalogLastSeenAt || item.lastSeenAt || "",
    catalogLastInspectedAt: item.catalogLastInspectedAt || item.lastInspectedAt || "",
    thumbnailUrl: runtimeThumbnailUrl(item),
    songs: (item.songs || []).map(buildClientSong),
  };
  if (!result.channelUrl) delete result.channelUrl;
  return result;
}

function runtimeThumbnailUrl(item) {
  const videoId = item.videoId || "";
  if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  return item.thumbnailUrl || "";
}

function buildClientSong(song) {
  return {
    seconds: Math.max(0, Number(song.seconds) || 0),
    title: song.title || "",
    artist: song.artist || "",
    isNiche: song.isNiche === true,
  };
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function compactRankDiff(diff) {
  return {
    schemaVersion: diff.schemaVersion || RUNTIME_SCHEMA_VERSION,
    generatedAt: diff.generatedAt || "",
    capturedAt: diff.capturedAt || diff.generatedAt || "",
    range: diff.range || "",
    current: diff.current || null,
    previous: diff.previous || null,
    songRank: compactRankDiffEntries(diff.songRank),
    artistRank: compactRankDiffEntries(diff.artistRank),
  };
}

function compactRankDiffEntries(entries) {
  return (entries || [])
    .map((entry) => ({
      entityKey: entry.entityKey || "",
      rankDelta: entry.rankDelta ?? null,
      countDelta: Number(entry.countDelta) || 0,
      isNew: entry.isNew === true,
      currentRank: entry.currentRank,
    }))
    .filter((entry) => entry.entityKey)
    .filter((entry) => entry.currentRank == null || entry.currentRank <= RUNTIME_RANK_DIFF_LIMIT || entry.isNew)
    .filter((entry) => !(entry.rankDelta === 0 && entry.countDelta === 0 && entry.isNew === false))
    .map(({ currentRank, ...entry }) => entry);
}

function groupHasNicheAnnotations(group) {
  let songCount = 0;
  for (const item of group.items || []) {
    for (const song of item.songs || []) {
      songCount += 1;
      if (typeof song.isNiche !== "boolean") return false;
    }
  }
  return songCount > 0;
}

function diffPathForRange(rangeId) {
  return path.join(DATA_DIR, "diff", `latest-${rangeId}.json`);
}

function writeRuntimeShardSet(payload, rangePayload, rangeId, options = {}) {
  const sourceGroup = groupForRange(payload.groups, rangeId) || { items: [] };
  const dataVersion = options.dataVersion || rangePayload.dataVersion || "";
  const runtime = writePagedShard({
    kind: "runtime-page",
    rangeId,
    dataVersion,
    generatedAt: rangePayload.generatedAt || payload.generatedAt || "",
    capturedAt: rangePayload.capturedAt || payload.capturedAt || payload.generatedAt || "",
    baseDir: `data/ui/ranges/${rangeId}`,
    pageSize: RUNTIME_PAGE_SIZE,
    records: rangePayload.items || [],
    recordName: "items",
  });
  const sourceDetails = writePagedShard({
    kind: "source-detail",
    rangeId,
    dataVersion,
    generatedAt: rangePayload.generatedAt || payload.generatedAt || "",
    capturedAt: rangePayload.capturedAt || payload.capturedAt || payload.generatedAt || "",
    baseDir: `data/ui/source-details/${rangeId}`,
    pageSize: SOURCE_DETAIL_PAGE_SIZE,
    records: buildSourceDetailRecords(sourceGroup.items || []),
    recordName: "sources",
  });
  const search = writePagedShard({
    kind: "search",
    rangeId,
    dataVersion,
    generatedAt: rangePayload.generatedAt || payload.generatedAt || "",
    capturedAt: rangePayload.capturedAt || payload.capturedAt || payload.generatedAt || "",
    baseDir: `data/ui/search/${rangeId}`,
    pageSize: SEARCH_PAGE_SIZE,
    records: buildSearchRecords(rangePayload.items || []),
    recordName: "records",
  });
  return { runtime, sourceDetails, search };
}

function writePagedShard({ kind, rangeId, dataVersion, generatedAt, capturedAt, baseDir, pageSize, records, recordName }) {
  const chunks = chunkArray(records, pageSize);
  const pages = chunks.map((chunk, index) => {
    const pageIndex = index + 1;
    const pagePayload = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      kind,
      rangeId,
      dataVersion,
      generatedAt,
      capturedAt,
      pageIndex,
      pageCount: chunks.length,
      pageSize,
      itemCount: chunk.length,
      [recordName]: chunk,
    };
    const text = stringifyRuntimeJson(pagePayload);
    const sha256 = sha256Text(text);
    const pathName = `${baseDir}/page-${String(pageIndex).padStart(4, "0")}.${sha256.slice(0, 12)}.json`;
    writeRuntimeJsonText(path.join(ROOT, pathName), text);
    return {
      index: pageIndex,
      path: pathName,
      sha256,
      bytes: Buffer.byteLength(text, "utf8"),
      itemCount: chunk.length,
    };
  });
  const manifestPayload = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    kind: `${kind}-manifest`,
    rangeId,
    dataVersion,
    generatedAt,
    capturedAt,
    pageSize,
    itemCount: records.length,
    pageCount: pages.length,
    pages,
  };
  const manifestText = stringifyRuntimeJson(manifestPayload);
  const manifestSha256 = sha256Text(manifestText);
  const manifestPath = `${baseDir}/manifest.${manifestSha256.slice(0, 12)}.json`;
  const manifestLegacyPath = `${baseDir}/manifest.json`;
  writeRuntimeJsonText(path.join(ROOT, manifestPath), manifestText);
  writeRuntimeJsonText(path.join(ROOT, manifestLegacyPath), manifestText);
  cleanupOldPagedShardFiles(baseDir, {
    manifestPath,
    pages,
  });
  return {
    manifestPath,
    manifestLegacyPath,
    sha256: manifestSha256,
    bytes: Buffer.byteLength(manifestText, "utf8"),
    pageSize,
    itemCount: records.length,
    pageCount: pages.length,
    pages,
  };
}

function buildSourceDetailRecords(items) {
  return (items || []).map((item) => ({
    videoId: item.videoId || "",
    title: item.title || "",
    channelName: item.channelName || "",
    channelId: item.channelId || "",
    channelHandle: item.channelHandle || "",
    channelUrl: item.channelUrl || item.authorUrl || item.ownerUrl || "",
    keyword: item.keyword || "",
    keywords: listValues(item.keywords),
    keywordKeys: listValues(item.keywordKeys),
    publishedText: item.publishedText || "",
    publishedTimestamp: Number.isFinite(item.publishedTimestamp) ? item.publishedTimestamp : null,
    durationText: item.durationText || "",
    sourceGroups: listValues(item.sourceGroups),
    sourceUrls: listValues(item.sourceUrls),
    selectedSourceId: item.selectedSourceId || item.sourceId || "",
    selectedSourceHash: item.selectedSourceHash || item.sourceHash || "",
    sourceQuality: item.sourceQuality || null,
    songCount: Array.isArray(item.songs) ? item.songs.length : 0,
    catalogFirstSeenAt: item.catalogFirstSeenAt || "",
    catalogLastSeenAt: item.catalogLastSeenAt || "",
    catalogLastInspectedAt: item.catalogLastInspectedAt || "",
    carriedFromPrevious: item.carriedFromPrevious === true,
  }));
}

function buildSearchRecords(items) {
  const records = [];
  for (const item of items || []) {
    records.push({
      type: "video",
      videoId: item.videoId || "",
      title: item.title || "",
      channelName: item.channelName || "",
      keyword: item.keyword || "",
      searchText: normalizeSearchText([item.videoId, item.title, item.channelName, item.keyword].join(" ")),
    });
    for (const song of item.songs || []) {
      records.push({
        type: "song",
        videoId: item.videoId || "",
        seconds: Math.max(0, Number(song.seconds) || 0),
        title: song.title || "",
        artist: song.artist || "",
        isNiche: song.isNiche === true,
        searchText: normalizeSearchText([item.videoId, song.title, song.artist, item.title, item.channelName].join(" ")),
      });
    }
  }
  return records;
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function chunkArray(items, pageSize) {
  const chunks = [];
  for (let index = 0; index < items.length; index += pageSize) {
    chunks.push(items.slice(index, index + pageSize));
  }
  return chunks.length ? chunks : [[]];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stringifyRuntimeJson(value) {
  return JSON.stringify(value);
}

function writeRuntimeJson(filePath, value) {
  writeRuntimeJsonText(filePath, stringifyRuntimeJson(value));
}

function writeRuntimeJsonText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, text, "utf8");
  fs.renameSync(tempPath, filePath);
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function computeRuntimeDataVersion(payload, rangePayloads) {
  return sha256Text(
    stringifyRuntimeJson({
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      generatedAt: payload.generatedAt || "",
      capturedAt: payload.capturedAt || payload.generatedAt || "",
      rebuiltDerivedAt: payload.source?.rebuiltDerivedAt || "",
      curationVersion: payload.curationVersion || "",
      curationHash: payload.curationHash || "",
      blocklistVersion: payload.blocklistVersion || payload.source?.blocklistVersion || BLOCKLIST_VERSION,
      blocklistHash: payload.blocklistHash || payload.source?.blocklistHash || BLOCKLIST_HASH,
      filterVersion: CURRENT_FILTER_VERSION,
      ranges: Object.fromEntries(RANGES.map((rangeId) => [rangeId, rangePayloads[rangeId] || null])),
    }),
  );
}

function commonRangeDataVersion(rangePayloads) {
  const versions = RANGES.map((rangeId) => rangePayloads[rangeId]?.dataVersion).filter(Boolean);
  return versions.length && versions.every((version) => version === versions[0]) ? versions[0] : "";
}

function cleanupOldRuntimeRangeFiles(rangeFiles) {
  if (!fs.existsSync(UI_DIR)) return;
  const current = new Set(Object.values(rangeFiles).map((entry) => path.basename(entry.path)));
  for (const rangeId of RANGES) {
    const files = fs
      .readdirSync(UI_DIR)
      .filter((name) => new RegExp(`^${rangeId}\\.[0-9a-f]{12}\\.json$`, "u").test(name))
      .map((name) => ({
        name,
        mtimeMs: fs.statSync(path.join(UI_DIR, name)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const keep = new Set([...files.slice(0, 4).map((file) => file.name), ...current]);
    for (const file of files) {
      if (!keep.has(file.name)) fs.unlinkSync(path.join(UI_DIR, file.name));
    }
  }
}

function cleanupOldPagedShardFiles(baseDir, currentShard) {
  const dirPath = path.join(ROOT, baseDir);
  if (!fs.existsSync(dirPath)) return;
  const keep = new Set([
    path.basename(currentShard.manifestPath || ""),
    "manifest.json",
    ...(currentShard.pages || []).map((page) => path.basename(page.path || "")),
  ]);
  for (const name of fs.readdirSync(dirPath)) {
    if (!/^(manifest|page-[0-9]{4})\.[0-9a-f]{12}\.json$/u.test(name)) continue;
    if (!keep.has(name)) fs.unlinkSync(path.join(dirPath, name));
  }
}

function writeRuntimeAliasFiles(rangeFiles, rangePayloads) {
  for (const [legacyId, targetId] of Object.entries(LEGACY_RANGE_ALIASES)) {
    const target = rangeFiles[targetId] || {};
    const targetPayload = rangePayloads[targetId] || {};
    writeRuntimeJson(path.join(UI_DIR, `${legacyId}.json`), {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      id: legacyId,
      aliasOf: targetId,
      path: target.path || `data/ui/${targetId}.json`,
      legacyPath: target.legacyPath || `data/ui/${targetId}.json`,
      generatedAt: targetPayload.generatedAt || target.generatedAt || "",
      capturedAt: targetPayload.capturedAt || "",
      itemCount: targetPayload.items?.length || 0,
      dataVersion: targetPayload.dataVersion || "",
    });
  }
}

function listValues(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return value ? [String(value)] : [];
}

function positiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  CANONICAL_RANGES,
  buildClientGroup,
  buildClientSong,
  buildClientVideo,
  buildRuntimeMeta,
  buildRuntimeRangePayload,
  buildSearchRecords,
  buildSourceDetailRecords,
  compactRankDiff,
  compactRankDiffEntries,
  computeRuntimeDataVersion,
  CURRENT_FILTER_VERSION,
  LEGACY_RANGE_ALIASES,
  LEGACY_RANGE_IDS,
  RANGES,
  SEARCH_PAGE_SIZE,
  SOURCE_DETAIL_PAGE_SIZE,
  RUNTIME_PAGE_SIZE,
  sha256Text,
  writeRuntimeJson,
};
