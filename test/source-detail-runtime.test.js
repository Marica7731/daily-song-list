const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const SourceDetailRuntime = require("../assets/source-detail-runtime");

test("new source detail chunks normalize into current-song occurrences only", () => {
  const occurrences = SourceDetailRuntime.normalizeSourceDetailOccurrences({
    kind: "source-detail-chunk-v3",
    sources: [
      {
        videoId: "AAAAAAAAAAA",
        channelName: "Channel",
        channelId: "UCID",
        videoTitle: "Short title",
        publishedTimestamp: Date.parse("2026-07-17T00:00:00Z"),
        firstSeenAt: "2026-07-16T00:00:00Z",
        thumbnailUrl: "must not be copied",
        songs: [{ title: "unrelated" }],
        timepoints: [
          { seconds: 80, title: "Song", artist: "Artist" },
          { seconds: 10, title: "Song", artist: "Artist" },
        ],
      },
    ],
  });

  assert.equal(occurrences.length, 2);
  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.song.seconds),
    [80, 10],
  );
  assert.equal(occurrences[0].item.videoId, "AAAAAAAAAAA");
  assert.equal(occurrences[0].item.thumbnailUrl, undefined);
  assert.equal(occurrences[0].item.songs, undefined);
  assert.equal(occurrences[0].item._requiresVideoSetlist, true);
});

test("manifest loader reads only the selected song chunks and never video setlists", async () => {
  const paths = [];
  const payloads = new Map([
    [
      "data/ui/ranges/7d/sources/aa/song/manifest.json",
      {
        kind: "source-detail-manifest-v3",
        chunks: [
          { index: 2, path: "data/ui/ranges/7d/sources/aa/song/chunk-0002.hash.json" },
          { index: 1, path: "data/ui/ranges/7d/sources/aa/song/chunk-0001.hash.json" },
        ],
      },
    ],
    [
      "data/ui/ranges/7d/sources/aa/song/chunk-0001.hash.json",
      { kind: "source-detail-chunk-v3", sources: [source("AAAAAAAAAAA", 10)] },
    ],
    [
      "data/ui/ranges/7d/sources/aa/song/chunk-0002.hash.json",
      { kind: "source-detail-chunk-v3", sources: [source("BBBBBBBBBBB", 20)] },
    ],
  ]);
  const chunkProgress = [];
  const occurrences = await SourceDetailRuntime.loadSourceDetailOccurrences("data/ui/ranges/7d/sources/aa/song/manifest.json", {
    readJson: async (requestPath) => {
      paths.push(requestPath);
      return payloads.get(requestPath);
    },
    onChunk: (_chunk, progress) => chunkProgress.push(progress.index),
  });

  assert.deepEqual(paths, [
    "data/ui/ranges/7d/sources/aa/song/manifest.json",
    "data/ui/ranges/7d/sources/aa/song/chunk-0001.hash.json",
    "data/ui/ranges/7d/sources/aa/song/chunk-0002.hash.json",
  ]);
  assert.equal(paths.some((requestPath) => requestPath.includes("video-setlists")), false);
  assert.deepEqual(chunkProgress, [1, 2]);
  assert.deepEqual(occurrences.map((occurrence) => occurrence.item.videoId), ["AAAAAAAAAAA", "BBBBBBBBBBB"]);
});

test("legacy full and remainder source detail shards stay readable", () => {
  const full = SourceDetailRuntime.normalizeSourceDetailOccurrences({
    records: [
      { key: "other", occurrences: [legacyOccurrence("XXXXXXXXXXX")] },
      { key: "song-key", occurrences: [legacyOccurrence("CCCCCCCCCCC")] },
    ],
  }, "song-key");
  const remainder = SourceDetailRuntime.normalizeSourceDetailOccurrences({
    records: [{ key: "song-key", occurrences: [legacyOccurrence("DDDDDDDDDDD")] }],
  }, "song-key");

  assert.deepEqual(full.map((occurrence) => occurrence.item.videoId), ["CCCCCCCCCCC"]);
  assert.deepEqual(remainder.map((occurrence) => occurrence.item.videoId), ["DDDDDDDDDDD"]);
});

test("drawer opens with preview state and virtual windows cap rendered source rows", () => {
  assert.deepEqual(SourceDetailRuntime.drawerInitialState({ previewCount: 2, totalCount: 131 }), {
    state: "loading",
    previewCount: 2,
    loadedCount: 2,
    totalCount: 131,
    label: "已加载 2 / 131 · 正在加载来源",
  });

  const windowState = SourceDetailRuntime.virtualWindow({
    total: 131,
    start: 48,
    windowSize: 32,
    overscan: 4,
    rowHeight: 88,
  });
  assert.equal(windowState.count <= 40, true);
  assert.equal(windowState.beforeHeight, 44 * 88);
  assert.equal(windowState.afterHeight, (131 - 84) * 88);
});

test("video setlist loader requests on demand and returns cache hits", async () => {
  const requested = [];
  const loader = SourceDetailRuntime.createVideoSetlistLoader({
    readJson: async (requestPath) => {
      requested.push(requestPath);
      return {
        videoId: "EEEEEEEEEEE",
        title: "Setlist",
        channelName: "Channel",
        songs: [
          { seconds: 30, title: "Second", artist: "Artist" },
          { seconds: 5, title: "First", artist: "Artist" },
        ],
      };
    },
  });

  assert.equal(requested.length, 0);
  const first = await loader({ videoId: "EEEEEEEEEEE" });
  const second = await loader({ videoId: "EEEEEEEEEEE" });
  assert.equal(first, second);
  assert.deepEqual(requested, ["data/ui/video-setlists/EE/EEEEEEEEEEE.json"]);
  assert.deepEqual(first.songs.map((song) => song.title), ["First", "Second"]);
});

test("app source wires abort, retry, incremental hydration, and deferred setlists", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "assets", "app.js"), "utf8");

  assert.match(appSource, /function startSourceDetailHydration/u);
  assert.match(appSource, /new AbortController\(\)/u);
  assert.match(appSource, /abortSourceDetailHydration\(row\)/u);
  assert.match(appSource, /data-source-detail-retry/u);
  assert.match(appSource, /loadVideoSetlist\(videoId, item\)/u);
  assert.match(appSource, /state\.videoSetlistCache/u);
});

function source(videoId, seconds) {
  return {
    videoId,
    channelName: "Channel",
    videoTitle: `Video ${videoId}`,
    publishedTimestamp: Date.parse("2026-07-17T00:00:00Z"),
    firstSeenAt: "2026-07-16T00:00:00Z",
    timepoints: [{ seconds, title: "Song", artist: "Artist" }],
  };
}

function legacyOccurrence(videoId) {
  return {
    item: { videoId, title: `Video ${videoId}`, channelName: "Channel" },
    song: { seconds: 10, title: "Song", artist: "Artist" },
  };
}
