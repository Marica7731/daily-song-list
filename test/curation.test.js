const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyCurationToSources,
  applyCurationToVideos,
  classifyEntry,
  createSourceRecord,
  hashNormalizedText,
  isActivityMarkerTitle,
  isCandidateActivityTitle,
  isConversationEntry,
  isParserCorruptionEntry,
  mergeCurationPatch,
} = require("../scripts/curation");
const { buildRankDiffs, extractCommentTexts, sourceScore } = require("../scripts/update-songlist");
const { createSongSearchLookup, normalizeSongSearchText } = require("../assets/frontend-utils");

test("source identity prefers commentId and hash fallback is stable", () => {
  const withCommentId = createSourceRecord({
    videoId: "AAAAAAAAAAA",
    sourceType: "comment",
    commentId: "UgxStableComment",
    authorName: "reviewer",
    text: "0:10 Song / Artist",
  });
  const withoutCommentId = createSourceRecord({
    videoId: "AAAAAAAAAAA",
    sourceType: "comment",
    text: "0:10 Song / Artist",
  });

  assert.equal(withCommentId.sourceId, "UgxStableComment");
  assert.equal(withCommentId.sourceHash, hashNormalizedText("0:10 Song / Artist"));
  assert.equal(withoutCommentId.sourceId, `comment:${hashNormalizedText("0:10 Song / Artist")}`);
  assert.equal(createSourceRecord({ videoId: "AAAAAAAAAAA", sourceType: "comment", text: "0:10  Song / Artist" }).sourceHash, withCommentId.sourceHash);
});

test("extractCommentTexts exposes YouTube commentId as sourceId", () => {
  const records = extractCommentTexts(
    {
      commentRenderer: {
        commentId: "UgxFromRenderer",
        authorText: { simpleText: "author" },
        contentText: { runs: [{ text: "0:10 Song / Artist" }] },
      },
    },
    "comment",
    "AAAAAAAAAAA",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].sourceId, "UgxFromRenderer");
  assert.equal(records[0].authorName, "author");
});

test("curation overrides drop, replace, force keep, and carry forward videos", () => {
  const source = createSourceRecord({ videoId: "AAAAAAAAAAA", sourceType: "comment", commentId: "UgxSource", text: "source" });
  const dropRawHash = hashNormalizedText("0:10 dirty");
  const replaceRawHash = hashNormalizedText("0:20 typo");
  const forceRawHash = hashNormalizedText("0:30 keep");
  const context = {
    overrides: {
      records: [
        { action: "drop_entry", videoId: "AAAAAAAAAAA", sourceId: source.sourceId, seconds: 10, rawHash: dropRawHash },
        {
          action: "replace_entry",
          videoId: "AAAAAAAAAAA",
          sourceId: source.sourceId,
          seconds: 20,
          rawHash: replaceRawHash,
          replacement: { title: "Fixed", artist: "Artist" },
        },
        { action: "force_keep", videoId: "AAAAAAAAAAA", sourceId: source.sourceId, seconds: 30, rawHash: forceRawHash },
      ],
    },
  };
  const songs = [
    song("dirty", 10, dropRawHash),
    song("typo", 20, replaceRawHash),
    song("keep", 30, forceRawHash),
  ];

  const curatedSources = applyCurationToSources([{ ...source, songs, stats: { keptCount: 3 } }], context, { videoId: "AAAAAAAAAAA" });
  assert.deepEqual(
    curatedSources[0].songs.map((item) => item.title),
    ["Fixed", "keep"],
  );
  assert.equal(curatedSources[0].songs[1].forceKept, true);

  const carried = applyCurationToVideos([{ videoId: "AAAAAAAAAAA", selectedSourceId: source.sourceId, songs }], context);
  assert.deepEqual(
    carried[0].songs.map((item) => item.title),
    ["Fixed", "keep"],
  );
});

test("curation classifies parser corruptions and conversation-only rows", () => {
  assert.equal(
    isParserCorruptionEntry({
      title: "32",
      artist: "*Luna",
      raw: "01:59:19 15. 8.32 / *Luna",
    }),
    true,
  );
  assert.equal(
    classifyEntry({
      title: "32",
      artist: "*Luna",
      raw: "01:59:19 15. 8.32 / *Luna",
    }).classification,
    "parser_corruption",
  );
  assert.equal(isConversationEntry({ title: "何ケーキを食べるか問題", artist: "未記載" }), true);
  assert.equal(classifyEntry({ title: "何ケーキを食べるか問題", artist: "未記載" }).classification, "likely_noise");
});

