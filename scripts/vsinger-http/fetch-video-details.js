#!/usr/bin/env node
const path = require("node:path");

const { readJson, writeJson } = require("./bundle-writer");
const { createClient, ensureRobotsAllowed, loadRobots, parseArgs, requestStatsFromPages } = require("./crawl-core");
const { dedupeOccurrences, dedupeVideos, occurrenceEntitiesFromVideo } = require("./model");
const { parseVideoDetailPage } = require("./parsers");

async function fetchVideoDetails(options = {}) {
  const args = { ...options };
  const client = args.client || createClient(args);
  const outputDir = args["output-dir"] || path.resolve(process.cwd(), "artifacts", "vsinger-http-backfill", "video-details");
  const inputPath = args["queue"] || path.resolve(process.cwd(), "artifacts", "vsinger-http-backfill", "streams", "detail-queue.json");
  const queue = args.queueItems || readJson(inputPath, []);
  const maxVideos = args["max-videos"] ? Number(args["max-videos"]) : queue.length;
  const previous = args.fresh ? {} : readJson(path.join(outputDir, "video-details.json"), {});
  const previousVideos = args.fresh ? [] : readJson(path.join(outputDir, "videos.json"), previous.videos || []);
  const robots = args.robots || (await loadRobots(client));
  ensureRobotsAllowed(robots, "videos");

  const videos = [...previousVideos];
  const failures = Array.isArray(previous.failures) ? [...previous.failures] : [];
  const pages = Array.isArray(previous.pages) ? [...previous.pages] : [];
  const processedQueueKeys = new Set(previous.processedQueueKeys || pages.map((page) => page.queueKey || page.pageUrl));
  let runFetchedCount = 0;
  let runFailureCount = 0;

  for (const item of queue) {
    if (runFetchedCount + runFailureCount >= maxVideos) break;
    if (!item.videoPageUrl) continue;
    const key = queueItemKey(item);
    if (processedQueueKeys.has(key)) continue;
    let response;
    try {
      response = await client.getText(item.videoPageUrl);
      const parsed = parseVideoDetailPage(response.body, item.videoPageUrl);
      videos.push({ ...parsed, detailQueueReasons: [], detailReasonsResolved: item.reasons || [] });
      pages.push({
        queueKey: key,
        pageUrl: item.videoPageUrl,
        externalVideoId: parsed.externalVideoId,
        setlistCount: parsed.setlistSongs.length,
        bytes: response.bytes,
        elapsedMs: response.elapsedMs,
        fromCache: response.fromCache,
      });
      runFetchedCount += 1;
    } catch (error) {
      failures.push({ queueKey: key, videoPageUrl: item.videoPageUrl, reasons: item.reasons || [], message: error.message, status: error.status || null });
      runFailureCount += 1;
    }
    processedQueueKeys.add(key);
  }

  const uniqueVideos = dedupeVideos(videos);
  const occurrences = dedupeOccurrences(uniqueVideos.flatMap(occurrenceEntitiesFromVideo));
  const remainingQueue = queue.filter((item) => item.videoPageUrl && !processedQueueKeys.has(queueItemKey(item)));
  const processedQueueCount = queue.filter((item) => item.videoPageUrl && processedQueueKeys.has(queueItemKey(item))).length;
  const coverageStatus = remainingQueue.length === 0 && failures.length === 0 ? "complete" : "partial";
  const result = {
    schemaVersion: 1,
    kind: "vsinger-moment-http-video-detail-fill",
    generatedAt: new Date().toISOString(),
    inputPath,
    requestedCount: queue.length,
    processedQueueCount,
    remainingQueueCount: remainingQueue.length,
    runFetchedCount,
    runFailureCount,
    fetchedCount: pages.length,
    videoCount: uniqueVideos.length,
    occurrenceCount: occurrences.length,
    coverageStatus,
    requestStats: requestStatsFromPages(pages),
    pages,
    videos: uniqueVideos,
    occurrences,
    failures,
    processedQueueKeys: [...processedQueueKeys],
  };

  writeJson(path.join(outputDir, "video-details.json"), videoDetailsReport(result));
  writeJson(path.join(outputDir, "videos.json"), uniqueVideos);
  writeJson(path.join(outputDir, "occurrences.json"), occurrences);
  writeJson(path.join(outputDir, "checkpoint.json"), {
    schemaVersion: 1,
    kind: "vsinger-moment-http-video-details-checkpoint",
    updatedAt: result.generatedAt,
    inputPath,
    requestedCount: result.requestedCount,
    processedQueueCount: result.processedQueueCount,
    remainingQueueCount: result.remainingQueueCount,
    processedQueueKeys: result.processedQueueKeys,
    coverageStatus,
  });
  writeJson(path.join(outputDir, "sync-state.json"), {
    schemaVersion: 1,
    kind: "vsinger-moment-http-sync-state",
    updatedAt: result.generatedAt,
    lastSuccessfulVideoDetailFill: {
      finishedAt: result.generatedAt,
      coverageStatus,
      requestedCount: result.requestedCount,
      processedQueueCount: result.processedQueueCount,
      remainingQueueCount: result.remainingQueueCount,
      fetchedCount: result.fetchedCount,
      videoCount: result.videoCount,
      occurrenceCount: result.occurrenceCount,
    },
    knownExternalVideoIds: uniqueVideos.map((video) => video.externalVideoId).filter(Boolean),
    processedQueueKeys: result.processedQueueKeys,
    coverageStatus,
  });
  console.log(`CODEX_VSINGER_VIDEO_DETAILS_OK fetched=${result.fetchedCount} runFetched=${result.runFetchedCount} videos=${result.videoCount} occurrences=${result.occurrenceCount} remaining=${result.remainingQueueCount}`);
  return result;
}

function queueItemKey(item) {
  return item.videoPageUrl || item.externalVideoId || "";
}

function videoDetailsReport(result) {
  const { videos, occurrences, ...report } = result;
  return {
    ...report,
    outputFiles: {
      videos: "videos.json",
      occurrences: "occurrences.json",
      checkpoint: "checkpoint.json",
      syncState: "sync-state.json",
    },
  };
}

if (require.main === module) {
  fetchVideoDetails(parseArgs()).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchVideoDetails,
  queueItemKey,
  videoDetailsReport,
};
