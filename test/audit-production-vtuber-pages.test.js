const assert = require("node:assert/strict");
const test = require("node:test");

const {
  auditChannelRecord,
  auditPagePayload,
  pageSpecs,
} = require("../scripts/audit-production-vtuber-pages");

test("production page audit covers the four requested rankings", () => {
  assert.deepEqual(
    pageSpecs().map((spec) => [spec.metric, spec.page]),
    [
      ["count", 1],
      ["count", 2],
      ["songs", 1],
      ["songs", 2],
    ],
  );
});

test("channel audit preserves real singleton and flags only review candidates", () => {
  const result = auditChannelRecord({
    rank: 1,
    key: "fixture",
    name: "Fixture Channel",
    channelHandle: "@fixture",
    count: 20,
    videoCount: 4,
    songCount: 6,
    songs: [
      { title: "One-time Original", displayArtist: "Fixture Artist", count: 1, videoCount: 1 },
      { title: "Known Song", displayArtist: "Known Artist", count: 4, videoCount: 2 },
      { title: "Known Song", displayArtist: "未記載", count: 1, videoCount: 1 },
      { title: "Shared Title", displayArtist: "Artist A", count: 3, videoCount: 2 },
      { title: "Shared Title", displayArtist: "Artist B", count: 2, videoCount: 1 },
      { title: "168000", displayArtist: "未記載", count: 1, videoCount: 1 },
    ],
  });

  assert.equal(result.preservedSingletonSamples.some((song) => song.title === "One-time Original"), true);
  assert.equal(result.issues.obviousConversation.some((song) => song.title === "168000"), true);
  assert.equal(result.issues.unknownFillCandidates[0].title, "Known Song");
  assert.equal(result.issues.unknownFillCandidates[0].inferredArtist, "Known Artist");
  assert.equal(result.issues.sameTitleArtistConflicts[0].title, "Shared Title");
});

test("compact VTuber song rows without artist are not mislabeled as unknown artist", () => {
  const result = auditChannelRecord({
    rank: 1,
    key: "fixture",
    name: "Fixture Channel",
    count: 2,
    videoCount: 1,
    songCount: 2,
    songs: [
      { key: "first-song", name: "First Song", count: 1 },
      { key: "168000", name: "168000", count: 1 },
    ],
  });
  assert.equal(result.songs[0].artistAvailable, false);
  assert.equal(result.songs[0].unknownArtist, false);
  assert.equal(result.issues.unknownArtist.length, 0);
  assert.equal(result.issues.obviousConversation[0].title, "168000");
});

test("page audit requires all 20 channels and complete expanded songs", () => {
  const records = Array.from({ length: 20 }, (_, index) => ({
    rank: index + 1,
    key: `channel-${index}`,
    name: `Channel ${index}`,
    count: 1,
    videoCount: 1,
    songCount: 1,
    songs: [
      {
        title: `Song ${index}`,
        displayArtist: `Artist ${index}`,
        count: 1,
        videoCount: 1,
      },
    ],
  }));
  const audited = auditPagePayload(pageSpecs()[0], {
    page: 1,
    pageSize: 20,
    total: 40,
    pageCount: 2,
    records,
  });
  assert.equal(audited.channelCount, 20);
  assert.equal(audited.expandedSongCount, 20);

  assert.throws(
    () => auditPagePayload(pageSpecs()[0], { records: records.slice(0, 19) }),
    /expected 20 channel records/u,
  );
  const mismatch = auditPagePayload(pageSpecs()[0], {
    records: records.map((record, index) => (index === 0 ? { ...record, songCount: 2 } : record)),
  });
  assert.equal(mismatch.summaryCountMismatchCount, 1);
  assert.deepEqual(mismatch.summaryCountMismatches[0], {
    rank: 1,
    name: "Channel 0",
    songCount: 2,
    expandedSongs: 1,
  });
});
