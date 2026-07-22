const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildArtistRecords,
  buildArtistSongGroups,
  buildCompetitionRanks,
  buildSongRecords,
  extractSongVariant,
  isUnknownArtistName,
  normalizeSongWorkTitle,
  normalizeSongTitleKey,
  songWorkTitleKey,
} = require("../assets/ranking-utils");

test("merges same title with the same known artist", () => {
  const records = buildSongRecords([occurrence("花に亡霊", "ヨルシカ", "A"), occurrence("花に亡霊", "ヨルシカ", "B")]);

  assert.equal(records.length, 1);
  assert.equal(records[0].count, 2);
  assert.deepEqual(records[0].occurrences.map(({ item }) => item.videoId), ["A", "B"]);
});

test("keeps same title separated when known artists differ", () => {
  const records = buildSongRecords([occurrence("Start", "Artist A", "A"), occurrence("Start", "Artist B", "B")]);

  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => Array.from(record.artists.values())[0].name).sort(),
    ["Artist A", "Artist B"],
  );
});

test("merges safe artist spelling and annotation variants for the same title", () => {
  const records = buildSongRecords([
    occurrence("HOT LIMIT", "T.M.Revolution", "A"),
    occurrence("Hot Limit", "T.M. Revolution", "B"),
    occurrence("HOT LIMIT", "T.M.Revolution (1998)", "C"),
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].title, "HOT LIMIT");
  assert.equal(records[0].count, 3);
});

test("merges same-title kana and romaji artist identities conservatively", () => {
  const records = buildSongRecords([
    occurrence("花に亡霊", "ヨルシカ", "A"),
    occurrence("花に亡霊", "Yorushika", "B"),
    occurrence("Stellar Stellar", "星街すいせい", "C"),
    occurrence("Stellar Stellar", "Hoshimachi Suisei", "D"),
    occurrence("少女レイ", "みきとP", "E"),
    occurrence("少女レイ", "MikitoP", "F"),
    occurrence("不可解", "花譜 KAF", "G"),
    occurrence("不可解", "花譜", "H"),
  ]);

  assert.equal(records.length, 4);
  for (const record of records) assert.equal(record.count, 2);
});

test("merges same-title partial artist identities only with safe evidence", () => {
  const records = buildSongRecords([
    occurrence("Stellar Stellar", "Hoshimachi Suisei", "A"),
    occurrence("Stellar Stellar", "Suisei", "B"),
    occurrence("ビビデバ", "星街すいせい", "C"),
    occurrence("ビビデバ", "すいせい", "D"),
    occurrence("Song A", "Ado", "E"),
    occurrence("Song A", "Kado", "F"),
    occurrence("Song B", "YOASOBI", "G"),
    occurrence("Song B", "Ayase / YOASOBI", "H"),
  ]);

  const stellar = records.find((record) => record.title === "Stellar Stellar");
  const bibideba = records.find((record) => record.title === "ビビデバ");
  assert.equal(stellar.count, 2);
  assert.equal(bibideba.count, 2);
  assert.equal(records.filter((record) => record.title === "Song A").length, 2);
  assert.equal(records.filter((record) => record.title === "Song B").length, 2);
});

test("merges curated same-title artist aliases with canonical display names", () => {
  const records = buildSongRecords([
    occurrence("Calc Alias Song", "Calc", "A"),
    occurrence("Calc Alias Song", "Calc.", "B"),
    occurrence("No Logic", "ジミーサムP", "C"),
    occurrence("No Logic", "OneRoom", "D"),
    occurrence("Different OneRoom Song", "OneRoom", "E"),
  ]);

  const calc = records.find((record) => record.title === "Calc Alias Song");
  const noLogic = records.find((record) => record.title === "No Logic");
  assert.equal(calc.count, 2);
  assert.equal(calc.displayArtist, "Calc.");
  assert.equal(calc.artistIdentityKey, "calc");
  assert.equal(noLogic.count, 2);
  assert.equal(noLogic.displayArtist, "ジミーサムP");
  assert.equal(records.find((record) => record.title === "Different OneRoom Song").displayArtist, "ジミーサムP");
});

