const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MONTH_CATALOG_DAYS,
  catalogSummary,
  catalogToVideos,
  createEmptyVideoCatalog,
  mergeVideosIntoCatalog,
  rebuildVideoCatalogFromVideos,
} = require("../scripts/video-catalog");

const NOW = new Date("2026-07-13T13:00:00Z");

test("video catalog keeps one usable entry per video within 35 days", () => {
  const result = rebuildVideoCatalogFromVideos(
    [
      video("AAAAAAAAAAA", 2, "new song"),
      video("AAAAAAAAAAA", 3, "older duplicate"),
      video("BBBBBBBBBBB", 24 * 34, "month song"),
      video("CCCCCCCCCCC", 24 * 36, "expired song"),
      { ...video("DDDDDDDDDDD", 1, ""), songs: [] },
    ],
    NOW,
    { curationVersion: "curation-v1:test" },
  );

  assert.equal(result.catalog.retentionDays, MONTH_CATALOG_DAYS);
  assert.deepEqual(
    result.catalog.videos.map((entry) => entry.videoId),
    ["AAAAAAAAAAA", "BBBBBBBBBBB"],
  );
  assert.equal(result.catalog.videos[0].songs[0].title, "new song");
  assert.equal(result.stats.expiredVideoCount, 1);
  assert.equal(result.stats.skippedInvalidVideoCount, 1);
});

test("video catalog merge preserves firstSeenAt while replacing refreshed songs", () => {
  const previous = {
    ...createEmptyVideoCatalog("2026-07-12T00:00:00Z"),
    videos: [
      {
        videoId: "AAAAAAAAAAA",
        title: "old video",
        channelName: "channel",
        channelId: "",
        channelHandle: "",
        publishedTimestamp: NOW.getTime() - 2 * 60 * 60 * 1000,
        firstSeenAt: "2026-07-12T01:00:00Z",
        lastSeenAt: "2026-07-12T01:00:00Z",
        lastInspectedAt: "2026-07-12T01:00:00Z",
        discoveryGroups: ["today"],
        sourceUrls: ["today-url"],
        selectedSourceId: "old",
        selectedSourceHash: "old-hash",
        songs: [song("old song")],
        curationVersion: "curation-v1:old",
        curationHash: "",
        qualityStatus: "usable",
      },
    ],
  };

  const result = mergeVideosIntoCatalog(previous, [video("AAAAAAAAAAA", 1, "fresh song")], NOW, {
    curationVersion: "curation-v1:new",
  });
  const [entry] = result.catalog.videos;

  assert.equal(entry.firstSeenAt, "2026-07-12T01:00:00Z");
  assert.equal(entry.lastSeenAt, NOW.toISOString());
  assert.equal(entry.songs[0].title, "fresh song");
  assert.equal(entry.curationVersion, "curation-v1:new");
  assert.equal(catalogToVideos(result.catalog)[0].songs[0].index, 1);
});

test("video catalog summary reports month coverage", () => {
  const result = rebuildVideoCatalogFromVideos([video("AAAAAAAAAAA", 2, "song")], NOW);
  const summary = catalogSummary(result.catalog, NOW);

  assert.equal(summary.path, "data/video-catalog.json");
  assert.equal(summary.catalogVideoCount, 1);
  assert.equal(summary.monthVideoCount, 1);
});

function video(videoId, hoursAgo, title) {
  return {
    videoId,
    title: `video ${videoId}`,
    channelName: "channel",
    channelId: "",
    channelHandle: "",
    publishedTimestamp: NOW.getTime() - hoursAgo * 60 * 60 * 1000,
    sourceGroups: ["today"],
    sourceUrls: ["today-url"],
    selectedSourceId: "source",
    selectedSourceHash: "hash",
    songs: title ? [song(title)] : [],
  };
}

function song(title) {
  return {
    index: 1,
    seconds: 60,
    time: "0:01:00",
    title,
    artist: "artist",
  };
}
