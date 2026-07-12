const assert = require("node:assert/strict");
const test = require("node:test");

process.env.DAILY_SONG_VIDEO_LIMIT = "10";
process.env.DAILY_SONG_RECENT_BUCKET_LIMIT = "2";
process.env.DAILY_SONG_MONTH_REFRESH_LIMIT = "1";
process.env.DAILY_SONG_MONTH_BACKFILL_TARGET = "20";
process.env.DAILY_SONG_MONTH_BACKFILL_RECENT_BUCKET_LIMIT = "1";
process.env.DAILY_SONG_429_COOLDOWN_MS = "9000";

const {
  buildGroups,
  buildRankDiffs,
  collectCarryForwardVideos,
  createRequestLimiter,
  filterArtistRichMixedSourceSongs,
  isBlockedSource,
  mergeFetchedAndCarriedVideos,
  parseRetryAfterMs,
  retryDelayMs,
  selectCandidatesForInspection,
  TAIWAN_VTUBER_BLACKLIST,
} = require("../scripts/update-songlist");

const NOW = new Date("2026-07-11T13:00:00Z");
const TODAY_SEARCH_URL = "https://www.youtube.com/results?search_query=%E6%AD%8C%E6%9E%A0&sp=CAMSBAgCGAI%253D";
const MONTH_SEARCH_URL = "https://www.youtube.com/results?search_query=%E6%AD%8C%E6%9E%A0&sp=CAMSBggEEAEYAg%253D%253D";
const SOURCE_URLS = {
  today: TODAY_SEARCH_URL,
  month: MONTH_SEARCH_URL,
};

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
          video("GGGGGGGGGGG", 24, ["today"]),
          video("HHHHHHHHHHH", 24, ["month"], { sourceUrls: [TODAY_SEARCH_URL] }),
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
  assert.equal(carry.skipVideoIds.has("GGGGGGGGGGG"), false);
  assert.equal(carry.skipVideoIds.has("HHHHHHHHHHH"), false);
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

