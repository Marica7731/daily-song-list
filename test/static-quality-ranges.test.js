"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  cleanStaticVideos,
  normalizeConservativeArtist,
  normalizeReleaseMetadataArtist,
  repairKnownSourceCredit,
  repairReleaseDateCredit,
  repairStructuredSlashCredit,
  repeatedDescriptionSources,
  unambiguousNonSongReason,
} = require("../scripts/static/quality-guard");
const { filterRange, shanghaiCalendarStart } = require("../scripts/static/collect-and-build");
const { buildQualityReview, reviewReasons } = require("../scripts/static/quality-review");

function song(title, artist, options = {}) {
  return { title, artist, raw: options.raw ?? `00:10 ${title} - ${artist}`, ...options };
}

function video(index, rows, overrides = {}) {
  return {
    videoId: `test-video-${index}`,
    channelId: `test-channel-${index}`,
    channelName: `Test Channel ${index}`,
    title: `Unrelated karaoke title ${index}`,
    publishedAt: "2026-09-25T12:00:00.000Z",
    songs: rows,
    ...overrides,
  };
}

test("date-shaped real song and common-language song titles are retained", () => {
  assert.equal(unambiguousNonSongReason(song("1/2", "川本真琴")), null);
  assert.equal(unambiguousNonSongReason(song("12/09", "架空バンド")), null);
  assert.equal(unambiguousNonSongReason(song("おかえり", "絢香")), null);
  assert.equal(unambiguousNonSongReason(song("開始", "独立の作曲家")), null);
});

test("religious livestream date and weekday-coded livestream notice are not songs", () => {
  const prayer = song("12/09", "25° Dia [Live Ao vivo]", {
    raw: "Santo Rosário | 40 Dias com São Miguel Arcanjo 2026 | 03:40 | 12/09 | 25° Dia | Live Ao vivo",
  });
  assert.equal(unambiguousNonSongReason(prayer), "prayer_broadcast_timeline");
  const announcement = song("ばた音るーむ Vol.109 配信 2026.9.24", "木", {
    raw: "ばた音るーむ Vol.109 配信 2026.9.24(木)21:00-",
  });
  assert.equal(unambiguousNonSongReason(announcement), "dated_stream_announcement");
  assert.equal(unambiguousNonSongReason(song("まで！達成できず😭9", "26土", {
    raw: "8:00まで！達成できず😭9/26土",
  })), "dated_stream_challenge_result");
  assert.equal(unambiguousNonSongReason(song("ANTES DE COMEÇAR O SEU DIA, OUÇA ESTA PALAVRA", "LUCAS", {
    raw: "ANTES DE COMEÇAR O SEU DIA, OUÇA ESTA PALAVRA | LUCAS 12:31",
  })), "bible_verse_broadcast");
});

test("source hash collision requires several independent channels and video titles", () => {
  const hash = "a".repeat(64);
  const copied = song("Noisy copied text", "未記載", {
    raw: "Some long and unrelated title from a different YouTube livestream 2026",
    sourceId: "description:unrelated:source",
    sourceHash: hash,
  });
  assert.equal(repeatedDescriptionSources(Array.from({ length: 4 }, (_, i) => video(i, [copied]))).size, 0);
  assert.equal(repeatedDescriptionSources(Array.from({ length: 6 }, (_, i) => video(i, [copied], { channelId: "same-channel" }))).size, 0);
  assert.equal(repeatedDescriptionSources(Array.from({ length: 6 }, (_, i) => video(i, [copied]))).get(hash).videoCount, 6);
});

test("contaminated descriptions are reversibly quarantined, while unrelated and repeat songs stay", () => {
  const hash = "b".repeat(64);
  const copied = song("False entry", "Unknown", {
    raw: "Third-party livestream title copied across unrelated singing streams",
    sourceId: "description:wrong-source",
    sourceHash: hash,
  });
  // Over 10% quarantine blocks publication, so use a representative mixed
  // sample: six bad rows across different channels, 120 legitimate rows.
  const input = Array.from({ length: 6 }, (_, i) => video(i, [
    copied,
    ...Array.from({ length: 20 }, (_, n) => song(n ? `Legitimate song ${n}` : "1/2", n ? "Artist" : "川本真琴")),
  ]));
  const before = JSON.stringify(input);
  const result = cleanStaticVideos(input);
  assert.equal(result.audit.quarantinedOccurrences, 6);
  assert.equal(result.audit.visibleOccurrences, 120);
  assert.equal(result.audit.byReason.reused_description_across_unrelated_channels, 6);
  assert.equal(result.videos.length, 6);
  assert(result.videos.every((v) => v.songs.some((s) => s.title === "1/2")));
  assert.equal(JSON.stringify(input), before, "quality pass must never mutate the input/history");
});

test("mass quarantine above 10% fails publication rather than silently deleting music", () => {
  const bad = song("12/09", "25° Dia [Live Ao vivo]", {
    raw: "Santo Rosário | 40 Dias com São Miguel Arcanjo 2026 | 03:40 | 12/09 | 25° Dia | Live Ao vivo",
  });
  assert.throws(() => cleanStaticVideos([video(1, [bad, song("1/2", "川本真琴")])]), /over 10%/);
});

