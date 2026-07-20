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
  collectInspectionCacheSkipIds,
  createVideoTitleKnownSongSourceRecord,
  createRequestLimiter,
  extractSearchItems,
  extractMygitTodaySnapshotItems,
  filterArtistRichMixedSourceSongs,
  fetchMygitTodaySnapshotSource,
  hasMonthlyDiscoverySource,
  isBlockedSource,
  mergeInspectionCache,
  mergeFetchedAndCarriedVideos,
  matchKnownTitleArtistFromVideoTitle,
  parseOptionalLimit,
  parseRetryAfterMs,
  randomJitterMs,
  retryDelayMs,
  selectMygitTodaySnapshotEntries,
  selectCandidatesForInspection,
  BLOCKED_REGIONAL_VTUBER_CHANNELS,
  MYGIT_TODAY_SNAPSHOT_SOURCE_GROUP,
} = require("../scripts/update-songlist");
const { createSongSearchLookup, normalizeSongSearchText } = require("../assets/frontend-utils");
const { createSongAliasContext } = require("../scripts/song-aliases");

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
      { videoId: "EEEEEEEEEEE", result: "selected" },
      { videoId: "FFFFFFFFFFF", result: "fetch_error" },
      { videoId: "IIIIIIIIIII", result: "no_usable_song_source" },
    ],
  };

  const carry = collectCarryForwardVideos(previous, previousAudit, NOW);

  assert.equal(carry.enabled, true);
  assert.equal(carry.reason, "previous_latest_fresh");
  assert.deepEqual(
    carry.videos.map((item) => item.videoId).sort(),
    ["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC", "DDDDDDDDDDD", "GGGGGGGGGGG", "HHHHHHHHHHH"],
  );
  assert.deepEqual(carry.counts, { h72: 2, month: 4 });
  assert.equal(carry.skipVideoIds.has("AAAAAAAAAAA"), true);
  assert.equal(carry.skipVideoIds.has("BBBBBBBBBBB"), true);
  assert.equal(carry.skipVideoIds.has("CCCCCCCCCCC"), true);
  assert.equal(carry.skipVideoIds.has("DDDDDDDDDDD"), true);
  assert.equal(carry.skipVideoIds.has("GGGGGGGGGGG"), true);
  assert.equal(carry.skipVideoIds.has("HHHHHHHHHHH"), true);
  assert.equal(carry.skipVideoIds.has("EEEEEEEEEEE"), true);
  assert.equal(carry.skipVideoIds.has("FFFFFFFFFFF"), false);
  assert.equal(carry.skipVideoIds.has("IIIIIIIIIII"), false);
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

test("inspection cache skips only aged no-progress videos using real mygit published timestamps", () => {
  const realNowMs = Date.parse("2026-07-15T14:47:13Z");
  const cache = {
    videos: [
      {
        videoId: "rimdGN6BGQ8",
        title: "ウクレレ弾き語り。YouTubeライブ配信 #ウクレレ #ウクレレ弾き語り #弾き語り",
        channelName: "よしうた。",
        result: "no_usable_song_source",
        lastInspectedAt: "2026-07-15T14:45:00.000Z",
        publishedText: "56 分前 に配信済み",
        publishedTimestamp: 1784124040470,
      },
      {
        videoId: "QSaxZIHI774",
        title: "HINAZUKIのお歌",
        channelName: "HINAZUKI",
        result: "no_usable_song_source",
        lastInspectedAt: "2026-07-15T14:45:00.000Z",
        publishedText: "16 分前 に配信済み",
        publishedTimestamp: 1783952078609,
      },
      {
        videoId: "oVMq3zFoWbQ",
        title: "そろそろサムネ変えたいギター弾き語り配信",
        channelName: "ういちチャンネル",
        result: "no_timestamp_candidates",
        lastInspectedAt: "2026-07-15T14:45:00.000Z",
        publishedText: "1 時間前 に配信済み",
        publishedTimestamp: 1783897178354,
      },
      {
        videoId: "kw83Fv8eEGQ",
        title: "【歌枠✧karaoke】夕方の歌枠♪高評価１００✨よかったら聞いてって♡",
        channelName: "子鞠まゆ-KomariMayu",
        result: "fetch_error",
        lastInspectedAt: "2026-07-15T12:47:13.000Z",
        publishedTimestamp: 1784120183392,
      },
      {
        videoId: "Jpw04YF4V8o",
        title: "猫のゆるジャズ喫茶【Vtuber 歌枠】",
        channelName: "さばしろ JazzVocal",
        result: "fetch_error",
        lastInspectedAt: "2026-07-15T07:47:13.000Z",
        publishedTimestamp: 1784113333000,
      },
    ],
  };

  const skipped = collectInspectionCacheSkipIds(cache, realNowMs);

  assert.equal(skipped.has("rimdGN6BGQ8"), false, "just-ended no-usable streams stay eligible for reinspection");
  assert.equal(skipped.has("QSaxZIHI774"), true, "two-day-old no-usable streams are skipped");
  assert.equal(skipped.has("oVMq3zFoWbQ"), true, "two-day-old streams without timestamp candidates are skipped");
  assert.equal(skipped.has("kw83Fv8eEGQ"), true, "recent fetch errors get a short cooldown skip");
  assert.equal(skipped.has("Jpw04YF4V8o"), false, "fetch errors leave cooldown after the TTL");

  const carry = collectCarryForwardVideos({ generatedAt: "2026-07-15T14:40:00Z", groups: {} }, { videos: [] }, new Date(realNowMs), {
    inspectionCache: cache,
  });
  assert.equal(carry.skipVideoIds.has("rimdGN6BGQ8"), false);
  assert.equal(carry.skipVideoIds.has("QSaxZIHI774"), true);
  assert.equal(carry.skipVideoIds.has("oVMq3zFoWbQ"), true);
  assert.equal(carry.inspectionCacheSkipCount, 3);
});

