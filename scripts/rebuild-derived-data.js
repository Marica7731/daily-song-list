const fs = require("node:fs");
const path = require("node:path");
const { annotatePayloadWithSongSearchNiche, mergeSupplementalKnownSongs, songSearchSourceSummary } = require("./song-search-index");
const { backfillMissingArtistsInPayload } = require("./artist-backfill");
const { applyCurationToVideos, hashNormalizedText, isParserCorruptionEntry, loadCurationContext } = require("./curation");
const { createSongSearchLookup } = require("../assets/frontend-utils");
const { BLOCKLIST_HASH, BLOCKLIST_VERSION, assertNoBlockedVideos, createBlockedSourceAudit, filterBlockedVideos } = require("../assets/source-filter");
const { repairParsedEntry } = require("./entry-repair");
const { normalizeParsedSong, parseTimestampSongs } = require("./song-utils");
const { canonicalizePayloadSongAliases, canonicalizeSongIdentity, loadSongAliasContext } = require("./song-aliases");
const { applyGroupQualityFilters, buildGroups, writeRankDiffFiles } = require("./update-songlist");
const {
  VIDEO_CATALOG_PATH,
  catalogSummary,
  catalogToVideos,
  loadVideoCatalog,
  rebuildVideoCatalogFromVideos,
  writeVideoCatalog,
} = require("./video-catalog");
const { CANONICAL_RANGES, WEEK_MS, groupForRange, legacyAliasManifest } = require("./range-config");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const STATUS_PATH = path.join(DATA_DIR, "status.json");
const SONG_SEARCH_INDEX_PATH = path.join(DATA_DIR, "song-search-known-songs.json");
const RANGES = CANONICAL_RANGES;