test("today and three-day ranges use Shanghai calendar days, not trailing 24/72 hours", () => {
  const now = new Date("2026-09-25T18:42:00.000Z"); // Sep 26 02:42 Shanghai
  assert.equal(new Date(shanghaiCalendarStart(now)).toISOString(), "2026-09-25T16:00:00.000Z");
  assert.equal(new Date(shanghaiCalendarStart(now, 3)).toISOString(), "2026-09-23T16:00:00.000Z");
  const input = [
    video(1, [song("A", "B")], { publishedAt: "2026-09-25T15:59:59.000Z" }),
    video(2, [song("A", "B")], { publishedAt: "2026-09-25T16:00:00.000Z" }),
    video(3, [song("A", "B")], { publishedAt: "2026-09-23T16:00:00.000Z" }),
    video(4, [song("A", "B")], { publishedAt: "2026-09-23T15:59:59.000Z" }),
  ];
  assert.deepEqual(filterRange(input, now, null, 1).map((v) => v.videoId), ["test-video-2"]);
  assert.deepEqual(filterRange(input, now, null, 3).map((v) => v.videoId), ["test-video-1", "test-video-2", "test-video-3"]);
  assert.equal(filterRange(input, now, 7).length, 4);
});

test("full-history review surfaces questionable records without dropping real songs", () => {
  assert.deepEqual(reviewReasons(song("1/2", "川本真琴")), []);
  const videos = [
    video(1, [song("1/2", "川本真琴"),
      song("栞", "6thアルバム「PUZZLE」より", { raw: "00:20 栞 / 6thアルバム「PUZZLE」より" })],
    { publishedAt: "2026-07-17T11:30:00Z" }),
    video(2, [song("新曲", "テスト", { raw: "00:50 新曲 / テスト" })],
    { publishedAt: "2026-08-20T11:30:00Z" }),
  ];
  const original = JSON.stringify(videos);
  const review = buildQualityReview(videos, { byDay: { "2026-07-17": { quarantinedOccurrences: 2 } } }, new Date("2026-09-25T19:00:00Z"));
  assert.equal(review.status, "REVIEW_ONLY_NO_AUTO_DELETION");
  assert.equal(review.scannedOccurrenceCount, 3);
  assert.equal(review.scannedDays.length, 2);
  assert.equal(review.scannedDays[0].quarantinedOccurrences, 2);
  assert(review.candidates.some((item) => item.reason === "possible_release_metadata_as_artist"));
  assert.equal(JSON.stringify(videos), original);
});

test("repair separator-polluted artist credits without changing historical input or counts", () => {
  assert.equal(normalizeConservativeArtist(song("Butter-Fly", "/ 和田光司")).artist, "和田光司");
  assert.equal(normalizeConservativeArtist(song("盛れ！ミ・アモーレ", "／ Juice=Juice")).artist, "Juice=Juice");
  assert.equal(normalizeConservativeArtist(song("猫", "DISH//")).artist, "DISH//");
  assert.equal(normalizeConservativeArtist(song("Untouched", "/meme")).artist, "/meme");
  const input = [video(1, [song("Butter-Fly", "/ 和田光司"), song("Butter-Fly", "和田光司")])];
  const saved = JSON.stringify(input);
  const { videos, audit } = cleanStaticVideos(input);
  assert.equal(audit.normalizedArtistOccurrences, 1);
  assert.equal(audit.quarantinedOccurrences, 0);
  assert.equal(videos[0].songs.length, 2);
  assert.deepEqual(videos[0].songs.map(row => row.artist), ["和田光司", "和田光司"]);
  assert.equal(JSON.stringify(input), saved);
});

test("intentional 100-song endurance singing is not confused with duplicate dirty data", () => {
  const repeated = video(2, Array.from({ length: 87 }, (_, index) => ({
    ...song("勝利のマシンロボ", "未記載"),
    occurrenceId: `bUb_oMOzuf4:${index}`,
    seconds: 915 + index * 165,
  })), { title: "勝利のマシンロボ100回歌唱耐久" });
  const { videos, audit } = cleanStaticVideos([repeated]);
  assert.equal(audit.quarantinedOccurrences, 0);
  assert.equal(videos[0].songs.length, 87);
});

