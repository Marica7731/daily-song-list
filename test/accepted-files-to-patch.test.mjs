import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const script = path.resolve("scripts/migration/accepted-files-to-patch.py");

test("accepted converter preserves 7d/null/duplicate-seconds/provenance fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "accepted-patch-test-"));
  try {
    const input = path.join(root, "accepted.json");
    const output = path.join(root, "candidate.ndjson");
    const manifest = path.join(root, "manifest.json");
    fs.writeFileSync(input, JSON.stringify({
      sourceSystem: "source-system",
      rangeId: "7d",
      sourceReachedEnd: true,
      mediaDownloaded: false,
      videos: [{
        videoId: "video-1",
        publishedTimestamp: 1780000000000,
        songs: [
          { occurrenceId: "occ-1", seconds: 12, title: "same", artist: "" , sourceId: "", rawHash: "raw-1" },
          { occurrenceId: "occ-2", seconds: 12, title: "same", artist: null, sourceId: null, rawHash: "raw-2" },
          { occurrenceId: "occ-3", seconds: null, title: "missing-time", artist: "artist", sourceId: "source-3", rawHash: "raw-3" },
        ],
      }],
    }),
    "utf8");
    const audit = path.join(root, "status-audit.json");
    fs.writeFileSync(audit, JSON.stringify({ summary: { ignored_no_timestamp: 1, pending_followup: 2, skipped_no_increment: 3 } }), "utf8");
    execFileSync(python, [
      script,
      "--input", input,
      "--output", output,
      "--manifest-output", manifest,
      "--range-id", "7d",
      "--source-key", "test-source",
      "--status-audit", audit,
      "--reviewed-at", "2026-07-28T12:34:56Z",
    ], { stdio: "pipe" });
    const record = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(record.rangeId, "7d");
    assert.equal(record.publishedAt, "2026-05-28T20:26:40+00:00");
    assert.equal(record.songs.length, 3);
    assert.equal(record.songs[0].seconds, 12);
    assert.equal(record.songs[1].seconds, 12);
    assert.equal(record.songs[2].seconds, null);
    assert.equal(record.songs[0].artist, "");
    assert.equal(record.songs[1].artist, null);
    assert.equal(record.songs[0].sourceId, "");
    assert.equal(record.songs[1].sourceId, null);
    assert.equal(record.songs[2].sourceId, "source-3");
    assert.equal(record.reviewedAt, "2026-07-28T12:34:56+00:00");
    assert.equal(record.songs[0].reviewedAt, "2026-07-28T12:34:56+00:00");
    const summary = JSON.parse(fs.readFileSync(manifest, "utf8"));
    assert.equal(summary.generatedAt, "2026-07-28T12:34:56+00:00");
    assert.equal(summary.rangeId, "7d");
    assert.equal(summary.sourceReachedEnd, true);
    assert.equal(summary.mediaDownloaded, false);
    assert.equal(summary.statusAuditIncluded, true);
    assert.equal(summary.reviewAudit.pending_followup, 2);
    assert.equal(summary.acceptedVideoCount, 1);
    assert.equal(summary.acceptedOccurrenceCount, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
