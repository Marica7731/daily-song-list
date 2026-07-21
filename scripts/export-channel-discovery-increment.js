const fs = require("node:fs");
const path = require("node:path");

const { loadCurationContext } = require("./curation");
const { loadVideoCatalog } = require("./video-catalog");
const {
  filterNonRegressiveImports,
  inputDirsFromArgs,
  projectRelativePath,
  readDiscoveryVideos,
  SOURCE_GROUP,
} = require("./import-channel-discovery");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = inputDirsFromArgs(args);
  const outputPath = path.resolve(ROOT, String(args.output || path.join("data", "external", "youtube-channel-discovery", "accepted", "manual-import.json")));
  const generatedAt = new Date().toISOString();
  const curation = loadCurationContext();
  const catalog = loadVideoCatalog();
  const { videos, stats: readStats } = readDiscoveryVideos(inputs, { auditExceptionsPath: args["audit-exceptions"] });
  if (!videos.length && !args["allow-empty"]) {
    throw new Error(`no usable channel discovery video details found in ${inputs.join(", ")}`);
  }
  const safeImport = filterNonRegressiveImports(catalog, videos);
  const acceptedVideos = safeImport.videos.map((video) => ({
    ...video,
    curationVersion: curation.version,
    curationHash: curation.hash,
  }));
  const inputSummaries = buildInputSummaries(inputs, readStats, videos, acceptedVideos, safeImport);
  const payload = {
    schemaVersion: 1,
    sourceSystem: SOURCE_GROUP,
    kind: "youtube-channel-discovery-increment",
    generatedAt,
    inputs: inputs.map((input) => projectRelativePath(input)),
    readStats: { ...readStats, ...safeImport.stats },
    inputSummaries,
    videoCount: acceptedVideos.length,
    occurrenceCount: acceptedVideos.reduce((total, video) => total + (Array.isArray(video.songs) ? video.songs.length : 0), 0),
    videos: acceptedVideos,
  };
  writeJson(outputPath, payload);
  console.log(
    [
      "CODEX_CHANNEL_DISCOVERY_INCREMENT_OK",
      `inputs=${inputs.length}`,
      `readVideos=${readStats.videoDetails}`,
      `usableVideos=${videos.length}`,
      `acceptedVideos=${acceptedVideos.length}`,
      `skippedRegressions=${safeImport.stats.skippedExistingRegressions}`,
      `suspicious=${inputSummaries.reduce((total, item) => total + item.suspicious, 0)}`,
      `occurrences=${payload.occurrenceCount}`,
      `failed=${inputSummaries.reduce((total, item) => total + item.failed, 0)}`,
      `output=${quoteForMarker(outputPath)}`,
    ].join(" "),
  );
}

