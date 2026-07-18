#!/usr/bin/env node
const path = require("node:path");

const { readJson, writeJson, writeShardedBundle } = require("./bundle-writer");
const {
  createClient,
  cursorKey,
  ensureRobotsAllowed,
  loadCheckpoint,
  loadRobots,
  parseArgs,
  requestStatsFromPages,
  saveCheckpoint,
  stopRecord,
  writeRunOutput,
} = require("./crawl-core");
const { buildNormalizedBundle, dedupeOccurrences, dedupeSongs, dedupeVideos, occurrenceEntitiesFromVideo, songCandidatesFromVideos, songEntityFromHttp } = require("./model");
const { parseStreamsPage } = require("./parsers");

async function crawlStreams(options = {}) {
  const args = { ...options };
  const client = args.client || createClient(args);
  const outputDir = args["output-dir"] || path.resolve(process.cwd(), "artifacts", "vsinger-http-backfill", "streams");
  const checkpointPath = args["checkpoint"] || path.join(outputDir, "checkpoint.json");
  const checkpoint = args.fresh ? null : loadCheckpoint(checkpointPath);
  const maxPages = args["max-pages"] ? Number(args["max-pages"]) : Infinity;
  const startUrl = args["start-url"] || checkpoint?.nextPageUrl || "https://vsinger-moment.jp/streams";
  const previous = args.fresh ? {} : readJson(path.join(outputDir, "crawl.json"), {});
  const previousVideos = args.fresh ? [] : readJson(path.join(outputDir, "videos.json"), previous.videos || []);
  const previousDetailQueue = args.fresh ? [] : readJson(path.join(outputDir, "detail-queue.json"), previous.detailQueue || []);
  const stopWatermark = args["stream-watermark"] || "";

  const robots = args.robots || (await loadRobots(client));
  ensureRobotsAllowed(robots, "streams");

  const visitedCursorUrls = new Set(checkpoint?.visitedCursorUrls || []);
  const visitedPageHashes = new Set(checkpoint?.visitedPageHashes || []);
  const checkpointVideoKeys = (checkpoint?.knownExternalVideoIds || []).map((id) => `external:${id}`);
  const previousVideoKeys = previousVideos.map((video) => video.youtubeVideoId || `external:${video.externalVideoId}`);
  const knownVideoKeys = new Set([...checkpointVideoKeys, ...previousVideoKeys]);
  const videos = [...previousVideos];
  const detailQueue = [...previousDetailQueue];
  const pages = Array.isArray(previous.pages) ? [...previous.pages] : [];
  const previousPageCount = Math.max(Number(previous.pageCount || 0), Number(checkpoint?.pageCount || 0), visitedCursorUrls.size, pages.length);
  const failures = Array.isArray(previous.failures) ? [...previous.failures] : [];
  let nextPageUrl = startUrl;
  let stop = null;
  let duplicateRowCount = Number(previous.duplicateRowCount || 0);
  let rawRowCount = Math.max(Number(previous.rawRowCount || pages.reduce((sum, page) => sum + (Number(page.rawRowCount) || 0), 0)), previousVideos.length + duplicateRowCount);
  let noProgressPages = 0;
  let cursorLoopDetected = false;
  let noProgressDetected = false;
  let previousHash = pages.at(-1)?.pageHash || "";
  let streamWatermark = stopWatermark || checkpoint?.streamWatermark || previous.streamWatermark || "";
  let runPageCount = 0;
  let totalPageCount = previousPageCount;
  const runPages = [];

  while (nextPageUrl && runPageCount < maxPages) {
    const key = cursorKey(nextPageUrl);
    if (visitedCursorUrls.has(key)) {
      cursorLoopDetected = true;
      stop = stopRecord("cursor-loop", { cursor: key, nextPageUrl });
      break;
    }
    visitedCursorUrls.add(key);

    let response;
    try {
      response = await client.getText(nextPageUrl);
    } catch (error) {
      stop = stopRecord("http-error", { message: error.message, status: error.status || null, url: nextPageUrl });
      failures.push(stop);
      break;
    }

    const parsed = parseStreamsPage(response.body, nextPageUrl);
    rawRowCount += parsed.rawRowCount;
    runPageCount += 1;
    totalPageCount += 1;
    if (parsed.pageHash === previousHash) {
      stop = stopRecord("same-page-hash-consecutive", { pageHash: parsed.pageHash, pageUrl: nextPageUrl });
      break;
    }
    previousHash = parsed.pageHash;
    visitedPageHashes.add(parsed.pageHash);

    let newVideos = 0;
    for (const video of parsed.videos) {
      const videoKey = video.youtubeVideoId || `external:${video.externalVideoId}`;
      if (knownVideoKeys.has(videoKey)) {
        duplicateRowCount += 1;
        continue;
      }
      if (stopWatermark && video.streamedAt && video.streamedAt <= stopWatermark) {
        stop = stopRecord("stream-watermark", { streamWatermark: stopWatermark, pageUrl: nextPageUrl });
        break;
      }
      knownVideoKeys.add(videoKey);
      videos.push(video);
      newVideos += 1;
      if (video.streamedAt && (!streamWatermark || video.streamedAt > streamWatermark)) streamWatermark = video.streamedAt;
      if (video.detailQueueReasons.length) detailQueue.push({ externalVideoId: video.externalVideoId, videoPageUrl: video.videoPageUrl, reasons: video.detailQueueReasons });
    }
    if (stop?.reason === "stream-watermark") break;

    noProgressPages = newVideos === 0 ? noProgressPages + 1 : 0;
    if (noProgressPages >= 5) {
      noProgressDetected = true;
      stop = stopRecord("no-progress", { pageUrl: nextPageUrl, noProgressPages });
      break;
    }

    const pageReport = {
      pageUrl: nextPageUrl,
      pageHash: parsed.pageHash,
      rawRowCount: parsed.rawRowCount,
      newVideos,
      setlistCount: parsed.videos.filter((video) => video.setlistSongs.length).length,
      occurrenceCount: parsed.videos.reduce((sum, video) => sum + video.setlistSongs.length, 0),
      nextPageUrl: parsed.nextPageUrl,
      bytes: response.bytes,
      elapsedMs: response.elapsedMs,
      fromCache: response.fromCache,
    };
    pages.push(pageReport);
    runPages.push(pageReport);
    saveCheckpoint(checkpointPath, {
      kind: "streams",
      updatedAt: new Date().toISOString(),
      nextPageUrl: parsed.nextPageUrl,
      pageCount: totalPageCount,
      knownExternalVideoIds: videos.map((video) => video.externalVideoId),
      visitedCursorUrls: [...visitedCursorUrls],
      visitedPageHashes: [...visitedPageHashes],
      streamWatermark,
      coverageStatus: "partial",
    });

    if (!parsed.nextPageUrl) {
      stop = stopRecord("no-next-cursor", { pageUrl: nextPageUrl });
      break;
    }
    nextPageUrl = parsed.nextPageUrl;
  }

  if (!stop && runPageCount >= maxPages) stop = stopRecord("max-pages", { maxPages, runPageCount, totalPageCount });

  const uniqueVideos = dedupeVideos(videos);
  const occurrences = dedupeOccurrences(uniqueVideos.flatMap(occurrenceEntitiesFromVideo));
  const setlistSongCandidates = dedupeSongs(songCandidatesFromVideos(uniqueVideos));
  const setlistSongs = setlistSongCandidates.map((song) => songEntityFromHttp(song));
  const duplicateRate = rawRowCount ? duplicateRowCount / rawRowCount : 0;
  const result = {
    schemaVersion: 1,
    kind: "vsinger-moment-http-streams-crawl",
    generatedAt: new Date().toISOString(),
    startUrl,
    stop,
    pageCount: totalPageCount,
    storedPageCount: pages.length,
    rawRowCount,
    uniqueVideoCount: uniqueVideos.length,
    uniqueSetlistSongCount: setlistSongs.length,
    duplicateRowCount,
    duplicateRate,
    occurrenceCount: occurrences.length,
    cursorLoopDetected,
    noProgressDetected,
    coverageStatus: stop?.reason === "no-next-cursor" && !cursorLoopDetected && !noProgressDetected ? "complete" : cursorLoopDetected ? "cursor-loop" : noProgressDetected ? "no-progress" : "partial",
    streamWatermark,
    requestStats: combineRequestStats(previous.requestStats, requestStatsFromPages(runPages), previousPageCount),
    pages,
    videos: uniqueVideos,
    songs: setlistSongs,
    occurrences,
    detailQueue,
    failures,
  };

  writeRunOutput(outputDir, "crawl", streamCrawlReport(result));
  writeJson(path.join(outputDir, "videos.json"), uniqueVideos);
  writeJson(path.join(outputDir, "songs.json"), setlistSongs);
  writeJson(path.join(outputDir, "occurrences.json"), occurrences);
  writeJson(path.join(outputDir, "detail-queue.json"), detailQueue);
  writeJson(path.join(outputDir, "sync-state.json"), {
    schemaVersion: 1,
    kind: "vsinger-moment-http-sync-state",
    updatedAt: result.generatedAt,
    lastSuccessfulStreamCrawl: {
      finishedAt: result.generatedAt,
      coverageStatus: result.coverageStatus,
      stopReason: result.stop?.reason || "",
      pageCount: result.pageCount,
      uniqueVideoCount: result.uniqueVideoCount,
      occurrenceCount: result.occurrenceCount,
    },
    streamWatermark,
    knownExternalVideoIds: uniqueVideos.map((video) => video.externalVideoId),
    knownSongIds: setlistSongs.map((song) => song.externalSongId),
    cursorCheckpoint: {
      nextPageUrl: result.stop?.reason === "max-pages" ? result.pages.at(-1)?.nextPageUrl || "" : "",
      visitedCursorUrls: [...visitedCursorUrls],
      visitedPageHashes: [...visitedPageHashes],
    },
    coverageStatus: result.coverageStatus,
  });
  if (args["write-bundle"]) {
    const bundle = buildNormalizedBundle({ songs: setlistSongCandidates, videos: uniqueVideos });
    bundle.coverage = {
      kind: "streams",
      pageCount: result.pageCount,
      rawRowCount: result.rawRowCount,
      uniqueVideoCount: result.uniqueVideoCount,
      uniqueSetlistSongCount: result.uniqueSetlistSongCount,
      duplicateRowCount: result.duplicateRowCount,
      duplicateRate: result.duplicateRate,
      occurrenceCount: result.occurrenceCount,
      coverageStatus: result.coverageStatus,
      streamWatermark: result.streamWatermark,
      stop: result.stop,
      requestStats: result.requestStats,
      detailQueueCount: result.detailQueue.length,
    };
    bundle.syncState = {
      lastSuccessfulStreamCrawl: result.generatedAt,
      streamWatermark: result.streamWatermark,
      knownExternalVideoIds: uniqueVideos.map((video) => video.externalVideoId),
      knownSongIds: setlistSongs.map((song) => song.externalSongId),
      cursorCheckpoint: result.stop?.reason === "max-pages" ? result.pages.at(-1)?.nextPageUrl || "" : "",
      coverageStatus: result.coverageStatus,
    };
    bundle.failures = failures;
    writeShardedBundle(args["bundle-dir"] || path.resolve(process.cwd(), "data", "external", "vsinger-http", "streams"), bundle);
  }
  return result;
}

