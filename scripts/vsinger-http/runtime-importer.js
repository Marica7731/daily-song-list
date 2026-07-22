const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { matchBlockedSource } = require("../../assets/source-filter");
const { CANONICAL_RANGES, RANGE_TITLES, WEEK_MS, groupForRange } = require("../range-config");
const { SOURCE_SYSTEM } = require("./model");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_BACKFILL_DIR = path.join(ROOT, "data", "external", "vsinger-http", "backfill");
const SOURCE_GROUP = "vsinger-moment";
const SOURCE_GROUP_LABEL = "VSinger Moment";
const DISABLE_VALUES = new Set(["0", "false", "no", "off"]);

function augmentPayloadWithVsingerBackfill(payload, options = {}) {
  if (!payload || typeof payload !== "object") return payload;
  if (!shouldIncludeVsingerBackfill(options)) return payload;

  const importResult = loadVsingerBackfillRuntimeVideos(options);
  if (!importResult) return payload;

  const capturedAt = new Date(payload.capturedAt || payload.generatedAt || Date.now());
  const capturedMs = capturedAt.getTime();
  const groups = {};
  const rangeSummaries = {};

  for (const rangeId of CANONICAL_RANGES) {
    const sourceGroup = groupForRange(payload.groups, rangeId) || {};
    const baseItems = Array.isArray(sourceGroup.items) ? sourceGroup.items : [];
    const importItems = importResult.videos.filter((item) => videoBelongsToRange(item, rangeId, capturedMs));
    const merged = mergeVideoItems(baseItems, importItems);
    const generatedAt = latestIso(sourceGroup.generatedAt, importResult.summary.generatedAt) || sourceGroup.generatedAt || payload.generatedAt || "";

    groups[rangeId] = {
      ...sourceGroup,
      id: rangeId,
      title: sourceGroup.title || RANGE_TITLES[rangeId] || rangeId,
      generatedAt,
      updatedAt: latestIso(sourceGroup.updatedAt, generatedAt) || generatedAt,
      items: sortVideos(merged.items),
    };
    rangeSummaries[rangeId] = {
      importedVideoCount: importItems.length,
      mergedExistingVideoCount: merged.mergedExistingVideoCount,
      appendedVideoCount: merged.appendedVideoCount,
      itemCount: groups[rangeId].items.length,
      occurrenceCount: sumSongCount(groups[rangeId].items),
    };
  }

  const legacyGroups = Object.fromEntries(
    Object.entries(payload.groups || {}).filter(([groupId]) => !CANONICAL_RANGES.includes(groupId)),
  );
  const externalSources = {
    ...(payload.source?.externalSources || {}),
    vsingerMoment: {
      ...importResult.summary,
      ranges: rangeSummaries,
    },
  };

  return {
    ...payload,
    groups: {
      ...legacyGroups,
      ...groups,
    },
    source: {
      ...(payload.source || {}),
      externalSources,
    },
  };
}

function shouldIncludeVsingerBackfill(options = {}) {
  if (options.include === false) return false;
  const value = options.envValue ?? process.env.DAILY_SONG_INCLUDE_VSINGER_BACKFILL;
  if (value == null || value === "") return true;
  return !DISABLE_VALUES.has(String(value).trim().toLowerCase());
}

function loadVsingerBackfillRuntimeVideos(options = {}) {
  const backfillDir = options.backfillDir || DEFAULT_BACKFILL_DIR;
  const manifestPath = path.join(backfillDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    if (options.required) throw new Error(`VSinger backfill manifest not found: ${manifestPath}`);
    return null;
  }

  const manifest = readJson(manifestPath);
  const coverage = readManifestObjectShard(backfillDir, manifest, "coverage");
  assertCompleteBackfill(manifest, coverage, options);

  const songs = readManifestArrayShards(backfillDir, manifest, "songs");
  const videos = readManifestArrayShards(backfillDir, manifest, "videos");
  const occurrences = readManifestArrayShards(backfillDir, manifest, "occurrences");
  assertManifestCount(manifest, "songs", songs.length);
  assertManifestCount(manifest, "videos", videos.length);
  assertManifestCount(manifest, "occurrences", occurrences.length);

  const buildResult = buildRuntimeVideosFromBundle({ songs, videos, occurrences, manifest, coverage });
  return {
    videos: buildResult.videos,
    summary: {
      sourceSystem: SOURCE_SYSTEM,
      sourceGroup: SOURCE_GROUP,
      label: SOURCE_GROUP_LABEL,
      generatedAt: manifest.generatedAt || "",
      manifestPath: path.relative(ROOT, manifestPath).replace(/\\/g, "/"),
      counts: manifest.counts || {},
      importedSongCount: songs.length,
      importedVideoCount: buildResult.videos.length,
      importedOccurrenceCount: buildResult.occurrenceCount,
      skippedInvalidVideoCount: buildResult.skippedInvalidVideoCount,
      skippedNoSongsVideoCount: buildResult.skippedNoSongsVideoCount,
      skippedBlockedVideoCount: buildResult.skippedBlockedVideoCount,
      coverage: summarizeCoverage(coverage),
    },
  };
}

