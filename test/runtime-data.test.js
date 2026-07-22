const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildClientGroup,
  buildRuntimeMeta,
  buildRuntimeRangePayload,
  buildSearchRecords,
  buildSourceDetailRecords,
  chunkRecordsByPayloadBytes,
  compactRankDiff,
  compactRankDiffEntries,
  CURRENT_FILTER_VERSION,
  requestSearchBucketId,
  requestSearchBuckets,
} = require("../scripts/build-runtime-data");
const { BLOCKLIST_HASH, BLOCKLIST_VERSION } = require("../assets/source-filter");

test("buildClientGroup keeps only runtime video and song fields", () => {
  const group = buildClientGroup({
    id: "72h",
    title: "最近72小时",
    generatedAt: "2026-07-12T15:00:00Z",
    items: [
      {
        videoId: "AAAAAAAAAAA",
        title: "video",
        channelName: "channel",
        channelId: "UCID",
        channelHandle: "/@handle",
        channelUrl: "https://www.youtube.com/@handle",
        keyword: "歌枠",
        keywords: ["歌枠"],
        publishedText: "1 hour ago",
        thumbnailUrl: "https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg",
        sourceGroups: ["today"],
        raw: { unused: true },
        songs: [
          {
            index: 1,
            time: "0:01:15",
            seconds: 75,
            title: "song",
            artist: "artist",
            raw: "1:15 song / artist",
            isNiche: false,
          },
        ],
      },
    ],
  });

  assert.deepEqual(Object.keys(group.items[0]).sort(), [
    "avatarUrl",
    "catalogFirstSeenAt",
    "catalogLastInspectedAt",
    "catalogLastSeenAt",
    "channelHandle",
    "channelId",
    "channelName",
    "channelUrl",
    "isCollected",
    "keyword",
    "knownSourceType",
    "publishedAt",
    "publishedText",
    "publishedTimestamp",
    "songs",
    "sourceUrl",
    "thumbnailUrl",
    "timeMissingReason",
    "title",
    "videoId",
  ]);
  assert.deepEqual(Object.keys(group.items[0].songs[0]).sort(), ["artist", "isNiche", "seconds", "title"]);
  assert.equal(group.items[0].songs[0].seconds, 75);
});

test("buildClientGroup removes channel URL paths from handles and aliases", () => {
  const group = buildClientGroup({
    id: "all",
    title: "all",
    items: [
      {
        videoId: "PATHHANDLE3",
        title: "video",
        channelName: "Channel",
        channelId: "UC_REAL",
        channelHandle: "/channel/UC_REAL",
        channelUrl: "https://www.youtube.com/channel/UC_REAL",
        channelAliases: ["/channel/UC_REAL", "Channel Alias"],
        songs: [{ seconds: 1, title: "Song", artist: "Artist" }],
      },
    ],
  });

  assert.equal(group.items[0].channelHandle, "");
  assert.deepEqual(group.items[0].channelAliases, ["Channel Alias"]);
});

test("buildClientGroup treats moment sources as not collected even with stale flags", () => {
  const group = buildClientGroup({
    id: "all",
    title: "all",
    items: [
      {
        videoId: "MOMENT00001",
        title: "moment video",
        channelName: "Moment Ch.",
        knownSourceType: "vsinger_moment_http",
        isCollected: true,
        sourceGroups: ["vsinger-moment"],
        sourceQuality: { sourceType: "external", sourceSystem: "vsinger_moment_http" },
        songs: [{ seconds: 1, title: "Moment Song", artist: "Moment Artist" }],
      },
      {
        videoId: "MOMENTALIAS1",
        title: "moment alias video",
        channelName: "Moment Alias Ch.",
        isCollected: true,
        sourceQuality: { sourceType: "external", sourceSystem: "moment" },
        songs: [{ seconds: 5, title: "Moment Alias Song", artist: "Moment Alias Artist" }],
      },
      {
        videoId: "MOMENTALIAS2",
        title: "vsinger moment alias video",
        channelName: "VSinger Moment Alias Ch.",
        isCollected: true,
        sourceQuality: { sourceType: "external", sourceSystem: "vsinger-moment" },
        songs: [{ seconds: 6, title: "VSinger Moment Alias Song", artist: "VSinger Moment Alias Artist" }],
      },
      {
        videoId: "SCAN0000001",
        title: "scan video",
        channelName: "Scan Ch.",
        sourceGroups: ["youtube_channel_discovery"],
        songs: [{ seconds: 2, title: "Scanned Song", artist: "Scanned Artist" }],
      },
      {
        videoId: "MANUAL00001",
        title: "manual video",
        channelName: "Manual Ch.",
        knownSourceType: "manual",
        songs: [{ seconds: 3, title: "Manual Song", artist: "Manual Artist" }],
      },
      {
        videoId: "MIXED000001",
        title: "mixed video",
        channelName: "Mixed Ch.",
        knownSourceType: "vsinger_moment_http",
        sourceGroups: ["vsinger-moment", "youtube_channel_discovery"],
        songs: [{ seconds: 4, title: "Mixed Song", artist: "Mixed Artist" }],
      },
    ],
  });

  assert.deepEqual(
    group.items.map((item) => [item.videoId, item.knownSourceType, item.isCollected]),
    [
      ["MOMENT00001", "vsinger_moment_http", false],
      ["MOMENTALIAS1", "moment", false],
      ["MOMENTALIAS2", "vsinger-moment", false],
      ["SCAN0000001", "youtube_channel_discovery", true],
      ["MANUAL00001", "manual", true],
      ["MIXED000001", "vsinger_moment_http", true],
    ],
  );
});

