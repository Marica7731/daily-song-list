const assert = require("node:assert/strict");
const test = require("node:test");

const { buildArtistRecords, buildArtistSongGroups, buildCompetitionRanks, buildSongRecords } = require("../assets/ranking-utils");

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
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].title, "少女レイ");
  assert.equal(records[0].count, 4);
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
