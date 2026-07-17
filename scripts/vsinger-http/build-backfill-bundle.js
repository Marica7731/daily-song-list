#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const { readJson, writeJson, writeShardedBundle } = require("./bundle-writer");
const { buildNormalizedBundle, dedupeSongs, SOURCE_SYSTEM, songEntityFromHttp } = require("./model");
const { parseArgs, requestStatsFromPages } = require("./crawl-core");

function buildBackfillBundle(options = {}) {
  const args = { ...options };
  const generatedAt = args.generatedAt || new Date().toISOString();
  const rootDir = args["root-dir"] || path.resolve(process.cwd(), "artifacts", "vsinger-http-backfill");
  const songsDir = args["songs-dir"] || path.join(rootDir, "songs");
  const streamsDir = args["streams-dir"] || path.join(rootDir, "streams");
  const videoDetailsDir = args["video-details-dir"] || path.join(rootDir, "video-details");
  const singerSongsDir = args["singer-songs-dir"] || path.join(rootDir, "singer-songs");
  const outputDir = args["output-dir"] || path.resolve(process.cwd(), "data", "external", "vsinger-http", "backfill");

  const songsCrawl = readJson(path.join(songsDir, "crawl.json"), {});
  const streamsCrawl = readJson(path.join(streamsDir, "crawl.json"), {});
  const videoDetails = readJson(path.join(videoDetailsDir, "video-details.json"), {});
  const singerSongsCrawl = readJson(path.join(singerSongsDir, "crawl.json"), {});
  const songsSyncState = readJson(path.join(songsDir, "sync-state.json"), {});
  const streamsSyncState = readJson(path.join(streamsDir, "sync-state.json"), {});
  const singerSongsSyncState = readJson(path.join(singerSongsDir, "sync-state.json"), {});

  const catalogSongs = readJson(path.join(songsDir, "songs.json"), []);
  const singerSongs = readJson(path.join(singerSongsDir, "songs.json"), []);
  const streamVideos = readJson(path.join(streamsDir, "videos.json"), streamsCrawl.videos || []);
  const detailVideos = readJson(path.join(videoDetailsDir, "videos.json"), videoDetails.videos || []);
  const singerVideos = readJson(path.join(singerSongsDir, "videos.json"), singerSongsCrawl.videos || []);
  const detailQueue = readJson(path.join(streamsDir, "detail-queue.json"), streamsCrawl.detailQueue || []);

  const videos = mergeVideoRecords([...streamVideos, ...detailVideos, ...singerVideos]);
  const sourceSongs = [...catalogSongs, ...singerSongs];
  const normalized = buildNormalizedBundle({ songs: sourceSongs, videos }, generatedAt);
  const conflicts = songConflicts([...sourceSongs, ...songsFromVideos(videos)]);
  const failures = collectFailures({ songsCrawl, streamsCrawl, videoDetails, singerSongsCrawl });
  const coverage = buildCoverage({
    generatedAt,
    songsCrawl,
    streamsCrawl,
    videoDetails,
    singerSongsCrawl,
    detailQueue,
    conflicts,
    failures,
  });
  const syncState = buildSyncState({
    generatedAt,
    songsSyncState,
    streamsSyncState,
    singerSongsSyncState,
    songs: normalized.songs,
    videos: normalized.videos,
    coverage,
  });

  const bundle = {
    ...normalized,
    coverage,
    conflicts,
    failures,
    syncState,
  };
  bundle.counts = {
    ...bundle.counts,
    conflicts: conflicts.length,
    failures: failures.length,
  };

  const manifest = writeShardedBundle(outputDir, bundle, { shardSize: Number(args["shard-size"]) || undefined });
  const report = buildReport({ bundle, manifest, songsCrawl, streamsCrawl, videoDetails, singerSongsCrawl, detailQueue });
  writeJson(path.join(outputDir, "backfill-report.json"), report);
  writeReportMarkdown(path.join(outputDir, "backfill-report.md"), report);
  console.log(`CODEX_VSINGER_BACKFILL_BUNDLE_OK songs=${bundle.counts.songs} videos=${bundle.counts.videos} occurrences=${bundle.counts.occurrences} status=${coverage.overallStatus}`);
  return { bundle, manifest, report };
}