test("buildClientGroup backfills same-title unknown artists before UI search/source preview", () => {
  const group = buildClientGroup({
    id: "all",
    title: "all",
    items: [
      {
        videoId: "FLOWER00001",
        title: "Flower karaoke",
        channelName: "Flower Ch.",
        songs: [
          { seconds: 10, title: "花になって", artist: "緑黄色社会" },
          { seconds: 20, title: "晴るる", artist: "未記載" },
        ],
      },
      {
        videoId: "FLOWER00002",
        title: "Flower alias karaoke",
        channelName: "Flower Alias Ch.",
        songs: [
          { seconds: 30, title: "⟦16⟧ 花になって", artist: "未記載" },
          { seconds: 40, title: "花になって - Be a flower", artist: "未記載" },
          { seconds: 50, title: "52😎花になって", artist: "未記載" },
        ],
      },
    ],
  });

  const songs = group.items.flatMap((item) => item.songs);
  const flowerSongs = songs.filter((song) => song.title === "花になって");
  assert.equal(flowerSongs.length, 4);
  assert.deepEqual(
    flowerSongs.map((song) => song.artist),
    ["緑黄色社会", "緑黄色社会", "緑黄色社会", "緑黄色社会"],
  );
  const haruru = songs.find((song) => song.title === "晴るる");
  assert.equal(haruru.artist, "未記載");

  const flowerSearchText = JSON.stringify(buildSearchRecords(group.items).filter((record) => record.type === "song" && record.title === "花になって"));
  assert.doesNotMatch(flowerSearchText, /未記載|⟦16⟧|Be a flower|52😎/u);
});

test("buildClientGroup filters runtime activity markers while preserving START songs", () => {
  const group = buildClientGroup({
    id: "all",
    title: "all",
    items: [
      {
        videoId: "AAAAAAAAAAA",
        title: "video",
        channelName: "channel",
        songs: [
          { seconds: 1, title: "StaRt", artist: "Mrs. GREEN APPLE", isNiche: false },
          { seconds: 2, title: "枠Start", artist: "未記載", isNiche: true },
          { seconds: 3, title: "~ 開始", artist: "未記載", isNiche: true },
          { seconds: 4, title: "セットリスト", artist: "歌唱開始時間", isNiche: true },
          { seconds: 5, title: "103期4月度Fes×LIVE 同時視聴開始", artist: "未記載", isNiche: false },
          { seconds: 6, title: "メズマライザー", artist: "ラグにより途中開始", isNiche: false },
          { seconds: 7, title: "仮装狂騒曲", artist: "初星学園(ちゃんと歌えるまで耐久開始)", isNiche: false },
          { seconds: 8, title: "開始　～　春泥棒", artist: "ヨルシカ", isNiche: false },
          { seconds: 9, title: "閉会式開始", artist: "未記載", isNiche: false },
          { seconds: 10, title: "開始ツイートしてなーい！", artist: "\"I forgot to tweet that the stream started!\"", isNiche: false },
          { seconds: 11, title: "なれコールアンケート", artist: "未記載", isNiche: false },
          { seconds: 12, title: "Never Ending Story", artist: "Limahl", isNiche: false },
          { seconds: 13, title: "START:DASH!!", artist: "μ's", isNiche: false },
        ],
      },
    ],
  });

  assert.deepEqual(
    group.items[0].songs.map((song) => `${song.title} / ${song.artist}`),
    ["StaRt / Mrs. GREEN APPLE", "メズマライザー / 未記載", "仮装狂騒曲 / 初星学園", "春泥棒 / ヨルシカ", "Never Ending Story / Limahl", "START:DASH!! / μ's"],
  );
});

