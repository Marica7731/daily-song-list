const assert = require("node:assert/strict");
const test = require("node:test");

const {
  VIDEO_ACTIONS,
  applyCurationToSources,
  applyCurationToVideos,
  classifyEntry,
  createSourceRecord,
  hashNormalizedText,
  isActivityMarkerTitle,
  isCandidateActivityTitle,
  isConversationEntry,
  isParserCorruptionEntry,
  loadCurationContext,
  mergeCurationPatch,
  normalizeOverrides,
  normalizeUpsertSongs,
  validateCurationOverrides,
} = require("../scripts/curation");
const { buildRankDiffs, extractCommentTexts, sourceScore } = require("../scripts/update-songlist");

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
          { title: "結束", artist: "未記載", seconds: 8, raw: "0:08 結束" },
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
  assert.equal(videos.curationStats.ruleDroppedEntries + videos.curationStats.conversationDroppedEntries, 7);
});

test("curation drops naretan commentary rows while keeping explicit known songs", () => {
  const videos = applyCurationToVideos(
    [
      {
        videoId: "NARETAN0001",
        songs: [
          { title: "コメ「なれたんかわいい」", artist: "未記載", seconds: 1, raw: "0:01 コメ「なれたんかわいい」" },
          { title: "アンケート結果", artist: "未記載", seconds: 2, raw: "0:02 アンケート結果" },
          { title: "喉が痛い", artist: "未記載", seconds: 3, raw: "0:03 喉が痛い" },
          { title: "配信について", artist: "未記載", seconds: 4, raw: "0:04 配信について" },
          { title: "リクエストください", artist: "未記載", seconds: 5, raw: "0:05 リクエストください" },
          { title: "コメント欄", artist: "未記載", seconds: 6, raw: "0:06 コメント欄" },
          { title: "なれたん自己紹介", artist: "未記載", seconds: 7, raw: "0:07 なれたん自己紹介" },
          { title: "星座になれたら", artist: "結束バンド", seconds: 8, raw: "0:08 星座になれたら / 結束バンド" },
          { title: "ENDLESS STORY", artist: "REIRA starring YUNA ITO", seconds: 9, raw: "0:09 ENDLESS STORY / REIRA starring YUNA ITO" },
          { title: "Opening", artist: "Known Artist", seconds: 10, raw: "0:10 Opening / Known Artist" },
          { title: "楽しみにしてろよ!", artist: "練習後のなれたんを", seconds: 11, raw: "0:11 楽しみにしてろよ! / 練習後のなれたんを" },
          { title: "なれコールアンケート", artist: "未記載", seconds: 12, raw: "0:12 なれコールアンケート" },
          { title: "Never Ending Story", artist: "Limahl", seconds: 13, raw: "0:13 Never Ending Story / Limahl" },
          { title: "START:DASH!!", artist: "μ's", seconds: 14, raw: "0:14 START:DASH!! / μ's" },
        ],
      },
    ],
    { overrides: { records: [] } },
  );

  assert.deepEqual(
    videos[0].songs.map((item) => `${item.title} / ${item.artist}`),
    ["星座になれたら / 結束バンド", "ENDLESS STORY / REIRA starring YUNA ITO", "Opening / Known Artist", "Never Ending Story / Limahl", "START:DASH!! / μ's"],
  );
  assert.equal(videos.curationStats.ruleDroppedEntries + videos.curationStats.conversationDroppedEntries, 9);
});

test("curation drops global conversational pseudo-song rows from multiple channels", () => {
  const videos = applyCurationToVideos(
    [
      {
        videoId: "NARAETAN002",
        channelName: "なれたん Naraetan Ch.",
        channelHandle: "/@naraetanV",
        songs: [
          { title: "雑談タイム", artist: "未記載", seconds: 1, raw: "0:01 雑談タイム" },
          { title: "START:DASH!!", artist: "μ's", seconds: 2, raw: "0:02 START:DASH!! / μ's" },
        ],
      },
      {
        videoId: "HANON000001",
        channelName: "Hanon Ch. 香鳴ハノン【パレプロ】",
        channelHandle: "/@kanaruhanon",
        songs: [
          { title: "おつはのちゅっちゅる〜！", artist: "未記載", seconds: 3, raw: "1:01:14 おつはのちゅっちゅる〜！" },
          { title: "次のバトンは香鳴ハノンちゃん", artist: "未記載", seconds: 4, raw: "00:24:24 次のバトンは香鳴ハノンちゃん" },
          { title: "セトリは概要欄です", artist: "Setlist is in the description", seconds: 6, raw: "01. セトリは概要欄です / Setlist is in the description" },
          { title: "曲名教えてください", artist: "未記載", seconds: 7, raw: "00:25:00 曲名教えてください" },
          { title: "ENDLESS STORY", artist: "REIRA starring YUNA ITO", seconds: 5, raw: "0:05 ENDLESS STORY / REIRA starring YUNA ITO" },
        ],
      },
    ],
    { overrides: { records: [] } },
  );

  assert.deepEqual(
    videos.flatMap((item) => item.songs.map((song) => `${item.videoId}:${song.title} / ${song.artist}`)),
    ["NARAETAN002:START:DASH!! / μ's", "HANON000001:ENDLESS STORY / REIRA starring YUNA ITO"],
  );
  assert.equal(videos.curationStats.ruleDroppedEntries + videos.curationStats.conversationDroppedEntries, 5);
});

