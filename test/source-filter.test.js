const assert = require("node:assert/strict");
const test = require("node:test");

const {
  cleanSongTitleNoise,
  isArtistRichMixedSongList,
  isBlockedSongEntry,
  filterPayloadBlockedSources,
  isBlockedSource,
  normalizeSongEntry,
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

test("source filter removes section markers and cleans ordinal song prefixes", () => {
  assert.equal(isBlockedSongEntry({ title: "この曲について", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "待機", artist: "待补歌手" }), true);
  assert.equal(isBlockedSongEntry({ title: "歌い終えて", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "1個目！", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "曲終わり", artist: "未記載" }), true);
  assert.equal(isBlockedSongEntry({ title: "Ending", artist: "未記載" }), true);
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
  assert.equal(isBlockedSongEntry({ title: "Ending", artist: "Known Artist" }), false);
  assert.equal(isBlockedSongEntry({ title: "はじまりはいつも雨", artist: "未記載" }), false);

  assert.equal(cleanSongTitleNoise("01| ハートアンドハート"), "ハートアンドハート");
  assert.equal(cleanSongTitleNoise("8.32"), "8.32");
  assert.equal(cleanSongTitleNoise("2.500♪"), "2.500♪");
  assert.equal(cleanSongTitleNoise("02.441"), "441");
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
  assert.equal(isBlockedSongEntry({ title: "閉会式も見てください", artist: "待补歌手" }), true);
  assert.equal(isBlockedSongEntry({ title: "1を手で表現した", artist: "待补歌手" }), true);
  assert.equal(isBlockedSongEntry({ title: "2周年記念お写真公開！", artist: "待补歌手" }), true);
  assert.equal(isBlockedSongEntry({ title: "〜3Dライブ開催決定!!!!", artist: "待补歌手" }), true);
  assert.equal(isBlockedSongEntry({ title: "3Dお披露目でスタンドマイク回したかった", artist: "永ちゃんやりたい" }), true);

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
              { title: "02| キュートなキューたい", artist: "CUTIE STREET", seconds: 1361, time: "0:22:41" },
            ],
          },
        ],
      },
    },
  };

  const filtered = filterPayloadBlockedSources(payload);

  assert.deepEqual(filtered.groups["72h"].items[0].songs, [
    { title: "キュートなキューたい", artist: "CUTIE STREET", seconds: 1361, time: "0:22:41" },
  ]);
  assert.equal(filtered.source.clientFilteredBlockedSongCount, 6);
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

function video(videoId, channelName, title) {
  return {
    videoId,
    channelName,
    title,
    songs: [{ title, artist: "未記載", seconds: 1, time: "0:00:01" }],
  };
}