test("buildClientGroup applies source-aware runtime song cleanup", () => {
  const group = buildClientGroup({
    id: "all",
    title: "all",
    items: [
      {
        videoId: "NOAPOLARIS1",
        title: "Noa Karaoke",
        channelName: "ノア・ポラリス -Noa Polaris-",
        channelHandle: "/@noa_polaris",
        songs: [
          { seconds: 1, title: "自己紹介", artist: "Aimer", isNiche: true },
          { seconds: 2, title: "Brave Shine", artist: "Aimer Start", isNiche: false },
        ],
      },
      {
        videoId: "RIONA000001",
        title: "Riona Karaoke",
        channelName: "Riona Ch. 響咲リオナ - FLOW GLOW",
        channelHandle: "/@IsakiRiona",
        songs: [
          { seconds: 3, title: "Unknown Row", artist: "未記載", isNiche: true },
          { seconds: 4, title: "Known Song", artist: "Known Artist", isNiche: false },
        ],
      },
    ],
  });

  assert.deepEqual(
    group.items.map((item) => [item.videoId, item.songs.map((song) => `${song.title} / ${song.artist}`)]),
    [
      ["NOAPOLARIS1", ["Brave Shine / Aimer"]],
      ["RIONA000001", ["Known Song / Known Artist"]],
    ],
  );
  assert.deepEqual(Object.keys(group.items[0].songs[0]).sort(), ["artist", "isNiche", "seconds", "title"]);
});

test("buildClientGroup drops videos after all songs are filtered", () => {
  const group = buildClientGroup({
    id: "all",
    title: "all",
    items: [
      {
        videoId: "AAAAAAAAAAA",
        title: "video",
        channelName: "channel",
        songs: [
          { seconds: 1, title: "セットリスト", artist: "歌唱開始時間", isNiche: true },
          { seconds: 2, title: "セットリスト（歌唱開始時間）", artist: "未記載", isNiche: true },
          { seconds: 3, title: "本日のセトリはこちら", artist: "未記載", isNiche: true },
          { seconds: 4, title: "セトリ開示タイム", artist: "チラ見ユラ", isNiche: true },
          { seconds: 5, title: "~ 開始", artist: "未記載", isNiche: true },
        ],
      },
    ],
  });

  assert.equal(group.items.length, 0);
});

test("runtime meta uses the expected range and diff paths", () => {
  const rangePayloads = {
    "72h": { id: "72h", generatedAt: "2026-07-12T15:00:00Z", items: [{ videoId: "AAAAAAAAAAA" }], nicheAnnotated: true },
    "1m": {
      id: "1m",
      generatedAt: "2026-07-12T15:00:00Z",
      items: [{ videoId: "BBBBBBBBBBB" }, { videoId: "CCCCCCCCCCC" }],
      nicheAnnotated: true,
    },
    "7d": { id: "7d", generatedAt: "2026-07-12T15:00:00Z", items: [{ videoId: "AAAAAAAAAAA" }], nicheAnnotated: true },
    all: {
      id: "all",
      generatedAt: "2026-07-12T15:00:00Z",
      items: [{ videoId: "BBBBBBBBBBB" }, { videoId: "CCCCCCCCCCC" }],
      nicheAnnotated: true,
    },
  };
  const meta = buildRuntimeMeta(
    {
      generatedAt: "2026-07-12T15:00:00Z",
      capturedAt: "2026-07-12T15:00:00Z",
      status: { status: "success" },
      source: {
        rebuiltDerivedAt: "2026-07-12T16:30:00Z",
        videoCatalog: {
          path: "data/video-catalog.json",
          retentionPolicy: "permanent",
          retentionDays: null,
          catalogVideoCount: 12,
          allVideoCount: 12,
          monthVideoCount: 4,
        },
      },
    },
    rangePayloads,
  );

  assert.match(meta.dataVersion, /^[0-9a-f]{64}$/u);
  assert.equal(meta.filterVersion, CURRENT_FILTER_VERSION);
  assert.equal(meta.blocklistVersion, BLOCKLIST_VERSION);
  assert.equal(meta.blocklistHash, BLOCKLIST_HASH);
  assert.equal(meta.rebuiltDerivedAt, "2026-07-12T16:30:00Z");
  assert.equal(meta.status.rebuiltDerivedAt, "2026-07-12T16:30:00Z");
  assert.equal(meta.status.capturedAt, "2026-07-12T15:00:00Z");
  assert.equal(meta.status.dataVersion, meta.dataVersion);
  assert.equal(meta.nicheAnnotated, true);
  assert.equal(meta.latestCapture.capturedAt, "2026-07-12T15:00:00Z");
  assert.equal(meta.latestDerived.rebuiltDerivedAt, "2026-07-12T16:30:00Z");
  assert.deepEqual(meta.latestCapture.itemCounts, { "7d": 1, all: 2 });
  assert.deepEqual(meta.rangeAliases, { "72h": "7d", "1m": "all" });
  assert.equal(meta.ranges["7d"].path, "data/ui/7d.json");
  assert.equal(meta.ranges["7d"].legacyPath, "data/ui/7d.json");
  assert.equal(meta.ranges["7d"].canonicalRangeId, "7d");
  assert.deepEqual(meta.ranges["7d"].legacyRangeIds, ["72h"]);
  assert.match(meta.ranges["7d"].sha256, /^[0-9a-f]{64}$/u);
  assert.equal(meta.ranges["7d"].dataVersion, meta.dataVersion);
  assert.equal(meta.ranges["7d"].itemCount, 1);
  assert.deepEqual(meta.ranges.all.legacyRangeIds, ["1m"]);
  assert.equal(meta.ranges.all.itemCount, 2);
  assert.deepEqual(meta.catalog, {
    path: "data/video-catalog.json",
    retentionPolicy: "permanent",
    retentionDays: null,
    catalogVideoCount: 12,
    allVideoCount: 12,
    monthVideoCount: 4,
  });
  assert.deepEqual(meta.diffs["7d"], { path: "data/diff/latest-7d.json" });
});