test("audit-confirmed historical non-song examples are quarantined without generic labels", () => {
  const confirmed = [
    ["【一般ライブ】8", "月", "16:58 【一般ライブ】8/3 (月)"],
    ["【マンデーバスターズ】ほんこん×門田隆将", "未記載", "17:40【マンデーバスターズ】ほんこん×門田隆将"],
    ["am Worship Livestream", "20-2026", "10:30am Worship Livestream | 9-20-2026"],
    ["【#雑談】🍔9", "24", "12:00 【#雑談】🍔9/24"],
    ["6", "土", "43:17 6/27（土）"],
    ["次回の配信は26日", "水", "20:00 次回の配信は26日(水)"],
    ["2026/07", "19", "1:41:57 2026/07/19"],
    ["現地ライブ「ちょっとそこまで」第三弾 12", "土", "1:31:34 現地ライブ「ちょっとそこまで」第三弾 12/19(土)"],
    ["焔魔るり Birthday Live 2026〜黄昏と揺らめいて〜 9", "木", "1:25:01 焔魔るり Birthday Live 2026〜黄昏と揺らめいて〜 9/3(木)"],
    ["【茶話会】今日のテーマは「お彼岸」です！のんびり質疑応答するだけの会 2026/09", "16", "【茶話会】今日のテーマは「お彼岸」です！のんびり質疑応答するだけの会 2026/09/16 20:00"],
    ["ここらへんで一回ブツブツになり、YouTubeを再起動", "", "ちなみに俺の不調は大体 2:40:58 ここらへんで一回ブツブツになり、YouTubeを再起動"],
    ["MC1", "クラフェス", "0:40:57 MC1（クラフェス）"],
    ["トーク", "HiMEのお話", "1:03:26 トーク(HiMEのお話)"],
    ["雑談タイム②", "意外な禁句ワード", "00:42:46 雑談タイム②(意外な禁句ワード)"],
  ];
  for (const [title, artist, raw] of confirmed) {
    assert.ok(unambiguousNonSongReason(song(title, artist, {raw})), title + " should be flagged");
  }
  for (const [title, artist, raw] of [
    ["1/2", "川本真琴", "01:17:00 1/2 / 川本真琴"],
    ["MC", "Original Artist", "10:15 MC / Original Artist"],
    ["トーク", "Original Artist", "1:03:26 トーク / Original Artist"],
    ["6", "土", "43:17 6 / 土"],
    ["ひゆるりらぱっぱ", "月", "【02:03:19】ひゆるりらぱっぱ / 月"],
  ]) assert.equal(unambiguousNonSongReason(song(title, artist, {raw})), null, title + " must be retained");
});

test("restore release-date-split song credits and never discard the source occurrence", () => {
  const table = [
    ["Go For It! \"style EDGE\"/GRANRODEO 2015/09", "30", "00:20:53 Go For It! \"style EDGE\"/GRANRODEO 2015/09/30", "Go For It! \"style EDGE\"", "GRANRODEO"],
    ["春よ、来い/松任谷由実 1994/10", "24", "01:10:55 春よ、来い/松任谷由実 1994/10/24", "春よ、来い", "松任谷由実"],
    ["Kitai/あさぎーにょ", "2017", "0:54:05 Kitai/あさぎーにょ/2017", "Kitai", "あさぎーにょ"],
  ];
  for (const [title, artist, raw, expectedTitle, expectedArtist] of table) {
    const original = song(title, artist, {raw});
    const repaired = repairReleaseDateCredit(original);
    assert.equal(repaired.title, expectedTitle);
    assert.equal(repaired.artist, expectedArtist);
    assert.equal(original.title, title);
    assert.equal(original.artist, artist);
  }
  const improvisation = song("惑星と恒星の違いがわからないの歌/幽音しの/幽音しの即興ソング", "2026", {
    raw: "1:06:14 惑星と恒星の違いがわからないの歌/幽音しの/幽音しの即興ソング/2026",
  });
  assert.strictEqual(repairReleaseDateCredit(improvisation), improvisation);
  const input = [video(1, table.map(([title, artist, raw]) => song(title, artist, {raw})))];
  const originalBytes = JSON.stringify(input);
  const {videos, audit} = cleanStaticVideos(input);
  assert.equal(audit.repairedDateCreditOccurrences, 3);
  assert.equal(audit.quarantinedOccurrences, 0);
  assert.equal(videos[0].songs.length, 3);
  assert.equal(JSON.stringify(input), originalBytes);
});

test("the artist 後ろから這いより隊G is not mistaken for release metadata", () => {
  const record = song("太陽曰く燃えよカオス", "後ろから這いより隊G");
  assert.equal(reviewReasons(record).includes("possible_release_metadata_as_artist"), false);
  assert.equal(reviewReasons(song("栞", "6thアルバム「PUZZLE」より")).includes("possible_release_metadata_as_artist"), true);
});


test("reviewed mixed chapter sources keep marked songs and remove prose timestamps", () => {
  const hash = "0ed81627410668fc890661a0687651ce3c2990631a47c4ebf2e4eb0edfb90c47";
  const prose = song("potato discussions", "未記載", {
    sourceHash: hash,
    sourceId: "Ugz51dlxGcqCVz2Zylt4AaABAg",
    raw: "26:13 potato discussions...",
  });
  const actualSong = song("STARDOM!", "未記載", {
    sourceHash: hash,
    sourceId: "Ugz51dlxGcqCVz2Zylt4AaABAg",
    raw: "2:12 ♡ 1. STARDOM!",
  });
  assert.equal(unambiguousNonSongReason(prose), "reviewed_mixed_chapter_comment");
  assert.equal(unambiguousNonSongReason(actualSong), null);
});

test("MC prose and the reviewed three-channel miracle description are quarantined", () => {
  assert.equal(unambiguousNonSongReason(song("MCパート", "今年の目標は少しでも歌を上手くなること！", {
    raw: "6:30 MCパート（今年の目標は少しでも歌を上手くなること！）",
  })), "confirmed_mc_break");
  assert.equal(unambiguousNonSongReason(song("間奏MC", "手汗がすごい！", {
    raw: "└4:20 間奏MC（手汗がすごい！）",
  })), "confirmed_mc_break");
  assert.equal(unambiguousNonSongReason(song("God Miracles Today", "", {
    raw: "God Miracles Today 11:11",
    sourceId: "description:XnDe6MpY83w:508e5918d7aa133e",
    sourceHash: "508e5918d7aa133eb0fbc4c0e16bd95e6f834cc5826b03c4b7529ef7f1fdf6b8",
  })), "reviewed_bad_description_source");
});

