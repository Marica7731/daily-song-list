#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const { readJson, writeJson, writeShardedBundle } = require("./bundle-writer");
const {
  buildNormalizedBundle,
  dedupeOccurrences,
  dedupeSongs,
  dedupeVideos,
  SOURCE_SYSTEM,
} = require("./model");
const { parseArgs, requestStatsFromPages, stopRecord } = require("./crawl-core");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_BACKFILL_DIR = path.join(ROOT, "data", "external", "vsinger-http", "backfill");

function mergeBackfillIncrements(options = {}) {
  const args = { ...options };
  const generatedAt = args.generatedAt || new Date().toISOString();
  const backfillDir = path.resolve(args["backfill-dir"] || DEFAULT_BACKFILL_DIR);
  const outputDir = path.resolve(args["output-dir"] || backfillDir);
  const incrementDirs = resolveIncrementDirs(args);
  if (!incrementDirs.length) throw new Error("Provide --increment-dir or --increment-dirs.");

  const base = readBundle(backfillDir);
  const increments = incrementDirs.map(readSingerSongsIncrement);
  const incrementBundle = buildNormalizedBundle(
    {
      songs: increments.flatMap((item) => item.songs),
      videos: increments.flatMap((item) => item.videos),
    },
    generatedAt,
  );
  const songs = dedupeSongs([...base.songs, ...incrementBundle.songs]);
  const videos = dedupeVideos([...base.videos, ...incrementBundle.videos]);
  const occurrences = dedupeOccurrences([...base.occurrences, ...incrementBundle.occurrences]);
  const conflicts = dedupeConflicts(base.conflicts);
  const failures = dedupeFailures([...base.failures, ...increments.flatMap((item) => item.failures)]);
  const coverage = mergeCoverage(base.coverage, increments, generatedAt, {
    songDelta: songs.length - base.songs.length,
    videoDelta: videos.length - base.videos.length,
    occurrenceDelta: occurrences.length - base.occurrences.length,
  });
  const syncState = mergeSyncState(base.syncState, coverage, songs, videos, generatedAt);
  const bundle = {
    schemaVersion: 1,
    sourceSystem: SOURCE_SYSTEM,
    generatedAt,
    songs,
    videos,
    occurrences,
    conflicts,
    failures,
    coverage,
    syncState,
    counts: {
      songs: songs.length,
      videos: videos.length,
      occurrences: occurrences.length,
      conflicts: conflicts.length,
      failures: failures.length,
    },
  };

  const manifest = writeShardedBundle(outputDir, bundle, { shardSize: positiveInteger(args["shard-size"], base.manifest.shardSize || 1000) });
  const report = buildReport({ bundle, manifest, base, increments });
  writeJson(path.join(outputDir, "backfill-report.json"), report);
  writeReportMarkdown(path.join(outputDir, "backfill-report.md"), report);
  console.log(
    [
      "CODEX_VSINGER_BACKFILL_INCREMENT_MERGE_OK",
      `increments=${increments.length}`,
      `songs=${bundle.counts.songs}`,
      `videos=${bundle.counts.videos}`,
      `occurrences=${bundle.counts.occurrences}`,
      `songDelta=${report.delta.songs}`,
      `videoDelta=${report.delta.videos}`,
      `occurrenceDelta=${report.delta.occurrences}`,
      `failures=${bundle.counts.failures}`,
    ].join(" "),
  );
  return { bundle, manifest, report };
}

function resolveIncrementDirs(args) {
  const values = [];
  if (args["increment-dir"]) values.push(args["increment-dir"]);
  if (args["increment-dirs"]) values.push(...String(args["increment-dirs"]).split(/[;,]/u));
  return values.map((item) => item.trim()).filter(Boolean).map((item) => path.resolve(item));
}

function readBundle(backfillDir) {
  const manifest = readJson(path.join(backfillDir, "manifest.json"), null);
  if (!manifest) throw new Error(`Missing backfill manifest: ${path.join(backfillDir, "manifest.json")}`);
  return {
    manifest,
    songs: readManifestArrayShards(backfillDir, manifest, "songs"),
    videos: readManifestArrayShards(backfillDir, manifest, "videos"),
    occurrences: readManifestArrayShards(backfillDir, manifest, "occurrences"),
    conflicts: readManifestArrayShards(backfillDir, manifest, "conflicts", true),
    failures: readManifestArrayShards(backfillDir, manifest, "failures", true),
    coverage: readManifestObjectShard(backfillDir, manifest, "coverage") || {},
    syncState: readManifestObjectShard(backfillDir, manifest, "syncState") || {},
  };
}