test("runtime range payload carries filterVersion and niche annotation state", () => {
  const payload = {
    generatedAt: "2026-07-12T15:00:00Z",
    capturedAt: "2026-07-12T15:00:00Z",
    groups: {
      "72h": {
        id: "72h",
        title: "最近72小时",
        items: [
          {
            videoId: "AAAAAAAAAAA",
            title: "video",
            channelName: "channel",
            songs: [{ seconds: 75, title: "song", artist: "artist", isNiche: true }],
          },
        ],
      },
    },
  };

  const range = buildRuntimeRangePayload(payload, "72h");

  assert.equal(range.id, "72h");
  assert.equal(range.canonicalRangeId, "7d");
  assert.deepEqual(range.legacyRangeIds, []);
  assert.equal(range.filterVersion, CURRENT_FILTER_VERSION);
  assert.equal(range.blocklistVersion, BLOCKLIST_VERSION);
  assert.equal(range.blocklistHash, BLOCKLIST_HASH);
  assert.equal(range.nicheAnnotated, true);
  assert.equal(range.items[0].songs[0].isNiche, true);
});

test("canonical runtime ranges can be built from legacy payload groups", () => {
  const payload = {
    generatedAt: "2026-07-12T15:00:00Z",
    capturedAt: "2026-07-12T15:00:00Z",
    groups: {
      "72h": {
        id: "72h",
        title: "legacy recent",
        items: [
          {
            videoId: "AAAAAAAAAAA",
            title: "video",
            channelName: "channel",
            songs: [{ seconds: 75, title: "song", artist: "artist", isNiche: false }],
          },
        ],
      },
      "1m": {
        id: "1m",
        title: "legacy all",
        items: [
          {
            videoId: "BBBBBBBBBBB",
            title: "older video",
            channelName: "channel",
            songs: [{ seconds: 30, title: "old song", artist: "artist", isNiche: false }],
          },
        ],
      },
    },
  };

  const recent = buildRuntimeRangePayload(payload, "7d");
  const all = buildRuntimeRangePayload(payload, "all");

  assert.equal(recent.id, "7d");
  assert.deepEqual(recent.legacyRangeIds, ["72h"]);
  assert.equal(recent.items[0].videoId, "AAAAAAAAAAA");
  assert.equal(all.id, "all");
  assert.deepEqual(all.legacyRangeIds, ["1m"]);
  assert.equal(all.items[0].videoId, "BBBBBBBBBBB");
});

