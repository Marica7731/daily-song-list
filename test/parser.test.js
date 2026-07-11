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

test("rejects chapter timelines that are not songs", () => {
  const songs = parseTimestampSongs([
    [
      "0:02:08 今週スケジュール出ません",
      "0:28:43 欲しいギターとマイクのお話",
      "1:30:10 良い音",
      "1:32:04 先生の手癖",
      "2:43:11 チャット読み、ギフトは読めません",
    ].join("\n"),
  ]);

  assert.deepEqual(songs, []);
});

test("rejects setup noises even when separated like artist fields", () => {
  const songs = parseTimestampSongs(["0:00:21 音入り / 咳払い"]);

  assert.deepEqual(songs, []);
});

test("keeps explicit song and artist rows", () => {
  const songs = parseTimestampSongs(["0:39:01 06. ダイアモンド クレバス／シェリル・ノーム starring May'n"]);

  assert.equal(songs.length, 1);
  assert.equal(songs[0].title, "ダイアモンド クレバス");
  assert.equal(songs[0].artist, "シェリル・ノーム starring May'n");
});

test("strips leading custom emoji aliases from song titles", () => {
  const songs = parseTimestampSongs(["7:16 :_light1:ワールドイズマイン / ryo(supercell) feat. 初音ミク"]);

  assert.equal(songs.length, 1);
  assert.equal(songs[0].title, "ワールドイズマイン");
});

test("keeps song titles that contain greeting-like words", () => {
  const songs = parseTimestampSongs(["08. 1:31:32 金曜日のおはよう（HoneyWorks）"]);

  assert.equal(songs.length, 1);
  assert.equal(songs[0].title, "金曜日のおはよう");
});

test("keeps emoji performer markers without treating them as song titles", () => {
  const songs = parseTimestampSongs([
    ["20:45 ワールド・ランプシェード / 💡", "𝟎𝟑. 0:17:10 again✦Yui（🐝×💡）"].join("\n"),
  ]);

  assert.deepEqual(
    songs.map((song) => song.title),
    ["again", "ワールド・ランプシェード"],
  );
  assert.deepEqual(
    songs.map((song) => song.artist),
    ["Yui（🐝×💡）", "未記載"],
  );
});

test("keeps song title before trailing timestamp", () => {
  const songs = parseTimestampSongs(["🎶 Climax Jump 00:20:14"]);

  assert.equal(songs.length, 1);
  assert.equal(songs[0].time, "0:20:14");
  assert.equal(songs[0].title, "Climax Jump");
});

test("does not reject song titles that contain farewell text", () => {
  const songs = parseTimestampSongs(["06. 1:20:34 またね幻 / ずっと真夜中でいいのに。"]);

  assert.equal(songs.length, 1);
  assert.equal(songs[0].title, "またね幻");
  assert.equal(songs[0].artist, "ずっと真夜中でいいのに。");
});

test("rejects tree child notes and channel metrics", () => {
  const songs = parseTimestampSongs([
    [
      "└8:31 曲始まり",
      "00:06 オープニング",
      "11:55 登場",
      "0:19:30 OBSが散らかっているIRyS",
      "0:38:26 登録者数9.1万人",
      "2:29:40 高評価、ch登録してくれると嬉しいな",
    ].join("\n"),
  ]);

  assert.deepEqual(songs, []);
});

test("still rejects plain greeting and topic comments", () => {
  const songs = parseTimestampSongs([
    [
      "06:40 こんにちはー！緋八マナです！",
      "4:53 こんばんは？",
      "13:46 ここだけの話",
      "25:37 💡おめでとう🐝🤣ありがとう",
      "0:42:25 👏300達成（5秒前）",
      "1:29:06 お手洗い休憩（チャットお題:お昼ご飯は？）",
      "6/13 弾き語り& 雑談 23:30まで",
      "1:07 開始 / ずっと虚空に向かって話していたいろは殿:_kusa:",
      "┣11:30 生誕ライブにゲストでよく呼ばれるのでクリックあるものだと思ってしまった",
      "┗12:31 クリックとは",
      "16:21 爆裂ハイテンションなござるさん / そらちゃんのチャンネルで爆裂愛してるの歌ってみた上がってます！",
      "1:07:43 メモは紙に書くいろは殿 / 明日の曲について書いた独特すぎるメモ:_kusa",
    ].join("\n"),
  ]);

  assert.deepEqual(songs, []);
});