test("artist ranking merges curated aliases only with shared-song evidence", () => {
  const { records } = buildArtistRecords([
    occurrence("No Logic", "ジミーサムP", "A"),
    occurrence("No Logic", "OneRoom", "B"),
    occurrence("Separate Song", "OneRoom", "C"),
    occurrence("Other Song", "Different Alias", "D"),
  ]);

  const jimmy = records.find((record) => record.name === "ジミーサムP");
  assert.equal(jimmy.count, 3);
  assert.deepEqual(new Set(jimmy.aliases.map((alias) => alias.name)), new Set(["ジミーサムP", "OneRoom"]));
  assert.equal(records.some((record) => record.name === "Different Alias"), true);
});

test("does not merge kana romaji identities across different titles or identity annotations", () => {
  const records = buildSongRecords([
    occurrence("Song A", "ヨルシカ", "A"),
    occurrence("Song B", "Yorushika", "B"),
    occurrence("からくりピエロ", "みきとP", "C"),
    occurrence("からくりピエロ", "MikitoP feat. 初音ミク", "D"),
  ]);

  assert.equal(records.length, 4);
});

test("merges same work title version variants and keeps variant labels", () => {
  const records = buildSongRecords([
    occurrence("前前前世", "RADWIMPS", "A"),
    occurrence("前前前世 -Piano Ver", "RADWIMPS", "B", { isNiche: true }),
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].title, "前前前世");
  assert.equal(records[0].count, 2);
  assert.deepEqual(records[0].variantLabels, ["Piano Ver"]);
  assert.deepEqual(
    records[0].occurrences.map(({ item }) => item.videoId),
    ["A", "B"],
  );
});

test("keeps unknown title suffixes and remix variants separated", () => {
  const records = buildSongRecords([
    occurrence("Song -Piano Ver", "Artist", "A"),
    occurrence("Song Remix", "Artist", "B"),
    occurrence("Song -Night Drive", "Artist", "C"),
  ]);

  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((record) => record.title).sort(),
    ["Song", "Song -Night Drive", "Song Remix"].sort(),
  );
});

test("merges dominant same-work artist typos without showing duplicate artist counts", () => {
  const occurrences = Array.from({ length: 14 }, (_, index) => occurrence("前前前世", "RADWIMPS", `A${index}`));
  occurrences.push(occurrence("前前前世", "RADWINPS", "B"));
  const records = buildSongRecords(occurrences);

  assert.equal(records.length, 1);
  assert.equal(records[0].count, 15);
  assert.equal(records[0].displayArtist, "RADWIMPS");
  assert.equal(records[0].artistIdentityKey, "radwimps");
});

test("front front front fixture conserves occurrences under work identity", () => {
  const occurrences = [
    ...Array.from({ length: 14 }, (_, index) => occurrence("前前前世", "RADWIMPS", `base${index}`)),
    occurrence("前前前世", "RADWINPS", "typo"),
    occurrence("前前前世", "RADWIMPS (14)", "counted-artist"),
    occurrence("前前前世 -Piano Ver", "RADWIMPS", "piano", { isNiche: true }),
  ];
  const records = buildSongRecords(occurrences);

  assert.equal(records.length, 1);
  assert.equal(records[0].title, "前前前世");
  assert.equal(records[0].displayArtist, "RADWIMPS");
  assert.equal(records[0].count, 17);
  assert.equal(records[0].occurrences.length, 17);
  assert.deepEqual(records[0].variantLabels, ["Piano Ver"]);
});

