import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
const script = path.resolve("scripts/migration/curation-overrides-to-patch.py");
const minimalRulesManifest = path.resolve("artifacts/migration/curation-global-singleton-minimal.json");

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
      { videoId: "video-1", occurrenceId: "occ-1", position: 0, seconds: 12, title: "chat", artist: "", sourceId: "", rangeId: "all", sourceSystem: "latest_json" },
      { videoId: "video-1", occurrenceId: "occ-2", position: 1, seconds: 24, title: "Old", artist: "Unknown", sourceId: "", rangeId: "all", sourceSystem: "latest_json" },
      { videoId: "video-1", occurrenceId: "occ-3", position: 2, seconds: 36, title: "Same", artist: "Old Artist", sourceId: "", rangeId: "all", sourceSystem: "latest_json" },
    ].map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
    const result = spawnSync(python, [script, "--overrides", overrides, "--snapshot", snapshot, "--output", output, "--manifest-output", manifest, "--review-output", review], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
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

test("curation converter blocks ambiguous or missing identity instead of guessing", () => {
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
    assert.equal(result.status, 78, result.stderr);
    const resultManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
    assert.equal(resultManifest.status, "needs_review");
    assert.equal(resultManifest.reviewAudit.ambiguous, 1);
    assert.equal(resultManifest.reviewAudit.already_applied_absent, 1);
    assert.equal(fs.readFileSync(output, "utf8"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exact selector rejects a different sourceHash even when seconds sourceId and rawHash match", () => {
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
    assert.equal(result.status, 78, result.stderr);
    assert.equal(fs.readFileSync(output, "utf8"), "");
    const resultManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const resultReview = JSON.parse(fs.readFileSync(review, "utf8"));
    assert.equal(resultManifest.status, "needs_review");
    assert.equal(resultManifest.reviewAudit.count_mismatch, 1);
    assert.equal(resultReview.results[0].matchCount, 0);
    assert.equal(resultReview.results[0].expectedMatchCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("minimal singleton manifest emits exactly Naraetan 1 plus Ado 10 and protects excluded scopes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-minimal-test-"));
  try {
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    const rules = JSON.parse(fs.readFileSync(minimalRulesManifest, "utf8"));
    assert.equal(rules.records.length, 1);
    assert.equal(rules.records[0].expectedMatchCount, 1);
    assert.equal(rules.artistScopedAliases.length, 1);
    assert.equal(rules.artistScopedAliases[0].expectedMatchCount, 10);
    assert.equal(rules.safetyAssertions.find((item) => item.assertionId === "exclude-urameshi-legacy-rules").auditedLegacyRuleCount, 27);

    const aliasVariants = rules.artistScopedAliases[0].aliases.filter((title) => title !== "逆光");
    const snapshotRows = [
      { kind: "video", videoId: "lUDCE3zZmuQ" },
      {
        videoId: "lUDCE3zZmuQ",
        occurrenceId: "occ-naraetan-9463",
        position: 24,
        seconds: 9463,
        title: "Even in a life full of hardships...",
        artist: "",
        sourceId: "Ugxw2-DEUVx0aNsvVyR4AaABAg",
        sourceHash: "5a84ddcb0ff7c6f66409f9d5b93f1c0c258769dbe6ad300a6b27a1907a37c07f",
        rawHash: "66cb9e129f135600d5b881595110822a7e7bb01175eeb5d7d138763768188f1e",
        rangeId: "all",
        sourceSystem: "accepted",
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        videoId: `ado-video-${index}`,
        occurrenceId: `occ-ado-${index}`,
        position: index,
        seconds: 100 + index,
        title: aliasVariants[index % aliasVariants.length],
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
    assert.equal(rows.length, 11);
    assert.equal(rows.filter((row) => row.tombstone).length, 1);
    assert.equal(rows.filter((row) => !row.tombstone && row.payload.title === "逆光" && row.payload.artist === "Ado").length, 10);
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
    assert.equal(resultManifest.curationMutationCount, 11);
    assert.equal(resultManifest.selectorMutationCount, 1);
    assert.equal(resultManifest.aliasMutationCount, 10);

    const resultReview = JSON.parse(fs.readFileSync(review, "utf8"));
    const naraetan = resultReview.results.find((item) => item.ruleId === "naraetan-lUDCE3zZmuQ-9463-translated-commentary");
    const ado = resultReview.results.find((item) => item.ruleId === "ado-gyakko-official-album-title");
    const vaundy = resultReview.results.find((item) => item.assertionId === "protect-vaundy-gyakko-replica");
    const flugel = resultReview.results.find((item) => item.assertionId === "protect-gyakko-no-flugel");
    const urameshi = resultReview.results.find((item) => item.assertionId === "exclude-urameshi-legacy-rules");
    assert.equal(naraetan.matchCount, 1);
    assert.equal(ado.matchCount, 10);
    assert.deepEqual([vaundy.scopeRowCount, vaundy.mutationCount], [1, 0]);
    assert.deepEqual([flugel.scopeRowCount, flugel.mutationCount], [1, 0]);
    assert.deepEqual([urameshi.scopeRowCount, urameshi.mutationCount, urameshi.auditedLegacyRuleCount], [27, 0, 27]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
