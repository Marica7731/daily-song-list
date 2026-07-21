const assert = require("node:assert/strict");
const test = require("node:test");

const {
  bestCombinedTitleArtistCandidate,
  cleanSafeTitleCandidate,
  createKnownSongArtistOverrideContext,
  entryRepairSignals,
  parserCorruptionTitleCandidate,
  repairParsedEntry,
  titleArtistSplitCandidates,
  validateKnownSongArtistOverrides,
} = require("../scripts/entry-repair");
const { buildSongSearchIndex } = require("../scripts/song-search-index");

test("repairs delimiter splits using song-search title and title-artist matches", () => {
  const lookup = buildSongSearchIndex([
    { title: "初音ミクの暴走", artist: "cosMo（暴走P）" },
    { title: "Notebook", artist: "buzzG" },
  ]);

  const runaway = repairParsedEntry(
    {
      time: "0:00:01",
      seconds: 1,
      title: "初音ミクの暴走",
      artist: "暴走P",
      raw: "0:01 初音ミクの暴走／cosMo（暴走P）",
    },
    lookup,
  );
  const notebook = repairParsedEntry(
    {
      time: "0:00:02",
      seconds: 2,
      title: "Notebook",
      artist: "buzzG",
      raw: "0:02 Notebook／buzzG",
    },
    lookup,
  );

  assert.equal(runaway.title, "初音ミクの暴走");
  assert.equal(runaway.artist, "cosMo（暴走P）");
  assert.equal(runaway.raw, "0:01 初音ミクの暴走／cosMo（暴走P）");
  assert.equal(runaway.repair.knownTitleArtist, true);
  assert.equal(notebook.title, "Notebook");
  assert.equal(notebook.artist, "buzzG");
  assert.equal(notebook.repair.knownTitleArtist, true);
});

test("scores delimiters without treating year-month dates as separators", () => {
  const lion = repairParsedEntry({
    time: "0:00:03",
    seconds: 3,
    title: "ライオン/シェリル・ノーム(May'n), ランカ・リー(中島愛) 2008",
    artist: "08",
    raw: "0:03 ライオン/シェリル・ノーム(May'n), ランカ・リー(中島愛) 2008/08",
  });
  const constellation = repairParsedEntry({
    time: "0:00:04",
    seconds: 4,
    title: "星座になれたら/結束バンド 2022",
    artist: "12",
    raw: "0:04 星座になれたら/結束バンド 2022/12",
  });

  assert.deepEqual(
    titleArtistSplitCandidates("ライオン/シェリル・ノーム(May'n), ランカ・リー(中島愛) 2008/08").map((candidate) => [
      candidate.title,
      candidate.artist,
    ]),
    [["ライオン", "シェリル・ノーム(May'n), ランカ・リー(中島愛)"]],
  );
  assert.equal(lion.title, "ライオン");
  assert.equal(lion.artist, "シェリル・ノーム(May'n), ランカ・リー(中島愛)");
  assert.equal(constellation.title, "星座になれたら");
  assert.equal(constellation.artist, "結束バンド");
});

test("repairs obvious title artist credits for unknown artists even without lookup", () => {
  const runaway = repairParsedEntry({
    time: "0:00:01",
    seconds: 1,
    title: "初音ミクの暴走／cosMo（暴走P）",
    artist: "未記載",
    raw: "0:01 初音ミクの暴走／cosMo（暴走P）",
  });
  const notebook = repairParsedEntry({
    time: "0:00:02",
    seconds: 2,
    title: "Notebook／buzzG",
    artist: "未記載",
    raw: "0:02 Notebook／buzzG",
  });

  assert.equal(runaway.title, "初音ミクの暴走");
  assert.equal(runaway.artist, "cosMo（暴走P）");
  assert.equal(notebook.title, "Notebook");
  assert.equal(notebook.artist, "buzzG");
});

test("splits combined title artist text only on a unique title-artist lookup match", () => {
  const uniqueLookup = buildSongSearchIndex([{ title: "発光帯", artist: "ハナレグミ" }]);
  const ambiguousLookup = buildSongSearchIndex([
    { title: "発光帯", artist: "ハナレグミ" },
    { title: "発光帯 ハナレグミ", artist: "Other Artist" },
  ]);

  const fixed = repairParsedEntry({ title: "発光帯　ハナレグミ", artist: "未記載", raw: "0:05 発光帯　ハナレグミ" }, uniqueLookup);
  const ambiguous = repairParsedEntry({ title: "発光帯　ハナレグミ", artist: "未記載", raw: "0:05 発光帯　ハナレグミ" }, ambiguousLookup);

  assert.deepEqual(bestCombinedTitleArtistCandidate("発光帯　ハナレグミ", uniqueLookup), {
    title: "発光帯",
    artist: "ハナレグミ",
    key: "発光帯::ハナレクミ",
  });
  assert.equal(fixed.title, "発光帯");
  assert.equal(fixed.artist, "ハナレグミ");
  assert.equal(ambiguous.title, "発光帯　ハナレグミ");
  assert.equal(ambiguous.artist, "未記載");
});

