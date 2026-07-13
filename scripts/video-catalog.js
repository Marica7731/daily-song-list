const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const VIDEO_CATALOG_PATH = path.join(DATA_DIR, "video-catalog.json");
const CATALOG_MIGRATION_REPORT_PATH = path.join(DATA_DIR, "catalog-migration-report.json");
const MONTH_CATALOG_DAYS = 35;
const MONTH_CATALOG_MS = MONTH_CATALOG_DAYS * 24 * 60 * 60 * 1000;

function createEmptyVideoCatalog(generatedAt = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    generatedAt,
    retentionDays: MONTH_CATALOG_DAYS,
    videos: [],
  };
}

function loadVideoCatalog(filePath = VIDEO_CATALOG_PATH) {
  if (!fs.existsSync(filePath)) return createEmptyVideoCatalog();
  const catalog = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return normalizeVideoCatalog(catalog);
}

function normalizeVideoCatalog(catalog) {
  const generatedAt = stringValue(catalog?.generatedAt) || new Date().toISOString();
  return {
    schemaVersion: 1,
    generatedAt,
    retentionDays: MONTH_CATALOG_DAYS,
    videos: Array.isArray(catalog?.videos) ? catalog.videos.map(normalizeCatalogEntry).filter(Boolean) : [],
  };
}

function rebuildVideoCatalogFromVideos(videos, capturedAt, options = {}) {
  const now = asDate(capturedAt);
  const nowIso = now.toISOString();
  const previous = options.previousCatalog ? normalizeVideoCatalog(options.previousCatalog) : createEmptyVideoCatalog(nowIso);
  const previousByVideoId = new Map(previous.videos.map((entry) => [entry.videoId, entry]));
  const byVideoId = new Map();
  const stats = {
    inputVideoCount: 0,
    catalogVideoCount: 0,
    addedVideoCount: 0,
    updatedVideoCount: 0,
    expiredVideoCount: 0,
    skippedInvalidVideoCount: 0,
  };

  for (const video of videos || []) {
    stats.inputVideoCount += 1;
    const previousEntry = previousByVideoId.get(video?.videoId);
    const entry = videoToCatalogEntry(video, nowIso, {
      previousEntry,
      curationVersion: options.curationVersion,
      curationHash: options.curationHash,
      qualityStatus: options.qualityStatus || "usable",
    });
    if (!entry) {
      stats.skippedInvalidVideoCount += 1;
      continue;
    }
    const existing = byVideoId.get(entry.videoId);
    if (!existing || isBetterCatalogEntry(entry, existing)) byVideoId.set(entry.videoId, entry);
  }

  const retained = [];
  for (const entry of byVideoId.values()) {
    if (!isWithinCatalogWindow(entry.publishedTimestamp, now.getTime())) {
      stats.expiredVideoCount += 1;
      continue;
    }
    const previousEntry = previousByVideoId.get(entry.videoId);
    if (!previousEntry) stats.addedVideoCount += 1;
    else if (catalogEntrySignature(previousEntry) !== catalogEntrySignature(entry)) stats.updatedVideoCount += 1;
    retained.push(entry);
  }
  retained.sort(compareCatalogEntries);
  stats.catalogVideoCount = retained.length;

  return {
    catalog: {
      schemaVersion: 1,
      generatedAt: nowIso,
      retentionDays: MONTH_CATALOG_DAYS,
      videos: retained,
    },
    stats,
  };
}

function mergeVideosIntoCatalog(catalog, videos, capturedAt, options = {}) {
  const previous = normalizeVideoCatalog(catalog);
  const existingVideos = catalogToVideos(previous);
  const incomingIds = new Set((videos || []).map((video) => video?.videoId).filter(Boolean));
  const merged = [
    ...existingVideos.filter((video) => !incomingIds.has(video.videoId)),
    ...(videos || []),
  ];
  return rebuildVideoCatalogFromVideos(merged, capturedAt, { ...options, previousCatalog: previous });
}

function catalogToVideos(catalog) {
  return normalizeVideoCatalog(catalog).videos.map((entry) => ({
    videoId: entry.videoId,
    title: entry.title,
    channelName: entry.channelName,
    channelId: entry.channelId,
    channelHandle: entry.channelHandle,
    publishedTimestamp: entry.publishedTimestamp,
    sourceGroups: [...entry.discoveryGroups],
    sourceUrls: [...entry.sourceUrls],
    selectedSourceId: entry.selectedSourceId,
    selectedSourceHash: entry.selectedSourceHash,
    songs: (entry.songs || []).map((song, index) => ({ ...song, index: index + 1 })),
    catalogFirstSeenAt: entry.firstSeenAt,
    catalogLastSeenAt: entry.lastSeenAt,
    catalogLastInspectedAt: entry.lastInspectedAt,
    qualityStatus: entry.qualityStatus,
  }));
}