test("release metadata and known album labels are normalized without deleting songs", () => {
  assert.equal(normalizeReleaseMetadataArtist(song("Web of Night", "T.M.Revolution（2004/07/28）※English Version")).artist, "T.M.Revolution");
  assert.equal(normalizeReleaseMetadataArtist(song("Tell Your World", "kz ※2012-01-18")).artist, "kz");
  assert.equal(normalizeReleaseMetadataArtist(song("裸の勇者", "Vaundy【王様ランキング】（2022/01/07）※89.164点")).artist, "Vaundy");
  assert.equal(normalizeReleaseMetadataArtist(song("ビバナミダ", "アルバム 幸福", {
    raw: "2:01 ビバナミダ（アルバム 幸福）",
  }), {videoId: "jsQX01izzbY"}).artist, "岡村靖幸");
  assert.equal(normalizeReleaseMetadataArtist(song("DATE", "アルバム DATE"), {videoId: "another-video"}).artist, "アルバム DATE");
});

test("structured slash credits recover title and artist only when metadata proves the format", () => {
  const anime = song("Lion/Sheryl Nome starring May'n&Ranka Lee(CV.Megumi Nakajima)/Macross Frontier OP", "", {
    raw: "1:03:20 Lion/Sheryl Nome starring May'n&Ranka Lee(CV.Megumi Nakajima)/Macross Frontier OP/2008",
  });
  const repaired = repairStructuredSlashCredit(anime);
  assert.equal(repaired.title, "Lion");
  assert.equal(repaired.artist, "Sheryl Nome starring May'n&Ranka Lee(CV.Megumi Nakajima)");
  const improv = song("惑星と恒星の違いがわからないの歌/幽音しの/幽音しの即興ソング", "2026", {
    raw: "1:06:14 惑星と恒星の違いがわからないの歌/幽音しの/幽音しの即興ソング/2026",
  });
  const repairedImprov = repairStructuredSlashCredit(improv);
  assert.equal(repairedImprov.title, "惑星と恒星の違いがわからないの歌");
  assert.equal(repairedImprov.artist, "幽音しの");
  const ambiguous = song("A/B/C", "", { raw: "1:00 A/B/C/2020" });
  assert.strictEqual(repairStructuredSlashCredit(ambiguous), ambiguous);
});

test("exact same-video same-timestamp duplicate is removed, different timestamps remain", () => {
  const input = [video(1, [
    {...song("花に亡霊", "ヨルシカ"), seconds: 531, occurrenceId: "a"},
    {...song("花に亡霊", "ヨルシカ"), seconds: 531, occurrenceId: "b"},
    {...song("花に亡霊", "ヨルシカ"), seconds: 900, occurrenceId: "c"},
  ])];
  const saved = JSON.stringify(input);
  const {videos, audit} = cleanStaticVideos(input);
  assert.equal(audit.deduplicatedOccurrences, 1);
  assert.equal(audit.quarantinedOccurrences, 0);
  assert.deepEqual(videos[0].songs.map(x => x.seconds), [531, 900]);
  assert.equal(JSON.stringify(input), saved);
});


test("source-specific chapter formats keep numbered songs and repair known missing credits", () => {
  const claudeHash = "49c8912f79f9ef9e037189882ddbd34b2915ec8b68de9de41f314317f7fa1b7e";
  assert.equal(unambiguousNonSongReason(song("they're so giggly today", "未記載", {
    raw: "33:58 - they're so giggly today", sourceHash: claudeHash,
  })), "reviewed_mixed_chapter_comment");
  assert.equal(unambiguousNonSongReason(song("PAPERMOON", "Tommy heavenly6", {
    raw: "52:59 - 9. PAPERMOON by Tommy heavenly6 【🎫❔】", sourceHash: claudeHash,
  })), null);
  const synth = repairKnownSourceCredit(song("ハッピーシンセサイザ", "未記載", {
    raw: "47:15 - 8. ハッピーシンセサイザ (Happy Synthesizer) by EasyPop 【❔🍸】",
    sourceHash: claudeHash,
  }));
  assert.equal(synth.artist, "EasyPop");
  assert.equal(unambiguousNonSongReason(song("joshi idol anime that mariring knows aside from the stuff we know: SHE KNOWS 22", "7?????", {
    raw: "54:51 joshi idol anime that mariring knows aside from the stuff we know: SHE KNOWS 22/7?????",
    sourceHash: "6e50c51d121b4aed13920f19b3f4b4adaaf5ade07819fff8fce06e075c8a857a",
  })), "reviewed_mixed_chapter_comment");

  const robocoHash = "a7b481ab3db2c4b08ded6c4e2775e67b7e75c6f2ef4c159e9870c11907975231";
  const repaired = repairKnownSourceCredit(song(
    "115万キロのフィルム (115man Kilo no Film / 115 Million Kilometer Film) Official髭男dism",
    "未記載",
    {sourceHash: robocoHash},
  ));
  assert.equal(repaired.title, "115万キロのフィルム");
  assert.equal(repaired.artist, "Official髭男dism");
});