test("fills high-confidence unknown artists from reviewed title metadata only", () => {
  const heat = repairParsedEntry({
    time: "0:00:10",
    seconds: 10,
    title: "熱異常",
    artist: "待补歌手",
    raw: "0:10 熱異常",
  });
  const bracketed = repairParsedEntry({
    time: "0:00:20",
    seconds: 20,
    title: "（少女レイ）",
    artist: "未記載",
    raw: "0:20 （少女レイ）",
  });
  const explicit = repairParsedEntry({
    time: "0:00:30",
    seconds: 30,
    title: "熱異常",
    artist: "Other Artist",
    raw: "0:30 熱異常 / Other Artist",
  });
  const chatter = repairParsedEntry({
    time: "0:00:40",
    seconds: 40,
    title: "熱異常について",
    artist: "待补歌手",
    raw: "0:40 熱異常について",
  });
  const haru = repairParsedEntry({
    time: "0:00:50",
    seconds: 50,
    title: "晴る",
    artist: "未記載",
    raw: "0:50 晴る",
  });
  const bansanka = repairParsedEntry({
    time: "0:01:00",
    seconds: 60,
    title: "晩餐歌",
    artist: "待补歌手",
    raw: "1:00 晩餐歌",
  });
  const flower = repairParsedEntry({
    time: "0:01:10",
    seconds: 70,
    title: "花になって",
    artist: "未記載",
    raw: "1:10 花になって",
  });
  const flowerCommentary = repairParsedEntry({
    time: "0:01:20",
    seconds: 80,
    title: "花になっての話",
    artist: "待补歌手",
    raw: "1:20 花になっての話",
  });

  assert.equal(heat.artist, "いよわ");
  assert.equal(heat.repair.changed, true);
  assert.equal(heat.repair.reasons.includes("known_song_artist_override"), true);
  assert.equal(bracketed.title, "（少女レイ）");
  assert.equal(bracketed.artist, "みきとP");
  assert.equal(explicit.artist, "Other Artist");
  assert.equal(chatter.artist, "待补歌手");
  assert.equal(haru.artist, "ヨルシカ");
  assert.equal(bansanka.artist, "tuki.");
  assert.equal(flower.artist, "緑黄色社会");
  assert.equal(flowerCommentary.artist, "待补歌手");
});

test("validates high-confidence artist override config conflicts", () => {
  const validation = validateKnownSongArtistOverrides({
    schemaVersion: 1,
    records: [
      { title: "熱異常", artist: "いよわ", reviewedAt: "2026-07-21" },
      { title: "熱異常", artist: "Other Artist", reviewedAt: "2026-07-21" },
    ],
  });
  const context = createKnownSongArtistOverrideContext({
    schemaVersion: 1,
    records: [{ title: "新宝島", artist: "サカナクション", reviewedAt: "2026-07-21" }],
  });

  assert.equal(validation.errors.some((error) => error.includes("conflicts")), true);
  assert.equal(context.byTitleKey.get("新宝島").artist, "サカナクション");
});

test("cleans safe title decorations without overwriting raw text", () => {
  assert.equal(cleanSafeTitleCandidate("╟ 『ハグルマ』"), "ハグルマ");
  assert.equal(cleanSafeTitleCandidate("╟ 『NEVER SURRENDER』🆕"), "NEVER SURRENDER");
  assert.equal(cleanSafeTitleCandidate("【セットリスト】『Song』←NEW!"), "Song");
  assert.equal(cleanSafeTitleCandidate("【リクエスト】「Song」"), "Song");
  assert.equal(cleanSafeTitleCandidate("01≫アンノウン・マザーグース"), "アンノウン・マザーグース");
  assert.equal(cleanSafeTitleCandidate("待补歌手 01≫アンノウン・マザーグース"), "アンノウン・マザーグース");
  assert.equal(cleanSafeTitleCandidate("꒱‬ 01. 初恋サイダー"), "初恋サイダー");
  assert.equal(cleanSafeTitleCandidate("⁆🦊03.星間飛行"), "星間飛行");
  assert.equal(cleanSafeTitleCandidate("＊ 04. KICK BACK"), "KICK BACK");
  assert.equal(cleanSafeTitleCandidate("＊〜アスタリスク〜"), "＊〜アスタリスク〜");
  assert.equal(cleanSafeTitleCandidate("②どんな色が好き"), "どんな色が好き");
  assert.equal(cleanSafeTitleCandidate("M1.わたがし:_レオペンライト:"), "わたがし");

  const repaired = repairParsedEntry({
    title: "╟ 『NEVER SURRENDER』🆕",
    artist: "未記載",
    raw: "0:07 ╟ 『NEVER SURRENDER』🆕",
  });
  assert.equal(repaired.title, "NEVER SURRENDER");
  assert.equal(repaired.raw, "0:07 ╟ 『NEVER SURRENDER』🆕");

  const numbered = repairParsedEntry({
    title: "M2.フィクサー",
    artist: "ぬゆり:_レオペンライト:",
    raw: "14:54 M2.フィクサー／ぬゆり:_レオペンライト:",
  });
  assert.equal(numbered.title, "フィクサー");
  assert.equal(numbered.artist, "ぬゆり");
});

