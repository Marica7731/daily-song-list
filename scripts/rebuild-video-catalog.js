const fs = require("node:fs");
const path = require("node:path");
const { createSongSearchLookup } = require("../assets/frontend-utils");
const { applyCurationToVideos, loadCurationContext } = require("./curation");
const { annotatePayloadWithSongSearchNiche, songSearchSourceSummary } = require("./song-search-index");
const { canonicalizePayloadSongAliases, loadSongAliasContext } = require("./song-aliases");
const { applyGroupQualityFilters, buildGroups, filterBlockedVideos, writeRankDiffFiles } = require("./update-songlist");
const { buildRuntimeMeta, buildRuntimeRangePayload, writeRuntimeJson } = require("./build-runtime-data");
const {
  CATALOG_MIGRATION_REPORT_PATH,
  VIDEO_CATALOG_PATH,
  catalogSummary,
  catalogToVideos,
  createEmptyVideoCatalog,
  isWithinCatalogWindow,
  rebuildVideoCatalogFromVideos,
} = require("./video-catalog");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const UI_DIR = path.join(DATA_DIR, "ui");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const SNAPSHOT_INDEX_PATH = path.join(DATA_DIR, "snapshots", "index.json");
const SONG_SEARCH_INDEX_PATH = path.join(DATA_DIR, "song-search-known-songs.json");
const RANGES = ["72h", "1m"];

if (require.main === module) {
  main();
}

function main() {
  const latest = readJson(LATEST_PATH);
  const capturedAt = new Date(latest.capturedAt || latest.generatedAt || Date.now());
  if (!Number.isFinite(capturedAt.getTime())) throw new Error("latest capturedAt/generatedAt is invalid");

  const songAliasContext = loadSongAliasContext();
  const curationContext = { ...loadCurationContext(), songAliasContext, songSearchLookup: loadSongSearchLookup() };
  const migration = collectMigrationVideos(capturedAt);
  const curatedVideos = filterBlockedVideos(applyCurationToVideos(migration.videos, curationContext));
  const catalogResult = rebuildVideoCatalogFromVideos(curatedVideos, capturedAt, {
    previousCatalog: createEmptyVideoCatalog(capturedAt.toISOString()),
    curationVersion: curationContext.version,
    curationHash: curationContext.hash,
  });
  writeJson(VIDEO_CATALOG_PATH, catalogResult.catalog);

  let payload = {
    ...latest,
    curationVersion: curationContext.version,
    curationHash: curationContext.hash,
    groups: applyGroupQualityFilters(buildGroups(catalogToVideos(catalogResult.catalog), capturedAt)),
    source: {
      ...(latest.source || {}),
      videoCatalog: {
        ...catalogSummary(catalogResult.catalog, capturedAt),
        addedVideoCount: catalogResult.stats.addedVideoCount,
        updatedVideoCount: catalogResult.stats.updatedVideoCount,
        expiredVideoCount: catalogResult.stats.expiredVideoCount,
        fromLatestVideoCount: migration.report.fromLatestVideoCount,
        fromStandaloneRangeVideoCount: migration.report.fromStandaloneRangeVideoCount,
        fromSnapshotVideoCount: migration.report.fromSnapshotVideoCount,
        from72hSupplementVideoCount: migration.report.from72hSupplementVideoCount,
        conflictCount: migration.report.conflictCount,
        h72VideoCount: 0,
        monthVideoCount: 0,
      },
    },
  };
  payload.source.videoCatalog.h72VideoCount = payload.groups["72h"]?.items?.length || 0;
  payload.source.videoCatalog.monthVideoCount = payload.groups["1m"]?.items?.length || 0;
  payload = canonicalizePayloadSongAliases(payload, songAliasContext);

  const songSearchIndex = readJsonIfExists(SONG_SEARCH_INDEX_PATH);
  if (songSearchIndex?.titleKeys?.length || songSearchIndex?.titleArtistKeys?.length) {
    payload = annotatePayloadWithSongSearchNiche(payload, songSearchIndex, songAliasContext);
    payload.source = {
      ...(payload.source || {}),
      songSearch: songSearchSourceSummary(songSearchIndex),
    };
  }

  const canonicalCatalogResult = rebuildVideoCatalogFromVideos(collectUniqueGroupVideos(payload.groups), capturedAt, {
    previousCatalog: catalogResult.catalog,
    curationVersion: curationContext.version,
    curationHash: curationContext.hash,
  });
  writeJson(VIDEO_CATALOG_PATH, canonicalCatalogResult.catalog);
  payload = {
    ...payload,
    groups: applyGroupQualityFilters(buildGroups(catalogToVideos(canonicalCatalogResult.catalog), capturedAt)),
    source: {
      ...(payload.source || {}),
      videoCatalog: {
        ...(payload.source?.videoCatalog || {}),
        ...catalogSummary(canonicalCatalogResult.catalog, capturedAt),
        addedVideoCount: canonicalCatalogResult.stats.catalogVideoCount,
        updatedVideoCount: 0,
        expiredVideoCount: catalogResult.stats.expiredVideoCount + canonicalCatalogResult.stats.expiredVideoCount,
        h72VideoCount: 0,
        monthVideoCount: 0,
      },
    },
  };
  payload.source.videoCatalog.h72VideoCount = payload.groups["72h"]?.items?.length || 0;
  payload.source.videoCatalog.monthVideoCount = payload.groups["1m"]?.items?.length || 0;

  writeJson(LATEST_PATH, payload);
  for (const rangeId of RANGES) {
    writeJson(path.join(DATA_DIR, `${rangeId}.json`), payload.groups[rangeId]);
  }
  writeRankDiffFiles(payload, undefined, curationContext);
  writeRuntimeFiles(payload);

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    capturedAt: capturedAt.toISOString(),
    catalog: payload.source.videoCatalog,
    ...migration.report,
  };
  writeJson(CATALOG_MIGRATION_REPORT_PATH, report);
  console.log(
    `[video-catalog] videos=${payload.source.videoCatalog.catalogVideoCount} 72h=${payload.groups["72h"].items.length} 1m=${payload.groups["1m"].items.length} conflicts=${report.conflictCount}`,
  );
}

