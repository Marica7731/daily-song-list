const assert = require("node:assert/strict");
const test = require("node:test");

process.env.DAILY_SONG_VIDEO_LIMIT = "10";
process.env.DAILY_SONG_RECENT_BUCKET_LIMIT = "2";
process.env.DAILY_SONG_MONTH_REFRESH_LIMIT = "1";

const {
  collectCarryForwardVideos,
  mergeFetchedAndCarriedVideos,
  selectCandidatesForInspection,
} = require("../scripts/update-songlist");

const NOW = new Date("2026-07-11T13:00:00Z");

test("carries fresh previous song lists and skips previously inspected stable videos", () => {
  const previous = {
    generatedAt: "2026-07-11T12:00:00Z",
    groups: {
      "72h": {
        items: [
          video("AAAAAAAAAAA", 60, ["today"]),
          video("BBBBBBBBBBB", 80, ["today"]),
        ],
      },
      "1m": {
        items: [
          video("CCCCCCCCCCC", 24 * 10, ["month"]),
          video("DDDDDDDDDDD", 24 * 40, ["month"]),
        ],
      },
    },
  };
  const previousAudit = {
    videos: [
      { videoId: "EEEEEEEEEEE", result: "no_usable_song_source" },
      { videoId: "FFFFFFFFFFF", result: "fetch_error" },
    ],
  };

  const carry = collectCarryForwardVideos(previous, previousAudit, NOW);

  assert.equal(carry.enabled, true);
  assert.equal(carry.reason, "previous_latest_fresh");
  assert.deepEqual(
    carry.videos.map((item) => item.videoId).sort(),
    ["AAAAAAAAAAA", "CCCCCCCCCCC"],
  );
  assert.deepEqual(carry.counts, { h72: 1, month: 1 });
  assert.equal(carry.skipVideoIds.has("AAAAAAAAAAA"), true);
  assert.equal(carry.skipVideoIds.has("CCCCCCCCCCC"), true);
  assert.equal(carry.skipVideoIds.has("EEEEEEEEEEE"), true);
  assert.equal(carry.skipVideoIds.has("FFFFFFFFFFF"), false);
});

test("incremental selection skips known videos, scans 48h, and caps monthly refresh", () => {
  const candidates = [
    candidate("AAAAAAAAAAA", 2, ["today"]),
    candidate("BBBBBBBBBBB", 10, ["today"]),
    candidate("CCCCCCCCCCC", 30, ["today"]),
    candidate("DDDDDDDDDDD", 55, ["today"]),
    candidate("EEEEEEEEEEE", 24 * 9, ["month"]),
    candidate("FFFFFFFFFFF", 24 * 8, ["month"]),
  ];
  const selection = selectCandidatesForInspection(candidates, NOW, {
    carryForwardEnabled: true,
    excludeVideoIds: new Set(["AAAAAAAAAAA"]),
  });

  assert.equal(selection.mode, "incremental_48h_with_carry_forward");
  assert.equal(selection.recentScanHorizonHours, 48);
  assert.equal(selection.skippedKnownCandidateCount, 1);
  assert.deepEqual(
    selection.items.map((item) => item.videoId),
    ["BBBBBBBBBBB", "CCCCCCCCCCC", "FFFFFFFFFFF"],
  );
});

test("fetched videos win over carried videos while preserving month membership", () => {
  const fetched = [{ ...video("AAAAAAAAAAA", 3, ["today"]), songs: [song("new")] }];
  const carried = [{ ...video("AAAAAAAAAAA", 3, ["month"]), songs: [song("old")] }];

  const merged = mergeFetchedAndCarriedVideos(fetched, carried);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].songs.map((item) => item.title), ["new"]);
  assert.deepEqual(merged[0].sourceGroups.sort(), ["month", "today"]);
});

function candidate(videoId, hoursAgo, sourceGroups) {
  return {
    videoId,
    title: videoId,
    sourceGroups,
    publishedTimestamp: NOW.getTime() - hoursAgo * 60 * 60 * 1000,
  };
}

function video(videoId, hoursAgo, sourceGroups) {
  return {
    ...candidate(videoId, hoursAgo, sourceGroups),
    channelName: "channel",
    publishedText: `${hoursAgo} hours ago`,
    songs: [song("song A"), song("song B")],
  };
}

function song(title) {
  return {
    title,
    artist: "artist",
    seconds: 60,
    time: "0:01:00",
  };
}