test("curation drops high-confidence activity titles but keeps known songs", () => {
  const context = {
    nonSongRules: {
      exactUnknownArtistTitles: ["曲終わり", "マイクテスト"],
      candidateActivityTitles: [],
      activityTitlePatterns: [],
    },
    overrides: { records: [] },
  };
  const videos = applyCurationToVideos(
    [
      {
        videoId: "AAAAAAAAAAA",
        songs: [
          { title: "曲終わり", artist: "未記載", seconds: 10, raw: "0:10 曲終わり" },
          { title: "マイクテスト", artist: "未記載", seconds: 20, raw: "0:20 マイクテスト" },
          { title: "曲紹介", artist: "Known Artist", seconds: 30, raw: "0:30 曲紹介 / Known Artist" },
        ],
      },
    ],
    context,
  );

  assert.deepEqual(videos[0].songs.map((item) => item.title), ["曲紹介"]);
  assert.equal(videos.curationStats.ruleDroppedEntries, 2);
});

test("curation drops naraetan-style narration rows before title-only known-song protection", () => {
  const songSearchLookup = createSongSearchLookup({
    titleKeys: ["あくび", "ペットショップ", "幾億光年", "マリーゴールド", "snowhalation"].map(normalizeSongSearchText),
    titleArtistKeys: ["marigold::aimyon", "snowhalation::μs"],
  });
  const videos = applyCurationToVideos(
    [
      {
        videoId: "NARAETAN01",
        songs: [
          { title: "あくび", artist: "未記載", seconds: 10, raw: "00:00:10 あくび / Yawn" },
          { title: "ペットショップ", artist: "未記載", seconds: 20, raw: "00:00:20 ペットショップ / Pet Shop" },
          { title: "【幾億光年】スーパーで聞いた曲", artist: "未記載", seconds: 30, raw: "00:00:30 【幾億光年】スーパーで聞いた曲" },
          {
            title: "去年のなれたんはもう全部歌った",
            artist: "Last year Naraetan already sang all of them",
            seconds: 35,
            raw: "15. 00:00:35 去年のなれたんはもう全部歌った / Last year Naraetan already sang all of them",
          },
          { title: "練習　晩餐歌", artist: "tuki.", seconds: 40, raw: "00:00:40 練習　晩餐歌/tuki." },
          { title: "マリーゴールド", artist: "未記載", seconds: 50, raw: "00:00:50 マリーゴールド" },
          { title: "Sonw halation", artist: "未記載", seconds: 60, raw: "00:01:00 Sonw halation" },
        ],
      },
    ],
    { overrides: { records: [] }, songSearchLookup },
  );

  assert.deepEqual(
    videos[0].songs.map((item) => item.title),
    ["マリーゴールド", "Sonw halation"],
  );
  assert.equal(videos.curationStats.conversationDroppedEntries, 5);
});

test("curation drops weak unknown singleton rows only when corpus and lookup evidence are weak", () => {
  const songSearchLookup = createSongSearchLookup({ titleKeys: ["knownsong"], titleArtistKeys: [] });
  const videos = applyCurationToVideos(
    [
      {
        videoId: "WEAK000001",
        songs: [
          { title: "Known Song", artist: "未記載", seconds: 10, raw: "00:00:10 Known Song" },
          { title: "Happy Happy Bitthdary", artist: "未記載", seconds: 20, raw: "00:00:20 Happy Happy Bitthdary" },
        ],
      },
    ],
    { overrides: { records: [] }, songSearchLookup },
  );

  assert.deepEqual(videos[0].songs.map((item) => item.title), ["Known Song"]);
  assert.equal(videos.curationStats.conversationDroppedEntries, 1);
});

test("candidate activity title handles legacy non-song rule objects", () => {
  assert.equal(isCandidateActivityTitle("戻り", { exactUnknownArtistTitles: ["戻り"] }), true);
  assert.equal(isCandidateActivityTitle("前前前世", { exactUnknownArtistTitles: [] }), false);
});