function collectMigrationVideos(capturedAt) {
  const nowMs = capturedAt.getTime();
  const latest = readJson(LATEST_PATH);
  const latestMonthIds = new Set((latest.groups?.["1m"]?.items || []).map((item) => item.videoId));
  const byVideoId = new Map();
  const report = {
    scannedSourceCount: 0,
    scannedVideoCount: 0,
    skippedExpiredVideoCount: 0,
    skippedInvalidVideoCount: 0,
    fromLatestVideoCount: 0,
    fromStandaloneRangeVideoCount: 0,
    fromSnapshotVideoCount: 0,
    from72hSupplementVideoCount: 0,
    conflictCount: 0,
    conflicts: [],
  };

  const sources = [
    { label: "latest", payload: latest, kind: "latest" },
    { label: "data/72h.json", payload: rangePayload("72h"), kind: "standalone" },
    { label: "data/1m.json", payload: rangePayload("1m"), kind: "standalone" },
    ...snapshotSources(),
  ].filter((source) => source.payload);

  for (const source of sources) {
    report.scannedSourceCount += 1;
    for (const item of collectPayloadItems(source.payload)) {
      report.scannedVideoCount += 1;
      if (!isValidVideoItem(item)) {
        report.skippedInvalidVideoCount += 1;
        continue;
      }
      if (!isWithinCatalogWindow(item.publishedTimestamp, nowMs)) {
        report.skippedExpiredVideoCount += 1;
        continue;
      }
      const existing = byVideoId.get(item.videoId);
      if (!existing) {
        byVideoId.set(item.videoId, {
          ...item,
          migrationSource: source.label,
          migrationSourceKind: source.kind,
        });
        incrementSourceCount(report, source.kind);
        if (source.kind === "latest" && !latestMonthIds.has(item.videoId)) report.from72hSupplementVideoCount += 1;
        continue;
      }
      mergeDiscoveryMetadata(existing, item);
      const existingSignature = songListSignature(existing);
      const nextSignature = songListSignature(item);
      if (existingSignature !== nextSignature) {
        report.conflictCount += 1;
        if (report.conflicts.length < 200) {
          report.conflicts.push({
            videoId: item.videoId,
            keptSource: existing.migrationSource,
            skippedSource: source.label,
            keptSongCount: existing.songs.length,
            skippedSongCount: item.songs.length,
          });
        }
      }
    }
  }

  return { videos: [...byVideoId.values()], report };
}