test("repairs cross-field wrappers and dangling artist brackets", () => {
  const wrapped = repairParsedEntry({
    time: "2:32:34",
    seconds: 9154,
    title: "【Kakurenbo",
    artist: "AliA】",
    raw: "2:32:34 【Kakurenbo - AliA】",
  });
  const dangling = repairParsedEntry({
    time: "1:24:05",
    seconds: 5045,
    title: "かくれんぼ",
    artist: "AliA -【",
    raw: "かくれんぼ/AliA -【01:24:05】",
  });
  const byTitle = repairParsedEntry({
    time: "6:15:35",
    seconds: 22535,
    title: "【Stand",
    artist: "Me】/ Ben E.King",
    raw: "6:15:35 【Stand By Me】/ Ben E.King",
  });

  assert.equal(wrapped.title, "Kakurenbo");
  assert.equal(wrapped.artist, "AliA");
  assert.equal(wrapped.repair.reasons.includes("cross_field_wrapper"), true);
  assert.equal(dangling.artist, "AliA");
  assert.equal(byTitle.title, "Stand By Me");
  assert.equal(byTitle.artist, "Ben E.King");
});

test("strips unpaired trailing close bracket from artist fields", () => {
  const repaired = repairParsedEntry({
    time: "1:06:46",
    seconds: 4006,
    title: "寄り酔い",
    artist: "和ぬか」",
    raw: "1:06:46 🎤7曲目:寄り酔い/和ぬか」",
  });

  assert.equal(repaired.title, "寄り酔い");
  assert.equal(repaired.artist, "和ぬか");
  assert.equal(repaired.repair.reasons.includes("safe_artist_cleanup"), true);
});

test("exposes curation signals for custom emoji and reaction text", () => {
  for (const title of ["_可愛い:ぷくっ", "_hotsmile", "ぷくっ", "ぷいっっ"]) {
    const signals = entryRepairSignals({ title, artist: "未記載", raw: `0:01 ${title}` });
    assert.equal(signals.suppressLikelySong, true, title);
    assert.equal(signals.suggestedAction, "drop_entry");
    assert.ok(signals.reasons.length >= 1);

    const repaired = repairParsedEntry({ title, artist: "未記載", raw: `0:01 ${title}` });
    assert.equal(repaired.curationSignals.suppressLikelySong, true, title);
  }
});

test("exposes curation signals for announcement action and numeric pseudo titles", () => {
  const dirtySamples = [
    { title: "閉会式", artist: "未記載", reason: "activity_or_announcement" },
    { title: "1を手で表現した", artist: "未記載", reason: "activity_or_announcement" },
    { title: "2周年記念お写真公開！", artist: "未記載", reason: "activity_or_announcement" },
    { title: "3Dお披露目でスタンドマイク回したかった", artist: "永ちゃんやりたい", reason: "activity_or_announcement" },
    { title: "〜3Dライブ開催決定!!!!", artist: "未記載", reason: "activity_or_announcement" },
    { title: "3次会", artist: "未記載", reason: "activity_or_announcement" },
    { title: "達成！", artist: "未記載", reason: "activity_or_announcement" },
    { title: "歌みたの話", artist: "未記載", reason: "activity_or_announcement" },
    { title: "02.441", artist: "miwa", reason: "numeric_pseudo_title" },
  ];

  for (const sample of dirtySamples) {
    const repaired = repairParsedEntry({ ...sample, raw: `0:01 ${sample.title}` });
    assert.equal(repaired.curationSignals.suppressLikelySong, true, sample.title);
    assert.equal(repaired.curationSignals.suggestedAction, "drop_entry", sample.title);
    assert.equal(repaired.curationSignals.reasons.includes(sample.reason), true, sample.title);
  }
});

test("restores decimal titles truncated by parser corruption", () => {
  assert.equal(parserCorruptionTitleCandidate({ title: "500♪", raw: "0:08:08  2.500♪" }, "500♪"), "2.500♪");

  const repaired = repairParsedEntry({
    time: "0:08:08",
    seconds: 488,
    title: "500♪",
    artist: "未記載",
    raw: "0:08:08  2.500♪",
  });

  assert.equal(repaired.title, "2.500♪");
  assert.equal(repaired.repair.changed, true);
  assert.ok(repaired.repair.reasons.includes("parser_corruption_title_restore"));
});
