const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildClientGroup,
  buildRuntimeMeta,
  buildRuntimeRangePayload,
  compactRankDiff,
  compactRankDiffEntries,
  CURRENT_FILTER_VERSION,
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
    "channelHandle",
    "channelId",
    "channelName",
    "channelUrl",
    "keyword",
    "publishedText",
    "songs",
    "thumbnailUrl",
    "title",
    "videoId",
  ]);
  assert.deepEqual(Object.keys(group.items[0].songs[0]).sort(), ["artist", "isNiche", "seconds", "title"]);
  assert.equal(group.items[0].songs[0].seconds, 75);
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
          retentionDays: 35,
          catalogVideoCount: 12,
          monthVideoCount: 12,
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
  assert.deepEqual(meta.latestCapture.itemCounts, { "72h": 1, "1m": 2 });
  assert.equal(meta.ranges["72h"].path, "data/ui/72h.json");
  assert.equal(meta.ranges["72h"].legacyPath, "data/ui/72h.json");
  assert.match(meta.ranges["72h"].sha256, /^[0-9a-f]{64}$/u);
  assert.equal(meta.ranges["72h"].dataVersion, meta.dataVersion);
  assert.equal(meta.ranges["72h"].itemCount, 1);
  assert.equal(meta.ranges["1m"].itemCount, 2);
  assert.deepEqual(meta.catalog, {
    path: "data/video-catalog.json",
    retentionDays: 35,
    catalogVideoCount: 12,
    monthVideoCount: 12,
  });
  assert.deepEqual(meta.diffs["72h"], { path: "data/diff/latest-72h.json" });
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
  assert.equal(range.filterVersion, CURRENT_FILTER_VERSION);
  assert.equal(range.blocklistVersion, BLOCKLIST_VERSION);
  assert.equal(range.blocklistHash, BLOCKLIST_HASH);
  assert.equal(range.nicheAnnotated, true);
  assert.equal(range.items[0].songs[0].isNiche, true);
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
