#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const { readJson, writeJson } = require("./bundle-writer");
const { parseArgs, requestStatsFromPages, stopRecord } = require("./crawl-core");
const { dedupeOccurrences, dedupeSongs, dedupeVideos, occurrenceEntitiesFromVideo } = require("./model");
const {
  buildSyncState,
  dedupeRawOccurrences,
  loadSingerTargets,
  singerSongsReport,
  videosFromSingerOccurrences,
} = require("./crawl-singer-songs");

function planSingerSongShards(options = {}) {
  const args = { ...options };
  const singersFile = args["singers-file"];
  if (!singersFile) throw new Error("Provide --singers-file for shard planning.");

  const allSingers = loadSingerTargets({ "singers-file": singersFile });
  const startIndex = optionalIndex(args["singer-start-index"], 0, "singer-start-index");
  const endIndex = optionalIndex(args["singer-end-index"], allSingers.length, "singer-end-index");
  if (startIndex > endIndex) throw new Error(`--singer-start-index (${startIndex}) must be <= --singer-end-index (${endIndex}).`);
  if (endIndex > allSingers.length) throw new Error(`--singer-end-index (${endIndex}) exceeds singer target count (${allSingers.length}).`);

  const selected = allSingers.slice(startIndex, endIndex).map((singer, offset) => ({
    ...singer,
    sourceSingerIndex: startIndex + offset,
  }));
  const shardCount = args.shards ? positiveInteger(args.shards, "shards") : null;
  const shardSize = args["shard-size"] ? positiveInteger(args["shard-size"], "shard-size") : null;
  if (!shardCount && !shardSize) throw new Error("Provide --shards or --shard-size for shard planning.");

  const ranges = shardCount ? evenRanges(startIndex, endIndex, shardCount) : sizeRanges(startIndex, endIndex, shardSize);
  const outputDir = args["output-dir"] || path.resolve(process.cwd(), "artifacts", "vsinger-http-backfill", "singer-song-shards");
  const crawlOutputRoot = args["crawl-output-root"] || path.join(outputDir, "outputs");
  const ownerPermissionNote = args["owner-permission-note"] || "site-owner email authorization";
  const maxSingers = args["max-singers"] || "";
  const maxSongPages = args["max-song-pages"] || "";
  const requestIntervalMs = args["request-interval-ms"] || "";

  fs.mkdirSync(outputDir, { recursive: true });
  const shards = ranges.map((range, index) => {
    const shardId = `shard-${String(index + 1).padStart(3, "0")}`;
    const shardSingers = selected.slice(range.start - startIndex, range.end - startIndex);
    const shardSingersFile = path.join(outputDir, `${shardId}.singers.json`);
    const shardOutputDir = path.join(crawlOutputRoot, shardId);
    writeJson(shardSingersFile, {
      schemaVersion: 1,
      kind: "vsinger-moment-http-singer-song-shard-targets",
      sourceSingersFile: relativePath(path.resolve(singersFile)),
      singerStartIndex: range.start,
      singerEndIndex: range.end,
      singerCount: shardSingers.length,
      singers: shardSingers,
    });
    return {
      shardId,
      singerStartIndex: range.start,
      singerEndIndex: range.end,
      singerCount: shardSingers.length,
      singersFile: relativePath(shardSingersFile),
      outputDir: relativePath(shardOutputDir),
      command: crawlCommand({
        singersFile: relativePath(shardSingersFile),
        outputDir: relativePath(shardOutputDir),
        ownerPermissionNote,
        maxSingers,
        maxSongPages,
        requestIntervalMs,
      }),
    };
  });

  const manifest = {
    schemaVersion: 1,
    kind: "vsinger-moment-http-singer-song-shard-plan",
    generatedAt: new Date().toISOString(),
    sourceSingersFile: relativePath(path.resolve(singersFile)),
    singerTargetCount: allSingers.length,
    singerStartIndex: startIndex,
    singerEndIndex: endIndex,
    selectedSingerCount: selected.length,
    shardCount: shards.length,
    shards,
    mergeCommand: `npm run vsinger:shard:singer-songs -- --mode merge --manifest ${shellQuote(relativePath(path.join(outputDir, "manifest.json")))} --output-dir artifacts/vsinger-http-backfill/singer-songs-merged`,
  };
  writeJson(path.join(outputDir, "manifest.json"), manifest);
  writeText(path.join(outputDir, "commands.ps1"), commandLines(shards, "powershell"));
  writeText(path.join(outputDir, "commands.sh"), commandLines(shards, "bash"));
  console.log(`CODEX_VSINGER_SINGER_SHARD_PLAN_OK shards=${shards.length} singers=${selected.length} output=${relativePath(outputDir)}`);
  return manifest;
}