if (require.main === module) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["from-catalog"]) {
    rebuildDerivedFromCatalog();
    return;
  }

  const latest = readJson(LATEST_PATH);
  if (!latest?.groups) throw new Error("data/latest.json missing groups");

  const songAliasContext = loadSongAliasContext();
  const curationContext = { ...loadCurationContext(), songAliasContext };
  const songSearchIndex = mergeSupplementalKnownSongs(readJsonIfExists(SONG_SEARCH_INDEX_PATH) || {});
  const songSearchLookup = createSongSearchLookup(songSearchIndex || {});
  const stats = createRebuildStats();
  const blockedSourceAudit = createBlockedSourceAudit();

  const rebuiltGroups = {};
  for (const [groupId, group] of Object.entries(latest.groups || {})) {
    const rebuiltItems = (group.items || [])
      .map((item) => rebuildVideoItem(item, stats, songSearchLookup, songAliasContext))
      .filter((item) => item.songs.length);
    const sourceFilteredItems = filterBlockedVideos(rebuiltItems, { audit: blockedSourceAudit });
    const curatedItems = applyCurationToVideos(sourceFilteredItems, curationContext);
    const curationStats = curatedItems.curationStats || {};
    stats.manualDroppedEntryCount += curationStats.droppedEntries || 0;
    stats.manualReplacedEntryCount += curationStats.replacedEntries || 0;
    stats.ruleDroppedEntryCount += curationStats.ruleDroppedEntries || 0;
    stats.conversationDroppedEntryCount += curationStats.conversationDroppedEntries || 0;
    stats.nearDuplicateDroppedEntryCount += curationStats.nearDuplicateDroppedEntries || 0;
    stats.droppedVideoCount += curationStats.droppedVideos || 0;

    const beforeQualityCount = countSongs(curatedItems);
    const filteredGroup = applyGroupQualityFilters({
      [groupId]: {
        ...group,
        items: curatedItems,
      },
    })[groupId];
    const afterQualityCount = countSongs(filteredGroup.items || []);
    stats.qualityDroppedEntryCount += Math.max(0, beforeQualityCount - afterQualityCount);

    rebuiltGroups[groupId] = {
      ...group,
      items: filteredGroup.items,
    };
  }

  let payload = {
    ...latest,
    curationVersion: curationContext.version,
    curationHash: curationContext.hash,
    groups: rebuiltGroups,
    source: {
      ...(latest.source || {}),
      rebuiltDerivedAt: new Date().toISOString(),
      blocklistVersion: BLOCKLIST_VERSION,
      blocklistHash: BLOCKLIST_HASH,
      blockedSourceAudit: blockedSourceAudit.summary(),
      curationSummary: buildCurationSummary(latest.source?.curationSummary, stats),
    },
    blocklistVersion: BLOCKLIST_VERSION,
    blocklistHash: BLOCKLIST_HASH,
  };

  payload = applyPostCurationSongIdentity(payload, songAliasContext, songSearchIndex);
  stats.artistBackfilledCount += payload.source?.artistBackfill?.filledCount || 0;

  const capturedAt = new Date(payload.capturedAt || payload.generatedAt || Date.now());
  const catalogInputVideos = filterBlockedVideos(collectUniqueGroupVideos(payload.groups), { audit: blockedSourceAudit });
  const catalogRefresh = rebuildVideoCatalogFromVideos(catalogInputVideos, capturedAt, {
    previousCatalog: loadVideoCatalog(),
    curationVersion: curationContext.version,
    curationHash: curationContext.hash,
  });
  const catalogGroupVideos = catalogToVideos(catalogRefresh.catalog);
  assertNoBlockedVideos(catalogGroupVideos, "rebuild-derived catalog");
  writeVideoCatalog(catalogRefresh.catalog, VIDEO_CATALOG_PATH);
  const nextGroups = applyGroupQualityFilters(buildGroups(catalogGroupVideos, capturedAt));
  payload = {
    ...payload,
    groups: nextGroups,
    source: {
      ...(payload.source || {}),
      blockedSourceAudit: blockedSourceAudit.summary(),
      videoCatalog: {
        ...catalogSummary(catalogRefresh.catalog, capturedAt),
        addedVideoCount: catalogRefresh.stats.addedVideoCount,
        updatedVideoCount: catalogRefresh.stats.updatedVideoCount,
        expiredVideoCount: catalogRefresh.stats.expiredVideoCount,
        h72VideoCount: catalogRefresh.catalog.videos.filter((item) => {
          const published = Number(item.publishedTimestamp);
          return Number.isFinite(published) && capturedAt.getTime() - published >= 0 && capturedAt.getTime() - published <= WEEK_MS;
        }).length,
        recent7dVideoCount: nextGroups["7d"]?.items?.length || 0,
        monthVideoCount: catalogRefresh.stats.catalogVideoCount,
        allVideoCount: catalogRefresh.stats.catalogVideoCount,
      },
    },
  };
  payload = applyPostCurationSongIdentity(payload, songAliasContext, songSearchIndex, { preserveArtistBackfillSummary: true });

  writeJson(LATEST_PATH, payload);
  for (const rangeId of RANGES) {
    if (payload.groups?.[rangeId]) writeJson(path.join(DATA_DIR, `${rangeId}.json`), payload.groups[rangeId]);
  }
  writeJson(path.join(DATA_DIR, "72h.json"), legacyAliasManifest("72h", groupForRange(payload.groups, "7d")));
  writeJson(path.join(DATA_DIR, "1m.json"), legacyAliasManifest("1m", groupForRange(payload.groups, "all")));
  writeDerivedStatus(payload);
  writeRankDiffFiles(payload, undefined, curationContext);

  console.log(
    [
      `[rebuild-derived] songs=${stats.inputSongs}`,
      `parsedRaw=${stats.parsedFromRaw}`,
      `fixedTitles=${stats.fixedTitleCount}`,
      `repaired=${stats.repairedEntryCount}`,
      `artistBackfilled=${stats.artistBackfilledCount}`,
      `manualDropped=${stats.manualDroppedEntryCount}`,
      `ruleDropped=${payload.source.curationSummary.ruleDroppedEntryCount}`,
      `blockedSources=${blockedSourceAudit.summary().removed}`,
      `forceRefresh=${payload.source.curationSummary.forceRefreshVideoCount}`,
    ].join(" "),
  );
}

