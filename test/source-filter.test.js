const assert = require("node:assert/strict");
const test = require("node:test");

const {
  cleanSongTitleNoise,
  isArtistRichMixedSongList,
  isBlockedSongEntry,
  filterPayloadBlockedSources,
  isBlockedSource,
  isChannelScopedUnknownArtistDirtySong,
  isSelfReferentialChannelTitle,
  BLOCKLIST_HASH,
  normalizeSongEntry,
} = require("../assets/source-filter");
const { isLikelyNonSongEntry } = require("../scripts/song-utils");

test("source filter removes blocked HK/TW VTuber channels without matching ordinary song titles", () => {
  assert.equal(isBlockedSource({ channelId: "UCW8G8aeRjbIOlL-Fgms8hEQ", channelName: "Japanese Channel", title: "歌雜 / HKVtuber" }), true);
  assert.equal(isBlockedSource({ channelHandle: "@yukichanch", channelName: "Japanese Channel", title: "歌枠" }), true);
  assert.equal(isBlockedSource({ channelUrl: "https://www.youtube.com/@rhoda1126", channelName: "Japanese Channel", title: "歌枠" }), true);
  assert.equal(isBlockedSource({ channelId: "UCD1QOCJIAPsMKMvRSXjLahw", channelName: "Aruma Ch. 薬袋アルマ", title: "歌枠" }), true);
  assert.equal(isBlockedSource({ channelHandle: "@ArumaCh", channelName: "薬袋アルマ", title: "歌枠" }), true);
  assert.equal(isBlockedSource({ channelName: "AZKi Channel", title: "奔跑日記！ / 米亞 MYA" }), false);
  assert.equal(isBlockedSource({ channelName: "Narrator Music", title: "HKVtuber 台湾旅行" }), false);
  assert.equal(isBlockedSongEntry({ title: "DEN Q~~~", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "DEN Q~~~", artist: "Known Artist" }), false);

  const payload = {
    source: { name: "fixture" },
    groups: {
      "72h": {
        items: [
          { ...video("blocked", "Japanese Channel", "奔跑日記！"), channelId: "UCW8G8aeRjbIOlL-Fgms8hEQ" },
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
  assert.equal(filtered.blocklistHash, BLOCKLIST_HASH);
  assert.equal(payload.groups["72h"].items.length, 2);
});

test("source filter removes section markers and cleans ordinal song prefixes", () => {
  assert.equal(isBlockedSongEntry({ title: "この曲について", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "待機", artist: "待补歌手" }), true);
  assert.equal(isBlockedSongEntry({ title: "歌い終えて", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "1個目！", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "曲終わり", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "Ending", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "opening", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "END", artist: "エンドカード" }), true);
  assert.equal(isBlockedSongEntry({ title: "オープニング", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "エンディング", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "歌唱開始時間", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "セットリスト", artist: "歌唱開始時間" }), true);
  assert.equal(isBlockedSongEntry({ title: "セトリ", artist: "Set List♬" }), true);
  assert.equal(isBlockedSongEntry({ title: "ED", artist: "お遊戯あり" }), true);
  assert.equal(isBlockedSongEntry({ title: "1on1&同期は", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "本日のサムネ", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "チューニング", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "NEW!", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "曲導入", artist: "コメント平和だね" }), true);
  assert.equal(isBlockedSongEntry({ title: "最近暑いね", artist: "曲導入" }), true);
  assert.equal(isBlockedSongEntry({ title: "提供", artist: "待補歌手" }), true);
  assert.equal(isBlockedSongEntry({ title: "おつウタノン", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "おつぜふぁ～ bye bye～", artist: "待补歌手" }), true);
  assert.equal(isBlockedSongEntry({ title: "せーの！おつひなーぽぽんぽんぽん", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "こんひなー", artist: "待補歌手" }), true);
  assert.equal(isBlockedSongEntry({ title: "TunamiPON", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "Tunami(PON)", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "再開", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "後半再開！", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "換気タイム", artist: "待补歌手" }), true);
  assert.equal(isBlockedSongEntry({ title: "_UTANO012; オケが止まった", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "100人達成！", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "222人に目標変更", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "A LELELELE", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "KP", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "ft", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "天Q", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "天Q天Q~~WO~~~", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "HI 天Q~", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "HAWAWA", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "BUAAAA", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "HE HE", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "E HO E HO", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "Set List", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "曲名", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "コメ「なれたんかわいい」", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "アンケート結果", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "喉が痛い", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "配信について", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "リクエストください", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "コメント欄", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "なれコールアンケート", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "歌詞考察", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "なれたん自己紹介", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "喉が痛い", artist: "配信について" }), true);
  assert.equal(isBlockedSongEntry({ title: "Ending", artist: "Known Artist" }), false);
  assert.equal(isBlockedSongEntry({ title: "Opening", artist: "Known Artist" }), false);
  assert.equal(isBlockedSongEntry({ title: "Open Your Eyes", artist: "Guano Apes" }), false);
  assert.equal(isBlockedSongEntry({ title: "ENDLESS STORY", artist: "REIRA starring YUNA ITO" }), false);
  assert.equal(isBlockedSongEntry({ title: "Never Ending Story", artist: "Limahl" }), false);
  assert.equal(isBlockedSongEntry({ title: "START:DASH!!", artist: "μ's" }), false);
  assert.equal(isBlockedSongEntry({ title: "星座になれたら", artist: "結束バンド" }), false);
  assert.equal(isBlockedSongEntry({ title: "START", artist: "レフティーモンスターP feat. Lily" }), false);
  assert.equal(isBlockedSongEntry({ title: "天Q", artist: "Known Artist" }), false);
  assert.equal(isBlockedSongEntry({ title: "はじまりはいつも雨", artist: "未記載" }), false);
  assert.equal(isBlockedSongEntry({ title: "コメ「残り96曲ですね?」", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "アンケート (なれたんを家族に例えると)", artist: "Poll: If Narae-tan was family" }), true);
  assert.equal(isBlockedSongEntry({ title: "（去年のなれたん）譲り合い精神がないの？", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "なれたんに褒められたいハネダン達", artist: "Hanedans Who Want Praise from Naretan" }), true);
  assert.equal(isBlockedSongEntry({ title: "なれたんの身長が低いって言いたいの?", artist: "Are you trying to say Narae-tan is short?" }), true);
  assert.equal(isBlockedSongEntry({ title: "楽しみにしてろよ!", artist: "練習後のなれたんを" }), true);
  assert.equal(isBlockedSongEntry({ title: "【さぁ】「さぁだけにSURFACE」", artist: "なれたんギャグ" }), true);
  assert.equal(isBlockedSongEntry({ title: "【雑談】リクエスト確認", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "（去年のなれたん）譲り合い精神がないの？", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "初めて日本の病院に行ってきました", artist: "I Went to a Japanese Hospital for the First Time" }), true);
  assert.equal(isBlockedSongEntry({ title: "韓国のちゃんぽん", artist: "Korean Jjamppong" }), true);
  assert.equal(isBlockedSongEntry({ title: "音楽停止（クリックミス）", artist: "Music stops (accidental click)" }), true);
  assert.equal(isBlockedSongEntry({ title: "FとPの発音", artist: "Pronunciation of F and P" }), true);
  assert.equal(isBlockedSongEntry({ title: "食あたり", artist: "Food Poisoning" }), true);
  assert.equal(isBlockedSongEntry({ title: "お茶を飲みながら逆立ち", artist: "Handstand While Drinking Tea" }), true);
  assert.equal(isBlockedSongEntry({ title: "おすすめの曲紹介", artist: "Song Recommendations" }), true);
  assert.equal(isBlockedSongEntry({ title: "星座になれたら", artist: "結束バンド" }), false);
  assert.equal(isBlockedSongEntry({ title: "晩餐歌", artist: "tuki.", raw: "1:04:22 晩餐歌 / Bansanka (tuki.)" }), false);
  assert.equal(isBlockedSongEntry({ title: "花になって", artist: "緑黄色社会" }), false);
  assert.equal(isBlockedSongEntry({ title: "晴る", artist: "ヨルシカ" }), false);

  assert.equal(cleanSongTitleNoise("01| ハートアンドハート"), "ハートアンドハート");
  assert.equal(cleanSongTitleNoise("8.32"), "8.32");
  assert.equal(cleanSongTitleNoise("2.500♪"), "2.500♪");
  assert.equal(cleanSongTitleNoise("02.441"), "441");
  assert.equal(cleanSongTitleNoise("01.1時間"), "1時間");
  assert.equal(cleanSongTitleNoise("07.3月9日"), "3月9日");
  assert.equal(cleanSongTitleNoise("13.05410-(ん)"), "05410-(ん)");
  assert.equal(cleanSongTitleNoise("28.366日"), "366日");
  assert.equal(cleanSongTitleNoise("01. Song"), "Song");
  assert.equal(cleanSongTitleNoise("01≫アンノウン・マザーグース"), "アンノウン・マザーグース");
  assert.equal(cleanSongTitleNoise("02≫テオ"), "テオ");
  assert.equal(cleanSongTitleNoise("꒱‬ 01. 初恋サイダー"), "初恋サイダー");
  assert.equal(cleanSongTitleNoise("꒱‬ 03. ブルーハワイレモン"), "ブルーハワイレモン");
  assert.equal(cleanSongTitleNoise("②どんな色が好き"), "どんな色が好き");
  assert.equal(cleanSongTitleNoise("③クリープ"), "クリープ");
  assert.equal(cleanSongTitleNoise("10曲目   Brave Shine"), "Brave Shine");
  assert.equal(cleanSongTitleNoise("3 01. 初恋サイダー"), "初恋サイダー");
  assert.deepEqual(normalizeSongEntry({ title: "02| キュートなキューたい", artist: "CUTIE STREET" }), {
    title: "キュートなキューたい",
    artist: "CUTIE STREET",
  });
  assert.deepEqual(normalizeSongEntry({ title: "01≫アンノウン・マザーグース", artist: "wowaka" }), {
    title: "アンノウン・マザーグース",
    artist: "wowaka",
  });

  assert.equal(isBlockedSongEntry({ title: "閉会式", artist: "待补歌手" }), true);

  assert.equal(isLikelyNonSongEntry({ title: "END", artist: "unknown" }), true);
  assert.equal(isLikelyNonSongEntry({ title: "Opening Talk", artist: "未記載" }), true);
  assert.equal(isLikelyNonSongEntry({ title: "Ending Talk", artist: "unknown" }), true);
  assert.equal(isLikelyNonSongEntry({ title: "本編終了", artist: "未記載" }), true);
  assert.equal(isLikelyNonSongEntry({ title: "ENDLESS STORY", artist: "REIRA starring YUNA ITO" }), false);
  assert.equal(isLikelyNonSongEntry({ title: "Pretender", artist: "Official髭男dism" }), false);
  assert.equal(isLikelyNonSongEntry({ title: "spending", artist: "Known Artist" }), false);
  assert.equal(isLikelyNonSongEntry({ title: "Ending", artist: "Known Artist" }), false);
  assert.equal(isBlockedSongEntry({ title: "閉会式も見てください", artist: "待补歌手" }), true);
  assert.equal(isBlockedSongEntry({ title: "1を手で表現した", artist: "待补歌手" }), true);
  assert.equal(isBlockedSongEntry({ title: "2周年記念お写真公開！", artist: "待补歌手" }), true);
  assert.equal(isBlockedSongEntry({ title: "〜3Dライブ開催決定!!!!", artist: "待补歌手" }), true);
  assert.equal(isBlockedSongEntry({ title: "3Dお披露目でスタンドマイク回したかった", artist: "永ちゃんやりたい" }), true);
  assert.equal(isBlockedSongEntry({ title: "8", artist: "29(土) ワンマンライブ開催！＆クラファン開催中！(追加ゴール)" }), true);
  assert.equal(isBlockedSongEntry({ title: "7", artist: "13（月）ニコニコ生放送デビュー配信" }), true);
  assert.equal(isBlockedSongEntry({ title: "1", artist: "3の純情な感情", raw: "0:01 1/3の純情な感情" }), true);
  assert.equal(isBlockedSongEntry({ title: "01", artist: "ハートアンドハート(Heart and Heart) | 苺咲べりぃ(Maisaki Berry)" }), true);
  assert.equal(isBlockedSongEntry({ title: "27", artist: "SUPER BEAVER（💡）" }), false);
  assert.equal(isBlockedSongEntry({ title: "8.32", artist: "*Luna" }), false);
  assert.equal(isBlockedSongEntry({ title: "1.0", artist: "amazarashi" }), false);

  const payload = {
    source: { name: "fixture" },
    groups: {
      "72h": {
        items: [
          {
            ...video("dirty", "音ノ乃のの / NononoNono", "歌枠"),
            songs: [
              { title: "この曲について", artist: "未記載", seconds: 721, time: "0:12:01" },
              { title: "1個目！", artist: "未記載", seconds: 3824, time: "1:03:44" },
              { title: "最近暑いね", artist: "曲導入", seconds: 834, time: "0:13:54" },
              { title: "おつウタノン", artist: "未記載", seconds: 7967, time: "2:12:47" },
              { title: "Tunami(PON)", artist: "未記載", seconds: 1739, time: "0:28:59" },
              { title: "再開", artist: "待补歌手", seconds: 1975, time: "0:32:55" },
              { title: "8", artist: "29(土) ワンマンライブ開催！＆クラファン開催中！(追加ゴール)", seconds: 2000, time: "0:33:20" },
              { title: "コメ「喉が痛い」", artist: "未記載", seconds: 2100, time: "0:35:00" },
              { title: "リクエスト受付中", artist: "未記載", seconds: 2110, time: "0:35:10" },
              { title: "なれコールアンケート", artist: "未記載", seconds: 2115, time: "0:35:15" },
              { title: "02| キュートなキューたい", artist: "CUTIE STREET", seconds: 1361, time: "0:22:41" },
              { title: "Opening", artist: "Known Artist", seconds: 2120, time: "0:35:20" },
            ],
          },
        ],
      },
    },
  };

  const filtered = filterPayloadBlockedSources(payload);

  assert.deepEqual(filtered.groups["72h"].items[0].songs, [
    { title: "キュートなキューたい", artist: "CUTIE STREET", seconds: 1361, time: "0:22:41" },
    { title: "Opening", artist: "Known Artist", seconds: 2120, time: "0:35:20" },
  ]);
  assert.equal(filtered.source.clientFilteredBlockedSongCount, 10);
  assert.equal(filtered.source.clientNormalizedSongCount, 1);
});

test("source filter drops title-only rows only inside artist-rich mixed lists", () => {
  const artistRows = Array.from({ length: 8 }, (_, index) => ({
    title: `Song ${index + 1}`,
    artist: `Artist ${index + 1}`,
    seconds: index + 1,
    time: `0:00:0${index + 1}`,
  }));
  const mixedSongs = [
    { title: "「君とのメモリー 更新中～」", artist: "未記載", seconds: 226, time: "0:03:46" },
    { title: "ナナフシダンス", artist: "待补歌手", seconds: 13506, time: "3:45:06" },
    ...artistRows,
  ];

  assert.equal(isArtistRichMixedSongList(mixedSongs), true);

  const payload = {
    source: { name: "fixture" },
    groups: {
      "72h": {
        items: [
          { videoId: "AAAAAAAAAAA", title: "mixed", channelName: "A", songs: mixedSongs },
          {
            videoId: "BBBBBBBBBBB",
            title: "title only",
            channelName: "B",
            songs: [
              { title: "タッチ", artist: "未記載", seconds: 1, time: "0:00:01" },
              { title: "ラムのラブソング", artist: "未記載", seconds: 2, time: "0:00:02" },
              { title: "KP", artist: "未記載", seconds: 3, time: "0:00:03" },
            ],
          },
        ],
      },
    },
  };

  const filtered = filterPayloadBlockedSources(payload);
  assert.deepEqual(
    filtered.groups["72h"].items[0].songs.map((song) => song.title),
    artistRows.map((song) => song.title),
  );
  assert.deepEqual(
    filtered.groups["72h"].items[1].songs.map((song) => song.title),
    ["タッチ", "ラムのラブソング"],
  );
  assert.equal(filtered.source.clientFilteredBlockedSongCount, 3);
});

test("source filter drops only unknown-artist rows from Riona channel", () => {
  const rionaSource = {
    videoId: "ZEAgcWCnkwQ",
    channelName: "Riona Ch. 響咲リオナ - FLOW GLOW",
    channelUrl: "https://www.youtube.com/@IsakiRiona",
  };
  assert.equal(isChannelScopedUnknownArtistDirtySong({ title: "花に亡霊", artist: "未記載" }, rionaSource), true);
  assert.equal(isChannelScopedUnknownArtistDirtySong({ title: "花に亡霊", artist: "ヨルシカ" }, rionaSource), false);
  assert.equal(isChannelScopedUnknownArtistDirtySong({ title: "花に亡霊", artist: "未記載" }, { channelName: "Other Channel" }), false);

  const payload = {
    source: { name: "fixture" },
    groups: {
      "72h": {
        items: [
          {
            ...rionaSource,
            title: "Riona karaoke",
            songs: [
              { title: "花に亡霊", artist: "未記載", seconds: 145, time: "0:02:25" },
              { title: "自己肯定感がドンドン上がってる", artist: "未記載", seconds: 3362, time: "0:56:02" },
              { title: "花に亡霊", artist: "ヨルシカ", seconds: 4000, time: "1:06:40" },
            ],
          },
          {
            videoId: "SAFE0000001",
            channelName: "Other Channel",
            title: "Other karaoke",
            songs: [{ title: "花に亡霊", artist: "未記載", seconds: 145, time: "0:02:25" }],
          },
        ],
      },
    },
  };

  const filtered = filterPayloadBlockedSources(payload);
  assert.deepEqual(
    filtered.groups["72h"].items.flatMap((item) => item.songs.map((song) => `${item.videoId}:${song.title} / ${song.artist}`)),
    ["ZEAgcWCnkwQ:花に亡霊 / ヨルシカ", "SAFE0000001:花に亡霊 / 未記載"],
  );
  assert.equal(filtered.source.clientFilteredBlockedSongCount, 2);
});

test("source filter drops unknown-artist self references without blocking real songs", () => {
  const source = {
    videoId: "SELFREF0001",
    channelName: "Naretan Ch. なれたん",
    channelHandle: "@naretan",
  };

  assert.equal(isSelfReferentialChannelTitle("なれたん", source), true);
  assert.equal(isSelfReferentialChannelTitle("Naretan", source), true);
  assert.equal(isBlockedSongEntry({ title: "なれたん", artist: "未記載" }, source), true);
  assert.equal(isBlockedSongEntry({ title: "Naretan", artist: "未記載" }, source), true);
  assert.equal(isBlockedSongEntry({ title: "Naretan", artist: "Known Artist" }, source), false);
  assert.equal(isBlockedSongEntry({ title: "START", artist: "愛内里菜" }, source), false);
});

function video(videoId, channelName, title) {
  return {
    videoId,
    channelName,
    title,
    songs: [{ title, artist: "未記載", seconds: 1, time: "0:00:01" }],
  };
}
