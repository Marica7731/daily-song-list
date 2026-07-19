const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  filterNonRegressiveImports,
  inputDirsFromArgs,
  isStrictSongSubset,
  normalizeImportedVideo,
  readDiscoveryVideos,
} = require("../scripts/import-channel-discovery");

test("input dirs accept repeated CLI values and positional fallback", () => {
  const first = path.resolve("artifacts/channel-discovery/a");
  const second = path.resolve("artifacts/channel-discovery/b");
  assert.deepEqual(inputDirsFromArgs({ "input-dir": ["artifacts/channel-discovery/a", "artifacts/channel-discovery/b"] }), [first, second]);
  assert.deepEqual(inputDirsFromArgs({ _: ["artifacts/channel-discovery/a"] }), [first]);
});

test("channel discovery import reads usable details and preserves provenance", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-discovery-import-"));
  fs.writeFileSync(
    path.join(dir, "video-details.json"),
    JSON.stringify([
      {
        videoId: "AAAAAAAAAAA",
        title: "歌枠",
        channelName: "Noa",
        channelId: "UC_NOA",
        channelHandle: "/@noa_polaris",
        publishedTimestamp: Date.parse("2026-07-18T00:00:00Z"),
        discoverySourceUrls: ["https://www.youtube.com/@noa_polaris/streams"],
        discoverySingerName: "Noa",
        discoveryChannelUrl: "https://www.youtube.com/@noa_polaris",
        selectedSourceId: "comment:1",
        selectedSourceHash: "hash-1",
        matchedKeywords: ["歌"],
        songs: [
          {
            time: "12:34",
            seconds: 754,
            title: "少女レイ",
            artist: "みきとP",
            raw: "12:34 少女レイ / みきとP",
            rawHash: "raw-1",
            sourceId: "comment:1",
            sourceHash: "hash-1",
          },
        ],
      },
      { videoId: "BBBBBBBBBBB", title: "empty", songs: [] },
      { videoId: "not-valid", title: "bad", songs: [{ title: "x" }] },
    ]),
    "utf8",
  );

  const { videos, stats } = readDiscoveryVideos([dir]);
  assert.equal(videos.length, 1);
  assert.equal(stats.videoDetails, 3);
  assert.equal(stats.usableVideos, 1);
  assert.equal(stats.skippedNoSongs, 1);
  assert.equal(stats.skippedInvalidVideoId, 1);
  assert.equal(stats.songs, 1);
  assert.equal(videos[0].sourceGroups.includes("youtube_channel_discovery"), true);
  assert.equal(videos[0].sourceUrls.includes("https://www.youtube.com/@noa_polaris/streams"), true);
  assert.equal(videos[0].sourceUrls.includes("https://www.youtube.com/watch?v=AAAAAAAAAAA"), true);
  assert.equal(videos[0].songs[0].sourceId, "comment:1");
});

test("normalizeImportedVideo maps detail song fields into catalog-ready videos", () => {
  const video = normalizeImportedVideo(
    {
      videoId: "CCCCCCCCCCC",
      title: "弾き語り",
      sourceGroups: ["month"],
      sourceUrls: ["https://example.test/source"],
      songs: [{ seconds: 1, title: "Song", artist: "Artist", isNiche: true }],
    },
    "input-dir",
    [{ seconds: 1, title: "Song", artist: "Artist", isNiche: true }],
  );
  assert.equal(video.videoId, "CCCCCCCCCCC");
  assert.deepEqual(video.sourceGroups.sort(), ["month", "youtube_channel_discovery"]);
  assert.equal(video.songs[0].index, 1);
  assert.equal(video.songs[0].isNiche, true);
  assert.equal(video.qualityStatus, "usable");
});

test("import skips duplicate videos that would replace a richer existing song list", () => {
  assert.equal(
    isStrictSongSubset(
      [
        { seconds: 10, title: "Song A", artist: "Artist" },
        { seconds: 20, title: "Song B", artist: "Artist" },
      ],
      [{ seconds: 10, title: "Song A", artist: "Artist" }],
    ),
    true,
  );
  assert.equal(isStrictSongSubset([{ seconds: 10, title: "Song A", artist: "Artist" }], [{ seconds: 10, title: "Song A", artist: "Artist" }]), false);
  const result = filterNonRegressiveImports(
    {
      videos: [
        {
          videoId: "AAAAAAAAAAA",
          songs: [
            { seconds: 10, title: "Song A", artist: "Artist" },
            { seconds: 20, title: "Song B", artist: "Artist" },
          ],
        },
      ],
    },
    [
      { videoId: "AAAAAAAAAAA", songs: [{ seconds: 10, title: "Song A", artist: "Artist" }] },
      { videoId: "BBBBBBBBBBB", songs: [{ seconds: 30, title: "Song C", artist: "Artist" }] },
    ],
  );
  assert.deepEqual(result.videos.map((video) => video.videoId), ["BBBBBBBBBBB"]);
  assert.equal(result.stats.skippedExistingRegressions, 1);
  assert.deepEqual(result.stats.skippedExistingRegressionVideoIds, ["AAAAAAAAAAA"]);
});
