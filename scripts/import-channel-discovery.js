const fs = require("node:fs");
const path = require("node:path");

const { loadCurationContext } = require("./curation");
const {
  VIDEO_CATALOG_PATH,
  loadVideoCatalog,
  mergeVideosIntoCatalog,
  writeCatalogSegments,
  writeVideoCatalog,
} = require("./video-catalog");
const { isLikelyNonSongEntry, normalizeParsedSong } = require("./song-utils");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_GROUP = "youtube_channel_discovery";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = inputDirsFromArgs(args);
  const startedAt = new Date().toISOString();
  const curation = loadCurationContext();
  const before = loadVideoCatalog();
  const { videos, stats: readStats } = readDiscoveryVideos(inputs);
  if (!videos.length && !args["allow-empty"]) {
    throw new Error(`no usable channel discovery video details found in ${inputs.join(", ")}`);
  }
  const safeImport = filterNonRegressiveImports(before, videos);
  const importedVideos = safeImport.videos.map((video) => ({
    ...video,
    curationVersion: curation.version,
    curationHash: curation.hash,
  }));
  const update = mergeVideosIntoCatalog(before, importedVideos, startedAt);
  writeVideoCatalog(update.catalog, VIDEO_CATALOG_PATH);
  const segmentStats = writeCatalogSegments(update.catalog);
  const beforeVideoIds = new Set(before.videos.map((entry) => entry.videoId));
  const candidateVideoIds = new Set(videos.map((video) => video.videoId));
  const importedVideoIds = new Set(importedVideos.map((video) => video.videoId));
  const report = {
    schemaVersion: 1,
    kind: "youtube-channel-discovery-import",
    generatedAt: startedAt,
    inputs,
    readStats: { ...readStats, ...safeImport.stats },
    catalogStats: update.stats,
    segmentStats,
    candidateVideoIds: [...candidateVideoIds].sort(),
    importedVideoIds: [...importedVideoIds].sort(),
    addedVideoIds: [...importedVideoIds].filter((videoId) => !beforeVideoIds.has(videoId)).sort(),
  };
  const reportPath = path.resolve(ROOT, String(args["report-path"] || path.join("artifacts", "channel-discovery", "import-report.json")));
  writeJson(reportPath, report);
  console.log(
    [
      "CODEX_CHANNEL_DISCOVERY_IMPORT_OK",
      `inputs=${inputs.length}`,
      `readVideos=${readStats.videoDetails}`,
      `usableVideos=${videos.length}`,
      `importedVideos=${importedVideos.length}`,
      `skippedRegressions=${safeImport.stats.skippedExistingRegressions}`,
      `songs=${readStats.songs}`,
      `catalogBefore=${before.videos.length}`,
      `catalogAfter=${update.catalog.videos.length}`,
      `added=${update.stats.addedVideoCount}`,
      `updated=${update.stats.updatedVideoCount}`,
      `segments=${segmentStats.segmentCount}`,
      `report=${quoteForMarker(reportPath)}`,
    ].join(" "),
  );
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    const value = !next || next.startsWith("--") ? true : next;
    if (value !== true) index += 1;
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      args[key] = Array.isArray(args[key]) ? [...args[key], value] : [args[key], value];
    } else {
      args[key] = value;
    }
  }
  return args;
}

function inputDirsFromArgs(args) {
  const values = listValues(args["input-dir"] || args.input || args._);
  const dirs = values.map((value) => path.resolve(ROOT, String(value || ""))).filter(Boolean);
  if (!dirs.length) {
    throw new Error("Usage: npm run youtube:import-channel-discovery -- --input-dir <discovery output dir>");
  }
  return [...new Set(dirs)];
}

