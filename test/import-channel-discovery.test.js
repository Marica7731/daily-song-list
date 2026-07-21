const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  auditDiscoverySongs,
  filterNonRegressiveImports,
  inputDirsFromArgs,
  isStrictSongSubset,
  normalizeImportedVideo,
  readDiscoveryVideos,
} = require("../scripts/import-channel-discovery");

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
        thumbnailUrl: "https://example.test/noa-thumb.jpg",
        publishedTimestamp: Date.parse("2026-07-18T00:00:00Z"),
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
          {
            time: "13:00",
            seconds: 780,
            title: "Brave Shine",
            artist: "Aimer Start",
            raw: "13:00 Brave Shine / Aimer Start",
          },
        ],
      },
      { videoId: "BBBBBBBBBBB", title: "empty", songs: [] },
      { videoId: "not-valid", title: "bad", songs: [{ title: "x" }] },
    ]),
    "utf8",
  );

  const { videos, stats } = readDiscoveryVideos([dir]);
  assert.equal(videos.length, 1);
  assert.equal(stats.videoDetails, 3);
  assert.equal(stats.usableVideos, 1);
  assert.equal(stats.skippedNoSongs, 1);
  assert.equal(stats.skippedInvalidVideoId, 1);
  assert.equal(stats.songs, 2);
  assert.equal(videos[0].sourceGroups.includes("youtube_channel_discovery"), true);
  assert.equal(videos[0].sourceUrls.includes("https://www.youtube.com/@noa_polaris/streams"), true);
  assert.equal(videos[0].sourceUrls.includes("https://www.youtube.com/watch?v=AAAAAAAAAAA"), true);
  assert.deepEqual(videos[0].songs.map((song) => `${song.title} / ${song.artist}`), ["少女レイ / みきとP", "Brave Shine / Aimer"]);
  assert.equal(videos[0].songs[0].sourceId, "comment:1");
  assert.equal(videos[0].thumbnailUrl, "https://example.test/noa-thumb.jpg");
});

test("channel discovery import audits dirty source rows before accepting songs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-discovery-import-audit-"));
  fs.writeFileSync(
    path.join(dir, "video-details.json"),
    JSON.stringify([
      discoveryDetail({
        videoId: "NARAE000001",
        channelName: "なれたん Naraetan Ch.",
        channelHandle: "/@naraetanV",
        discoveryChannelUrl: "https://www.youtube.com/@naraetanV",
        songs: [
          song("0:01", "曲名教えてください", "未記載", "0:01 曲名教えてください"),
          song("0:02", "缶をマイクに", "Using a Can as a Microphone", "0:02 缶をマイクに / Using a Can as a Microphone"),
          song("0:03", "START", "未記載", "0:03 START"),
          song("0:04", "START", "愛内里菜", "0:04 START / 愛内里菜"),
          song("0:05", "START:DASH!!", "μ's", "0:05 START:DASH!! / μ's"),
        ],
      }),
      discoveryDetail({
        videoId: "HANON000001",
        channelName: "Hanon Ch. 香鳴ハノン【パレプロ】",
        channelHandle: "/@kanaruhanon",
        discoveryChannelUrl: "https://www.youtube.com/@kanaruhanon",
        songs: [
          song("0:11", "おつはのちゅっちゅる〜！", "未記載", "0:11 おつはのちゅっちゅる〜！"),
          song("0:12", "次のバトンは香鳴ハノンちゃん", "未記載", "0:12 次のバトンは香鳴ハノンちゃん"),
          song("0:13", "ENDLESS STORY", "REIRA starring YUNA ITO", "0:13 ENDLESS STORY / REIRA starring YUNA ITO"),
        ],
      }),
      discoveryDetail({
        videoId: "PANNO000001",
        channelName: "パン野実々美 / Panno Mimimi",
        channelHandle: "/@pannomimimi",
        discoveryChannelUrl: "https://www.youtube.com/@pannomimimi",
        songs: [
          song("0:21", "公開した音声の正体", "The identity of the released audio", "0:21 公開した音声の正体 / The identity of the released audio"),
          song("0:22", "『公開メモ』", "未記載", "0:22 『公開メモ』"),
          song("0:23", "花に亡霊", "ヨルシカ", "0:23 花に亡霊 / ヨルシカ"),
        ],
      }),
      discoveryDetail({
        videoId: "KISAKI00001",
        title: "フルート生演奏 live source audit fixture",
        channelName: "Kisaki",
        channelHandle: "/@kisaki",
        discoveryChannelUrl: "https://www.youtube.com/@kisaki",
        songs: [
          song("0:31", "あなたへ贈る歌", "erica", "0:31 あなたへ贈る歌 / erica"),
          song("0:32", "ちるえも、こそこそ話", "就寝させない爆音EDテーマ", "0:32 ちるえも、こそこそ話 / 就寝させない爆音EDテーマ"),
          song("0:33", "メンシが取れてる、、、悲しい", "の事情", "0:33 メンシが取れてる、、、悲しい / の事情"),
        ],
      }),
    ]),
    "utf8",
  );

  const { videos, stats } = readDiscoveryVideos([dir]);

  assert.deepEqual(
    videos.flatMap((video) => video.songs.map((item) => `${video.channelHandle}:${item.title} / ${item.artist}`)),
    [
      "/@naraetanV:START / 愛内里菜",
      "/@naraetanV:START:DASH!! / μ's",
      "/@kanaruhanon:ENDLESS STORY / REIRA starring YUNA ITO",
      "/@pannomimimi:花に亡霊 / ヨルシカ",
    ],
  );
  assert.equal(videos.some((video) => video.channelHandle === "/@kisaki"), false);
  assert.equal(stats.rawSongs, 14);
  assert.equal(stats.acceptedSongs, 4);
  assert.equal(stats.droppedSongs, 9);
  assert.equal(stats.suspiciousSongs, 1);
  assert.equal(stats.importAudit.dropped.some((entry) => entry.reason === "song_request_instruction" && entry.channel.handle === "/@naraetanV"), true);
  assert.equal(stats.importAudit.dropped.some((entry) => entry.reason === "likely_non_song_entry" && entry.channel.handle === "/@pannomimimi"), true);
  assert.deepEqual(
    stats.importAudit.dropped
      .filter((entry) => entry.channel.handle === "/@kisaki")
      .map((entry) => `${entry.reason}:${entry.title} / ${entry.artist}`),
    [
      "excluded_source_context:あなたへ贈る歌 / erica",
      "excluded_source_context:ちるえも、こそこそ話 / 就寝させない爆音EDテーマ",
      "excluded_source_context:メンシが取れてる、、、悲しい / の事情",
    ],
  );
  assert.deepEqual(Object.keys(stats.importAudit.suspicious[0]).filter((key) => ["channel", "video", "sourceText", "title", "artist", "reason"].includes(key)), [
    "channel",
    "video",
    "sourceText",
    "title",
    "artist",
    "reason",
  ]);
  assert.equal(stats.importAudit.suspicious[0].channel.handle, "/@pannomimimi");

  const directAudit = auditDiscoverySongs(
    discoveryDetail({
      videoId: "DIRECT00001",
      channelName: "direct",
      channelHandle: "/@direct",
      discoveryChannelUrl: "https://www.youtube.com/@direct",
      songs: [song("0:01", "Opening", "Known Artist", "0:01 Opening / Known Artist"), song("0:02", "Opening", "未記載", "0:02 Opening")],
    }),
  );
  assert.deepEqual(directAudit.accepted.map((item) => `${item.title} / ${item.artist}`), ["Opening / Known Artist"]);
  assert.equal(directAudit.dropped.length + directAudit.suspicious.length, 1);
});

