const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  filterNonRegressiveImports,
  inputDirsFromArgs,
  isImportableSong,
  isStrictSongSubset,
  normalizeImportedVideo,
  projectRelativePath,
  readDiscoveryVideos,
} = require("../scripts/import-channel-discovery");
const { buildInputSummaries } = require("../scripts/export-channel-discovery-increment");
const { createSongAliasContext } = require("../scripts/song-aliases");

function auditOptions(overrides = {}) {
  return {
    supplementalKnownSongs: [],
    songSearchIndex: { titleKeys: [], titleArtistKeys: [] },
    songAliasContext: createSongAliasContext({ schemaVersion: 1, records: [] }),
    ...overrides,
  };
}

test("input dirs accept repeated CLI values and positional fallback", () => {
  const first = path.resolve("artifacts/channel-discovery/a");
  const second = path.resolve("artifacts/channel-discovery/b");
  assert.deepEqual(inputDirsFromArgs({ "input-dir": ["artifacts/channel-discovery/a", "artifacts/channel-discovery/b"] }), [first, second]);
  assert.deepEqual(inputDirsFromArgs({ _: ["artifacts/channel-discovery/a"] }), [first]);
});

test("channel discovery import reads usable details and preserves provenance", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-discovery-import-"));
  fs.writeFileSync(
    path.join(dir, "video-details.json"),
    JSON.stringify([
      {
        videoId: "AAAAAAAAAAA",
        title: "歌枠",
        channelName: "Noa",
        channelId: "UC_NOA",
        channelHandle: "/@noa_polaris",
        channelAvatarUrl: "https://yt3.ggpht.com/noa=s240",
        publishedTimestamp: Date.parse("2026-07-18T00:00:00Z"),
        publishedText: "2026-07-18",
        durationText: "1:23:45",
        thumbnailUrl: "https://example.test/noa-thumb.jpg",
        discoverySourceUrls: ["https://www.youtube.com/@noa_polaris/streams"],
        discoverySingerName: "Noa",
        discoveryChannelUrl: "https://www.youtube.com/@noa_polaris",
        selectedSourceId: "comment:1",
        selectedSourceHash: "hash-1",
        matchedKeywords: ["歌"],
        songs: [
          {
            time: "00:30",
            seconds: 30,
            title: "枠Start",
            artist: "未記載",
            raw: "0:30 枠Start",
          },
          {
            time: "12:34",
            seconds: 754,
            title: "少女レイ",
            artist: "みきとP",
            raw: "12:34 少女レイ / みきとP",
            rawHash: "raw-1",
            sourceId: "comment:1",
            sourceHash: "hash-1",
          },
        ],
      },
      { videoId: "BBBBBBBBBBB", title: "empty", songs: [] },
      { videoId: "not-valid", title: "bad", songs: [{ title: "x" }] },
    ]),
    "utf8",
  );

  const { videos, stats } = readDiscoveryVideos([dir], auditOptions());
  assert.equal(videos.length, 1);
  assert.equal(stats.videoDetails, 3);
  assert.equal(stats.usableVideos, 1);
  assert.equal(stats.skippedNoSongs, 1);
  assert.equal(stats.skippedInvalidVideoId, 1);
  assert.equal(stats.songs, 1);
  assert.equal(stats.videosWithPublishedTimestamp, 1);
  assert.equal(stats.videosWithThumbnail, 1);
  assert.equal(stats.songsWithTimestamp, 1);
  assert.equal(stats.rawSongCandidates, 3);
  assert.equal(stats.acceptedSongs, 1);
  assert.equal(stats.failedSongs, 1);
  assert.equal(stats.skippedSongs, 1);
  assert.equal(stats.suspiciousSongs, 0);
  assert.equal(stats.preImportAudit.totals.raw.videoDetails, 3);
  assert.equal(stats.preImportAudit.totals.raw.songCandidates, 3);
  assert.equal(stats.preImportAudit.totals.cleaned.videos.accepted, 1);
  assert.equal(stats.preImportAudit.totals.cleaned.videos.failed, 1);
  assert.equal(stats.preImportAudit.totals.cleaned.videos.withSuspiciousRows, 0);
  assert.equal(stats.preImportAudit.totals.cleaned.songs.accepted, 1);
  assert.equal(stats.preImportAudit.totals.cleaned.songs.suspicious, 0);
  assert.equal(stats.preImportAudit.totals.reasons.skipped.rule_rejected_non_song, 1);
  assert.equal(Boolean(stats.preImportAudit.caseSamples.rule_rejected_non_song?.length), true);
  assert.equal(Array.isArray(stats.preImportAudit.channelSummaries), true);
  assert.equal(stats.inputSummaries[0].usableVideos, 1);
  assert.equal(stats.inputSummaries[0].preImportAudit.raw.songCandidates, 3);
  assert.equal(videos[0].sourceGroups.includes("youtube_channel_discovery"), true);
  assert.equal(videos[0].sourceUrls.includes("https://www.youtube.com/@noa_polaris/streams"), true);
  assert.equal(videos[0].sourceUrls.includes("https://www.youtube.com/watch?v=AAAAAAAAAAA"), true);
  assert.equal(videos[0].thumbnailUrl, "https://example.test/noa-thumb.jpg");
  assert.equal(videos[0].channelAvatarUrl, "https://yt3.ggpht.com/noa=s240");
  assert.equal(videos[0].publishedText, "2026-07-18");
  assert.equal(videos[0].durationText, "1:23:45");
  assert.deepEqual(videos[0].songs.map((song) => song.title), ["少女レイ"]);
  assert.equal(videos[0].songs[0].sourceId, "comment:1");
});