function rebuildDerivedFromCatalog() {
  const latest = readJson(LATEST_PATH);
  if (!latest?.groups) throw new Error("data/latest.json missing groups");

  const capturedAt = new Date();
  const capturedAtIso = capturedAt.toISOString();
  const songAliasContext = loadSongAliasContext();
  const curationContext = { ...loadCurationContext(), songAliasContext };
  const songSearchIndex = mergeSupplementalKnownSongs(readJsonIfExists(SONG_SEARCH_INDEX_PATH) || {});
  const songSearchLookup = createSongSearchLookup(songSearchIndex || {});
  const stats = createRebuildStats();
  const blockedSourceAudit = createBlockedSourceAudit();
  const sourceCatalog = loadVideoCatalog();
  const sourceVideos = catalogToVideos(sourceCatalog)
    .map((item) => rebuildVideoItem(item, stats, songSearchLookup, songAliasContext))
    .filter((item) => item.songs.length);
  const sourceFilteredItems = filterBlockedVideos(sourceVideos, { audit: blockedSourceAudit });
  const curatedItems = applyCurationToVideos(sourceFilteredItems, curationContext);
  collectAppliedCurationStats(stats, curatedItems);
  const beforeQualityCount = countSongs(curatedItems);
  const filteredItems = applyGroupQualityFilters({
    all: {
      id: "all",
      title: "累計",
      items: curatedItems,
    },
  }).all.items;
  stats.qualityDroppedEntryCount += Math.max(0, beforeQualityCount - countSongs(filteredItems || []));

  const catalogRefresh = rebuildVideoCatalogFromVideos(filteredItems || [], capturedAt, {
    previousCatalog: sourceCatalog,
    curationVersion: curationContext.version,
    curationHash: curationContext.hash,
  });
  assertNoBlockedVideos(catalogToVideos(catalogRefresh.catalog), "rebuild-derived catalog from catalog");

  let payload = {
    ...latest,
    generatedAt: capturedAtIso,
    capturedAt: capturedAtIso,
    curationVersion: curationContext.version,
    curationHash: curationContext.hash,
    groups: applyGroupQualityFilters(buildGroups(catalogToVideos(catalogRefresh.catalog), capturedAt)),
    source: {
      ...(latest.source || {}),
      rebuiltDerivedAt: capturedAtIso,
      blocklistVersion: BLOCKLIST_VERSION,
      blocklistHash: BLOCKLIST_HASH,
      blockedSourceAudit: blockedSourceAudit.summary(),
      curationSummary: buildCurationSummary(latest.source?.curationSummary, stats),
      videoCatalog: buildVideoCatalogSource(catalogRefresh, capturedAt, {}),
    },
    blocklistVersion: BLOCKLIST_VERSION,
    blocklistHash: BLOCKLIST_HASH,
  };
  payload = applyPostCurationSongIdentity(payload, songAliasContext, songSearchIndex);
  stats.artistBackfilledCount += payload.source?.artistBackfill?.filledCount || 0;

  const canonicalCatalogResult = rebuildVideoCatalogFromVideos(collectUniqueGroupVideos(payload.groups), capturedAt, {
    previousCatalog: catalogRefresh.catalog,
    curationVersion: curationContext.version,
    curationHash: curationContext.hash,
  });
  writeVideoCatalog(canonicalCatalogResult.catalog, VIDEO_CATALOG_PATH);
  payload = {
    ...payload,
    groups: applyGroupQualityFilters(buildGroups(catalogToVideos(canonicalCatalogResult.catalog), capturedAt)),
    source: {
      ...(payload.source || {}),
      videoCatalog: buildVideoCatalogSource(canonicalCatalogResult, capturedAt, catalogRefresh.stats),
    },
  };
  payload = applyPostCurationSongIdentity(payload, songAliasContext, songSearchIndex, { preserveArtistBackfillSummary: true });

  writeJson(LATEST_PATH, payload);
  for (const rangeId of RANGES) {
    if (payload.groups?.[rangeId]) writeJson(path.join(DATA_DIR, `${rangeId}.json`), payload.groups[rangeId]);
  }
  writeJson(path.join(DATA_DIR, "72h.json"), legacyAliasManifest("72h", groupForRange(payload.groups, "7d")));
  writeJson(path.join(DATA_DIR, "1m.json"), legacyAliasManifest("1m", groupForRange(payload.groups, "all")));
  writeDerivedStatus(payload);
  writeRankDiffFiles(payload, undefined, curationContext);

  console.log(
    [
      "CODEX_REBUILD_DERIVED_FROM_CATALOG_OK",
      `videos=${payload.source.videoCatalog.catalogVideoCount}`,
      `all=${payload.groups.all?.items?.length || 0}`,
      `recent7d=${payload.groups["7d"]?.items?.length || 0}`,
      `songs=${countSongs(payload.groups.all?.items || [])}`,
      `parsedRaw=${stats.parsedFromRaw}`,
      `artistBackfilled=${stats.artistBackfilledCount}`,
      `blockedSources=${blockedSourceAudit.summary().removed}`,
    ].join(" "),
  );
}

