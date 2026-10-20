#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const { buildBackfillBundle } = require("./build-backfill-bundle");
const { readJson, writeJson } = require("./bundle-writer");
const { createClient, loadRobots, parseArgs } = require("./crawl-core");
const { crawlSingerSongs } = require("./crawl-singer-songs");
const { crawlSingers } = require("./crawl-singers");
const { crawlSongs } = require("./crawl-songs");
const { crawlStreams } = require("./crawl-streams");
const { fetchVideoDetails } = require("./fetch-video-details");

const DEFAULT_SONG_THRESHOLD = 1000;
const DEFAULT_OCCURRENCE_THRESHOLD = 5000;
const DEFAULT_INTERVAL_MINUTES = 60;

async function runBackfillWorker(options = {}) {
  const args = { ...options };
  const generatedAt = args.generatedAt || new Date().toISOString();
  const rootDir = args["root-dir"] || path.resolve(process.cwd(), "artifacts", "vsinger-http-backfill");
  const bundleRoot = args["bundle-root"] || args["bundle-dir"] || path.resolve(process.cwd(), "data", "external", "vsinger-http", "backfill");
  const statePath = args["state-file"] || path.join(rootDir, "worker-state.json");
  const lockPath = args["lock-file"] || path.join(rootDir, "worker.lock");
  const lock = args["no-lock"] ? null : acquireLock(lockPath);

  try {
    const client = args.client || createClient(args);
    const robots = args.robots || (await loadRobots(client));
    const stageResults = {};

    if (!isSkipped(args, "songs")) {
      stageResults.songs = await crawlSongs(stageArgs(args, client, robots, path.join(rootDir, "songs"), "song-pages"));
    }
    if (!isSkipped(args, "streams")) {
      stageResults.streams = await crawlStreams(stageArgs(args, client, robots, path.join(rootDir, "streams"), "stream-pages", { "stream-watermark": args["stream-watermark"] }));
    }
    if (!isSkipped(args, "singers")) {
      stageResults.singers = await crawlSingers(stageArgs(args, client, robots, path.join(rootDir, "singers"), "singer-pages"));
    }
    if (!isSkipped(args, "video-details")) {
      const queuePath = args.queue || path.join(rootDir, "streams", "detail-queue.json");
      const queue = readJson(queuePath, []);
      if (queue.length || args["fetch-empty-video-details"]) {
        stageResults.videoDetails = await fetchVideoDetails({
          client,
          robots,
          queueItems: queue,
          queue: queuePath,
          "output-dir": path.join(rootDir, "video-details"),
          "max-videos": args["video-detail-count"] || args["max-video-details"],
        });
      } else {
        stageResults.videoDetails = skippedStage("empty-detail-queue");
      }
    }
    if (!isSkipped(args, "singer-songs")) {
      const ownerPermission = Boolean(args["owner-permission"]) || process.env.VSINGER_OWNER_PERMISSION === "1";
      const singersFile = args["singers-file"] || path.join(rootDir, "singers", "singers.json");
      if (!ownerPermission) {
        stageResults.singerSongs = skippedStage("missing-owner-permission");
      } else if (!fs.existsSync(singersFile)) {
        stageResults.singerSongs = skippedStage("missing-singers-file", { singersFile });
      } else {
        stageResults.singerSongs = await crawlSingerSongs({
          client,
          robots,
          "owner-permission": true,
          "owner-permission-note": args["owner-permission-note"],
          "singers-file": singersFile,
          "output-dir": path.join(rootDir, "singer-songs"),
          "max-singers": args["singer-count"],
          "max-song-pages": args["singer-song-pages"],
          "max-song-details": args["singer-song-detail-count"] || args["max-song-details"],
          "fetch-song-details": args["fetch-song-details"],
          fresh: args.fresh,
        });
      }
    }

    const previousState = readJson(statePath, {});
    const currentCounts = readCurrentCounts(rootDir);
    const bundleDecision = shouldWriteBundle({
      args,
      currentCounts,
      previousBundle: previousState.lastBundle,
      generatedAt,
    });
    let bundle = null;
    if (bundleDecision.write) {
      bundle = writeImmutableBundle({
        args,
        rootDir,
        bundleRoot,
        generatedAt,
        currentCounts,
        reason: bundleDecision.reason,
      });
    }

    const report = {
      schemaVersion: 1,
      kind: "vsinger-moment-http-backfill-worker-run",
      generatedAt,
      rootDir,
      bundleRoot,
      stages: summarizeStages(stageResults),
      currentCounts,
      bundleDecision,
      bundle,
    };
    writeJson(path.join(rootDir, "worker-run.json"), report);
    writeJson(statePath, buildWorkerState({ previousState, report }));
    console.log(
      `CODEX_VSINGER_BACKFILL_WORKER_OK songs=${currentCounts.songs} videos=${currentCounts.videos} occurrences=${currentCounts.occurrences} bundle=${bundle ? bundle.version : "skipped"} reason=${bundleDecision.reason}`,
    );
    return report;
  } finally {
    if (lock) releaseLock(lock);
  }
}

