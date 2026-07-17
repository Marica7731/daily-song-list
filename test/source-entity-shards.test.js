const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildSlimSourceEntries,
  videoSetlistPath,
  writeSourceEntityShardSet,
  writeVideoSetlistFiles,
} = require("../scripts/lib/source-entity-shards");

test("source entity shards write one independent manifest per song identity", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "source-entity-shards-"));
  try {
    const records = [
      { key: "song-a", songIdentityKey: "song-a", occurrences: [occurrence("AAAAAAAAAAA", 30, "Song A")] },
      { key: "song-b", songIdentityKey: "song-b", occurrences: [occurrence("BBBBBBBBBBB", 45, "Song B")] },
    ];

    const result = writeSourceEntityShardSet({
      rootDir: tempDir,
      rangeId: "7d",
      dataVersion: "version",
      generatedAt: "2026-07-17T00:00:00Z",
      records,
      chunkSize: 20,
    });

    assert.equal(result.itemCount, 2);
    const manifestA = readJson(tempDir, result.records.find((record) => record.key === "song-a").manifestPath);
    const manifestB = readJson(tempDir, result.records.find((record) => record.key === "song-b").manifestPath);
    assert.equal(manifestA.songIdentityKey, "song-a");
    assert.equal(manifestB.songIdentityKey, "song-b");
    assert.equal(manifestA.chunks.length, 1);
    assert.match(manifestA.chunks[0].path, /data\/ui\/ranges\/7d\/sources\/[0-9a-f]{2}\/song-a\/chunk-0001\.[0-9a-f]{12}\.json/u);

    const chunkA = readJson(tempDir, manifestA.chunks[0].path);
    const chunkB = readJson(tempDir, manifestB.chunks[0].path);
    assert.deepEqual(chunkA.sources.map((source) => source.videoId), ["AAAAAAAAAAA"]);
    assert.deepEqual(chunkB.sources.map((source) => source.videoId), ["BBBBBBBBBBB"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("source records are slim and do not carry full video setlists or heavy fields", () => {
  const [source] = buildSlimSourceEntries([
    occurrence("CCCCCCCCCCC", 90, "Song C", {
      item: {
        description: "full description must not be copied",
        comments: ["comment"],
        hashtags: ["#tag"],
        thumbnailUrl: "https://i.ytimg.com/vi/CCCCCCCCCCC/hqdefault.jpg",
        searchText: "duplicate search text",
        songs: [{ seconds: 1, title: "Other Song" }],
      },
    }),
  ]);

  assert.deepEqual(Object.keys(source).sort(), [
    "channelId",
    "channelName",
    "firstSeenAt",
    "publishedTimestamp",
    "status",
    "timepoints",
    "videoId",
    "videoTitle",
  ]);
  assert.deepEqual(source.timepoints, [{ seconds: 90, title: "Song C", artist: "Artist", isNiche: true }]);
  assert.equal(JSON.stringify(source).includes("Other Song"), false);
  assert.equal(JSON.stringify(source).includes("thumbnail"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(source), "utf8") < 300);
});

test("popular songs are chunked and sorted without duplicate video rows", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "source-entity-chunks-"));
  try {
    const occurrences = [];
    for (let index = 0; index < 45; index += 1) {
      occurrences.push(occurrence(videoId(index), 120 - index, "Song A", {
        item: {
          publishedTimestamp: Date.parse(`2026-07-${String(10 + (index % 5)).padStart(2, "0")}T00:00:00Z`),
          catalogFirstSeenAt: `2026-07-${String(1 + (index % 9)).padStart(2, "0")}T00:00:00Z`,
        },
      }));
    }
    occurrences.push(occurrence(videoId(0), 5, "Song A"));

    const result = writeSourceEntityShardSet({
      rootDir: tempDir,
      rangeId: "all",
      dataVersion: "version",
      generatedAt: "2026-07-17T00:00:00Z",
      records: [{ key: "popular", songIdentityKey: "popular", occurrences }],
      chunkSize: 20,
    });
    const manifest = readJson(tempDir, result.records[0].manifestPath);
    assert.equal(manifest.sourceCount, 45);
    assert.equal(manifest.chunkSize, 20);
    assert.equal(manifest.chunkCount, 3);
    assert.equal(manifest.chunks.every((chunk) => chunk.gzipBytes < 150 * 1024), true);

    const allSources = manifest.chunks.flatMap((chunk) => readJson(tempDir, chunk.path).sources);
    assert.equal(new Set(allSources.map((source) => source.videoId)).size, 45);
    assert.deepEqual(
      allSources.find((source) => source.videoId === videoId(0)).timepoints.map((point) => point.seconds),
      [5, 120],
    );
    assert.deepEqual(
      allSources.map((source) => source.videoId),
      [...allSources].sort((a, b) => compareExpectedSourceOrder(a, b)).map((source) => source.videoId),
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("video setlists are written separately and addressed by video id", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "source-video-setlists-"));
  try {
    const result = writeVideoSetlistFiles({
      rootDir: tempDir,
      dataVersion: "version",
      generatedAt: "2026-07-17T00:00:00Z",
      items: [
        {
          videoId: "DDDDDDDDDDD",
          title: "Full Video",
          channelName: "Channel",
          songs: [
            { seconds: 100, title: "Second", artist: "Artist" },
            { seconds: 10, title: "First", artist: "Artist" },
          ],
        },
      ],
    });

    assert.equal(result.itemCount, 1);
    assert.equal(result.records[0].path, videoSetlistPath("DDDDDDDDDDD"));
    const payload = readJson(tempDir, result.records[0].path);
    assert.deepEqual(payload.songs.map((song) => song.title), ["First", "Second"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function occurrence(videoIdValue, seconds, title, overrides = {}) {
  const item = {
    videoId: videoIdValue,
    title: `Video ${videoIdValue}`,
    channelName: "Channel",
    channelId: "UCCHANNEL",
    publishedTimestamp: Date.parse("2026-07-17T00:00:00Z"),
    catalogFirstSeenAt: "2026-07-16T00:00:00Z",
    sourceQuality: { sourceType: "comment" },
    ...(overrides.item || {}),
  };
  return {
    item,
    song: {
      seconds,
      title,
      artist: "Artist",
      isNiche: true,
      ...(overrides.song || {}),
    },
  };
}

function videoId(index) {
  return `VID${String(index).padStart(8, "0")}`;
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function compareExpectedSourceOrder(a, b) {
  const timestampA = Number(a.publishedTimestamp) || 0;
  const timestampB = Number(b.publishedTimestamp) || 0;
  if (timestampA !== timestampB) return timestampB - timestampA;
  const firstA = Date.parse(a.firstSeenAt || "") || 0;
  const firstB = Date.parse(b.firstSeenAt || "") || 0;
  if (firstA !== firstB) return firstB - firstA;
  return a.videoId.localeCompare(b.videoId, "en", { numeric: true, sensitivity: "base" });
}
