import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/migration/7d-stream-protocol.py");

function runPython(args, input = "") {
  const candidates = [process.env.PYTHON, "python3", "python"].filter(Boolean);
  let last;
  for (const executable of candidates) {
    const result = spawnSync(executable, [script, ...args], {
      encoding: "utf8",
      input,
    });
    if (result.error?.code === "ENOENT" || result.status === 9009) {
      last = result;
      continue;
    }
    return result;
  }
  return last;
}

test("7D partition is deterministic and preserves compact dated candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daily-song-list-7d-protocol-"));
  try {
    const manifest = path.join(root, "candidate-manifest.json");
    const output = path.join(root, "shards");
    fs.writeFileSync(manifest, JSON.stringify({ candidates: [
      { videoId: "video-a", videoUrl: "https://youtu.be/video-a", publishedText: "今天", publishedAt: "2026-07-27T00:00:00+09:00", timezone: "Asia/Tokyo", evidenceStatus: "candidate" },
      { videoId: "video-b", videoUrl: "https://youtu.be/video-b", publishedText: "昨日", publishedAt: "2026-07-26T00:00:00+09:00", timezone: "Asia/Tokyo", evidenceStatus: "candidate" },
      { videoId: "video-c", videoUrl: "https://youtu.be/video-c", publishedText: "3日前", publishedAt: "2026-07-24T00:00:00+09:00", timezone: "Asia/Tokyo", evidenceStatus: "candidate" },
    ] }, null, 2));
    const result = runPython(["partition", "--manifest", manifest, "--output-dir", output, "--worker-count", "3"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(output, "partition-manifest.json"), "utf8"));
    assert.equal(report.candidateCount, 3);
    assert.equal(report.mediaDownloaded, false);
    const rows = [];
    for (let index = 0; index < 3; index += 1) {
      const file = path.join(output, `candidate-shard-${String(index).padStart(2, "0")}.ndjson`);
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)) rows.push(JSON.parse(line));
      }
    }
    assert.deepEqual(rows.map((row) => row.videoId).sort(), ["video-a", "video-b", "video-c"]);
    assert.equal(rows.find((row) => row.videoId === "video-c").publishedAt, "2026-07-24T00:00:00+09:00");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("7D ingest fsyncs, preserves nullable/repeated occurrences, and is idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daily-song-list-7d-ingest-"));
  try {
    const candidate = path.join(root, "candidate.ndjson");
    const output = path.join(root, "accepted.ndjson");
    const checkpoint = path.join(root, "checkpoint.json");
    const report = path.join(root, "manifest.json");
    fs.writeFileSync(candidate, JSON.stringify({ videoId: "video-a", videoUrl: "https://youtu.be/video-a", publishedAt: "2026-07-27T00:00:00+09:00" }) + "\n");
    const detail = {
      videoId: "video-a",
      publishedAt: "2026-07-27T00:00:00+09:00",
      occurrences: [
        { occurrenceId: "o1", seconds: null, rawTimeText: "未知", sourceId: "source-1", sourceSystem: "youtube" },
        { occurrenceId: "o2", seconds: 42, rawTimeText: "0:42", sourceId: "source-1", sourceSystem: "youtube" },
        { occurrenceId: "o3", seconds: 42, rawTimeText: "0:42", sourceId: "source-1", sourceSystem: "youtube" },
      ],
    };
    const envelope = JSON.stringify({ schemaVersion: 1, runId: "run-1", shardId: 0, videoId: "video-a", detail }) + "\n";
    const first = runPython(["ingest", "--output", output, "--checkpoint", checkpoint, "--manifest-output", report, "--run-id", "run-1", "--shard-id", "0", "--candidate-shard", candidate], envelope);
    assert.equal(first.status, 0, first.stderr);
    const second = runPython(["ingest", "--output", output, "--checkpoint", checkpoint, "--manifest-output", report, "--run-id", "run-1", "--shard-id", "0", "--candidate-shard", candidate], envelope);
    assert.equal(second.status, 0, second.stderr);
    const result = JSON.parse(fs.readFileSync(report, "utf8"));
    assert.equal(result.receivedCount, 1);
    assert.equal(result.replayCount, 1);
    const accepted = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(accepted.detail.occurrences[0].seconds, null);
    assert.equal(accepted.detail.occurrences.filter((row) => row.seconds === 42).length, 2);
    assert.equal(accepted.mediaDownloaded, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