test("song work title key only strips whitelisted variants and list markers", () => {
  assert.equal(songWorkTitleKey("前前前世 -Piano Ver"), songWorkTitleKey("前前前世"));
  assert.equal(songWorkTitleKey("前前前世 33曲目"), songWorkTitleKey("前前前世"));
  assert.equal(songWorkTitleKey("33「Calc.」"), songWorkTitleKey("Calc."));
  assert.equal(songWorkTitleKey("55【Calc.】"), songWorkTitleKey("Calc."));
  assert.equal(songWorkTitleKey("Calc"), songWorkTitleKey("Calc."));
  assert.equal(songWorkTitleKey("Calc. (Calc.)"), songWorkTitleKey("Calc."));
  assert.equal(songWorkTitleKey("Calc. (Eng Ver.)"), songWorkTitleKey("Calc."));
  assert.equal(songWorkTitleKey("Calc. English version"), songWorkTitleKey("Calc."));
  assert.equal(songWorkTitleKey("Calc. 英文版"), songWorkTitleKey("Calc."));
  assert.equal(songWorkTitleKey("Calc. アカペラ版"), songWorkTitleKey("Calc."));
  assert.equal(songWorkTitleKey("Calc. 阿卡贝拉版"), songWorkTitleKey("Calc."));
  assert.equal(songWorkTitleKey("Calc.-Riano Ver-"), songWorkTitleKey("Calc."));
  assert.notEqual(songWorkTitleKey("前前前世 Remix"), songWorkTitleKey("前前前世"));
  assert.notEqual(songWorkTitleKey("前前前世 -Night Drive"), songWorkTitleKey("前前前世"));
  assert.equal(normalizeSongWorkTitle("Song (Acoustic Ver)").variantLabel, "Acoustic Ver");
  assert.equal(extractSongVariant("Song - Remix").variantLabel, "");
});

test("merges Calc title punctuation, list markers, and safe version labels", () => {
  const records = buildSongRecords([
    occurrence("Calc", "ジミーサムP", "A"),
    occurrence("Calc.", "ジミーサムP", "B"),
    occurrence("33「Calc.」", "", "C"),
    occurrence("55【Calc.】", "", "D"),
    occurrence("Calc. (Eng Ver.)", "ジミーサムP", "E"),
    occurrence("Calc. (Calc.)", "ジミーサムP", "F"),
    occurrence("Calc.-Riano Ver-", "ジミーサムP", "G"),
    occurrence("Calc. 英文版", "ジミーサムP", "H"),
    occurrence("Calc. アカペラ版", "ジミーサムP", "I"),
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].title, "Calc.");
  assert.equal(records[0].displayArtist, "ジミーサムP");
  assert.equal(records[0].count, 9);
  assert.deepEqual(new Set(records[0].occurrences.map(({ item }) => item.videoId)), new Set(["A", "B", "C", "D", "E", "F", "G", "H", "I"]));
});

test("merges month spelling, list markers, safe variants, and decorated artist aliases", () => {
  const records = buildSongRecords([
    occurrence("とても素敵な六月でした", "Eight", "A"),
    occurrence("とても素敵な6月でした", "Eight(Eight)", "B"),
    occurrence("12曲目 とても素敵な六月でした Piano Ver", "Eight 様┊", "C"),
    occurrence("とても素敵な6月でした アカペラ", "Eight(Totemo Suteki na Rokugatsu deshita)", "D"),
  ]);

  assert.equal(normalizeSongTitleKey("とても素敵な六月でした"), normalizeSongTitleKey("とても素敵な6月でした"));
  assert.equal(songWorkTitleKey("12曲目 とても素敵な六月でした Piano Ver"), songWorkTitleKey("とても素敵な6月でした"));
  assert.equal(records.length, 1);
  assert.equal(records[0].count, 4);
  assert.equal(records[0].displayArtist, "Eight");
  assert.deepEqual(
    records[0].occurrences.map(({ item }) => item.videoId),
    ["A", "B", "C", "D"],
  );
  assert.deepEqual(new Set(records[0].variantLabels), new Set(["Piano Ver", "アカペラ"]));
});

test("merges no-space feat annotations into an existing base artist", () => {
  const records = buildSongRecords([
    occurrence("からくりピエロ", "40mP", "A"),
    occurrence("からくりピエロ", "40mP feat.初音ミク", "B"),
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].count, 2);
});

