const test = require("node:test");
const assert = require("node:assert/strict");
const { parseTimestampSongs, timeToSeconds } = require("../scripts/song-utils");

test("parses timestamp before song index without truncating minutes", () => {
  const songs = parseTimestampSongs([
    [
      "08:53      01.  曖昧劣情Lover (Aimai Retsujou Lover) // 電ポルP (koyori)",
      "17:48      02.  エイリアンズ (Aliens) // キリンジ (Kirinji)",
      "26:16      03.  This Love // Angela Aki",
      "1:03:30    08. 蝶々結び (Choucho Musubi) // Aimer",
    ].join("\n"),
  ]);

  assert.deepEqual(
    songs.map((song) => song.time),
    ["0:08:53", "0:17:48", "0:26:16", "1:03:30"],
  );
  assert.deepEqual(
    songs.map((song) => song.title),
    ["曖昧劣情Lover", "エイリアンズ", "This Love", "蝶々結び"],
  );
  assert.deepEqual(
    songs.map((song) => song.artist),
    ["電ポルP", "キリンジ", "Angela Aki", "Aimer"],
  );
});

test("rejects timestamped regular comment sentences", () => {
  const songs = parseTimestampSongs([
    ["1:45:24 むあんちゃん with JOY子の寄り酔いも", "2:49:33 COOLな酔いどれ知らずも良すぎてするする晩酌が進みました"].join(
      "\n",
    ),
  ]);

  assert.deepEqual(songs, []);
});

test("filters common non-song timestamp sections", () => {
  const songs = parseTimestampSongs([
    [
      "0:00:43　声入り",
      "┗━━ 0:14:32　Talk_01",
      "01:23 ご挨拶",
      "0:03:04 アナウンス",
      "0:10:02 自己紹介",
      "0:48:10 MaiR→七海うらら",
      "0:02:44 ・ スタート",
      "0:09:56　魔法／tayori",
    ].join("\n"),
  ]);

  assert.equal(songs.length, 1);
  assert.equal(songs[0].title, "魔法");
  assert.equal(songs[0].artist, "tayori");
});

test("parses split number start end song blocks using start time", () => {
  const songs = parseTimestampSongs([
    [
      "《 セットリスト 》",
      "1",
      "4:55~",
      "7:52",
      "├ \"超\" インフルエンサー→☆ (松永依織)",
      "└ (Chou Influencer)",
      "2",
      "14:52~",
      "19:07",
      "└ ロキ / Loki (みきとP)",
    ].join("\n"),
  ]);

  assert.deepEqual(
    songs.map((song) => song.time),
    ["0:04:55", "0:14:52"],
  );
  assert.deepEqual(
    songs.map((song) => song.title),
    ['"超" インフルエンサー→☆', "ロキ"],
  );
});

test("builds seconds for YouTube t parameter", () => {
  assert.equal(timeToSeconds("1:03:30"), 3810);
});