test("artist-rich mixed sources drop title-only rows without rejecting pure title-only lists", () => {
  const artistRows = Array.from({ length: 8 }, (_, index) => ({
    title: `Song ${index + 1}`,
    artist: `Artist ${index + 1}`,
    time: `0:${String(index + 1).padStart(2, "0")}:00`,
    seconds: 60 * (index + 1),
    raw: `${index + 1}:00 Song ${index + 1} / Artist ${index + 1}`,
  }));
  const mixed = filterArtistRichMixedSourceSongs([
    {
      title: "「君とのメモリー 更新中～」",
      artist: "未記載",
      time: "0:03:46",
      seconds: 226,
      raw: "03:46 「君とのメモリー 更新中～」",
    },
    {
      title: "222人に目標変更",
      artist: "未記載",
      time: "3:31:11",
      seconds: 12671,
      raw: "03:31:11 222人に目標変更",
    },
    ...artistRows,
  ]);

  assert.deepEqual(
    mixed.songs.map((song) => song.title),
    artistRows.map((song) => song.title),
  );
  assert.deepEqual(
    mixed.rejectedEntries.map((entry) => entry.reason),
    ["artist_rich_source_title_only_entry", "artist_rich_source_title_only_entry"],
  );

  const titleOnly = filterArtistRichMixedSourceSongs([
    { title: "タッチ", artist: "未記載" },
    { title: "ラムのラブソング", artist: "未記載" },
    { title: "ジェミニ", artist: "未記載" },
  ]);
  assert.deepEqual(
    titleOnly.songs.map((song) => song.title),
    ["タッチ", "ラムのラブソング", "ジェミニ"],
  );
  assert.deepEqual(titleOnly.rejectedEntries, []);
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

test("low monthly carry-forward prioritizes monthly backfill within the inspection budget", () => {
  const candidates = [
    candidate("AAAAAAAAAAA", 2, ["today"]),
    candidate("BBBBBBBBBBB", 3, ["today"]),
    candidate("CCCCCCCCCCC", 26, ["today"]),
    candidate("DDDDDDDDDDD", 27, ["today"]),
    candidate("EEEEEEEEEEE", 24 * 4, ["month"]),
    candidate("FFFFFFFFFFF", 24 * 5, ["month"]),
    candidate("GGGGGGGGGGG", 24 * 6, ["month"]),
    candidate("HHHHHHHHHHH", 24 * 7, ["month"]),
    candidate("IIIIIIIIIII", 24 * 8, ["month"]),
    candidate("JJJJJJJJJJJ", 24 * 9, ["month"]),
    candidate("KKKKKKKKKKK", 24 * 10, ["month"]),
    candidate("LLLLLLLLLLL", 24 * 11, ["month"]),
    candidate("MMMMMMMMMMM", 24 * 12, ["month"]),
    candidate("NNNNNNNNNNN", 24 * 13, ["month"]),
  ];
  const selection = selectCandidatesForInspection(candidates, NOW, {
    carryForwardEnabled: true,
    carriedMonthVideoCount: 1,
  });

  assert.equal(selection.mode, "incremental_month_backfill_with_carry_forward");
  assert.equal(selection.monthBackfillEnabled, true);
  assert.equal(selection.monthBackfillRecentBucketLimit, 1);
  assert.deepEqual(
    selection.items.map((item) => item.videoId),
    [
      "AAAAAAAAAAA",
      "CCCCCCCCCCC",
      "EEEEEEEEEEE",
      "FFFFFFFFFFF",
      "GGGGGGGGGGG",
      "HHHHHHHHHHH",
      "IIIIIIIIIII",
      "JJJJJJJJJJJ",
      "KKKKKKKKKKK",
      "LLLLLLLLLLL",
    ],
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

test("monthly group only includes monthly-source videos within the carry-forward window", () => {
  const groups = buildGroups(
    [
      video("AAAAAAAAAAA", 2, ["today"]),
      video("BBBBBBBBBBB", 24 * 10, ["month"]),
      video("CCCCCCCCCCC", 24 * 40, ["today"]),
      video("DDDDDDDDDDD", 3, ["today", "month"]),
      video("EEEEEEEEEEE", 24 * 40, ["month"]),
      video("FFFFFFFFFFF", 4, ["today", "month"], { sourceUrls: [TODAY_SEARCH_URL] }),
    ],
    NOW,
  );

  assert.deepEqual(
    groups["72h"].items.map((item) => item.videoId),
    ["AAAAAAAAAAA", "DDDDDDDDDDD", "FFFFFFFFFFF"],
  );
  assert.deepEqual(
    groups["1m"].items.map((item) => item.videoId),
    ["DDDDDDDDDDD", "BBBBBBBBBBB"],
  );
});

test("rank diffs compare current ranks and counts to previous snapshot", () => {
  const previous = payloadWithItems({
    "72h": [
      rankedItem("AAAAAAAAAAA", [...repeatedSongs("Alpha", "Artist A", 3)]),
      rankedItem("BBBBBBBBBBB", [...repeatedSongs("Beta", "Artist B", 2)]),
    ],
    "1m": [],
  });
  const current = payloadWithItems({
    "72h": [
      rankedItem("CCCCCCCCCCC", [...repeatedSongs("Beta", "Artist B", 4)]),
      rankedItem("DDDDDDDDDDD", [...repeatedSongs("Alpha", "Artist A", 2)]),
      rankedItem("EEEEEEEEEEE", [song("Fresh", "Artist C")]),
    ],
    "1m": [],
  });

  const diff = buildRankDiffs(current, {
    entry: { id: "20260711T120000Z", path: "data/snapshots/20260711T120000Z.json" },
    payload: previous,
  })["72h"];

  assert.equal(diff.previous.snapshotId, "20260711T120000Z");
  assertRankDiff(diff.songRank, "Beta", {
    previousRank: 2,
    currentRank: 1,
    rankDelta: 1,
    previousCount: 2,
    currentCount: 4,
    countDelta: 2,
    isNew: false,
  });
  assertRankDiff(diff.songRank, "Alpha", {
    previousRank: 1,
    currentRank: 2,
    rankDelta: -1,
    previousCount: 3,
    currentCount: 2,
    countDelta: -1,
    isNew: false,
  });
  assertRankDiff(diff.songRank, "Fresh", {
    previousRank: null,
    currentRank: 3,
    rankDelta: null,
    previousCount: 0,
    currentCount: 1,
    countDelta: 1,
    isNew: true,
  });
  assertRankDiff(diff.artistRank, "Artist B", {
    previousRank: 2,
    currentRank: 1,
    rankDelta: 1,
    previousCount: 2,
    currentCount: 4,
    countDelta: 2,
    isNew: false,
  });
});

test("rank diffs use stable new-entry fields without previous snapshot", () => {
  const current = payloadWithItems({
    "72h": [rankedItem("AAAAAAAAAAA", [song("Fresh", "Artist A")])],
    "1m": [rankedItem("BBBBBBBBBBB", [song("Monthly Fresh", "Artist B")])],
  });

  const diffs = buildRankDiffs(current, null);

  assert.equal(diffs["72h"].previous, null);
  assertRankDiff(diffs["72h"].songRank, "Fresh", {
    previousRank: null,
    currentRank: 1,
    rankDelta: null,
    previousCount: 0,
    currentCount: 1,
    countDelta: 1,
    isNew: true,
  });
  assertRankDiff(diffs["1m"].artistRank, "Artist B", {
    previousRank: null,
    currentRank: 1,
    rankDelta: null,
    previousCount: 0,
    currentCount: 1,
    countDelta: 1,
    isNew: true,
  });
});

test("rank diffs preserve competition ranking for tied counts", () => {
  const current = payloadWithItems({
    "72h": [
      rankedItem("AAAAAAAAAAA", [...repeatedSongs("Alpha", "Artist A", 3)]),
      rankedItem("BBBBBBBBBBB", [...repeatedSongs("Beta", "Artist B", 2)]),
      rankedItem("CCCCCCCCCCC", [...repeatedSongs("Gamma", "Artist C", 2)]),
      rankedItem("DDDDDDDDDDD", [song("Delta", "Artist D")]),
    ],
    "1m": [],
  });

  const diff = buildRankDiffs(current, null)["72h"];

  assert.equal(rankDiffByLabel(diff.songRank, "Alpha").currentRank, 1);
  assert.equal(rankDiffByLabel(diff.songRank, "Beta").currentRank, 2);
  assert.equal(rankDiffByLabel(diff.songRank, "Gamma").currentRank, 2);
  assert.equal(rankDiffByLabel(diff.songRank, "Delta").currentRank, 4);
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
    sourceUrls: sourceGroups.map((groupId) => SOURCE_URLS[groupId]).filter(Boolean),
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

function song(title, artist = "artist", overrides = {}) {
  return {
    title,
    artist,
    seconds: 60,
    time: "0:01:00",
    ...overrides,
  };
}

function repeatedSongs(title, artist, count) {
  return Array.from({ length: count }, () => song(title, artist));
}

function rankedItem(videoId, songs) {
  return {
    ...candidate(videoId, 1, ["today"]),
    publishedText: "1 hour ago",
    songs,
  };
}

function payloadWithItems(groups) {
  return {
    schemaVersion: 1,
    generatedAt: NOW.toISOString(),
    capturedAt: NOW.toISOString(),
    groups: {
      "72h": group("72h", groups["72h"] || []),
      "1m": group("1m", groups["1m"] || []),
    },
  };
}

function group(id, items) {
  return {
    id,
    title: id,
    generatedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    items,
  };
}

function rankDiffByLabel(entries, label) {
  const entry = entries.find((item) => item.label === label);
  assert.ok(entry, `Expected rank diff entry for ${label}`);
  return entry;
}

function assertRankDiff(entries, label, expected) {
  const entry = rankDiffByLabel(entries, label);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(entry[key], value, `${label}.${key}`);
  }
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
