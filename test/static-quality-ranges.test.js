"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  cleanStaticVideos,
  isExplicitNumberedSetlistRow,
  normalizeConservativeArtist,
  normalizeReleaseMetadataArtist,
  repairKnownSourceCredit,
  repairReleaseDateCredit,
  repairStructuredSlashCredit,
  repeatedDescriptionSources,
  unambiguousNonSongReason,
} = require("../scripts/static/quality-guard");
const { filterRange, shanghaiCalendarStart } = require("../scripts/static/collect-and-build");
const { buildQualityReview, hasUnbalancedCreditDelimiters, reviewReasons } = require("../scripts/static/quality-review");

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


test("reviewed historical mixed setlists drop only source-bound talk chapters", () => {
  const rows = [
    ["eaa8f87146f3fb5bc0d06b8c918efa421fafcd0a68053d288ab233a87900821a", "学文路トキ さん"],
    ["cfdabe4c9486f849e9b103ddec6532b1f74b1d4656add59b9854342d6955fc67", "Soraさん"],
    ["da296b61ea105747d1fa4527becd8e0c253f92e7d3efedd2cd8fa8017d5e55ad", "何選曲したっけ…"],
    ["472599b63ab850c21f239c14359636ec399e14fc860b9c5c7541e6e6c2baed80", "イベントの規模がでかい"],
    ["f60e7d209b0f8a7a088c520ddf48a4003e898576dee09ba6b84742fe723cb1a0", "今日はお披露目あり"],
    ["14b62e6cf9ca10b9a65ad61c8206c716303081b558d4abe1f6caac4193c16a93", "重大発表②『歌ってみた』"],
    ["c42bc673a091cab8fb3a026527c7452440b7b34814debb56a9b944b7248811f1", "ストーリーのあらすじ"],
    ["2d5b755ce969ec2a9a7970440f52728f4054b8daa5a15efcb0451752502cd0c0", "Talk segment"],
  ];
  for (const [sourceHash, title] of rows) {
    assert.equal(unambiguousNonSongReason(song(title, "", {sourceHash, raw: "1:00 " + title})), "reviewed_source_activity_chapter");
    assert.equal(unambiguousNonSongReason(song(title, "", {sourceHash: "not-reviewed", raw: "1:00 " + title})), null);
  }
  assert.equal(unambiguousNonSongReason(song("どこまでも", "", {
    sourceHash: "f60e7d209b0f8a7a088c520ddf48a4003e898576dee09ba6b84742fe723cb1a0",
    raw: "0:37:01 どこまでも (アカペラ)",
  })), null);
  assert.equal(unambiguousNonSongReason(song("花に亡霊", "", {
    sourceHash: "14b62e6cf9ca10b9a65ad61c8206c716303081b558d4abe1f6caac4193c16a93",
    raw: "11:58 【花に亡霊】",
  })), null);
});

test("performance-status text is not published as the song artist", () => {
  assert.equal(normalizeConservativeArtist(song("残響讃歌", "歌えません", {
    raw: "42:27 残響讃歌(歌えません)",
  })).artist, "");
  assert.equal(normalizeConservativeArtist(song("グリーンライツ・セレナーデ-piano Ver", "練習中", {
    raw: "1:37:35 グリーンライツ・セレナーデ-piano Ver.-(練習中)",
  })).artist, "");
  assert.equal(normalizeConservativeArtist(song("イキナクチャ", "ロマニードットアイオー ✨Original Song✨", {
    raw: "1:39:40 06. イキナクチャ - ロマニードットアイオー ✨Original Song✨",
  })).artist, "ロマニードットアイオー");
  assert.equal(normalizeConservativeArtist(song("歌えません", "歌えません", {
    raw: "1:00 歌えません / 歌えません",
  })).artist, "歌えません");
});

test("three-part year credits and commercial metadata recover artist without broad guessing", () => {
  const simple = repairStructuredSlashCredit(song("Koi no Ageha/Yukari Tamura", "", {
    raw: "2:01:12 Koi no Ageha/Yukari Tamura/2009",
  }));
  assert.equal(simple.title, "Koi no Ageha");
  assert.equal(simple.artist, "Yukari Tamura");

  const commercial = repairStructuredSlashCredit(song("StaRt/Mrs. GREEN APPLE/花王「メリット」のCMソング", "", {
    raw: "06:33 StaRt/Mrs. GREEN APPLE/花王「メリット」のCMソング/2015",
  }));
  assert.equal(commercial.title, "StaRt");
  assert.equal(commercial.artist, "Mrs. GREEN APPLE");

  const ambiguous = song("A/B", "", {raw: "1:00 A/B/not-a-year"});
  assert.strictEqual(repairStructuredSlashCredit(ambiguous), ambiguous);
});