test("does not strip explicit CV identity from known artists", () => {
  const records = buildSongRecords([
    occurrence("恋愛サーキュレーション", "千石撫子", "A"),
    occurrence("恋愛サーキュレーション", "千石撫子(CV.花澤香菜)", "B"),
  ]);

  assert.equal(records.length, 2);
});

test("merges unknown artist rows into the only known artist group", () => {
  const records = buildSongRecords([occurrence("夜明けと蛍", "n-buna", "A"), occurrence("夜明けと蛍", "", "B")]);

  assert.equal(records.length, 1);
  assert.equal(records[0].count, 2);
  assert.deepEqual(
    Array.from(records[0].artists.values()).map((entry) => entry.name),
    ["n-buna"],
  );
});

test("merges unknown artist rows into the dominant known artist group", () => {
  const records = buildSongRecords([
    occurrence("you", "倖田來未", "A"),
    occurrence("you", "倖田來未", "B"),
    occurrence("you", "癒月", "C"),
    occurrence("you", "", "D"),
  ]);

  assert.equal(records.length, 2);
  const dominant = records.find((record) => Array.from(record.artists.values()).some((artist) => artist.name === "倖田來未"));
  assert.equal(dominant.count, 3);
  assert.deepEqual(
    dominant.occurrences.map(({ item }) => item.videoId),
    ["A", "B", "D"],
  );
});

test("normalizes song title punctuation and list markers before grouping", () => {
  const records = buildSongRecords([
    occurrence("少女レイ", "みきとP", "A"),
    occurrence("『 少女レイ 』", "", "B"),
    occurrence("⑪少女レイ", "", "C"),
    occurrence("14| 少女レイ", "", "D"),
    occurrence("⁆🦊03.少女レイ", "", "E"),
    occurrence("＊ 04. 少女レイ", "", "F"),
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].title, "少女レイ");
  assert.equal(records[0].count, 6);
});

test("numeric dot title keys stay distinct from stripped list indexes", () => {
  assert.equal(normalizeSongTitleKey("01. Song"), "song");
  assert.equal(normalizeSongTitleKey("01) Song"), "song");
  assert.equal(normalizeSongTitleKey("⁆🦊03.星間飛行"), normalizeSongTitleKey("星間飛行"));
  assert.equal(normalizeSongTitleKey("＊ 04. KICK BACK"), normalizeSongTitleKey("KICK BACK"));
  assert.equal(normalizeSongTitleKey("No01. Honey♥Come!!"), normalizeSongTitleKey("Honey♥Come!!"));
  assert.equal(normalizeSongTitleKey("27;0:11:02 エマ"), normalizeSongTitleKey("エマ"));
  assert.notEqual(normalizeSongTitleKey("8.32"), normalizeSongTitleKey("32"));
  assert.notEqual(normalizeSongTitleKey("2.500♪"), normalizeSongTitleKey("500♪"));
  assert.notEqual(normalizeSongTitleKey("No Logic"), normalizeSongTitleKey("Logic"));
  assert.notEqual(normalizeSongTitleKey("NO, Thank You!"), normalizeSongTitleKey("Thank You!"));
  assert.notEqual(normalizeSongTitleKey("No.1"), normalizeSongTitleKey("1"));
  assert.notEqual(normalizeSongTitleKey("Re;fract"), normalizeSongTitleKey("fract"));

  const records = buildSongRecords([occurrence("8.32", "*Luna", "A"), occurrence("32", "*Luna", "B")]);
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => record.title).sort(),
    ["32", "8.32"],
  );
});

test("uses a clean title variant even when a dirty title appears first", () => {
  const records = buildSongRecords([
    occurrence("⑭HOT LIMIT", "T.M.Revolution", "A"),
    occurrence("HOT LIMIT", "T.M.Revolution", "B"),
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].title, "HOT LIMIT");
  assert.equal(records[0].count, 2);
});

test("merges missing-artist rows when the artist leaked into the title", () => {
  const records = buildSongRecords([
    occurrence("夏祭り", "Whiteberry", "A"),
    occurrence("夏祭り\tWhiteberry", "", "B"),
    occurrence("「夏祭り」Whiteberry", "", "C"),
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].title, "夏祭り");
  assert.equal(records[0].count, 3);
});