test("curation drops singleton topic/gloss pseudo songs while keeping reliable English artists", () => {
  const videos = applyCurationToVideos(
    [
      {
        videoId: "NARAETAN003",
        channelName: "なれたん Naraetan Ch.",
        channelHandle: "/@naraetanV",
        songs: [
          { title: "上野公園の桜", artist: "Cherry Blossoms at Ueno Park", seconds: 1, raw: "0:01 上野公園の桜 / Cherry Blossoms at Ueno Park" },
          { title: "歌リストの整理", artist: "Organizing My Song List", seconds: 2, raw: "0:02 歌リストの整理 / Organizing My Song List" },
          { title: "この曲（Lovely Fruit）はMVの制服がとても可愛い", artist: "未記載", seconds: 3, raw: "0:03 この曲（Lovely Fruit）はMVの制服がとても可愛い" },
          { title: "ホログラム", artist: "NICO Touches the Walls", seconds: 4, raw: "0:04 ホログラム / NICO Touches the Walls" },
          { title: "元彼氏として", artist: "My Hair is Bad", seconds: 5, raw: "0:05 元彼氏として / My Hair is Bad" },
        ],
      },
      {
        videoId: "HANON000002",
        channelName: "Hanon Ch. 香鳴ハノン【パレプロ】",
        channelHandle: "/@kanaruhanon",
        songs: [
          { title: "次の出番は白雪みしろちゃん", artist: "未記載", seconds: 6, raw: "0:06 次の出番は白雪みしろちゃん" },
          { title: "明日への扉", artist: "I WiSH", seconds: 7, raw: "0:07 明日への扉 / I WiSH" },
        ],
      },
    ],
    { overrides: { records: [] } },
  );

  assert.deepEqual(
    videos.flatMap((item) => item.songs.map((song) => `${song.title} / ${song.artist}`)),
    ["ホログラム / NICO Touches the Walls", "元彼氏として / My Hair is Bad", "明日への扉 / I WiSH"],
  );
  assert.ok(videos.curationStats.ruleDroppedEntries + videos.curationStats.conversationDroppedEntries >= 2);
});

