import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const python = process.env.PYTHON || "python3";
const script = path.resolve("scripts/migration/7d-status-audit.py");

test("7d status audit keeps recent missing timestamps pending on the initial pass", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "7d-status-audit-test-"));
  try {
    const details = path.join(root, "details.json");
    const output = path.join(root, "audit.json");
    const review = path.join(root, "review.ndjson");
    const acceptedDetails = path.join(root, "accepted-details.json");
    fs.writeFileSync(details, JSON.stringify([
      { videoId: "old-video", publishedAt: "2026-07-20T00:00:00Z", songs: [] },
      { videoId: "new-video", publishedAt: "2026-07-26T12:00:00Z", songs: [] },
      { videoId: "timestamp-video", publishedTimestamp: 1782475200000, songs: [{ seconds: 10, title: "song" }] },
    ]), "utf8");
    execFileSync(python, [
      script,
      "--details", details,
      "--output", output,
      "--review-queue", review,
      "--accepted-details-output", acceptedDetails,
      "--now", "2026-07-27T12:00:00Z",
    ], { stdio: "pipe" });
    const audit = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.deepEqual(audit.summary, { accepted_candidate: 1, ignored_no_timestamp: 1, pending_followup: 1, skipped_no_increment: 0 });
    const statuses = audit.records.map((record) => [record.videoId, record.status, record.terminalStatus]);
    assert.deepEqual(statuses, [
      ["old-video", "ignored_no_timestamp", "ignored_no_timestamp"],
      ["new-video", "pending_followup", null],
      ["timestamp-video", "accepted_candidate", null],
    ]);
    assert.match(fs.readFileSync(review, "utf8"), /ignored_no_timestamp/);
    assert.match(fs.readFileSync(review, "utf8"), /pending_followup/);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(acceptedDetails, "utf8")).map((detail) => detail.videoId),
      ["timestamp-video"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("7d status follow-up prioritizes skipped_no_increment for every still-missing timestamp", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "7d-status-followup-test-"));
  try {
    const details = path.join(root, "details.json");
    const output = path.join(root, "audit.json");
    const review = path.join(root, "review.ndjson");
    const acceptedDetails = path.join(root, "accepted-details.json");
    fs.writeFileSync(details, JSON.stringify([
      { videoId: "old-video", publishedAt: "2026-07-20T00:00:00Z", songs: [] },
      { videoId: "new-video", publishedAt: "2026-07-26T12:00:00Z", songs: [] },
      { videoId: "unknown-date-video", publishedAt: "not-a-date", songs: [] },
      { videoId: "timestamp-video", publishedAt: "2026-07-26T12:00:00Z", songs: [{ seconds: 10, title: "song" }] },
    ]), "utf8");
    execFileSync(python, [
      script,
      "--details", details,
      "--output", output,
      "--review-queue", review,
      "--accepted-details-output", acceptedDetails,
      "--now", "2026-07-27T12:00:00Z",
      "--followup",
    ], { stdio: "pipe" });
    const audit = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(audit.followup, true);
    assert.deepEqual(audit.summary, {
      accepted_candidate: 1,
      ignored_no_timestamp: 0,
      pending_followup: 0,
      skipped_no_increment: 3,
    });
    assert.deepEqual(
      audit.records.map((record) => [record.videoId, record.status, record.terminalStatus]),
      [
        ["old-video", "skipped_no_increment", "skipped_no_increment"],
        ["new-video", "skipped_no_increment", "skipped_no_increment"],
        ["unknown-date-video", "skipped_no_increment", "skipped_no_increment"],
        ["timestamp-video", "accepted_candidate", null],
      ],
    );
    const reviewRecords = fs.readFileSync(review, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(reviewRecords.length, 3);
    assert.equal(reviewRecords.every((record) => record.status === "skipped_no_increment"), true);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(acceptedDetails, "utf8")).map((detail) => detail.videoId),
      ["timestamp-video"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("7d accepted-details output fails closed on duplicate video lineage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "7d-status-lineage-test-"));
  try {
    const details = path.join(root, "details.json");
    const output = path.join(root, "audit.json");
    const review = path.join(root, "review.ndjson");
    const acceptedDetails = path.join(root, "accepted-details.json");
    fs.writeFileSync(details, JSON.stringify([
      { videoId: "duplicate-video", publishedAt: "2026-07-26T12:00:00Z", songs: [] },
      { videoId: "duplicate-video", publishedAt: "2026-07-26T12:00:00Z", songs: [{ seconds: 10, title: "song" }] },
    ]), "utf8");
    const result = spawnSync(python, [
      script,
      "--details", details,
      "--output", output,
      "--review-queue", review,
      "--accepted-details-output", acceptedDetails,
      "--now", "2026-07-27T12:00:00Z",
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /status audit repeats videoId=duplicate-video/);
    assert.equal(fs.existsSync(acceptedDetails), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
