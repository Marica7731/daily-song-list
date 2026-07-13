const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function assertHasKeys(value, keys, label) {
  for (const key of keys) {
    assert.ok(Object.hasOwn(value, key), `${label} should include ${key}`);
  }
}

test("public review UI files are not shipped", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "review.html")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "assets", "review.js")), false);
  assert.doesNotMatch(readText("scripts/update-asset-version.js"), /review\.html|assets\/review\.js/);
  assert.doesNotMatch(readText("data/review/all-niche-unknown.md"), /review\.html\?/);
});

test("review manifest records current and history queue counts", () => {
  const manifest = readJson("data/review/manifest.json");

  assert.equal(manifest.currentQueuePath, "data/review/queue-current.json");
  assert.equal(manifest.historyQueuePath, "data/review/queue-history.json");
  assert.equal(manifest.currentEntryIndexPath, "data/review/current-entry-index.json");
  assert.ok(manifest.currentSourceCount > 0);
  assert.ok(manifest.currentEntryCount > 0);
  assert.ok(manifest.historySourceCount > 0);
  assert.ok(manifest.historyEntryCount > 0);
});

test("current entry index contains reviewable entry fields and mixed classifications", () => {
  const index = readJson("data/review/current-entry-index.json");

  assert.ok(index.itemCount > 0);
  assert.equal(index.items.length, index.itemCount);

  const first = index.items[0];
  assertHasKeys(
    first,
    [
      "reviewId",
      "sourcePath",
      "videoId",
      "sourceId",
      "rawHash",
      "seconds",
      "time",
      "title",
      "artist",
      "raw",
      "status",
      "isNiche",
      "classification",
      "suggestedAction",
      "riskReasons",
    ],
    "current entry index item",
  );

  const classifications = new Set(index.items.map((item) => item.classification));
  assert.ok(classifications.has("needs_review"));
  assert.ok([...classifications].some((classification) => classification !== "needs_review"));
});

test("all niche unknown report contains entry fields, count metadata, and classified records", () => {
  const report = readJson("data/review/all-niche-unknown.json");

  assert.ok(report.counts.totalCandidates > 0);
  assert.equal(report.items.length, report.counts.totalCandidates);
  assertHasKeys(
    report.counts,
    [
      "uniqueVideos",
      "uniqueSources",
      "confirmedNoiseCount",
      "parserCorruptionCount",
      "likelyNoiseCount",
      "needsReviewCount",
      "likelySongCount",
      "byClassification",
    ],
    "all niche unknown counts",
  );

  const first = report.items[0];
  assertHasKeys(
    first,
    [
      "title",
      "artist",
      "isNiche",
      "isUnknownArtist",
      "seconds",
      "time",
      "raw",
      "rawHash",
      "videoId",
      "videoTitle",
      "channelName",
      "sourceId",
      "sourceHash",
      "sourceOrigin",
      "sourceScope",
      "ranges",
      "classification",
      "suggestedAction",
      "riskReasons",
      "sourceRiskReasons",
      "positiveEvidence",
    ],
    "all niche unknown item",
  );

  const classifications = new Set(report.items.map((item) => item.classification));
  assert.ok(
    [...classifications].some((classification) => classification !== "needs_review"),
    "target behavior: all-niche-unknown should not classify every report row as needs_review",
  );
  assert.ok(report.counts.confirmedNoiseCount > 0 || report.counts.likelyNoiseCount > 0);
  assert.equal(
    report.items.some((item) => item.classification === "parser_corruption" && !item.replacementSuggestion),
    false,
    "parser corruption rows should carry replacement suggestions",
  );
});