function mergeSingerSongShards(options = {}) {
  const args = { ...options };
  const generatedAt = args.generatedAt || new Date().toISOString();
  const shardDirs = resolveShardDirs(args);
  if (!shardDirs.length) throw new Error("No shard crawl directories found.");

  const shardReports = [];
  const state = {
    pages: [],
    detailPages: [],
    failures: [],
    songs: [],
    rawOccurrences: [],
    singerReports: [],
  };

  for (const shardDir of shardDirs) {
    const report = readJson(path.join(shardDir, "crawl.json"), null);
    if (!report) throw new Error(`Missing crawl.json in shard directory: ${shardDir}`);
    const shardId = path.basename(shardDir);
    const songs = readJson(path.join(shardDir, "songs.json"), report.songs || []);
    const rawOccurrences = readJson(path.join(shardDir, "raw-occurrences.json"), report.rawOccurrences || []);

    shardReports.push({ shardId, shardDir, report });
    state.pages.push(...tagShard(report.pages || [], shardId));
    state.detailPages.push(...tagShard(report.detailPages || [], shardId));
    state.failures.push(...tagShard(report.failures || [], shardId));
    state.songs.push(...tagShard(songs, shardId));
    state.rawOccurrences.push(...tagShard(rawOccurrences, shardId));
    upsertSingerReports(state.singerReports, tagShard(report.singers || [], shardId));
  }

  const rawOccurrences = dedupeRawOccurrences(state.rawOccurrences);
  const songs = dedupeSongs(state.songs).map((song) => ({
    ...song,
    permissionSource: song.permissionSource || "site_owner_permission",
  }));
  const videos = dedupeVideos(videosFromSingerOccurrences(rawOccurrences));
  const occurrences = dedupeOccurrences(videos.flatMap(occurrenceEntitiesFromVideo));
  const failures = dedupeFailures(state.failures);
  const singers = sortSingerReports(state.singerReports);
  const shardSummaries = shardReports.map(({ shardId, shardDir, report }) => ({
    shardId,
    shardDir: relativePath(shardDir),
    coverageStatus: report.coverageStatus || "missing",
    detailCoverageStatus: report.detailCoverageStatus || "missing",
    singersProcessed: report.singersProcessed || 0,
    singerTargetCount: report.singerTargetCount || 0,
    stopReason: report.stop?.reason || "",
    currentSinger: report.currentSinger || null,
  }));

  const targetCount = targetCountFromArgs(args, shardReports, singers.length);
  const allShardDetailsComplete = shardReports.every(({ report }) => report.detailCoverageStatus === "complete");
  const allMergedSingersComplete = singers.length >= targetCount && singers.every((report) => report.stop?.reason === "no-next-cursor");
  const detailCoverageStatus = allShardDetailsComplete && failures.length === 0 ? "complete" : "partial";
  const coverageStatus = allMergedSingersComplete && detailCoverageStatus === "complete" && failures.length === 0 ? "complete" : "partial";
  const stop = coverageStatus === "complete"
    ? stopRecord("completed-targets", { singerCount: targetCount, mergedShardCount: shardReports.length })
    : stopRecord("merged-shards-partial", { singerCount: singers.length, targetCount, mergedShardCount: shardReports.length });
  const nextSingerIndex = coverageStatus === "complete" ? targetCount : Math.min(singers.length, targetCount);
  const ownerPermission = ownerPermissionFromReports(shardReports);

  const result = {
    schemaVersion: 1,
    kind: "vsinger-moment-http-singer-songs-crawl",
    generatedAt,
    ownerPermission,
    stop,
    singerTargetCount: targetCount,
    nextSingerIndex,
    remainingSingerCount: Math.max(0, targetCount - nextSingerIndex),
    currentSinger: null,
    singersProcessed: singers.length,
    pageCount: state.pages.length,
    detailPageCount: state.detailPages.length,
    rawSongRowCount: state.pages.reduce((sum, page) => sum + (Number(page.rawRowCount) || 0), 0),
    uniqueSongCount: songs.length,
    rawOccurrenceCount: rawOccurrences.length,
    occurrenceCount: occurrences.length,
    uniqueVideoCount: videos.length,
    detailCoverageStatus,
    coverageStatus,
    requestStats: requestStatsFromPages([...state.pages, ...state.detailPages]),
    singers,
    pages: state.pages,
    detailPages: state.detailPages,
    songs,
    videos,
    occurrences,
    rawOccurrences,
    failures,
    shardMerge: {
      schemaVersion: 1,
      sourceShardCount: shardReports.length,
      shards: shardSummaries,
    },
  };

  const outputDir = args["output-dir"] || path.resolve(process.cwd(), "artifacts", "vsinger-http-backfill", "singer-songs-merged");
  fs.mkdirSync(outputDir, { recursive: true });
  writeJson(path.join(outputDir, "crawl.json"), singerSongsReport(result));
  writeJson(path.join(outputDir, "songs.json"), result.songs);
  writeJson(path.join(outputDir, "videos.json"), result.videos);
  writeJson(path.join(outputDir, "occurrences.json"), result.occurrences);
  writeJson(path.join(outputDir, "raw-occurrences.json"), result.rawOccurrences);
  writeJson(path.join(outputDir, "sync-state.json"), buildSyncState(result));
  writeJson(path.join(outputDir, "merge-report.json"), result.shardMerge);
  writeJson(path.join(outputDir, "checkpoint.json"), {
    schemaVersion: 1,
    kind: "vsinger-moment-http-singer-songs-checkpoint",
    updatedAt: result.generatedAt,
    ownerPermission: result.ownerPermission,
    singerTargetCount: result.singerTargetCount,
    nextSingerIndex: result.nextSingerIndex,
    remainingSingerCount: result.remainingSingerCount,
    currentSinger: null,
    knownSongIds: result.songs.map((song) => song.externalSongId),
    knownExternalVideoIds: result.videos.map((video) => video.externalVideoId),
    coverageStatus: result.coverageStatus,
  });

  if (args["require-complete"] && coverageStatus !== "complete") {
    throw new Error(`Merged shard coverage is ${coverageStatus}; expected complete.`);
  }
  console.log(`CODEX_VSINGER_SINGER_SHARD_MERGE_OK shards=${shardReports.length} singers=${result.singersProcessed} songs=${result.uniqueSongCount} videos=${result.uniqueVideoCount} occurrences=${result.occurrenceCount} status=${result.coverageStatus}`);
  return result;
}