function assertCompleteBackfill(manifest, coverage, options = {}) {
  if (manifest?.sourceSystem !== SOURCE_SYSTEM) {
    throw new Error(`VSinger backfill sourceSystem must be ${SOURCE_SYSTEM}`);
  }
  if ((Number(manifest?.counts?.failures) || 0) !== 0) {
    throw new Error("VSinger backfill has recorded failures");
  }
  if (options.allowPartial) return;
  if (coverage?.overallStatus !== "complete") {
    throw new Error(`VSinger backfill coverage is not complete: ${coverage?.overallStatus || "missing"}`);
  }
  const singerSongs = coverage?.stages?.singerSongs || {};
  if (singerSongs.coverageStatus !== "complete" || singerSongs.detailCoverageStatus !== "complete") {
    throw new Error("VSinger singer-scoped song coverage is not complete");
  }
  if (singerSongs.ownerPermission?.enabled !== true) {
    throw new Error("VSinger singer-scoped song import requires recorded owner permission");
  }
}

function buildRuntimeVideosFromBundle(bundle) {
  const songsByCanonicalId = new Map();
  const songsByExternalId = new Map();
  for (const song of bundle.songs || []) {
    if (song.canonicalSongId) songsByCanonicalId.set(song.canonicalSongId, song);
    if (song.externalSongId) songsByExternalId.set(song.externalSongId, song);
  }

  const occurrencesByVideoId = new Map();
  for (const occurrence of bundle.occurrences || []) {
    const videoId = cleanText(occurrence.youtubeVideoId);
    if (!isValidYouTubeVideoId(videoId)) continue;
    const seconds = normalizeSeconds(occurrence.seconds);
    const song = songsByCanonicalId.get(occurrence.canonicalSongId) || songsByExternalId.get(occurrence.externalSongId) || null;
    const runtimeSong = buildRuntimeSong(song, occurrence, seconds);
    if (!runtimeSong.title) continue;
    if (!occurrencesByVideoId.has(videoId)) occurrencesByVideoId.set(videoId, []);
    occurrencesByVideoId.get(videoId).push(runtimeSong);
  }

  let skippedInvalidVideoCount = 0;
  let skippedNoSongsVideoCount = 0;
  let skippedBlockedVideoCount = 0;
  const result = [];
  const seenVideoIds = new Set();
  for (const video of bundle.videos || []) {
    const videoId = cleanText(video.youtubeVideoId);
    if (!isValidYouTubeVideoId(videoId)) {
      skippedInvalidVideoCount += 1;
      continue;
    }
    if (seenVideoIds.has(videoId)) continue;
    seenVideoIds.add(videoId);

    const songs = mergeSongItems([], occurrencesByVideoId.get(videoId) || []);
    if (!songs.length) {
      skippedNoSongsVideoCount += 1;
      continue;
    }

    const runtimeVideo = {
      videoId,
      title: cleanText(video.title),
      channelName: cleanText(video.singerName),
      channelId: "",
      channelHandle: "",
      channelUrl: "",
      keyword: SOURCE_GROUP_LABEL,
      publishedText: cleanText(video.streamedAt),
      publishedTimestamp: parseVsingerDateTimestamp(video.streamedAt),
      sourceGroups: [SOURCE_GROUP],
      sourceUrls: uniqueValues([video.sourceUrl, `https://www.youtube.com/watch?v=${videoId}`]),
      selectedSourceId: video.externalVideoId ? `${SOURCE_GROUP}:${video.externalVideoId}` : `${SOURCE_GROUP}:${videoId}`,
      selectedSourceHash: video.externalVideoId || "",
      sourceQuality: {
        sourceType: "external",
        sourceSystem: SOURCE_SYSTEM,
        sourceGroup: SOURCE_GROUP,
        verificationStatus: video.verificationStatus || "externally_reported",
        generatedAt: bundle.manifest?.generatedAt || "",
      },
      songs,
    };
    if (matchBlockedSource(runtimeVideo)) {
      skippedBlockedVideoCount += 1;
      continue;
    }
    result.push(runtimeVideo);
  }

  return {
    videos: sortVideos(result),
    occurrenceCount: sumSongCount(result),
    skippedInvalidVideoCount,
    skippedNoSongsVideoCount,
    skippedBlockedVideoCount,
  };
}

