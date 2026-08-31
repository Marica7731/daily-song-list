import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { HISTORY_GAP, buildStaticSite, hashId, initialState } = require("../scripts/static/collect-and-build.js");
const { computeHistoryGaps, gitBlobSha1, importLegacyDocument, migrateRecoveryState, snapshotCoverage, verifySourceBytes } = require("../scripts/static/recover-history.js");

test("static pipeline emits resumable 7d/30d/all shards and explicit gap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-static-"));
  const dataRoot = path.join(root, "data/static/v1");
  fs.mkdirSync(path.join(dataRoot, "days"), { recursive: true });
  const now = new Date("2026-09-01T00:00:00Z");
  const state = initialState(now);
  state.continuityStart = "2026-09-01T00:01:00Z";
  state.lastSourceSnapshotId = "fixture-1";
  state.lastSourceCapturedAt = now.toISOString();
  state.sourceCoverage = { status: "success", candidateVideos: 1 };
  state.processedVideoIds = ["abcdefghijk"];
  fs.writeFileSync(path.join(dataRoot, "state.json"), JSON.stringify(state));
  fs.writeFileSync(path.join(dataRoot, "days/2026-09-01.json"), JSON.stringify({
    schemaVersion: 1,
    day: "2026-09-01",
    videos: [{
      videoId: "abcdefghijk",
      title: "fixture stream",
      channelName: "Fixture VTuber",
      channelId: "UCfixture",
      publishedAt: "2026-09-01T00:00:00Z",
      thumbnailUrl: "https://example.invalid/a.jpg",
      watchUrl: "https://youtube.com/watch?v=abcdefghijk",
      keyword: "歌枠",
      keywords: ["歌枠"],
      songs: [
        { occurrenceId: "one", time: "00:10", seconds: 10, title: "Song A", artist: "Artist A" },
        { occurrenceId: "two", time: "00:20", seconds: 20, title: "Song A", artist: "Artist A" },
      ],
    }],
  }));

  const meta = buildStaticSite(dataRoot, state, now, { pageSize: 1, maxShardBytes: 100000 });
  assert.equal(meta.ranges["7d"].songs.totalCount, 1);
  assert.equal(meta.ranges["30d"].artists.totalCount, 1);
  assert.equal(meta.ranges.all.vtubers.totalCount, 1);
  assert.deepEqual(meta.historyGaps, [HISTORY_GAP]);
  const page = JSON.parse(fs.readFileSync(path.join(dataRoot, "rankings/7d/songs/page-0001.json")));
  assert.equal(page.items[0].occurrenceCount, 2);
  assert.equal(page.items[0].detailPath, `entities/songs/${hashId("songs\u001fsonga\u001fartista")}.json`);
  const detail = JSON.parse(fs.readFileSync(path.join(dataRoot, page.items[0].detailPath)));
  assert.equal(detail.occurrences.length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("static update workflow is GitHub-hosted, resumable, and commits only static data", () => {
  const workflow = fs.readFileSync(path.resolve(".github/workflows/static-update.yml"), "utf8");
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /cron: "23 \* \* \* \*"/);
  assert.match(workflow, /npm run static:update/);
  assert.match(workflow, /npm run static:validate/);
  assert.match(workflow, /git add -- data\/static\/v1/);
  assert.match(workflow, /\[\[ "\$path" == data\/static\/v1\/\* \]\]/);
  assert.doesNotMatch(workflow, /self-hosted|PostgreSQL|WDC|ssh /i);
});

test("legacy all is byte-bound, split into day shards, and restores all beyond 7d", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-legacy-"));
  const dataRoot = path.join(root, "data/static/v1");
  fs.mkdirSync(dataRoot, { recursive: true });
  const now = new Date("2026-09-01T00:00:00Z");
  const state = initialState(now);
  migrateRecoveryState(state);
  const legacy = {
    id: "all", retentionPolicy: "permanent", generatedAt: "2026-08-22T17:52:03.305Z",
    items: [{
      videoId: "abcdefghijk", title: "old stream", channelName: "Old VTuber", channelId: "",
      publishedTimestamp: Date.parse("2026-01-02T03:04:05Z"), sourceGroups: ["today"], selectedSourceId: "source",
      songs: [
        { occurrenceId: null, index: 1, time: "0:10", seconds: 10, title: "Old Song", artist: "Old Artist", raw: "old", rawHash: "raw-hash", sourceId: "source", sourceHash: "hash", needsReview: false },
        { occurrenceId: "empty", index: 2, time: "0:20", seconds: 20, title: "", artist: "未記載", raw: "", rawHash: "empty-hash", sourceId: "source", sourceHash: "hash", needsReview: false },
      ],
    }],
  };
  const source = { commit: "fixture", generatedAt: legacy.generatedAt };
  const summary = importLegacyDocument(dataRoot, state, legacy, source, now, 100000);
  assert.equal(summary.videoCount, 1);
  assert.equal(summary.occurrenceCount, 1);
  assert.equal(summary.derivedOccurrenceIds, 1);
  assert.equal(summary.rejectedEmptyTitles, 1);
  assert.equal(summary.missingChannelIds, 1);
  assert.equal(fs.readdirSync(path.join(dataRoot, "days/2026-01-02")).length, 1);
  const meta = buildStaticSite(dataRoot, state, now, { pageSize: 50, maxShardBytes: 100000 });
  assert.equal(meta.ranges["7d"].songs.totalCount, 0);
  assert.equal(meta.ranges.all.songs.totalCount, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("recovery source proof uses Git blob identity and missing days compact into ranges", () => {
  const bytes = Buffer.from("immutable fixture\n");
  const source = { bytes: bytes.length, gitBlobSha1: gitBlobSha1(bytes) };
  assert.equal(verifySourceBytes(bytes, source).gitBlobSha1, source.gitBlobSha1);
  const days = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`2026-08-${String(23 + index).padStart(2, "0")}`, "MISSING"]));
  days["2026-08-24"] = "COMPLETE";
  days["2026-08-25"] = "COMPLETE";
  assert.deepEqual(computeHistoryGaps(days), [
    { from: "2026-08-23", through: "2026-08-23", status: "MISSING" },
    { from: "2026-08-26", through: "2026-08-31", status: "MISSING" },
  ]);
});

test("truncated immutable discovery remains MISSING even after its records can be processed", () => {
  assert.deepEqual(snapshotCoverage({ groups: { today: { sources: [{ keyword: "歌枠", itemCount: 500, limit: 500, reachedBottom: false, truncatedByLimit: true }] } } }), {
    complete: false,
    status: "MISSING",
    sourceCount: 1,
    incomplete: [{ keyword: "歌枠", itemCount: 500, limit: 500, reachedBottom: false, truncatedByLimit: true }],
  });
  assert.equal(snapshotCoverage({ groups: { today: { sources: [{ keyword: "弾き語り", itemCount: 80, limit: 500, reachedBottom: true, truncatedByLimit: false }] } } }).status, "COMPLETE");
});

test("history recovery workflow is GitHub-hosted, bounded, resumable, and static-only", () => {
  const workflow = fs.readFileSync(path.resolve(".github/workflows/static-recover-history.yml"), "utf8");
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /timeout-minutes: 55/);
  assert.match(workflow, /npm run static:recover/);
  assert.match(workflow, /Resume an incomplete date checkpoint/);
  assert.match(workflow, /git add -- data\/static\/v1/);
  assert.doesNotMatch(workflow, /self-hosted|PostgreSQL|WDC|ssh /i);
});