function mergeVideoRecords(videos) {
  const byKey = new Map();
  for (const video of videos || []) {
    if (!video) continue;
    const key = video.youtubeVideoId || `external:${video.externalVideoId}`;
    if (!key || key === "external:") continue;
    const current = byKey.get(key);
    byKey.set(key, current ? betterVideoRecord(current, video) : video);
  }
  return [...byKey.values()];
}

function betterVideoRecord(left, right) {
  const leftSetlistCount = (left.setlistSongs || []).length;
  const rightSetlistCount = (right.setlistSongs || []).length;
  const primary = rightSetlistCount > leftSetlistCount ? right : left;
  const fallback = primary === right ? left : right;
  return {
    ...fallback,
    ...primary,
    youtubeVideoId: primary.youtubeVideoId || fallback.youtubeVideoId || "",
    youtubeUrl: primary.youtubeUrl || fallback.youtubeUrl || "",
    videoPageUrl: primary.videoPageUrl || fallback.videoPageUrl || "",
    videoTitle: primary.videoTitle || fallback.videoTitle || "",
    singerId: primary.singerId || fallback.singerId || "",
    singerName: primary.singerName || fallback.singerName || "",
    streamedAt: primary.streamedAt || fallback.streamedAt || "",
    thumbnailUrl: primary.thumbnailUrl || fallback.thumbnailUrl || "",
    setlistSongs: (primary.setlistSongs || []).length ? primary.setlistSongs : fallback.setlistSongs || [],
    detailQueueReasons: primary.detailQueueReasons || fallback.detailQueueReasons || [],
    detailReasonsResolved: [...new Set([...(fallback.detailReasonsResolved || []), ...(primary.detailReasonsResolved || [])])],
  };
}

function songsFromVideos(videos) {
  const songs = [];
  for (const video of videos || []) {
    for (const song of video.setlistSongs || []) {
      if (!song.externalSongId) continue;
      songs.push({
        externalSongId: song.externalSongId,
        title: "",
        originalArtist: "",
        rawTitle: song.rawTitle || "",
        rawArtist: song.rawArtist || "",
        songPageUrl: song.songPageUrl || "",
        sourceSystem: SOURCE_SYSTEM,
      });
    }
  }
  return songs;
}

function songConflicts(rawSongs) {
  const byId = new Map();
  for (const rawSong of rawSongs || []) {
    if (!rawSong.externalSongId) continue;
    const entity = songEntityFromHttp(rawSong);
    const key = `${entity.displayTitle}\u0000${entity.displayArtist}`;
    const bucket = byId.get(entity.externalSongId) || new Map();
    if (!entity.displayTitle && !entity.displayArtist) continue;
    bucket.set(key, {
      externalSongId: entity.externalSongId,
      displayTitle: entity.displayTitle,
      displayArtist: entity.displayArtist,
      sourceUrl: entity.sourceUrl,
      provenance: entity.provenance,
    });
    byId.set(entity.externalSongId, bucket);
  }

  const conflicts = [];
  for (const [externalSongId, variants] of byId.entries()) {
    const variantList = [...variants.values()];
    const titleValues = new Set(variantList.map((variant) => variant.displayTitle).filter(Boolean));
    const artistValues = new Set(variantList.map((variant) => variant.displayArtist).filter(Boolean));
    if (titleValues.size < 2 && artistValues.size < 2) continue;
    conflicts.push({
      type: "song-metadata-conflict",
      externalSongId,
      variants: variantList,
    });
  }
  return conflicts;
}

function collectFailures({ songsCrawl, streamsCrawl, videoDetails, singerSongsCrawl }) {
  const failures = [];
  for (const [stage, payload] of [
    ["songs", songsCrawl],
    ["streams", streamsCrawl],
    ["video-details", videoDetails],
    ["singer-songs", singerSongsCrawl],
  ]) {
    for (const failure of payload.failures || []) {
      failures.push({ stage, ...failure });
    }
  }
  return failures;
}

