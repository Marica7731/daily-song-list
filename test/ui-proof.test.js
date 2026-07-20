const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  expectedScreenshots,
  pngDimensions,
  proofInputEntries,
  proofInputHash,
  screenshotContracts,
  sha256Buffer,
  validateUiProof,
} = require("../scripts/validate-ui-proof");

const repoRoot = path.join(__dirname, "..");

test("UI proof expected list covers source thumbnail states", () => {
  for (const name of [
    "mobile-source-inline-0.png",
    "mobile-source-inline-1.png",
    "mobile-source-inline-2.png",
    "mobile-source-inline-3.png",
    "mobile-source-new-to-old.png",
    "mobile-source-more-than-3.png",
    "mobile-source-more-than-3-expanded.png",
    "mobile-source-more-than-3-expanded-bottom.png",
    "mobile-source-thumb-fallback.png",
    "mobile-source-long-channel.png",
    "mobile-query-filter.png",
    "mobile-active-query-strip.png",
    "desktop-query-panel.png",
    "mobile-video-expanded-bottom.png",
    "desktop-artist-rank.png",
    "desktop-song-index.png",
    "desktop-source-inline-3.png",
    "tablet-source-inline-3.png",
    "desktop-range-7d.png",
    "desktop-range-all.png",
    "desktop-all-diff-explanation.png",
    "desktop-song-kana-romaji-merged.png",
    "mobile-all-monotonic-summary.png",
    "mobile-trend-count-increase.png",
    "mobile-trend-rank-only-down.png",
    "mobile-trend-corrected-decrease.png",
    "mobile-song-kana-romaji-merged.png",
    "mobile-video-diagnostic-result.png",
    "desktop-partition-pagination.png",
    "desktop-search-snapshot-index.png",
  ]) {
    assert.equal(expectedScreenshots.includes(name), true, `missing expected screenshot ${name}`);
  }
});

test("UI proof contracts pin new fixture scenes and proof docs", () => {
  assert.deepEqual(screenshotContracts["desktop-range-7d.png"].params, { fixture: "range", range: "7d" });
  assert.deepEqual(screenshotContracts["desktop-range-all.png"].params, { fixture: "range", range: "all" });
  assert.equal(screenshotContracts["desktop-all-diff-explanation.png"].scene, "fixture-diff-explanation");
  assert.equal(screenshotContracts["desktop-song-kana-romaji-merged.png"].scene, "fixture-identity-merge");
  assert.equal(screenshotContracts["mobile-all-monotonic-summary.png"].scene, "fixture-all-monotonic-summary");
  assert.equal(screenshotContracts["mobile-trend-count-increase.png"].scene, "fixture-trend-countIncrease");
  assert.equal(screenshotContracts["mobile-trend-rank-only-down.png"].params.case, "rankOnlyDown");
  assert.equal(screenshotContracts["mobile-trend-corrected-decrease.png"].params.case, "correctedDecrease");
  assert.equal(screenshotContracts["mobile-song-kana-romaji-merged.png"].scene, "fixture-identity-merge");
  assert.equal(screenshotContracts["mobile-video-diagnostic-result.png"].scene, "fixture-video-diagnostic");
  assert.deepEqual(screenshotContracts["desktop-monthly-song-rank.png"].params, { range: "1m", pageSize: 100 });
  assert.equal(screenshotContracts["desktop-monthly-song-rank.png"].scene, "desktop-all-range-song-rank");
  assert.deepEqual(screenshotContracts["desktop-artist-rank.png"].params, { view: "artistRank" });
  assert.deepEqual(screenshotContracts["desktop-song-index.png"].params, { view: "songAz" });
  assert.equal(screenshotContracts["mobile-source-inline-2.png"].scene, "fixture-double");
  assert.equal(screenshotContracts["mobile-source-inline-3.png"].scene, "fixture-triple");
  assert.equal(screenshotContracts["tablet-source-inline-3.png"].viewport.width, 820);
  assert.equal(screenshotContracts["mobile-source-new-to-old.png"].scene, "fixture-newToOld");
  assert.equal(screenshotContracts["desktop-partition-pagination.png"].scene, "fixture-partition-pagination");
  assert.equal(screenshotContracts["desktop-search-snapshot-index.png"].scene, "fixture-search-snapshot-index");
  assert.equal(screenshotContracts["desktop-query-panel.png"].scene, "desktop-direct-query-fields");
  assert.equal(screenshotContracts["mobile-query-filter.png"].scene, "mobile-direct-query-fields");
  assert.deepEqual(screenshotContracts["mobile-active-query-strip.png"].params, {
    q: "少女レイ",
    hideUnknown: 1,
    metric: "videos",
    minCount: 2,
  });
  assert.equal(screenshotContracts["mobile-video-expanded-bottom.png"].scene, "mobile-video-expanded-bottom");

  const inputPaths = proofInputEntries().map((entry) => entry.path);
  for (const inputPath of [
    "README.md",
    "docs/ui-proof.md",
    "docs/data-architecture.md",
    "docs/range-migration.md",
    "docs/storage-layout.md",
    "docs/backfill.md",
    "test/ui-proof-fixtures.test.js",
  ]) {
    assert.equal(inputPaths.includes(inputPath), true, `missing proof input ${inputPath}`);
  }
});

test("UI proof fingerprint changes when an input hash changes", () => {
  const entries = proofInputEntries();
  const original = proofInputHash(entries);
  const changed = proofInputHash(entries.map((entry, index) => (index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry)));
  assert.notEqual(changed, original);
});

test("UI proof manifest validates committed screenshots when present", () => {
  const manifestPath = path.join(repoRoot, "docs", "assets", "screenshots", "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    assert.fail("UI proof manifest missing; run npm run screenshots:readme");
  }
  const result = validateUiProof({ silent: true });
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("UI proof PNG dimensions and hash helpers read committed images", () => {
  const imagePath = path.join(repoRoot, "docs", "assets", "screenshots", expectedScreenshots[0]);
  if (!fs.existsSync(imagePath)) assert.fail(`missing screenshot fixture ${expectedScreenshots[0]}`);
  const buffer = fs.readFileSync(imagePath);
  const dimensions = pngDimensions(buffer);
  assert.ok(dimensions.width > 0);
  assert.ok(dimensions.height > 0);
  assert.match(sha256Buffer(buffer), /^[a-f0-9]{64}$/u);
});