function videoToCatalogEntry(video, nowIso, options = {}) {
  if (!isValidVideoId(video?.videoId)) return null;
  const songs = normalizeSongs(video.songs);
  if (!songs.length) return null;
  const previous = options.previousEntry || null;
  const publishedTimestamp = finiteTimestamp(video.publishedTimestamp);
  return {
    videoId: video.videoId,
    title: stringValue(video.title),
    channelName: stringValue(video.channelName),
    channelId: stringValue(video.channelId),
    channelHandle: stringValue(video.channelHandle),
    publishedTimestamp,
    firstSeenAt: stringValue(previous?.firstSeenAt) || nowIso,
    lastSeenAt: nowIso,
    lastInspectedAt: stringValue(video.lastInspectedAt) || stringValue(video.catalogLastInspectedAt) || nowIso,
    discoveryGroups: uniqueValues([
      ...listValues(previous?.discoveryGroups),
      ...listValues(video.sourceGroups),
      video.sourceGroup,
    ]),
    sourceUrls: uniqueValues([...listValues(previous?.sourceUrls), ...listValues(video.sourceUrls)]),
    selectedSourceId: stringValue(video.selectedSourceId || video.sourceId),
    selectedSourceHash: stringValue(video.selectedSourceHash || video.sourceHash),
    songs,
    curationVersion: stringValue(options.curationVersion || video.curationVersion || previous?.curationVersion),
    curationHash: stringValue(options.curationHash || video.curationHash || previous?.curationHash),
    qualityStatus: stringValue(options.qualityStatus || video.qualityStatus || previous?.qualityStatus) || "usable",
  };
}

function normalizeCatalogEntry(entry) {
  if (!isValidVideoId(entry?.videoId)) return null;
  const songs = normalizeSongs(entry.songs);
  if (!songs.length) return null;
  return {
    videoId: entry.videoId,
    title: stringValue(entry.title),
    channelName: stringValue(entry.channelName),
    channelId: stringValue(entry.channelId),
    channelHandle: stringValue(entry.channelHandle),
    publishedTimestamp: finiteTimestamp(entry.publishedTimestamp),
    firstSeenAt: stringValue(entry.firstSeenAt),
    lastSeenAt: stringValue(entry.lastSeenAt),
    lastInspectedAt: stringValue(entry.lastInspectedAt),
    discoveryGroups: uniqueValues(listValues(entry.discoveryGroups)),
    sourceUrls: uniqueValues(listValues(entry.sourceUrls)),
    selectedSourceId: stringValue(entry.selectedSourceId),
    selectedSourceHash: stringValue(entry.selectedSourceHash),
    songs,
    curationVersion: stringValue(entry.curationVersion),
    curationHash: stringValue(entry.curationHash),
    qualityStatus: stringValue(entry.qualityStatus) || "usable",
  };
}

function normalizeSongs(songs) {
  return (songs || [])
    .map((song, index) => ({
      ...song,
      index: index + 1,
      seconds: Number.isInteger(song?.seconds) ? song.seconds : Math.max(0, Number(song?.seconds) || 0),
      title: stringValue(song?.title),
      artist: stringValue(song?.artist) || "未記載",
    }))
    .filter((song) => song.title);
}

function catalogSummary(catalog, capturedAt) {
  const normalized = normalizeVideoCatalog(catalog);
  const nowMs = asDate(capturedAt).getTime();
  const monthVideoCount = normalized.videos.filter((entry) => isWithinCatalogWindow(entry.publishedTimestamp, nowMs)).length;
  return {
    path: "data/video-catalog.json",
    generatedAt: normalized.generatedAt,
    retentionDays: MONTH_CATALOG_DAYS,
    catalogVideoCount: normalized.videos.length,
    monthVideoCount,
  };
}

function isWithinCatalogWindow(publishedTimestamp, nowMs) {
  if (!Number.isFinite(publishedTimestamp)) return false;
  const age = nowMs - publishedTimestamp;
  return age >= 0 && age <= MONTH_CATALOG_MS;
}

function isBetterCatalogEntry(candidate, existing) {
  const timeDiff = (candidate.lastInspectedAt || "").localeCompare(existing.lastInspectedAt || "");
  if (timeDiff) return timeDiff > 0;
  return (candidate.songs?.length || 0) > (existing.songs?.length || 0);
}

function compareCatalogEntries(a, b) {
  const timeDiff = (b.publishedTimestamp || 0) - (a.publishedTimestamp || 0);
  if (timeDiff) return timeDiff;
  return a.videoId.localeCompare(b.videoId);
}

function catalogEntrySignature(entry) {
  return JSON.stringify({
    publishedTimestamp: entry.publishedTimestamp,
    selectedSourceHash: entry.selectedSourceHash,
    songs: (entry.songs || []).map((song) => [song.seconds, song.title, song.artist]),
    curationVersion: entry.curationVersion,
    qualityStatus: entry.qualityStatus,
  });
}

function listValues(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return value ? [String(value)] : [];
}

function uniqueValues(values) {
  return [...new Set((values || []).filter(Boolean).map(String))];
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function isValidVideoId(value) {
  return /^[A-Za-z0-9_-]{11}$/.test(String(value || ""));
}

function asDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

module.exports = {
  CATALOG_MIGRATION_REPORT_PATH,
  MONTH_CATALOG_DAYS,
  MONTH_CATALOG_MS,
  VIDEO_CATALOG_PATH,
  catalogSummary,
  catalogToVideos,
  createEmptyVideoCatalog,
  isWithinCatalogWindow,
  loadVideoCatalog,
  mergeVideosIntoCatalog,
  normalizeVideoCatalog,
  rebuildVideoCatalogFromVideos,
  videoToCatalogEntry,
};