test("keeps voiced and unvoiced kana titles separated", () => {
  const records = buildSongRecords([occurrence("ギラギラ", "Ado", "A"), occurrence("キラキラ", "aiko", "B")]);

  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => record.title).sort(),
    ["キラキラ", "ギラギラ"].sort(),
  );
});

test("builds competition ranking after same-title aggregation", () => {
  const records = buildSongRecords([
    occurrence("Song A", "Artist", "A"),
    occurrence("Song A", "Artist", "B"),
    occurrence("Song B", "Artist", "C"),
    occurrence("Song C", "Artist", "D"),
  ]).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
  const ranks = buildCompetitionRanks(records);

  assert.equal(ranks.get(records[0].key), 1);
  assert.equal(ranks.get(records[1].key), 2);
  assert.equal(ranks.get(records[2].key), 2);
});

test("artist ranking excludes unknown artist placeholders", () => {
  const { records, missingArtistCount } = buildArtistRecords([
    occurrence("Song A", "未記載", "A"),
    occurrence("Song B", "待补歌手", "B"),
    occurrence("Song C", "待補歌手", "C"),
    occurrence("Song D", "Known Artist", "D"),
  ]);

  assert.deepEqual(records.map((record) => record.name), ["Known Artist"]);
  assert.equal(records[0].count, 1);
  assert.equal(missingArtistCount, 3);
});

test("unknown artist helper covers user-facing placeholder variants", () => {
  for (const value of ["", "未記載", "未记载", "不明", "なし", "无", "待补", "待補", "unknown", "n/a", "na", "none", "null", "-"]) {
    assert.equal(isUnknownArtistName(value), true, value);
  }
  assert.equal(isUnknownArtistName("Known Artist"), false);
});

test("artist ranking merges conservative non-identity artist annotations", () => {
  const { records } = buildArtistRecords([
    occurrence("Song A", "Ａｄｏ（2020）", "A"),
    occurrence("Song B", "Ado", "B"),
    occurrence("Song C", "Ado", "C"),
    occurrence("Song D", "Ado / 動画 OP", "D"),
    occurrence("Song E", "Ado【原曲】", "E"),
    occurrence("Song F", "Ado TV size", "F"),
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].key, "ado");
  assert.equal(records[0].name, "Ado");
  assert.equal(records[0].count, 6);
  assert.ok(Array.isArray(records[0].aliases));
  assert.equal(records[0].aliases[0].name, "Ado");
  assert.equal(records[0].aliases[0].count, 2);
  assert.deepEqual(
    new Set(records[0].aliases.map((alias) => alias.name)),
    new Set(["Ａｄｏ（2020）", "Ado", "Ado / 動画 OP", "Ado【原曲】", "Ado TV size"]),
  );
});

test("artist canonicalization keeps official names for common variants", () => {
  const { records } = buildArtistRecords([
    occurrence("唱", "Ado :_heart:", "ado-a"),
    occurrence("新時代", "ado", "ado-b"),
    occurrence("ゴーストルール", "deco27", "deco-a"),
    occurrence("妄想税", "DECO*27", "deco-b"),
    occurrence("晴る", "yorushika", "yoru-a"),
    occurrence("花に亡霊", "ヨルシカ（yorushika）", "yoru-b"),
  ]);

  assert.deepEqual(
    records.map((record) => [record.name, record.count]).sort((a, b) => a[0].localeCompare(b[0], "ja")),
    [
      ["Ado", 2],
      ["DECO*27", 2],
      ["ヨルシカ", 2],
    ].sort((a, b) => a[0].localeCompare(b[0], "ja")),
  );
});

