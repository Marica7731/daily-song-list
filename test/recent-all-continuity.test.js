const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertRecentAllContinuity,
  validateRecentAllContinuity,
} = require("../scripts/recent-all-continuity");

function payload(allItem) {
  return {
    groups: {
      "7d": {
        items: [{
          videoId: "RECENT00001",
          title: "recent video",
          channelName: "channel",
          channelId: "UC123",
          publishedTimestamp: 100,
          songs: [{ seconds: 10, title: "Song", artist: "Artist" }],
        }],
      },
      all: { items: allItem ? [allItem] : [] },
    },
  };
}

test("recent videos and song occurrences must remain in all", () => {
  const result = validateRecentAllContinuity(payload({
    videoId: "RECENT00001",
    title: "recent video",
    channelName: "channel",
    channelId: "UC123",
    publishedTimestamp: 100,
    songs: [{ seconds: 10, title: "Song", artist: "Artist" }],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.recentVideoCount, 1);
  assert.equal(result.allVideoCount, 1);
});

test("continuity reports a missing video and missing fields", () => {
  const result = validateRecentAllContinuity(payload({
    videoId: "RECENT00001",
    title: "recent video",
    songs: [],
  }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingVideos, []);
  assert.deepEqual(result.missingSongs, ['RECENT00001:[10,"Song","Artist"]']);
  assert.deepEqual(result.missingFields, [
    "RECENT00001:channelName",
    "RECENT00001:channelId",
    "RECENT00001:publishedTimestamp",
    "RECENT00001:songs",
  ]);
});

test("continuity rejects a recent video absent from all", () => {
  assert.throws(() => assertRecentAllContinuity(payload(null)), /7d-to-all continuity failed/);
});
