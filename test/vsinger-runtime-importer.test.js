const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { writeShardedBundle } = require("../scripts/vsinger-http/bundle-writer");
const { SOURCE_SYSTEM } = require("../scripts/vsinger-http/model");
const {
  augmentPayloadWithVsingerBackfill,
  loadVsingerBackfillRuntimeVideos,
  mergeSongItems,
  parseVsingerDateTimestamp,
} = require("../scripts/vsinger-http/runtime-importer");

test("VSinger backfill augments runtime groups and merges existing videos", () => {
  const dir = writeBackfillBundle({
    songs: [
      song("vsinger:song-a", "song-a", "フィナーレ", "eill"),
      song("vsinger:song-b", "song-b", "晩餐歌", "Tuki."),
      song("vsinger:song-c", "song-c", "Future Song", "Future Artist"),
    ],
    videos: [
      video("PwEG0NtOoxE", "video-a", "2026-07-17"),
      video("SR7Az4c9-Ls", "video-b", "2026-07-20"),
    ],
    occurrences: [
      occurrence("PwEG0NtOoxE", "video-a", "vsinger:song-a", "song-a", 421),
      occurrence("PwEG0NtOoxE", "video-a", "vsinger:song-b", "song-b", 870),
      occurrence("SR7Az4c9-Ls", "video-b", "vsinger:song-c", "song-c", 120),
    ],
  });
  const payload = basePayload({
    items: [
      {
        videoId: "PwEG0NtOoxE",
        title: "existing title",
        channelName: "existing channel",
        keyword: "歌枠",
        publishedText: "2026-07-17",
        publishedTimestamp: parseVsingerDateTimestamp("2026-07-17"),
        sourceGroups: ["today"],
        sourceUrls: ["https://example.test/source"],
        songs: [{ time: "0:00:10", seconds: 10, title: "Existing Song", artist: "Existing Artist", isNiche: true }],
      },
    ],
  });

  const result = augmentPayloadWithVsingerBackfill(payload, { backfillDir: dir });
  const allItems = result.groups.all.items;
  const recentItems = result.groups["7d"].items;
  const merged = allItems.find((item) => item.videoId === "PwEG0NtOoxE");

  assert.equal(allItems.filter((item) => item.videoId === "PwEG0NtOoxE").length, 1);
  assert.equal(allItems.some((item) => item.videoId === "SR7Az4c9-Ls"), false);
  assert.equal(recentItems.some((item) => item.videoId === "PwEG0NtOoxE"), true);
  assert.equal(recentItems.some((item) => item.videoId === "SR7Az4c9-Ls"), false);
  assert.equal(merged.title, "existing title");
  assert.deepEqual(
    merged.songs.map((item) => item.title),
    ["Existing Song", "フィナーレ", "晩餐歌"],
  );
  assert.equal(merged.sourceGroups.includes("today"), true);
  assert.equal(merged.sourceGroups.includes("vsinger-moment"), true);
  assert.equal(result.source.externalSources.vsingerMoment.importedVideoCount, 2);
  assert.equal(result.source.externalSources.vsingerMoment.importedOccurrenceCount, 3);
  assert.equal(result.source.externalSources.vsingerMoment.ranges.all.importedVideoCount, 1);
});

test("VSinger backfill requires complete singer-scoped coverage", () => {
  const dir = writeBackfillBundle({
    coverage: {
      overallStatus: "partial",
      stages: {
        singerSongs: {
          coverageStatus: "partial",
          detailCoverageStatus: "partial",
          ownerPermission: { enabled: true },
        },
      },
      failureCount: 0,
      conflictCount: 0,
    },
  });

  assert.throws(() => loadVsingerBackfillRuntimeVideos({ backfillDir: dir }), /coverage is not complete/u);
});

test("VSinger song merge preserves same-song repeats at different timestamps", () => {
  const songs = mergeSongItems(
    [{ seconds: 100, title: "Song", artist: "Artist", isNiche: false }],
    [
      { seconds: 100, title: "Song", artist: "Artist", isNiche: false },
      { seconds: 200, title: "Song", artist: "Artist", isNiche: false },
    ],
  );

  assert.deepEqual(
    songs.map((song) => `${song.seconds}:${song.title}:${song.artist}`),
    ["100:Song:Artist", "200:Song:Artist"],
  );
});

test("VSinger song merge filters legacy commentary rows while keeping reviewed real songs", () => {
  const songs = mergeSongItems(
    [
      { seconds: 1, title: "なれたんに褒められたいハネダン達", artist: "Hanedans Who Want Praise from Naretan" },
      { seconds: 2, title: "去年のなれたんは譲り合い精神がないの？", artist: "未記載" },
      { seconds: 3, title: "END", artist: "エンドカード" },
      { seconds: 4, title: "星座になれたら", artist: "結束バンド" },
      { seconds: 5, title: "ENDLESS STORY", artist: "REIRA starring YUNA ITO" },
      { seconds: 6, title: "楽しみにしてろよ!", artist: "練習後のなれたんを" },
    ],
    [
      { seconds: 7, title: "アンケート (なれたんを家族に例えると)", artist: "Poll: If Narae-tan was family" },
      { seconds: 8, title: "Opening", artist: "Known Artist" },
    ],
  );

  assert.deepEqual(
    songs.map((song) => `${song.title} / ${song.artist}`),
    ["星座になれたら / 結束バンド", "ENDLESS STORY / REIRA starring YUNA ITO", "Opening / Known Artist"],
  );
});