function buildCoverage({ generatedAt, songsCrawl, streamsCrawl, videoDetails, singerSongsCrawl, detailQueue, conflicts, failures }) {
  const detailQueueCount = detailQueue.length || streamsCrawl.detailQueue?.length || 0;
  const streamsVideoCount = streamsCrawl.uniqueVideoCount || streamsCrawl.videoCount || 0;
  const requestStats = totalRequestStats([songsCrawl, streamsCrawl, videoDetails, singerSongsCrawl]);
  const songsCoverageStatus = songsCrawl.coverageStatus || "missing";
  const streamsCoverageStatus = streamsCrawl.coverageStatus || "missing";
  const overallStatus = songsCoverageStatus === "complete" && streamsCoverageStatus === "complete" && failures.length === 0 ? "complete" : "partial";
  return {
    schemaVersion: 1,
    kind: "vsinger-moment-http-backfill-coverage",
    generatedAt,
    overallStatus,
    stages: {
      songs: stageCoverage(songsCrawl, {
        uniqueSongCount: songsCrawl.uniqueSongCount || 0,
        observedSiteSongCount: songsCrawl.observedSiteSongCount || 0,
        coverageRatio: songsCrawl.coverageRatio || 0,
      }),
      streams: stageCoverage(streamsCrawl, {
        uniqueVideoCount: streamsCrawl.uniqueVideoCount || 0,
        uniqueSetlistSongCount: streamsCrawl.uniqueSetlistSongCount || 0,
        occurrenceCount: streamsCrawl.occurrenceCount || 0,
        detailQueueCount,
      }),
      videoDetails: {
        coverageStatus: videoDetails.kind ? videoDetails.coverageStatus || "partial" : "missing",
        requestedCount: videoDetails.requestedCount || 0,
        fetchedCount: videoDetails.fetchedCount || 0,
        occurrenceCount: videoDetails.occurrenceCount || 0,
        requestStats: videoDetails.requestStats || emptyRequestStats(),
      },
      singerSongs: {
        coverageStatus: singerSongsCrawl.kind ? singerSongsCrawl.coverageStatus || "partial" : "missing",
        singersProcessed: singerSongsCrawl.singersProcessed || 0,
        pageCount: singerSongsCrawl.pageCount || 0,
        detailPageCount: singerSongsCrawl.detailPageCount || 0,
        uniqueSongCount: singerSongsCrawl.uniqueSongCount || 0,
        uniqueVideoCount: singerSongsCrawl.uniqueVideoCount || 0,
        occurrenceCount: singerSongsCrawl.occurrenceCount || 0,
        ownerPermission: singerSongsCrawl.ownerPermission || null,
        requestStats: singerSongsCrawl.requestStats || emptyRequestStats(),
      },
    },
    requestStats,
    report: {
      songs: requestReportForSongs(songsCrawl),
      streams: requestReportForStreams(streamsCrawl, detailQueueCount),
    },
    savings: {
      avoidedBulkMcpGetSongRequests: songsCrawl.observedSiteSongCount || 0,
      avoidedVideoDetailRequestsByListSetlists: Math.max(0, streamsVideoCount - detailQueueCount),
      singerScopedOccurrencesImported: singerSongsCrawl.occurrenceCount || 0,
    },
    conflictCount: conflicts.length,
    failureCount: failures.length,
  };
}

function stageCoverage(payload, extra = {}) {
  return {
    coverageStatus: payload.coverageStatus || "missing",
    stopReason: payload.stop?.reason || "",
    pageCount: payload.pageCount || 0,
    rawRowCount: payload.rawRowCount || 0,
    duplicateRowCount: payload.duplicateRowCount || 0,
    duplicateRate: payload.duplicateRate || 0,
    cursorLoopDetected: Boolean(payload.cursorLoopDetected),
    noProgressDetected: Boolean(payload.noProgressDetected),
    requestStats: payload.requestStats || emptyRequestStats(),
    ...extra,
  };
}

