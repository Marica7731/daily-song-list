import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const python = process.env.PYTHON || "python3";
const script = path.resolve("scripts/migration/curation-overrides-to-patch.py");

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