function parseArgs(argv) {
  const args = {};
  for (const item of argv || []) {
    if (item === "--from-catalog") args["from-catalog"] = true;
    else throw new Error(`Unknown argument: ${item}`);
  }
  return args;
}

function createRebuildStats() {
  return {
    inputSongs: 0,
    parsedFromRaw: 0,
    fixedTitleCount: 0,
    fixedArtistCount: 0,
    fixedSecondsCount: 0,
    repairedEntryCount: 0,
    parseRejectedCount: 0,
    missingRawCount: 0,
    manualDroppedEntryCount: 0,
    manualReplacedEntryCount: 0,
    ruleDroppedEntryCount: 0,
    conversationDroppedEntryCount: 0,
    nearDuplicateDroppedEntryCount: 0,
    qualityDroppedEntryCount: 0,
    droppedVideoCount: 0,
    forceRefreshVideoIds: [],
    blockedSourceDroppedVideoCount: 0,
    artistBackfilledCount: 0,
  };
}

function collectAppliedCurationStats(stats, curatedItems) {
  const curationStats = curatedItems.curationStats || {};
  stats.manualDroppedEntryCount += curationStats.droppedEntries || 0;
  stats.manualReplacedEntryCount += curationStats.replacedEntries || 0;
  stats.ruleDroppedEntryCount += curationStats.ruleDroppedEntries || 0;
  stats.conversationDroppedEntryCount += curationStats.conversationDroppedEntries || 0;
  stats.nearDuplicateDroppedEntryCount += curationStats.nearDuplicateDroppedEntries || 0;
  stats.droppedVideoCount += curationStats.droppedVideos || 0;
}

function buildVideoCatalogSource(catalogResult, capturedAt, previousStats = {}) {
  const groups = applyGroupQualityFilters(buildGroups(catalogToVideos(catalogResult.catalog), capturedAt));
  return {
    ...catalogSummary(catalogResult.catalog, capturedAt),
    addedVideoCount: catalogResult.stats.addedVideoCount,
    updatedVideoCount: catalogResult.stats.updatedVideoCount,
    expiredVideoCount: catalogResult.stats.expiredVideoCount + (previousStats.expiredVideoCount || 0),
    h72VideoCount: catalogResult.catalog.videos.filter((item) => {
      const published = Number(item.publishedTimestamp);
      return Number.isFinite(published) && capturedAt.getTime() - published >= 0 && capturedAt.getTime() - published <= WEEK_MS;
    }).length,
    recent7dVideoCount: groups["7d"]?.items?.length || 0,
    monthVideoCount: catalogResult.stats.catalogVideoCount,
    allVideoCount: catalogResult.stats.catalogVideoCount,
  };
}

function rebuildVideoItem(item, stats, lookup = null, aliasContext = null) {
  const songs = [];
  for (const song of item.songs || []) {
    stats.inputSongs += 1;
    const rebuilt = rebuildSong(song, item, stats, lookup, aliasContext);
    songs.push(...rebuilt);
  }
  return { ...item, songs: songs.map((song, index) => ({ ...song, index: index + 1 })) };
}

