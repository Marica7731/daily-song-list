const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CATALOG_RETENTION_POLICY,
  buildCatalogSegments,
  catalogSummary,
  catalogToVideos,
  createEmptyVideoCatalog,
  mergeVideosIntoCatalog,
  rebuildVideoCatalogFromVideos,
} = require("../scripts/video-catalog");

const NOW = new Date("2026-07-13T13:00:00Z");

test("video catalog keeps one usable entry per video permanently", () => {
  const result = rebuildVideoCatalogFromVideos(
    [
      video("AAAAAAAAAAA", 2, "new song"),
      video("AAAAAAAAAAA", 3, "older duplicate"),
      video("BBBBBBBBBBB", 24 * 34, "month song"),
      video("CCCCCCCCCCC", 24 * 36, "older song"),
      { ...video("DDDDDDDDDDD", 1, ""), songs: [] },
    ],
    NOW,
    { curationVersion: "curation-v1:test" },
  );

  assert.equal(result.catalog.retentionPolicy, CATALOG_RETENTION_POLICY);
  assert.equal(result.catalog.retentionDays, null);
  assert.deepEqual(
    result.catalog.videos.map((entry) => entry.videoId),
    ["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC"],
  );
  assert.equal(result.catalog.videos[0].songs[0].title, "new song");
  assert.equal(result.stats.expiredVideoCount, 0);
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

test("video catalog preserves previous songs when a refreshed video loses a strict subset", () => {
  const previous = {
    ...createEmptyVideoCatalog("2026-07-12T00:00:00Z"),
    videos: [
      {
        ...video("AAAAAAAAAAA", 2, "old song"),
        firstSeenAt: "2026-07-12T01:00:00Z",
        lastSeenAt: "2026-07-12T01:00:00Z",
        lastInspectedAt: "2026-07-12T01:00:00Z",
        songs: [songAt("星間飛行", 950), songAt("KICK BACK", 1166)],
        curationVersion: "curation-v1:old",
        qualityStatus: "usable",
      },
    ],
  };

  const result = mergeVideosIntoCatalog(
    previous,
    [
      {
        ...video("AAAAAAAAAAA", 1, "星間飛行"),
        songs: [songAt("星間飛行", 950)],
      },
    ],
    NOW,
    { curationVersion: "curation-v1:new" },
  );
  const [entry] = result.catalog.videos;

  assert.deepEqual(
    entry.songs.map((item) => item.title),
    ["星間飛行", "KICK BACK"],
  );
  assert.equal(entry.qualityStatus, "usable");
  assert.equal(entry.regressionAudit.reason, "incoming_strict_song_subset");
  assert.equal(entry.regressionAudit.previousSongCount, 2);
  assert.equal(entry.regressionAudit.incomingSongCount, 1);
});

test("video catalog preserves previous songs when a refreshed video has no usable timestamps", () => {
  const previous = {
    ...createEmptyVideoCatalog("2026-07-12T00:00:00Z"),
    videos: [
      {
        ...video("AAAAAAAAAAA", 2, "old song"),
        firstSeenAt: "2026-07-12T01:00:00Z",
        lastSeenAt: "2026-07-12T01:00:00Z",
        lastInspectedAt: "2026-07-12T01:00:00Z",
        songs: [songAt("星間飛行", 950)],
        curationVersion: "curation-v1:old",
        qualityStatus: "usable",
      },
    ],
  };

  const result = mergeVideosIntoCatalog(previous, [{ ...video("AAAAAAAAAAA", 1, ""), songs: [] }], NOW, {
    curationVersion: "curation-v1:new",
  });
  const [entry] = result.catalog.videos;

  assert.deepEqual(
    entry.songs.map((item) => item.title),
    ["星間飛行"],
  );
  assert.equal(entry.qualityStatus, "usable");
  assert.equal(entry.regressionAudit.reason, "incoming_empty_song_set");
  assert.equal(entry.regressionAudit.previousSongCount, 1);
  assert.equal(entry.regressionAudit.incomingSongCount, 0);
});

test("video catalog accepts refreshed song supersets", () => {
  const previous = {
    ...createEmptyVideoCatalog("2026-07-12T00:00:00Z"),
    videos: [
      {
        ...video("AAAAAAAAAAA", 2, "old song"),
        firstSeenAt: "2026-07-12T01:00:00Z",
        lastSeenAt: "2026-07-12T01:00:00Z",
        lastInspectedAt: "2026-07-12T01:00:00Z",
        songs: [songAt("星間飛行", 950)],
        curationVersion: "curation-v1:old",
        qualityStatus: "usable",
      },
    ],
  };

  const result = mergeVideosIntoCatalog(
    previous,
    [
      {
        ...video("AAAAAAAAAAA", 1, "星間飛行"),
        songs: [songAt("星間飛行", 950), songAt("KICK BACK", 1166)],
      },
    ],
    NOW,
    { curationVersion: "curation-v1:new" },
  );
  const [entry] = result.catalog.videos;

  assert.deepEqual(
    entry.songs.map((item) => item.title),
    ["星間飛行", "KICK BACK"],
  );
  assert.equal(entry.qualityStatus, "usable");
  assert.equal(entry.regressionAudit.reason, "incoming_song_superset");
  assert.equal(entry.regressionAudit.previousSongCount, 1);
  assert.equal(entry.regressionAudit.incomingSongCount, 2);
});

test("video catalog summary reports month coverage", () => {
  const result = rebuildVideoCatalogFromVideos([video("AAAAAAAAAAA", 2, "song"), video("BBBBBBBBBBB", 24 * 40, "old song")], NOW);
  const summary = catalogSummary(result.catalog, NOW);

  assert.equal(summary.path, "data/video-catalog.json");
  assert.equal(summary.retentionPolicy, CATALOG_RETENTION_POLICY);
  assert.equal(summary.catalogVideoCount, 2);
  assert.equal(summary.allVideoCount, 2);
  assert.equal(summary.monthVideoCount, 1);
});

test("video catalog segments split permanent catalog records", () => {
  const result = rebuildVideoCatalogFromVideos(
    [video("AAAAAAAAAAA", 2, "song A"), video("BBBBBBBBBBB", 3, "song B"), video("CCCCCCCCCCC", 4, "song C")],
    NOW,
  );
  const { manifest, segments } = buildCatalogSegments(result.catalog, { segmentSize: 2 });

  assert.equal(manifest.retentionPolicy, CATALOG_RETENTION_POLICY);
  assert.equal(manifest.itemCount, 3);
  assert.equal(manifest.segmentCount, 2);
  assert.deepEqual(
    manifest.segments.map((segment) => segment.itemCount),
    [2, 1],
  );
  assert.match(manifest.segments[0].path, /^data\/catalog-segments\/segment-0001\.[0-9a-f]{12}\.json$/u);
  assert.equal(segments[0].payload.videos.length, 2);
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

function songAt(title, seconds) {
  return {
    ...song(title),
    index: seconds,
    seconds,
    time: seconds === 950 ? "0:15:50" : "0:19:26",
  };
}