function buildInputSummaries(inputDirs, readStats, usableVideos, acceptedVideos, safeImport) {
  const readStatsByInput = new Map((readStats.inputSummaries || []).map((item) => [item.inputDir, item]));
  const usableByInput = groupVideosByInput(usableVideos);
  const acceptedByInput = groupVideosByInput(acceptedVideos);
  const skippedRegressionIds = new Set(safeImport.stats.skippedExistingRegressionVideoIds || []);
  return inputDirs.map((inputDir) => {
    const inputKey = projectRelativePath(inputDir);
    const manifest = readJsonIfExists(path.join(inputDir, "manifest.json")) || {};
    const audits = readJsonArrayIfExists(path.join(inputDir, "audits.json"));
    const rawVideos = readJsonArrayIfExists(path.join(inputDir, "raw-videos.json"));
    const read = readStatsByInput.get(inputKey) || {};
    const usable = usableByInput.get(inputKey) || [];
    const accepted = acceptedByInput.get(inputKey) || [];
    const regressionSkipped = usable.filter((video) => skippedRegressionIds.has(video.videoId));
    const failedReasons = summarizeFailedAudits(audits);
    const preImportAudit = normalizePreImportAuditSummary(read.preImportAudit);
    const preImportFailedVideos = Number(preImportAudit.cleaned?.videos?.failed) || 0;
    const suspiciousVideos = Number(preImportAudit.cleaned?.videos?.withSuspiciousRows) || Number(preImportAudit.cleaned?.videos?.suspicious) || 0;
    const importedOccurrenceCount = sumSongCount(accepted);
    const skippedNoSongs = Number(read.skippedNoSongs) || 0;
    const skippedInvalidVideoId = Number(read.skippedInvalidVideoId) || 0;
    const duplicateVideoIds = Number(read.duplicateVideoIds) || 0;
    return {
      inputDir: inputKey,
      channelUrl: stringValue(manifest.channelUrl),
      singerName: stringValue(manifest.singerName),
      generatedAt: stringValue(manifest.generatedAt),
      imported: accepted.length,
      rawCandidates: {
        videos: Number(preImportAudit.raw?.videoDetails) || Number(read.videoDetails) || 0,
        songs: Number(preImportAudit.raw?.songCandidates) || Number(read.rawSongCandidates) || 0,
      },
      skipped: skippedNoSongs + skippedInvalidVideoId + duplicateVideoIds + regressionSkipped.length,
      failed: failedReasons.total + preImportFailedVideos,
      suspicious: suspiciousVideos,
      failedReasons: mergeReasonCounts(failedReasons.byResult, preImportAudit.reasons?.failed),
      suspiciousReasons: preImportAudit.reasons?.suspicious || {},
      caseSamples: preImportAudit.caseSamples || {},
      skippedReasons: {
        noSongs: skippedNoSongs,
        invalidVideoId: skippedInvalidVideoId,
        duplicateVideoIds,
        existingRegression: regressionSkipped.length,
        preImportAudit: preImportAudit.reasons?.skipped || {},
      },
      preImportAudit,
      suspiciousQueue: preImportAudit.suspiciousQueue || preImportAudit.suspiciousItems || [],
      increments: {
        videos: accepted.length,
        occurrences: importedOccurrenceCount,
        songs: countDistinctSongs(accepted),
      },
      discovery: {
        candidates: Number(manifest.candidateCount) || rawVideos.length,
        inspectedInLatestRun: Number(manifest.inspectedInLatestRun) || 0,
        usableVideos: Number(read.usableVideos) || usable.length,
        occurrences: Number(manifest.occurrenceCount) || sumSongCount(usable),
      },
      coverage: {
        usableVideos: {
          publishedTimestamp: ratioSummary(usable, (video) => video.publishedTimestamp),
          thumbnailUrl: ratioSummary(usable, (video) => video.thumbnailUrl),
        },
        acceptedVideos: {
          publishedTimestamp: ratioSummary(accepted, (video) => video.publishedTimestamp),
          thumbnailUrl: ratioSummary(accepted, (video) => video.thumbnailUrl),
        },
        acceptedOccurrences: {
          seconds: ratioSummary(accepted.flatMap((video) => video.songs || []), (song) => Number.isFinite(Number(song.seconds))),
        },
      },
      missingThumbnailVideoIds: accepted.filter((video) => !video.thumbnailUrl).map((video) => video.videoId).sort(),
      skippedExistingRegressionVideoIds: regressionSkipped.map((video) => video.videoId).sort(),
    };
  });
}

function groupVideosByInput(videos) {
  const result = new Map();
  for (const video of videos || []) {
    const inputDir = video.discoveryImport?.inputDir || "";
    if (!result.has(inputDir)) result.set(inputDir, []);
    result.get(inputDir).push(video);
  }
  return result;
}

function summarizeFailedAudits(audits) {
  const byResult = {};
  let total = 0;
  for (const audit of audits || []) {
    const result = stringValue(audit.result) || "unknown";
    if (result === "selected") continue;
    total += 1;
    byResult[result] = (byResult[result] || 0) + 1;
  }
  return { total, byResult };
}