function rebuildSong(song, item, stats, lookup = null, aliasContext = null) {
  const raw = String(song.raw || "").trim();
  if (!raw) {
    stats.missingRawCount += 1;
    if (isParserCorruptionEntry(song)) stats.forceRefreshVideoIds.push(item.videoId);
    return [normalizeCarriedSong(song, item, aliasContext)];
  }

  const rejected = [];
  const parsed = parseTimestampSongs([raw], { onReject: (entry) => rejected.push(entry) }).map(normalizeParsedSong);
  if (!parsed.length) {
    stats.parseRejectedCount += 1;
    return [];
  }

  stats.parsedFromRaw += 1;
  const parsedSelected = selectParsedSong(parsed, song);
  const selected = canonicalizeSongIdentity(repairParsedEntry(parsedSelected, lookup), aliasContext);
  if (selected.repair?.changed) stats.repairedEntryCount += 1;
  if (selected.title !== song.title) stats.fixedTitleCount += 1;
  if (normalizeArtist(selected.artist) !== normalizeArtist(song.artist)) stats.fixedArtistCount += 1;
  if (selected.seconds !== song.seconds) stats.fixedSecondsCount += 1;

  return [
    {
      ...song,
      time: selected.time,
      seconds: selected.seconds,
      title: selected.title,
      artist: selected.artist,
      ...repairMetadata(selected),
      raw,
      rawHash: hashNormalizedText(raw),
      sourceId: song.sourceId || item.selectedSourceId || item.sourceId || (item.videoId ? `legacy:${item.videoId}` : ""),
      sourceHash:
        song.sourceHash ||
        item.selectedSourceHash ||
        item.sourceHash ||
        hashNormalizedText(JSON.stringify((item.songs || []).map((entry) => [entry.seconds, entry.title, entry.artist, entry.raw || ""]))),
    },
  ];
}

function normalizeCarriedSong(song, item, aliasContext = null) {
  const normalized = canonicalizeSongIdentity(repairParsedEntry(normalizeParsedSong(song)), aliasContext);
  return {
    ...song,
    ...normalized,
    rawHash: song.rawHash || hashNormalizedText(song.raw || `${song.time || song.seconds || ""} ${song.title || ""}`),
    sourceId: song.sourceId || item.selectedSourceId || item.sourceId || (item.videoId ? `legacy:${item.videoId}` : ""),
    sourceHash:
      song.sourceHash ||
      item.selectedSourceHash ||
      item.sourceHash ||
      hashNormalizedText(JSON.stringify((item.songs || []).map((entry) => [entry.seconds, entry.title, entry.artist, entry.raw || ""]))),
  };
}

function selectParsedSong(parsed, original) {
  const seconds = Number(original.seconds);
  if (Number.isInteger(seconds)) {
    const exact = parsed.find((song) => song.seconds === seconds);
    if (exact) return exact;
    const near = parsed.find((song) => Math.abs(song.seconds - seconds) <= 2);
    if (near) return near;
  }
  return parsed[0];
}

function repairMetadata(song) {
  const metadata = {};
  if (song?.repair?.changed) metadata.repair = song.repair;
  if (song?.curationSignals?.reasons?.length) metadata.curationSignals = song.curationSignals;
  return metadata;
}

function countSongs(items) {
  return (items || []).reduce((sum, item) => sum + (item.songs || []).length, 0);
}