function readDiscoveryVideos(inputDirs) {
  const videos = [];
  const seen = new Set();
  const stats = {
    inputDirs: inputDirs.length,
    videoDetails: 0,
    usableVideos: 0,
    skippedNoSongs: 0,
    skippedInvalidVideoId: 0,
    duplicateVideoIds: 0,
    songs: 0,
    videosWithPublishedTimestamp: 0,
    videosWithThumbnail: 0,
    songsWithTimestamp: 0,
    inputSummaries: [],
  };
  for (const inputDir of inputDirs) {
    const filePath = path.join(inputDir, "video-details.json");
    if (!fs.existsSync(filePath)) throw new Error(`video-details.json not found: ${filePath}`);
    const details = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(details)) throw new Error(`video-details.json must be an array: ${filePath}`);
    const inputStats = {
      inputDir: projectRelativePath(inputDir),
      videoDetails: 0,
      usableVideos: 0,
      skippedNoSongs: 0,
      skippedInvalidVideoId: 0,
      duplicateVideoIds: 0,
      songs: 0,
      videosWithPublishedTimestamp: 0,
      videosWithThumbnail: 0,
      songsWithTimestamp: 0,
    };
    for (const detail of details) {
      stats.videoDetails += 1;
      inputStats.videoDetails += 1;
      const videoId = String(detail?.videoId || "").trim();
      if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) {
        stats.skippedInvalidVideoId += 1;
        inputStats.skippedInvalidVideoId += 1;
        continue;
      }
      const songs = Array.isArray(detail.songs) ? detail.songs.map(normalizeParsedSong).filter(isImportableSong) : [];
      if (!songs.length) {
        stats.skippedNoSongs += 1;
        inputStats.skippedNoSongs += 1;
        continue;
      }
      if (seen.has(videoId)) {
        stats.duplicateVideoIds += 1;
        inputStats.duplicateVideoIds += 1;
        continue;
      }
      seen.add(videoId);
      videos.push(normalizeImportedVideo(detail, inputDir, songs));
      stats.usableVideos += 1;
      stats.songs += songs.length;
      stats.videosWithPublishedTimestamp += finiteTimestamp(detail.publishedTimestamp) ? 1 : 0;
      stats.videosWithThumbnail += stringValue(detail.thumbnailUrl) || fallbackThumbnailUrl(videoId) ? 1 : 0;
      stats.songsWithTimestamp += songs.filter((song) => Number.isFinite(Number(song.seconds))).length;
      inputStats.usableVideos += 1;
      inputStats.songs += songs.length;
      inputStats.videosWithPublishedTimestamp += finiteTimestamp(detail.publishedTimestamp) ? 1 : 0;
      inputStats.videosWithThumbnail += stringValue(detail.thumbnailUrl) || fallbackThumbnailUrl(videoId) ? 1 : 0;
      inputStats.songsWithTimestamp += songs.filter((song) => Number.isFinite(Number(song.seconds))).length;
    }
    stats.inputSummaries.push(inputStats);
  }
  return { videos, stats };
}

function filterNonRegressiveImports(catalog, videos) {
  const previousByVideoId = new Map((catalog.videos || []).map((entry) => [entry.videoId, entry]));
  const kept = [];
  const stats = {
    skippedExistingRegressions: 0,
    skippedExistingRegressionVideoIds: [],
  };
  for (const video of videos) {
    const previous = previousByVideoId.get(video.videoId);
    if (previous && isStrictSongSubset(previous.songs, video.songs)) {
      stats.skippedExistingRegressions += 1;
      stats.skippedExistingRegressionVideoIds.push(video.videoId);
      continue;
    }
    kept.push(video);
  }
  stats.skippedExistingRegressionVideoIds.sort();
  return { videos: kept, stats };
}

function isStrictSongSubset(previousSongs, incomingSongs) {
  const previousKeys = new Set((previousSongs || []).map(songKey).filter(Boolean));
  const incomingKeys = new Set((incomingSongs || []).map(songKey).filter(Boolean));
  if (!previousKeys.size || !incomingKeys.size) return false;
  let missing = 0;
  for (const key of previousKeys) {
    if (!incomingKeys.has(key)) missing += 1;
  }
  return missing > 0;
}

function songKey(song) {
  const seconds = Math.max(0, Number(song?.seconds) || 0);
  return [
    seconds,
    normalizeIdentity(song?.title),
    normalizeIdentity(song?.artist),
    normalizeIdentity(song?.rawHash || song?.raw),
  ].join("::");
}