function incrementSourceCount(report, kind) {
  if (kind === "latest") report.fromLatestVideoCount += 1;
  else if (kind === "standalone") report.fromStandaloneRangeVideoCount += 1;
  else if (kind === "snapshot") report.fromSnapshotVideoCount += 1;
}

function snapshotSources() {
  const index = readJsonIfExists(SNAPSHOT_INDEX_PATH);
  return (index?.snapshots || [])
    .slice()
    .sort((a, b) => String(b.capturedAt || b.generatedAt || b.id).localeCompare(String(a.capturedAt || a.generatedAt || a.id)))
    .map((entry) => ({
      label: entry.path || entry.file || entry.id,
      kind: "snapshot",
      payload: readJsonIfExists(path.join(ROOT, entry.path || path.join("data", "snapshots", entry.file || ""))),
    }))
    .filter((source) => source.payload);
}

function rangePayload(rangeId) {
  const group = readJsonIfExists(path.join(DATA_DIR, `${rangeId}.json`));
  return group ? { groups: { [rangeId]: group } } : null;
}

function collectPayloadItems(payload) {
  const groups = payload.groups || {};
  return Object.values(groups).flatMap((group) => group.items || []);
}

function collectUniqueGroupVideos(groups) {
  const byVideoId = new Map();
  for (const item of collectPayloadItems({ groups })) {
    if (!byVideoId.has(item.videoId)) byVideoId.set(item.videoId, item);
  }
  return [...byVideoId.values()];
}

function isValidVideoItem(item) {
  return /^[A-Za-z0-9_-]{11}$/.test(item?.videoId || "") && Number.isFinite(Number(item.publishedTimestamp)) && (item.songs || []).length > 0;
}

function mergeDiscoveryMetadata(target, source) {
  target.sourceGroups = uniqueValues([...(target.sourceGroups || []), target.sourceGroup, ...(source.sourceGroups || []), source.sourceGroup]);
  target.sourceUrls = uniqueValues([...(target.sourceUrls || []), ...(source.sourceUrls || [])]);
}

function songListSignature(item) {
  return JSON.stringify((item.songs || []).map((song) => [song.seconds, song.title, song.artist]));
}

function uniqueValues(values) {
  return [...new Set((values || []).filter(Boolean).map(String))];
}

function loadSongSearchLookup() {
  const index = readJsonIfExists(SONG_SEARCH_INDEX_PATH);
  return createSongSearchLookup(index || {});
}

function writeRuntimeFiles(payload) {
  const rangePayloads = Object.fromEntries(RANGES.map((rangeId) => [rangeId, buildRuntimeRangePayload(payload, rangeId)]));
  for (const [rangeId, rangePayload] of Object.entries(rangePayloads)) {
    writeRuntimeJson(path.join(UI_DIR, `${rangeId}.json`), rangePayload);
  }
  writeRuntimeJson(path.join(UI_DIR, "meta.json"), buildRuntimeMeta(payload, rangePayloads));
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