test("reviewed numbered setlists keep explicit songs and reject only unnumbered chapters", () => {
  const hash = "0c4e427c76ae5910267ca613807e36fd3fb14d1a9ec2d866846481d3e59ad71b";
  const real = song("残機", "ずっと真夜中でいいのに。", {
    raw: "0:08:18 01. 残機 - ずっと真夜中でいいのに。",
    sourceHash: hash,
  });
  const talk = song("豪華なドレス姿のらんぜ", "", {
    raw: "┗ 0:38:08 豪華なドレス姿のらんぜ",
    sourceHash: hash,
  });
  assert.equal(isExplicitNumberedSetlistRow(real.raw), true);
  assert.equal(unambiguousNonSongReason(real), null);
  assert.equal(isExplicitNumberedSetlistRow(talk.raw), false);
  assert.equal(unambiguousNonSongReason(talk), "reviewed_non_song_chapter_in_numbered_setlist");
  assert.equal(isExplicitNumberedSetlistRow("𝟎𝟏. 0:04:33 Hero’s Come Back!!✦nobodyknows+"), true);
});

test("full-history review no longer treats long valid cast credits as dirt", () => {
  const legitimate = song(
    "Love∞Destiny",
    "佐久間まゆ (CV: 牧野由依)、北条加蓮 (CV: 渕上舞)、小日向美穂 (CV: 津田美波)、多田李衣菜 (CV: 青木瑠璃子)、緒方智絵里 (CV: 大空直美)",
  );
  assert.deepEqual(reviewReasons(legitimate), []);
  assert.equal(hasUnbalancedCreditDelimiters("妹S [土間うまる(CV.田中あいみ)"), true);
  assert.ok(reviewReasons(song("うまるん体操", "妹S [土間うまる(CV.田中あいみ)")).includes("possible_unparsed_credits"));
});

test("mixed-source review requires numbered-song evidence instead of guessing from artist presence", () => {
  const hash = "review-mixed";
  const ordinary = Array.from({length:8}, (_, i) => song("Song " + i, i < 3 ? "Artist " + i : "", {
    raw: String(i + 1) + ":00 Song " + i,
    sourceHash: hash,
  }));
  const ordinaryReview = buildQualityReview([video(30, ordinary)], {byDay:{}}, new Date("2026-09-26T00:00:00Z"));
  assert.equal(ordinaryReview.mixedStructuredSetlistSources.length, 0);

  const structured = [
    song("Song A", "Artist A", {raw:"1:00 01. Song A - Artist A",sourceHash:hash}),
    song("Song B", "Artist B", {raw:"5:00 02. Song B - Artist B",sourceHash:hash}),
    song("Song C", "Artist C", {raw:"9:00 03. Song C - Artist C",sourceHash:hash}),
    ...Array.from({length:5}, (_, i) => song("chat " + i, "", {raw:(i+2)+":30 chat "+i,sourceHash:hash})),
  ];
  const structuredReview = buildQualityReview([video(31, structured)], {byDay:{}}, new Date("2026-09-26T00:00:00Z"));
  assert.equal(structuredReview.mixedStructuredSetlistSources.length, 1);
});

test("Japanese game metadata and source-proven malformed credits are repaired", () => {
  const game = normalizeReleaseMetadataArtist(song(
    "愛ADRENALIN",
    "狛江･クリストフ･ヨウスケ(鈴木達央) / ゲーム『Scared Rider Xechs』キャラクターソングCD第四弾『Scared Rider Xechs DRAMATIC CHARACTER CD Vol.4』収録",
  ));
  assert.equal(game.artist, "狛江・クリストフ・ヨウスケ(鈴木達央)");

  const repaired = repairKnownSourceCredit(song(
    "うまるん体操",
    "妹S（シスターズ） [土間うまる(CV.田中あいみ)、海老名菜々(CV.影山 灯)、本場切絵(CV.白石晴香)、橘・シルフィンフォード(CV.古川由利奈)",
    {
      raw: "② 51:38 うまるん体操 / 妹S（シスターズ） [土間うまる(CV.田中あいみ)、海老名菜々(CV.影山 灯)、本場切絵(CV.白石晴香)、橘・シルフィンフォード(CV.古川由利奈)]",
      sourceHash: "132be6b41618301ab3f400aeda33d5eb3b287beacda40f1ddbe2b1e944a3798f",
    },
  ));
  assert.match(repaired.artist, /\]$/u);
  assert.deepEqual(reviewReasons(repaired), []);
});


