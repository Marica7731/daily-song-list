import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function resolvePython() {
  const defaults = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const executable of [...new Set([process.env.PYTHON, ...defaults].filter(Boolean))]) {
    try {
      execFileSync(executable, ["--version"], { stdio: "ignore" });
      return executable;
    } catch {
      // Try the next interpreter name; Windows commonly has python but not python3.
    }
  }
  throw new Error("Python interpreter not found; set PYTHON or install python3/python");
}

const python = resolvePython();
process.env.PYTHONIOENCODING = "utf-8";
const candidateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(candidateRoot, "scripts/migration/curation-overrides-to-patch.py");
const localMinimalRulesManifest = path.join(candidateRoot, "artifacts/migration/p2-curation-rules.json");
const minimalRulesManifest = fs.existsSync(localMinimalRulesManifest)
  ? localMinimalRulesManifest
  : path.resolve(candidateRoot, "..", ".codex-d-fix", "artifacts/migration/curation-global-singleton-minimal.json");

function knownTuple(overrides = {}) {
  return {
    videoId: "protected-video", occurrenceId: "protected-occurrence", position: 0, seconds: 1,
    sourceId: "protected-source", sourceHash: "protected-source-hash", rawHash: "protected-raw-hash", rangeId: "all",
    ...overrides,
  };
}

function runFixture(root, name, rulesPayload, snapshotRows) {
  const rules = path.join(root, `${name}.rules.json`);
  const snapshot = path.join(root, `${name}.snapshot.ndjson`);
  const output = path.join(root, `${name}.patch.ndjson`);
  const manifest = path.join(root, `${name}.manifest.json`);
  const review = path.join(root, `${name}.review.json`);
  fs.writeFileSync(rules, JSON.stringify(rulesPayload), "utf8");
  fs.writeFileSync(
    snapshot,
    snapshotRows.map((row) => JSON.stringify(row)).join("\n") + (snapshotRows.length ? "\n" : ""),
    "utf8",
  );
  const result = spawnSync(python, [
    script, "--rules-manifest", rules, "--snapshot", snapshot, "--output", output,
    "--manifest-output", manifest, "--review-output", review,
  ], { encoding: "utf8" });
  return {
    result,
    output: fs.existsSync(output) ? fs.readFileSync(output, "utf8") : null,
    manifest: fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : null,
    review: fs.existsSync(review) ? JSON.parse(fs.readFileSync(review, "utf8")) : null,
  };
}