test("year-range structured credits and reviewed parser artifacts are repaired conservatively", () => {
  const range = repairStructuredSlashCredit(song(
    'Happy☆Material (June)/Mahora Academy Middle School Class 2-A/Anime "Negima!"',
    "2005–2008",
    {raw: '7:36:15 Happy☆Material (June)/Mahora Academy Middle School Class 2-A/Anime "Negima!" /2005–2008'},
  ));
  assert.equal(range.title, "Happy☆Material (June)");
  assert.equal(range.artist, "Mahora Academy Middle School Class 2-A");
  assert.equal(normalizeReleaseMetadataArtist(song("Lolita", "Konata Izumi /", {
    raw: "1:23:46 Lolita / Konata Izumi / 2007",
  })).artist, "Konata Izumi");
  const titleArtifact = repairKnownSourceCredit(song("34　(ｱﾝｺｰﾙ) み む かｩ わ ナ イ ス ト ラ イ", "ぬぬぬ", {
    raw: "♪2:44:34　(ｱﾝｺｰﾙ) み む かｩ わ ナ イ ス ト ラ イ | ぬぬぬ",
    sourceHash: "087f98b90de544c80795a5f24729ba2a5e1e9df8250379c29fc361e02012c6ef",
  }));
  assert.equal(titleArtifact.title, "(ｱﾝｺｰﾙ) み む かｩ わ ナ イ ス ト ラ イ");
});

test("review scanner surfaces mixed setlist/comment sources without auto-deleting them", () => {
  const hash = "mixed-review-hash";
  const rows = [
    song("Song A", "Artist A", {raw:"2:00 - 1. Song A by Artist A",sourceHash:hash}),
    song("Song B", "Artist B", {raw:"6:00 - 2. Song B by Artist B",sourceHash:hash}),
    song("Song C", "Artist C", {raw:"10:00 - 3. Song C by Artist C",sourceHash:hash}),
    song("they laugh", "未記載", {raw:"3:00 - they laugh",sourceHash:hash}),
    song("chat about food", "未記載", {raw:"7:00 - chat about food",sourceHash:hash}),
    song("wrap up", "未記載", {raw:"11:00 - wrap up",sourceHash:hash}),
    song("small reaction", "未記載", {raw:"12:00 - wow",sourceHash:hash}),
    song("another note", "未記載", {raw:"13:00 - note",sourceHash:hash}),
  ];
  const review = buildQualityReview([video(9, rows)], {byDay:{}}, new Date("2026-09-26T00:00:00Z"));
  assert.equal(review.mixedStructuredSetlistSources.length, 1);
  assert.equal(review.mixedStructuredSetlistSources[0].unknownNonNumberedRows, 5);
  assert.equal(review.mixedStructuredSetlistSources[0].explicitNumberedSongs, 3);
});


test("full-history source-proven residual credits are repaired without inference", () => {
  const table = [
    [song("奏", "オリ曲 YOU＆合図 リリース／明日は祝日", {
      raw: "1:11:42 奏／オリ曲 YOU＆合図 リリース／明日は祝日",
      sourceHash: "f62db69ee3c93d0d093367cd8755d892498b361e289772acc62c8dd972c422aa",
    }), "奏", "スキマスイッチ"],
    [song("祝日天国", "7", {
      raw: "1:05:43　10.祝日天国／35.7（2022/07/31）【NEW】",
      sourceHash: "924e1a18c91dd603a7be0e9523559988d299ff51e649624795ba0402d60f5a4e",
    }), "祝日天国", "35.7"],
    [song("乙女のルートはひとつじゃない！", "乙女ゲームの破滅フラグしかない悪役令嬢に転生してしまった…", {
      sourceHash: "3665facacaf3ad5caa221a2a0bbd346a2c5adf66fe0f69ce4bcc9bae83a46c6a",
    }), "乙女のルートはひとつじゃない！", "angela"],
    [song("1", "2", {
      raw: '8:55:05 1/2/Kawamoto Makoto/Anime "Rurouni Kenshin" OP/1997',
      sourceHash: "7b6b7ed5a0d5ef6faa6271a57adca3ce57654e5984e7f515845853adfb0e8da0",
    }), "1/2", "川本真琴"],
    [song("FLAGS", "T.M.Revolution (劇場版 戦国BASARA The Last Party OP 及び PSPの戦国BASARAクロニクルヒーローズ主題歌(やはりゲームもでした))", {
      sourceHash: "401adaa520f8e84434c4e8581ede7277564e44dc0448fe962bccd7fe78d6046a",
    }), "FLAGS", "T.M.Revolution"],
  ];
  for (const [input, expectedTitle, expectedArtist] of table) {
    const repaired = repairKnownSourceCredit(input);
    assert.equal(repaired.title, expectedTitle);
    assert.equal(repaired.artist, expectedArtist);
  }
  const eightyEight = repairKnownSourceCredit(song("栞", "6thアルバム「PUZZLE」より", {
    sourceHash: "99b19f47604cfddfb64f05e5317e359c4d90755ed1c2b3f5cb169c52f9f45bc9",
  }));
  assert.equal(eightyEight.artist, "Eighty eight");
  const duca = repairKnownSourceCredit(song("観覧車~あの日と、昨日と今日と明日と~／Duca／work", "あざらしそふと (2020)", {
    raw: "2:37:05 観覧車~あの日と、昨日と今日と明日と~／Duca／work／2020",
    sourceHash: "d723897d567d473dd7aea57f04f8ad70a15479135d554e912b12368fcf1b117a",
  }));
  assert.equal(duca.title, "観覧車～あの日と、昨日と今日と明日と～");
  assert.equal(duca.artist, "Duca");
});

