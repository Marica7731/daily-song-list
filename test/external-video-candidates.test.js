const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildVideoCandidates,
  extractYouTubeVideoId,
} = require("../scripts/lib/external-song-enrichment");

const FIXTURE_PATH = path.join(__dirname, "..", "data", "external", "vsinger-moment", "enrichment-input.fixture.json");
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
const NOW = "2026-07-17T14:30:00.000Z";

function buildFixtureResult() {
  return buildVideoCandidates({
    externalSongs: FIXTURE.externalSongs,
    now: NOW,
  });
}

test("extracts YouTube ids from supported URL and direct id shapes", () => {
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/watch?v=AAAAAAAAAAA&t=123s"), "AAAAAAAAAAA");
  assert.equal(extractYouTubeVideoId("https://youtu.be/BBBBBBBBBBB?t=67"), "BBBBBBBBBBB");
  assert.equal(extractYouTubeVideoId("CCCCCCCCCCC"), "CCCCCCCCCCC");
});

test("video candidates remain unverified and do not enter local catalog fields", () => {
  const result = buildFixtureResult();

  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates.every((candidate) => candidate.verificationStatus === "unverified"), true);
  assert.equal(result.candidates.some((candidate) => candidate.videoId === "AAAAAAAAAAA"), true);
  assert.equal(result.candidates.some((candidate) => candidate.videoId === "BBBBBBBBBBB"), true);
  assert.equal(result.candidates.some((candidate) => candidate.videoId === "CCCCCCCCCCC"), true);
  assert.equal(result.candidates.every((candidate) => !Object.prototype.hasOwnProperty.call(candidate, "catalogStatus")), true);
  assert.equal(result.candidates.every((candidate) => !Object.prototype.hasOwnProperty.call(candidate, "publishedTimestamp")), true);
});

test("reported timestamp and singer are carried only as external claims", () => {
  const result = buildFixtureResult();
  const candidate = result.candidates.find((item) => item.videoId === "BBBBBBBBBBB");

  assert.equal(candidate.reportedSinger, "藍月なくる / Aitsuki Nakuru");
  assert.equal(candidate.reportedTimestamp, "0:01:07");
  assert.equal(candidate.reportedSongTitle, "メルト");
  assert.equal(candidate.reportedArtist, "ryo");
  assert.equal(candidate.provenance.decision, "video-candidate-unverified");
});

test("video candidate generation is idempotent", () => {
  const first = buildFixtureResult();
  const second = buildFixtureResult();

  assert.deepEqual(second, first);
});

test("video candidates include durable source proof", () => {
  const result = buildFixtureResult();
  const candidate = result.candidates.find((item) => item.videoId === "AAAAAAAAAAA");

  assert.equal(candidate.externalSongId, "song:jp-standard");
  assert.equal(candidate.sourceUrl, "https://vsinger-moment.jp/songs/song%3Ajp-standard");
  assert.equal(candidate.provenance.externalSystem, "vsinger-moment.mcp-public");
  assert.equal(candidate.provenance.externalId, "song:jp-standard");
  assert.equal(candidate.provenance.rawHash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});