test("curation converter maps audited rules to immutable occurrence keys", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-test-"));
  try {
    const overrides = path.join(root, "overrides.json");
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    fs.writeFileSync(overrides, JSON.stringify({ schemaVersion: 1, records: [
      { action: "drop_entry", videoId: "video-1", seconds: 12, title: "chat", artist: "", sourceId: "comment-1", reason: "confirmed_chat", reviewedAt: "2026-07-27T00:00:00Z", reviewedBy: "test" },
      { action: "replace_entry", videoId: "video-1", seconds: 24, sourceId: "comment-2", replacement: { title: "Real Song", artist: "Artist" }, reason: "confirmed_title", reviewedAt: "2026-07-27T00:00:00Z", reviewedBy: "test" },
      { action: "replace_entry", videoId: "video-1", seconds: 36, sourceId: "comment-3", replacement: { artist: "Artist Only" }, reason: "confirmed_artist", reviewedAt: "2026-07-27T00:00:00Z", reviewedBy: "test" },
      { action: "drop_video", videoId: "video-2", reason: "confirmed_noise", reviewedAt: "2026-07-27T00:00:00Z", reviewedBy: "test" },
    ] }), "utf8");
    fs.writeFileSync(snapshot, [
      { kind: "video", videoId: "video-1" },
      { kind: "video", videoId: "video-2" },
      { videoId: "video-1", occurrenceId: "occ-1", position: 0, seconds: 12, title: "chat", artist: "", sourceId: "comment-1", rangeId: "all", sourceSystem: "latest_json" },
      { videoId: "video-1", occurrenceId: "occ-2", position: 1, seconds: 24, title: "Old", artist: "Unknown", sourceId: "comment-2", rangeId: "all", sourceSystem: "latest_json" },
      { videoId: "video-1", occurrenceId: "occ-3", position: 2, seconds: 36, title: "Same", artist: "Old Artist", sourceId: "comment-3", rangeId: "all", sourceSystem: "latest_json" },
    ].map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
    const result = spawnSync(python, [script, "--overrides", overrides, "--snapshot", snapshot, "--output", output, "--manifest-output", manifest, "--review-output", review], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || fs.readFileSync(review, "utf8"));
    const rows = fs.readFileSync(output, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 4);
    assert.equal(rows[0].entityKey, "occ-1");
    assert.equal(rows[0].tombstone, true);
    assert.equal(rows[1].entityKey, "occ-2");
    assert.equal(rows[1].tombstone, false);
    assert.equal(rows[1].payload.title, "Real Song");
    assert.equal(rows[2].payload.artist, "Artist Only");
    assert.equal(rows[3].entityType, "videos");
    const resultManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
    assert.equal(resultManifest.status, "ready");
    assert.equal(resultManifest.curationMutationCount, 4);
    assert.equal(resultManifest.reviewAudit.accepted, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("curation converter observes ambiguous or missing identity without blocking the batch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-review-test-"));
  try {
    const overrides = path.join(root, "overrides.json");
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    fs.writeFileSync(overrides, JSON.stringify({ records: [
      { action: "replace_entry", videoId: "video-1", seconds: 12, replacement: { title: "new" }, reason: "test" },
      { action: "drop_entry", videoId: "missing", seconds: 1, title: "x", artist: "y", reason: "test" },
    ] }), "utf8");
    fs.writeFileSync(snapshot, [
      { kind: "video", videoId: "video-1" },
      { videoId: "video-1", occurrenceId: "occ-1", position: 0, seconds: 12, title: "a", artist: "b" },
      { videoId: "video-1", occurrenceId: "occ-2", position: 1, seconds: 12, title: "c", artist: "d" },
    ].map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
    const result = spawnSync(python, [script, "--overrides", overrides, "--snapshot", snapshot, "--output", output, "--manifest-output", manifest, "--review-output", review], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const resultManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
    assert.equal(resultManifest.status, "ready");
    assert.equal(resultManifest.observedReviewStatus, "needs_review");
    assert.equal(resultManifest.reviewAudit.ambiguous, 1);
    assert.equal(resultManifest.reviewAudit.already_applied_absent, 1);
    assert.equal(fs.readFileSync(output, "utf8"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exact selector records a different sourceHash without blocking unrelated mutations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-source-hash-test-"));
  try {
    const overrides = path.join(root, "overrides.json");
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    fs.writeFileSync(overrides, JSON.stringify({ records: [{
      action: "drop_entry",
      videoId: "video-1",
      seconds: 12,
      sourceId: "comment-1",
      sourceHash: "expected-source-hash",
      rawHash: "same-raw-hash",
      expectedMatchCount: 1,
      reason: "verified_commentary",
    }] }), "utf8");
    fs.writeFileSync(snapshot, JSON.stringify({
      videoId: "video-1",
      occurrenceId: "occ-1",
      position: 0,
      seconds: 12,
      title: "commentary",
      artist: "",
      sourceId: "comment-1",
      sourceHash: "different-source-hash",
      rawHash: "same-raw-hash",
    }) + "\n", "utf8");

    const result = spawnSync(python, [
      script,
      "--overrides", overrides,
      "--snapshot", snapshot,
      "--output", output,
      "--manifest-output", manifest,
      "--review-output", review,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(output, "utf8"), "");
    const resultManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const resultReview = JSON.parse(fs.readFileSync(review, "utf8"));
    assert.equal(resultManifest.status, "ready");
    assert.equal(resultManifest.observedReviewStatus, "needs_review");
    assert.equal(resultManifest.reviewAudit.provenance_mismatch, 1);
    assert.equal(resultReview.results[0].coarseMatchCount, 1);
    assert.equal(resultReview.results[0].exactMatchCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provenance drift remains observable while the converter exits zero", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-provenance-test-"));
  try {
    for (const [field, expected, actual, expectedStatus] of [
      ["sourceId", "wanted-source", "other-source", 0],
      ["sourceId", "wanted-source", "", 0],
      ["sourceHash", "wanted-source-hash", "", 0],
      ["rawHash", "wanted-raw-hash", "", 0],
    ]) {
      const base = path.join(root, field + expected.replaceAll("-", ""));
      const overrides = base + ".overrides.json";
      const snapshot = base + ".snapshot.ndjson";
      const output = base + ".patch.ndjson";
      const manifest = base + ".manifest.json";
      const review = base + ".review.json";
      fs.writeFileSync(overrides, JSON.stringify({ records: [{
        action: "drop_entry", videoId: "video-1", seconds: 12,
        [field]: expected, expectedMatchCount: 1, reason: "exact-provenance",
      }] }), "utf8");
      fs.writeFileSync(snapshot, JSON.stringify({
        videoId: "video-1", occurrenceId: "occ-1", seconds: 12,
        title: "same second", artist: "Artist", [field]: actual,
      }) + "\n", "utf8");
      const result = spawnSync(python, [script, "--overrides", overrides, "--snapshot", snapshot, "--output", output, "--manifest-output", manifest, "--review-output", review], { encoding: "utf8" });
      assert.equal(result.status, expectedStatus, `${field}: ${result.stderr}`);
      assert.equal(JSON.parse(fs.readFileSync(manifest, "utf8")).status, "ready");
      assert.equal(fs.readFileSync(output, "utf8"), "");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exact selector treats a missing audited time as an explicit no-op", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-absent-test-"));
  try {
    const overrides = path.join(root, "overrides.json");
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    fs.writeFileSync(overrides, JSON.stringify({ records: [{
      action: "drop_entry", videoId: "lUDCE3zZmuQ", seconds: 9463,
      sourceId: "Ugxw2-DEUVx0aNsvVyR4AaABAg",
      sourceHash: "5a84ddcb0ff7c6f66409f9d5b93f1c0c258769dbe6ad300a6b27a1907a37c07f",
      rawHash: "66cb9e129f135600d5b881595110822a7e7bb01175eeb5d7d138763768188f1e",
      expectedMatchCount: 1,
    }] }), "utf8");
    fs.writeFileSync(snapshot, JSON.stringify({
      videoId: "lUDCE3zZmuQ", occurrenceId: "occ-official", position: 1,
      seconds: 8336, title: "花に亡霊", artist: "ヨルシカ",
    }) + "\n", "utf8");
    const result = spawnSync(python, [
      script, "--overrides", overrides, "--snapshot", snapshot, "--output", output,
      "--manifest-output", manifest, "--review-output", review,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const resultManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const resultReview = JSON.parse(fs.readFileSync(review, "utf8"));
    assert.equal(resultManifest.status, "ready");
    assert.equal(resultManifest.selectorMutationCount, 0);
    assert.equal(resultManifest.reviewAudit.already_applied_absent, 1);
    assert.equal(resultReview.results[0].status, "already_applied_absent");
    assert.equal(fs.readFileSync(output, "utf8"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("safety scope mismatch is emitted as an observation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-min-scope-test-"));
  try {
    const rules = path.join(root, "rules.json");
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    fs.writeFileSync(rules, JSON.stringify({ records: [], safetyAssertions: [{
      assertionId: "protected-song", equals: { title: "Protected", artist: "Artist" },
      expectedScopeCount: 2, minScopeCount: 2, expectedMutationCount: 0, knownTuplePresence: [knownTuple()],
    }] }), "utf8");
    fs.writeFileSync(snapshot, JSON.stringify({
      videoId: "protected-video", occurrenceId: "protected-occurrence", position: 0, seconds: 1,
      title: "Protected", artist: "Artist", sourceId: "protected-source",
      sourceHash: "protected-source-hash", rawHash: "protected-raw-hash", rangeId: "all",
    }) + "\n", "utf8");
    const result = spawnSync(python, [script, "--rules-manifest", rules, "--snapshot", snapshot, "--output", output, "--manifest-output", manifest, "--review-output", review], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const resultManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
    assert.equal(resultManifest.status, "ready");
    assert.equal(resultManifest.observedReviewStatus, "needs_review");
    assert.equal(resultManifest.reviewAudit.scope_count_below_minimum, 1);
    assert.equal(fs.readFileSync(output, "utf8"), "");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("missing protected tuple is observable without blocking output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-known-tuple-test-"));
  try {
    const rules = path.join(root, "rules.json");
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    fs.writeFileSync(rules, JSON.stringify({ records: [], safetyAssertions: [{
      assertionId: "protected-song", equals: { title: "Protected", artist: "Artist" }, expectedScopeCount: 1, minScopeCount: 1, expectedMutationCount: 0,
      knownTuplePresence: [knownTuple({ sourceHash: "expected-source-hash" })],
    }] }), "utf8");
    fs.writeFileSync(snapshot, JSON.stringify({
      videoId: "protected-video", occurrenceId: "protected-occurrence", position: 0, seconds: 1,
      title: "Protected", artist: "Artist", sourceId: "protected-source",
      sourceHash: "drifted-source-hash", rawHash: "protected-raw-hash", rangeId: "all",
    }) + "\n", "utf8");
    const result = spawnSync(python, [script, "--rules-manifest", rules, "--snapshot", snapshot, "--output", output, "--manifest-output", manifest, "--review-output", review], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const resultReview = JSON.parse(fs.readFileSync(review, "utf8"));
    assert.equal(resultReview.results[0].status, "known_tuple_missing");
    assert.equal(resultReview.results[0].knownTupleCount, 0);
    assert.equal(fs.readFileSync(output, "utf8"), "");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("safety contracts reject malformed counts and incomplete, duplicate, or unknown immutable tuples", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-contract-schema-test-"));
  try {
    const snapshot = path.join(root, "snapshot.ndjson");
    fs.writeFileSync(snapshot, JSON.stringify({ ...knownTuple(), title: "Protected", artist: "Artist" }) + "\n", "utf8");
    for (const [name, assertion] of [
      ["boolean-exact", { assertionId: "x", equals: { title: "Protected" }, expectedScopeCount: true, expectedMutationCount: 0 }],
      ["negative-min", { assertionId: "x", equals: { title: "Protected" }, minScopeCount: -1, expectedMutationCount: 0 }],
      ["boolean-mutation", { assertionId: "x", equals: { title: "Protected" }, expectedMutationCount: false }],
      ["empty-field", { assertionId: "x", equals: { title: "Protected" }, expectedScopeCount: 1, minScopeCount: 1, expectedMutationCount: 0, knownTuplePresence: [knownTuple({ sourceHash: "" })] }],
      ["wrong-type", { assertionId: "x", equals: { title: "Protected" }, expectedScopeCount: 1, minScopeCount: 1, expectedMutationCount: 0, knownTuplePresence: [knownTuple({ seconds: "1" })] }],
      ["missing-field", { assertionId: "x", equals: { title: "Protected" }, expectedMutationCount: 0, knownTuplePresence: [{ ...knownTuple(), rawHash: undefined }] }],
      ["unknown-field", { assertionId: "x", equals: { title: "Protected" }, expectedScopeCount: 1, minScopeCount: 1, expectedMutationCount: 0, knownTuplePresence: [{ ...knownTuple(), unexpected: true }] }],
      ["duplicate", { assertionId: "x", equals: { title: "Protected" }, expectedScopeCount: 1, minScopeCount: 1, expectedMutationCount: 0, knownTuplePresence: [knownTuple(), knownTuple()] }],
      ["unknown-selector", { assertionId: "x", equals: { titleTypo: "Protected" }, expectedScopeCount: 0, expectedMutationCount: 0 }],
    ]) {
      const rules = path.join(root, `${name}.json`); const output = path.join(root, `${name}.ndjson`); const manifest = path.join(root, `${name}.manifest.json`); const review = path.join(root, `${name}.review.json`);
      fs.writeFileSync(rules, JSON.stringify({ records: [], safetyAssertions: [assertion] }));
      const result = spawnSync(python, [script, "--rules-manifest", rules, "--snapshot", snapshot, "--output", output, "--manifest-output", manifest, "--review-output", review], { encoding: "utf8" });
      assert.equal(result.status, 1, name);
      assert.match(result.stderr, /CURATION_PATCH_ERROR/, name);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("scope gates are independently optional, composable, and keep legacy mutation-only assertions compatible", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-optional-scope-test-"));
  try {
    const row = { ...knownTuple(), title: "Protected", artist: "Artist" };
    for (const [name, assertion] of [
      ["legacy", { assertionId: "legacy", equals: { title: "Protected" }, expectedMutationCount: 0 }],
      ["exact", { assertionId: "exact", equals: { title: "Protected" }, expectedScopeCount: 1, expectedMutationCount: 0 }],
      ["minimum", { assertionId: "minimum", equals: { title: "Protected" }, minScopeCount: 1, expectedMutationCount: 0 }],
      ["combined", { assertionId: "combined", equals: { title: "Protected" }, expectedScopeCount: 1, minScopeCount: 1, expectedMutationCount: 0 }],
    ]) {
      const observed = runFixture(root, name, { records: [], safetyAssertions: [assertion] }, [row]);
      assert.equal(observed.result.status, 0, `${name}: ${observed.result.stderr}`);
      assert.equal(observed.review.results[0].status, "accepted", name);
    }
    for (const [name, assertion, status, gate, observedCount, expectedCount] of [
      ["exact-fail", { assertionId: "exact-fail", equals: { title: "Protected" }, expectedScopeCount: 2, expectedMutationCount: 0 }, "scope_count_mismatch", "expectedScopeCount", 1, 2],
      ["min-fail", { assertionId: "min-fail", equals: { title: "Protected" }, minScopeCount: 2, expectedMutationCount: 0 }, "scope_count_below_minimum", "minScopeCount", 1, 2],
    ]) {
      const failed = runFixture(root, name, { records: [], safetyAssertions: [assertion] }, [row]);
      assert.equal(failed.result.status, 0, name);
      assert.equal(failed.review.results[0].status, status, name);
      assert.equal(failed.review.results[0].assertionId, assertion.assertionId, name);
      assert.equal(failed.review.results[0].gate, gate, name);
      assert.equal(failed.review.results[0].observed, observedCount, name);
      assert.equal(failed.review.results[0].expected, expectedCount, name);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("known tuples require exactly one pre-mutation row inside selector scope and preserve seconds zero", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-known-exactly-once-test-"));
  try {
    const tuple = knownTuple({ seconds: 0 });
    const protectedRow = { ...tuple, title: "Protected", artist: "Artist" };
    const accepted = runFixture(root, "seconds-zero", {
      records: [],
      safetyAssertions: [{
        assertionId: "seconds-zero", equals: { title: "Protected", artist: "Artist" },
        expectedMutationCount: 0, knownTuplePresence: [tuple],
      }],
    }, [protectedRow]);
    assert.equal(accepted.result.status, 0, accepted.result.stderr);
    assert.equal(accepted.review.results[0].knownTupleCount, 1);

    for (const [name, rows, expectedStatus, expectedObserved] of [
      ["missing", [], "known_tuple_missing", { present: 0, missing: 1, ambiguous: 0, outsideScope: 0, projectionError: 0 }],
      ["ambiguous", [protectedRow, { ...protectedRow, title: "Protected" }], "known_tuple_ambiguous", { present: 0, missing: 0, ambiguous: 1, outsideScope: 0, projectionError: 0 }],
      ["outside", [{ ...protectedRow, title: "Different" }], "known_tuple_outside_scope", { present: 0, missing: 0, ambiguous: 0, outsideScope: 1, projectionError: 0 }],
    ]) {
      const failed = runFixture(root, name, {
        records: [],
        safetyAssertions: [{
          assertionId: name, equals: { title: "Protected", artist: "Artist" },
          expectedMutationCount: 0, knownTuplePresence: [tuple],
        }],
      }, rows);
      assert.equal(failed.result.status, 0, `${name}: ${failed.result.stderr}`);
      const assertion = failed.review.results[0];
      assert.equal(assertion.status, expectedStatus, name);
      assert.equal(assertion.gate, "knownTuplePresence", name);
      assert.deepEqual(assertion.observed, expectedObserved, name);
      assert.deepEqual(assertion.expected, { exactlyOnceInScope: 1 }, name);
      assert.doesNotMatch(JSON.stringify(assertion), /protected-source-hash|protected-raw-hash/, name);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("scope is evaluated on logical active input before mutations while mutation count remains independent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-pre-mutation-scope-test-"));
  try {
    const tuple = knownTuple({ seconds: 0 });
    const observed = runFixture(root, "pre-mutation", {
      records: [{
        action: "drop_entry", videoId: tuple.videoId, seconds: 0, sourceId: tuple.sourceId,
        sourceHash: tuple.sourceHash, rawHash: tuple.rawHash, expectedMatchCount: 1,
      }],
      safetyAssertions: [{
        assertionId: "pre-mutation", equals: { title: "Protected", artist: "Artist" },
        expectedScopeCount: 1, minScopeCount: 1, expectedMutationCount: 1,
        knownTuplePresence: [tuple],
      }],
    }, [{ ...tuple, title: "Protected", artist: "Artist" }]);
    assert.equal(observed.result.status, 0, observed.result.stderr);
    assert.equal(observed.review.results.at(-1).scopeRowCount, 1);
    assert.equal(observed.review.results.at(-1).mutationCount, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("handle normalization is generic NFKC/casefold/trim with only one slash and at-sign prefix removed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-generic-handle-test-"));
  try {
    const variants = [" @Example_Handle ", "＠example_handle", "/@EXAMPLE_HANDLE", "example_handle"];
    const rows = [
      ...variants.map((channelHandle, index) => ({
        ...knownTuple({ videoId: `handle-${index}`, occurrenceId: `handle-occ-${index}`, position: index, seconds: index, sourceId: `source-${index}`, sourceHash: `source-hash-${index}`, rawHash: `raw-hash-${index}` }),
        title: "Protected", artist: "", channelHandle,
      })),
      { ...knownTuple({ videoId: "url", occurrenceId: "url-occ" }), title: "Protected", artist: "", channelHandle: "https://youtube.com/@example_handle" },
      { ...knownTuple({ videoId: "double", occurrenceId: "double-occ" }), title: "Protected", artist: "", channelHandle: "@@example_handle" },
    ];
    const observed = runFixture(root, "handles", {
      records: [],
      safetyAssertions: [{
        assertionId: "generic-handle", equals: { channelHandle: "@example_handle" },
        expectedScopeCount: 4, expectedMutationCount: 0,
      }],
    }, rows);
    assert.equal(observed.result.status, 0, observed.result.stderr);
    assert.equal(observed.review.results[0].scopeRowCount, 4);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Vaundy, Flugel, Luna, and artist-scoped Ado fixtures are protected without guessing production counts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-protected-fixtures-test-"));
  try {
    const rows = [
      ...Array.from({ length: 3 }, (_, index) => ({ ...knownTuple({ videoId: `v-${index}`, occurrenceId: `v-occ-${index}`, position: index, seconds: index, sourceId: `v-source-${index}`, sourceHash: `v-source-hash-${index}`, rawHash: `v-raw-hash-${index}` }), title: "逆光 - replica", artist: "Vaundy" })),
      ...Array.from({ length: 123 }, (_, index) => ({ ...knownTuple({ videoId: `f-${index}`, occurrenceId: `f-occ-${index}`, position: index, seconds: 1000 + index, sourceId: `f-source-${index}`, sourceHash: `f-source-hash-${index}`, rawHash: `f-raw-hash-${index}` }), title: `逆光のフリューゲル ${index}`, artist: "Fixture" })),
      { ...knownTuple({ videoId: "luna", occurrenceId: "luna-occ", seconds: 2000 }), title: "8.32", artist: "*Luna" },
      { ...knownTuple({ videoId: "ado", occurrenceId: "ado-occ", seconds: 3000 }), title: "逆光", artist: "Ado" },
      { ...knownTuple({ videoId: "not-ado", occurrenceId: "not-ado-occ", seconds: 3001 }), title: "逆光", artist: "Other" },
    ];
    const observed = runFixture(root, "protected-domains", {
      records: [],
      safetyAssertions: [
        { assertionId: "vaundy", equals: { title: "逆光 - replica", artist: "Vaundy" }, expectedScopeCount: 3, expectedMutationCount: 0 },
        { assertionId: "flugel", startsWith: { title: "逆光のフリューゲル" }, expectedScopeCount: 123, expectedMutationCount: 0 },
        { assertionId: "luna", equals: { title: "8.32", artist: "*Luna" }, minScopeCount: 1, expectedMutationCount: 0 },
        { assertionId: "ado", equals: { title: "逆光", artist: "Ado" }, expectedScopeCount: 1, expectedMutationCount: 0 },
      ],
    }, rows);
    assert.equal(observed.result.status, 0, observed.result.stderr);
    assert.deepEqual(observed.review.results.map((item) => [item.assertionId, item.scopeRowCount, item.mutationCount]), [
      ["vaundy", 3, 0], ["flugel", 123, 0], ["luna", 1, 0], ["ado", 1, 0],
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Naraetan selector changes only lUDCE3zZmuQ at 9463", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-naraetan-exact-target-test-"));
  try {
    const provenance = { sourceId: "naraetan-source", sourceHash: "naraetan-source-hash", rawHash: "naraetan-raw-hash" };
    const observed = runFixture(root, "naraetan-only", {
      records: [{
        action: "drop_entry", videoId: "lUDCE3zZmuQ", seconds: 9463, ...provenance,
        expectedMatchCount: 1, expectedCurrentState: "present", expectedSelectorMutationCount: 1,
      }],
    }, [
      { videoId: "lUDCE3zZmuQ", occurrenceId: "target", position: 0, seconds: 9463, title: "Commentary", artist: "", rangeId: "all", ...provenance },
      { videoId: "other-video", occurrenceId: "other", position: 0, seconds: 9463, title: "Song", artist: "Artist", rangeId: "all", ...provenance },
    ]);
    assert.equal(observed.result.status, 0, observed.result.stderr);
    assert.deepEqual(observed.output.trim().split("\n").map(JSON.parse).map((row) => row.entityKey), ["target"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("legacy selector and alias drift are observed while invalid replacement schema remains fatal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-legacy-risk-test-"));
  try {
    const noHitRecords = Array.from({ length: 100 }, (_, index) => ({
      action: "drop_entry", videoId: `legacy-${index}`, seconds: index, sourceId: `wanted-${index}`,
      expectedMatchCount: 1, title: "Commentary", artist: "",
    }));
    const aliasTuple = knownTuple({ videoId: "alias-video", occurrenceId: "alias-occurrence", seconds: 5000 });
    const observed = runFixture(root, "legacy-risks", {
      records: [
        ...noHitRecords,
        { action: "drop_entry", videoId: "hash-drift", seconds: 1000, sourceId: "hash-source", sourceHash: "required-hash", expectedMatchCount: 1 },
      ],
      artistScopedAliases: [{
        ruleId: "global-alias-risk", artist: "Ado", canonicalTitle: "逆光",
        aliases: ["Alias"], expectedMatchCount: 1,
      }],
      safetyAssertions: [{
        assertionId: "global-alias-risk", equals: { title: "Alias", artist: "Ado" },
        expectedScopeCount: 1, minScopeCount: 1, expectedMutationCount: 0,
        knownTuplePresence: [aliasTuple],
      }],
    }, [
      ...Array.from({ length: 100 }, (_, index) => ({
        videoId: `legacy-${index}`, occurrenceId: `legacy-occ-${index}`, position: 0, seconds: index,
        title: "Commentary", artist: "", sourceId: `different-${index}`, rangeId: "all",
      })),
      { videoId: "hash-drift", occurrenceId: "hash-occ", position: 0, seconds: 1000, title: "Commentary", artist: "", sourceId: "hash-source", rawHash: "raw", rangeId: "all" },
      { ...aliasTuple, title: "Alias", artist: "Ado" },
    ]);
    assert.equal(observed.result.status, 0, observed.result.stderr);
    assert.equal(observed.manifest.status, "ready");
    assert.equal(observed.manifest.observedReviewStatus, "needs_review");
    assert.equal(observed.manifest.aliasMutationCount, 1);
    assert.equal(observed.manifest.reviewAudit.already_applied_absent, 100);
    assert.equal(observed.manifest.reviewAudit.provenance_mismatch, 1);
    assert.equal(observed.manifest.reviewAudit.safety_violation, 1);
    const aliasGate = observed.review.results.find((item) => item.assertionId === "global-alias-risk" && item.kind === "safety_assertion");
    assert.deepEqual([aliasGate.gate, aliasGate.observed, aliasGate.expected], ["expectedMutationCount", 1, 0]);

    const invalidReplace = runFixture(root, "invalid-replace", {
      records: [{
        action: "replace_entry", videoId: "bad-replace", seconds: 1001,
        sourceId: "replace-source", replacement: {}, expectedMatchCount: 1,
      }],
    }, [{
      videoId: "bad-replace", occurrenceId: "replace-occ", position: 0, seconds: 1001,
      title: "Old", artist: "Artist", sourceId: "replace-source", rangeId: "all",
    }]);
    assert.equal(invalidReplace.result.status, 1);
    assert.match(invalidReplace.result.stderr, /CURATION_PATCH_ERROR.*replace_entry requires replacement/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Naraetan binds present to one mutation, absent to zero, and observes coarse provenance drift", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-naraetan-state-test-"));
  try {
    const base = { ruleId: "naraetan-test", action: "drop_entry", videoId: "video", seconds: 7, sourceId: "source", sourceHash: "source-hash", rawHash: "raw-hash", expectedMatchCount: 1 };
    for (const [name, state, row, expectedStatus, expectedMutations] of [
      ["present", "present", { videoId: "video", occurrenceId: "occ", position: 0, seconds: 7, sourceId: "source", sourceHash: "source-hash", rawHash: "raw-hash", rangeId: "all", title: "talk", artist: "" }, 0, 1],
      ["absent", "absent", null, 0, 0],
      ["drift", "absent", { videoId: "video", occurrenceId: "occ", position: 0, seconds: 7, sourceId: "source", sourceHash: "different", rawHash: "raw-hash", rangeId: "all", title: "talk", artist: "" }, 0, 0],
    ]) {
      const rules = path.join(root, `${name}.json`); const snapshot = path.join(root, `${name}.ndjson`); const output = path.join(root, `${name}.out`); const manifest = path.join(root, `${name}.manifest`); const review = path.join(root, `${name}.review`);
      fs.writeFileSync(rules, JSON.stringify({ records: [{ ...base, expectedCurrentState: state, expectedSelectorMutationCount: state === "present" ? 1 : 0 }] }));
      fs.writeFileSync(snapshot, row ? JSON.stringify(row) + "\n" : "");
      const result = spawnSync(python, [script, "--rules-manifest", rules, "--snapshot", snapshot, "--output", output, "--manifest-output", manifest, "--review-output", review], { encoding: "utf8" });
      assert.equal(result.status, expectedStatus, name);
      assert.equal(JSON.parse(fs.readFileSync(manifest, "utf8")).selectorMutationCount, expectedMutations, name);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("protected real songs receive zero mutations when a separate exact selector is removed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-protected-zero-test-"));
  try {
    const rules = path.join(root, "rules.json");
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    fs.writeFileSync(rules, JSON.stringify({ records: [{
      action: "drop_entry", videoId: "commentary-video", seconds: 10, sourceId: "commentary-source",
      sourceHash: "commentary-source-hash", rawHash: "commentary-raw-hash", expectedMatchCount: 1,
    }], safetyAssertions: [{
      assertionId: "protect-real-song", equals: { title: "Real Song", artist: "Real Artist" }, expectedScopeCount: 1, minScopeCount: 1, expectedMutationCount: 0,
      knownTuplePresence: [knownTuple({ videoId: "real-video", occurrenceId: "real-occurrence", position: 0, seconds: 20, sourceId: "real-source", sourceHash: "real-source-hash", rawHash: "real-raw-hash" })],
    }] }), "utf8");
    fs.writeFileSync(snapshot, [
      { videoId: "commentary-video", occurrenceId: "commentary-occurrence", position: 0, seconds: 10, title: "Talk", artist: "", sourceId: "commentary-source", sourceHash: "commentary-source-hash", rawHash: "commentary-raw-hash", rangeId: "all" },
      { videoId: "real-video", occurrenceId: "real-occurrence", position: 0, seconds: 20, title: "Real Song", artist: "Real Artist", sourceId: "real-source", sourceHash: "real-source-hash", rawHash: "real-raw-hash", rangeId: "all" },
    ].map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
    const result = spawnSync(python, [script, "--rules-manifest", rules, "--snapshot", snapshot, "--output", output, "--manifest-output", manifest, "--review-output", review], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const rows = fs.readFileSync(output, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.map((row) => row.entityKey), ["commentary-occurrence"]);
    const protectedResult = JSON.parse(fs.readFileSync(review, "utf8")).results.find((item) => item.assertionId === "protect-real-song");
    assert.equal(protectedResult.mutationCount, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Urameshi handle protection accepts NFKC, case, trim, and single-prefix variants only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-urameshi-handle-test-"));
  try {
    const rules = path.join(root, "rules.json");
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    fs.writeFileSync(rules, JSON.stringify({ records: [], safetyAssertions: [{
      assertionId: "exclude-urameshi", equals: { channelHandle: "@urameshi_conta" }, expectedScopeCount: 4, minScopeCount: 4, expectedMutationCount: 0,
      knownTuplePresence: Array.from({ length: 4 }, (_, index) => knownTuple({ videoId: `urameshi-${index}`, occurrenceId: `urameshi-occ-${index}`, position: index, seconds: index, sourceId: `source-${index}`, sourceHash: `hash-${index}`, rawHash: `raw-${index}` })),
    }] }), "utf8");
    fs.writeFileSync(snapshot, [" @URAMESHI_CONTA ", "＠urameshi_conta", "/@UrAmEsHi_CoNtA", "urameshi_conta", "@@urameshi_conta"].map((channelHandle, index) => JSON.stringify({
      videoId: `urameshi-${index}`, occurrenceId: `urameshi-occ-${index}`, position: index, seconds: index,
      title: "protected", artist: "", sourceId: `source-${index}`, sourceHash: `hash-${index}`, rawHash: `raw-${index}`, rangeId: "all", channelHandle,
    })).join("\n") + "\n", "utf8");
    const result = spawnSync(python, [script, "--rules-manifest", rules, "--snapshot", snapshot, "--output", output, "--manifest-output", manifest, "--review-output", review], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const assertion = JSON.parse(fs.readFileSync(review, "utf8")).results[0];
    assert.equal(assertion.scopeRowCount, 4);
    assert.equal(assertion.mutationCount, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("handle normalization does not parse URLs or channel identities", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-urameshi-url-test-"));
  try {
    const rules = path.join(root, "rules.json");
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    fs.writeFileSync(rules, JSON.stringify({ records: [], safetyAssertions: [{
      assertionId: "generic-handle-only", equals: { channelHandle: "@urameshi_conta" }, expectedScopeCount: 1, minScopeCount: 1, expectedMutationCount: 0,
      knownTuplePresence: [knownTuple({ videoId: "valid-bare", occurrenceId: "valid-bare-occ", sourceId: "bare-source", sourceHash: "bare-source-hash", rawHash: "bare-raw-hash" })],
    }] }), "utf8");
    const handles = ["@urameshi_conta", "https://www.youtube.com/@urameshi_conta?tab=videos#latest", "https://youtube.com.evil/@urameshi_conta", "https://youtube.com/channel/UC8VlcljjGFb4-Ny2Heb0-ew", "urameshi@conta"];
    fs.writeFileSync(snapshot, handles.map((channelHandle, index) => JSON.stringify({
      videoId: index === 0 ? "valid-bare" : `invalid-url-${index}`, occurrenceId: index === 0 ? "valid-bare-occ" : `invalid-url-occ-${index}`,
      position: 0, seconds: 1, title: "protected", artist: "", sourceId: index === 0 ? "bare-source" : `source-${index}`,
      sourceHash: index === 0 ? "bare-source-hash" : `hash-${index}`, rawHash: index === 0 ? "bare-raw-hash" : `raw-${index}`, rangeId: "all", channelHandle,
    })).join("\n") + "\n", "utf8");
    const result = spawnSync(python, [script, "--rules-manifest", rules, "--snapshot", snapshot, "--output", output, "--manifest-output", manifest, "--review-output", review], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(review, "utf8")).results[0].scopeRowCount, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("merged P2 manifest stays observable until Mac supplies current-active evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-minimal-test-"));
  try {
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    const rules = JSON.parse(fs.readFileSync(minimalRulesManifest, "utf8"));
    assert.equal(rules.records.length, 128);
    const singletonRule = rules.records.find((item) => item.videoId === "lUDCE3zZmuQ" && item.seconds === 9463);
    const adoAlias = rules.artistScopedAliases.find((item) => item.artist === "Ado");
    assert.equal(singletonRule.action, "drop_entry");
    assert.equal(singletonRule.ruleId, "naraetan-lUDCE3zZmuQ-9463-translated-commentary");
    assert.equal(rules.artistScopedAliases.length, 12);
    assert.equal(adoAlias.expectedMatchCount, 14);
    assert.equal(rules.safetyAssertions.find((item) => item.assertionId === "exclude-urameshi-legacy-rules").auditedLegacyRuleCount, 27);

    const aliasVariants = rules.artistScopedAliases[0].aliases.filter((title) => title !== "逆光");
    const snapshotRows = [
      { kind: "video", videoId: "lUDCE3zZmuQ" },
      {
        videoId: "lUDCE3zZmuQ",
        occurrenceId: "f35b292b485512e0ee7bfcec",
        position: 24,
        seconds: 9463,
        title: "辛いことがある人生でも",
        artist: "Even in a life full of hardships",
        sourceId: "Ugxw2-DEUVx0aNsvVyR4AaABAg",
        sourceHash: "5a84ddcb0ff7c6f66409f9d5b93f1c0c258769dbe6ad300a6b27a1907a37c07f",
        rawHash: "66cb9e129f135600d5b881595110822a7e7bb01175eeb5d7d138763768188f1e",
        rangeId: "all",
        sourceSystem: "accepted",
      },
      ...Array.from({ length: 14 }, (_, index) => ({
        videoId: `ado-video-${index}`,
        occurrenceId: `occ-ado-${index}`,
        position: index,
        seconds: 100 + index,
        title: adoAlias.aliases[(index % (adoAlias.aliases.length - 1)) + 1],
        artist: "Ado",
        sourceId: `ado-source-${index}`,
        sourceHash: `ado-source-hash-${index}`,
        rawHash: `ado-raw-hash-${index}`,
        rangeId: "all",
        sourceSystem: "accepted",
      })),
      {
        videoId: "ado-canonical",
        occurrenceId: "occ-ado-canonical",
        position: 0,
        seconds: 1,
        title: "逆光",
        artist: "Ado",
      },
      {
        videoId: "protected-vaundy",
        occurrenceId: "occ-protected-vaundy",
        position: 0,
        seconds: 2,
        title: "逆光 - replica",
        artist: "Vaundy",
      },
      {
        videoId: "protected-flugel",
        occurrenceId: "occ-protected-flugel",
        position: 0,
        seconds: 3,
        title: "逆光のフリューゲル",
        artist: "ツヴァイウィング",
      },
      ...Array.from({ length: 27 }, (_, index) => ({
        videoId: `urameshi-video-${index}`,
        occurrenceId: `occ-urameshi-${index}`,
        position: index,
        seconds: 200 + index,
        title: `legacy commentary ${index}`,
        artist: "",
        channelHandle: "@urameshi_conta",
      })),
    ];
    const safetyAssertion = (assertionId) => rules.safetyAssertions.find(
      (item) => item.assertionId === assertionId,
    );
    const vaundyScope = safetyAssertion("protect-vaundy-gyakko-replica");
    const flugelScope = safetyAssertion("protect-gyakko-no-flugel");
    const lunaScope = safetyAssertion("protect-luna-8-32");
    const adoScope = safetyAssertion("protect-ado-gyakko-canonical");
    snapshotRows.push(
      ...Array.from({ length: 2 }, (_, index) => ({
        videoId: `protected-vaundy-extra-${index}`,
        occurrenceId: `occ-protected-vaundy-extra-${index}`,
        position: index,
        seconds: 300 + index,
        title: vaundyScope.equals.title,
        artist: vaundyScope.equals.artist,
      })),
      ...Array.from({ length: 122 }, (_, index) => ({
        videoId: `protected-flugel-extra-${index}`,
        occurrenceId: `occ-protected-flugel-extra-${index}`,
        position: index,
        seconds: 400 + index,
        title: `${flugelScope.startsWith.title} ${index}`,
        artist: "protected",
      })),
      ...Array.from({ length: 17 }, (_, index) => ({
        videoId: `protected-luna-${index}`,
        occurrenceId: `occ-protected-luna-${index}`,
        position: index,
        seconds: 600 + index,
        title: lunaScope.equals.title,
        artist: lunaScope.equals.artist,
      })),
      ...Array.from({ length: 400 }, (_, index) => ({
        videoId: `protected-ado-${index}`,
        occurrenceId: `occ-protected-ado-${index}`,
        position: index,
        seconds: 700 + index,
        title: adoScope.equals.title,
        artist: adoScope.equals.artist,
      })),
      ...Array.from({ length: 3892 }, (_, index) => ({
        videoId: `urameshi-extra-${index}`,
        occurrenceId: `occ-urameshi-extra-${index}`,
        position: index,
        seconds: 1200 + index,
        title: `legacy commentary extra ${index}`,
        artist: "",
        channelHandle: "/@urameshi_conta",
      })),
    );
    fs.writeFileSync(snapshot, snapshotRows.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

    const result = spawnSync(python, [
      script,
      "--rules-manifest", minimalRulesManifest,
      "--snapshot", snapshot,
      "--output", output,
      "--manifest-output", manifest,
      "--review-output", review,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    const rows = fs.readFileSync(output, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 15);
    assert.equal(rows.filter((row) => row.tombstone).length, 1);
    assert.equal(rows.filter((row) => !row.tombstone && row.payload.title === "逆光" && row.payload.artist === "Ado").length, 14);
    assert.equal(rows.some((row) => row.entityKey === "occ-protected-vaundy"), false);
    assert.equal(rows.some((row) => row.entityKey === "occ-protected-flugel"), false);
    assert.equal(rows.some((row) => row.payload.originalIdentity.channelHandle === "@urameshi_conta"), false);
    for (const row of rows) {
      assert.ok(row.payload.originalIdentity.occurrenceId);
      assert.ok(row.payload.curationReason);
      assert.ok(row.payload.curationProvenance.ruleId);
      assert.ok(Array.isArray(row.payload.curationProvenance.evidenceUrls));
    }

    const resultManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
    assert.equal(resultManifest.status, "ready");
    assert.equal(resultManifest.observedReviewStatus, "needs_review");
    assert.equal(resultManifest.curationMutationCount, 15);
    assert.equal(resultManifest.selectorMutationCount, 1);
    assert.equal(resultManifest.aliasMutationCount, 14);
    assert.equal(resultManifest.aliasSourceGroups.reduce((sum, group) => sum + group.count, 0), 14);
    assert.ok(resultManifest.aliasSourceGroups.every((group) => group.rangeId === "all" && /^[0-9a-f]{16}$/.test(group.originalSourceDetailKey) && /^[0-9a-f]{16}$/.test(group.replacementSourceDetailKey)));
    assert.equal(
      resultManifest.aliasSourceGroupsSha256,
      crypto.createHash("sha256").update(JSON.stringify(resultManifest.aliasSourceGroups.map((group) => Object.fromEntries(Object.entries(group).sort(([a], [b]) => a.localeCompare(b)))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))) + "\n").digest("hex"),
    );

    const resultReview = JSON.parse(fs.readFileSync(review, "utf8"));
    const naraetan = resultReview.results.find((item) => item.ruleId === "naraetan-lUDCE3zZmuQ-9463-translated-commentary");
    const ado = resultReview.results.find((item) => item.ruleId === "ado-gyakko-official-album-title");
    const vaundy = resultReview.results.find((item) => item.assertionId === "protect-vaundy-gyakko-replica");
    const flugel = resultReview.results.find((item) => item.assertionId === "protect-gyakko-no-flugel");
    const luna = resultReview.results.find((item) => item.assertionId === "protect-luna-8-32");
    const adoCanonical = resultReview.results.find((item) => item.assertionId === "protect-ado-gyakko-canonical");
    const urameshi = resultReview.results.find((item) => item.assertionId === "exclude-urameshi-legacy-rules");
    assert.equal(naraetan.matchCount, 1);
    assert.equal(ado.matchCount, 14);
    assert.equal(ado.selectedIdentities.length, 14);
    assert.deepEqual([...new Set(ado.selectedIdentities.map((item) => item.rangeId))], ["all"]);
    assert.deepEqual([vaundy.scopeRowCount, vaundy.mutationCount], [3, 0]);
    assert.deepEqual([flugel.scopeRowCount, flugel.mutationCount], [123, 0]);
    assert.deepEqual([luna.scopeRowCount, luna.mutationCount], [17, 0]);
    assert.deepEqual([adoCanonical.scopeRowCount, adoCanonical.mutationCount], [401, 0]);
    assert.deepEqual([urameshi.scopeRowCount, urameshi.mutationCount, urameshi.auditedLegacyRuleCount], [3919, 0, 27]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Mac binding materializes exact nonzero protected scopes and then converts the bound rules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-current-active-bind-"));
  try {
    const template = JSON.parse(fs.readFileSync(minimalRulesManifest, "utf8"));
    const snapshot = path.join(root, "snapshot.ndjson");
    const bound = path.join(root, "bound-rules.json");
    const evidence = path.join(root, "binding-evidence.json");
    let sequence = 0;
    const row = (title, artist, overrides = {}) => {
      const id = ++sequence;
      return {
        videoId: `video-${id}`, occurrenceId: `occurrence-${id}`, position: id,
        seconds: id, title, artist, sourceId: `source-${id}`,
        sourceHash: `source-hash-${id}`, rawHash: `raw-hash-${id}`, rangeId: "all",
        sourceSystem: "latest_json", channelHandle: "@other", ...overrides,
      };
    };
    const legacyProtected = (value) => ({
      ...value,
      sourceId: "",
      sourceHash: "",
      rawHash: "",
    });
    const naraetanRule = template.records.find((item) => item.videoId === "lUDCE3zZmuQ" && item.seconds === 9463);
    const aliasRule = template.artistScopedAliases.find((item) => item.artist === "Ado");
    const vaundyRows = Array.from({ length: 3 }, (_, index) => legacyProtected(
      row("逆光 - replica", "Vaundy", { seconds: 1000 + index }),
    ));
    const flugelRows = Array.from({ length: 123 }, (_, index) => legacyProtected(
      row(`逆光のフリューゲル ${index}`, "protected", { seconds: 2000 + index }),
    ));
    const adoProtectedRow = legacyProtected(
      row("逆光", "Ado", { channelHandle: "" }),
    );
    const urameshiProtectedRow = legacyProtected(
      row("Urameshi protected", "", { channelHandle: " /@URAMESHI_CONTA " }),
    );
    const rows = [
      row(naraetanRule.title, naraetanRule.artist, {
        videoId: naraetanRule.videoId, occurrenceId: naraetanRule.occurrenceId, seconds: naraetanRule.seconds,
        sourceId: naraetanRule.sourceId, sourceHash: naraetanRule.sourceHash,
        rawHash: naraetanRule.rawHash,
      }),
      ...vaundyRows,
      ...flugelRows,
      legacyProtected(row("8.32", "*Luna")),
      adoProtectedRow,
      urameshiProtectedRow,
      ...Array.from({ length: 14 }, (_, index) => row(aliasRule.aliases[1], "Ado", { seconds: 3000 + index })),
    ];
    fs.writeFileSync(snapshot, rows.map(JSON.stringify).join("\n") + "\n", "utf8");
    const binding = spawnSync(python, [
      script, "--rules-manifest", minimalRulesManifest, "--snapshot", snapshot,
      "--output", bound, "--bind-current-active-evidence",
      "--binding-evidence-output", evidence,
      "--active-revision-id", "accepted_30402041297_1",
    ], { encoding: "utf8" });
    assert.equal(binding.status, 0, binding.stderr);
    const boundRules = JSON.parse(fs.readFileSync(bound, "utf8"));
    assert.equal(boundRules.status, "ready");
    assert.equal(boundRules.expectedSelectorMutationCount, 1);
    assert.equal(boundRules.expectedAliasMutationCount, 14);
    const byId = new Map(boundRules.safetyAssertions.map((item) => [item.assertionId, item]));
    assert.equal(byId.get("protect-vaundy-gyakko-replica").expectedScopeCount, 3);
    assert.equal(byId.get("protect-gyakko-no-flugel").expectedScopeCount, 123);
    assert.equal(byId.get("protect-luna-8-32").expectedScopeCount, 1);
    assert.equal(byId.get("exclude-urameshi-legacy-rules").expectedScopeCount, 1);
    assert.equal(
      byId.get("exclude-urameshi-legacy-rules").knownTuplePresence.length,
      1,
    );
    assert.equal(
      Object.values(byId.get("protect-luna-8-32").knownTuplePresence[0]).includes(""),
      false,
    );
    assert.ok(
      byId.get("protect-vaundy-gyakko-replica").knownTuplePresence.every(
        (item) => ["sourceId", "sourceHash", "rawHash"].every(
          (field) => new RegExp(`^derived-protection-v1:${field}:[0-9a-f]{64}$`).test(item[field]),
        ),
      ),
    );
    assert.ok(
      ["sourceId", "sourceHash", "rawHash"].every(
        (field) => new RegExp(`^derived-protection-v1:${field}:[0-9a-f]{64}$`).test(
          byId.get("protect-ado-gyakko-canonical").knownTuplePresence[0][field],
        ),
      ),
    );
    assert.ok(
      ["sourceId", "sourceHash", "rawHash"].every(
        (field) => new RegExp(`^derived-protection-v1:${field}:[0-9a-f]{64}$`).test(
          byId.get("exclude-urameshi-legacy-rules").knownTuplePresence[0][field],
        ),
      ),
    );

    const converted = runFixture(root, "bound", boundRules, rows);
    assert.equal(converted.result.status, 0, converted.result.stderr);
    assert.equal(converted.manifest.selectorMutationCount, 1);
    assert.equal(converted.manifest.aliasMutationCount, 14);
    assert.equal(converted.manifest.curationMutationCount, 15);
    assert.doesNotMatch(converted.output, /derived-protection-v1/);

    const lineageDrifts = {
      videoId: "different-video",
      occurrenceId: "different-occurrence",
      position: 99999,
      seconds: 99999,
      title: "different title",
      artist: "different artist",
      sourceSystem: "different-source-system",
      rangeId: "7d",
      channelHandle: "@different",
    };
    for (const [field, value] of Object.entries(lineageDrifts)) {
      const driftedRows = rows.map((item) => (
        item.occurrenceId === vaundyRows[0].occurrenceId ? { ...item, [field]: value } : item
      ));
      const drifted = runFixture(root, `bound-drift-${field}`, boundRules, driftedRows);
      assert.equal(drifted.result.status, 0, `${field}: ${drifted.result.stderr}`);
      assert.equal(drifted.manifest.status, "ready", field);
      assert.equal(drifted.manifest.observedReviewStatus, "needs_review", field);
      if (drifted.output !== null) {
        assert.doesNotMatch(drifted.output, /derived-protection-v1/, field);
      }
    }

    const adoHandleDrift = runFixture(
      root,
      "bound-drift-ado-empty-channel-handle",
      boundRules,
      rows.map((item) => (
        item.occurrenceId === adoProtectedRow.occurrenceId
          ? { ...item, channelHandle: "@later-resolved-handle" }
          : item
      )),
    );
    assert.equal(adoHandleDrift.result.status, 0, adoHandleDrift.result.stderr);
    if (adoHandleDrift.output !== null) {
      assert.doesNotMatch(adoHandleDrift.output, /derived-protection-v1/);
    }

    const urameshiArtistDrift = runFixture(
      root,
      "bound-drift-urameshi-empty-artist",
      boundRules,
      rows.map((item) => (
        item.occurrenceId === urameshiProtectedRow.occurrenceId
          ? { ...item, artist: "later-resolved-artist" }
          : item
      )),
    );
    assert.equal(
      urameshiArtistDrift.result.status,
      0,
      urameshiArtistDrift.result.stderr,
    );
    if (urameshiArtistDrift.output !== null) {
      assert.doesNotMatch(urameshiArtistDrift.output, /derived-protection-v1/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("protection projection records partial real provenance without blocking output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-protection-partial-provenance-"));
  try {
    const expected = knownTuple({
      videoId: "legacy-video",
      occurrenceId: "legacy-occurrence",
      position: 4,
      seconds: 55,
    });
    const observed = runFixture(root, "partial", {
      records: [],
      safetyAssertions: [{
        assertionId: "partial-real-provenance",
        equals: { title: "Protected", artist: "Artist" },
        expectedScopeCount: 1,
        minScopeCount: 1,
        expectedMutationCount: 0,
        knownTuplePresence: [expected],
      }],
    }, [{
      videoId: "legacy-video",
      occurrenceId: "legacy-occurrence",
      position: 4,
      seconds: 55,
      title: "Protected",
      artist: "Artist",
      sourceId: "real-source-id",
      sourceHash: "",
      rawHash: "",
      sourceSystem: "latest_json",
      rangeId: "all",
      channelHandle: "@protected",
    }]);
    assert.equal(observed.result.status, 0, observed.result.stderr);
    assert.equal(observed.output, "");
    assert.equal(observed.manifest.status, "ready");
    assert.equal(observed.manifest.observedReviewStatus, "needs_review");
    assert.equal(
      observed.manifest.businessValidationObservations.some(
        (item) => item.code === "protection_tuple_projection",
      ),
      true,
    );

    for (const [name, provenance, expectedError, equals] of [
      ["invalid-type", { sourceId: 1, sourceHash: 2, rawHash: 3 }, /invalid string provenance/],
      ["whitespace", { sourceId: " ", sourceHash: " ", rawHash: " " }, /invalid string provenance/],
      ["wrong-source-system", { sourceId: "", sourceHash: "", rawHash: "", sourceSystem: "accepted" }, /unsupported derived lineage/],
      ["null-channel-handle", { channelHandle: null }, /incomplete derived lineage/],
      ["numeric-channel-handle", { channelHandle: 42 }, /incomplete derived lineage/],
      ["null-artist", { artist: null }, /incomplete derived lineage/, { title: "Protected" }],
      ["numeric-artist", { artist: 42 }, /incomplete derived lineage/, { title: "Protected" }],
    ]) {
      const failed = runFixture(root, name, {
        records: [],
        safetyAssertions: [{
          assertionId: name,
          equals: equals ?? { title: "Protected", artist: "Artist" },
          expectedScopeCount: 1,
          minScopeCount: 1,
          expectedMutationCount: 0,
          knownTuplePresence: [expected],
        }],
      }, [{
        videoId: "legacy-video",
        occurrenceId: "legacy-occurrence",
        position: 4,
        seconds: 55,
        title: "Protected",
        artist: "Artist",
        sourceId: "",
        sourceHash: "",
        rawHash: "",
        sourceSystem: "latest_json",
        rangeId: "all",
        channelHandle: "@protected",
        ...provenance,
      }]);
      assert.equal(failed.result.status, 0, `${name}: ${failed.result.stderr}`);
      assert.equal(failed.output, "", name);
      assert.equal(failed.manifest.status, "ready", name);
      assert.equal(failed.manifest.observedReviewStatus, "needs_review", name);
      assert.equal(
        failed.manifest.businessValidationObservations.some(
          (item) => item.code === "protection_tuple_projection" && expectedError.test(item.observed),
        ),
        true,
        name,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot identity schema stays fatal while derived protection drift is observed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-protection-core-lineage-"));
  try {
    const baseRow = {
      videoId: "legacy-video",
      occurrenceId: "legacy-occurrence",
      position: 4,
      seconds: 55,
      title: "Protected",
      artist: "Artist",
      sourceId: "",
      sourceHash: "",
      rawHash: "",
      sourceSystem: "latest_json",
      rangeId: "all",
      channelHandle: "",
    };
    const rules = {
      records: [],
      safetyAssertions: [{
        assertionId: "invalid-core-lineage",
        equals: { artist: "Artist" },
        expectedScopeCount: 1,
        minScopeCount: 1,
        expectedMutationCount: 0,
        knownTuplePresence: [knownTuple({
          videoId: baseRow.videoId,
          occurrenceId: baseRow.occurrenceId,
          position: baseRow.position,
          seconds: baseRow.seconds,
        })],
      }],
    };
    for (const field of ["videoId", "occurrenceId", "title", "sourceSystem", "rangeId"]) {
      for (const value of ["", null, 42]) {
        const name = `invalid-core-${field}-${value === null ? "null" : typeof value}`;
        const failed = runFixture(root, name, rules, [{ ...baseRow, [field]: value }]);
        if (["videoId", "occurrenceId"].includes(field)) {
          assert.notEqual(failed.result.status, 0, name);
          assert.match(
            failed.result.stderr,
            field === "videoId"
              ? /invalid videoId/
              : /invalid occurrenceId/,
            name,
          );
        } else {
          assert.equal(failed.result.status, 0, `${name}: ${failed.result.stderr}`);
          assert.equal(failed.manifest.status, "ready", name);
          assert.equal(failed.manifest.observedReviewStatus, "needs_review", name);
        }
      }
    }
    for (const field of ["position", "seconds"]) {
      for (const value of ["", null, "4", true, -1]) {
        const label = value === null ? "null" : `${typeof value}-${String(value)}`;
        const name = `invalid-core-${field}-${label}`;
        const failed = runFixture(root, name, rules, [{ ...baseRow, [field]: value }]);
        assert.equal(failed.result.status, 0, `${name}: ${failed.result.stderr}`);
        assert.equal(failed.manifest.status, "ready", name);
        assert.equal(failed.manifest.observedReviewStatus, "needs_review", name);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("drop-video and alias identity projection failures stay observable while mutations are preserved", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-projection-observation-"));
  try {
    const templatePath = path.join(root, "drop-video-template.json");
    const snapshotPath = path.join(root, "drop-video-snapshot.ndjson");
    const boundPath = path.join(root, "drop-video-bound.json");
    const evidencePath = path.join(root, "drop-video-evidence.json");
    const template = {
      status: "needs_current_active_evidence",
      ready: false,
      records: [{ ruleId: "drop-video-partial", action: "drop_video", videoId: "video-partial" }],
      artistScopedAliases: [],
      safetyAssertions: [],
    };
    const partialRows = [
      { kind: "video", videoId: "video-partial" },
      {
        videoId: "video-partial", occurrenceId: "partial-occ", position: 0, seconds: 1,
        title: "Noise", artist: "", sourceId: "real-source", sourceHash: "", rawHash: "",
        sourceSystem: "latest_json", rangeId: "all", channelHandle: "@source",
      },
    ];
    fs.writeFileSync(templatePath, JSON.stringify(template), "utf8");
    fs.writeFileSync(snapshotPath, partialRows.map(JSON.stringify).join("\n") + "\n", "utf8");
    const binding = spawnSync(python, [
      script, "--rules-manifest", templatePath, "--snapshot", snapshotPath,
      "--output", boundPath, "--bind-current-active-evidence",
      "--binding-evidence-output", evidencePath, "--active-revision-id", "accepted_projection_fixture",
    ], { encoding: "utf8" });
    assert.equal(binding.status, 0, binding.stderr);
    const bound = JSON.parse(fs.readFileSync(boundPath, "utf8"));
    assert.equal(bound.expectedVideoMutationCount, 1);
    assert.equal(bound.records[0].expectedVideoScopeCount, 0);
    assert.deepEqual(bound.records[0].expectedVideoScope, []);
    assert.equal(
      bound.bindingBusinessObservations.some((item) => item.code === "drop_video_scope_projection"),
      true,
    );

    const converted = runFixture(root, "drop-video-partial", bound, partialRows);
    assert.equal(converted.result.status, 0, converted.result.stderr);
    assert.equal(converted.manifest.videoMutationCount, 1);
    assert.equal(converted.manifest.status, "ready");
    assert.equal(converted.output.trim().split("\n").map(JSON.parse)[0].entityType, "videos");
    assert.equal(
      converted.manifest.businessValidationObservations.some(
        (item) => item.code === "drop_video_scope_projection",
      ),
      true,
    );

    const alias = runFixture(root, "alias-projection", {
      records: [],
      artistScopedAliases: [{
        ruleId: "alias-projection", artist: "Ado", canonicalTitle: "Canonical",
        aliases: ["Alias"], expectedMatchCount: 1,
      }],
      safetyAssertions: [],
    }, [{
      videoId: "alias-video", occurrenceId: "alias-occ", position: 0, seconds: 4,
      title: "Alias", artist: "Ado", sourceId: "source", sourceHash: "hash", rawHash: "raw",
      sourceSystem: "latest_json", rangeId: "weekly",
    }]);
    assert.equal(alias.result.status, 0, alias.result.stderr);
    assert.equal(alias.manifest.aliasMutationCount, 1);
    assert.equal(alias.output.trim().split("\n").map(JSON.parse).length, 1);
    assert.equal(
      alias.manifest.businessValidationObservations.some(
        (item) => item.code === "alias_selected_identity_projection" && item.status === "alias_identity_review_mismatch",
      ),
      true,
    );
    assert.equal(alias.review.results.some((item) => item.status === "alias_identity_review_mismatch"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remote-main alias ledger remains deterministic after scope-v4 integration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-alias-ledger-"));
  try {
    const rules = {
      records: [],
      artistScopedAliases: [{
        ruleId: "range-split", artist: "Artist", canonicalTitle: "new",
        aliases: ["old"], expectedMatchCount: 3,
      }],
    };
    const rows = [
      { videoId: "legacy", occurrenceId: "legacy-occ", position: 3, seconds: 3, title: "old", artist: "Artist", sourceId: "legacy-source" },
      { videoId: "all", occurrenceId: "all-occ", position: 2, seconds: 2, title: "old", artist: "Artist", sourceId: "all-source", rangeId: "all" },
      { videoId: "seven", occurrenceId: "seven-occ", position: 1, seconds: 1, title: "old", artist: "Artist", sourceId: "seven-source", rangeId: "7d" },
    ];
    const first = runFixture(root, "ledger-first", rules, rows);
    const second = runFixture(root, "ledger-second", rules, [...rows].reverse());
    assert.equal(first.result.status, 0, first.result.stderr);
    assert.equal(second.result.status, 0, second.result.stderr);
    assert.equal(first.manifest.aliasMutationCount, 3);
    assert.equal(first.manifest.aliasSourceReview.selectedIdentityCount, 4);
    assert.equal(
      first.manifest.aliasSourceGroups.reduce((sum, item) => sum + item.count, 0),
      4,
    );
    assert.deepEqual(second.manifest.aliasSourceReview, first.manifest.aliasSourceReview);
    assert.equal(second.manifest.aliasSourceGroupsSha256, first.manifest.aliasSourceGroupsSha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("Naraetan 9463 full product overlay emits exactly one drop", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-naraetan-luna-full-overlay-"));
  try {
    const formalRules = JSON.parse(fs.readFileSync(localMinimalRulesManifest, "utf8"));
    const snapshotRows = [
      { videoId: "lUDCE3zZmuQ", occurrenceId: "f35b292b485512e0ee7bfcec", position: 0, seconds: 9463, title: "辛いことがある人生でも", artist: "Even in a life full of hardships", sourceId: "", sourceHash: "", rawHash: "", rangeId: "all", sourceSystem: "latest_json" },
      { videoId: "lUDCE3zZmuQ", occurrenceId: "naraetan-5069", position: 1, seconds: 5069, title: "chat at 5069", artist: "Naraetan", sourceId: "", sourceHash: "", rawHash: "", rangeId: "all", sourceSystem: "latest_json" },
      { videoId: "lUDCE3zZmuQ", occurrenceId: "naraetan-9888", position: 2, seconds: 9888, title: "comment at 9888", artist: "Naraetan", sourceId: "", sourceHash: "", rawHash: "", rangeId: "all", sourceSystem: "latest_json" },
      { videoId: "aDoRevSong1", occurrenceId: "protected-ado", position: 0, seconds: 9463, title: "逆光", artist: "Ado", sourceId: "", sourceHash: "", rawHash: "", rangeId: "all", sourceSystem: "latest_json" },
      { videoId: "luna832song", occurrenceId: "protected-luna", position: 0, seconds: 9463, title: "8.32", artist: "*Luna", sourceId: "", sourceHash: "", rawHash: "", rangeId: "all", sourceSystem: "latest_json" },
      { videoId: "fluegel0011", occurrenceId: "protected-fluegel", position: 0, seconds: 9463, title: "逆光のフリューゲル", artist: "翼", sourceId: "", sourceHash: "", rawHash: "", rangeId: "all", sourceSystem: "latest_json" },
      { videoId: "vndyreplica", occurrenceId: "protected-vaundy", position: 0, seconds: 9463, title: "逆光 - replica", artist: "Vaundy", sourceId: "", sourceHash: "", rawHash: "", rangeId: "all", sourceSystem: "latest_json" },
    ];
    const observed = runFixture(root, "naraetan-full-overlay", formalRules, snapshotRows);
    assert.equal(observed.result.status, 0, observed.result.stderr);
    const rows = observed.output.trim() ? observed.output.trim().split("\n").map(JSON.parse) : [];
    assert.deepEqual(rows.map((row) => row.entityKey), ["f35b292b485512e0ee7bfcec"]);
    assert.equal(rows[0].tombstone, true);
    assert.equal(observed.manifest.curationMutationCount, 1);
    assert.equal(observed.manifest.selectorMutationCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