test("structured slash repair accepts a trailing reviewed year annotation", () => {
  const input = song("世界の約束/倍賞千恵子/ハウルの動く城 主題歌", "2004 ※木村弓のアルバム『流星』（2003年）収録の同名曲のカバー", {
    raw: "1:53:42 世界の約束/倍賞千恵子/ハウルの動く城 主題歌/2004 ※木村弓のアルバム『流星』（2003年）収録の同名曲のカバー",
  });
  const repaired = repairStructuredSlashCredit(input);
  assert.equal(repaired.title, "世界の約束");
  assert.equal(repaired.artist, "倍賞千恵子");
});

test("release metadata normalization removes work labels only when coupled to a release date", () => {
  assert.equal(
    normalizeReleaseMetadataArtist(song("裸の勇者", "Vaundy【王様ランキング】（2022/01/07）※89.164点")).artist,
    "Vaundy",
  );
  assert.equal(
    normalizeReleaseMetadataArtist(song("Maybe Artist", "Unit【Official Artist Name】")).artist,
    "Unit【Official Artist Name】",
  );
});


test("reviewed historical mixed-source policies keep proven songs and quarantine chapters", () => {
  const cases = [
    [song("ひな結構基本おしがま", "未記載", {
      raw: "2:06:458 ひな結構基本おしがま",
      sourceHash: "30d4fba63bb782028af7ca03a506cf94714933e93de48d1c5eef13b84d9438a4",
    }), "reviewed_mixed_chapter_comment"],
    [song("ワールドイズマイン", "ryo(supercell) feat. 初音ミク", {
      raw: "01,10:17 ワールドイズマイン / ryo(supercell) feat. 初音ミク",
      sourceHash: "30d4fba63bb782028af7ca03a506cf94714933e93de48d1c5eef13b84d9438a4",
    }), null],
    [song("歯医者", "未記載", {
      raw: "3:02 歯医者",
      sourceHash: "e0d69e03eeba0ccb8e420e88af51d810907dfb9b1e8b50d98579bf4d8646df60",
    }), "reviewed_mixed_chapter_comment"],
    [song("謎", "未記載", {
      raw: "13:12 ▶ 謎",
      sourceHash: "e0d69e03eeba0ccb8e420e88af51d810907dfb9b1e8b50d98579bf4d8646df60",
    }), null],
    [song("猫の鳴き声1", "未記載", {
      raw: "50:19 猫の鳴き声1",
      sourceHash: "c2f39a5fb479d4d148f076609150d3662d0bef7611973817c5f56f2ea7d6af4e",
    }), "reviewed_mixed_chapter_comment"],
    [song("No Logic", "ジミーサムP", {
      raw: "1:50:40 No Logic / ジミーサムP",
      sourceHash: "c2f39a5fb479d4d148f076609150d3662d0bef7611973817c5f56f2ea7d6af4e",
    }), null],
    [song("船キャンセル", "未記載", {
      raw: "30:18 船キャンセル",
      sourceHash: "ae9a67b4a59214c5b5936d095e43ea9e11c46133b79891c2d968cc5f65db219f",
    }), "reviewed_mixed_chapter_comment"],
    [song("Hero’s Come Back!!", "nobodyknows+", {
      raw: "𝟎𝟏. 0:04:33 Hero’s Come Back!!✦nobodyknows+",
      sourceHash: "ae9a67b4a59214c5b5936d095e43ea9e11c46133b79891c2d968cc5f65db219f",
    }), null],
    [song("（次回に延期）", "未記載", {
      raw: "9:48 （次回に延期）",
      sourceHash: "1922f6d700c7615e8ff682c9ea9ac82ea19d0b2a145d31e4ea73df7d243bc352",
    }), "reviewed_mixed_chapter_comment"],
    [song("メトロノーム", "米津玄師", {
      raw: "8:35 メトロノーム / 米津玄師",
      sourceHash: "1922f6d700c7615e8ff682c9ea9ac82ea19d0b2a145d31e4ea73df7d243bc352",
    }), null],
    [song("MC(初歌の感想、風呂エコー)", "", {
      raw: "23:20 MC(初歌の感想、風呂エコー)",
      sourceHash: "c2fe7785dffa7d43c6405b4efd19edb8dfa6d3d0d276084a42c6431f16ee8777",
    }), "reviewed_mixed_chapter_comment"],
    [song("だから僕は音楽を辞めた", "ヨルシカ", {
      raw: "29:50 だから僕は音楽を辞めた/ヨルシカ",
      sourceHash: "c2fe7785dffa7d43c6405b4efd19edb8dfa6d3d0d276084a42c6431f16ee8777",
    }), null],
    [song("休憩9", "", {
      raw: "4:25:26 休憩9",
      sourceHash: "2f784a14e4122ab625a239f2693dd725658688982e1b9aa526fad3f379efe188",
    }), "reviewed_source_activity_chapter"],
    [song("点描の唄", "", {
      raw: "4:16:11 点描の唄",
      sourceHash: "2f784a14e4122ab625a239f2693dd725658688982e1b9aa526fad3f379efe188",
    }), null],
  ];
  for (const [row, expected] of cases) assert.equal(unambiguousNonSongReason(row), expected);
  assert.equal(
    unambiguousNonSongReason(song("弾き語り再開", "未記載", { sourceHash: "different-source" })),
    null,
    "source-reviewed activity names must never become global title bans",
  );
});

