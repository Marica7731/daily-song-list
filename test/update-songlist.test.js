const assert = require("node:assert/strict");
const test = require("node:test");

process.env.DAILY_SONG_VIDEO_LIMIT = "10";
process.env.DAILY_SONG_RECENT_BUCKET_LIMIT = "2";
process.env.DAILY_SONG_MONTH_REFRESH_LIMIT = "1";

const {
  collectCarryForwardVideos,
  isBlockedSource,
  mergeFetchedAndCarriedVideos,
  selectCandidatesForInspection,
  TAIWAN_VTUBER_BLACKLIST,
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

test("Taiwan VTuber blacklist matches named channels without relying on song title text", () => {
  assert.equal(TAIWAN_VTUBER_BLACKLIST.some((entry) => entry.name === "羽芝扉扉"), true);
  assert.equal(TAIWAN_VTUBER_BLACKLIST.some((entry) => entry.name === "厄倫蒂兒"), true);
  assert.equal(isBlockedSource({ channelName: "羽芝扉扉Uchi Fifi", title: "歌枠" }), true);
  assert.equal(isBlockedSource({ channelName: "Earendel ch. 厄倫蒂兒", title: "Karaoke" }), true);
  assert.equal(isBlockedSource({ channelName: "AZKi Channel", title: "厄倫蒂兒 cover setlist" }), false);
  assert.equal(isBlockedSource({ channelName: "AZKi Channel", title: "#厄倫蒂兒 clip" }), true);
});

test("carry-forward drops blacklisted previous videos", () => {
  const previous = {
    generatedAt: "2026-07-11T12:00:00Z",
    groups: {
      "72h": {
        items: [
          video("AAAAAAAAAAA", 3, ["today"], { channelName: "Earendel ch. 厄倫蒂兒" }),
          video("BBBBBBBBBBB", 3, ["today"], { channelName: "channel" }),
        ],
      },
      "1m": {
        items: [
          video("CCCCCCCCCCC", 24 * 10, ["month"], { channelName: "羽芝扉扉Uchi Fifi" }),
          video("DDDDDDDDDDD", 24 * 10, ["month"], { channelName: "channel" }),
        ],
      },
    },
  };

  const carry = collectCarryForwardVideos(previous, { videos: [] }, NOW);

  assert.deepEqual(
    carry.videos.map((item) => item.videoId).sort(),
    ["BBBBBBBBBBB", "DDDDDDDDDDD"],
  );
  assert.deepEqual(carry.counts, { h72: 1, month: 1 });
});

test("candidate selection and final merge filter blacklisted videos", () => {
  const candidates = [
    candidate("AAAAAAAAAAA", 2, ["today"], { channelName: "羽芝扉扉Uchi Fifi" }),
    candidate("BBBBBBBBBBB", 3, ["today"], { channelName: "channel" }),
    candidate("CCCCCCCCCCC", 24 * 8, ["month"], { channelName: "Earendel ch. 厄倫蒂兒" }),
  ];
  const selection = selectCandidatesForInspection(candidates, NOW);

  assert.equal(selection.skippedBlacklistedCandidateCount, 2);
  assert.deepEqual(
    selection.items.map((item) => item.videoId),
    ["BBBBBBBBBBB"],
  );

  const merged = mergeFetchedAndCarriedVideos(
    [video("AAAAAAAAAAA", 2, ["today"], { channelName: "羽芝扉扉Uchi Fifi" })],
    [video("BBBBBBBBBBB", 3, ["month"], { channelName: "channel" })],
  );

  assert.deepEqual(
    merged.map((item) => item.videoId),
    ["BBBBBBBBBBB"],
  );
});

function candidate(videoId, hoursAgo, sourceGroups, overrides = {}) {
  return {
    videoId,
    title: videoId,
    channelName: "channel",
    sourceGroups,
    publishedTimestamp: NOW.getTime() - hoursAgo * 60 * 60 * 1000,
    ...overrides,
  };
}

function video(videoId, hoursAgo, sourceGroups, overrides = {}) {
  return {
    ...candidate(videoId, hoursAgo, sourceGroups, overrides),
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