test("song ranking backfills placeholders and strips duplicated artist descriptors", () => {
  const records = buildSongRecords([
    occurrence("花になって", "未記載", "flower-a"),
    occurrence("花になって", "緑黄色社会", "flower-b"),
    occurrence("花になって", "緑黄色社会、緑黄色社会|Be a flower / Ryokuu Shakai", "flower-c"),
    occurrence("花になって - Be a flower", "未記載", "flower-d"),
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].title, "花になって");
  assert.equal(records[0].displayArtist, "緑黄色社会");
  assert.equal(records[0].count, 4);
  assert.equal(records[0].occurrences.every((item) => !isUnknownArtistName(item.song.artist)), true);
});

test("artist ranking does not merge explicit CV identity into the base artist", () => {
  const { records } = buildArtistRecords([
    occurrence("恋愛サーキュレーション", "千石撫子", "A"),
    occurrence("恋愛サーキュレーション", "千石撫子(CV.花澤香菜)", "B"),
  ]);

  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => record.name).sort(),
    ["千石撫子", "千石撫子(CV.花澤香菜)"].sort(),
  );
});

test("artist ranking does not merge feat identity into the base artist", () => {
  const { records } = buildArtistRecords([
    occurrence("からくりピエロ", "40mP", "A"),
    occurrence("からくりピエロ", "40mP feat.初音ミク", "B"),
  ]);

  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => record.name).sort(),
    ["40mP", "40mP feat.初音ミク"].sort(),
  );
});

test("artist ranking merges partial names only when songs overlap", () => {
  const { records } = buildArtistRecords([
    occurrence("Stellar Stellar", "Hoshimachi Suisei", "A"),
    occurrence("Stellar Stellar", "Suisei", "B"),
    occurrence("ビビデバ", "星街すいせい", "C"),
    occurrence("ビビデバ", "すいせい", "D"),
    occurrence("Song A", "Ado", "E"),
    occurrence("Song A", "Kado", "F"),
    occurrence("Song C", "Nanashi Mumei", "G"),
    occurrence("Song D", "Mumei", "H"),
  ]);

  const latinPartial = records.find((record) => record.aliases.some((alias) => alias.name === "Hoshimachi Suisei"));
  const cjkPartial = records.find((record) => record.aliases.some((alias) => alias.name === "星街すいせい"));
  assert.equal(latinPartial.count, 2);
  assert.equal(cjkPartial.count, 2);
  assert.equal(records.some((record) => record.name === "Ado"), true);
  assert.equal(records.some((record) => record.name === "Kado"), true);
  assert.equal(records.some((record) => record.name === "Nanashi Mumei"), true);
  assert.equal(records.some((record) => record.name === "Mumei"), true);
});

