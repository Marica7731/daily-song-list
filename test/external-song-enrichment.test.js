const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  EXTERNAL_SYSTEM,
  MATCHING_VERSION,
  assertNoRankingInputs,
  buildSongEnrichment,
} = require("../scripts/lib/external-song-enrichment");
const { parseArgs } = require("../scripts/build-external-song-aliases");

const FIXTURE_PATH = path.join(__dirname, "..", "data", "external", "vsinger-moment", "enrichment-input.fixture.json");
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
const NOW = "2026-07-17T14:30:00.000Z";

function buildFixtureResult() {
  return buildSongEnrichment({
    externalSongs: FIXTURE.externalSongs,
    localSongs: FIXTURE.localSongs,
    manualCuration: FIXTURE.manualCuration,
    now: NOW,
  });
}

test("exact local title and artist matches become automatic identity candidates", () => {
  const result = buildFixtureResult();
  const candidate = result.automaticAliases.find((item) => item.externalSongId === "song:jp-standard");

  assert.equal(candidate.decision, "auto-accept");
  assert.equal(candidate.canonicalTitleCandidate, "少女レイ");
  assert.equal(candidate.canonicalArtistCandidate, "みきとP");
  assert.equal(candidate.confidence, 0.98);
  assert.equal(candidate.provenance.externalSystem, EXTERNAL_SYSTEM);
  assert.equal(candidate.provenance.matchingVersion, MATCHING_VERSION);
  assert.equal(candidate.provenance.rawHash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});

test("kana and romanized artist aliases stay candidates with provenance", () => {
  const result = buildFixtureResult();
  const candidate = result.automaticAliases.find((item) => item.externalSongId === "song:kana-romaji-singer");

  assert.equal(candidate.decision, "auto-accept");
  assert.deepEqual(candidate.kanaRomajiCandidates, ["りょう", "ryo"]);
  assert.deepEqual(candidate.artistAliases, ["りょう"]);
  assert.equal(candidate.provenance.externalId, "song:kana-romaji-singer");
});

test("feat titles can be accepted when title and artist are unique high confidence matches", () => {
  const result = buildFixtureResult();
  const candidate = result.automaticAliases.find((item) => item.externalSongId === "song:feat");

  assert.equal(candidate.decision, "auto-accept");
  assert.equal(candidate.canonicalTitleCandidate, "劣等上等 feat. 鏡音リン・レン");
  assert.equal(result.knownSongCandidates.some((item) => item.externalSongId === "song:feat"), true);
});

test("Piano Ver is not auto-applied when the local identity omits the version suffix", () => {
  const result = buildFixtureResult();
  const candidate = result.reviewCandidates.find((item) => item.externalSongId === "song:piano-version");
  const conflict = result.conflictReport.find((item) => item.externalSongId === "song:piano-version");

  assert.equal(candidate.decision, "review-required");
  assert.equal(candidate.matchingReason, "title-alias-artist");
  assert.equal(conflict.type, "version_suffix_difference");
});

test("Remix, Mashup, and Medley style conflicts are rejected from automatic adoption", () => {
  const result = buildFixtureResult();
  const candidate = result.reviewCandidates.find((item) => item.externalSongId === "song:remix");

  assert.equal(candidate.decision, "rejected-version-conflict");
  assert.equal(candidate.provenance.decision, "rejected-version-conflict");
  assert.equal(result.knownSongCandidates.some((item) => item.externalSongId === "song:remix"), false);
});

test("same title with different artists is treated as ambiguous review material", () => {
  const result = buildFixtureResult();
  const sameTitle = result.reviewCandidates.find((item) => item.externalSongId === "song:same-title-a");
  const externalOnly = result.reviewCandidates.find((item) => item.externalSongId === "song:same-title-b");

  assert.equal(sameTitle.decision, "review-required");
  assert.equal(sameTitle.provenance.decision, "review-required");
  assert.equal(externalOnly.decision, "external-only");
  assert.equal(result.conflictReport.some((item) => item.type === "same_title_different_artist"), true);
});

test("local same-title different-artist conflicts block automatic external identity adoption", () => {
  const result = buildSongEnrichment({
    externalSongs: [
      {
        externalSongId: "song:local-title-conflict",
        title: "花",
        artist: "Singer A",
        sourcePageUrl: "https://vsinger-moment.jp/songs/song%3Alocal-title-conflict",
        fetchedAt: NOW,
        rawHash: "4444444444444444444444444444444444444444444444444444444444444444",
      },
    ],
    localSongs: [
      { title: "花", artist: "Singer A" },
      { title: "花", artist: "Singer B" },
    ],
    now: NOW,
  });
  const candidate = result.reviewCandidates.find((item) => item.externalSongId === "song:local-title-conflict");

  assert.equal(candidate.decision, "review-required");
  assert.equal(candidate.confidence, 0.84);
  assert.equal(result.automaticAliases.some((item) => item.externalSongId === "song:local-title-conflict"), false);
  assert.equal(result.knownSongCandidates.some((item) => item.externalSongId === "song:local-title-conflict"), false);
  assert.equal(result.conflictReport.some((item) => item.externalSongId === "song:local-title-conflict" && item.type === "same_title_different_artist"), true);
});

test("manual curation has the highest priority over external enrichment", () => {
  const result = buildFixtureResult();
  const candidate = result.reviewCandidates.find((item) => item.externalSongId === "song:manual-curation");

  assert.equal(candidate.decision, "manual-curation-priority");
  assert.equal(candidate.confidence, 0.98);
  assert.equal(result.automaticAliases.some((item) => item.externalSongId === "song:manual-curation"), false);
});

test("curation override replacement identity has priority over automatic enrichment", () => {
  const result = buildSongEnrichment({
    externalSongs: [
      {
        externalSongId: "song:curation-replacement",
        title: "KING",
        artist: "Kanaria",
        sourcePageUrl: "https://vsinger-moment.jp/songs/song%3Acuration-replacement",
        fetchedAt: NOW,
        rawHash: "5555555555555555555555555555555555555555555555555555555555555555",
      },
    ],
    localSongs: [{ title: "KING", artist: "Kanaria" }],
    manualCuration: [
      {
        action: "replace_entry",
        sourceId: "description:AAAAAAAAAAA:0",
        replacement: {
          title: "KING",
          artist: "Kanaria",
        },
      },
    ],
    now: NOW,
  });
  const candidate = result.reviewCandidates.find((item) => item.externalSongId === "song:curation-replacement");

  assert.equal(candidate.decision, "manual-curation-priority");
  assert.equal(result.automaticAliases.some((item) => item.externalSongId === "song:curation-replacement"), false);
  assert.equal(result.knownSongCandidates.some((item) => item.externalSongId === "song:curation-replacement"), false);
});

test("known song candidates are independent and not all external songs become known", () => {
  const result = buildFixtureResult();

  assert.equal(result.summary.externalSongCount, 9);
  assert.equal(result.summary.automaticAliasCount, 3);
  assert.equal(result.summary.reviewCandidateCount, 6);
  assert.equal(result.knownSongCandidates.length, 3);
  assert.equal(result.knownSongCandidates.every((item) => item.verifiedAt === null), true);
  assert.equal(result.knownSongCandidates.some((item) => item.externalSongId === "song:no-local"), false);
});

test("external singing counts never enter ranking or known-song outputs", () => {
  const result = buildFixtureResult();
  const serialized = JSON.stringify({
    automaticAliases: result.automaticAliases,
    reviewCandidates: result.reviewCandidates,
    knownSongCandidates: result.knownSongCandidates,
  });

  assert.doesNotMatch(serialized, /streamCount|singingCount|performanceCount|viewCount/u);
  assert.doesNotThrow(() => assertNoRankingInputs(result.automaticAliases));
  assert.doesNotThrow(() => assertNoRankingInputs(result.knownSongCandidates));
});

test("repeated enrichment with the same inputs is idempotent", () => {
  const first = buildFixtureResult();
  const second = buildFixtureResult();

  assert.deepEqual(second.automaticAliases, first.automaticAliases);
  assert.deepEqual(second.reviewCandidates, first.reviewCandidates);
  assert.deepEqual(second.knownSongCandidates, first.knownSongCandidates);
});

test("conflict report covers external-only and local-only identity gaps", () => {
  const result = buildFixtureResult();

  assert.equal(result.conflictReport.some((item) => item.type === "external_missing_local" && item.externalSongId === "song:no-local"), true);
  assert.equal(result.conflictReport.some((item) => item.type === "local_missing_external" && item.title === "本站だけの曲"), true);
  assert.equal(result.conflictReport.some((item) => item.type === "artist_kana_romaji"), true);
});

test("external alias builder defaults to durable curation overrides", () => {
  const options = parseArgs([]);

  assert.equal(path.basename(options.manualCurationInput), "curation-overrides.json");
  assert.equal(path.basename(path.dirname(options.manualCurationInput)), "config");
});