test("curation drops reviewed unknown-artist activity leftovers from production data", () => {
  assert.equal(isActivityMarkerTitle("戻り", "未記載"), true);
  assert.equal(isActivityMarkerTitle("本日も〜？ひなたびよりー☀️", "未記載"), true);
  assert.equal(isActivityMarkerTitle("戻り", "Known Artist"), false);

  const videos = applyCurationToVideos(
    [
      {
        videoId: "Nera7o9MuwM",
        songs: [
          { title: "戻り", artist: "未記載", seconds: 1438, raw: "23:58  戻り" },
          { title: "本日も〜？ひなたびよりー☀️", artist: "未記載", seconds: 545, raw: "0:09:05 本日も〜？ひなたびよりー☀️" },
          { title: "戻り", artist: "Known Artist", seconds: 2000, raw: "33:20 戻り / Known Artist" },
        ],
      },
    ],
    { overrides: { records: [] } },
  );

  assert.deepEqual(videos[0].songs.map((item) => item.title), ["戻り"]);
  assert.equal(videos[0].songs[0].artist, "Known Artist");
  assert.equal(videos.curationStats.ruleDroppedEntries, 2);
});

test("curation drops announcement and action rows from current dirty samples", () => {
  const videos = applyCurationToVideos(
    [
      {
        videoId: "DIRTY000001",
        songs: [
          { title: "閉会式", artist: "待补歌手", seconds: 1, raw: "0:01 閉会式" },
          { title: "閉会式も見てください", artist: "待补歌手", seconds: 7, raw: "0:07 閉会式も見てください" },
          { title: "1を手で表現した", artist: "待补歌手", seconds: 2, raw: "0:02 1を手で表現した" },
          { title: "2周年記念お写真公開！", artist: "待补歌手", seconds: 3, raw: "0:03 2周年記念お写真公開！" },
          { title: "〜3Dライブ開催決定!!!!", artist: "待补歌手", seconds: 4, raw: "0:04 〜3Dライブ開催決定!!!!" },
          { title: "3Dお披露目でスタンドマイク回したかった", artist: "永ちゃんやりたい", seconds: 5, raw: "0:05 3Dお披露目でスタンドマイク回したかった / 永ちゃんやりたい" },
          { title: "アンノウン・マザーグース", artist: "wowaka", seconds: 6, raw: "0:06 01≫アンノウン・マザーグース / wowaka" },
        ],
      },
    ],
    { overrides: { records: [] } },
  );

  assert.deepEqual(videos[0].songs.map((item) => item.title), ["アンノウン・マザーグース"]);
  assert.equal(videos.curationStats.ruleDroppedEntries + videos.curationStats.conversationDroppedEntries, 6);
});

test("curation drops IsakiRiona self-esteem chat rows from timestamp lists", () => {
  const videos = applyCurationToVideos(
    [
      {
        videoId: "ZEAgcWCnkwQ",
        songs: [
          { title: "自己肯定感がドンドン上がってる", artist: "未記載", seconds: 3362, raw: "56:02 自己肯定感がドンドン上がってる" },
          { title: "晩餐歌", artist: "tuki.", seconds: 3600, raw: "1:00:00 晩餐歌 / tuki." },
        ],
      },
    ],
    { overrides: { records: [] } },
  );

  assert.deepEqual(videos[0].songs.map((item) => item.title), ["晩餐歌"]);
  assert.equal(videos.curationStats.conversationDroppedEntries, 1);
});

test("curation preserves gORDBq5IpBo songs while dropping chat timeline rows", () => {
  const videos = applyCurationToVideos(
    [
      {
        videoId: "gORDBq5IpBo",
        songs: [
          {
            title: "ライオン",
            artist: "シェリル・ノーム(May'n), ランカ・リー(中島愛)",
            seconds: 1265,
            raw: "00:21:05 ライオン/シェリル・ノーム(May'n), ランカ・リー(中島愛) 2008/08/20 マクロスΔ 挿入歌",
          },
          { title: "ゆるちの幅広い地声がすごい", artist: "未記載", seconds: 2661, raw: "00:44:21 　　ゆるちの幅広い地声がすごい" },
          { title: "星座になれたら", artist: "結束バンド", seconds: 3155, raw: "00:52:35 星座になれたら/結束バンド 2022/12/25" },
          { title: "免許の適正性は仲間", artist: "未記載", seconds: 3868, raw: "01:04:28 　　免許の適正性は仲間" },
          {
            title: "8",
            artist: "29 おりづるVTuberフェス(広島県) 出演決定",
            seconds: 5314,
            raw: "01:28:34 8/29 おりづるVTuberフェス(広島県) 出演決定",
          },
          { title: "うれしすぎて声がサイレン", artist: "未記載", seconds: 5450, raw: "01:30:50 　　うれしすぎて声がサイレン" },
        ],
      },
    ],
    { overrides: { records: [] } },
  );

  assert.deepEqual(
    videos[0].songs.map((item) => item.title),
    ["ライオン", "星座になれたら"],
  );
  assert.equal(videos.curationStats.ruleDroppedEntries + videos.curationStats.conversationDroppedEntries, 4);
});

