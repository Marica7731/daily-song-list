const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadYoutubeChannelDiscoveryRuntimeVideos } = require("../scripts/youtube-channel-discovery-runtime");

test("runtime loader cleans accepted channel discovery overlays before DB export", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-discovery-runtime-"));
  const acceptedDir = path.join(root, "accepted");
  fs.mkdirSync(acceptedDir, { recursive: true });
  fs.writeFileSync(
    path.join(acceptedDir, "fixture.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceSystem: "youtube_channel_discovery",
      generatedAt: "2026-07-22T00:00:00.000Z",
      videos: [
        {
          videoId: "naradirty01",
          title: "Naraetan karaoke",
          channelName: "なれたん Naraetan Ch.",
          channelHandle: "@naraetanV",
          channelUrl: "https://www.youtube.com/@naraetanV",
          songs: [
            { title: "Calc", artist: "未記載", time: "0:01", seconds: 1, raw: "0:01 Calc. / ジミーサムP" },
            { title: "喉が痛い", artist: "未記載", time: "0:02", seconds: 2, raw: "0:02 喉が痛い / My throat hurts" },
            { title: "Overlay Song", artist: "Overlay Artist", time: "0:03", seconds: 3, raw: "0:03 Overlay Song / Overlay Artist" },
          ],
        },
        {
          videoId: "aruma000001",
          title: "Aruma karaoke",
          channelName: "Aruma Ch. 薬袋アルマ",
          channelHandle: "@ArumaCh",
          channelUrl: "https://www.youtube.com/@ArumaCh",
          songs: [{ title: "Blocked Song", artist: "Blocked Artist", time: "0:01", seconds: 1 }],
        },
      ],
    }),
    "utf8",
  );

  const result = loadYoutubeChannelDiscoveryRuntimeVideos({ importDir: root, required: true });

  assert.equal(result.summary.rawVideoCount, 2);
  assert.equal(result.summary.rawOccurrenceCount, 4);
  assert.equal(result.summary.videoCount, 1);
  assert.equal(result.summary.occurrenceCount, 2);
  assert.equal(result.summary.cleanup.blockedSources.removed, 1);
  assert.equal(result.summary.cleanup.curation.conversationDroppedEntries, 1);
  assert.equal(result.summary.cleanup.artistBackfill.filledCount, 1);
  assert.deepEqual(
    result.videos[0].songs.map((song) => [song.title, song.artist]),
    [
      ["Calc.", "ジミーサムP"],
      ["Overlay Song", "Overlay Artist"],
    ],
  );
});