test("final numbered-source pass removes speeches while keeping unnumbered real songs in mixed sources", () => {
  const speechHash = "228c383678249eecd538161b93282bc2215495be1736c2d7270cbdbc9993f6e1";
  assert.equal(unambiguousNonSongReason(song("口上①", "", {raw:"07:27 口上①", sourceHash:speechHash})), "reviewed_non_song_chapter_in_numbered_setlist");
  assert.equal(unambiguousNonSongReason(song("思想犯", "ヨルシカ", {raw:"03:15 1. 思想犯/ヨルシカ", sourceHash:speechHash})), null);

  const relayHash = "e916c9ce505c107c706f25bdcd129e6892b2acd1143aeebafafe63bd5e3b7a2c";
  assert.equal(unambiguousNonSongReason(song("本日の意気込み", "未記載", {raw:"08:47 本日の意気込み",sourceHash:relayHash})), "reviewed_source_activity_chapter");
  assert.equal(unambiguousNonSongReason(song("OP曲:烈火", "百瀬ヒバナ", {raw:"00:55 OP曲:烈火 / 百瀬ヒバナ",sourceHash:relayHash})), null);

  const devilithHash = "891b820cfb8e6a53645d354b197fffef38e415e4f944ac14d5844b30d685fd78";
  assert.equal(unambiguousNonSongReason(song("4周年重大發表宣傳", "", {raw:"36:25 4周年重大發表宣傳",sourceHash:devilithHash})), "reviewed_source_activity_chapter");
  assert.equal(unambiguousNonSongReason(song("肚子餓之歌", "", {raw:"44:53 肚子餓之歌",sourceHash:devilithHash})), null);
});

test("source-proven artist metadata suffixes are normalized without deleting the song", () => {
  const cases = [
    ["Aimer (作詞:aimerrhythm、田中ユウスケ / 作曲:田中ユウスケ) [2025年", "Aimer", "01. 00:12:13 やさしい舞踏会 / Aimer (作詞:aimerrhythm、田中ユウスケ / 作曲:田中ユウスケ) [2025年]"],
    ["Whiteberry (J", "Whiteberry", "2:22:30 17.夏祭り/Whiteberry (J)"],
    ["黒うさP(2011", "黒うさP", "7:09 (1)千本桜/黒うさP(2011)"],
    ["ONE OK ROCK [2010年", "ONE OK ROCK", "00:42:19 Wherver you are / ONE OK ROCK [2010年]"],
    ["米津玄師(🛼ソロ", "米津玄師", "00:29:06 M04. 地球儀 / 米津玄師(🛼ソロ)"],
    ["ロクデナシ [一瞬迷子", "ロクデナシ", "37:44 06. 心の奥 / ロクデナシ [一瞬迷子]"],
    ["Zhou Shen hoyo-mix [Honkai Impact 3rd", "Zhou Shen hoyo-mix", "39:55 Rubia - Zhou Shen hoyo-mix [Honkai Impact 3rd]"],
    ["ポリスピカデリー(cover 羽月うずな", "ポリスピカデリー", "EDBGM 2:46:59 センティメント/ポリスピカデリー(cover 羽月うずな"],
  ];
  for (const [artist, expected, raw] of cases) {
    assert.equal(normalizeReleaseMetadataArtist(song("fixture", artist, {raw})).artist, expected);
  }
});

test("raw-proven closing credit delimiters are restored, but invented closers are not", () => {
  assert.equal(normalizeReleaseMetadataArtist(song("When She Loved Me", "Jessie [CV: Sarah McLachlan", {
    raw:"00:30:20 05. When She Loved Me / Jessie [CV: Sarah McLachlan]",
  })).artist, "Jessie [CV: Sarah McLachlan]");
  assert.equal(normalizeReleaseMetadataArtist(song("可愛くてごめん", "HoneyWorks feat.ちゅーたん(cv:早見沙織", {
    raw:"3:08:02 11. 可愛くてごめん / HoneyWorks feat.ちゅーたん(cv:早見沙織)",
  })).artist, "HoneyWorks feat.ちゅーたん(cv:早見沙織)");
  assert.equal(normalizeReleaseMetadataArtist(song("千石", "千石撫子(花澤香菜", {
    raw:"2:01:21 千石 / 千石撫子(花澤香菜",
  })).artist, "千石撫子(花澤香菜");
});

