#!/usr/bin/env node
const path = require("node:path");

const { writeJson, writeShardedBundle } = require("./bundle-writer");
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
const { buildNormalizedBundle, dedupeOccurrences, dedupeVideos, occurrenceEntitiesFromVideo } = require("./model");
const { parseStreamsPage } = require("./parsers");

async function crawlStreams(options = {}) {
  const args = { ...options };
  const client = args.client || createClient(args);
  const outputDir = args["output-dir"] || path.resolve(process.cwd(), "artifacts", "vsinger-http-backfill", "streams");
  const checkpointPath = args["checkpoint"] || path.join(outputDir, "checkpoint.json");
  const checkpoint = args.fresh ? null : loadCheckpoint(checkpointPath);
  const maxPages = args["max-pages"] ? Number(args["max-pages"]) : Infinity;
  const startUrl = args["start-url"] || checkpoint?.nextPageUrl || "https://vsinger-moment.jp/streams";
  const watermark = args["stream-watermark"] || checkpoint?.streamWatermark || "";

  const robots = args.robots || (await loadRobots(client));
  ensureRobotsAllowed(robots, "streams");

  const visitedCursorUrls = new Set(checkpoint?.visitedCursorUrls || []);
  const visitedPageHashes = new Set(checkpoint?.visitedPageHashes || []);
  const knownVideoKeys = new Set((checkpoint?.knownExternalVideoIds || []).map((id) => `external:${id}`));
  const videos = [];
  const detailQueue = [];
  const pages = [];
  const failures = [];
  let nextPageUrl = startUrl;
  let stop = null;
  let rawRowCount = 0;
  let duplicateRowCount = 0;
  let noProgressPages = 0;
  let cursorLoopDetected = false;
  let noProgressDetected = false;
  let previousHash = "";
  let streamWatermark = watermark;

  while (nextPageUrl && pages.length < maxPages) {
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
      if (watermark && video.streamedAt && video.streamedAt <= watermark) {
        stop = stopRecord("stream-watermark", { streamWatermark: watermark, pageUrl: nextPageUrl });
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

    pages.push({
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
    });
    saveCheckpoint(checkpointPath, {
      kind: "streams",
      updatedAt: new Date().toISOString(),
      nextPageUrl: parsed.nextPageUrl,
      pageCount: pages.length,
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

  if (!stop && pages.length >= maxPages) stop = stopRecord("max-pages", { maxPages });

  const uniqueVideos = dedupeVideos(videos);
  const occurrences = dedupeOccurrences(uniqueVideos.flatMap(occurrenceEntitiesFromVideo));
  const duplicateRate = rawRowCount ? duplicateRowCount / rawRowCount : 0;
  const result = {
    schemaVersion: 1,
    kind: "vsinger-moment-http-streams-crawl",
    generatedAt: new Date().toISOString(),
    startUrl,
    stop,
    pageCount: pages.length,
    rawRowCount,
    uniqueVideoCount: uniqueVideos.length,
    duplicateRowCount,
    duplicateRate,
    occurrenceCount: occurrences.length,
    cursorLoopDetected,
    noProgressDetected,
    coverageStatus: stop?.reason === "no-next-cursor" && !cursorLoopDetected && !noProgressDetected ? "complete" : cursorLoopDetected ? "cursor-loop" : noProgressDetected ? "no-progress" : "partial",
    streamWatermark,
    requestStats: requestStatsFromPages(pages),
    pages,
    videos: uniqueVideos,
    occurrences,
    detailQueue,
    failures,
  };

  writeRunOutput(outputDir, "crawl", result);
  writeJson(path.join(outputDir, "videos.json"), uniqueVideos);
  writeJson(path.join(outputDir, "occurrences.json"), occurrences);
  writeJson(path.join(outputDir, "detail-queue.json"), detailQueue);
  if (args["write-bundle"]) {
    const bundle = buildNormalizedBundle({ videos: uniqueVideos });
    bundle.coverage = {
      kind: "streams",
      pageCount: result.pageCount,
      rawRowCount: result.rawRowCount,
      uniqueVideoCount: result.uniqueVideoCount,
      duplicateRowCount: result.duplicateRowCount,
      duplicateRate: result.duplicateRate,
      occurrenceCount: result.occurrenceCount,
      coverageStatus: result.coverageStatus,
      streamWatermark: result.streamWatermark,
      stop: result.stop,
      requestStats: result.requestStats,
      detailQueueCount: result.detailQueue.length,
    };
    bundle.failures = failures;
    writeShardedBundle(args["bundle-dir"] || path.resolve(process.cwd(), "data", "external", "vsinger-http", "streams"), bundle);
  }
  return result;
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
};