function stageArgs(args, client, robots, outputDir, pageArg, extra = {}) {
  const stage = {
    client,
    robots,
    "output-dir": outputDir,
    fresh: args.fresh,
    ...extra,
  };
  const pages = args[pageArg] || args["max-pages"];
  if (pages) stage["max-pages"] = pages;
  return stage;
}

function isSkipped(args, stage) {
  return Boolean(args[`skip-${stage}`]);
}

function skippedStage(reason, extra = {}) {
  return {
    skipped: true,
    reason,
    ...extra,
  };
}

function readCurrentCounts(rootDir) {
  const songs = readJson(path.join(rootDir, "songs", "songs.json"), []);
  const streamSongs = readJson(path.join(rootDir, "streams", "songs.json"), []);
  const streamVideos = readJson(path.join(rootDir, "streams", "videos.json"), []);
  const streamOccurrences = readJson(path.join(rootDir, "streams", "occurrences.json"), []);
  const videoDetailVideos = readJson(path.join(rootDir, "video-details", "videos.json"), []);
  const videoDetailOccurrences = readJson(path.join(rootDir, "video-details", "occurrences.json"), []);
  const singerSongs = readJson(path.join(rootDir, "singer-songs", "songs.json"), []);
  const singerVideos = readJson(path.join(rootDir, "singer-songs", "videos.json"), []);
  const singerOccurrences = readJson(path.join(rootDir, "singer-songs", "occurrences.json"), []);
  return {
    songs: uniqueCount([...songs, ...streamSongs, ...singerSongs], (song) => song.externalSongId),
    videos: uniqueCount([...streamVideos, ...videoDetailVideos, ...singerVideos], (video) => video.youtubeVideoId || video.externalVideoId),
    occurrences: streamOccurrences.length + videoDetailOccurrences.length + singerOccurrences.length,
  };
}

function shouldWriteBundle({ args, currentCounts, previousBundle, generatedAt }) {
  if (args["force-bundle"]) return { write: true, reason: "force-bundle" };
  if (!previousBundle) return { write: true, reason: "first-bundle" };

  const songThreshold = Number(args["bundle-song-threshold"] || DEFAULT_SONG_THRESHOLD);
  const occurrenceThreshold = Number(args["bundle-occurrence-threshold"] || DEFAULT_OCCURRENCE_THRESHOLD);
  const intervalMinutes = Number(args["bundle-interval-minutes"] || DEFAULT_INTERVAL_MINUTES);
  const previousCounts = previousBundle.counts || {};
  const songDelta = currentCounts.songs - (previousCounts.songs || 0);
  const occurrenceDelta = currentCounts.occurrences - (previousCounts.occurrences || 0);
  if (songDelta >= songThreshold) return { write: true, reason: "song-threshold", songDelta, songThreshold };
  if (occurrenceDelta >= occurrenceThreshold) return { write: true, reason: "occurrence-threshold", occurrenceDelta, occurrenceThreshold };

  const previousAt = Date.parse(previousBundle.generatedAt || "");
  const currentAt = Date.parse(generatedAt);
  const elapsedMinutes = Number.isFinite(previousAt) && Number.isFinite(currentAt) ? (currentAt - previousAt) / 60000 : Infinity;
  if (elapsedMinutes >= intervalMinutes) return { write: true, reason: "time-threshold", elapsedMinutes, intervalMinutes };
  return { write: false, reason: "below-threshold", songDelta, occurrenceDelta, elapsedMinutes, songThreshold, occurrenceThreshold, intervalMinutes };
}