function normalizePreImportAuditSummary(summary) {
  return {
    policy: summary?.policy || {},
    raw: {
      videoDetails: Number(summary?.raw?.videoDetails) || 0,
      songCandidates: Number(summary?.raw?.songCandidates) || 0,
    },
    cleaned: {
      videos: {
        accepted: Number(summary?.cleaned?.videos?.accepted) || 0,
        skipped: Number(summary?.cleaned?.videos?.skipped) || 0,
        failed: Number(summary?.cleaned?.videos?.failed) || 0,
        suspicious: Number(summary?.cleaned?.videos?.suspicious) || 0,
        withSuspiciousRows: Number(summary?.cleaned?.videos?.withSuspiciousRows) || 0,
        withFailedRows: Number(summary?.cleaned?.videos?.withFailedRows) || 0,
        dropped: Number(summary?.cleaned?.videos?.dropped) || 0,
      },
      songs: {
        accepted: Number(summary?.cleaned?.songs?.accepted) || 0,
        skipped: Number(summary?.cleaned?.songs?.skipped) || 0,
        failed: Number(summary?.cleaned?.songs?.failed) || 0,
        suspicious: Number(summary?.cleaned?.songs?.suspicious) || 0,
        dropped: Number(summary?.cleaned?.songs?.dropped) || 0,
      },
    },
    reasons: {
      skipped: summary?.reasons?.skipped || {},
      failed: summary?.reasons?.failed || {},
      suspicious: summary?.reasons?.suspicious || {},
      acceptedExceptions: Number(summary?.reasons?.acceptedExceptions) || 0,
      rejectedExceptions: Number(summary?.reasons?.rejectedExceptions) || 0,
    },
    caseSamples: summary?.caseSamples || {},
    channelSummaries: Array.isArray(summary?.channelSummaries) ? summary.channelSummaries : [],
    suspiciousItems: Array.isArray(summary?.suspiciousItems) ? summary.suspiciousItems : [],
    suspiciousQueue: Array.isArray(summary?.suspiciousQueue) ? summary.suspiciousQueue : Array.isArray(summary?.suspiciousItems) ? summary.suspiciousItems : [],
  };
}

function mergeReasonCounts(...items) {
  const result = {};
  for (const item of items || []) {
    for (const [key, value] of Object.entries(item || {})) {
      result[key] = (result[key] || 0) + (Number(value) || 0);
    }
  }
  return result;
}

function ratioSummary(items, hasValue) {
  const total = Array.isArray(items) ? items.length : 0;
  const covered = (items || []).filter((item) => {
    const value = hasValue(item);
    return typeof value === "boolean" ? value : Boolean(value);
  }).length;
  return {
    covered,
    total,
    ratio: total ? roundNumber(covered / total, 4) : null,
  };
}

function countDistinctSongs(videos) {
  const keys = new Set();
  for (const video of videos || []) {
    for (const song of video.songs || []) {
      const key = `${normalizeIdentity(song.title)}\u0001${normalizeIdentity(song.artist)}`;
      if (key.trim()) keys.add(key);
    }
  }
  return keys.size;
}

function sumSongCount(videos) {
  return (videos || []).reduce((total, video) => total + (Array.isArray(video.songs) ? video.songs.length : 0), 0);
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readJsonArrayIfExists(filePath) {
  const value = readJsonIfExists(filePath);
  return Array.isArray(value) ? value : [];
}

function normalizeIdentity(value) {
  return stringValue(value).normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function roundNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function stringValue(value) {
  return String(value || "").trim();
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    const value = !next || next.startsWith("--") ? true : next;
    if (value !== true) index += 1;
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      args[key] = Array.isArray(args[key]) ? [...args[key], value] : [args[key], value];
    } else {
      args[key] = value;
    }
  }
  return args;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function quoteForMarker(value) {
  return JSON.stringify(String(value || ""));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildInputSummaries,
  parseArgs,
};