function requestReportForSongs(crawl) {
  const pageCount = crawl.pageCount || 0;
  const uniqueSongCount = crawl.uniqueSongCount || 0;
  const observedSiteSongCount = crawl.observedSiteSongCount || 0;
  const uniqueSongsPerPage = pageCount ? uniqueSongCount / pageCount : 0;
  const estimatedCompleteRequests = observedSiteSongCount && uniqueSongsPerPage ? Math.ceil(observedSiteSongCount / uniqueSongsPerPage) : null;
  return {
    averageHtmlBytes: crawl.requestStats?.averageHtmlBytes || 0,
    averageResponseTimeMs: crawl.requestStats?.averageResponseTimeMs || 0,
    uniqueSongCount,
    duplicateSongRows: crawl.duplicateRowCount || 0,
    cursorStable: !crawl.cursorLoopDetected && !crawl.noProgressDetected,
    estimatedCompleteRequests,
    estimatedRuntimeSecondsAtOneRequestPerSecond: estimatedCompleteRequests,
  };
}

function requestReportForStreams(crawl, detailQueueCount) {
  const pages = crawl.pages || [];
  return {
    averageHtmlBytes: crawl.requestStats?.averageHtmlBytes || 0,
    averageResponseTimeMs: crawl.requestStats?.averageResponseTimeMs || 0,
    videosPerPage: pages.length ? Math.round((crawl.rawRowCount || 0) / pages.length) : 0,
    setlistsPerPage: average(pages.map((page) => page.setlistCount || 0)),
    occurrencesPerPage: average(pages.map((page) => page.occurrenceCount || 0)),
    cursorStable: !crawl.cursorLoopDetected && !crawl.noProgressDetected,
    detailQueueCount,
  };
}

function totalRequestStats(payloads) {
  const pages = payloads.flatMap((payload) => payload.pages || []);
  if (pages.length) return requestStatsFromPages(pages);
  return payloads.reduce(
    (stats, payload) => ({
      requestCount: stats.requestCount + (payload.requestStats?.requestCount || 0),
      averageHtmlBytes: 0,
      averageResponseTimeMs: 0,
      totalBytes: stats.totalBytes + (payload.requestStats?.totalBytes || 0),
    }),
    emptyRequestStats(),
  );
}

function buildSyncState({ generatedAt, songsSyncState, streamsSyncState, singerSongsSyncState, songs, videos, coverage }) {
  const knownSongIds = dedupeSongs(songs).map((song) => song.externalSongId);
  return {
    schemaVersion: 1,
    kind: "vsinger-moment-http-sync-state",
    updatedAt: generatedAt,
    lastSuccessfulSongCrawl: songsSyncState.lastSuccessfulSongCrawl || null,
    lastSuccessfulStreamCrawl: streamsSyncState.lastSuccessfulStreamCrawl || null,
    lastSuccessfulSingerSongsCrawl: singerSongsSyncState.lastSuccessfulSingerSongsCrawl || null,
    ownerPermission: singerSongsSyncState.ownerPermission || null,
    streamWatermark: streamsSyncState.streamWatermark || "",
    knownSongIds,
    knownExternalVideoIds: videos.map((video) => video.externalVideoId).filter(Boolean),
    cursorCheckpoint: {
      songs: songsSyncState.cursorCheckpoint || null,
      streams: streamsSyncState.cursorCheckpoint || null,
    },
    coverageStatus: coverage.overallStatus,
    stageCoverageStatus: {
      songs: coverage.stages.songs.coverageStatus,
      streams: coverage.stages.streams.coverageStatus,
      videoDetails: coverage.stages.videoDetails.coverageStatus,
      singerSongs: coverage.stages.singerSongs.coverageStatus,
    },
  };
}