test("year-split, work-date, and four-field metadata rows recover title and artist from raw evidence", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(repairStructuredSlashCredit(song("お化けなんていないさ/弘田三枝子", "1966", {
      raw:"0:04:32 お化けなんていないさ/弘田三枝子/1966",
    }))).filter(([key]) => ["title","artist"].includes(key))),
    {title:"お化けなんていないさ",artist:"弘田三枝子"},
  );
  const work = repairStructuredSlashCredit(song("Beautiful World", "未記載", {
    raw:"1:07:46 11.Beautiful World/宇多田ヒカル【ヱヴァンゲリヲン新劇場版:序】(2007/08/29)",
  }));
  assert.equal(work.artist, "宇多田ヒカル");
  const tv = repairStructuredSlashCredit(song("夏色/ゆず/「スペースシャワーTV」6月期の曲", "1998", {
    raw:"08:31 夏色/ゆず/「スペースシャワーTV」6月期の曲/1998",
  }));
  assert.equal(tv.title, "夏色");
  assert.equal(tv.artist, "ゆず");
});

test("quoted work/date source recovers its artist and voice-only chapter stays quarantined", () => {
  const hash = "eb659bd57798713ec33ed807d1086758e7611b52e9567197983478e92fd74193";
  const raw = "8:01 ｢創聖のアクエリオン/創聖のアクエリオン:OP｣2005年4月27日【AKINO from bless4】";
  const fixed = repairKnownSourceCredit(song("｢創聖のアクエリオン", "創聖のアクエリオン:OP｣2005年4月27日", {raw,sourceHash:hash}));
  assert.equal(fixed.title, "創聖のアクエリオン");
  assert.equal(fixed.artist, "AKINO from bless4");
  assert.equal(unambiguousNonSongReason(song("｢ゴミ", "シスタークレア罵倒ボイス｣2026年7月1日", {
    raw:"1:12:01 ｢ゴミ/シスタークレア罵倒ボイス｣2026年7月1日【シスタークレア】",
    sourceHash:hash,
  })), "reviewed_source_activity_chapter");
});

test("double-slash work metadata source repairs FictionJunction without splitting .hack//Roots", () => {
  const fixed = repairKnownSourceCredit(song("Silly-Go-Round／FictionJunction／.hack", "未記載", {
    raw:"19:50 Silly-Go-Round／FictionJunction／.hack//Roots OP",
    sourceHash:"9cbc8fd9b1f9f5bc24b2ae7929994e406e7b574af0eda8d0ef74b6a666535e1e",
  }));
  assert.equal(fixed.title, "Silly-Go-Round");
  assert.equal(fixed.artist, "FictionJunction");
});


test("residual full-history review removes only source-proven activity chapters", () => {
  const dirty = [
    song("26日", "土", {
      raw: "26:43　26日(土)",
      sourceHash: "c2f658ac301da176cdf73b8d81f27f47ab9b8cead6a5bbd48f952a11703fa81f",
    }),
    song("???", "??? )↓と同じ？", {
      raw: "( 1:34:36 ??? / ??? )↓と同じ？",
      sourceHash: "04d86c87e7b05ace07991f6073189c1c62a6a2e56723a2555514fe52a323285b",
    }),
    song("Talk Time", "月見バーガー ! !", {
      raw: "【01:09:48】:_あのー: Talk Time // 月見バーガー ! !",
      sourceHash: "cc5f41656f02400f6cb81c857ca689a0fc3bb1b7e2c0ae6cfba3c744ee7886b7",
    }),
    song("コンビニOBとして先輩風", "", {
      raw: "01:17:11 コンビニOBとして先輩風",
      sourceHash: "4f438a8da6cd94680ce230ff82d670100ea645c7a9ee37a4d00eccd82386687a",
    }),
  ];
  for (const row of dirty) assert.equal(unambiguousNonSongReason(row), "reviewed_source_activity_chapter");

  assert.equal(unambiguousNonSongReason(song("ひゆるりらぱっぱ", "月", {
    raw: "【02:03:19】ひゆるりらぱっぱ / 月",
    sourceHash: "e52b04dc28b044bee7527bf9081090b23d0daf09c7e2f9b9257d1320a29bad41",
  })), null);
});

