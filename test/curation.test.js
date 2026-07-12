const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyCurationToSources,
  applyCurationToVideos,
  classifyEntry,
  createSourceRecord,
  hashNormalizedText,
  isConversationEntry,
  isParserCorruptionEntry,
  mergeCurationPatch,
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

  assert.equal(diffs["72h"].current.curationVersion, "curation-v1:test");
  assert.equal(diffs["72h"].previous.curationVersion, "curation-v1:test");
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