test("reviewed exact historical activity rows are source-bound", () => {
  const cases = [
    ["しずさん感想", "未記載", "0d63e5c4ca38df917fb58c74f1b5be81c8a54a893fdd1050b81aad849e18314d"],
    ["弾き語り再開", "未記載", "b04aa8bcb7319194e2eb49532361b52f9c69682e2391caa690f814dbbf240a3c"],
    ["100曲歌いきり達成！！", "未記載", "1af631bc2ab20bdb747ac3472747891c983e70837523efde6ad2a7b65c4d41d7"],
    ["～8", "15", "aecd22582a4e2bbd1ee61cece9d5e420e1c8dcb5252ac3e776b159572c932710"],
    ["ワンマンライブ12", "19", "1417a20bd96f281a8175858186e650a70612f18bb745400dc20ca8d0161c253f"],
    ["【#雑談】🍔9", "24", "4bb6b16914332005d78c5618640485453eff7d6369b6b5a2216185e6647522ac"],
  ];
  for (const [title, artist, sourceHash] of cases) {
    assert.equal(
      unambiguousNonSongReason(song(title, artist, { raw: "00:10 " + title + "/" + artist, sourceHash })),
      "reviewed_source_activity_chapter",
    );
  }
  assert.equal(
    unambiguousNonSongReason(song("トーク", "お見送り", {
      raw: "3:10:24 トーク (お見送り)",
      sourceHash: "4f0ebf635214d0dc35c7423a0a51578f8996f8086ee17aa5ec573be364db84a9",
    })),
    "reviewed_source_activity_chapter",
  );
});

test("reviewed Urara chapter source keeps and repairs its actual song", () => {
  const sourceHash = "7d072c6a6bd42aa23a499fbc04ed5cbffc12a44a51d5456644a1b6cff6ace681";
  assert.equal(unambiguousNonSongReason(song("おはうら～", "未記載", {
    raw: "0:07:55 おはうら～", sourceHash,
  })), "reviewed_mixed_chapter_comment");
  const row = song("Luv Rendezvous 💎 七海うらら", "七海の日～！ｺｰﾚｽ", {
    raw: "1:56:14🎤08. Luv Rendezvous 💎 七海うらら (七海の日～！ｺｰﾚｽ）",
    sourceHash,
  });
  assert.equal(unambiguousNonSongReason(row), null);
  const repaired = repairKnownSourceCredit(row);
  assert.equal(repaired.title, "Luv Rendezvous");
  assert.equal(repaired.artist, "七海うらら");
});

test("quality review exposes activity candidates and no longer truncates mixed sources at 120", () => {
  assert.ok(reviewReasons(song("締めの挨拶", "未記載", { raw: "1:49:50 締めの挨拶" }))
    .includes("possible_activity_chapter"));
  const videos = Array.from({ length: 121 }, (_, index) => {
    const sourceHash = "hash-" + index;
    return video(index + 1000, [
      song("Song A", "Artist A", { raw: "01. Song A / Artist A", sourceHash }),
      song("Song B", "Artist B", { raw: "02. Song B / Artist B", sourceHash }),
      song("Song C", "Artist C", { raw: "03. Song C / Artist C", sourceHash }),
      song("chat one", "未記載", { raw: "04:00 chat one", sourceHash }),
      song("chat two", "未記載", { raw: "05:00 chat two", sourceHash }),
      song("chat three", "未記載", { raw: "06:00 chat three", sourceHash }),
      song("chat four", "未記載", { raw: "07:00 chat four", sourceHash }),
      song("chat five", "未記載", { raw: "08:00 chat five", sourceHash }),
    ]);
  });
  const result = buildQualityReview(videos, { byDay: {} }, new Date("2026-09-27T00:00:00Z"));
  assert.equal(result.mixedStructuredSetlistSources.length, 121);
});