function readSingerSongsIncrement(dir) {
  const crawl = readJson(path.join(dir, "crawl.json"), null);
  if (!crawl) throw new Error(`Missing increment crawl.json: ${dir}`);
  if (crawl.coverageStatus !== "complete" || crawl.detailCoverageStatus !== "complete") {
    throw new Error(`Increment is not complete: ${dir} coverage=${crawl.coverageStatus} details=${crawl.detailCoverageStatus}`);
  }
  if (crawl.ownerPermission?.enabled !== true) {
    throw new Error(`Increment lacks recorded owner permission: ${dir}`);
  }
  const songs = readJson(path.join(dir, "songs.json"), []);
  const videos = readJson(path.join(dir, "videos.json"), []);
  const rawOccurrences = readJson(path.join(dir, "raw-occurrences.json"), []);
  return {
    dir,
    crawl,
    songs: Array.isArray(songs) ? songs : [],
    videos: Array.isArray(videos) ? videos : [],
    rawOccurrences: Array.isArray(rawOccurrences) ? rawOccurrences : [],
    failures: Array.isArray(crawl.failures) ? crawl.failures : [],
  };
}

function readManifestArrayShards(backfillDir, manifest, key, optional = false) {
  const shards = manifest?.shards?.[key] || [];
  if (!shards.length && optional) return [];
  const rows = [];
  for (const shard of shards) {
    const value = readJson(path.join(backfillDir, shard.file || ""), null);
    if (!Array.isArray(value)) throw new Error(`Manifest ${key} shard must be an array: ${shard.file}`);
    rows.push(...value);
  }
  return rows;
}