test("residual malformed credits are repaired from their reviewed source rows", () => {
  const rows = [
    [song("GO!GO!MANIAC", "", {
      raw: "1:17:06 GO!GO!MANIAC / 桜高軽音部/放課後ティータイム / アニメ けいおん!!(2011)",
      sourceHash: "7c8916d1842c73094cbbf8a79577a40c4b26a60541d7c23db2ebf494bfb99963",
    }), "GO!GO!MANIAC", "放課後ティータイム"],
    [song("鳥の詩", "", {
      raw: "40:14 鳥の詩/key作品/AIR",
      sourceHash: "03d057937b4a250e8401f44c925adbc863ce3eb0209a6a7b55377633c8efdda6",
    }), "鳥の詩", ""],
    [song("猫／DISH//", "", {
      raw: "00:19:07 04. 猫／DISH//",
      sourceHash: "6bf40ecd74e76a6bbff3bd013cf1fa7096c4f281178f5347e399de678d5b5b63",
    }), "猫", "DISH//"],
    [song("KISS OF DEATH (Produced", "HYDE)／中島美嘉", {
      raw: "0:39:44 KISS OF DEATH (Produced by HYDE)／中島美嘉",
      sourceHash: "6ca8928630b3a52aebc13bbeaed3af13dcd186955da7b5ad5c87b48ee3c0be29",
    }), "KISS OF DEATH", "中島美嘉"],
    [song("檄!帝国華撃団", "", {
      raw: "40:20 檄!帝国華撃団 / ゲーム サクラ大戦(1996) / アニメ(2000)",
      sourceHash: "28ae2a831a0734f65d0780d861156e21ce1d248beeeef0f71e0c2cdae72cc3ad",
    }), "檄!帝国華撃団", ""],
    [song("前前前世", "RADWIMPS [途中迷子", {
      raw: "20:43  02. 前前前世  /  RADWIMPS  [途中迷子]",
      sourceHash: "75f339dfc59363f1494867a75be85070cd4d0ef485456472535d3a2578c864f1",
    }), "前前前世", "RADWIMPS"],
  ];
  for (const [row, title, artist] of rows) {
    const repaired = repairKnownSourceCredit(row);
    assert.equal(repaired.title, title);
    assert.equal(repaired.artist, artist);
  }
});

test("review-only scan detects status/year metadata while keeping them out of auto-delete rules", () => {
  assert(reviewReasons(song("irony", "ClariS(2010)", {
    raw: "04:01 irony / ClariS(2010) / アニメ 俺の妹がこんなに可愛いわけがない/OP",
  })).includes("possible_year_suffix_as_artist_metadata"));
  assert(reviewReasons(song("CLEAR", "坂本真綾 [ワンコーラスVer.]", {
    raw: "8:29  01. CLEAR / 坂本真綾 [ワンコーラスVer.]",
  })).includes("possible_performance_status_in_artist"));
  assert.equal(unambiguousNonSongReason(song("irony", "ClariS(2010)", {
    raw: "04:01 irony / ClariS(2010) / アニメ 俺の妹がこんなに可愛いわけがない/OP",
  })), null);
});


test("older reviewed source-specific activity rows stay quarantined after concurrent main cleanup", () => {
  const exact = [
    ["配信はじまり","待機画面","0:00 配信はじまり(待機画面)","deccea4d95fcaa96325871f5ed82c40abc6abb50b8be53dcc232d1a229f5291c"],
    ["自己紹介","コール＆レスポンス","4:51 自己紹介（コール＆レスポンス）","e9a92bc803fb76ead17d288c98d72548f8dab5988948579aaaf9f2550346c630"],
    ["小休憩","あめタイム","3:18:43 小休憩(あめタイム)","5f0c0d169ed3de44f989ba355295f9648abf73f33ac9aaa232b69f661ebf05d9"],
    ["Talk Time","休憩タイム","【02:36:42】 Talk Time // 休憩タイム","1d7cd95ec5c5614d37369fc63a26ca622d9eb0733495f9ca301abd90a5dfa5b9"],
    ["(waiting)","","00:00 (waiting)","28ae2a831a0734f65d0780d861156e21ce1d248beeeef0f71e0c2cdae72cc3ad"],
  ];
  for (const [title,artist,raw,sourceHash] of exact) {
    assert.equal(unambiguousNonSongReason(song(title,artist,{raw,sourceHash})), "reviewed_source_activity_chapter");
  }

  assert.equal(unambiguousNonSongReason(song("スタート","待機画面",{raw:"0:00 スタート（待機画面）"})), "confirmed_stream_start_marker");
  assert.equal(unambiguousNonSongReason(song("自己紹介","コール＆レスポンス",{raw:"4:51 自己紹介（コール＆レスポンス）"})), "confirmed_self_intro_segment");
  assert.equal(unambiguousNonSongReason(song("小休憩","あめタイム",{raw:"3:18:43 小休憩(あめタイム)"})), "confirmed_break_segment");
  assert.equal(unambiguousNonSongReason(song("OP Start","",{raw:"2:03 OP Start"})), "confirmed_stream_start_marker");
  assert.equal(unambiguousNonSongReason(song("Opening 3","",{raw:"8:47 Opening 3"})), null);
});