test("pre-import audit blocks suspicious rows until a reviewed exception exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-discovery-preimport-audit-"));
  fs.writeFileSync(
    path.join(dir, "video-details.json"),
    JSON.stringify([
      {
        videoId: "EEEEEEEEEEE",
        title: "歌枠",
        channelName: "Audit Channel",
        thumbnailUrl: "https://example.test/thumb.jpg",
        songs: [
          {
            time: "00:10",
            seconds: 10,
            title: "Hidden Gem",
            artist: "未記載",
            raw: "00:10 Hidden Gem",
            rawHash: "raw-hidden-gem",
          },
          {
            time: "01:20",
            seconds: 80,
            title: "ガイドメロディのあるカラオケで歌いなおします",
            artist: "I'll Re-sing It with Guide Melody Karaoke",
            raw: "01:20 ガイドメロディのあるカラオケで歌いなおします / I'll Re-sing It with Guide Melody Karaoke",
            rawHash: "raw-translation",
          },
          {
            time: "02:30",
            seconds: 150,
            title: "【OP】Start",
            artist: "未記載",
            raw: "02:30 【OP】Start",
            rawHash: "raw-op",
          },
        ],
      },
    ]),
    "utf8",
  );

  const blocked = readDiscoveryVideos([dir], auditOptions());
  assert.equal(blocked.videos.length, 0);
  assert.equal(blocked.stats.preImportAudit.totals.cleaned.videos.withSuspiciousRows, 1);
  assert.equal(blocked.stats.preImportAudit.totals.cleaned.songs.suspicious, 1);
  assert.equal(blocked.stats.preImportAudit.totals.cleaned.songs.skipped, 2);
  assert.equal(blocked.stats.preImportAudit.totals.reasons.suspicious.single_occurrence_without_artist, 1);
  assert.equal(blocked.stats.preImportAudit.totals.reasons.skipped.translation_split_as_artist, 1);
  assert.equal(blocked.stats.preImportAudit.totals.reasons.skipped.timeline_marker_pollution, 1);
  assert.equal(blocked.stats.preImportAudit.suspiciousQueue.length, 1);

  const reviewed = readDiscoveryVideos([dir], auditOptions({
    auditExceptions: {
      accepted: [
        {
          id: "review-hidden-gem",
          videoId: "EEEEEEEEEEE",
          rawHash: "raw-hidden-gem",
          reviewedBy: "operator",
          reason: "manual source confirms title-only song row",
        },
      ],
    },
  }));
  assert.equal(reviewed.videos.length, 1);
  assert.deepEqual(reviewed.videos[0].songs.map((song) => song.title), ["Hidden Gem"]);
  assert.equal(reviewed.stats.preImportAudit.totals.reasons.acceptedExceptions, 1);
  assert.equal(reviewed.stats.preImportAudit.totals.cleaned.songs.accepted, 1);
  assert.equal(reviewed.stats.preImportAudit.totals.cleaned.songs.suspicious, 0);
  assert.equal(reviewed.stats.preImportAudit.totals.cleaned.songs.skipped, 2);
});