function readManifestObjectShard(backfillDir, manifest, key) {
  const shards = manifest?.shards?.[key] || [];
  if (!shards.length) return null;
  if (shards.length !== 1) throw new Error(`Manifest ${key} must have exactly one shard.`);
  const value = readJson(path.join(backfillDir, shards[0].file || ""), null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Manifest ${key} shard must be an object.`);
  return value;
}

function mergeCoverage(baseCoverage, increments, generatedAt, delta) {
  const baseSingerSongs = baseCoverage?.stages?.singerSongs || {};
  const incrementPages = increments.flatMap((item) => [...(item.crawl.pages || []), ...(item.crawl.detailPages || [])]);
  const incrementSingerReports = increments.flatMap((item) => item.crawl.singers || []);
  const incrementOccurrenceCount = increments.reduce((sum, item) => sum + (Number(item.crawl.occurrenceCount) || 0), 0);
  return {
    ...(baseCoverage || {}),
    generatedAt,
    overallStatus: baseCoverage?.overallStatus || "complete",
    stages: {
      ...(baseCoverage?.stages || {}),
      singerSongs: {
        ...baseSingerSongs,
        coverageStatus: baseSingerSongs.coverageStatus || "complete",
        detailCoverageStatus: baseSingerSongs.detailCoverageStatus || "complete",
        incrementalRefresh: {
          generatedAt,
          singerCount: uniqueCount(incrementSingerReports.map((item) => item.externalSingerId)),
          pageCount: increments.reduce((sum, item) => sum + (Number(item.crawl.pageCount) || 0), 0),
          detailPageCount: increments.reduce((sum, item) => sum + (Number(item.crawl.detailPageCount) || 0), 0),
          occurrenceCount: incrementOccurrenceCount,
          songDelta: delta.songDelta,
          videoDelta: delta.videoDelta,
          occurrenceDelta: delta.occurrenceDelta,
          singers: incrementSingerReports.map((item) => ({
            externalSingerId: item.externalSingerId,
            singerName: item.singerName,
            pageCount: item.pageCount,
            uniqueSongCount: item.uniqueSongCount,
            detailPagesFetched: item.detailPagesFetched,
            stopReason: item.stop?.reason || "",
          })),
        },
        requestStats: combineRequestStats(baseSingerSongs.requestStats, requestStatsFromPages(incrementPages)),
      },
    },
  };
}

function mergeSyncState(baseSyncState, coverage, songs, videos, generatedAt) {
  return {
    ...(baseSyncState || {}),
    updatedAt: generatedAt,
    lastIncrementalSingerSongsMerge: coverage.stages?.singerSongs?.incrementalRefresh || null,
    knownSongIds: songs.map((song) => song.externalSongId).filter(Boolean),
    knownExternalVideoIds: videos.map((video) => video.externalVideoId).filter(Boolean),
  };
}

function combineRequestStats(left, right) {
  const leftCount = Number(left?.requestCount || 0);
  const rightCount = Number(right?.requestCount || 0);
  const total = leftCount + rightCount;
  return {
    requestCount: total,
    averageHtmlBytes: weightedAverage(left?.averageHtmlBytes, leftCount, right.averageHtmlBytes, rightCount),
    averageResponseTimeMs: weightedAverage(left?.averageResponseTimeMs, leftCount, right.averageResponseTimeMs, rightCount),
    totalBytes: Number(left?.totalBytes || 0) + Number(right.totalBytes || 0),
  };
}

function weightedAverage(leftAverage, leftCount, rightAverage, rightCount) {
  const total = leftCount + rightCount;
  if (!total) return 0;
  return Math.round((Number(leftAverage || 0) * leftCount + Number(rightAverage || 0) * rightCount) / total);
}

function buildReport({ bundle, manifest, base, increments }) {
  return {
    schemaVersion: 1,
    kind: "vsinger-moment-http-backfill-increment-report",
    generatedAt: bundle.generatedAt,
    counts: bundle.counts,
    delta: {
      songs: bundle.songs.length - base.songs.length,
      videos: bundle.videos.length - base.videos.length,
      occurrences: bundle.occurrences.length - base.occurrences.length,
    },
    manifest: {
      shardSize: manifest.shardSize,
      shards: Object.fromEntries(Object.entries(manifest.shards || {}).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0])),
    },
    increments: increments.map((item) => ({
      dir: relativePath(item.dir),
      generatedAt: item.crawl.generatedAt,
      singersProcessed: item.crawl.singersProcessed,
      uniqueSongCount: item.crawl.uniqueSongCount,
      uniqueVideoCount: item.crawl.uniqueVideoCount,
      occurrenceCount: item.crawl.occurrenceCount,
      stopReason: item.crawl.stop?.reason || "",
      singers: (item.crawl.singers || []).map((singer) => ({
        externalSingerId: singer.externalSingerId,
        singerName: singer.singerName,
        uniqueSongCount: singer.uniqueSongCount,
        detailPagesFetched: singer.detailPagesFetched,
        stopReason: singer.stop?.reason || "",
      })),
    })),
    coverage: bundle.coverage,
  };
}

function writeReportMarkdown(filePath, report) {
  const lines = [
    "# VSinger Moment Increment Merge Report",
    "",
    `Generated at: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Songs: ${report.counts.songs} (${formatDelta(report.delta.songs)})`,
    `- Videos: ${report.counts.videos} (${formatDelta(report.delta.videos)})`,
    `- Occurrences: ${report.counts.occurrences} (${formatDelta(report.delta.occurrences)})`,
    `- Failures: ${report.counts.failures}`,
    "",
    "## Increment Inputs",
    "",
    "| Directory | Singers | Songs | Videos | Occurrences | Stop |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const item of report.increments) {
    lines.push(`| ${item.dir} | ${item.singersProcessed} | ${item.uniqueSongCount} | ${item.uniqueVideoCount} | ${item.occurrenceCount} | ${item.stopReason} |`);
  }
  lines.push("");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}`, "utf8");
}

function dedupeConflicts(conflicts) {
  const seen = new Set();
  const result = [];
  for (const item of conflicts || []) {
    const key = JSON.stringify([item.type || "", item.externalSongId || "", item.variants || []]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function dedupeFailures(failures) {
  const seen = new Set();
  const result = [];
  for (const item of failures || []) {
    const key = JSON.stringify([item.reason || "", item.url || "", item.externalSongId || "", item.status || ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function uniqueCount(values) {
  return new Set(values.filter(Boolean)).size;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function formatDelta(value) {
  return value >= 0 ? `+${value}` : String(value);
}

function relativePath(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/gu, "/");
}

if (require.main === module) {
  try {
    mergeBackfillIncrements(parseArgs());
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  mergeBackfillIncrements,
};
