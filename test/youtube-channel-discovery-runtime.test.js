const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadYoutubeChannelDiscoveryRuntimeVideos, normalizeRuntimeVideo } = require("../scripts/youtube-channel-discovery-runtime");

function acceptedFixture(payload) {
  return {
    ...payload,
    videos: (payload.videos || []).map((video) => ({
      ...video,
      publishedTimestamp: video.publishedTimestamp || 1784937600000,
      songs: (video.songs || []).map((song) => ({
        ...song,
        time: song.time || `0:00:${String(song.seconds).padStart(2, "0")}`,
      })),
    })),
  };
}

test("runtime discovery rejects channel URL paths as handles", () => {
  const video = normalizeRuntimeVideo(
    {
      videoId: "RUNTIME0001",
      title: "歌枠",
      channelName: "Runtime Channel",
      channelId: "UC_RUNTIME",
      channelHandle: "/channel/UC_RUNTIME",
      channelUrl: "https://www.youtube.com/channel/UC_RUNTIME",
      publishedTimestamp: 1784937600000,
      songs: [{ time: "0:00:01", seconds: 1, title: "Song", artist: "Artist" }],
    },
    "runtime.json",
  );

  assert.equal(video.channelId, "UC_RUNTIME");
  assert.equal(video.channelHandle, "");
});

test("runtime discovery recovers handles from channel urls", () => {
  const video = normalizeRuntimeVideo(
    {
      videoId: "RUNTIME0002",
      title: "歌枠",
      channelName: "Runtime Channel",
      channelHandle: "/channel/UC_RUNTIME",
      channelUrl: "https://www.youtube.com/@runtime_handle",
      publishedTimestamp: 1784937600000,
      songs: [{ time: "0:00:01", seconds: 1, title: "Song", artist: "Artist" }],
    },
    "runtime.json",
  );

  assert.equal(video.channelHandle, "/@runtime_handle");
});

test("runtime discovery enforces accepted timestamp contracts without coercing zero seconds", () => {
  const base = {
    videoId: "CONTRACT001",
    title: "Contract fixture",
    channelName: "Contract Channel",
    publishedTimestamp: 1784937600000,
    songs: [{ time: "0:00:00", seconds: 0, title: "Song", artist: "Artist" }],
  };

  const valid = normalizeRuntimeVideo(base, "contract.json");
  assert.equal(valid.publishedTimestamp, 1784937600000);
  assert.equal(valid.songs[0].seconds, 0);
  assert.equal(valid.songs[0].time, "0:00:00");

  for (const publishedTimestamp of [null, undefined, "1784937600000", Number.NaN]) {
    assert.throws(
      () => normalizeRuntimeVideo({ ...base, publishedTimestamp }, "contract.json"),
      /file=contract\.json videoId=CONTRACT001 field=publishedTimestamp/,
    );
  }
  assert.throws(
    () => normalizeRuntimeVideo({ ...base, songs: [{ ...base.songs[0], time: " " }] }, "contract.json"),
    /file=contract\.json videoId=CONTRACT001 songIndex=0 field=time/,
  );
  for (const seconds of [-1, 0.5, "0", undefined]) {
    assert.throws(
      () => normalizeRuntimeVideo({ ...base, songs: [{ ...base.songs[0], seconds }] }, "contract.json"),
      /file=contract\.json videoId=CONTRACT001 songIndex=0 field=seconds/,
    );
  }
});

test("runtime discovery hydrates one channel id to the preferred Japanese display name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-channel-hydrate-"));
  const acceptedDir = path.join(dir, "accepted");
  fs.mkdirSync(acceptedDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "channel-metadata.json"),
    JSON.stringify({
      channels: [
        {
          channelId: "UCISSHIKI",
          handle: "/@IsshikiIS",
          displayName: "一色イズ◇Isshiki IS",
          sourceUrl: "https://www.youtube.com/@IsshikiIS",
        },
        {
          channelId: "UCnKt20HH_BiuID0FDHGMcvw",
          displayName: "IMI",
          sourceUrl: "https://www.youtube.com/channel/UCnKt20HH_BiuID0FDHGMcvw",
        },
      ],
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(acceptedDir, "isshiki.json"),
    JSON.stringify(acceptedFixture({
      generatedAt: "2026-07-22T00:00:00.000Z",
      videos: [
        {
          videoId: "ISSHIKI0001",
          title: "歌枠",
          channelName: "Isshiki Izu",
          channelId: "UCISSHIKI",
          channelHandle: "/channel/UCISSHIKI",
          channelUrl: "https://www.youtube.com/channel/UCISSHIKI",
          channelAliases: ["/channel/UCISSHIKI", "Isshiki Izu"],
          songs: [{ seconds: 10, title: "雑魚", artist: "柊マグネタイト" }],
        },
        {
          videoId: "IMI000000001",
          title: "歌枠",
          channelName: "UCnKt20HH_BiuID0FDHGMcvw",
          channelId: "UCnKt20HH_BiuID0FDHGMcvw",
          channelHandle: "/channel/UCnKt20HH_BiuID0FDHGMcvw",
          channelUrl: "https://www.youtube.com/channel/UCnKt20HH_BiuID0FDHGMcvw",
          songs: [{ seconds: 20, title: "ノープラン", artist: "IMI" }],
        },
      ],
    })),
    "utf8",
  );

  const payload = loadYoutubeChannelDiscoveryRuntimeVideos({ importDir: dir, required: true });
  assert.equal(payload.videos.length, 2);
  assert.equal(payload.videos[0].channelName, "一色イズ◇Isshiki IS");
  assert.equal(payload.videos[0].channelHandle, "/@IsshikiIS");
  assert.equal(payload.videos[0].channelAliases.includes("/channel/UCISSHIKI"), false);
  assert.equal(payload.videos[1].channelName, "IMI");
  assert.equal(payload.videos[1].channelHandle, "");
});

test("reviewed Hanon and Noa increments load with complete identity and timestamps", () => {
  const importDir = path.join(
    __dirname,
    "..",
    "data",
    "external",
    "youtube-channel-discovery",
  );
  const payload = loadYoutubeChannelDiscoveryRuntimeVideos({ importDir, required: true });
  const expected = new Map([
    ["aibg0-_tU6c", { channelHandle: "/@kanaruhanon", songCount: 4 }],
    ["mt55aKAdYqM", { channelHandle: "/@kanaruhanon", songCount: 12 }],
    ["HZ1q27Z5Pqc", { channelHandle: "/@noa_polaris", songCount: 14 }],
    ["0bXKzDEk79E", { channelHandle: "/@noa_polaris", songCount: 5 }],
  ]);

  for (const [videoId, fixture] of expected) {
    const video = payload.videos.find((candidate) => candidate.videoId === videoId);
    assert.ok(video, `${videoId} must be loaded from the reviewed accepted increments`);
    assert.equal(video.channelHandle, fixture.channelHandle);
    assert.equal(video.songs.length, fixture.songCount);
    assert.ok(Number.isFinite(video.publishedTimestamp) && video.publishedTimestamp > 0);
    assert.equal(video.songs.every((song) => Number.isInteger(song.seconds) && song.time), true);
  }
});