test("reviewed source repairs recover literal credits without inventing missing artists", () => {
  let fixed = repairKnownSourceCredit(song("戒厳のシグナル/神咒Kajiri （1st originalSong）https","www.youtube.com/watch?v=8WoHr8lxxXY",{
    raw:"28:27 戒厳のシグナル/神咒Kajiri （1st originalSong）https://www.youtube.com/watch?v=8WoHr8lxxXY",
    sourceHash:"3ddc8b1b3a39f0f7754cefd5d692c8c83c24902d902a802421e61d19c9b97c00",
  }));
  assert.equal(fixed.title,"戒厳のシグナル");
  assert.equal(fixed.artist,"神咒Kajiri");

  fixed = repairKnownSourceCredit(song("糸","中島みゆき / https://youtu.be/O6e_00LPex8",{
    raw:"1:38:14 糸 / 中島みゆき / https://youtu.be/O6e_00LPex8",
    sourceHash:"54d387bc5821e57e0a9567d2003c8b96568b1dc746b5481b1e0f0da1ec492a47",
  }));
  assert.equal(fixed.artist,"中島みゆき");

  fixed = repairKnownSourceCredit(song("彗星","チャレンジ失敗",{
    raw:"1:48:37 彗星/monaca:factory（チャレンジ失敗）",
    sourceHash:"6a82a15578d2ce6cf9144390e8f59a24bfe230a73aa3844962dfce436463cd20",
  }));
  assert.equal(fixed.artist,"monaca:factory");

  fixed = repairKnownSourceCredit(song("休憩〜水平線歌唱〜","未記載",{
    raw:"1:00:50 休憩〜水平線歌唱〜",
    sourceHash:"ec3536420568a915fff8687d10e3c9b6cff17246c49944bac64c9d38fb0bc616",
  }));
  assert.equal(fixed.title,"水平線");
  assert.equal(fixed.artist,"");

  // Source gives only work metadata, not the performer: keep it unknown.
  fixed = repairKnownSourceCredit(song("鳥の詩","",{
    raw:"40:14 鳥の詩/key作品/AIR",
    sourceHash:"03d057937b4a250e8401f44c925adbc863ce3eb0209a6a7b55377633c8efdda6",
  }));
  assert.equal(fixed.artist,"");
  fixed = repairKnownSourceCredit(song("檄!帝国華撃団","",{
    raw:"40:20 檄!帝国華撃団 / ゲーム サクラ大戦(1996) / アニメ(2000)",
    sourceHash:"28ae2a831a0734f65d0780d861156e21ce1d248beeeef0f71e0c2cdae72cc3ad",
  }));
  assert.equal(fixed.artist,"");
});

test("full-width note separator source repairs every malformed song/artist row, not only one example", () => {
  const hash="3b657c0a4983dbf17cd8f4e31c5ef607f7ca00791d0e2bca8e9e113289527222";
  const cases=[
    ["剣の舞(88')/光GENJI","5期生に歌ってほしい曲","04:40 剣の舞(88')/光GENJI／5期生に歌ってほしい曲","剣の舞(88')","光GENJI"],
    ["III(24')/宝鐘マリン&Kobo Kanaeru","ちゃむ。先輩と歌いたい曲","14:00 III(24')/宝鐘マリン&Kobo Kanaeru／ちゃむ。先輩と歌いたい曲","III(24')","宝鐘マリン&Kobo Kanaeru"],
    ["勝手にシンドバッド(78')/サザンオールスターズ","バトラ先輩に歌ってほしい曲","35:29 勝手にシンドバッド(78')/サザンオールスターズ／バトラ先輩に歌ってほしい曲","勝手にシンドバッド(78')","サザンオールスターズ"],
  ];
  for(const [title,artist,raw,expectedTitle,expectedArtist] of cases){
    const fixed=repairKnownSourceCredit(song(title,artist,{raw,sourceHash:hash}));
    assert.equal(fixed.title,expectedTitle);
    assert.equal(fixed.artist,expectedArtist);
  }
});

