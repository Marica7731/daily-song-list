const fs = require("node:fs");
const { buildArtistRecords, buildSongRecords } = require("../assets/ranking-utils");

const latest = readJson("data/latest.json");

for (const range of ["72h", "1m"]) {
  const ui = readJson(`data/ui/${range}.json`);
  const fullItems = latest.groups[range].items;
  const uiItems = ui.items;
  const fullOccurrences = collectOccurrences(fullItems);
  const uiOccurrences = collectOccurrences(uiItems);
  if (fullItems.length !== uiItems.length) throw new Error(`${range} item count changed`);
  if (fullOccurrences.length !== uiOccurrences.length) throw new Error(`${range} occurrence count changed`);
  compareMaps(`${range} songs`, recordMap(buildSongRecords(fullOccurrences)), recordMap(buildSongRecords(uiOccurrences)));
  compareMaps(
    `${range} artists`,
    recordMap(buildArtistRecords(fullOccurrences).records),
    recordMap(buildArtistRecords(uiOccurrences).records),
  );
  console.log(`[rank-compare] ${range} items=${uiItems.length} occurrences=${uiOccurrences.length}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectOccurrences(items) {
  return (items || []).flatMap((item) =>
    (item.songs || []).filter((song) => song.title).map((song) => ({ item, song })),
  );
}

function recordMap(records) {
  return new Map(records.map((record) => [record.key, record.count]));
}

function compareMaps(label, actual, expected) {
  if (actual.size !== expected.size) throw new Error(`${label} size ${actual.size} != ${expected.size}`);
  for (const [key, value] of actual) {
    if (expected.get(key) !== value) {
      throw new Error(`${label} mismatch ${key}: ${value} != ${expected.get(key)}`);
    }
  }
}