function buildReport({ bundle, manifest, songsCrawl, streamsCrawl, videoDetails, singerSongsCrawl, detailQueue }) {
  return {
    schemaVersion: 1,
    kind: "vsinger-moment-http-backfill-report",
    generatedAt: bundle.generatedAt,
    counts: bundle.counts,
    manifest: {
      shardSize: manifest.shardSize,
      shards: Object.fromEntries(Object.entries(manifest.shards || {}).map(([key, shards]) => [key, shards.length])),
    },
    coverage: bundle.coverage,
    inputs: {
      songs: {
        generatedAt: songsCrawl.generatedAt || "",
        coverageStatus: songsCrawl.coverageStatus || "missing",
        stopReason: songsCrawl.stop?.reason || "",
      },
      streams: {
        generatedAt: streamsCrawl.generatedAt || "",
        coverageStatus: streamsCrawl.coverageStatus || "missing",
        stopReason: streamsCrawl.stop?.reason || "",
        detailQueueCount: detailQueue.length || streamsCrawl.detailQueue?.length || 0,
      },
      videoDetails: {
        generatedAt: videoDetails.generatedAt || "",
        fetchedCount: videoDetails.fetchedCount || 0,
      },
      singerSongs: {
        generatedAt: singerSongsCrawl.generatedAt || "",
        singersProcessed: singerSongsCrawl.singersProcessed || 0,
        uniqueSongCount: singerSongsCrawl.uniqueSongCount || 0,
        occurrenceCount: singerSongsCrawl.occurrenceCount || 0,
        ownerPermission: singerSongsCrawl.ownerPermission || null,
      },
    },
  };
}

function writeReportMarkdown(filePath, report) {
  const lines = [
    "# VSinger Moment HTTP Backfill Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Counts",
    "",
    `- Songs: ${report.counts.songs}`,
    `- Videos: ${report.counts.videos}`,
    `- Occurrences: ${report.counts.occurrences}`,
    `- Conflicts: ${report.counts.conflicts}`,
    `- Failures: ${report.counts.failures}`,
    "",
    "## Coverage",
    "",
    `- Overall: ${report.coverage.overallStatus}`,
    `- Songs: ${report.coverage.stages.songs.coverageStatus} (${report.coverage.stages.songs.stopReason || "no stop"})`,
    `- Streams: ${report.coverage.stages.streams.coverageStatus} (${report.coverage.stages.streams.stopReason || "no stop"})`,
    `- Video details: ${report.coverage.stages.videoDetails.coverageStatus}`,
    `- Singer-scoped songs: ${report.coverage.stages.singerSongs.coverageStatus}`,
    "",
    "## Request Report",
    "",
    `- Total requests: ${report.coverage.requestStats.requestCount}`,
    `- Total HTML bytes: ${report.coverage.requestStats.totalBytes}`,
    `- Songs average HTML bytes: ${report.coverage.report.songs.averageHtmlBytes}`,
    `- Streams average HTML bytes: ${report.coverage.report.streams.averageHtmlBytes}`,
    `- Streams average setlists/page: ${report.coverage.report.streams.setlistsPerPage}`,
    `- Streams average occurrences/page: ${report.coverage.report.streams.occurrencesPerPage}`,
    `- Singer-scoped occurrence imports: ${report.coverage.savings.singerScopedOccurrencesImported}`,
    "",
    "## Savings",
    "",
    `- Avoided bulk MCP get_song requests: ${report.coverage.savings.avoidedBulkMcpGetSongRequests}`,
    `- Avoided video detail requests by list setlists: ${report.coverage.savings.avoidedVideoDetailRequestsByListSetlists}`,
    "",
  ];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function average(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return 0;
  return Math.round(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function emptyRequestStats() {
  return {
    requestCount: 0,
    averageHtmlBytes: 0,
    averageResponseTimeMs: 0,
    totalBytes: 0,
  };
}

if (require.main === module) {
  buildBackfillBundle(parseArgs());
}

module.exports = {
  buildBackfillBundle,
  mergeVideoRecords,
  songConflicts,
};