function normalizeIdentity(value) {
  return stringValue(value).normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function normalizeImportedVideo(detail, inputDir, songs) {
  const videoId = String(detail.videoId || "").trim();
  return {
    videoId,
    title: stringValue(detail.title),
    channelName: stringValue(detail.channelName),
    channelId: stringValue(detail.channelId),
    channelHandle: stringValue(detail.channelHandle),
    channelUrl: stringValue(detail.channelUrl || detail.discoveryChannelUrl),
    channelAvatarUrl: stringValue(detail.channelAvatarUrl || detail.channelThumbnailUrl),
    channelThumbnailUrl: stringValue(detail.channelThumbnailUrl || detail.channelAvatarUrl),
    publishedTimestamp: finiteTimestamp(detail.publishedTimestamp),
    publishedText: stringValue(detail.publishedText),
    durationText: stringValue(detail.durationText),
    thumbnailUrl: stringValue(detail.thumbnailUrl) || fallbackThumbnailUrl(videoId),
    sourceGroups: uniqueValues([SOURCE_GROUP, ...listValues(detail.sourceGroups), detail.sourceGroup]),
    sourceUrls: uniqueValues([
      ...listValues(detail.sourceUrls),
      ...listValues(detail.discoverySourceUrls),
      stringValue(detail.sourceUrl),
      `https://www.youtube.com/watch?v=${videoId}`,
    ]),
    selectedSourceId: stringValue(detail.selectedSourceId || detail.sourceQuality?.sourceId),
    selectedSourceHash: stringValue(detail.selectedSourceHash || detail.sourceQuality?.sourceHash),
    songs: songs.map((song, index) => ({
      index: index + 1,
      time: stringValue(song.time),
      seconds: Math.max(0, Number(song.seconds) || 0),
      title: stringValue(song.title),
      artist: stringValue(song.artist),
      raw: stringValue(song.raw),
      rawHash: stringValue(song.rawHash),
      sourceId: stringValue(song.sourceId || detail.selectedSourceId || detail.sourceQuality?.sourceId),
      sourceHash: stringValue(song.sourceHash || detail.selectedSourceHash || detail.sourceQuality?.sourceHash),
      isNiche: song.isNiche === true,
    })),
    lastInspectedAt: stringValue(detail.lastInspectedAt || detail.updatedAt) || new Date().toISOString(),
    qualityStatus: "usable",
    discoveryImport: {
      sourceGroup: SOURCE_GROUP,
      inputDir: projectRelativePath(inputDir),
      discoverySingerName: stringValue(detail.discoverySingerName),
      discoveryChannelUrl: stringValue(detail.discoveryChannelUrl),
      matchedKeywords: listValues(detail.matchedKeywords).map((value) => stringValue(value)).filter(Boolean),
    },
  };
}

function fallbackThumbnailUrl(videoId) {
  return /^[A-Za-z0-9_-]{11}$/u.test(String(videoId || "")) ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
}

function isImportableSong(song) {
  return Boolean(song?.title) && !isLikelyNonSongEntry(song);
}

function projectRelativePath(value) {
  const absolutePath = path.resolve(ROOT, String(value || ""));
  const relativePath = path.relative(ROOT, absolutePath);
  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.replace(/\\/gu, "/");
  }
  return absolutePath.replace(/\\/gu, "/");
}

function finiteTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function listValues(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === false) return [];
  return [value];
}

function uniqueValues(values) {
  return [...new Set(listValues(values).map((value) => stringValue(value)).filter(Boolean))];
}

function stringValue(value) {
  return String(value || "").trim();
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function quoteForMarker(value) {
  return JSON.stringify(String(value || ""));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  SOURCE_GROUP,
  filterNonRegressiveImports,
  inputDirsFromArgs,
  isImportableSong,
  isStrictSongSubset,
  normalizeImportedVideo,
  projectRelativePath,
  readDiscoveryVideos,
  fallbackThumbnailUrl,
};