test("second full-history pass uses source structure instead of unknown-artist deletion", () => {
  const otsuka = "9ef1860f9676617e865cc613ba0a58db75fbf30fb1ffd8f903682b7cdf0d8ca1";
  assert.equal(unambiguousNonSongReason(song("(Who is Otsuka Ray?)", "未記載", {
    raw: "0:08:26 (Who is Otsuka Ray?)", sourceHash: otsuka,
  })), "reviewed_mixed_chapter_comment");
  assert.equal(unambiguousNonSongReason(song("愛♡スクリ~ム!", "未記載", {
    raw: "0:24:21 05-愛♡スクリ~ム!", sourceHash: otsuka,
  })), null);

  const hisagi = "ca0982ddee79fcf66cff3f5f20e2ac15539603a7d8a538d5cd9176d40f6d5d61";
  assert.equal(unambiguousNonSongReason(song("床で寝落ち", "未記載", {
    raw: "0:07:28 床で寝落ち", sourceHash: hisagi,
  })), "reviewed_mixed_chapter_comment");
  assert.equal(unambiguousNonSongReason(song("さよならメモリー", "7!!", {
    raw: "2:00:44 ［さよならメモリー／7!!］", sourceHash: hisagi,
  })), null);

  const minase = "930bc7636c4c769fa8a832e8ea56faed82c9a6c76b31db3f000a499885f18b26";
  assert.equal(unambiguousNonSongReason(song("( MC, 曲前語り )", "", {
    raw: "06:59 ( MC, 曲前語り )", sourceHash: minase,
  })), "reviewed_mixed_chapter_comment");
  assert.equal(unambiguousNonSongReason(song("蛍", "RADWIMPS", {
    raw: "01:48 1. 蛍／RADWIMPS", sourceHash: minase,
  })), null);
});

test("second full-history pass removes only reviewed MC, greeting and chatter rows", () => {
  assert.equal(unambiguousNonSongReason(song("MC - リプもらった！！", "", {
    raw: "0:20:09 MC - リプもらった!!",
    sourceHash: "92a7e650f684e741d7da5d2dfc6c2344abb06d8829c46237b25604f8716a5da6",
  })), "reviewed_source_activity_chapter");
  assert.equal(unambiguousNonSongReason(song("め組のひと", "", {
    raw: "01.【0:08:32】め組のひと",
    sourceHash: "92a7e650f684e741d7da5d2dfc6c2344abb06d8829c46237b25604f8716a5da6",
  })), null);
  assert.equal(unambiguousNonSongReason(song("今日は酒やな", "", {
    raw: "2:31:35 今日は酒やな",
    sourceHash: "8f6931da27cc8151b3f7fb4e0163c07b238cebca5bd9ee21790850b466063ebf",
  })), "reviewed_source_activity_chapter");
  assert.equal(unambiguousNonSongReason(song("今日は酒やな", "", {
    raw: "2:31:35 今日は酒やな",
    sourceHash: "unreviewed-source",
  })), null);
  assert.equal(unambiguousNonSongReason(song("わこチョま", "", {
    raw: "4:40 わこチョま",
    sourceHash: "e3d480117f9e4eb504e6ffea2c5998a689bb46c3fe9019446acdf971e0b2ff40",
  })), "reviewed_source_activity_chapter");
});

test("reviewed tab and underscore setlists recover title and artist from exact source rows", () => {
  const tabHash = "a2014dae610c4d64cabf398a0ac40f72c0a8f6475d02e05d068393071cd545a1";
  let repaired = repairKnownSourceCredit(song("青と夏\tMrs. GREEN APPLE", "", {
    raw: "1\t青と夏\tMrs. GREEN APPLE\t0:13:17", sourceHash: tabHash,
  }));
  assert.equal(repaired.title, "青と夏");
  assert.equal(repaired.artist, "Mrs. GREEN APPLE");
  repaired = repairKnownSourceCredit(song("W/X", "Y Tani Yuuki", {
    raw: "18\tW/X/Y\tTani Yuuki\t2:17:17", sourceHash: tabHash,
  }));
  assert.equal(repaired.title, "W/X/Y");
  assert.equal(repaired.artist, "Tani Yuuki");

  const underscoreHash = "478f401bb24ee9ed1d84eb42f0679395ee7b93c24c8bbff25d86e3120ea79661";
  repaired = repairKnownSourceCredit(song("深愛　＿水樹奈々", "", {
    raw: "11:09 深愛　＿水樹奈々", sourceHash: underscoreHash,
  }));
  assert.equal(repaired.title, "深愛");
  assert.equal(repaired.artist, "水樹奈々");
  repaired = repairKnownSourceCredit(song("(アンコール)Ｓｙｎｃｈｒｏｇａｚｅｒ　＿水樹奈々", "", {
    raw: "1:41:39 (アンコール)Ｓｙｎｃｈｒｏｇａｚｅｒ　＿水樹奈々", sourceHash: underscoreHash,
  }));
  assert.equal(repaired.title, "Synchrogazer");
  assert.equal(repaired.artist, "水樹奈々");
});

test("reviewed harp timeline drops comment continuations and repairs attached annotations only", () => {
  const hash = "6c02c324915aa78e9c30deda5783635ebff969c99c89d8828f8f24486711c5bd";
  assert.equal(unambiguousNonSongReason(song("好聽故事一直聽)", "", {
    raw: "05:02:37好聽故事一直聽)", sourceHash: hash,
  })), "reviewed_source_activity_chapter");
  let repaired = repairKnownSourceCredit(song("忘れじ言の葉(整段話只有", "", {
    raw: "07:18:37 忘れじ言の葉(整段話只有", sourceHash: hash,
  }));
  assert.equal(repaired.title, "忘れじ言の葉");
  repaired = repairKnownSourceCredit(song("フクロウ", "學貓頭鷹叫真的架勾錐", {
    raw: "04:25:29 フクロウ(學貓頭鷹叫真的架勾錐)", sourceHash: hash,
  }));
  assert.equal(repaired.title, "フクロウ");
  assert.equal(repaired.artist, "");
});
