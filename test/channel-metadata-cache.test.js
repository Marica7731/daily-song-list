const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { hydratePayloadWithChannelMetadata } = require("../scripts/channel-metadata-cache");

test("channel metadata hydration prefers Japanese display names and preserves aliases", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-metadata-alias-"));
  const metadataPath = path.join(dir, "channel-metadata.json");
  fs.writeFileSync(
    metadataPath,
    JSON.stringify({
      channels: [
        {
          channelId: "UCisshiki",
          handle: "@IsshikiIS",
          displayName: "一色イズ◇Isshiki IS",
          channelUrl: "https://www.youtube.com/@IsshikiIS",
          knownSourceType: "youtube_channel_discovery",
        },
        {
          channelId: "UCnKt20HH_BiuID0FDHGMcvw",
          displayName: "IMI",
          channelUrl: "https://www.youtube.com/channel/UCnKt20HH_BiuID0FDHGMcvw",
        },
      ],
    }),
    "utf8",
  );

  const payload = hydratePayloadWithChannelMetadata(
    {
      groups: {
        all: {
          items: [
            {
              videoId: "ISSHIKI0001",
              title: "karaoke",
              channelName: "Isshiki Izu",
              channelId: "UCisshiki",
              channelHandle: "/channel/UCisshiki",
              channelAliases: ["/channel/UCisshiki", "Isshiki Izu"],
              songs: [{ title: "song", artist: "artist", seconds: 1 }],
            },
            {
              videoId: "IMI000000001",
              title: "karaoke",
              channelName: "UCnKt20HH_BiuID0FDHGMcvw",
              channelId: "UCnKt20HH_BiuID0FDHGMcvw",
              channelHandle: "/channel/UCnKt20HH_BiuID0FDHGMcvw",
              songs: [{ title: "song", artist: "artist", seconds: 2 }],
            },
            {
              videoId: "ISSHIKI0002",
              title: "accepted karaoke",
              channelName: "Isshiki Izu",
              channelId: "UCisshiki",
              knownSourceType: "youtube_channel_discovery",
              isCollected: true,
              sourceGroups: ["youtube_channel_discovery"],
              songs: [{ title: "song", artist: "artist", seconds: 3 }],
            },
          ],
        },
      },
    },
    { metadataPath },
  );

  const item = payload.groups.all.items[0];
  assert.equal(item.channelName, "一色イズ◇Isshiki IS");
  assert.equal(item.channelHandle, "/@IsshikiIS");
  assert.deepEqual(item.channelAliases, ["Isshiki Izu", "一色イズ◇Isshiki IS", "/@IsshikiIS"]);
  assert.equal(item.knownSourceType, undefined);
  assert.equal(item.isCollected, undefined);
  const imiItem = payload.groups.all.items[1];
  assert.equal(imiItem.channelName, "IMI");
  assert.equal(imiItem.channelHandle, "");
  const acceptedItem = payload.groups.all.items[2];
  assert.equal(acceptedItem.knownSourceType, "youtube_channel_discovery");
  assert.equal(acceptedItem.isCollected, true);
  assert.deepEqual(acceptedItem.sourceGroups, ["youtube_channel_discovery"]);
});

test("channel avatar metadata producer remains identity-only", () => {
  const producerSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "fetch-channel-avatar-cache.js"), "utf8");
  assert.doesNotMatch(producerSource, /knownSourceType/u);
});