test("pre-import audit backfills artists and canonicalizes accepted aliases before import", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-discovery-preimport-backfill-"));
  fs.writeFileSync(
    path.join(dir, "video-details.json"),
    JSON.stringify([
      {
        videoId: "GGGGGGGGGGG",
        title: "歌枠",
        channelName: "Audit Channel",
        thumbnailUrl: "https://example.test/thumb.jpg",
        songs: [{ time: "00:10", seconds: 10, title: "33「Calc.」", artist: "未記載", raw: "00:10 33「Calc.」 / ジミーサムP" }],
      },
    ]),
    "utf8",
  );

  const result = readDiscoveryVideos([dir]);

  assert.equal(result.videos.length, 1);
  assert.deepEqual(
    result.videos[0].songs.map((song) => [song.title, song.artist]),
    [["Calc.", "ジミーサムP"]],
  );
  assert.equal(result.videos[0].songs[0].originalTitle, "33「Calc.」");
  assert.equal(result.videos[0].songs[0].artistBackfill.reason, "source_context_raw_credit");
  assert.equal(result.stats.preImportAudit.totals.cleaned.songs.accepted, 1);
  assert.equal(result.stats.preImportAudit.totals.cleaned.songs.suspicious, 0);
});

test("pre-import audit blocks regional VTuber sources before import", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-discovery-preimport-blocked-"));
  fs.writeFileSync(
    path.join(dir, "video-details.json"),
    JSON.stringify([
      {
        videoId: "HHHHHHHHHHH",
        title: "歌枠",
        channelName: "Aruma Ch. 薬袋アルマ",
        channelHandle: "@ArumaCh",
        thumbnailUrl: "https://example.test/aruma.jpg",
        songs: [{ time: "00:10", seconds: 10, title: "晩餐歌", artist: "tuki.", raw: "00:10 晩餐歌 / tuki." }],
      },
    ]),
    "utf8",
  );

  const result = readDiscoveryVideos([dir]);

  assert.equal(result.videos.length, 0);
  assert.equal(result.stats.preImportAudit.totals.cleaned.videos.failed, 1);
  assert.equal(result.stats.preImportAudit.totals.reasons.failed.blocked_source, 1);
  assert.equal(result.stats.preImportAudit.caseSamples.blocked_source[0].channelName, "Aruma Ch. 薬袋アルマ");
});

test("channel discovery import filters narration, translation, and action rows", () => {
  assert.equal(
    isImportableSong({
      title: "ガイドメロディのあるカラオケで歌いなおします",
      artist: "I’ll Re-sing It with Guide Melody Karaoke",
      raw: "2:13:14 ガイドメロディのあるカラオケで歌いなおします / I’ll Re-sing It with Guide Melody Karaoke",
    }),
    false,
  );
  assert.equal(isImportableSong({ title: "喉が痛い", artist: "未記載", raw: "0:10 喉が痛い" }), false);
  assert.equal(isImportableSong({ title: "晩餐歌", artist: "tuki.", raw: "0:20 晩餐歌 / tuki." }), true);
});

test("normalizeImportedVideo maps detail song fields into catalog-ready videos", () => {
  const video = normalizeImportedVideo(
    {
      videoId: "CCCCCCCCCCC",
      title: "弾き語り",
      thumbnailUrl: "",
      sourceGroups: ["month"],
      sourceUrls: ["https://example.test/source"],
      songs: [{ seconds: 1, title: "Song", artist: "Artist", isNiche: true }],
    },
    "input-dir",
    [{ seconds: 1, title: "Song", artist: "Artist", isNiche: true }],
  );
  assert.equal(video.videoId, "CCCCCCCCCCC");
  assert.deepEqual(video.sourceGroups.sort(), ["month", "youtube_channel_discovery"]);
  assert.equal(video.thumbnailUrl, "https://i.ytimg.com/vi/CCCCCCCCCCC/hqdefault.jpg");
  assert.equal(video.songs[0].index, 1);
  assert.equal(video.songs[0].isNiche, true);
  assert.equal(video.qualityStatus, "usable");
});

test("normalizeImportedVideo stores repository-relative discovery input paths", () => {
  const inputDir = path.resolve("artifacts/channel-discovery/noa_polaris");
  const video = normalizeImportedVideo(
    {
      videoId: "DDDDDDDDDDD",
      title: "歌枠",
      songs: [{ seconds: 1, title: "Song", artist: "Artist" }],
    },
    inputDir,
    [{ seconds: 1, title: "Song", artist: "Artist" }],
  );
  assert.equal(video.discoveryImport.inputDir, "artifacts/channel-discovery/noa_polaris");
});