test("curation drops residual daily chatter without removing target real songs", () => {
  const videos = applyCurationToVideos(
    [
      {
        videoId: "NARAETAN004",
        channelName: "なれたん Naraetan Ch.",
        channelHandle: "/@naraetanV",
        songs: [
          { title: "食べ放題", artist: "All-You-Can-Eat", seconds: 1, raw: "01:37:53 食べ放題 / All-You-Can-Eat" },
          { title: "歯磨き後のうがい", artist: "Rinsing After Brushing My Teeth", seconds: 2, raw: "01:28:49 歯磨き後のうがい / Rinsing After Brushing My Teeth" },
          { title: "たすかる", artist: "未記載", seconds: 3, raw: "2:14:48 たすかる" },
          { title: "はのぴょ〜ん！", artist: "未記載", seconds: 4, raw: "0:02:23 はのぴょ〜ん！" },
          { title: "閉会式開始", artist: "未記載", seconds: 5, raw: "0:31:45 0:32:43 閉会式開始" },
          { title: "大阪の話③:海遊館", artist: "未記載", seconds: 6, raw: "0:58:44 大阪の話③:海遊館" },
          { title: "Campus mode!!歌みたのこだわりポイント", artist: "未記載", seconds: 7, raw: "1:32:15 Campus mode!!歌みたのこだわりポイント" },
          { title: "今日の衣装と髪型", artist: "Today’s Outfit and Hairstyle", seconds: 12, raw: "0:12 今日の衣装と髪型 / Today’s Outfit and Hairstyle" },
          { title: "クイズタイム（スイスのモルモット）", artist: "Quiz Time (Swiss Guinea Pigs)", seconds: 13, raw: "0:13 クイズタイム（スイスのモルモット） / Quiz Time (Swiss Guinea Pigs)" },
          { title: "恋ダンスをするネンドウ君", artist: "Nendou Doing the “Koi Dance”", seconds: 14, raw: "0:14 恋ダンスをするネンドウ君 / Nendou Doing the “Koi Dance”" },
          { title: "缶をマイクに", artist: "Using a Can as a Microphone", seconds: 15, raw: "0:15 缶をマイクに / Using a Can as a Microphone" },
          { title: "あなたのお金を数えましょう", artist: "Let’s Count Your Money", seconds: 16, raw: "0:16 あなたのお金を数えましょう / Let’s Count Your Money" },
          { title: "著作権の問題でミュートされています", artist: "Muted Due to Copyright Issues", seconds: 17, raw: "0:17 著作権の問題でミュートされています / Muted Due to Copyright Issues" },
          { title: "AFK (away from keyboard)", artist: "未記載", seconds: 18, raw: "03:36:05 03:38:51 AFK (away from keyboard)" },
          { title: "ペットショップ", artist: "Pet Shop", seconds: 19, raw: "01:58:12 ペットショップ / Pet Shop" },
          { title: "ドンキホーテのラー油", artist: "Donki Hote’s Chili Oil", seconds: 20, raw: "01:47:22 ドンキホーテのラー油 / Donki Hote’s Chili Oil" },
          { title: "ケンタッキーとバーガーキング", artist: "KFC and Burger King", seconds: 21, raw: "01:06:15 ケンタッキーとバーガーキング / KFC and Burger King" },
          { title: "切り抜き酒のラベル", artist: "Clip-Style Sake Label", seconds: 22, raw: "02:07:56 切り抜き酒のラベル / Clip-Style Sake Label" },
          { title: "春が嫌いな人", artist: "People Who Hate Spring", seconds: 23, raw: "00:18:38 春が嫌いな人 / People Who Hate Spring" },
          {
            title: "カンニング（新しく覚えてきた曲を再確認）",
            artist: "Cheating (Rechecking a Newly Learned Song)",
            seconds: 24,
            raw: "00:42:54 カンニング（新しく覚えてきた曲を再確認） / Cheating (Rechecking a Newly Learned Song)",
          },
          { title: "雑談タイム!", artist: "未記載", seconds: 25, raw: "00:43:10 雑談タイム!" },
          { title: "新しいOP画面", artist: "未記載", seconds: 26, raw: "00:03:12 新しいOP画面 / New OP screen" },
          { title: "EDトーク", artist: "未記載", seconds: 27, raw: "02:11:00 EDトーク" },
          { title: "休憩&雑談タイム", artist: "未記載", seconds: 28, raw: "01:20:00 休憩&雑談タイム" },
          { title: "カンニングタイムPart2", artist: "未記載", seconds: 29, raw: "00:45:00 カンニングタイムPart2" },
          { title: "晴る", artist: "ヨルシカ", seconds: 8, raw: "0:08 晴る / ヨルシカ" },
          { title: "晩餐歌", artist: "tuki.", seconds: 9, raw: "0:09 晩餐歌 / tuki." },
          { title: "花になって", artist: "緑黄色社会", seconds: 10, raw: "0:10 花になって / 緑黄色社会" },
          { title: "START", artist: "愛内里菜", seconds: 11, raw: "0:11 START / 愛内里菜" },
        ],
      },
    ],
    { overrides: { records: [] } },
  );

  assert.deepEqual(
    videos[0].songs.map((item) => `${item.title} / ${item.artist}`),
    ["晴る / ヨルシカ", "晩餐歌 / tuki.", "花になって / 緑黄色社会", "START / 愛内里菜"],
  );
  assert.equal(videos.curationStats.ruleDroppedEntries + videos.curationStats.conversationDroppedEntries, 25);
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
  assert.equal(videos.curationStats.ruleDroppedEntries, 1);
  assert.equal(videos.curationStats.conversationDroppedEntries, 3);
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
  assert.equal(videos.curationStats.ruleDroppedEntries, 2);
  assert.equal(videos.curationStats.conversationDroppedEntries, 6);
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

test("curation drops Riona unknown-artist rows while keeping explicit artists", () => {
  const videos = applyCurationToVideos(
    [
      {
        videoId: "ZEAgcWCnkwQ",
        channelName: "Riona Ch. 響咲リオナ - FLOW GLOW",
        channelHandle: "@IsakiRiona",
        songs: [
          { title: "花に亡霊", artist: "未記載", seconds: 145, raw: "2:25 花に亡霊" },
          { title: "自己肯定感がドンドン上がってる", artist: "未記載", seconds: 3362, raw: "56:02 自己肯定感がドンドン上がってる" },
          { title: "花に亡霊", artist: "ヨルシカ", seconds: 4000, raw: "1:06:40 花に亡霊 / ヨルシカ" },
        ],
      },
      {
        videoId: "SAFE0000001",
        channelName: "Other Karaoke Channel",
        songs: [{ title: "花に亡霊", artist: "未記載", seconds: 145, raw: "2:25 花に亡霊" }],
      },
    ],
    { overrides: { records: [] } },
  );

  assert.deepEqual(
    videos.flatMap((item) => item.songs.map((song) => `${item.videoId}:${song.title} / ${song.artist}`)),
    ["ZEAgcWCnkwQ:花に亡霊 / ヨルシカ", "SAFE0000001:花に亡霊 / 未記載"],
  );
  assert.equal(videos.curationStats.ruleDroppedEntries, 2);
});

test("curation covers user-confirmed dirty source samples without broad START drops", () => {
  const curated = applyCurationToVideos(
    [
      {
        videoId: "ZEAgcWCnkwQ",
        channelName: "Riona Ch. 響咲リオナ - FLOW GLOW",
        channelHandle: "@IsakiRiona",
        songs: [
          { title: "自己肯定感がドンドン上がってる", artist: "未記載", seconds: 3362, raw: "56:02 自己肯定感がドンドン上がってる" },
          { title: "START", artist: "愛内里菜", seconds: 4000, raw: "1:06:40 START / 愛内里菜" },
        ],
      },
      {
        videoId: "NARETANCHAT",
        channelName: "Naretan Ch. なれたん",
        channelHandle: "@naretan",
        songs: [
          { title: "なれたん", artist: "未記載", seconds: 1, raw: "0:01 なれたん" },
          { title: "【雑談】リクエスト確認", artist: "未記載", seconds: 2, raw: "0:02 【雑談】リクエスト確認" },
          { title: "星座になれたら", artist: "結束バンド", seconds: 3, raw: "0:03 星座になれたら / 結束バンド" },
        ],
      },
    ],
    { overrides: { records: [] } },
  );

  assert.deepEqual(
    curated.flatMap((item) => item.songs.map((song) => `${item.videoId}:${song.title} / ${song.artist}`)),
    ["ZEAgcWCnkwQ:START / 愛内里菜", "NARETANCHAT:星座になれたら / 結束バンド"],
  );
  assert.equal(curated.curationStats.ruleDroppedEntries + curated.curationStats.conversationDroppedEntries, 3);

  const twDirty = applyCurationToVideos(
    [
      {
        videoId: "okW2MlmPGe8",
        songs: [{ title: "台V脏数据", artist: "未記載", seconds: 6697, raw: "1:51:37 台V脏数据" }],
      },
    ],
    loadCurationContext(),
  );
  assert.equal(twDirty.length, 0);
  assert.equal(twDirty.curationStats.droppedVideos, 1);
});

test("curation folds same-video same-song rows within 30 seconds with provenance", () => {
  const videos = applyCurationToVideos(
    [
      {
        videoId: "DUPLICATE01",
        selectedSourceId: "UgxSelected",
        selectedSourceHash: "selectedHash",
        songs: [
          { title: "ハロ/ハワユ", artist: "未記載", seconds: 470, time: "0:07:50", raw: "7:50 ハロ/ハワユ", rawHash: "raw-unknown" },
          { title: "ハロ/ハワユ", artist: "ナノウ", seconds: 471, time: "0:07:51", raw: "7:51 ハロ/ハワユ / ナノウ", rawHash: "raw-known" },
          { title: "なんでもないや", artist: "RADWIMPS", seconds: 951, time: "0:15:51", raw: "15:51 なんでもないや / RADWIMPS", rawHash: "raw-a" },
          { title: "なんでもないや", artist: "RADWIMPS", seconds: 952, time: "0:15:52", raw: "15:52 なんでもないや / RADWIMPS", rawHash: "raw-b" },
          { title: "花に亡霊", artist: "ヨルシカ", seconds: 1671, time: "0:27:51", raw: "27:51 花に亡霊 / ヨルシカ", rawHash: "raw-c" },
          { title: "花に亡霊", artist: "ヨルシカ", seconds: 1705, time: "0:28:25", raw: "28:25 花に亡霊 / ヨルシカ", rawHash: "raw-d" },
        ],
      },
    ],
    { overrides: { records: [] } },
  );

  assert.deepEqual(
    videos[0].songs.map((item) => `${item.time} ${item.title} / ${item.artist}`),
    ["0:07:51 ハロ/ハワユ / ナノウ", "0:15:51 なんでもないや / RADWIMPS", "0:27:51 花に亡霊 / ヨルシカ", "0:28:25 花に亡霊 / ヨルシカ"],
  );
  assert.equal(videos.curationStats.nearDuplicateDroppedEntries, 2);
  assert.equal(videos.curationStats.nearDuplicateGroups, 2);
  assert.equal(videos[0].songs[0].dedupe.reason, "near_duplicate_same_video");
  assert.equal(videos[0].songs[0].dedupe.windowSeconds, 30);
  assert.equal(videos[0].songs[0].dedupe.duplicates[0].rawHash, "raw-unknown");
  assert.equal(videos[0].songs[1].dedupe.duplicates[0].seconds, 952);
});

test("curation drops dirty chant entries but keeps false-positive song samples", () => {
  const videos = applyCurationToVideos(
    [
      {
        videoId: "TENQDIRTY01",
        songs: [
          { title: "天Q", artist: "未記載", seconds: 1, raw: "0:01 天Q" },
          { title: "天Q天Q~~WO~~~", artist: "未記載", seconds: 2, raw: "0:02 天Q天Q~~WO~~~" },
          { title: "HAWAWA", artist: "未記載", seconds: 3, raw: "0:03 HAWAWA" },
          { title: "AAA TEST TEST", artist: "未記載", seconds: 4, raw: "0:04 AAA TEST TEST" },
          { title: "opening", artist: "未記載", seconds: 5, raw: "0:05 opening" },
          { title: "セットリスト", artist: "歌唱開始時間", seconds: 6, raw: "0:06 セットリスト / 歌唱開始時間" },
          { title: "ED", artist: "お遊戯あり", seconds: 7, raw: "0:07 ED / お遊戯あり" },
          { title: "StaRt", artist: "Mrs. GREEN APPLE", seconds: 10, raw: "0:10 StaRt / Mrs. GREEN APPLE" },
          { title: "START", artist: "レフティーモンスターP feat. Lily", seconds: 20, raw: "0:20 START / レフティーモンスターP feat. Lily" },
          { title: "START", artist: "愛内里菜", seconds: 30, raw: "0:30 START / 愛内里菜" },
          { title: "-ERROR", artist: "niki", seconds: 40, raw: "0:40 -ERROR / niki" },
          { title: "さらば", artist: "キンモクセイ『あたしンち』初代OP ※", seconds: 50, raw: "0:50 さらば / キンモクセイ『あたしンち』初代OP ※" },
          { title: "Open Your Eyes", artist: "Guano Apes", seconds: 60, raw: "1:00 Open Your Eyes / Guano Apes" },
          { title: "ENDLESS STORY", artist: "REIRA starring YUNA ITO", seconds: 70, raw: "1:10 ENDLESS STORY / REIRA starring YUNA ITO" },
        ],
      },
    ],
    { overrides: { records: [] } },
  );

  assert.deepEqual(
    videos[0].songs.map((item) => `${item.title} / ${item.artist}`),
    [
      "StaRt / Mrs. GREEN APPLE",
      "START / レフティーモンスターP feat. Lily",
      "START / 愛内里菜",
      "-ERROR / niki",
      "さらば / キンモクセイ『あたしンち』初代OP ※",
      "Open Your Eyes / Guano Apes",
      "ENDLESS STORY / REIRA starring YUNA ITO",
    ],
  );
  assert.equal(videos.curationStats.ruleDroppedEntries, 7);
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

test("upsert_video fully replaces one existing stream and preserves video metadata", () => {
  const context = {
    overrides: {
      records: normalizeOverrides({
        schemaVersion: 1,
        records: [
          {
            action: "upsert_video",
            videoId: "AAAAAAAAAAA",
            songs: [
              { seconds: 300, title: "Second", artist: "Artist B" },
              { seconds: 120, title: "First", artist: "Artist A", isNiche: true },
              { seconds: 420, title: "自由記述の手動確認曲", artist: "未記載" },
            ],
            reason: "user_provided_setlist",
            reviewedAt: "2026-07-26T04:00:00+08:00",
            reviewedBy: "Marica7731",
          },
        ],
      }).records,
    },
  };
  const videos = [
    {
      videoId: "AAAAAAAAAAA",
      title: "Original stream title",
      publishedTimestamp: 123456789,
      songs: [
        { seconds: 10, title: "Old song", artist: "Old artist" },
        { seconds: 20, title: "Talk segment", artist: "" },
      ],
    },
    {
      videoId: "BBBBBBBBBBB",
      title: "Untouched stream",
      songs: [{ seconds: 30, title: "Keep me", artist: "Artist" }],
    },
  ];

  const curated = applyCurationToVideos(videos, context);
  const target = curated.find((video) => video.videoId === "AAAAAAAAAAA");
  const untouched = curated.find((video) => video.videoId === "BBBBBBBBBBB");

  assert.equal(target.title, "Original stream title");
  assert.equal(target.publishedTimestamp, 123456789);
  assert.deepEqual(target.songs.map((entry) => entry.title), [
    "First",
    "Second",
    "自由記述の手動確認曲",
  ]);
  assert.deepEqual(target.songs.map((entry) => entry.seconds), [120, 300, 420]);
  assert.equal(target.songs[0].time, "0:02:00");
  assert.equal(target.songs[0].isNiche, true);
  assert.equal(target.songs.every((entry) => entry.upserted && entry.sourceId === "manual-upsert:AAAAAAAAAAA"), true);
  assert.equal(target.songs[2].artist, "未記載");
  assert.equal(target.selectedSourceId, "manual-upsert:AAAAAAAAAAA");
  assert.equal(target.catalogReductionReason, "manual_curation");
  assert.equal(target.curationAction, "upsert_video");
  assert.equal(target.songs.some((entry) => entry.title === "Old song"), false);
  assert.equal(untouched.songs[0].title, "Keep me");
  assert.equal(curated.curationStats.upsertedVideos, 1);
});

test("drop_video takes precedence over upsert_video", () => {
  const curated = applyCurationToVideos(
    [{ videoId: "AAAAAAAAAAA", songs: [{ seconds: 1, title: "Old", artist: "Artist" }] }],
    {
      overrides: {
        records: [
          {
            action: "upsert_video",
            videoId: "AAAAAAAAAAA",
            songs: [{ seconds: 2, title: "New", artist: "Artist" }],
            reason: "user_provided_setlist",
            reviewedAt: "2026-07-26T04:00:00+08:00",
            reviewedBy: "Marica7731",
          },
          { action: "drop_video", videoId: "AAAAAAAAAAA" },
        ],
      },
    },
  );

  assert.equal(curated.length, 0);
  assert.equal(curated.curationStats.droppedVideos, 1);
  assert.equal(curated.curationStats.upsertedVideos, 0);
});

test("upsert_video validation requires reviewed non-empty integer timestamps", () => {
  const valid = validateCurationOverrides({
    schemaVersion: 1,
    records: [
      {
        action: "upsert_video",
        videoId: "AAAAAAAAAAA",
        songs: [{ seconds: 120, title: " Song ", artist: " Artist ", isNiche: false }],
        reason: "user_provided_setlist",
        reviewedAt: "2026-07-26T04:00:00+08:00",
        reviewedBy: "Marica7731",
      },
    ],
  });
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.overrides.records[0].songs[0].title, "Song");
  assert.equal(valid.overrides.records[0].songs[0].seconds, 120);
  assert.equal(valid.overrides.records[0].songs[0].isNiche, false);

  const invalid = validateCurationOverrides({
    schemaVersion: 1,
    records: [
      {
        action: "upsert_video",
        videoId: "BBBBBBBBBBB",
        songs: [
          { seconds: "10", title: "String timestamp", artist: "Artist" },
          { seconds: 10.5, title: "Fractional", artist: "Artist" },
          { seconds: 20, title: "", artist: "" },
          { seconds: 20, title: "Duplicate timestamp", artist: "Artist", isNiche: "false" },
        ],
        reason: "schema_documentation",
      },
    ],
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes("reason missing or reserved")));
  assert.ok(invalid.errors.some((error) => error.includes("reviewedAt missing")));
  assert.ok(invalid.errors.some((error) => error.includes("reviewedBy missing")));
  assert.ok(invalid.errors.some((error) => error.includes("non-negative integer")));
  assert.ok(invalid.errors.some((error) => error.includes("title missing")));
  assert.ok(invalid.errors.some((error) => error.includes("artist missing")));
  assert.ok(invalid.errors.some((error) => error.includes("isNiche must be a boolean")));
  assert.ok(invalid.errors.some((error) => error.includes("duplicates 20")));
});

test("upsert_video merge is idempotent and updates one record per video", () => {
  const record = {
    action: "upsert_video",
    videoId: "AAAAAAAAAAA",
    songs: [{ seconds: 120, title: "Song", artist: "Artist" }],
    reason: "user_provided_setlist",
    reviewedAt: "2026-07-26T04:00:00+08:00",
    reviewedBy: "Marica7731",
  };
  const duplicate = mergeCurationPatch(
    { schemaVersion: 1, records: [record] },
    { schemaVersion: 1, records: [record] },
  );
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.counts.ignored, 1);

  const updated = mergeCurationPatch(
    duplicate.merged,
    {
      schemaVersion: 1,
      records: [{ ...record, songs: [...record.songs, { seconds: 240, title: "Second", artist: "Artist" }] }],
    },
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.counts.updated, 1);
  assert.equal(updated.merged.records.length, 1);
  assert.equal(updated.merged.records[0].songs.length, 2);

  const reviewUpdated = mergeCurationPatch(
    updated.merged,
    {
      schemaVersion: 1,
      records: [
        {
          ...updated.merged.records[0],
          note: "second human review",
          reviewedAt: "2026-07-26T05:00:00+08:00",
        },
      ],
    },
  );
  assert.equal(reviewUpdated.ok, true);
  assert.equal(reviewUpdated.counts.updated, 1);
  assert.equal(reviewUpdated.merged.records[0].note, "second human review");
});

test("normalizeUpsertSongs preserves invalid rows for validation", () => {
  assert.equal(VIDEO_ACTIONS.has("upsert_video"), true);
  assert.deepEqual(normalizeUpsertSongs([{ seconds: "120", title: " Missing time ", isNiche: "false" }, null]), [
    { seconds: null, title: "Missing time", artist: "", isNiche: "false" },
    null,
  ]);
});

test("upsert_video reports a target video that is absent without creating a partial video", () => {
  const curated = applyCurationToVideos(
    [{ videoId: "BBBBBBBBBBB", songs: [{ seconds: 30, title: "Keep", artist: "Artist" }] }],
    {
      overrides: normalizeOverrides({
        schemaVersion: 1,
        records: [
          {
            action: "upsert_video",
            videoId: "AAAAAAAAAAA",
            songs: [{ seconds: 120, title: "Replacement", artist: "未記載" }],
            reason: "user_provided_setlist",
            reviewedAt: "2026-07-26T04:00:00+08:00",
            reviewedBy: "Marica7731",
          },
        ],
      }),
    },
  );

  assert.equal(curated.length, 1);
  assert.equal(curated[0].videoId, "BBBBBBBBBBB");
  assert.equal(curated.curationStats.upsertedVideos, 0);
  assert.deepEqual(curated.curationStats.unmatchedUpsertVideoIds, ["AAAAAAAAAAA"]);
});

test("Naraetan 8.32 feat.flower is retained and canonicalized instead of dropped", () => {
  const context = loadCurationContext();
  const record = context.overrides.records.find(
    (entry) => entry.videoId === "yBwvUMnjdGs" && entry.seconds === 7805,
  );
  assert.equal(record.action, "replace_entry");
  assert.equal(record.sourceId, "UgwX_usBCxl0ADk5s2V4AaABAg");
  assert.equal(record.sourceHash, "e5718ef0f544447b15d35e5a345f2a87f035d5b4ec7e1436e977766c935b67e8");
  assert.equal(record.replacement.title, "8.32");

  const curated = applyCurationToVideos(
    [
      {
        videoId: "yBwvUMnjdGs",
        selectedSourceId: "UgwX_usBCxl0ADk5s2V4AaABAg",
        selectedSourceHash: "e5718ef0f544447b15d35e5a345f2a87f035d5b4ec7e1436e977766c935b67e8",
        songs: [
          {
            seconds: 7805,
            title: "8.32 feat.flower",
            artist: "*Luna",
            raw: "2:10:05 8.32 feat.flower / *Luna",
            rawHash: "5d0d9e2f64468fc935bb0da0ac40682c32e2c401905c243f73846cec9c8e0eac",
            sourceId: "UgwX_usBCxl0ADk5s2V4AaABAg",
            sourceHash: "e5718ef0f544447b15d35e5a345f2a87f035d5b4ec7e1436e977766c935b67e8",
          },
        ],
      },
    ],
    context,
  );

  assert.equal(curated.length, 1);
  assert.equal(curated[0].songs.length, 1);
  assert.equal(curated[0].songs[0].title, "8.32");
  assert.equal(curated[0].songs[0].artist, "*Luna");
});

test("Naraetan batch 1 selectors use real accepted comment identities", () => {
  const context = loadCurationContext();
  const records = context.overrides.records.filter(
    (entry) => entry.reviewedAt === "2026-07-26T01:00:00+08:00",
  );
  const keys = new Set(
    records.map(
      (entry) =>
        `${entry.videoId}:${entry.sourceId}:${entry.sourceHash}:${entry.seconds}:${entry.rawHash}`,
    ),
  );

  assert.equal(records.length, 100);
  assert.equal(keys.size, 100);
  assert.equal(records.every((entry) => entry.sourceId && !entry.sourceId.startsWith("selected:")), true);
  assert.equal(records.every((entry) => /^[0-9a-f]{64}$/u.test(entry.sourceHash)), true);
});

test("Naraetan batch 1 confirmed or conservatively retained songs are never dropped", () => {
  const context = loadCurationContext();
  const expectedTitlesByRawHash = new Map([
    ["8dc11a038e2d5f709e947ee0b29de51628c4223fae063ecda9a24ca2b7222df3", "Habit"],
    ["695ac09774554d332dd867bb6362d9b8c50f2bfe8c6fd42c85f870ba66bc011a", "経験値上昇中☆"],
    ["76fb6eb7b39bc6ff953071a7c7ab1356fadf61758262932c2d13dcaf39c86e51", "Get チュー!"],
    ["951f272bf9c77ec0d4a672f2b3ec81b6309b648c3adaa5a637a1c1c03af361c5", "Happy Happy Birthday!"],
    ["37fc5b8ce6a074e168aeeebab3f3788b449e94f289e45d6229653d9ed33016ed", "Ne・Ni・Ge de Reset!"],
    ["b8edc7695869c29d913cd095b2a810796e943685e396bbd858a6e2746065f8f5", "more more!"],
    ["390396f1244a1cd9c824e4339b82ad5a87ffb1a6d3ae95eaa12614b9b1143596", "はなやか?あざやか?"],
    ["c4c0d932de2326e4ea8f98a1d54d137cabc2c30addf6f6abfb2d38835ebf25e3", "わすれるなんてひどい!"],
    ["02f8cd4e5b6fbb1e02a605b6cc828764b8791ff6584ebf778ad28a480d2238fe", "コットンキャンディえいえいおー!"],
    ["f04c84e2ecf03b50d56bca035bb74d14218aa67c061797111556982438ce6cbf", "夢の続き"],
    ["d9b79e92b5025661f3216a07f1fa25e260e9d34353b03666229bcf50e01e6cc8", "青と夏"],
    ["b6782a7d08873b271d4d7f0885b8b22cf3bd2a1134dda0dda7a34ba4ee93d602", "恋"],
  ]);

  for (const [rawHash, expectedTitle] of expectedTitlesByRawHash) {
    const record = context.overrides.records.find((entry) => entry.rawHash === rawHash);
    assert.ok(record, `missing reviewed Naraetan record ${rawHash}`);
    assert.equal(record.action, "replace_entry", `${expectedTitle} must not be dropped`);
    assert.equal(record.replacement.title, expectedTitle);
  }
});

test("global singleton cleanup batch uses exact selectors and conservative actions", () => {
  const context = loadCurationContext();
  const records = context.overrides.records.filter(
    (entry) => `${entry.reason || ""} ${entry.note || ""}`.includes("global-singleton-20260726"),
  );
  const selectorKeys = new Set(
    records.map(
      (entry) =>
        `${entry.videoId}:${entry.sourceId}:${entry.sourceHash}:${entry.seconds}:${entry.rawHash}`,
    ),
  );

  assert.equal(records.length, 15);
  assert.equal(records.filter((entry) => entry.action === "drop_entry").length, 12);
  assert.equal(records.filter((entry) => entry.action === "replace_entry").length, 3);
  assert.equal(selectorKeys.size, records.length);
  assert.equal(records.every((entry) => entry.sourceId), true);
  assert.equal(records.every((entry) => /^[0-9a-f]{64}$/u.test(entry.sourceHash)), true);
  assert.equal(records.every((entry) => /^[0-9a-f]{64}$/u.test(entry.rawHash)), true);
});

test("global singleton cleanup drops only reviewed rows and keeps corrected songs", () => {
  const context = loadCurationContext();
  const records = context.overrides.records.filter(
    (entry) => `${entry.reason || ""} ${entry.note || ""}`.includes("global-singleton-20260726"),
  );
  const originalByRawHash = new Map([
    ["bed5304fddcba7aea348de5ff6c9248589fb9f39b2f9c6a131b07cc127624f7a", ["（音量注意）明日への勇気", "吉成圭子"]],
    ["f84eda4112a7b18d75a26a54bd20183081dde0e72b71f09402b966f383baa4fb", ["ココロのちず", "未記載"]],
    ["b4c9e75396e01c834daa8a8602b2713924b714a17727e56f336d379b01fe66b2", ["恋するフォーチュンクッキー", "未記載"]],
  ]);
  const videos = records.map((entry, index) => {
    const [title, artist] = originalByRawHash.get(entry.rawHash) || [`Reviewed fixture ${index + 1}`, "Known Artist"];
    return {
      videoId: entry.videoId,
      selectedSourceId: entry.sourceId,
      selectedSourceHash: entry.sourceHash,
      songs: [
        {
          seconds: entry.seconds,
          title,
          artist,
          raw: `${entry.seconds} ${title}`,
          rawHash: entry.rawHash,
          sourceId: entry.sourceId,
          sourceHash: entry.sourceHash,
        },
      ],
    };
  });

  const curated = applyCurationToVideos(videos, context);
  const kept = curated.flatMap((video) => video.songs || []);
  assert.equal(kept.length, 3);
  assert.deepEqual(
    kept.map((entry) => `${entry.title} / ${entry.artist}`).sort(),
    [
      "ココロのちず / BOYSTYLE",
      "恋するフォーチュンクッキー / AKB48",
      "明日への勇気 / 吉成圭子",
    ].sort(),
  );

  const target = records.find((entry) => entry.action === "drop_entry");
  const nearMiss = applyCurationToVideos(
    [
      {
        videoId: target.videoId,
        selectedSourceId: target.sourceId,
        selectedSourceHash: target.sourceHash,
        songs: [
          {
            seconds: target.seconds,
            title: "Regression Fixture Song",
            artist: "Known Artist",
            raw: "near miss",
            rawHash: "0".repeat(64),
            sourceId: target.sourceId,
            sourceHash: target.sourceHash,
          },
        ],
      },
    ],
    context,
  );
  assert.equal(nearMiss[0].songs.length, 1);
  assert.equal(nearMiss[0].songs[0].title, "Regression Fixture Song");
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
