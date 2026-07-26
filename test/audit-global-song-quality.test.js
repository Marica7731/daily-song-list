const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  addVideoToAccumulator,
  aggregateMatchedChannels,
  classifyTitlePattern,
  computeInventoryKey,
  createAccumulator,
  enrichVideoSelectors,
  finalizeAccumulator,
  recordIncludesBatchTag,
  selectorMatchesSong,
} = require("../scripts/audit-global-song-quality");

test("inventory checkpoint key follows source content instead of the commit head", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-song-audit-key-"));
  const input = path.join(root, "latest.json");
  const vsingerDir = path.join(root, "vsinger");
  const youtubeDir = path.join(root, "youtube");
  fs.mkdirSync(vsingerDir);
  fs.mkdirSync(youtubeDir);
  fs.writeFileSync(input, "{\"value\":\"AA\"}\n");
  fs.writeFileSync(path.join(vsingerDir, "manifest.json"), "{\"value\":\"AA\"}\n");
  fs.writeFileSync(path.join(youtubeDir, "manifest.json"), "{\"value\":\"AA\"}\n");

  try {
    const args = { input, vsingerDir, youtubeDir };
    const original = computeInventoryKey(args);
    fs.writeFileSync(path.join(youtubeDir, "manifest.json"), "{\"value\":\"BB\"}\n");
    const changedSameSize = computeInventoryKey(args);
    fs.writeFileSync(path.join(youtubeDir, "manifest.json"), "{\"value\":\"AA\"}\n");
    const restored = computeInventoryKey(args);

    assert.notEqual(changedSameSize, original);
    assert.equal(restored, original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("YOSHIKA audit aggregates split historical channel identities", () => {
  const result = aggregateMatchedChannels([
    {
      key: "channel-id",
      name: "YOSHIKAâ‚Ch.",
      channelId: "UC3xQCiEPSkco54WhuiDcngw",
      handle: "",
      videos: 2,
      songs: 3,
      occurrences: 4,
      unknownArtistSongs: 1,
      unknownArtistOccurrences: 1,
      singletonSongs: 2,
      singletonUnknownSongs: 1,
      titlePatterns: { normal: 3, numeric_only: 1 },
      flaggedSamples: { numeric: [{ title: "168000" }], conversationOrTransition: [], unknownArtist: [] },
      samples: [],
    },
    {
      key: "handle",
      name: "",
      channelId: "",
      handle: "@yoshika-ch",
      videos: 1,
      songs: 2,
      occurrences: 3,
      unknownArtistSongs: 0,
      unknownArtistOccurrences: 0,
      singletonSongs: 1,
      singletonUnknownSongs: 0,
      titlePatterns: { normal: 3 },
      flaggedSamples: { numeric: [], conversationOrTransition: [], unknownArtist: [] },
      samples: [],
    },
  ], (row) => row.channelId === "UC3xQCiEPSkco54WhuiDcngw" || row.handle === "@yoshika-ch");

  assert.deepEqual(result.keys, ["channel-id", "handle"]);
  assert.equal(result.videos, 3);
  assert.equal(result.songs, 5);
  assert.equal(result.occurrences, 7);
  assert.equal(result.singletonSongs, 3);
  assert.equal(result.titlePatterns.normal, 6);
  assert.equal(result.flaggedSamples.numeric.length, 1);
});

test("global audit treats singleton and unknown artist as candidates, not deletion rules", () => {
  const accumulator = createAccumulator("fixture");
  addVideoToAccumulator(accumulator, {
    videoId: "AAAAAAAAAAA",
    channelName: "Fixture Channel",
    channelHandle: "@fixture",
    songs: [
      {
        seconds: 10,
        title: "One-time Original",
        artist: "Fixture Artist",
        raw: "0:10 One-time Original / Fixture Artist",
        sourceId: "fixture-source",
        sourceHash: "fixture-source-hash",
        rawHash: "fixture-raw-hash-1",
      },
      {
        seconds: 20,
        title: "Obscure Cover",
        artist: "未記載",
        raw: "0:20 Obscure Cover",
        sourceId: "fixture-source",
        sourceHash: "fixture-source-hash",
        rawHash: "fixture-raw-hash-2",
      },
    ],
  });

  const result = finalizeAccumulator(accumulator);
  assert.equal(result.counts.occurrences, 2);
  assert.equal(result.counts.songs, 2);
  assert.equal(result.counts.singletonSongs, 2);
  assert.equal(result.counts.singletonUnknownSongs, 1);
  assert.equal(result.channels[0].occurrences, 2);
  assert.equal(result.channels[0].flaggedSamples.unknownArtist.length, 1);
});

test("global audit retains exact selector evidence for numeric channel candidates", () => {
  const accumulator = createAccumulator("fixture");
  addVideoToAccumulator(accumulator, {
    videoId: "AAAAAAAAAAA",
    channelName: "YOSHIKA⁂Ch.",
    channelHandle: "@YOSHIKA-Ch",
    selectedSourceId: "vsinger-moment:fixture-video",
    selectedSourceHash: "fixture-video-hash",
    songs: [
      {
        seconds: 3477,
        title: "168000",
        artist: "未記載",
        raw: "57:57 168000",
        sourceId: "fixture-song-id",
        sourceHash: "fixture-song-hash",
        rawHash: "fixture-raw-hash",
      },
    ],
  });
  const result = finalizeAccumulator(accumulator);
  const sample = result.channels[0].flaggedSamples.numeric[0];
  assert.equal(sample.videoId, "AAAAAAAAAAA");
  assert.equal(sample.sourceId, "fixture-song-id");
  assert.equal(sample.sourceHash, "fixture-song-hash");
  assert.equal(sample.rawHash, "fixture-raw-hash");
  assert.equal(sample.seconds, 3477);
});

test("global audit verifies the complete source selector and rejects near misses", () => {
  const video = enrichVideoSelectors({
    videoId: "AAAAAAAAAAA",
    selectedSourceId: "source-id",
    selectedSourceHash: "source-hash",
    songs: [
      {
        seconds: 42,
        title: "Fixture Song",
        artist: "Fixture Artist",
        raw: "0:42 Fixture Song / Fixture Artist",
      },
    ],
  });
  const song = video.songs[0];
  const selector = {
    action: "replace_entry",
    videoId: video.videoId,
    sourceId: song.sourceId,
    sourceHash: song.sourceHash,
    seconds: song.seconds,
    rawHash: song.rawHash,
  };

  assert.equal(selectorMatchesSong(selector, video, song), true);
  assert.equal(selectorMatchesSong({ ...selector, seconds: 43 }, video, song), false);
  assert.equal(selectorMatchesSong({ ...selector, sourceHash: "wrong" }, video, song), false);
  assert.equal(selectorMatchesSong({ ...selector, rawHash: "wrong" }, video, song), false);
});

test("global audit reports normalized title variants without auto-merging artists", () => {
  const accumulator = createAccumulator("fixture");
  addVideoToAccumulator(accumulator, {
    videoId: "AAAAAAAAAAA",
    channelName: "Fixture Channel",
    songs: [
      { seconds: 10, title: "Finale", artist: "Artist A", raw: "0:10 Finale / Artist A" },
      { seconds: 20, title: "Finale.", artist: "Artist A", raw: "0:20 Finale. / Artist A" },
      { seconds: 30, title: "Finale。", artist: "Artist B", raw: "0:30 Finale。 / Artist B" },
    ],
  });
  const result = finalizeAccumulator(accumulator);
  assert.equal(result.titleVariantCandidates.length, 1);
  assert.equal(result.titleVariantCandidates[0].variants[0].samples[0].videoId, "AAAAAAAAAAA");
  assert.equal(result.titleVariantCandidates[0].variants[0].samples[0].seconds, 10);
  assert.deepEqual(
    result.titleVariantCandidates[0].variants.map((variant) => variant.name),
    ["Finale", "Finale.", "Finale。"],
  );
  assert.equal(result.conflictingArtistTitles.length, 1);
  assert.deepEqual(
    result.conflictingArtistTitles[0].knownArtists.map((artist) => artist.name),
    ["Artist A", "Artist B"],
  );
});

test("global audit title patterns remain conservative", () => {
  assert.equal(classifyTitlePattern("168000", "未記載"), "numeric_only");
  assert.equal(classifyTitlePattern("配信終了", "未記載"), "conversation_or_transition");
  assert.equal(classifyTitlePattern("A tiny original song", "Fixture Artist"), "normal");
  assert.equal(classifyTitlePattern("Song feat. Guest", "Fixture Artist"), "feat_or_annotation");
});

test("batch selection is explicit and does not include unrelated overrides", () => {
  assert.equal(
    recordIncludesBatchTag({ reason: "confirmed_noise", note: "global-singleton-20260726 YOSHIKA" }, "global-singleton-20260726"),
    true,
  );
  assert.equal(
    recordIncludesBatchTag({ batchTag: "global-singleton-followup-20260726" }, "global-singleton-followup-20260726"),
    true,
  );
  assert.equal(recordIncludesBatchTag({ reason: "confirmed_noise", note: "another batch" }, "global-singleton-20260726"), false);
});
