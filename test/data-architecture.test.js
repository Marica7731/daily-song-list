const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRuntimeRangePayload, buildSearchRecords, buildSourceDetailRecords } = require("../scripts/build-runtime-data");
const { buildCatalogSegments, rebuildVideoCatalogFromVideos } = require("../scripts/video-catalog");

const NOW = new Date("2026-07-13T13:00:00Z");

test("runtime shards and catalog segments handle thousand-video scale inputs", () => {
  const videos = Array.from({ length: 1200 }, (_, index) => video(index));
  const payload = {
    generatedAt: NOW.toISOString(),
    capturedAt: NOW.toISOString(),
    groups: {
      "1m": {
        id: "1m",
        title: "All accumulated timestamp song lists",
        generatedAt: NOW.toISOString(),
        items: videos,
      },
    },
  };

  const runtime = buildRuntimeRangePayload(payload, "all");
  const sourceDetails = buildSourceDetailRecords(videos);
  const searchRecords = buildSearchRecords(runtime.items);
  const catalog = rebuildVideoCatalogFromVideos(videos, NOW).catalog;
  const { manifest } = buildCatalogSegments(catalog, { segmentSize: 500 });

  assert.equal(runtime.id, "all");
  assert.equal(runtime.items.length, 1200);
  assert.equal(sourceDetails.length, 1200);
  assert.equal(searchRecords.length, 1200 * 4);
  assert.equal(manifest.itemCount, 1200);
  assert.equal(manifest.segmentCount, 3);
  assert.deepEqual(
    manifest.segments.map((segment) => segment.itemCount),
    [500, 500, 200],
  );
});

function video(index) {
  const videoId = `V${String(index).padStart(10, "0")}`;
  return {
    videoId,
    title: `video ${index}`,
    channelName: `channel ${index % 20}`,
    channelId: `UC${String(index).padStart(9, "0")}`,
    channelHandle: `@channel${index % 20}`,
    keyword: "歌枠",
    keywords: ["歌枠"],
    keywordKeys: ["utawaku"],
    publishedText: `${index + 1} hours ago`,
    publishedTimestamp: NOW.getTime() - (index + 1) * 60 * 60 * 1000,
    sourceGroups: ["month"],
    sourceUrls: ["https://example.test/month"],
    songs: [song(index, 0), song(index, 1), song(index, 2)],
  };
}

function song(videoIndex, songIndex) {
  return {
    index: songIndex + 1,
    time: `0:0${songIndex + 1}:00`,
    seconds: (songIndex + 1) * 60,
    title: `song ${videoIndex}-${songIndex}`,
    artist: `artist ${songIndex}`,
    isNiche: false,
  };
}
