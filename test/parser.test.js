const test = require("node:test");
const assert = require("node:assert/strict");
const { isLikelyNonSongEntry, parseTimestampSongs, timeToSeconds } = require("../scripts/song-utils");

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

test("keeps decimal-looking numeric song titles while stripping real list indexes", () => {
  const songs = parseTimestampSongs([
    [
      "0:10 8.32 / *Luna",
      "0:20 2.500♪",
      "0:30 01. Song / Artist",
      "0:40 01) Another Song / Another Artist",
      "0:50 07.3月9日 / レミオロメン",
      "1:00 13.05410-(ん) / RADWIMPS",
    ].join("\n"),
  ]);

  assert.deepEqual(
    songs.map((song) => song.title),
    ["8.32", "2.500♪", "Song", "Another Song", "3月9日", "05410-(ん)"],
  );
  assert.deepEqual(
    songs.map((song) => song.artist),
    ["*Luna", "未記載", "Artist", "Another Artist", "レミオロメン", "RADWIMPS"],
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

test("rejects naretan commentary and request timestamps while keeping real song rows", () => {
  const songs = parseTimestampSongs([
    [
      "0:01 コメ「なれたんかわいい」",
      "0:02 アンケート結果",
      "0:03 喉が痛い",
      "0:04 配信について",
      "0:05 リクエストください",
      "0:06 コメント欄",
      "0:07 なれたん自己紹介",
      "0:08 星座になれたら / 結束バンド",
      "0:09 ENDLESS STORY / REIRA starring YUNA ITO",
      "0:10 Opening / Known Artist",
      "0:11 楽しみにしてろよ! / 練習後のなれたんを",
      "0:12 初めて日本の病院に行ってきました / I Went to a Japanese Hospital for the First Time",
      "0:13 韓国のちゃんぽん / Korean Jjamppong",
      "0:14 音楽停止（クリックミス） / Music stops (accidental click)",
      "0:15 FとPの発音 / Pronunciation of F and P",
      "0:16 食あたり / Food Poisoning",
      "0:17 お茶を飲みながら逆立ち / Handstand While Drinking Tea",
      "0:18 晩餐歌 / tuki.",
      "0:19 花になって / 緑黄色社会",
      "0:20 晴る / ヨルシカ",
      "0:21 START / レフティーモンスターP feat. Lily",
    ].join("\n"),
  ]);

  assert.deepEqual(
    songs.map((song) => `${song.title} / ${song.artist}`),
    [
      "星座になれたら / 結束バンド",
      "ENDLESS STORY / REIRA starring YUNA ITO",
      "Opening / Known Artist",
      "晩餐歌 / tuki",
      "花になって / 緑黄色社会",
      "晴る / ヨルシカ",
      "START / レフティーモンスターP feat. Lily",
    ],
  );
});

test("rejects singleton narration and English gloss rows from Naraetan-style sources", () => {
  const songs = parseTimestampSongs([
    [
      "0:01 あくび / Yawn",
      "0:02 ペットショップ / Pet Shop",
      "0:03 リスナー同士の結婚報告 / A marriage report between listeners",
      "0:04 妻を迎えに行かないと / I have to go pick up my wife",
      "0:05 ガイドメロディが大きい / Guide melody is too loud",
      "0:06 コメント欄が壊れています / The comment section is broken",
      "0:07 病院に行ってきました / I went to the hospital",
      "0:08 晩餐歌 / tuki.",
      "0:09 晴る / ヨルシカ",
    ].join("\n"),
  ]);

  assert.deepEqual(
    songs.map((song) => `${song.title} / ${song.artist}`),
    ["晩餐歌 / tuki", "晴る / ヨルシカ"],
  );
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
      "0:03:22 枠Start",
      "0:09:56　魔法／tayori",
    ].join("\n"),
  ]);

  assert.equal(songs.length, 1);
  assert.equal(songs[0].title, "魔法");
  assert.equal(songs[0].artist, "tayori");
});

