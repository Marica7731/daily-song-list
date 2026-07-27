import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const python = process.env.PYTHON || "python3";
const script = path.resolve("scripts/migration/7d-status-audit.py");

test("7d status audit emits ignored, pending and skipped states with evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "7d-status-audit-test-"));
  try {
    const details = path.join(root, "details.json");
    const output = path.join(root, "audit.json");
    const review = path.join(root, "review.ndjson");
    fs.writeFileSync(details, JSON.stringify([
      { videoId: "old-video", publishedAt: "2026-07-20T00:00:00Z", songs: [] },
      { videoId: "new-video", publishedAt: "2026-07-26T12:00:00Z", songs: [] },
      { videoId: "timestamp-video", publishedTimestamp: 1782475200000, songs: [{ seconds: 10, title: "song" }] },
    ]), "utf8");
    execFileSync(python, [script, "--details", details, "--output", output, "--review-queue", review, "--now", "2026-07-27T12:00:00Z"], { stdio: "pipe" });
    const audit = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.deepEqual(audit.summary, { accepted_candidate: 1, ignored_no_timestamp: 1, pending_followup: 1, skipped_no_increment: 0 });
    const statuses = audit.records.map((record) => [record.videoId, record.status]);
    assert.deepEqual(statuses, [["old-video", "ignored_no_timestamp"], ["new-video", "pending_followup"], ["timestamp-video", "accepted_candidate"]]);
    assert.match(fs.readFileSync(review, "utf8"), /ignored_no_timestamp/);
    assert.match(fs.readFileSync(review, "utf8"), /pending_followup/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