test("performance annotations are stripped only when the raw row proves the suffix", () => {
  const cases=[
    ["楓","スピッツ(ギター","00:56:03 08. 楓／スピッツ(ギター弾き語り)","スピッツ"],
    ["U","millennium parade × Belle [歌詞動画","9:25 01. U / millennium parade × Belle [歌詞動画]","millennium parade × Belle"],
    ["CLEAR","坂本真綾 [ワンコーラスVer.","8:29 01. CLEAR / 坂本真綾 [ワンコーラスVer.]","坂本真綾"],
    ["ライラック","Mrs. GREEN APPLE］(挑戦枠)","2:28:54 21.［ライラック／Mrs. GREEN APPLE］(挑戦枠)","Mrs. GREEN APPLE"],
  ];
  for(const [title,artist,raw,expected] of cases){
    assert.equal(normalizeReleaseMetadataArtist(song(title,artist,{raw})).artist,expected);
  }
  assert.equal(normalizeReleaseMetadataArtist(song("Bracket Song","Artist [Unit",{raw:"1:00 Bracket Song / Artist [Unit"})).artist,"Artist [Unit");
});


test("reviewed September 26 slash-setlist source restores song and artist fields", () => {
  const hash = "ee7156adb2bed545e5380648e55b4c036ec2f4addc690476ab56fa9c0e8caffc";
  const rows = [
    [song("Raise your flag／MAN WITH A MISSION", "", {
      raw: "15:32\tRaise your flag／MAN WITH A MISSION／機動戦士ガンダム 鉄血のオルフェンズ OP", sourceHash: hash,
    }), "Raise your flag", "MAN WITH A MISSION"],
    [song("ファンサ／mona(CV:夏川椎菜)【HoneyWorks】", "告白実行委員会～アイドルシリーズ～", {
      raw: "17:30 1:56:53\tファンサ／mona(CV:夏川椎菜)【HoneyWorks】／告白実行委員会～アイドルシリーズ～", sourceHash: hash,
    }), "ファンサ", "mona(CV:夏川椎菜)【HoneyWorks】"],
    [song("Starry heavens／Day after tomorrow", "", {
      raw: "1:23:10\tStarry heavens／Day after tomorrow／GC版テイルズ オブ シンフォニア 主題歌", sourceHash: hash,
    }), "Starry heavens", "day after tomorrow"],
    [song("モエチャッカファイア／弌誠／ゼンレスゾーンゼロ", "エレン・ジョー イメージソング", {
      raw: "1:31:25\tモエチャッカファイア／弌誠／ゼンレスゾーンゼロ／エレン・ジョー イメージソング", sourceHash: hash,
    }), "モエチャッカファイア", "弌誠"],
  ];
  for (const [row, expectedTitle, expectedArtist] of rows) {
    const repaired = repairKnownSourceCredit(row);
    assert.equal(repaired.title, expectedTitle);
    assert.equal(repaired.artist, expectedArtist);
  }
  for (const title of ["～)　※蒼木さんの出番は", "まで！)"]) {
    assert.equal(unambiguousNonSongReason(song(title, "", { raw: title, sourceHash: hash })), "reviewed_source_activity_chapter");
  }
});


test("year-only artist metadata is removed without touching real numeric song titles", () => {
  const cases = [
    [song("君の知らない物語", "supercell (2009)", {
      raw: "02:27:06 君の知らない物語 / supercell (2009) / TVアニメ「化物語」ED",
    }), "君の知らない物語", "supercell"],
    [song("1/2", "川本真琴 (1997)", {
      raw: "00:23:33 1/2 / 川本真琴 (1997) / TVアニメ「るろうに剣心」2代目OP",
    }), "1/2", "川本真琴"],
    [song("drop", "keeno（2013）", {
      raw: "⑫【2:14:38】 drop / keeno（2013）",
    }), "drop", "keeno"],
  ];
  for (const [row, title, artist] of cases) {
    const repaired = normalizeReleaseMetadataArtist(row);
    assert.equal(repaired.title, title);
    assert.equal(repaired.artist, artist);
  }

  const unrelated = song("1984", "The Artist (1984)", {
    raw: "00:10 The Artist (1984) performed live",
  });
  assert.equal(normalizeReleaseMetadataArtist(unrelated).artist, "The Artist (1984)");
});

