const assert = require("node:assert/strict");
const test = require("node:test");

const proofFixture = require("./fixtures/ui-proof-runtime.json");
const { expectedScreenshots, proofCoverage, screenshotContracts } = require("../scripts/ui-proof-config");
const {
  parseUrlState,
  runtimeRangePath,
  serializeUrlState,
  sourcePresentationModel,
} = require("../assets/frontend-utils");

test("UI proof range fixtures cover future 7d and all contracts without enabling core ranges", () => {
  assert.deepEqual(Object.keys(proofFixture.rangeCases).sort(), ["7d", "all"]);
  assert.deepEqual(proofCoverage.rangeFixtures, ["7d", "all"]);

  const options = {
    validRanges: ["72h", "7d", "1m", "all"],
    validViews: ["songRank", "artistRank", "songAz", "videos"],
    validPageSizes: [50, 100, 200],
    defaults: {
      range: "72h",
      view: "songRank",
      page: 1,
      pageSize: 50,
      bucket: "全部",
      outside: false,
      hideUnknown: false,
      q: "",
    },
  };
  const sevenDay = parseUrlState("?range=7d", options);
  const all = parseUrlState("?range=all", options);

  assert.equal(sevenDay.range, "7d");
  assert.equal(all.range, "all");
  assert.equal(new URLSearchParams(serializeUrlState(sevenDay, options)).get("range"), "7d");
  assert.equal(runtimeRangePath("7d", { ranges: { "7d": { path: proofFixture.rangeCases["7d"].runtimePath } } }), proofFixture.rangeCases["7d"].runtimePath);
  assert.equal(runtimeRangePath("all", { ranges: { all: { path: proofFixture.rangeCases.all.runtimePath } } }), proofFixture.rangeCases.all.runtimePath);
});

test("UI proof source fixtures cover mobile two, desktop/tablet three, and new-to-old order", () => {
  const two = sourcePresentationModel(occurrencesFromSourceCase("double"), { inlineLimit: 3 });
  assert.equal(two.videoCount, 2);
  assert.equal(two.mode, "inline");
  assert.equal(two.inlineVisibleCount, 2);
  assert.equal(two.canExpand, false);
  assert.equal(expectedScreenshots.includes(proofCoverage.sourceFixtures.mobileTwo), true);

  const three = sourcePresentationModel(occurrencesFromSourceCase("triple"), { inlineLimit: 3 });
  assert.equal(three.videoCount, 3);
  assert.equal(three.mode, "inline");
  assert.equal(three.showCopyAll, true);
  assert.equal(expectedScreenshots.includes(proofCoverage.sourceFixtures.desktopThree), true);
  assert.equal(expectedScreenshots.includes(proofCoverage.sourceFixtures.tabletThree), true);

  const newToOld = proofFixture.sourceCases.newToOld.groups.map((group) => Date.parse(group.publishedAt));
  assert.equal(newToOld.every((value) => Number.isFinite(value)), true);
  assert.deepEqual([...newToOld].sort((a, b) => b - a), newToOld);
  assert.equal(screenshotContracts[proofCoverage.sourceFixtures.newToOld].scene, "fixture-newToOld");
});

test("UI proof data-index fixture covers partition pagination, search indexes, and snapshot index order", () => {
  assert.equal(expectedScreenshots.includes("desktop-partition-pagination.png"), true);
  assert.equal(expectedScreenshots.includes("desktop-search-snapshot-index.png"), true);

  const partitions = proofFixture.dataIndexCase.partitions;
  assert.deepEqual(
    partitions.map((entry) => [entry.range, entry.page, entry.pageCount, entry.pageSize]),
    [
      ["7d", 12, 86, 50],
      ["all", 241, 241, 50],
    ],
  );
  assert.equal(partitions.every((entry) => /^data\/ui\/(?:7d|all)\/page-\d{3}\.[0-9a-f]{12}\.json$/u.test(entry.path)), true);

  const searchIndexes = proofFixture.dataIndexCase.searchIndexes;
  assert.equal(searchIndexes.length >= 2, true);
  assert.equal(searchIndexes.every((entry) => entry.key.startsWith("query-index::") && entry.terms.length >= 2), true);

  const snapshotTimes = proofFixture.dataIndexCase.snapshotIndex.map((entry) => Date.parse(entry.generatedAt));
  assert.equal(proofFixture.dataIndexCase.snapshotIndex[0].id, "latest");
  assert.deepEqual([...snapshotTimes].sort((a, b) => b - a), snapshotTimes);
});

test("UI proof config covers diagnostics, identity merge, trend labels, and all range proof", () => {
  for (const name of proofCoverage.trendFixtures) {
    assert.equal(expectedScreenshots.includes(name), true, `missing trend proof ${name}`);
    assert.equal(screenshotContracts[name].params.fixture, "trend");
  }
  for (const name of proofCoverage.identityFixtures) {
    assert.equal(expectedScreenshots.includes(name), true, `missing identity proof ${name}`);
    assert.equal(screenshotContracts[name].scene, "fixture-identity-merge");
  }
  for (const name of proofCoverage.diagnostics) {
    assert.equal(expectedScreenshots.includes(name), true, `missing diagnostic proof ${name}`);
  }
  assert.equal(expectedScreenshots.includes("mobile-all-monotonic-summary.png"), true);
  assert.equal(screenshotContracts["mobile-all-monotonic-summary.png"].scene, "fixture-all-monotonic-summary");
  for (const name of proofCoverage.filterFixtures) {
    assert.equal(expectedScreenshots.includes(name), true, `missing filter proof ${name}`);
  }
  for (const name of proofCoverage.vtuberFixtures) {
    assert.equal(expectedScreenshots.includes(name), true, `missing vtuber proof ${name}`);
    assert.equal(screenshotContracts[name].params.view, "vtuberRank");
  }
  assert.equal(screenshotContracts["mobile-active-query-strip.png"].params.hideUnknown, 1);
  assert.equal(screenshotContracts["mobile-active-query-strip.png"].params.metric, "videos");
});

function occurrencesFromSourceCase(caseName) {
  return proofFixture.sourceCases[caseName].groups.map((group) => ({
    item: {
      videoId: group.videoId,
      title: group.title,
      channelName: group.channelName,
    },
    song: {
      title: "Proof Song",
      artist: "Proof Artist",
      seconds: group.seconds,
      time: group.time,
    },
  }));
}