test("curation drops fRvk5uuysyw chatter without rejecting normal unknown-artist setlists", () => {
  const videos = applyCurationToVideos(
    [
      {
        videoId: "fRvk5uuysyw",
        songs: [
          { title: "謝罪会見", artist: "未記載", seconds: 152, raw: "2:32 ）謝罪会見" },
          { title: "わたがし", artist: "back number", seconds: 383, raw: "6:23 M1.わたがし／back number:_レオペンライト:" },
          { title: "甚平か私服か", artist: "未記載", seconds: 736, raw: "12:16 甚平か私服か" },
          { title: "花火大会とかメンバーと行きたいな", artist: "未記載", seconds: 760, raw: "12:40 花火大会とかメンバーと行きたいな" },
          { title: "フィクサー", artist: "ぬゆり", seconds: 894, raw: "14:54 M2.フィクサー／ぬゆり:_レオペンライト:" },
          { title: "難しい曲を挑戦していくのが玖音レオなんで", artist: "未記載", seconds: 1207, raw: "20:07 難しい曲を挑戦していくのが玖音レオなんで" },
          { title: "俺と結婚したい？", artist: "未記載", seconds: 1359, raw: "22:39 「俺と結婚したい？」" },
          { title: "マリパのわさび事件", artist: "未記載", seconds: 1839, raw: "30:39 ）マリパのわさび事件" },
          { title: "アルテさんとのﾃｨｯﾁ", artist: "未記載", seconds: 2959, raw: "└ 49:19 アルテさんとのﾃｨｯﾁ:_arte::_leo:" },
          { title: "オリジナル", artist: "未記載", seconds: 2400, raw: "40:00 オリジナル" },
          { title: "寂しくない？", artist: "未記載", seconds: 3895, raw: "1:04:55 寂しくない？" },
        ],
      },
    ],
    { overrides: { records: [] } },
  );

  assert.deepEqual(
    videos[0].songs.map((item) => item.title),
    ["わたがし", "フィクサー", "オリジナル"],
  );
  assert.equal(videos.curationStats.ruleDroppedEntries + videos.curationStats.conversationDroppedEntries, 8);
});

test("curation drops campaign and announcement rows from production data", () => {
  const videos = applyCurationToVideos(
    [
      {
        videoId: "CAMPAIGN01",
        songs: [
          {
            title: "AZKi復刻版アルバム発売記念キャンペーン開催 7月1日～7月8日",
            artist: "未記載",
            seconds: 10,
            raw: "0:10 AZKi復刻版アルバム発売記念キャンペーン開催 7月1日～7月8日",
          },
          { title: "オリジナル", artist: "未記載", seconds: 20, raw: "0:20 オリジナル" },
        ],
      },
    ],
    { overrides: { records: [] } },
  );

  assert.deepEqual(videos[0].songs.map((item) => item.title), ["オリジナル"]);
  assert.equal(videos.curationStats.ruleDroppedEntries + videos.curationStats.conversationDroppedEntries, 1);
});

