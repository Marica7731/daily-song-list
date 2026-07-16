const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  expectedScreenshots,
  pngDimensions,
  proofInputEntries,
  proofInputHash,
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
    "mobile-source-more-than-3.png",
    "mobile-source-more-than-3-expanded.png",
    "mobile-source-thumb-fallback.png",
    "mobile-source-long-channel.png",
    "desktop-source-inline-3.png",
  ]) {
    assert.equal(expectedScreenshots.includes(name), true, `missing expected screenshot ${name}`);
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