test("buildArtistSongGroups groups occurrences by song", () => {
  const groups = buildArtistSongGroups([
    occurrence("Song A", "Artist", "A"),
    occurrence("Song A", "Artist", "B"),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "Song A");
  assert.deepEqual(
    groups[0].occurrences.map(({ item }) => item.videoId),
    ["A", "B"],
  );
});

test("buildArtistSongGroups counts multiple sources for the same song", () => {
  const groups = buildArtistSongGroups([
    occurrence("Song A", "Artist", "A"),
    occurrence("Song A", "Artist", "B"),
    occurrence("Song A", "Artist", "C"),
  ]);

  assert.equal(groups[0].count, 3);
});

test("buildArtistSongGroups keeps different songs separated", () => {
  const groups = buildArtistSongGroups([
    occurrence("Song A", "Artist", "A"),
    occurrence("Song B", "Artist", "B"),
  ]);

  assert.deepEqual(
    groups.map((group) => group.title).sort(),
    ["Song A", "Song B"],
  );
});

test("buildArtistSongGroups sorts song groups by count descending", () => {
  const groups = buildArtistSongGroups([
    occurrence("Song A", "Artist", "A"),
    occurrence("Song B", "Artist", "B"),
    occurrence("Song B", "Artist", "C"),
  ]);

  assert.deepEqual(
    groups.map((group) => group.title),
    ["Song B", "Song A"],
  );
});

test("buildArtistSongGroups sorts tied counts by song sort key", () => {
  const groups = buildArtistSongGroups([
    occurrence("Beta", "Artist", "A"),
    occurrence("Alpha", "Artist", "B"),
  ]);

  assert.deepEqual(
    groups.map((group) => group.title),
    ["Alpha", "Beta"],
  );
});

test("buildArtistSongGroups preserves niche state on song groups", () => {
  const groups = buildArtistSongGroups([
    occurrence("Known", "Artist", "A"),
    occurrence("Rare", "Artist", "B", { isNiche: true }),
  ]);

  assert.equal(groups.find((group) => group.title === "Rare").isNiche, true);
  assert.equal(groups.find((group) => group.title === "Known").isNiche, false);
});

test("buildArtistSongGroups recalculates niche after merged variants", () => {
  const groups = buildArtistSongGroups([
    occurrence("前前前世", "RADWIMPS", "A"),
    occurrence("前前前世 -Piano Ver", "RADWIMPS", "B", { isNiche: true }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "前前前世");
  assert.equal(groups[0].isNiche, false);
});

test("buildArtistSongGroups exposes canonical song identity for vtuber expansion backfill", () => {
  const groups = buildArtistSongGroups([
    occurrence("Calc", "ジミーサムP", "A"),
    occurrence("Calc.", "OneRoom", "B"),
    occurrence("Calc. (Eng Ver.)", "ジミーサムP", "B"),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "Calc.");
  assert.equal(groups[0].count, 3);
  assert.equal(groups[0].videoCount, 2);
  assert.equal(groups[0].canonicalWorkTitleKey, songWorkTitleKey("Calc."));
  assert.equal(groups[0].artistIdentityKey, "ジミーサムp");
  assert.equal(groups[0].songIdentityKey, `${songWorkTitleKey("Calc.")}::ジミーサムp`);
  assert.deepEqual(new Set(groups[0].occurrences.map(({ item }) => item.videoId)), new Set(["A", "B"]));
});

test("buildArtistSongGroups keeps same normalized title separated for incompatible artists", () => {
  const groups = buildArtistSongGroups([
    occurrence("私になれ", "Artist A", "A"),
    occurrence("私になれ", "Artist B", "B"),
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.songIdentityKey).sort(),
    [`${songWorkTitleKey("私になれ")}::artista`, `${songWorkTitleKey("私になれ")}::artistb`],
  );
});

test("buildArtistSongGroups can merge same work title for vtuber expansion", () => {
  const groups = buildArtistSongGroups(
    [
      occurrence("私になれ", "未記載", "watashi-a"),
      occurrence("私になれ", "パン野実々美", "watashi-b"),
      occurrence("私になれ", "パン野実々美 [7th", "watashi-c"),
      occurrence("群像夏", "未記載", "gunzou-a"),
      occurrence("群像夏", "パン野実々美", "gunzou-b"),
      occurrence("群像夏", "パン野実々美 - eBASEBALLパワフルプロ野球2022主題歌", "gunzou-c"),
      occurrence("群像夏", "パン野実々美 [パワプロ2022主題歌", "gunzou-d"),
    ],
    { mergeSameWorkTitle: true },
  );

  assert.equal(groups.length, 2);
  const watashi = groups.find((group) => group.title === "私になれ");
  const gunzou = groups.find((group) => group.title === "群像夏");
  assert.equal(watashi.count, 3);
  assert.equal(watashi.key, songWorkTitleKey("私になれ"));
  assert.equal(watashi.displayArtist, "パン野実々美");
  assert.equal(watashi.videoCount, 3);
  assert.equal(gunzou.count, 4);
  assert.equal(gunzou.key, songWorkTitleKey("群像夏"));
  assert.equal(gunzou.displayArtist, "パン野実々美");
  assert.equal(gunzou.videoCount, 4);
});

function occurrence(title, artist, videoId, overrides = {}) {
  return {
    item: {
      videoId,
      title: `video ${videoId}`,
      channelName: `channel ${videoId}`,
    },
    song: {
      title,
      artist,
      seconds: 60,
      time: "0:01:00",
      ...overrides,
    },
  };
}