function buildRuntimeSong(song, occurrence, seconds) {
  const title = cleanText(song?.displayTitle || occurrence?.displayTitle || occurrence?.rawTitle || "");
  const artist = cleanText(song?.displayArtist || occurrence?.displayArtist || occurrence?.rawArtist || "");
  return {
    time: formatSeconds(seconds),
    seconds,
    title,
    artist,
    raw: artist ? `${formatSeconds(seconds)} ${title} / ${artist}` : `${formatSeconds(seconds)} ${title}`,
    sourceId: occurrence?.externalSongId || song?.externalSongId || occurrence?.canonicalSongId || "",
    sourceHash: occurrence?.provenance?.hash || song?.provenance?.hash || "",
    isNiche: true,
  };
}

function mergeVideoItems(baseItems, importItems) {
  const byVideoId = new Map();
  for (const item of baseItems || []) {
    if (!item?.videoId || byVideoId.has(item.videoId)) continue;
    byVideoId.set(item.videoId, cloneJson(item));
  }

  let mergedExistingVideoCount = 0;
  let appendedVideoCount = 0;
  for (const item of importItems || []) {
    if (!item?.videoId) continue;
    const existing = byVideoId.get(item.videoId);
    if (!existing) {
      byVideoId.set(item.videoId, cloneJson(item));
      appendedVideoCount += 1;
      continue;
    }
    byVideoId.set(item.videoId, mergeVideoItem(existing, item));
    mergedExistingVideoCount += 1;
  }

  return {
    items: Array.from(byVideoId.values()),
    mergedExistingVideoCount,
    appendedVideoCount,
  };
}

function mergeVideoItem(base, imported) {
  const merged = {
    ...imported,
    ...base,
    title: base.title || imported.title || "",
    channelName: base.channelName || imported.channelName || "",
    channelId: base.channelId || imported.channelId || "",
    channelHandle: base.channelHandle || imported.channelHandle || "",
    channelUrl: base.channelUrl || imported.channelUrl || "",
    channelAvatarUrl: base.channelAvatarUrl || base.channelThumbnailUrl || imported.channelAvatarUrl || imported.channelThumbnailUrl || "",
    channelThumbnailUrl: base.channelThumbnailUrl || base.channelAvatarUrl || imported.channelThumbnailUrl || imported.channelAvatarUrl || "",
    keyword: base.keyword || imported.keyword || "",
    publishedText: base.publishedText || imported.publishedText || "",
    publishedTimestamp: base.publishedTimestamp || imported.publishedTimestamp || null,
    durationText: base.durationText || imported.durationText || "",
    thumbnailUrl: base.thumbnailUrl || base.thumbnail || imported.thumbnailUrl || imported.thumbnail || "",
    sourceGroups: uniqueValues([...(base.sourceGroups || []), base.sourceGroup, ...(imported.sourceGroups || []), imported.sourceGroup]),
    sourceUrls: uniqueValues([...(base.sourceUrls || []), base.sourceUrl, ...(imported.sourceUrls || []), imported.sourceUrl]),
    selectedSourceId: base.selectedSourceId || base.sourceId || imported.selectedSourceId || imported.sourceId || "",
    selectedSourceHash: base.selectedSourceHash || base.sourceHash || imported.selectedSourceHash || imported.sourceHash || "",
    sourceQuality: base.sourceQuality || imported.sourceQuality || null,
    songs: mergeSongItems(base.songs || [], imported.songs || []),
  };
  if (!merged.channelUrl) delete merged.channelUrl;
  return merged;
}

function mergeSongItems(baseSongs, importedSongs) {
  const byKey = new Map();
  for (const song of [...(baseSongs || []), ...(importedSongs || [])]) {
    const normalized = normalizeSong(song);
    if (!normalized.title) continue;
    const key = songMergeKey(normalized);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, normalized);
      continue;
    }
    byKey.set(key, pickRicherSong(existing, normalized));
  }
  return Array.from(byKey.values()).sort((a, b) => a.seconds - b.seconds || compareValues(a.title, b.title) || compareValues(a.artist, b.artist));
}

function normalizeSong(song) {
  const seconds = normalizeSeconds(song?.seconds);
  return {
    ...song,
    time: song?.time || formatSeconds(seconds),
    seconds,
    title: cleanText(song?.title),
    artist: cleanText(song?.artist),
    raw: song?.raw || "",
    isNiche: song?.isNiche === true,
  };
}

function pickRicherSong(a, b) {
  if (!a.artist && b.artist) return { ...a, ...b };
  if (!a.raw && b.raw) return { ...b, ...a, raw: b.raw };
  return a;
}

function songMergeKey(song) {
  return [song.seconds, normalizeKey(song.title), normalizeKey(song.artist)].join("\u0001");
}