test("reviewed fullwidth-slash sources restore title and performer instead of company metadata", () => {
  const cases = [
    [song("as×sist ～甘えベタな私なりに～／川田まみ／「甘えかたは彼女なりに。」OP", "戯画 (2016)", {
      raw: "0:15:53 as×sist ～甘えベタな私なりに～／川田まみ／「甘えかたは彼女なりに。」OP／戯画 (2016)",
      sourceHash: "d723897d567d473dd7aea57f04f8ad70a15479135d554e912b12368fcf1b117a",
    }), "as×sist ～甘えベタな私なりに～", "川田まみ"],
    [song("Call／霜月はるか／「できない私が、くり返す。」OP", "あかべぇそふとすりぃ (2014)", {
      raw: "1:49:23 Re:Call／霜月はるか／「できない私が、くり返す。」OP／あかべぇそふとすりぃ (2014)",
      sourceHash: "80923c4f194b93e4f4653fc4a21257b485eff0cf0a4588d5a21b5d7915f09201",
    }), "Re:Call", "霜月はるか"],
    [song("紬の夏休み／紬 ヴェンダース(CV:岩井映美里)／「Summer Pockets」挿入歌", "Key (2018)", {
      raw: "0:34:34 紬の夏休み／紬 ヴェンダース(CV:岩井映美里)／「Summer Pockets」挿入歌／Key (2018)",
      sourceHash: "5a7f0a1a023119e5571d5f1eb10894e67fdf361b4309005b76dabe7c77664819",
    }), "紬の夏休み", "紬 ヴェンダース(CV:岩井映美里)"],
  ];
  for (const [row, title, artist] of cases) {
    const repaired = repairKnownSourceCredit(row);
    assert.equal(repaired.title, title);
    assert.equal(repaired.artist, artist);
  }
});

test("reviewed performance notes are removed from artist credits but ordinary brackets survive", () => {
  const statusRows = [
    [song("メーベル", "バルーン [歌声迷子]", {
      raw: "25:08 03. メーベル / バルーン [歌声迷子]",
    }), "バルーン"],
    [song("StaRt", "Mrs. GREEN APPLE［キーマイナス6 / テンポマイナス4］", {
      raw: "03:18:33 StaRt / Mrs. GREEN APPLE［キーマイナス6 / テンポマイナス4］",
    }), "Mrs. GREEN APPLE"],
  ];
  for (const [row, artist] of statusRows) assert.equal(normalizeReleaseMetadataArtist(row).artist, artist);

  const officialLike = song("Example", "Band [Unit A]", { raw: "00:10 Example / Band [Unit A]" });
  assert.equal(normalizeReleaseMetadataArtist(officialLike).artist, "Band [Unit A]");
});

test("remaining source-proven malformed credits are repaired without broad title heuristics", () => {
  const cases = [
    [song("LOSER", "米津玄師 [LOSER / Yonezu Kenshi", {
      raw: "0:27:32 LOSER / 米津玄師 [LOSER / Yonezu Kenshi] (挑戦枠)",
      sourceHash: "d6870653d1a294ccccf28184ac05c57268eb6c0a6934e9d4cd1d1a870ab3fdaf",
    }), "米津玄師"],
    [song("鳥の詩", "未記載", {
      raw: "40:14 鳥の詩/key作品/AIR",
      sourceHash: "03d057937b4a250e8401f44c925adbc863ce3eb0209a6a7b55377633c8efdda6",
    }), "Lia"],
    [song("檄!帝国華撃団", "", {
      raw: "40:20 檄!帝国華撃団 / ゲーム サクラ大戦(1996) / アニメ(2000)",
      sourceHash: "28ae2a831a0734f65d0780d861156e21ce1d248beeeef0f71e0c2cdae72cc3ad",
    }), "横山智佐（真宮寺さくら）＆帝国歌劇団"],
  ];
  for (const [row, artist] of cases) assert.equal(repairKnownSourceCredit(row).artist, artist);

  assert.equal(repairKnownSourceCredit(song("鳥の詩", "別の歌手", {
    raw: "40:14 鳥の詩 - 別の歌手",
    sourceHash: "different-source",
  })).artist, "別の歌手");
});
