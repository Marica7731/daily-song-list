const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isBlockedSongEntry,
  filterPayloadBlockedSources,
  isBlockedSource,
} = require("../assets/source-filter");

test("source filter removes blocked HK/TW VTuber channels without matching ordinary song titles", () => {
  assert.equal(isBlockedSource({ channelName: "CheukCat Ch. 綽貓喵", title: "歌雜 / HKVtuber" }), true);
  assert.equal(isBlockedSource({ channelName: "AZKi Channel", title: "奔跑日記！ / 米亞 MYA" }), false);
  assert.equal(isBlockedSongEntry({ title: "DEN Q~~~", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "DEN Q~~~", artist: "Known Artist" }), false);

  const payload = {
    source: { name: "fixture" },
    groups: {
      "72h": {
        items: [
          video("blocked", "CheukCat Ch. 綽貓喵", "奔跑日記！"),
          {
            ...video("kept", "AZKi Channel", "奔跑日記！ / 米亞 MYA"),
            songs: [
              { title: "奔跑日記！", artist: "米亞 MYA", seconds: 1, time: "0:00:01" },
              { title: "DQ", artist: "未記載", seconds: 2, time: "0:00:02" },
              { title: "DEN Q~~~", artist: "未記載", seconds: 3, time: "0:00:03" },
            ],
          },
        ],
      },
      "1m": {
        items: [video("kept-month", "AZKi Channel", "歌枠")],
      },
    },
  };

  const filtered = filterPayloadBlockedSources(payload);

  assert.deepEqual(
    filtered.groups["72h"].items.flatMap((item) => item.songs.map((song) => song.title)),
    ["奔跑日記！"],
  );
  assert.deepEqual(
    filtered.groups["1m"].items.map((item) => item.videoId),
    ["kept-month"],
  );
  assert.equal(filtered.source.clientFilteredBlockedSourceCount, 1);
  assert.equal(filtered.source.clientFilteredBlockedSongCount, 2);
  assert.equal(payload.groups["72h"].items.length, 2);
});

function video(videoId, channelName, title) {
  return {
    videoId,
    channelName,
    title,
    songs: [{ title, artist: "未記載", seconds: 1, time: "0:00:01" }],
  };
}