test("VSinger backfill filters non-song setlist markers before runtime import", () => {
  const dir = writeBackfillBundle({
    songs: [
      song("vsinger:song-real", "song-real", "StaRt", "Mrs. GREEN APPLE"),
      song("vsinger:song-start", "song-start", "配信START", ""),
      song("vsinger:song-setlist", "song-setlist", "セットリスト", "歌唱開始時間"),
      song("vsinger:song-begin", "song-begin", "開始", ""),
    ],
    videos: [video("PwEG0NtOoxE", "video-a", "2026-07-17")],
    occurrences: [
      occurrence("PwEG0NtOoxE", "video-a", "vsinger:song-real", "song-real", 100),
      occurrence("PwEG0NtOoxE", "video-a", "vsinger:song-start", "song-start", 200),
      occurrence("PwEG0NtOoxE", "video-a", "vsinger:song-setlist", "song-setlist", 300),
      occurrence("PwEG0NtOoxE", "video-a", "vsinger:song-begin", "song-begin", 400),
    ],
  });

  const result = loadVsingerBackfillRuntimeVideos({ backfillDir: dir });

  assert.deepEqual(result.videos[0].songs.map((item) => item.title), ["StaRt"]);
  assert.equal(result.summary.importedOccurrenceCount, 1);
  assert.equal(result.summary.skippedNonSongOccurrenceCount, 3);
});

function writeBackfillBundle(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsinger-runtime-importer-"));
  const bundle = {
    schemaVersion: 1,
    sourceSystem: SOURCE_SYSTEM,
    generatedAt: "2026-07-18T10:04:38.227Z",
    songs: overrides.songs || [song("vsinger:song-a", "song-a", "フィナーレ", "eill")],
    videos: overrides.videos || [video("PwEG0NtOoxE", "video-a", "2026-07-17")],
    occurrences: overrides.occurrences || [occurrence("PwEG0NtOoxE", "video-a", "vsinger:song-a", "song-a", 421)],
    conflicts: [],
    failures: [],
    coverage: overrides.coverage || completeCoverage(),
  };
  bundle.counts = {
    songs: bundle.songs.length,
    videos: bundle.videos.length,
    occurrences: bundle.occurrences.length,
    conflicts: bundle.conflicts.length,
    failures: bundle.failures.length,
  };
  writeShardedBundle(dir, bundle, { shardSize: 2 });
  return dir;
}

function basePayload(options = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-18T09:00:00.000Z",
    capturedAt: "2026-07-18T09:00:00.000Z",
    groups: {
      "7d": {
        id: "7d",
        title: "Last 7 days timestamp song lists",
        generatedAt: "2026-07-18T09:00:00.000Z",
        updatedAt: "2026-07-18T09:00:00.000Z",
        items: options.items || [],
      },
      all: {
        id: "all",
        title: "All accumulated timestamp song lists",
        generatedAt: "2026-07-18T09:00:00.000Z",
        updatedAt: "2026-07-18T09:00:00.000Z",
        items: options.items || [],
      },
    },
    source: {},
  };
}

function completeCoverage() {
  return {
    overallStatus: "complete",
    stages: {
      singerSongs: {
        coverageStatus: "complete",
        detailCoverageStatus: "complete",
        singersProcessed: 393,
        ownerPermission: {
          enabled: true,
          acceptedAt: "2026-07-18T07:31:52.606Z",
        },
      },
    },
    failureCount: 0,
    conflictCount: 0,
  };
}

function song(canonicalSongId, externalSongId, displayTitle, displayArtist) {
  return {
    canonicalSongId,
    externalSongId,
    displayTitle,
    displayArtist,
    sourceSystem: SOURCE_SYSTEM,
    sourceUrl: `https://vsinger-moment.jp/songs/${externalSongId}`,
  };
}

function video(youtubeVideoId, externalVideoId, streamedAt) {
  return {
    youtubeVideoId,
    externalVideoId,
    title: `Stream ${externalVideoId}`,
    singerName: "Singer",
    streamedAt,
    sourceUrl: `https://vsinger-moment.jp/videos/${externalVideoId}`,
    verificationStatus: "externally_reported",
  };
}

function occurrence(youtubeVideoId, externalVideoId, canonicalSongId, externalSongId, seconds) {
  return {
    youtubeVideoId,
    externalVideoId,
    canonicalSongId,
    externalSongId,
    seconds,
    sourceSystem: SOURCE_SYSTEM,
  };
}
