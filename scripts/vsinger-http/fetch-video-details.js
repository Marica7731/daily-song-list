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
  const robots = args.robots || (await loadRobots(client));
  ensureRobotsAllowed(robots, "videos");

  const videos = [];
  const failures = [];
  const pages = [];
  for (const item of queue.slice(0, maxVideos)) {
    if (!item.videoPageUrl) continue;
    let response;
    try {
      response = await client.getText(item.videoPageUrl);
      const parsed = parseVideoDetailPage(response.body, item.videoPageUrl);
      videos.push({ ...parsed, detailQueueReasons: [], detailReasonsResolved: item.reasons || [] });
      pages.push({
        pageUrl: item.videoPageUrl,
        externalVideoId: parsed.externalVideoId,
        setlistCount: parsed.setlistSongs.length,
        bytes: response.bytes,
        elapsedMs: response.elapsedMs,
        fromCache: response.fromCache,
      });
    } catch (error) {
      failures.push({ videoPageUrl: item.videoPageUrl, reasons: item.reasons || [], message: error.message, status: error.status || null });
    }
  }

  const uniqueVideos = dedupeVideos(videos);
  const occurrences = dedupeOccurrences(uniqueVideos.flatMap(occurrenceEntitiesFromVideo));
  const result = {
    schemaVersion: 1,
    kind: "vsinger-moment-http-video-detail-fill",
    generatedAt: new Date().toISOString(),
    inputPath,
    requestedCount: queue.length,
    fetchedCount: pages.length,
    videoCount: uniqueVideos.length,
    occurrenceCount: occurrences.length,
    requestStats: requestStatsFromPages(pages),
    pages,
    videos: uniqueVideos,
    occurrences,
    failures,
  };

  writeJson(path.join(outputDir, "video-details.json"), result);
  writeJson(path.join(outputDir, "videos.json"), uniqueVideos);
  writeJson(path.join(outputDir, "occurrences.json"), occurrences);
  console.log(`CODEX_VSINGER_VIDEO_DETAILS_OK fetched=${result.fetchedCount} videos=${result.videoCount} occurrences=${result.occurrenceCount}`);
  return result;
}

if (require.main === module) {
  fetchVideoDetails(parseArgs()).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchVideoDetails,
};
