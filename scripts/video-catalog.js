const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const VIDEO_CATALOG_PATH = path.join(DATA_DIR, "video-catalog.json");
const CATALOG_MIGRATION_REPORT_PATH = path.join(DATA_DIR, "catalog-migration-report.json");
const CATALOG_SEGMENT_DIR = path.join(DATA_DIR, "catalog-segments");
const CATALOG_SEGMENT_MANIFEST_PATH = path.join(CATALOG_SEGMENT_DIR, "manifest.json");
const MONTH_CATALOG_DAYS = 35;
const MONTH_CATALOG_MS = MONTH_CATALOG_DAYS * 24 * 60 * 60 * 1000;
const CATALOG_RETENTION_POLICY = "permanent";
const CATALOG_SEGMENT_SIZE = positiveInteger(process.env.DAILY_SONG_CATALOG_SEGMENT_SIZE, 500);

function createEmptyVideoCatalog(generatedAt = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    generatedAt,
    retentionPolicy: CATALOG_RETENTION_POLICY,
    retentionDays: null,
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
  const retentionPolicy =
    catalog?.retentionPolicy || (catalog?.retentionDays == null ? CATALOG_RETENTION_POLICY : "legacy_month");
  return {
    schemaVersion: 1,
    generatedAt,
    retentionPolicy,
    retentionDays: retentionPolicy === CATALOG_RETENTION_POLICY ? null : catalog?.retentionDays ?? MONTH_CATALOG_DAYS,
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
      retentionPolicy: CATALOG_RETENTION_POLICY,
      retentionDays: null,
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
    channelUrl: entry.channelUrl,
    channelAvatarUrl: entry.channelAvatarUrl,
    channelThumbnailUrl: entry.channelThumbnailUrl,
    publishedTimestamp: entry.publishedTimestamp,
    publishedText: entry.publishedText,
    durationText: entry.durationText,
    thumbnailUrl: entry.thumbnailUrl,
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
  const previous = options.previousEntry || null;
  if (!songs.length) {
    if (previous && !verifiedReductionReason(video, options)) {
      return preservePreviousCatalogEntry(previous, video, nowIso, options, {
        reason: "incoming_empty_song_set",
        previousSongCount: normalizeSongs(previous.songs).length,
        incomingSongCount: 0,
        missingOccurrenceKeys: normalizeSongs(previous.songs).map(catalogSongOccurrenceKey).slice(0, 50),
      });
    }
    return null;
  }
  const regression = previous ? songSetRegression(previous.songs, songs) : null;
  if (regression?.isStrictSubset && !verifiedReductionReason(video, options)) {
    return preservePreviousCatalogEntry(previous, video, nowIso, options, {
      reason: "incoming_strict_song_subset",
      previousSongCount: regression.previousCount,
      incomingSongCount: regression.incomingCount,
      missingOccurrenceKeys: regression.missingKeys.slice(0, 50),
    });
  }
  const publishedTimestamp = finiteTimestamp(video.publishedTimestamp);
  return {
    videoId: video.videoId,
    title: stringValue(video.title),
    channelName: stringValue(video.channelName),
    channelId: stringValue(video.channelId),
    channelHandle: stringValue(video.channelHandle),
    channelUrl: stringValue(video.channelUrl || video.authorUrl || video.ownerUrl || previous?.channelUrl),
    channelAvatarUrl: stringValue(video.channelAvatarUrl || video.channelThumbnailUrl || previous?.channelAvatarUrl || previous?.channelThumbnailUrl),
    channelThumbnailUrl: stringValue(video.channelThumbnailUrl || video.channelAvatarUrl || previous?.channelThumbnailUrl || previous?.channelAvatarUrl),
    publishedTimestamp,
    publishedText: stringValue(video.publishedText || previous?.publishedText),
    durationText: stringValue(video.durationText || previous?.durationText),
    thumbnailUrl: stringValue(video.thumbnailUrl || video.thumbnail || previous?.thumbnailUrl),
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
    ...(regression?.isSuperset
      ? {
          regressionAudit: {
            reason: "incoming_song_superset",
            previousSongCount: regression.previousCount,
            incomingSongCount: regression.incomingCount,
            checkedAt: nowIso,
          },
        }
      : {}),
  };
}

function preservePreviousCatalogEntry(previous, video, nowIso, options, audit) {
  return {
    ...previous,
    lastSeenAt: nowIso,
    lastInspectedAt: stringValue(video.lastInspectedAt) || stringValue(video.catalogLastInspectedAt) || nowIso,
    discoveryGroups: uniqueValues([
      ...listValues(previous.discoveryGroups),
      ...listValues(video.sourceGroups),
      video.sourceGroup,
    ]),
    sourceUrls: uniqueValues([...listValues(previous.sourceUrls), ...listValues(video.sourceUrls)]),
    channelUrl: stringValue(video.channelUrl || video.authorUrl || video.ownerUrl || previous.channelUrl),
    channelAvatarUrl: stringValue(video.channelAvatarUrl || video.channelThumbnailUrl || previous.channelAvatarUrl || previous.channelThumbnailUrl),
    channelThumbnailUrl: stringValue(video.channelThumbnailUrl || video.channelAvatarUrl || previous.channelThumbnailUrl || previous.channelAvatarUrl),
    publishedText: stringValue(video.publishedText || previous.publishedText),
    durationText: stringValue(video.durationText || previous.durationText),
    thumbnailUrl: stringValue(video.thumbnailUrl || video.thumbnail || previous.thumbnailUrl),
    curationVersion: stringValue(options.curationVersion || video.curationVersion || previous.curationVersion),
    curationHash: stringValue(options.curationHash || video.curationHash || previous.curationHash),
    qualityStatus: "usable",
    regressionAudit: {
      ...audit,
      incomingSelectedSourceId: stringValue(video.selectedSourceId || video.sourceId),
      incomingSelectedSourceHash: stringValue(video.selectedSourceHash || video.sourceHash),
      previousSelectedSourceId: stringValue(previous.selectedSourceId),
      previousSelectedSourceHash: stringValue(previous.selectedSourceHash),
      checkedAt: nowIso,
    },
  };
}

function verifiedReductionReason(video, options = {}) {
  const reason = stringValue(video?.catalogReductionReason || video?.removalReason || options.reductionReason);
  return /^(?:manual_curation|curation_removed|blocklist|manual_tombstone|verified_parser_correction|verified_source_replacement|identity_merge)$/u.test(
    reason,
  );
}

function songSetRegression(previousSongs, incomingSongs) {
  const previousKeys = new Set(normalizeSongs(previousSongs).map(catalogSongOccurrenceKey));
  const incomingKeys = new Set(normalizeSongs(incomingSongs).map(catalogSongOccurrenceKey));
  if (!previousKeys.size || !incomingKeys.size) return null;
  const missingKeys = [...previousKeys].filter((key) => !incomingKeys.has(key));
  const addedKeys = [...incomingKeys].filter((key) => !previousKeys.has(key));
  return {
    previousCount: previousKeys.size,
    incomingCount: incomingKeys.size,
    missingKeys,
    addedKeys,
    isStrictSubset: missingKeys.length > 0 && addedKeys.length === 0,
    isSuperset: missingKeys.length === 0 && addedKeys.length > 0,
  };
}

function catalogSongOccurrenceKey(song) {
  return [
    Number.isInteger(song?.seconds) ? song.seconds : Math.max(0, Number(song?.seconds) || 0),
    cleanIdentityPart(song?.title),
    cleanIdentityPart(song?.artist),
    cleanIdentityPart(song?.rawHash || song?.raw),
  ].join("::");
}

function cleanIdentityPart(value) {
  return stringValue(value).normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
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
    channelUrl: stringValue(entry.channelUrl),
    channelAvatarUrl: stringValue(entry.channelAvatarUrl || entry.channelThumbnailUrl),
    channelThumbnailUrl: stringValue(entry.channelThumbnailUrl || entry.channelAvatarUrl),
    publishedTimestamp: finiteTimestamp(entry.publishedTimestamp),
    publishedText: stringValue(entry.publishedText),
    durationText: stringValue(entry.durationText),
    thumbnailUrl: stringValue(entry.thumbnailUrl || entry.thumbnail),
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
    ...(entry.regressionAudit && typeof entry.regressionAudit === "object" ? { regressionAudit: entry.regressionAudit } : {}),
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
  const allVideoCount = normalized.videos.filter((entry) => isWithinCatalogWindow(entry.publishedTimestamp, nowMs)).length;
  const monthVideoCount = normalized.videos.filter((entry) => isWithinLegacyMonthWindow(entry.publishedTimestamp, nowMs)).length;
  return {
    path: "data/video-catalog.json",
    generatedAt: normalized.generatedAt,
    retentionPolicy: CATALOG_RETENTION_POLICY,
    retentionDays: null,
    catalogVideoCount: normalized.videos.length,
    allVideoCount,
    monthVideoCount,
  };
}

function isWithinCatalogWindow(publishedTimestamp, nowMs) {
  if (!Number.isFinite(publishedTimestamp)) return true;
  const age = nowMs - publishedTimestamp;
  return age >= 0;
}

function isWithinLegacyMonthWindow(publishedTimestamp, nowMs) {
  if (!Number.isFinite(publishedTimestamp)) return false;
  const age = nowMs - publishedTimestamp;
  return age >= 0 && age <= MONTH_CATALOG_MS;
}

function buildCatalogSegments(catalog, options = {}) {
  const normalized = normalizeVideoCatalog(catalog);
  const segmentSize = positiveInteger(options.segmentSize, CATALOG_SEGMENT_SIZE);
  const baseDir = options.baseDir || "data/catalog-segments";
  const videos = normalized.videos || [];
  const chunks = chunkArray(videos, segmentSize);
  const segments = chunks.map((chunk, index) => {
    const segmentIndex = index + 1;
    const payload = {
      schemaVersion: 1,
      kind: "video-catalog-segment",
      generatedAt: normalized.generatedAt,
      retentionPolicy: CATALOG_RETENTION_POLICY,
      retentionDays: null,
      segmentIndex,
      segmentCount: chunks.length,
      segmentSize,
      itemCount: chunk.length,
      videos: chunk,
    };
    const text = stringifyJson(payload);
    const sha256 = sha256Text(text);
    return {
      payload,
      text,
      index: segmentIndex,
      file: `segment-${String(segmentIndex).padStart(4, "0")}.${sha256.slice(0, 12)}.json`,
      path: `${baseDir}/segment-${String(segmentIndex).padStart(4, "0")}.${sha256.slice(0, 12)}.json`,
      sha256,
      bytes: Buffer.byteLength(text, "utf8"),
      itemCount: chunk.length,
    };
  });
  const manifest = {
    schemaVersion: 1,
    kind: "video-catalog-segment-manifest",
    generatedAt: normalized.generatedAt,
    retentionPolicy: CATALOG_RETENTION_POLICY,
    retentionDays: null,
    segmentSize,
    itemCount: videos.length,
    segmentCount: segments.length,
    segments: segments.map(({ index, path: segmentPath, sha256, bytes, itemCount }) => ({
      index,
      path: segmentPath,
      sha256,
      bytes,
      itemCount,
    })),
  };
  return { manifest, segments };
}

function writeCatalogSegments(catalog, options = {}) {
  const baseDir = options.baseDir || "data/catalog-segments";
  const absoluteDir = path.join(ROOT, baseDir);
  const { manifest, segments } = buildCatalogSegments(catalog, { ...options, baseDir });
  fs.mkdirSync(absoluteDir, { recursive: true });
  const current = new Set();
  for (const segment of segments) {
    fs.writeFileSync(path.join(ROOT, segment.path), `${segment.text}\n`, "utf8");
    current.add(path.basename(segment.path));
  }
  cleanupOldCatalogSegments(absoluteDir, current);
  fs.writeFileSync(path.join(absoluteDir, "manifest.json"), `${stringifyJson(manifest)}\n`, "utf8");
  return manifest;
}

function cleanupOldCatalogSegments(absoluteDir, currentFiles) {
  if (!fs.existsSync(absoluteDir)) return;
  for (const name of fs.readdirSync(absoluteDir)) {
    if (!/^segment-\d{4}\.[0-9a-f]{12}\.json$/u.test(name)) continue;
    if (!currentFiles.has(name)) fs.unlinkSync(path.join(absoluteDir, name));
  }
}

function writeVideoCatalog(catalog, filePath = VIDEO_CATALOG_PATH, options = {}) {
  const normalized = normalizeVideoCatalog(catalog);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  writeCatalogSegments(normalized, options);
  return normalized;
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
    publishedText: entry.publishedText,
    durationText: entry.durationText,
    thumbnailUrl: entry.thumbnailUrl,
    channelUrl: entry.channelUrl,
    channelAvatarUrl: entry.channelAvatarUrl,
    channelThumbnailUrl: entry.channelThumbnailUrl,
    selectedSourceHash: entry.selectedSourceHash,
    songs: (entry.songs || []).map((song) => [song.seconds, song.title, song.artist]),
    curationVersion: entry.curationVersion,
    qualityStatus: entry.qualityStatus,
    regressionAudit: entry.regressionAudit || null,
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

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks.length ? chunks : [[]];
}

function stringifyJson(value) {
  return JSON.stringify(value);
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function positiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  CATALOG_MIGRATION_REPORT_PATH,
  CATALOG_RETENTION_POLICY,
  CATALOG_SEGMENT_MANIFEST_PATH,
  CATALOG_SEGMENT_SIZE,
  MONTH_CATALOG_DAYS,
  MONTH_CATALOG_MS,
  VIDEO_CATALOG_PATH,
  buildCatalogSegments,
  catalogSummary,
  catalogToVideos,
  createEmptyVideoCatalog,
  isWithinLegacyMonthWindow,
  isWithinCatalogWindow,
  loadVideoCatalog,
  mergeVideosIntoCatalog,
  normalizeVideoCatalog,
  rebuildVideoCatalogFromVideos,
  videoToCatalogEntry,
  writeCatalogSegments,
  writeVideoCatalog,
};
