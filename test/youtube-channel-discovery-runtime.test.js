const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadYoutubeChannelDiscoveryRuntimeVideos, normalizeRuntimeVideo } = require("../scripts/youtube-channel-discovery-runtime");

test("runtime discovery rejects channel URL paths as handles", () => {
  const video = normalizeRuntimeVideo(
    {
      videoId: "RUNTIME0001",
      title: "歌枠",
      channelName: "Runtime Channel",
      channelId: "UC_RUNTIME",
      channelHandle: "/channel/UC_RUNTIME",
      channelUrl: "https://www.youtube.com/channel/UC_RUNTIME",
      songs: [{ seconds: 1, title: "Song", artist: "Artist" }],
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
      songs: [{ seconds: 1, title: "Song", artist: "Artist" }],
    },
    "runtime.json",
  );

  assert.equal(video.channelHandle, "/@runtime_handle");
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
      ],
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(acceptedDir, "isshiki.json"),
    JSON.stringify({
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
      ],
    }),
    "utf8",
  );

  const payload = loadYoutubeChannelDiscoveryRuntimeVideos({ importDir: dir, required: true });
  assert.equal(payload.videos.length, 1);
  assert.equal(payload.videos[0].channelName, "一色イズ◇Isshiki IS");
  assert.equal(payload.videos[0].channelHandle, "/@IsshikiIS");
  assert.equal(payload.videos[0].channelAliases.includes("/channel/UCISSHIKI"), false);
});
