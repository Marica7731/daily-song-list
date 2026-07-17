const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const zlib = require("node:zlib");

const { writeSourceEntityShardSet, writeVideoSetlistFiles } = require("./lib/source-entity-shards");
const SourceDetailRuntime = require("../assets/source-detail-runtime");

const CASES = [
  { name: "2 sources", sourceCount: 2, timepointsPerVideo: 1 },
  { name: "20 sources", sourceCount: 20, timepointsPerVideo: 1 },
  { name: "100 sources", sourceCount: 100, timepointsPerVideo: 1 },
  { name: "150 sources", sourceCount: 150, timepointsPerVideo: 1 },
  { name: "single video 100 timepoints", sourceCount: 1, timepointsPerVideo: 100 },
];

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "source-detail-benchmark-"));
  try {
    const rows = CASES.map((benchmarkCase) => runCase(tempDir, benchmarkCase));
    console.table(rows);
    console.log(`BENCHMARK_SOURCE_DETAIL_OK cases=${rows.length}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runCase(tempDir, benchmarkCase) {
  const occurrences = makeOccurrences(benchmarkCase);
  const shardSet = writeSourceEntityShardSet({
    rootDir: tempDir,
    rangeId: "7d",
    dataVersion: "benchmark",
    generatedAt: "2026-07-17T00:00:00Z",
    records: [{ key: benchmarkCase.name, songIdentityKey: benchmarkCase.name, occurrences }],
    chunkSize: 20,
  });
  writeVideoSetlistFiles({
    rootDir: tempDir,
    dataVersion: "benchmark",
    generatedAt: "2026-07-17T00:00:00Z",
    items: videoItemsFromOccurrences(occurrences),
  });

  const manifestPath = shardSet.records[0].manifestPath;
  const manifestText = fs.readFileSync(path.join(tempDir, manifestPath), "utf8");
  const manifest = JSON.parse(manifestText);
  const chunkTexts = manifest.chunks.map((chunk) => fs.readFileSync(path.join(tempDir, chunk.path), "utf8"));
  const firstChunkText = chunkTexts[0] || "";
  const allChunkBytes = chunkTexts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
  const allGzipBytes = chunkTexts.reduce((sum, text) => sum + gzipBytes(text), gzipBytes(manifestText));

  const parseStartedAt = performance.now();
  const parsedOccurrences = chunkTexts.flatMap((text) => SourceDetailRuntime.normalizeSourceDetailOccurrences(JSON.parse(text)));
  const parseMs = performance.now() - parseStartedAt;

  const firstDomStartedAt = performance.now();
  const firstDomRows = simulateSourceRows(parsedOccurrences.slice(0, 20));
  const firstDomMs = performance.now() - firstDomStartedAt;
  const sourceRowCount = simulateSourceRows(parsedOccurrences).length;
  const maxDomCount = Math.min(32, sourceRowCount);

  return {
    case: benchmarkCase.name,
    sources: manifest.sourceCount,
    chunks: manifest.chunkCount,
    "manifest bytes": Buffer.byteLength(manifestText, "utf8"),
    "first chunk bytes": Buffer.byteLength(firstChunkText, "utf8"),
    "all chunk bytes": allChunkBytes,
    "gzip bytes": allGzipBytes,
    "parse ms": roundMs(parseMs),
    "first DOM ms": roundMs(firstDomMs),
    "max DOM": Math.max(maxDomCount, firstDomRows.length),
  };
}

function makeOccurrences(benchmarkCase) {
  const occurrences = [];
  for (let sourceIndex = 0; sourceIndex < benchmarkCase.sourceCount; sourceIndex += 1) {
    const videoId = videoIdForIndex(sourceIndex);
    for (let pointIndex = 0; pointIndex < benchmarkCase.timepointsPerVideo; pointIndex += 1) {
      occurrences.push({
        item: {
          videoId,
          title: `Benchmark video ${sourceIndex}`,
          channelName: `Channel ${sourceIndex % 7}`,
          channelId: `UC${String(sourceIndex).padStart(9, "0")}`,
          publishedTimestamp: Date.parse("2026-07-17T00:00:00Z") - sourceIndex * 60000,
          catalogFirstSeenAt: new Date(Date.parse("2026-07-16T00:00:00Z") - sourceIndex * 60000).toISOString(),
          sourceQuality: { sourceType: "comment" },
          songs: Array.from({ length: Math.max(benchmarkCase.timepointsPerVideo, 1) }, (_, index) => ({
            seconds: index * 45,
            title: `Setlist song ${index}`,
            artist: `Artist ${index % 5}`,
          })),
        },
        song: {
          seconds: pointIndex * 45,
          title: `Benchmark song ${pointIndex}`,
          artist: `Artist ${pointIndex % 5}`,
          isNiche: pointIndex % 2 === 0,
        },
      });
    }
  }
  return occurrences;
}

function videoItemsFromOccurrences(occurrences) {
  const byVideoId = new Map();
  for (const occurrence of occurrences) {
    const item = occurrence.item;
    if (!byVideoId.has(item.videoId)) byVideoId.set(item.videoId, item);
  }
  return [...byVideoId.values()];
}

function simulateSourceRows(occurrences) {
  const byVideoId = new Map();
  for (const occurrence of occurrences) {
    if (!byVideoId.has(occurrence.item.videoId)) {
      byVideoId.set(occurrence.item.videoId, {
        videoId: occurrence.item.videoId,
        channelName: occurrence.item.channelName,
        title: occurrence.item.title,
        buttons: ["timestamp", "setlist"],
        lazyMedia: true,
        timepoints: [],
      });
    }
    byVideoId.get(occurrence.item.videoId).timepoints.push(occurrence.song.seconds);
  }
  return [...byVideoId.values()];
}

function videoIdForIndex(index) {
  return `BMK${String(index).padStart(8, "0")}`;
}

function gzipBytes(text) {
  return zlib.gzipSync(Buffer.from(String(text), "utf8")).length;
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

if (require.main === module) main();
