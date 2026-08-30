import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { HISTORY_GAP, buildStaticSite, hashId, initialState } = require("../scripts/static/collect-and-build.js");

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