test("import skips duplicate videos that would replace a richer existing song list", () => {
  assert.equal(
    isStrictSongSubset(
      [
        { seconds: 10, title: "Song A", artist: "Artist" },
        { seconds: 20, title: "Song B", artist: "Artist" },
      ],
      [{ seconds: 10, title: "Song A", artist: "Artist" }],
    ),
    true,
  );
  assert.equal(isStrictSongSubset([{ seconds: 10, title: "Song A", artist: "Artist" }], [{ seconds: 10, title: "Song A", artist: "Artist" }]), false);
  const result = filterNonRegressiveImports(
    {
      videos: [
        {
          videoId: "AAAAAAAAAAA",
          songs: [
            { seconds: 10, title: "Song A", artist: "Artist" },
            { seconds: 20, title: "Song B", artist: "Artist" },
          ],
        },
      ],
    },
    [
      { videoId: "AAAAAAAAAAA", songs: [{ seconds: 10, title: "Song A", artist: "Artist" }] },
      { videoId: "BBBBBBBBBBB", songs: [{ seconds: 30, title: "Song C", artist: "Artist" }] },
    ],
  );
  assert.deepEqual(result.videos.map((video) => video.videoId), ["BBBBBBBBBBB"]);
  assert.equal(result.stats.skippedExistingRegressions, 1);
  assert.deepEqual(result.stats.skippedExistingRegressionVideoIds, ["AAAAAAAAAAA"]);
});

test("channel discovery export summaries include per-input counts, coverage, and failure reasons", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-discovery-export-summary-"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      channelUrl: "https://www.youtube.com/@overlay",
      singerName: "Overlay",
      generatedAt: "2026-07-19T01:00:00Z",
      candidateCount: 3,
      inspectedInLatestRun: 2,
      occurrenceCount: 1,
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "audits.json"),
    JSON.stringify([
      { videoId: "AAAAAAAAAAA", result: "selected" },
      { videoId: "BBBBBBBBBBB", result: "no_usable_song_source" },
      { videoId: "CCCCCCCCCCC", result: "fetch_error" },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "raw-videos.json"), JSON.stringify([{ youtubeVideoId: "AAAAAAAAAAA" }]), "utf8");
  const inputDir = projectRelativePath(dir);
  const acceptedVideo = {
    videoId: "AAAAAAAAAAA",
    publishedTimestamp: Date.parse("2026-07-18T00:00:00Z"),
    thumbnailUrl: "https://example.test/thumb.jpg",
    discoveryImport: { inputDir },
    songs: [{ seconds: 83, title: "Overlay Song", artist: "Overlay Artist" }],
  };
  const summaries = buildInputSummaries(
    [dir],
    {
      inputSummaries: [
        {
          inputDir,
          usableVideos: 1,
          skippedNoSongs: 1,
          skippedInvalidVideoId: 0,
          duplicateVideoIds: 0,
          rawSongCandidates: 2,
          preImportAudit: {
            raw: { videoDetails: 2, songCandidates: 2 },
            cleaned: {
              videos: { accepted: 1, skipped: 0, failed: 0, suspicious: 0, withSuspiciousRows: 1, withFailedRows: 0 },
              songs: { accepted: 1, skipped: 0, failed: 0, suspicious: 1 },
            },
            reasons: {
              skipped: {},
              failed: {},
              suspicious: { single_occurrence_without_artist: 1 },
              acceptedExceptions: 0,
              rejectedExceptions: 0,
            },
            caseSamples: { rule_rejected_non_song: [{ title: "おはようございます" }] },
            channelSummaries: [{ channelName: "Overlay", rawCandidates: 2, accepted: 1, dropped: 0, suspicious: 1 }],
            suspiciousItems: [{ videoId: "AAAAAAAAAAA", songs: [{ title: "Needs Review" }] }],
            suspiciousQueue: [{ videoId: "AAAAAAAAAAA", songs: [{ title: "Needs Review" }] }],
          },
        },
      ],
    },
    [acceptedVideo],
    [acceptedVideo],
    { stats: { skippedExistingRegressionVideoIds: [] } },
  );

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].imported, 1);
  assert.equal(summaries[0].skipped, 1);
  assert.equal(summaries[0].failed, 2);
  assert.equal(summaries[0].suspicious, 1);
  assert.equal(summaries[0].rawCandidates.videos, 2);
  assert.equal(summaries[0].rawCandidates.songs, 2);
  assert.deepEqual(summaries[0].failedReasons, { fetch_error: 1, no_usable_song_source: 1 });
  assert.deepEqual(summaries[0].suspiciousReasons, { single_occurrence_without_artist: 1 });
  assert.equal(summaries[0].caseSamples.rule_rejected_non_song[0].title, "おはようございます");
  assert.equal(summaries[0].preImportAudit.channelSummaries[0].channelName, "Overlay");
  assert.equal(summaries[0].preImportAudit.suspiciousItems.length, 1);
  assert.equal(summaries[0].suspiciousQueue[0].songs[0].title, "Needs Review");
  assert.equal(summaries[0].increments.occurrences, 1);
  assert.equal(summaries[0].coverage.acceptedVideos.thumbnailUrl.covered, 1);
});