function combineRequestStats(previousStats, runStats, previousPageCount) {
  const previousCount = Number(previousStats?.requestCount || 0);
  const runCount = Number(runStats.requestCount || 0);
  const requestCount = previousCount + runCount;
  return {
    requestCount,
    averageHtmlBytes: weightedAverage(previousStats?.averageHtmlBytes, previousCount, runStats.averageHtmlBytes, runCount),
    averageResponseTimeMs: weightedAverage(previousStats?.averageResponseTimeMs, previousCount, runStats.averageResponseTimeMs, runCount),
    totalBytes: Number(previousStats?.totalBytes || 0) + Number(runStats.totalBytes || 0),
    coverageStatus: previousCount >= previousPageCount ? "complete" : "partial",
  };
}

function weightedAverage(previousAverage, previousCount, runAverage, runCount) {
  const totalCount = previousCount + runCount;
  if (!totalCount) return 0;
  return Math.round((Number(previousAverage || 0) * previousCount + Number(runAverage || 0) * runCount) / totalCount);
}

function streamCrawlReport(result) {
  const { videos, songs, occurrences, detailQueue, ...report } = result;
  return {
    ...report,
    outputFiles: {
      videos: "videos.json",
      songs: "songs.json",
      occurrences: "occurrences.json",
      detailQueue: "detail-queue.json",
    },
    detailQueueCount: Array.isArray(detailQueue) ? detailQueue.length : 0,
  };
}

if (require.main === module) {
  crawlStreams(parseArgs())
    .then((result) => {
      console.log(`CODEX_VSINGER_STREAMS_CRAWL_OK pages=${result.pageCount} videos=${result.uniqueVideoCount} occurrences=${result.occurrenceCount} status=${result.coverageStatus} stop=${result.stop?.reason || ""}`);
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  crawlStreams,
  streamCrawlReport,
};