function videoBelongsToRange(item, rangeId, capturedMs) {
  const timestamp = Number(item.publishedTimestamp);
  if (rangeId === "7d") return Number.isFinite(timestamp) && capturedMs - timestamp >= 0 && capturedMs - timestamp <= WEEK_MS;
  if (rangeId === "all") return !Number.isFinite(timestamp) || !Number.isFinite(capturedMs) || capturedMs - timestamp >= 0;
  return true;
}

function sortVideos(items) {
  return [...(items || [])].sort((a, b) => {
    const timeDiff = (Number(b.publishedTimestamp) || 0) - (Number(a.publishedTimestamp) || 0);
    if (timeDiff) return timeDiff;
    const songDiff = (b.songs?.length || 0) - (a.songs?.length || 0);
    if (songDiff) return songDiff;
    return compareValues(a.videoId, b.videoId);
  });
}

function readManifestArrayShards(backfillDir, manifest, key) {
  return readManifestShards(backfillDir, manifest, key).flatMap((value) => {
    if (!Array.isArray(value)) throw new Error(`VSinger ${key} shard must be an array`);
    return value;
  });
}

function readManifestObjectShard(backfillDir, manifest, key) {
  const shards = readManifestShards(backfillDir, manifest, key);
  if (!shards.length) return null;
  if (shards.length !== 1 || !shards[0] || typeof shards[0] !== "object" || Array.isArray(shards[0])) {
    throw new Error(`VSinger ${key} shard must be a single object`);
  }
  return shards[0];
}

function readManifestShards(backfillDir, manifest, key) {
  const shards = manifest?.shards?.[key] || [];
  const values = [];
  for (const shard of shards) {
    const filePath = path.join(backfillDir, shard.file || "");
    const value = readJson(filePath);
    if (sha256Json(value) !== shard.sha256) {
      throw new Error(`VSinger ${key} shard checksum mismatch: ${shard.file}`);
    }
    if (Array.isArray(value) && Number.isInteger(shard.count) && value.length !== shard.count) {
      throw new Error(`VSinger ${key} shard count mismatch: ${shard.file}`);
    }
    values.push(value);
  }
  return values;
}

function assertManifestCount(manifest, key, actualCount) {
  const expected = Number(manifest?.counts?.[key]);
  if (Number.isFinite(expected) && actualCount !== expected) {
    throw new Error(`VSinger ${key} count mismatch: expected ${expected}, got ${actualCount}`);
  }
}

function summarizeCoverage(coverage) {
  const singerSongs = coverage?.stages?.singerSongs || {};
  return {
    overallStatus: coverage?.overallStatus || "",
    singerSongs: {
      coverageStatus: singerSongs.coverageStatus || "",
      detailCoverageStatus: singerSongs.detailCoverageStatus || "",
      singersProcessed: Number(singerSongs.singersProcessed) || 0,
      ownerPermission: singerSongs.ownerPermission
        ? {
            enabled: singerSongs.ownerPermission.enabled === true,
            acceptedAt: singerSongs.ownerPermission.acceptedAt || "",
          }
        : null,
    },
    failureCount: Number(coverage?.failureCount) || 0,
    conflictCount: Number(coverage?.conflictCount) || 0,
  };
}

function parseVsingerDateTimestamp(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return null;
  const timestamp = Date.parse(`${match[1]}-${match[2]}-${match[3]}T12:00:00+09:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatSeconds(value) {
  const totalSeconds = normalizeSeconds(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function normalizeSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function isValidYouTubeVideoId(value) {
  return /^[A-Za-z0-9_-]{11}$/u.test(value || "");
}

function cleanText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeKey(value) {
  return cleanText(value).toLocaleLowerCase();
}

function compareValues(a, b) {
  return String(a || "").localeCompare(String(b || ""), "en", {
    numeric: true,
    sensitivity: "base",
  });
}

function uniqueValues(values) {
  return Array.from(new Set((values || []).filter(Boolean).map(String)));
}

function latestIso(...values) {
  let latest = "";
  let latestMs = Number.NaN;
  for (const value of values) {
    const ms = Date.parse(value || "");
    if (!Number.isFinite(ms)) continue;
    if (!latest || ms > latestMs) {
      latest = value;
      latestMs = ms;
    }
  }
  return latest;
}

function sumSongCount(items) {
  return (items || []).reduce((sum, item) => sum + (Array.isArray(item.songs) ? item.songs.length : 0), 0);
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  DEFAULT_BACKFILL_DIR,
  SOURCE_GROUP,
  SOURCE_SYSTEM,
  augmentPayloadWithVsingerBackfill,
  buildRuntimeVideosFromBundle,
  loadVsingerBackfillRuntimeVideos,
  mergeSongItems,
  mergeVideoItems,
  parseVsingerDateTimestamp,
  shouldIncludeVsingerBackfill,
  sortVideos,
  videoBelongsToRange,
};