function writeImmutableBundle({ args, rootDir, bundleRoot, generatedAt, currentCounts, reason }) {
  const version = args["bundle-version"] || safeTimestamp(generatedAt);
  const outputDir = path.join(bundleRoot, "versions", version);
  if (fs.existsSync(path.join(outputDir, "manifest.json")) && !args["allow-overwrite-bundle"]) {
    const error = new Error(`Immutable bundle version already exists: ${outputDir}`);
    error.code = "VSINGER_BUNDLE_VERSION_EXISTS";
    throw error;
  }
  const { manifest, report } = buildBackfillBundle({
    "root-dir": rootDir,
    "songs-dir": path.join(rootDir, "songs"),
    "streams-dir": path.join(rootDir, "streams"),
    "video-details-dir": path.join(rootDir, "video-details"),
    "singer-songs-dir": path.join(rootDir, "singer-songs"),
    "output-dir": outputDir,
    generatedAt,
    "shard-size": args["shard-size"],
  });
  const latest = {
    schemaVersion: 1,
    kind: "vsinger-moment-http-backfill-latest",
    generatedAt,
    version,
    reason,
    counts: report.counts || currentCounts,
    bundleDir: path.relative(bundleRoot, outputDir).replace(/\\/g, "/"),
    manifest: path.relative(bundleRoot, path.join(outputDir, "manifest.json")).replace(/\\/g, "/"),
    manifestCounts: manifest.counts,
  };
  writeJson(path.join(bundleRoot, "latest.json"), latest);
  return latest;
}

function buildWorkerState({ previousState, report }) {
  return {
    schemaVersion: 1,
    kind: "vsinger-moment-http-backfill-worker-state",
    updatedAt: report.generatedAt,
    lastRun: {
      generatedAt: report.generatedAt,
      stages: report.stages,
      currentCounts: report.currentCounts,
      bundleDecision: report.bundleDecision,
    },
    lastBundle: report.bundle
      ? {
          generatedAt: report.bundle.generatedAt,
          version: report.bundle.version,
          reason: report.bundle.reason,
          counts: report.bundle.counts,
          bundleDir: report.bundle.bundleDir,
          manifest: report.bundle.manifest,
        }
      : previousState.lastBundle || null,
  };
}

function summarizeStages(stageResults) {
  return Object.fromEntries(
    Object.entries(stageResults).map(([stage, result]) => [
      stage,
      {
        skipped: Boolean(result.skipped),
        reason: result.reason || result.stop?.reason || "",
        coverageStatus: result.coverageStatus || "",
        pageCount: result.pageCount || 0,
        uniqueSongCount: result.uniqueSongCount || 0,
        uniqueVideoCount: result.uniqueVideoCount || result.videoCount || 0,
        occurrenceCount: result.occurrenceCount || 0,
        uniqueSingerCount: result.uniqueSingerCount || 0,
        singersProcessed: result.singersProcessed || 0,
      },
    ]),
  );
}

function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const fd = fs.openSync(lockPath, "wx");
  const lock = { lockPath, fd };
  fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return lock;
}

function releaseLock(lock) {
  try {
    fs.closeSync(lock.fd);
  } finally {
    try {
      fs.unlinkSync(lock.lockPath);
    } catch {
      // The worker has already completed; a missing lock file should not hide the real result.
    }
  }
}

function uniqueCount(items, getKey) {
  return new Set((items || []).map(getKey).filter(Boolean)).size;
}

function safeTimestamp(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

if (require.main === module) {
  runBackfillWorker(parseArgs()).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  readCurrentCounts,
  runBackfillWorker,
  shouldWriteBundle,
};