test("rejects exact activity marker titles only for unknown artists", () => {
  const rejected = [];
  const songs = parseTimestampSongs(["0:06:44 曲紹介\n0:22:24 離席\n0:30:00 曲終わり\n0:31:00 曲紹介タイム\n0:32:00 休憩入り\n0:33:00 スパチャ・メンシ読み\n0:34:00 配信開始\n0:35:00 マイクテスト"], {
    onReject: (entry) => rejected.push(entry),
  });

  assert.deepEqual(songs, []);
  assert.deepEqual(
    rejected.map((entry) => entry.reason),
    Array.from({ length: 8 }, () => "activity_marker_title"),
  );
});

test("keeps exact activity marker title when a known artist is explicit", () => {
  const songs = parseTimestampSongs(["0:06:44 曲紹介 / Known Artist\n0:10:00 START / Known Artist"]);

  assert.equal(songs.length, 2);
  assert.equal(songs[0].title, "曲紹介");
  assert.equal(songs[0].artist, "Known Artist");
  assert.equal(songs[1].title, "START");
  assert.equal(songs[1].artist, "Known Artist");
});

test("rejects dirty section labels without matching video or channel text", () => {
  const dirtySongs = parseTimestampSongs(
    [
      "0:00 ED",
      "0:01 OP",
      "0:02 END",
      "0:03 Set List",
      "0:04 セットリスト",
      "0:05 セトリ",
      "0:06 タイムスタンプ",
      "0:07 曲名",
      "0:08 ～",
      "0:09 ～リアルライブチケット#耐久 7",
      "0:10 Start Stream！",
      "0:11 配信スタート",
      "0:12 声入り",
      "0:13 自己紹介",
      "0:14 opening",
      "0:15 ending",
      "0:16 歌唱開始時間",
      "0:17 セットリスト / 歌唱開始時間",
      "0:18 ED / お遊戯あり",
    ].join("\n"),
  );
  const cleanSongs = parseTimestampSongs([
    [
      "0:19 READY STEADY GO / L'Arc-en-Ciel",
      "0:20 Open Your Eyes / Guano Apes",
      "0:21 ENDLESS STORY / REIRA starring YUNA ITO",
    ].join("\n"),
  ]);

  assert.deepEqual(dirtySongs, []);
  assert.deepEqual(cleanSongs.map((song) => `${song.title} / ${song.artist}`), [
    "READY STEADY GO / L'Arc-en-Ciel",
    "Open Your Eyes / Guano Apes",
    "ENDLESS STORY / REIRA starring YUNA ITO",
  ]);
});

test("keeps START whitelist songs while dropping unknown START markers", () => {
  const songs = parseTimestampSongs([
    [
      "0:01 START",
      "0:02 Start",
      "0:03 StaRt / Mrs. GREEN APPLE",
      "0:04 START / レフティーモンスターP feat. Lily",
      "0:05 START / 愛内里菜",
    ].join("\n"),
  ]);

  assert.deepEqual(
    songs.map((song) => `${song.title} / ${song.artist}`),
    ["StaRt / Mrs. GREEN APPLE", "START / レフティーモンスターP feat. Lily", "START / 愛内里菜"],
  );
});