function buildCurationSummary(previous = {}, stats) {
  const newRuleDropped = stats.ruleDroppedEntryCount + stats.conversationDroppedEntryCount + stats.qualityDroppedEntryCount;
  return {
    ...(previous || {}),
    manualDroppedEntryCount: carryCount(previous.manualDroppedEntryCount, stats.manualDroppedEntryCount),
    manualReplacedEntryCount: carryCount(previous.manualReplacedEntryCount, stats.manualReplacedEntryCount),
    ruleDroppedEntryCount: carryCount(previous.ruleDroppedEntryCount, newRuleDropped),
    conversationDroppedEntryCount: carryCount(previous.conversationDroppedEntryCount, stats.conversationDroppedEntryCount),
    nearDuplicateDroppedEntryCount: carryCount(previous.nearDuplicateDroppedEntryCount, stats.nearDuplicateDroppedEntryCount),
    qualityDroppedEntryCount: carryCount(previous.qualityDroppedEntryCount, stats.qualityDroppedEntryCount),
    manualDroppedVideoCount: carryCount(previous.manualDroppedVideoCount, stats.droppedVideoCount),
    forceRefreshVideoCount: Math.max(numberOrZero(previous.forceRefreshVideoCount), stats.forceRefreshVideoIds.length),
    forceRefreshVideoIds: [...new Set([...(previous.forceRefreshVideoIds || []), ...stats.forceRefreshVideoIds])].sort(),
    fixedTitleCount: carryCount(previous.fixedTitleCount, stats.fixedTitleCount),
    fixedArtistCount: carryCount(previous.fixedArtistCount, stats.fixedArtistCount),
    artistBackfilledCount: carryCount(previous.artistBackfilledCount, stats.artistBackfilledCount),
    fixedSecondsCount: carryCount(previous.fixedSecondsCount, stats.fixedSecondsCount),
    repairedEntryCount: carryCount(previous.repairedEntryCount, stats.repairedEntryCount),
    parsedFromRawCount: Math.max(numberOrZero(previous.parsedFromRawCount), stats.parsedFromRaw),
    missingRawCount: Math.max(numberOrZero(previous.missingRawCount), stats.missingRawCount),
  };
}

function carryCount(previousValue, newValue) {
  const previous = numberOrZero(previousValue);
  const current = numberOrZero(newValue);
  return current > 0 ? previous + current : previous;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function attachSongSearchSummary(payload, summary) {
  return {
    ...payload,
    source: {
      ...(payload.source || {}),
      songSearch: summary,
    },
  };
}

function applyPostCurationSongIdentity(payload, songAliasContext, songSearchIndex, options = {}) {
  const previousArtistBackfill = payload.source?.artistBackfill || null;
  let next = canonicalizePayloadSongAliases(payload, songAliasContext);
  next = backfillMissingArtistsInPayload(next, {
    aliasContext: songAliasContext,
    supplementalKnownSongs: songSearchIndex?.supplementalKnownSongs || [],
  });
  next = canonicalizePayloadSongAliases(next, songAliasContext);
  if (options.preserveArtistBackfillSummary && previousArtistBackfill) {
    next = {
      ...next,
      source: {
        ...(next.source || {}),
        artistBackfill: previousArtistBackfill,
      },
    };
  }
  if (songSearchIndex?.titleKeys?.length || songSearchIndex?.titleArtistKeys?.length) {
    next = attachSongSearchSummary(annotatePayloadWithSongSearchNiche(next, songSearchIndex, songAliasContext), songSearchSourceSummary(songSearchIndex));
  }
  return next;
}

function writeDerivedStatus(payload) {
  const capturedAt = payload.capturedAt || payload.generatedAt || "";
  const status = {
    ...(payload.status || {}),
    status: "success",
    completedAt: payload.status?.completedAt || capturedAt,
    capturedAt,
    dataCapturedAt: capturedAt,
    rebuiltDerivedAt: payload.source?.rebuiltDerivedAt || payload.status?.rebuiltDerivedAt || "",
    itemCounts: Object.fromEntries(RANGES.map((rangeId) => [rangeId, payload.groups?.[rangeId]?.items?.length || 0])),
  };
  writeJson(STATUS_PATH, status);
}

function collectUniqueGroupVideos(groups) {
  const byVideoId = new Map();
  for (const group of Object.values(groups || {})) {
    for (const item of group.items || []) {
      if (!item?.videoId) continue;
      const existing = byVideoId.get(item.videoId);
      if (!existing || (item.songs?.length || 0) > (existing.songs?.length || 0)) byVideoId.set(item.videoId, item);
    }
  }
  return [...byVideoId.values()];
}

function normalizeArtist(value) {
  return String(value || "").trim() || "未記載";
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
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFileAtomic(filePath, text) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, text, "utf8");
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      if (attempt >= 5) {
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {}
        throw error;
      }
      sleepSync(200 * attempt);
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

module.exports = {
  rebuildSong,
};
