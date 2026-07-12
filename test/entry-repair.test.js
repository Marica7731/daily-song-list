const assert = require("node:assert/strict");
const test = require("node:test");

const {
  bestCombinedTitleArtistCandidate,
  cleanSafeTitleCandidate,
  entryRepairSignals,
  repairParsedEntry,
  titleArtistSplitCandidates,
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

test("cleans safe title decorations without overwriting raw text", () => {
  assert.equal(cleanSafeTitleCandidate("╟ 『ハグルマ』"), "ハグルマ");
  assert.equal(cleanSafeTitleCandidate("╟ 『NEVER SURRENDER』🆕"), "NEVER SURRENDER");
  assert.equal(cleanSafeTitleCandidate("【セットリスト】『Song』←NEW!"), "Song");
  assert.equal(cleanSafeTitleCandidate("【リクエスト】「Song」"), "Song");
  assert.equal(cleanSafeTitleCandidate("01≫アンノウン・マザーグース"), "アンノウン・マザーグース");
  assert.equal(cleanSafeTitleCandidate("꒱‬ 01. 初恋サイダー"), "初恋サイダー");
  assert.equal(cleanSafeTitleCandidate("②どんな色が好き"), "どんな色が好き");

  const repaired = repairParsedEntry({
    title: "╟ 『NEVER SURRENDER』🆕",
    artist: "未記載",
    raw: "0:07 ╟ 『NEVER SURRENDER』🆕",
  });
  assert.equal(repaired.title, "NEVER SURRENDER");
  assert.equal(repaired.raw, "0:07 ╟ 『NEVER SURRENDER』🆕");
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
    { title: "02.441", artist: "miwa", reason: "numeric_pseudo_title" },
  ];

  for (const sample of dirtySamples) {
    const repaired = repairParsedEntry({ ...sample, raw: `0:01 ${sample.title}` });
    assert.equal(repaired.curationSignals.suppressLikelySong, true, sample.title);
    assert.equal(repaired.curationSignals.suggestedAction, "drop_entry", sample.title);
    assert.equal(repaired.curationSignals.reasons.includes(sample.reason), true, sample.title);
  }
});
