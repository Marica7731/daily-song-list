const assert = require("node:assert/strict");
const test = require("node:test");
const { parseTimestampSongs, repairPublishedSongMetadata } = require("../scripts/song-utils");

test("timestamp parser removes the explicit list ordinal but retains a numeric song title and source evidence", () => {
  const raw = "00:20:29 | 01. 1 2 3 〜恋がはじまる〜 / いきものがかり";
  const songs = parseTimestampSongs([raw]);
  assert.equal(songs.length, 1);
  const { title, artist, time, seconds, raw: source } = songs[0];
  assert.deepEqual({ title, artist, time, seconds, source }, {
    title: "1 2 3 〜恋がはじまる〜",
    artist: "いきものがかり",
    time: "0:20:29",
    seconds: 1229,
    source: raw,
  });
});

test("short numeric titles survive explicit ordinals and ordinary bare ordinal parsing is unchanged", () => {
  for (const [line, title] of [
    ["00:20:29 | 01. 17 / 椎名林檎", "17"],
    ["00:20:29 | [01] 17 / 椎名林檎", "17"],
    ["00:20:29 | 01. Lemon / 米津玄師", "Lemon"],
    ["00:20:29 | 01 Lemon / 米津玄師", "Lemon"],
  ]) {
    assert.equal(parseTimestampSongs([line])[0]?.title, title, line);
  }
});

test("the publication repair already removes mathematical digit ordinals", () => {
  const raw = "01:05:53 𝟎𝟓. 斜陽／ヨルシカ";
  const repaired = repairPublishedSongMetadata({ title: "𝟎𝟓. 斜陽", artist: "ヨルシカ", raw });
  assert.equal(repaired.title, "斜陽");
  assert.equal(repaired.artist, "ヨルシカ");
});