test("inspection cache merge records published timestamps and removes later selected videos", () => {
  const merged = mergeInspectionCache(
    {
      videos: [
        {
          videoId: "QSaxZIHI774",
          title: "HINAZUKIのお歌",
          channelName: "HINAZUKI",
          result: "no_usable_song_source",
          firstInspectedAt: "2026-07-15T13:00:00.000Z",
          lastInspectedAt: "2026-07-15T13:00:00.000Z",
          publishedTimestamp: 1783952078609,
        },
      ],
    },
    [
      {
        videoId: "QSaxZIHI774",
        title: "HINAZUKIのお歌",
        channelName: "HINAZUKI",
        result: "selected",
        publishedTimestamp: 1783952078609,
      },
      {
        videoId: "rimdGN6BGQ8",
        title: "ウクレレ弾き語り。YouTubeライブ配信 #ウクレレ #ウクレレ弾き語り #弾き語り",
        channelName: "よしうた。",
        result: "no_usable_song_source",
        publishedText: "56 分前 に配信済み",
        publishedTimestamp: 1784124040470,
        durationText: "59:24 再生中",
        rejectedEntryCount: 3,
      },
    ],
    new Date("2026-07-15T14:47:13Z"),
  );

  assert.equal(merged.cache.videos.some((item) => item.videoId === "QSaxZIHI774"), false);
  const fresh = merged.cache.videos.find((item) => item.videoId === "rimdGN6BGQ8");
  assert.equal(fresh.publishedTimestamp, 1784124040470);
  assert.equal(fresh.publishedText, "56 分前 に配信済み");
  assert.equal(fresh.durationText, "59:24 再生中");
  assert.equal(merged.cache.noUsableMinAgeHours, 48);
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

test("incremental selection skips known videos, scans 7d, and reserves monthly refresh", () => {
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

  assert.equal(selection.mode, "incremental_7d_with_carry_forward");
  assert.equal(selection.recentScanHorizonHours, 168);
  assert.equal(selection.monthRefreshReserveLimit, 1);
  assert.equal(selection.skippedKnownCandidateCount, 1);
  assert.deepEqual(
    selection.items.map((item) => item.videoId),
    ["BBBBBBBBBBB", "CCCCCCCCCCC", "DDDDDDDDDDD", "FFFFFFFFFFF"],
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

test("mygit today snapshot index selects the latest retained snapshot per day", () => {
  const entries = selectMygitTodaySnapshotEntries(
    {
      snapshots: [
        {
          id: "20260715T140648Z",
          path: "data/today-snapshots/20260715T140648Z.json",
          capturedAt: "2026-07-15T14:06:48.000Z",
        },
        {
          id: "20260715T030000Z",
          path: "data/today-snapshots/20260715T030000Z.json",
          capturedAt: "2026-07-15T03:00:00.000Z",
        },
        {
          id: "20260714T230000Z",
          path: "data/today-snapshots/20260714T230000Z.json",
          capturedAt: "2026-07-14T23:00:00.000Z",
        },
        {
          id: "20260713T220000Z",
          path: "data/today-snapshots/20260713T220000Z.json",
          capturedAt: "2026-07-13T22:00:00.000Z",
        },
        {
          id: "20260710T220000Z",
          path: "data/today-snapshots/20260710T220000Z.json",
          capturedAt: "2026-07-10T22:00:00.000Z",
        },
      ],
    },
    new Date("2026-07-15T15:00:00Z"),
    { lookbackDays: 3, maxSnapshots: 3 },
  );

  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["20260715T140648Z", "20260714T230000Z", "20260713T220000Z"],
  );
});

test("mygit today snapshot zero limits mean unbounded", () => {
  assert.equal(parseOptionalLimit("0", 3), 0);
  assert.equal(parseOptionalLimit("", 3), 3);
  assert.equal(parseOptionalLimit("5", 3), 5);
  assert.throws(() => parseOptionalLimit("-1", 3), /Expected optional limit/u);

  const entries = selectMygitTodaySnapshotEntries(
    {
      snapshots: [
        { id: "20260715T140648Z", path: "data/today-snapshots/20260715T140648Z.json", capturedAt: "2026-07-15T14:06:48.000Z" },
        { id: "20260714T230000Z", path: "data/today-snapshots/20260714T230000Z.json", capturedAt: "2026-07-14T23:00:00.000Z" },
        { id: "20260713T220000Z", path: "data/today-snapshots/20260713T220000Z.json", capturedAt: "2026-07-13T22:00:00.000Z" },
        { id: "20260710T220000Z", path: "data/today-snapshots/20260710T220000Z.json", capturedAt: "2026-07-10T22:00:00.000Z" },
      ],
    },
    new Date("2026-07-15T15:00:00Z"),
    { lookbackDays: 0, maxSnapshots: 0 },
  );

  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["20260715T140648Z", "20260714T230000Z", "20260713T220000Z", "20260710T220000Z"],
  );
});

test("search item extraction supports ordinary videos and Shorts renderers", () => {
  const data = {
    contents: [
      {
        videoRenderer: {
          videoId: "VIDEOID0001",
          title: { runs: [{ text: "ordinary video" }] },
          ownerText: { runs: [{ text: "channel", navigationEndpoint: { browseEndpoint: { browseId: "UC123", canonicalBaseUrl: "/@ordinary" } } }] },
          lengthText: { simpleText: "1:23:45" },
        },
      },
      {
        reelItemRenderer: {
          videoId: "SHORTID0002",
          headline: { simpleText: "short reel" },
          navigationEndpoint: { reelWatchEndpoint: { videoId: "SHORTID0002" } },
        },
      },
      {
        shortsLockupViewModel: {
          overlayMetadata: { primaryText: { content: "short lockup" } },
          onTap: { innertubeCommand: { commandMetadata: { webCommandMetadata: { url: "/shorts/SHORTID0003" } } } },
        },
      },
      {
        richItemRenderer: {
          content: {
            reelItemRenderer: {
              videoId: "SHORTID0003",
              headline: { simpleText: "duplicate nested short" },
            },
          },
        },
      },
      { richItemRenderer: { content: { playlistRenderer: { playlistId: "PL1234567890" } } } },
    ],
  };

  const items = extractSearchItems(data);

  assert.deepEqual(
    items.map((item) => [item.videoId, item.sourceRendererType]),
    [
      ["VIDEOID0001", "videoRenderer"],
      ["SHORTID0002", "reelItemRenderer"],
      ["SHORTID0003", "shortsLockupViewModel"],
    ],
  );
});

test("video title known-song detection creates conservative 0-second source for Shorts covers", () => {
  const lookup = knownSongLookup([
    ["発光帯", "ハナレグミ"],
  ]);

  const match = matchKnownTitleArtistFromVideoTitle("【歌ってみた】発光帯 / ハナレグミ #shorts", lookup);
  assert.deepEqual(match, {
    title: "発光帯",
    artist: "ハナレグミ",
    key: `${normalizeSongSearchText("発光帯")}::${normalizeSongSearchText("ハナレグミ")}`,
  });

  const source = createVideoTitleKnownSongSourceRecord(
    {
      videoId: "SHORTID0004",
      title: "【歌ってみた】発光帯 / ハナレグミ #shorts",
      sourceRendererType: "shortsLockupViewModel",
    },
    { songSearchLookup: lookup },
  );

  assert.equal(source.sourceType, "video_title");
  assert.equal(source.text, "0:00 発光帯 / ハナレグミ");
});

test("video title known-song detection rejects ambiguous title pairs", () => {
  const lookup = knownSongLookup([
    ["発光帯", "ハナレグミ"],
    ["Notebook", "buzzG"],
  ]);

  assert.equal(matchKnownTitleArtistFromVideoTitle("発光帯 / ハナレグミ / Notebook / buzzG cover", lookup), null);
  assert.equal(
    createVideoTitleKnownSongSourceRecord(
      {
        videoId: "SHORTID0005",
        title: "発光帯 / ハナレグミ / Notebook / buzzG cover",
        sourceRendererType: "shortsLockupViewModel",
      },
      { songSearchLookup: lookup },
    ),
    null,
  );
});

test("mygit today snapshot items dedupe videos, preserve timestamps, and count as monthly discovery", () => {
  const items = extractMygitTodaySnapshotItems(
    {
      groups: {
        today: {
          keywords: {
            歌枠: [
              {
                videoId: "MG000000001",
                title: "歌枠 archive",
                channelName: "snapshot channel",
                channelUrl: "https://www.youtube.com/@snapshot_channel",
                watchUrl: "https://www.youtube.com/watch?v=MG000000001",
                thumbnailUrl: "https://i.ytimg.com/vi/MG000000001/hqdefault.jpg",
                publishedText: "1 day ago",
                publishedTimestamp: Date.parse("2026-07-14T11:00:00Z"),
                durationText: "1:23:45",
                sourceUrl: TODAY_SEARCH_URL,
              },
              {
                videoId: "MG000000002",
                title: "live waiting room",
                channelName: "snapshot channel",
                publishedText: "ライブ配信中",
                statusText: "ライブ配信中",
              },
            ],
            弾き語り: [
              {
                videoId: "MG000000001",
                title: "歌枠 archive",
                channelName: "snapshot channel",
                publishedTimestamp: Date.parse("2026-07-14T11:00:00Z"),
                durationText: "1:23:45",
              },
            ],
          },
        },
      },
    },
    {
      snapshotId: "20260715T140648Z",
      snapshotUrl: "https://raw.githubusercontent.com/Marica7731/mygit/main/data/today-snapshots/20260715T140648Z.json",
      capturedAt: "2026-07-15T14:06:48.000Z",
    },
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].videoId, "MG000000001");
  assert.equal(items[0].publishedTimestamp, Date.parse("2026-07-14T11:00:00Z"));
  assert.equal(items[0].channelHandle, "@snapshot_channel");
  assert.equal(items[0].sourceGroup, MYGIT_TODAY_SNAPSHOT_SOURCE_GROUP);
  assert.equal(items[0].sourceUrls.includes("https://raw.githubusercontent.com/Marica7731/mygit/main/data/today-snapshots/20260715T140648Z.json"), true);
  assert.deepEqual(items[0].keywords.sort(), ["mygit今日快照", "弾き語り", "歌枠"].sort());
  assert.equal(hasMonthlyDiscoverySource(items[0]), true);
});

test("mygit today snapshot source fetches selected snapshots and summarizes failures without throwing", async () => {
  const indexUrl = "https://raw.example/mygit/data/today-snapshots/index.json";
  const rawBaseUrl = "https://raw.example/mygit";
  const snapshotUrl = "https://raw.example/mygit/data/today-snapshots/20260715T140648Z.json";
  const fetchImpl = async (url) => {
    if (url === indexUrl) {
      return jsonResponse({
        snapshots: [
          {
            id: "20260715T140648Z",
            path: "data/today-snapshots/20260715T140648Z.json",
            capturedAt: "2026-07-15T14:06:48.000Z",
          },
          {
            id: "20260714T230000Z",
            path: "data/today-snapshots/20260714T230000Z.json",
            capturedAt: "2026-07-14T23:00:00.000Z",
          },
        ],
      });
    }
    if (url === snapshotUrl) {
      return jsonResponse({
        groups: {
          today: {
            keywords: {
              歌枠: [
                {
                  videoId: "MG000000003",
                  title: "snapshot discovered song list",
                  channelName: "snapshot channel",
                  publishedTimestamp: Date.parse("2026-07-15T10:00:00Z"),
                  durationText: "2:00:00",
                },
              ],
            },
          },
        },
      });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const result = await fetchMygitTodaySnapshotSource(new Date("2026-07-15T15:00:00Z"), {
    fetchImpl,
    indexUrl,
    rawBaseUrl,
    lookbackDays: 2,
    maxSnapshots: 2,
  });

  assert.equal(result.summary.status, "partial");
  assert.equal(result.summary.snapshotCount, 2);
  assert.equal(result.summary.fetchedSnapshotCount, 1);
  assert.equal(result.summary.itemCount, 1);
  assert.equal(result.items[0].videoId, "MG000000003");
  assert.equal(result.items[0].sourceGroups.includes(MYGIT_TODAY_SNAPSHOT_SOURCE_GROUP), true);
});

test("mygit-discovered videos are eligible for monthly backfill selection", () => {
  const candidates = [
    candidate("AAAAAAAAAAA", 2, ["today"]),
    candidate("MG000000004", 24 * 12, [MYGIT_TODAY_SNAPSHOT_SOURCE_GROUP], {
      sourceUrls: ["https://raw.githubusercontent.com/Marica7731/mygit/main/data/today-snapshots/20260701T140000Z.json"],
    }),
  ];

  const selection = selectCandidatesForInspection(candidates, NOW, {
    carryForwardEnabled: true,
    carriedMonthVideoCount: 1,
  });

  assert.equal(selection.monthBackfillEnabled, true);
  assert.equal(hasMonthlyDiscoverySource(candidates[1]), true);
  assert.deepEqual(
    selection.items.map((item) => item.videoId),
    ["AAAAAAAAAAA", "MG000000004"],
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

test("all group includes every usable catalog video while recent group uses 7 days", () => {
  const groups = buildGroups(
    [
      video("AAAAAAAAAAA", 2, ["today"]),
      video("BBBBBBBBBBB", 24 * 10, ["month"]),
      video("CCCCCCCCCCC", 24 * 40, ["today"]),
      video("DDDDDDDDDDD", 3, ["today", "month"]),
      video("EEEEEEEEEEE", 24 * 40, ["month"]),
      video("FFFFFFFFFFF", 4, ["today", "month"], { sourceUrls: [TODAY_SEARCH_URL] }),
      video("GGGGGGGGGGG", 24 * 6, ["today"]),
    ],
    NOW,
  );

  assert.deepEqual(
    groups["7d"].items.map((item) => item.videoId),
    ["AAAAAAAAAAA", "DDDDDDDDDDD", "FFFFFFFFFFF", "GGGGGGGGGGG"],
  );
  assert.deepEqual(
    groups.all.items.map((item) => item.videoId),
    ["AAAAAAAAAAA", "DDDDDDDDDDD", "FFFFFFFFFFF", "GGGGGGGGGGG", "BBBBBBBBBBB", "CCCCCCCCCCC", "EEEEEEEEEEE"],
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

  const diff = buildRankDiffs(
    current,
    {
      entry: { id: "20260711T120000Z", path: "data/snapshots/20260711T120000Z.json" },
      payload: previous,
    },
    { songAliasContext: createSongAliasContext({ schemaVersion: 1, records: [] }) },
  )["7d"];

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

test("rank diffs compare configured aliases using canonical song entity keys", () => {
  const songAliasContext = createSongAliasContext({
    schemaVersion: 1,
    records: [{ artist: "AliA", canonicalTitle: "かくれんぼ", aliases: ["Kakurenbo", "かくれんぼ"] }],
  });
  const previous = payloadWithItems({
    "72h": [rankedItem("AAAAAAAAAAA", [song("Kakurenbo", "AliA"), song("Filler", "Artist F")])],
    "1m": [],
  });
  const current = payloadWithItems({
    "72h": [rankedItem("BBBBBBBBBBB", [song("かくれんぼ", "AliA"), song("かくれんぼ", "AliA")])],
    "1m": [],
  });

  const diff = buildRankDiffs(
    current,
    {
      entry: { id: "20260711T120000Z", path: "data/snapshots/20260711T120000Z.json" },
      payload: previous,
    },
    { songAliasContext },
  )["7d"];
  const entry = rankDiffByLabel(diff.songRank, "かくれんぼ");

  assert.equal(entry.entityKey, "かくれんぼ::alia");
  assert.equal(entry.previousCount, 1);
  assert.equal(entry.currentCount, 2);
  assert.equal(entry.isNew, false);
});

test("rank diffs use stable new-entry fields without previous snapshot", () => {
  const current = payloadWithItems({
    "72h": [rankedItem("AAAAAAAAAAA", [song("Fresh", "Artist A")])],
    "1m": [rankedItem("BBBBBBBBBBB", [song("Monthly Fresh", "Artist B")])],
  });

  const diffs = buildRankDiffs(current, null);

  assert.equal(diffs["7d"].previous, null);
  assertRankDiff(diffs["7d"].songRank, "Fresh", {
    previousRank: null,
    currentRank: 1,
    rankDelta: null,
    previousCount: 0,
    currentCount: 1,
    countDelta: 1,
    isNew: true,
  });
  assertRankDiff(diffs.all.artistRank, "Artist B", {
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

  const diff = buildRankDiffs(current, null)["7d"];

  assert.equal(rankDiffByLabel(diff.songRank, "Alpha").currentRank, 1);
  assert.equal(rankDiffByLabel(diff.songRank, "Beta").currentRank, 2);
  assert.equal(rankDiffByLabel(diff.songRank, "Gamma").currentRank, 2);
  assert.equal(rankDiffByLabel(diff.songRank, "Delta").currentRank, 4);
});

test("regional VTuber blocklist matches exact channel fields without relying on broad title text", () => {
  assert.equal(BLOCKED_REGIONAL_VTUBER_CHANNELS.entries.some((entry) => entry.name === "羽芝扉扉"), true);
  assert.equal(BLOCKED_REGIONAL_VTUBER_CHANNELS.entries.some((entry) => entry.name === "厄倫蒂兒"), true);
  assert.equal(BLOCKED_REGIONAL_VTUBER_CHANNELS.entries.some((entry) => entry.name === "綽貓喵"), true);
  assert.equal(isBlockedSource({ channelName: "羽芝扉扉", title: "歌枠" }), true);
  assert.equal(isBlockedSource({ channelHandle: "@EarendelXDFP", channelName: "Japanese Channel", title: "Karaoke" }), true);
  assert.equal(isBlockedSource({ channelId: "UCW8G8aeRjbIOlL-Fgms8hEQ", channelName: "Japanese Channel", title: "歌雜 / HKVtuber" }), true);
  assert.equal(isBlockedSource({ channelName: "VTuber Music", title: "HKVtuber 台湾旅行" }), false);
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
          video("AAAAAAAAAAA", 3, ["today"], { channelHandle: "@EarendelXDFP" }),
          video("BBBBBBBBBBB", 3, ["today"], { channelName: "channel" }),
        ],
      },
      "1m": {
        items: [
          video("CCCCCCCCCCC", 24 * 10, ["month"], { channelName: "羽芝扉扉" }),
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
    candidate("AAAAAAAAAAA", 2, ["today"], { channelName: "羽芝扉扉" }),
    candidate("BBBBBBBBBBB", 3, ["today"], { channelName: "channel" }),
    candidate("CCCCCCCCCCC", 24 * 8, ["month"], { channelHandle: "@EarendelXDFP" }),
  ];
  const selection = selectCandidatesForInspection(candidates, NOW);

  assert.equal(selection.skippedBlacklistedCandidateCount, 2);
  assert.deepEqual(
    selection.items.map((item) => item.videoId),
    ["BBBBBBBBBBB"],
  );

  const merged = mergeFetchedAndCarriedVideos(
    [video("AAAAAAAAAAA", 2, ["today"], { channelName: "羽芝扉扉" })],
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
  assert.equal(retryDelayMs(response(500, ""), 2, nowMs, () => 0.5, 500), 3250);
});

test("random jitter is deterministic when the random source is injected", () => {
  assert.equal(randomJitterMs(0, () => 0.99), 0);
  assert.equal(randomJitterMs(500, () => 0), 0);
  assert.equal(randomJitterMs(500, () => 0.5), 250);
  assert.equal(randomJitterMs(500, () => 0.999), 500);
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

test("request limiter adds deterministic jitter to request spacing", async () => {
  const limiter = createRequestLimiter({ requestDelayMs: 1000, requestJitterMs: 500, max429Errors: 2, random: () => 0.5 });
  let nowMs = 1000;

  await limiter.beforeRequest(() => nowMs);

  assert.equal(limiter.nextRequestAt, 2250);
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
  return Array.from({ length: count }, (_, index) =>
    song(title, artist, {
      seconds: 60 + index * 60,
      time: `0:${String(index + 1).padStart(2, "0")}:00`,
    }),
  );
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

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}

function knownSongLookup(pairs) {
  return createSongSearchLookup({
    titleKeys: pairs.map(([title]) => normalizeSongSearchText(title)),
    titleArtistKeys: pairs.map(([title, artist]) => `${normalizeSongSearchText(title)}::${normalizeSongSearchText(artist)}`),
  });
}