test("source detail and search records split heavy runtime fields out of page payloads", () => {
  const items = [
    {
      videoId: "AAAAAAAAAAA",
      title: "video",
      channelName: "channel",
      channelId: "UCID",
      channelHandle: "@handle",
      keyword: "歌枠",
      keywords: ["歌枠", "弾き語り"],
      keywordKeys: ["utawaku"],
      publishedText: "1 hour ago",
      thumbnailUrl: "https://example.test/source-thumb.jpg",
      publishedTimestamp: Date.parse("2026-07-12T14:00:00Z"),
      durationText: "1:00:00",
      sourceGroups: ["today"],
      sourceUrls: ["https://example.test/source"],
      sourceQuality: { sourceType: "comment", sourceScore: 10 },
      songs: [
        { seconds: 75, title: "Song A", artist: "Artist A", isNiche: false },
        { seconds: 125, title: "Song B", artist: "Artist B", isNiche: true },
      ],
    },
  ];

  const details = buildSourceDetailRecords(items);
  const search = buildSearchRecords(items);

  assert.equal(details[0].videoId, "AAAAAAAAAAA");
  assert.equal(details[0].thumbnailUrl, "https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg");
  assert.deepEqual(details[0].keywords, ["歌枠", "弾き語り"]);
  assert.equal(details[0].songCount, 2);
  assert.equal(search.length, 3);
  assert.deepEqual(
    search.map((record) => record.type),
    ["video", "song", "song"],
  );
  assert.equal(search[1].searchText.includes("song a"), true);
  assert.equal(search[0].searchText.includes("aaaaaaaaaaa"), true);
  assert.equal(search[1].searchText.includes("aaaaaaaaaaa"), true);
});

test("request search buckets route by token first character into bounded shards", () => {
  const buckets = requestSearchBuckets("Song A Artist A Channel Name AAAAAAAAAAA");

  assert.ok(buckets.size <= 8);
  assert.ok([...buckets].every((bucket) => /^b\d{2}$/u.test(bucket)));
  assert.equal(requestSearchBucketId("S"), requestSearchBucketId("S"));
  assert.equal(requestSearchBucketId("ヤ"), requestSearchBucketId("ヤ"));
  assert.notEqual(requestSearchBucketId("S"), requestSearchBucketId("T"));
});

test("request keyed shards split before the payload byte budget is exceeded", () => {
  const records = [
    { key: "a", value: "x".repeat(90) },
    { key: "b", value: "y".repeat(90) },
    { key: "c", value: "z".repeat(90) },
  ];
  const chunks = chunkRecordsByPayloadBytes(records, {
    pageSize: 10,
    maxBytes: 260,
    buildPayload: (chunk) => ({ kind: "request-source-detail", records: chunk }),
  });

  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk.map((record) => record.key)), [["a"], ["b"], ["c"]]);
});

test("request search shards split by estimated payload bytes without repeated full payload serialization", () => {
  const records = [
    { key: "a", searchText: "alpha", value: "x".repeat(90) },
    { key: "b", searchText: "beta", value: "y".repeat(90) },
    { key: "c", searchText: "gamma", value: "z".repeat(90) },
  ];
  const chunks = chunkRecordsByPayloadBytes(records, {
    pageSize: 10,
    maxBytes: 280,
    payloadBase: { kind: "request-search-page", rangeId: "all", bucket: "b01" },
    recordName: "records",
  });

  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk.map((record) => record.key)), [["a"], ["b"], ["c"]]);
});

test("compact rank diff removes unchanged entries and detailed fields", () => {
  const entries = compactRankDiffEntries([
    {
      entityKey: "same",
      label: "same",
      previousRank: 1,
      currentRank: 1,
      rankDelta: 0,
      previousCount: 2,
      currentCount: 2,
      countDelta: 0,
      isNew: false,
    },
    {
      entityKey: "changed",
      label: "changed",
      previousRank: 3,
      currentRank: 2,
      rankDelta: 1,
      previousCount: 1,
      currentCount: 4,
      countDelta: 3,
      isNew: false,
    },
  ]);

  assert.deepEqual(entries, [{ entityKey: "changed", rankDelta: 1, countDelta: 3, isNew: false }]);
});

test("compact rank diff keeps only runtime trend fields", () => {
  const compact = compactRankDiff({
    schemaVersion: 1,
    generatedAt: "2026-07-12T15:00:00Z",
    capturedAt: "2026-07-12T15:00:00Z",
    range: "72h",
    current: { snapshotId: "current" },
    previous: null,
    songRank: [
      {
        entityKey: "fresh",
        label: "Fresh",
        previousRank: null,
        currentRank: 1,
        rankDelta: null,
        previousCount: 0,
        currentCount: 1,
        countDelta: 1,
        isNew: true,
      },
    ],
    artistRank: [],
  });

  assert.deepEqual(Object.keys(compact.songRank[0]).sort(), ["countDelta", "entityKey", "isNew", "rankDelta"]);
});