test("normalizeImportedVideo maps detail song fields into catalog-ready videos", () => {
  const video = normalizeImportedVideo(
    {
      videoId: "CCCCCCCCCCC",
      title: "弾き語り",
      sourceGroups: ["month"],
      sourceUrls: ["https://example.test/source"],
      songs: [{ seconds: 1, title: "Song", artist: "Artist", isNiche: true }],
    },
    "input-dir",
    [{ seconds: 1, title: "Song", artist: "Artist", isNiche: true }],
  );
  assert.equal(video.videoId, "CCCCCCCCCCC");
  assert.equal(video.thumbnailUrl, "https://i.ytimg.com/vi/CCCCCCCCCCC/hqdefault.jpg");
  assert.deepEqual(video.sourceGroups.sort(), ["month", "youtube_channel_discovery"]);
  assert.equal(video.songs[0].index, 1);
  assert.equal(video.songs[0].isNiche, true);
  assert.equal(video.qualityStatus, "usable");
});

test("channel discovery import backfills channel metadata within an input batch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-discovery-import-fallback-"));
  fs.writeFileSync(
    path.join(dir, "video-details.json"),
    JSON.stringify([
      {
        videoId: "EEEEEEEEEEE",
        title: "歌枠 1",
        channelName: "Real Channel",
        channelId: "UC_REAL",
        channelHandle: "/@real_handle",
        discoveryChannelUrl: "https://www.youtube.com/@real_handle/streams",
        songs: [{ time: "1:00", seconds: 60, title: "Song A", artist: "Artist" }],
      },
      {
        videoId: "FFFFFFFFFFF",
        title: "歌枠 2",
        discoverySingerName: "Fallback Name",
        discoveryChannelUrl: "https://www.youtube.com/@real_handle/streams",
        songs: [{ time: "2:00", seconds: 120, title: "Song B", artist: "Artist" }],
      },
    ]),
    "utf8",
  );

  const { videos } = readDiscoveryVideos([dir]);
  assert.deepEqual(
    videos.map((video) => [video.videoId, video.channelName, video.channelId, video.channelHandle]),
    [
      ["EEEEEEEEEEE", "Real Channel", "UC_REAL", "/@real_handle"],
      ["FFFFFFFFFFF", "Real Channel", "UC_REAL", "/@real_handle"],
    ],
  );
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

function discoveryDetail({ videoId, title = "歌枠 source audit fixture", channelName, channelHandle, discoveryChannelUrl, songs }) {
  return {
    videoId,
    title,
    channelName,
    channelHandle,
    discoveryChannelUrl,
    selectedSourceId: `comment:${videoId}`,
    selectedSourceHash: `hash:${videoId}`,
    songs,
  };
}

function song(time, title, artist, raw) {
  return {
    time,
    seconds: time
      .split(":")
      .map((part) => Number.parseInt(part, 10))
      .reduce((total, part) => total * 60 + part, 0),
    title,
    artist,
    raw,
    rawHash: `raw:${raw}`,
  };
}