test("curation folds same-video same-song duplicates within 30 seconds and keeps distant repeats", () => {
  const videos = applyCurationToVideos(
    [
      {
        videoId: "DEDUP000001",
        songs: [
          { title: "なんでもないや", artist: "未記載", seconds: 951, time: "0:15:51", raw: "15:51 なんでもないや", rawHash: "raw-1" },
          { title: "なんでもないや", artist: "RADWIMPS", seconds: 952, time: "0:15:52", raw: "15:52 なんでもないや / RADWIMPS", rawHash: "raw-2" },
          { title: "なんでもないや", artist: "RADWIMPS", seconds: 1000, time: "0:16:40", raw: "16:40 なんでもないや / RADWIMPS", rawHash: "raw-3" },
          {
            title: "secret base ～君がくれたもの～",
            artist: "ZONE",
            seconds: 1955,
            time: "0:32:35",
            raw: "32:35 secret base ～君がくれたもの～ / ZONE",
            rawHash: "raw-4",
          },
          {
            title: "secret base～君がくれたもの～",
            artist: "ZONE",
            seconds: 1956,
            time: "0:32:36",
            raw: "32:36 secret base～君がくれたもの～ / ZONE",
            rawHash: "raw-5",
          },
        ],
      },
    ],
    { overrides: { records: [] } },
  );

  assert.deepEqual(
    videos[0].songs.map((item) => `${item.time} ${item.title} / ${item.artist}`),
    [
      "0:15:52 なんでもないや / RADWIMPS",
      "0:16:40 なんでもないや / RADWIMPS",
      "0:32:35 secret base ～君がくれたもの～ / ZONE",
    ],
  );
  assert.equal(videos[0].songs[0].nearDuplicateMerge.droppedCount, 1);
  assert.equal(videos[0].songs[2].nearDuplicateMerge.dropped[0].rawHash, "raw-5");
  assert.equal(videos.curationStats.nearDuplicateDroppedEntries, 2);
});

test("curation patch merge dedupes identical records and reports conflicts", () => {
  const baseRecord = { action: "drop_entry", videoId: "AAAAAAAAAAA", sourceId: "source", seconds: 10, rawHash: "raw" };
  const deduped = mergeCurationPatch({ schemaVersion: 1, records: [baseRecord] }, { schemaVersion: 1, records: [baseRecord] });
  assert.equal(deduped.ok, true);
  assert.equal(deduped.counts.ignored, 1);

  const conflict = mergeCurationPatch(
    { schemaVersion: 1, records: [baseRecord] },
    { schemaVersion: 1, records: [{ ...baseRecord, action: "replace_entry", replacement: { title: "Other" } }] },
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.counts.conflicts, 1);
});

test("high risk source scores below clean song list source", () => {
  const clean = { stats: { keptCount: 8, knownSongCount: 8, artistCount: 8, structuralCount: 8, topicCount: 0, sentenceLikeCount: 0, activityMarkerCount: 0 } };
  const dirty = { stats: { keptCount: 12, knownSongCount: 0, artistCount: 0, structuralCount: 12, topicCount: 4, sentenceLikeCount: 4, activityMarkerCount: 6, riskLevel: "high" } };

  assert.ok(sourceScore(clean) > sourceScore(dirty));
});

test("conversation-heavy source scores below clean song list source", () => {
  const clean = { stats: { keptCount: 8, knownSongCount: 8, artistCount: 8, conversationEntryCount: 0, parserCorruptionCount: 0, riskLevel: "low" } };
  const conversation = {
    stats: {
      keptCount: 9,
      knownSongCount: 0,
      artistCount: 0,
      unknownArtistCount: 9,
      conversationEntryCount: 6,
      parserCorruptionCount: 0,
      riskLevel: "high",
    },
  };

  assert.ok(sourceScore(clean) > sourceScore(conversation));
});

test("rank diffs carry the same current curation version for previous snapshot", () => {
  const curationContext = { version: "curation-v1:test", hash: "hash" };
  const previous = payloadWithItems([{ title: "曲紹介", artist: "", seconds: 10, time: "0:00:10" }], "2026-07-12T00:00:00Z");
  const current = payloadWithItems([{ title: "Song", artist: "Artist", seconds: 20, time: "0:00:20" }], "2026-07-12T01:00:00Z");
  const diffs = buildRankDiffs(current, { entry: { id: "20260712T000000Z" }, payload: previous }, curationContext);

  assert.equal(diffs["7d"].current.curationVersion, "curation-v1:test");
  assert.equal(diffs["7d"].previous.curationVersion, "curation-v1:test");
});

function song(title, seconds, rawHash) {
  return {
    title,
    artist: "未記載",
    seconds,
    time: `0:00:${String(seconds).padStart(2, "0")}`,
    raw: `${seconds} ${title}`,
    rawHash,
    sourceId: "UgxSource",
    sourceHash: "sourceHash",
  };
}

function payloadWithItems(songs, generatedAt) {
  return {
    schemaVersion: 1,
    generatedAt,
    capturedAt: generatedAt,
    groups: {
      "72h": {
        id: "72h",
        items: [
          {
            videoId: "AAAAAAAAAAA",
            title: "video",
            channelName: "channel",
            publishedTimestamp: Date.parse(generatedAt),
            songs,
          },
        ],
      },
      "1m": { id: "1m", items: [] },
    },
  };
}