function resolveShardDirs(args) {
  if (args.manifest) {
    const manifest = readJson(args.manifest, null);
    if (!manifest) throw new Error(`Cannot read shard manifest: ${args.manifest}`);
    return (manifest.shards || []).map((shard) => path.resolve(process.cwd(), shard.outputDir || ""));
  }
  if (args["shard-dirs"]) {
    return String(args["shard-dirs"])
      .split(/[;,]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => path.resolve(item));
  }
  const root = args["shards-root"] || path.resolve(process.cwd(), "artifacts", "vsinger-http-backfill", "singer-song-shards", "outputs");
  return findShardDirs(root);
}

function findShardDirs(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const stack = [{ dir: path.resolve(root), depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (fs.existsSync(path.join(dir, "crawl.json"))) {
      result.push(dir);
      continue;
    }
    if (depth >= 3) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return result.sort();
}

function targetCountFromArgs(args, shardReports, singerCount) {
  const explicit = args["singer-target-count"] || args["total-singers"];
  if (explicit) return positiveInteger(explicit, "singer-target-count");
  const manifest = args.manifest ? readJson(args.manifest, {}) : {};
  if (manifest.selectedSingerCount) return Number(manifest.selectedSingerCount);
  const shardTargetSum = shardReports.reduce((sum, item) => sum + (Number(item.report.singerTargetCount) || 0), 0);
  return Math.max(singerCount, shardTargetSum);
}

function ownerPermissionFromReports(shardReports) {
  const permissions = shardReports.map((item) => item.report.ownerPermission).filter(Boolean);
  const enabled = permissions.some((item) => item.enabled);
  return {
    enabled,
    note: permissions.map((item) => item.note).filter(Boolean)[0] || "",
    acceptedAt: permissions.map((item) => item.acceptedAt).filter(Boolean).sort()[0] || "",
    robotsSingerSongsQueryAllowed: permissions.some((item) => item.robotsSingerSongsQueryAllowed),
    mergedShardCount: shardReports.length,
  };
}

function upsertSingerReports(target, reports) {
  for (const report of reports) {
    const index = target.findIndex((item) => item.externalSingerId === report.externalSingerId);
    if (index < 0) target.push(report);
    else target[index] = betterSingerReport(target[index], report);
  }
}

function betterSingerReport(left, right) {
  const leftCompleted = left.stop?.reason === "no-next-cursor";
  const rightCompleted = right.stop?.reason === "no-next-cursor";
  if (rightCompleted && !leftCompleted) return right;
  if (leftCompleted && !rightCompleted) return left;
  return (Number(right.pageCount) || 0) >= (Number(left.pageCount) || 0) ? right : left;
}

function sortSingerReports(reports) {
  return [...reports].sort((left, right) => {
    const leftIndex = Number.isInteger(left.sourceSingerIndex) ? left.sourceSingerIndex : Number.MAX_SAFE_INTEGER;
    const rightIndex = Number.isInteger(right.sourceSingerIndex) ? right.sourceSingerIndex : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || String(left.externalSingerId).localeCompare(String(right.externalSingerId));
  });
}

function dedupeFailures(failures) {
  const seen = new Set();
  const result = [];
  for (const failure of failures || []) {
    const key = JSON.stringify([failure.shardId || "", failure.reason || "", failure.url || "", failure.externalSongId || "", failure.status || ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(failure);
  }
  return result;
}

function tagShard(items, shardId) {
  return (items || []).map((item) => ({ ...item, shardId }));
}

function evenRanges(start, end, shardCount) {
  const total = end - start;
  const ranges = [];
  for (let index = 0; index < shardCount; index += 1) {
    const rangeStart = start + Math.floor((total * index) / shardCount);
    const rangeEnd = start + Math.floor((total * (index + 1)) / shardCount);
    if (rangeStart < rangeEnd) ranges.push({ start: rangeStart, end: rangeEnd });
  }
  return ranges;
}

function sizeRanges(start, end, shardSize) {
  const ranges = [];
  for (let index = start; index < end; index += shardSize) {
    ranges.push({ start: index, end: Math.min(end, index + shardSize) });
  }
  return ranges;
}

function crawlCommand({ singersFile, outputDir, ownerPermissionNote, maxSingers, maxSongPages, requestIntervalMs }) {
  const parts = [
    "npm run vsinger:crawl:singer-songs --",
    "--fresh",
    "--owner-permission",
    "--owner-permission-note",
    shellQuote(ownerPermissionNote),
    "--singers-file",
    shellQuote(singersFile),
    "--output-dir",
    shellQuote(outputDir),
    "--fetch-song-details",
  ];
  if (maxSingers) parts.push("--max-singers", String(maxSingers));
  if (maxSongPages) parts.push("--max-song-pages", String(maxSongPages));
  if (requestIntervalMs) parts.push("--request-interval-ms", String(requestIntervalMs));
  return parts.join(" ");
}

function commandLines(shards, shell) {
  const lines = shell === "powershell"
    ? ["# Run each command on a separate VPS. Remove --fresh when resuming the same shard output-dir."]
    : ["#!/usr/bin/env bash", "set -euo pipefail", "# Run each command on a separate VPS. Remove --fresh when resuming the same shard output-dir."];
  for (const shard of shards) lines.push(shard.command);
  lines.push("");
  return lines.join("\n");
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:\\-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function relativePath(filePath) {
  return path.relative(process.cwd(), path.resolve(filePath)).replace(/\\/g, "/");
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function optionalIndex(value, fallback, label) {
  if (value == null || value === true || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${label} must be a non-negative integer.`);
  return parsed;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${label} must be a positive integer.`);
  return parsed;
}

if (require.main === module) {
  const args = parseArgs();
  const mode = args.mode || "plan";
  try {
    if (mode === "plan") planSingerSongShards(args);
    else if (mode === "merge") mergeSingerSongShards(args);
    else throw new Error(`Unknown --mode ${mode}; expected plan or merge.`);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  mergeSingerSongShards,
  planSingerSongShards,
};
