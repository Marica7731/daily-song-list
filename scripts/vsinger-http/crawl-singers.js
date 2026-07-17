#!/usr/bin/env node
const path = require("node:path");

const { writeJson } = require("./bundle-writer");
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
const { parseSingersPage } = require("./parsers");

async function crawlSingers(options = {}) {
  const args = { ...options };
  const client = args.client || createClient(args);
  const outputDir = args["output-dir"] || path.resolve(process.cwd(), "artifacts", "vsinger-http-backfill", "singers");
  const checkpointPath = args.checkpoint || path.join(outputDir, "checkpoint.json");
  const checkpoint = args.fresh ? null : loadCheckpoint(checkpointPath);
  const maxPages = args["max-pages"] ? Number(args["max-pages"]) : Infinity;
  const startUrl = args["start-url"] || checkpoint?.nextPageUrl || "https://vsinger-moment.jp/singers";

  const robots = args.robots || (await loadRobots(client));
  ensureRobotsAllowed(robots, "singers");

  const visitedCursorUrls = new Set(args.visitedCursorUrls || checkpoint?.visitedCursorUrls || []);
  const visitedPageHashes = new Set(args.visitedPageHashes || checkpoint?.visitedPageHashes || []);
  const knownSingerIds = new Set(args.knownSingerIds || checkpoint?.knownSingerIds || []);
  const singers = [];
  const pages = [];
  const failures = [];
  let nextPageUrl = startUrl;
  let stop = null;
  let rawRowCount = 0;
  let duplicateRowCount = 0;
  let noProgressPages = 0;
  let cursorLoopDetected = false;
  let noProgressDetected = false;
  let observedSingerCount = null;
  let previousHash = "";

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

    const parsed = parseSingersPage(response.body, nextPageUrl);
    observedSingerCount = parsed.observedSingerCount || observedSingerCount;
    rawRowCount += parsed.rawRowCount;
    if (parsed.pageHash === previousHash) {
      stop = stopRecord("same-page-hash-consecutive", { pageHash: parsed.pageHash, pageUrl: nextPageUrl });
      break;
    }
    previousHash = parsed.pageHash;
    visitedPageHashes.add(parsed.pageHash);

    let newSingers = 0;
    for (const singer of parsed.singers) {
      if (knownSingerIds.has(singer.externalSingerId)) {
        duplicateRowCount += 1;
        continue;
      }
      knownSingerIds.add(singer.externalSingerId);
      singers.push(singer);
      newSingers += 1;
    }

    noProgressPages = newSingers === 0 ? noProgressPages + 1 : 0;
    if (noProgressPages >= 5) {
      noProgressDetected = true;
      stop = stopRecord("no-progress", { pageUrl: nextPageUrl, noProgressPages });
      break;
    }

    pages.push({
      pageUrl: nextPageUrl,
      pageHash: parsed.pageHash,
      rawRowCount: parsed.rawRowCount,
      newSingers,
      nextPageUrl: parsed.nextPageUrl,
      bytes: response.bytes,
      elapsedMs: response.elapsedMs,
      fromCache: response.fromCache,
    });
    saveCheckpoint(checkpointPath, {
      kind: "singers",
      updatedAt: new Date().toISOString(),
      nextPageUrl: parsed.nextPageUrl,
      pageCount: pages.length,
      knownSingerIds: [...knownSingerIds],
      visitedCursorUrls: [...visitedCursorUrls],
      visitedPageHashes: [...visitedPageHashes],
      coverageStatus: "partial",
    });

    if (!parsed.nextPageUrl) {
      stop = stopRecord("no-next-cursor", { pageUrl: nextPageUrl });
      break;
    }
    nextPageUrl = parsed.nextPageUrl;
  }

  if (!stop && pages.length >= maxPages) stop = stopRecord("max-pages", { maxPages });

  const coverageStatus =
    cursorLoopDetected ? "cursor-loop" : noProgressDetected ? "no-progress" : stop?.reason === "no-next-cursor" && (!observedSingerCount || knownSingerIds.size >= observedSingerCount) ? "complete" : "partial";
  const result = {
    schemaVersion: 1,
    kind: "vsinger-moment-http-singers-crawl",
    generatedAt: new Date().toISOString(),
    startUrl,
    stop,
    pageCount: pages.length,
    rawRowCount,
    uniqueSingerCount: singers.length,
    duplicateRowCount,
    duplicateRate: rawRowCount ? duplicateRowCount / rawRowCount : 0,
    cursorLoopDetected,
    noProgressDetected,
    observedSingerCount,
    coverageRatio: observedSingerCount ? singers.length / observedSingerCount : null,
    coverageStatus,
    requestStats: requestStatsFromPages(pages),
    pages,
    singers,
    failures,
  };

  writeRunOutput(outputDir, "crawl", result);
  writeJson(path.join(outputDir, "singers.json"), singers);
  writeJson(path.join(outputDir, "sync-state.json"), {
    schemaVersion: 1,
    kind: "vsinger-moment-http-sync-state",
    updatedAt: result.generatedAt,
    lastSuccessfulSingerCrawl: {
      finishedAt: result.generatedAt,
      coverageStatus: result.coverageStatus,
      stopReason: result.stop?.reason || "",
      pageCount: result.pageCount,
      uniqueSingerCount: result.uniqueSingerCount,
      observedSingerCount: result.observedSingerCount,
      coverageRatio: result.coverageRatio,
    },
    knownSingerIds: singers.map((singer) => singer.externalSingerId),
    cursorCheckpoint: {
      nextPageUrl: result.stop?.reason === "max-pages" ? result.pages.at(-1)?.nextPageUrl || "" : "",
      visitedCursorUrls: [...visitedCursorUrls],
      visitedPageHashes: [...visitedPageHashes],
    },
    coverageStatus,
  });
  return result;
}

if (require.main === module) {
  crawlSingers(parseArgs())
    .then((result) => {
      console.log(`CODEX_VSINGER_SINGERS_CRAWL_OK pages=${result.pageCount} singers=${result.uniqueSingerCount} status=${result.coverageStatus} stop=${result.stop?.reason || ""}`);
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  crawlSingers,
};