test("rejects tenQ chant variants from timestamp rows", () => {
  const songs = parseTimestampSongs([
    [
      "0:01 天Q",
      "0:02 天Q天Q~~WO~~~",
      "0:03 HI 天Q~",
      "0:04 DQ~",
      "0:05 HAWAWA",
      "0:06 BUAAAA",
      "0:07 HE HE",
      "0:08 E HO E HO",
      "0:09 READY STEADY GO / L'Arc-en-Ciel",
    ].join("\n"),
  ]);

  assert.deepEqual(
    songs.map((song) => song.title),
    ["READY STEADY GO"],
  );
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

test("rejects custom emoji aliases and reaction activities without song text", () => {
  const songs = parseTimestampSongs([
    "0:01 :_hotsmile:",
    "0:02 :_可愛い:ぷくっ",
    "0:03 :_可愛い:あくび",
    "31:03 あくび🥱‪‪‬ᐝ",
    "5:26:51 :_可愛い:ふんっ（ぷくっ）",
    "6:17:44 もうちょっと普通の時も（ぷくっ）",
    "あくびかわいい:_heart: 0:08:29",
  ]);

  assert.deepEqual(songs, []);
});

test("rejects carried reaction activities without rejecting real artist credits", () => {
  assert.equal(isLikelyNonSongEntry({ title: "ぷくっ", artist: "未記載", raw: "34:02 :_可愛い:ぷくっ" }), true);
  assert.equal(isLikelyNonSongEntry({ title: "あくび", artist: "未記載", raw: "3:38:54 :_可愛い:あくび" }), true);
  assert.equal(isLikelyNonSongEntry({ title: "あくび🥱‪‪‬ᐝ", artist: "未記載", raw: "31:03  あくび🥱‪‪‬ᐝ" }), true);
  assert.equal(isLikelyNonSongEntry({ title: "ふんっ", artist: "ぷくっ", raw: "5:26:51 :_可愛い:ふんっ（ぷくっ）" }), true);
  assert.equal(isLikelyNonSongEntry({ title: "もうちょっと普通の時も", artist: "ぷくっ", raw: "6:17:44 もうちょっと普通の時も（ぷくっ）" }), true);
  assert.equal(isLikelyNonSongEntry({ title: "あくび", artist: "作曲者", raw: "3:38:54 あくび / 作曲者" }), false);
});

test("strips trailing custom emoji aliases from song titles", () => {
  const songs = parseTimestampSongs(["1:44:21 READY STEADY GO:_hey:"]);

  assert.equal(songs.length, 1);
  assert.equal(songs[0].title, "READY STEADY GO");
});

test("keeps anime work metadata out of artist fields", () => {
  const songs = parseTimestampSongs([
    "0:03 勝利のマシンロボ/マシンロボクロノスの大逆襲OP(キー+4)",
    "0:08 勝利のマシンロボ/マシンロボクロノスの大逆襲OP(Ado風ver.)",
    "0:13 勝利のマシンロボ/マシンロボクロノスの大逆襲OP(Secret guest山岡さん参戦)",
  ]);

  assert.equal(songs.length, 3);
  assert.deepEqual(
    songs.map((song) => song.title),
    ["勝利のマシンロボ", "勝利のマシンロボ", "勝利のマシンロボ"],
  );
  assert.deepEqual(
    songs.map((song) => song.artist),
    ["未記載", "未記載", "未記載"],
  );
});

test("parses artist before a trailing slash metadata block", () => {
  const songs = parseTimestampSongs([
    [
      "02:43:45 ラムのラブソング / 松谷祐子 (1981) / TVアニメ「うる星やつら」初代OP",
      "03:01:03 ふわふわ時間 / 桜高軽音部 (2009) / TVアニメ「けいおん!」劇中歌",
      "06:09:57 恋愛サーキュレーション / 千石撫子(CV:花澤香菜) (2009) / TVアニメ 「化物語 」第10話OP",
    ].join("\n"),
  ]);

  assert.deepEqual(
    songs.map((song) => song.title),
    ["ラムのラブソング", "ふわふわ時間", "恋愛サーキュレーション"],
  );
  assert.deepEqual(
    songs.map((song) => song.artist),
    ["松谷祐子 (1981)", "桜高軽音部 (2009)", "千石撫子(CV:花澤香菜) (2009)"],
  );
});

test("does not treat year-month dates as title artist delimiters", () => {
  const songs = parseTimestampSongs([
    [
      "0:03 ライオン/シェリル・ノーム(May'n), ランカ・リー(中島愛) 2008/08",
      "0:04 星座になれたら/結束バンド 2022/12",
    ].join("\n"),
  ]);

  assert.deepEqual(
    songs.map((song) => song.title),
    ["ライオン", "星座になれたら"],
  );
  assert.deepEqual(
    songs.map((song) => song.artist),
    ["シェリル・ノーム(May'n), ランカ・リー(中島愛) 2008/08", "結束バンド 2022/12"],
  );
});

test("cleans decorated indexes and rejects announcement action dirty samples", () => {
  const songs = parseTimestampSongs([
    [
      "0:01 閉会式",
      "0:02 01≫アンノウン・マザーグース / wowaka",
      "0:03 1を手で表現した",
      "0:04 ꒱‬ 01. 初恋サイダー / Buono!",
      "0:05 02.441 / miwa",
      "0:06 ②どんな色が好き / 坂田おさむ＆神崎ゆう子",
      "0:07 02≫テオ / Omoi",
      "0:08 2周年記念お写真公開！",
      "0:09 ꒱‬ 02. 夏祭り恋慕う / ＝LOVE",
      "0:10 03≫ボッカデラベリタ / 柊キライ",
      "0:11 ꒱‬ 03. ブルーハワイレモン / ≒JOY",
      "0:12 3Dお披露目でスタンドマイク回したかった / 永ちゃんやりたい",
      "0:13 〜3Dライブ開催決定!!!!",
      "0:14 ③クリープ",
    ].join("\n"),
  ]);

  assert.deepEqual(
    songs.map((song) => song.title),
    ["アンノウン・マザーグース", "初恋サイダー", "441", "どんな色が好き", "テオ", "夏祭り恋慕う", "ボッカデラベリタ", "ブルーハワイレモン", "クリープ"],
  );
  assert.deepEqual(
    songs.map((song) => song.artist),
    ["wowaka", "Buono!", "miwa", "坂田おさむ＆神崎ゆう子", "Omoi", "＝LOVE", "柊キライ", "≒JOY", "未記載"],
  );
});

test("cleans decorated list prefixes from current dirty timeline samples", () => {
  const songs = parseTimestampSongs([
    [
      "⁅00:15:50⁆🦊03.星間飛行 /中島愛",
      "19:26  ＊ 04. KICK BACK",
      "1:15:31 ＊〜アスタリスク〜 / ORANGE RANGE",
    ].join("\n"),
  ]);

  assert.deepEqual(
    songs.map((song) => song.title),
    ["星間飛行", "KICK BACK", "＊〜アスタリスク〜"],
  );
  assert.deepEqual(
    songs.map((song) => song.artist),
    ["中島愛", "未記載", "ORANGE RANGE"],
  );
});

test("rejects afterparty and non-song tail markers from current dirty samples", () => {
  const songs = parseTimestampSongs([["01:27:06 3次会", "4:13:42 達成！", "4:26:12 歌みたの話"].join("\n")]);

  assert.deepEqual(songs, []);
});

test("keeps song rows with guest annotations in work metadata", () => {
  const songs = parseTimestampSongs(["60曲目 3:58:12 勝利のマシンロボ/マシンロボクロノスの大逆襲OP(特別ゲスト ケンリュウ)"]);

  assert.equal(songs.length, 1);
  assert.equal(songs[0].title, "勝利のマシンロボ");
  assert.equal(songs[0].artist, "未記載");
});

test("keeps song titles that contain greeting-like words", () => {
  const songs = parseTimestampSongs(["08. 1:31:32 金曜日のおはよう（HoneyWorks）"]);

  assert.equal(songs.length, 1);
  assert.equal(songs[0].title, "金曜日のおはよう");
});

test("rejects conversational pseudo songs from bilingual timestamp rows", () => {
  const songs = parseTimestampSongs([
    [
      "01:06:40 #03 星座になれたら / 結束バンド",
      "01:20:43 おすすめリップクリーム集 / Recommended Lip Balms",
      "02:49:57 姉 or 妹 or 幼馴染 / Older Sister, Younger Sister, or Childhood Friend?",
      "03:02:18 おすすめの曲紹介 / Song Recommendations",
      "01:44:27 指が細い人が羨ましい / I Envy People with Slender Fingers",
      "00:56:26 歌うフリをするね / I’ll Pretend to Sing",
      "03:23:23 #18 ENDLESS STORY / REIRA starring YUNA ITO",
    ].join("\n"),
  ]);

  assert.deepEqual(
    songs.map((song) => `${song.title} / ${song.artist}`),
    ["星座になれたら / 結束バンド", "ENDLESS STORY / REIRA starring YUNA ITO"],
  );
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

test("rejects short chat reaction timestamps after a real set list", () => {
  const songs = parseTimestampSongs([
    [
      "Set List",
      "17:45 タッチ",
      "21:38 さよならエレジー",
      "27:16 ラムのラブソング",
      "36:08 Rolling star",
      "39:52 V.I.P",
      "50:32 LUVORATORRRRRY!",
      "56:40 BOYS&GIRLS",
      "1:44:21 READY STEADY GOhey",
      "1:48:30 ブルーバード",
      "2:25:39 lulu.",
      "---------------------",
      "29:45 DQ",
      "39:15 DEN Q~~~",
      "1:00:46 DQ~~~clap",
      "1:10:24 DQ~~~~",
      "1:10:42 天Q~",
      "1:48:09 DEN Q",
      "1:52:18 bless you🙏",
      "1:53:41 pat",
      "2:04:04 pienface",
      "2:32:33 ZOOM IN",
      "2:34:17 MUMUMU",
      "2:35:16 WAAAA~",
      "2:36:00 smile",
    ].join("\n"),
  ]);
  const titles = songs.map((song) => song.title);

  assert.equal(titles.includes("タッチ"), true);
  assert.equal(titles.includes("lulu"), true);
  assert.equal(titles.some((title) => /^(?:DQ|DEN Q|天Q|ZOOM IN|MUMUMU|WAAAA|smile)/iu.test(title)), false);
});

test("rejects dirty section markers from niche-only timelines", () => {
  const songs = parseTimestampSongs([
    [
      "[ 12:01 この曲について ]",
      "0:00 待機",
      "02:02:09 歌い終えて",
      "1:03:44 1個目！:_nonoNono:",
      "┗ 0:07:35 [曲終わり]",
      "01:31:56 ending",
      "0:03:07 はじまり",
      "2:48:22 1on1&同期は",
      "0:00:00 待機画面／ＯＰ",
      "0:04:21 本日のサムネ",
      "0:05:32 チューニング",
      "0:06:43 ストローク練習",
      "0:07:54 インスト、カバーMV紹介",
      "0:09:05 予告あれこれ",
      "0:10:16 NEW!",
      "[ 13:54 最近暑いね ](曲導入)",
      "[ 19:35 夏と言えば…？ ](曲導入)",
      "[ 38:02 曲導入 ]",
      "02:12:47 おつウタノン",
      "10:20 TunamiPON",
      "0:28:59 Tunami(PON)",
      "0:32:55　●再開",
      "◆ 2:14:28 後半再開！",
      "0:30:16 換気タイム",
      "1:51:47 _UTANO012; オケが止まった",
    ].join("\n"),
  ]);

  assert.deepEqual(songs, []);
});

test("keeps song titles that merely contain dirty marker words", () => {
  const songs = parseTimestampSongs([
    [
      "1:21:48 はじまりはいつも雨",
      "㉔2:45:49 （2012）ルミナス / ClariS『魔法少女まどか☆マギカ [前編] 始まりの物語』劇場版主題歌",
      "60曲目 3:58:12 勝利のマシンロボ/マシンロボクロノスの大逆襲OP(特別ゲスト ケンリュウ)",
      "13:16 ・睡蓮花",
      "2:30:22 「Song for...／HY」",
    ].join("\n"),
  ]);

  assert.deepEqual(
    songs.map((song) => song.title),
    ["睡蓮花", "はじまりはいつも雨", "「Song for...／HY」", "（2012）ルミナス", "勝利のマシンロボ"],
  );
  assert.equal(songs.length, 5);
});

test("cleans ordinal prefixes while keeping real song rows", () => {
  const songs = parseTimestampSongs([
    [
      "00:10:32 01| ハートアンドハート(Heart and Heart) | 苺咲べりぃ(Maisaki Berry)",
      "1:23:09 10曲目 Brave Shine / Aimer",
      "1:03:34 3 01. 初恋サイダー / Buono!",
    ].join("\n"),
  ]);

  assert.deepEqual(
    songs.map((song) => song.title),
    ["ハートアンドハート", "初恋サイダー", "Brave Shine"],
  );
  assert.deepEqual(
    songs.map((song) => song.artist),
    ["苺咲べりぃ", "Buono!", "Aimer"],
  );
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
