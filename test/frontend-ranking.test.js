const assert = require("node:assert/strict");
const test = require("node:test");

const { buildCompetitionRanks, buildSongRecords } = require("../assets/ranking-utils");

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

test("merges unknown artist rows into the only known artist group", () => {
  const records = buildSongRecords([occurrence("夜明けと蛍", "n-buna", "A"), occurrence("夜明けと蛍", "", "B")]);

  assert.equal(records.length, 1);
  assert.equal(records[0].count, 2);
  assert.deepEqual(
    Array.from(records[0].artists.values()).map((entry) => entry.name),
    ["n-buna"],
  );
});

test("keeps unknown artist rows separate when title has multiple known artists", () => {
  const records = buildSongRecords([
    occurrence("you", "倖田來未", "A"),
    occurrence("you", "癒月", "B"),
    occurrence("you", "", "C"),
  ]);

  assert.equal(records.length, 3);
  assert.equal(records.some((record) => record.key.endsWith("::unknown") && record.count === 1), true);
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

function occurrence(title, artist, videoId) {
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
    },
  };
}
