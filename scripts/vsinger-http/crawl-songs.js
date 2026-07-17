#!/usr/bin/env node
const path = require("node:path");

const { writeJson, writeShardedBundle } = require("./bundle-writer");
const {
  classifyCoverage,
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
const { buildNormalizedBundle, dedupeSongs } = require("./model");
const { parseSongsPage } = require("./parsers");

async function crawlSongs(options = {}) {
  const args = { ...options };
  const client = args.client || createClient(args);
  const outputDir = args["output-dir"] || path.resolve(process.cwd(), "artifacts", "vsinger-http-backfill", "songs");
  const checkpointPath = args["checkpoint"] || path.join(outputDir, "checkpoint.json");
  const checkpoint = args.fresh ? null : loadCheckpoint(checkpointPath);
  const maxPages = args["max-pages"] ? Number(args["max-pages"]) : Infinity;
  const startUrl = args["start-url"] || checkpoint?.nextPageUrl || "https://vsinger-moment.jp/songs";

  const robots = args.robots || (await loadRobots(client));
  ensureRobotsAllowed(robots, "songs");

  const visitedCursorUrls = new Set(args.visitedCursorUrls || checkpoint?.visitedCursorUrls || []);
  const visitedPageHashes = new Set(args.visitedPageHashes || checkpoint?.visitedPageHashes || []);
  const discoveredSongIds = new Set(args.discoveredSongIds || checkpoint?.knownSongIds || []);
  const songs = [];
  const pages = [];
  const failures = [];
  let nextPageUrl = startUrl;
  let stop = null;
  let rawRowCount = 0;
  let duplicateRowCount = 0;
  let noProgressPages = 0;
  let cursorLoopDetected = false;
  let noProgressDetected = false;
  let observedSiteSongCount = null;
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

    const parsed = parseSongsPage(response.body, nextPageUrl);
    observedSiteSongCount = parsed.observedSiteSongCount || observedSiteSongCount;
    rawRowCount += parsed.rawRowCount;
    if (parsed.pageHash === previousHash) {
      stop = stopRecord("same-page-hash-consecutive", { pageHash: parsed.pageHash, pageUrl: nextPageUrl });
      break;
    }
    previousHash = parsed.pageHash;
    visitedPageHashes.add(parsed.pageHash);

    let newSongs = 0;
    for (const song of parsed.songs) {
      if (discoveredSongIds.has(song.externalSongId)) {
        duplicateRowCount += 1;
        continue;
      }
      discoveredSongIds.add(song.externalSongId);
      songs.push(song);
      newSongs += 1;
    }
    noProgressPages = newSongs === 0 ? noProgressPages + 1 : 0;
    if (noProgressPages >= 5) {
      noProgressDetected = true;
      stop = stopRecord("no-progress", { pageUrl: nextPageUrl, noProgressPages });
      break;
    }

    pages.push({
      pageUrl: nextPageUrl,
      pageHash: parsed.pageHash,
      rawRowCount: parsed.rawRowCount,
      newSongs,
      nextPageUrl: parsed.nextPageUrl,
      bytes: response.bytes,
      elapsedMs: response.elapsedMs,
      fromCache: response.fromCache,
    });
    saveCheckpoint(checkpointPath, {
      kind: "songs",
      updatedAt: new Date().toISOString(),
      nextPageUrl: parsed.nextPageUrl,
      pageCount: pages.length,
      knownSongIds: [...discoveredSongIds],
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

  const uniqueSongs = dedupeSongs(songs);
  const duplicateRate = rawRowCount ? duplicateRowCount / rawRowCount : 0;
  const coverageStatus = classifyCoverage({
    stopReason: stop?.reason,
    observedSiteSongCount,
    uniqueCount: uniqueSongs.length,
    cursorLoopDetected,
    noProgressDetected,
  });
  const result = {
    schemaVersion: 1,
    kind: "vsinger-moment-http-songs-crawl",
    generatedAt: new Date().toISOString(),
    startUrl,
    stop,
    pageCount: pages.length,
    rawRowCount,
    uniqueSongCount: uniqueSongs.length,
    duplicateRowCount,
    duplicateRate,
    cursorLoopDetected,
    noProgressDetected,
    observedSiteSongCount,
    coverageRatio: observedSiteSongCount ? uniqueSongs.length / observedSiteSongCount : null,
    coverageStatus,
    requestStats: requestStatsFromPages(pages),
    pages,
    songs: uniqueSongs,
    failures,
  };

  writeRunOutput(outputDir, "crawl", result);
  writeJson(path.join(outputDir, "songs.json"), uniqueSongs);
  writeJson(path.join(outputDir, "sync-state.json"), {
    schemaVersion: 1,
    kind: "vsinger-moment-http-sync-state",
    updatedAt: result.generatedAt,
    lastSuccessfulSongCrawl: {
      finishedAt: result.generatedAt,
      coverageStatus: result.coverageStatus,
      stopReason: result.stop?.reason || "",
      pageCount: result.pageCount,
      uniqueSongCount: result.uniqueSongCount,
      observedSiteSongCount: result.observedSiteSongCount,
      coverageRatio: result.coverageRatio,
    },
    knownSongIds: uniqueSongs.map((song) => song.externalSongId),
    cursorCheckpoint: {
      nextPageUrl: result.stop?.reason === "max-pages" ? result.pages.at(-1)?.nextPageUrl || "" : "",
      visitedCursorUrls: [...visitedCursorUrls],
      visitedPageHashes: [...visitedPageHashes],
    },
    coverageStatus,
  });
  if (args["write-bundle"]) {
    const bundle = buildNormalizedBundle({ songs: uniqueSongs });
    bundle.coverage = {
      kind: "songs",
      pageCount: result.pageCount,
      rawRowCount: result.rawRowCount,
      uniqueSongCount: result.uniqueSongCount,
      duplicateRowCount: result.duplicateRowCount,
      duplicateRate: result.duplicateRate,
      observedSiteSongCount: result.observedSiteSongCount,
      coverageRatio: result.coverageRatio,
      coverageStatus: result.coverageStatus,
      stop: result.stop,
      requestStats: result.requestStats,
    };
    bundle.syncState = {
      lastSuccessfulSongCrawl: result.generatedAt,
      knownSongIds: uniqueSongs.map((song) => song.externalSongId),
      cursorCheckpoint: result.stop?.reason === "max-pages" ? result.pages.at(-1)?.nextPageUrl || "" : "",
      coverageStatus: result.coverageStatus,
    };
    bundle.failures = failures;
    writeShardedBundle(args["bundle-dir"] || path.resolve(process.cwd(), "data", "external", "vsinger-http", "songs"), bundle);
  }
  return result;
}

if (require.main === module) {
  crawlSongs(parseArgs())
    .then((result) => {
      console.log(`CODEX_VSINGER_SONGS_CRAWL_OK pages=${result.pageCount} unique=${result.uniqueSongCount} status=${result.coverageStatus} stop=${result.stop?.reason || ""}`);
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  crawlSongs,
};
