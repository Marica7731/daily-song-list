const assert = require("node:assert/strict");
const test = require("node:test");

process.env.DAILY_SONG_VIDEO_LIMIT = "10";
process.env.DAILY_SONG_RECENT_BUCKET_LIMIT = "2";
process.env.DAILY_SONG_MONTH_REFRESH_LIMIT = "1";
process.env.DAILY_SONG_429_COOLDOWN_MS = "9000";

const {
  buildGroups,
  collectCarryForwardVideos,
  createRequestLimiter,
  isBlockedSource,
  mergeFetchedAndCarriedVideos,
  parseRetryAfterMs,
  retryDelayMs,
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

test("dirty carried videos are normalized but left eligible for refresh", () => {
  const previous = {
    generatedAt: "2026-07-11T12:00:00Z",
    groups: {
      "72h": {
        items: [
          {
            ...video("AAAAAAAAAAA", 2, ["today"]),
            songs: [
              { title: "_hotsmile", artist: "", seconds: 10, time: "0:00:10", raw: "0:10 :_hotsmile:" },
              { title: "ぷくっ", artist: "未記載", seconds: 20, time: "0:00:20", raw: "0:20 :_可愛い:ぷくっ" },
              { title: "あくび", artist: "未記載", seconds: 30, time: "0:00:30", raw: "0:30 :_可愛い:あくび" },
              { title: "あくび🥱‪‪‬ᐝ", artist: "未記載", seconds: 35, time: "0:00:35", raw: "0:35 あくび🥱‪‪‬ᐝ" },
              { title: "ふんっ", artist: "ぷくっ", seconds: 40, time: "0:00:40", raw: "0:40 :_可愛い:ふんっ（ぷくっ）" },
              { title: "もうちょっと普通の時も", artist: "ぷくっ", seconds: 45, time: "0:00:45", raw: "0:45 もうちょっと普通の時も（ぷくっ）" },
              {
                title: "勝利のマシンロボ",
                artist: "マシンロボクロノスの大逆襲OP(キー+4)",
                seconds: 60,
                time: "0:01:00",
                raw: "1:00 勝利のマシンロボ/マシンロボクロノスの大逆襲OP(キー+4)",
              },
            ],
          },
        ],
      },
      "1m": { items: [] },
    },
  };

  const carry = collectCarryForwardVideos(previous, { videos: [] }, NOW);

  assert.equal(carry.enabled, true);
  assert.equal(carry.videos.length, 1);
  assert.equal(carry.videos[0].needsRefreshFromDirtyCarryForward, true);
  assert.equal(carry.videos[0].songs.length, 1);
  assert.equal(carry.videos[0].songs[0].artist, "未記載");
  assert.equal(carry.skipVideoIds.has("AAAAAAAAAAA"), false);
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

test("monthly group includes recent videos found through the 72h search", () => {
  const groups = buildGroups(
    [
      video("AAAAAAAAAAA", 2, ["today"]),
      video("BBBBBBBBBBB", 24 * 10, ["month"]),
      video("CCCCCCCCCCC", 24 * 40, ["today"]),
    ],
    NOW,
  );

  assert.deepEqual(
    groups["72h"].items.map((item) => item.videoId),
    ["AAAAAAAAAAA"],
  );
  assert.deepEqual(
    groups["1m"].items.map((item) => item.videoId),
    ["AAAAAAAAAAA", "BBBBBBBBBBB"],
  );
});

test("Taiwan VTuber blacklist matches named channels without relying on song title text", () => {
  assert.equal(TAIWAN_VTUBER_BLACKLIST.some((entry) => entry.name === "羽芝扉扉"), true);
  assert.equal(TAIWAN_VTUBER_BLACKLIST.some((entry) => entry.name === "厄倫蒂兒"), true);
  assert.equal(TAIWAN_VTUBER_BLACKLIST.some((entry) => entry.name === "綽貓喵"), true);
  assert.equal(isBlockedSource({ channelName: "羽芝扉扉Uchi Fifi", title: "歌枠" }), true);
  assert.equal(isBlockedSource({ channelName: "Earendel ch. 厄倫蒂兒", title: "Karaoke" }), true);
  assert.equal(isBlockedSource({ channelName: "CheukCat Ch. 綽貓喵", title: "歌雜 / HKVtuber" }), true);
  assert.equal(isBlockedSource({ channelName: "AZKi Channel", title: "厄倫蒂兒 cover setlist" }), false);
  assert.equal(isBlockedSource({ channelName: "AZKi Channel", title: "奔跑日記！ / 米亞 MYA" }), false);
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

test("Retry-After parsing supports seconds and HTTP dates", () => {
  const nowMs = Date.parse("2026-07-12T00:00:00Z");

  assert.equal(parseRetryAfterMs("2.5", nowMs), 2500);
  assert.equal(parseRetryAfterMs("Sun, 12 Jul 2026 00:00:05 GMT", nowMs), 5000);
  assert.equal(parseRetryAfterMs("bad", nowMs), 0);
});

test("429 retry delay honors cooldown and Retry-After headers", () => {
  const nowMs = Date.parse("2026-07-12T00:00:00Z");

  assert.equal(retryDelayMs(response(429, "2"), 1, nowMs), 9000);
  assert.equal(retryDelayMs(response(503, "Sun, 12 Jul 2026 00:00:05 GMT"), 1, nowMs), 5000);
  assert.equal(retryDelayMs(response(500, ""), 2, nowMs), 3000);
});

test("request limiter tracks request spacing, cooldowns, and 429 budget", async () => {
  const limiter = createRequestLimiter({ requestDelayMs: 1000, max429Errors: 2 });
  let nowMs = 1000;

  await limiter.beforeRequest(() => nowMs);
  assert.equal(limiter.nextRequestAt, 2000);

  limiter.cooldown(5000, () => nowMs);
  assert.equal(limiter.cooldownUntil, 6000);

  limiter.note429();
  assert.equal(limiter.shouldStop(), false);
  limiter.note429();
  assert.equal(limiter.shouldStop(), true);
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

function response(status, retryAfter) {
  return {
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === "retry-after" ? retryAfter : "";
      },
    },
  };
}
