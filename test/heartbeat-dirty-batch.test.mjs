import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, "scripts/static/heartbeat-dirty-batch.js");
const rebuildScriptPath = path.join(repoRoot, "scripts/static/rebuild-only.js");
const workflowPath = path.join(repoRoot, ".github/workflows/heartbeat-dirty-data.yml");
const checkCodePath = path.join(repoRoot, ".github/workflows/check-code.yml");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-heartbeat-"));
  writeJson(path.join(root, "data/review/sources/current-clean.json"), {
    video: { videoId: "AAAAAAAAAAA", title: "current" },
    source: { sourceId: "selected:AAAAAAAAAAA:current", sourceHash: "hash-current" },
    entries: [
      {
        seconds: 10,
        rawHash: "raw-confirmed",
        classification: "confirmed_noise",
        suggestedAction: "drop_entry",
        replacementSuggestion: null,
      },
      {
        seconds: 20,
        rawHash: "raw-parser",
        classification: "parser_corruption",
        suggestedAction: "replace_entry",
        replacementSuggestion: { artist: "Fixed Artist" },
      },
      {
        seconds: 30,
        rawHash: "raw-invalid-parser",
        classification: "parser_corruption",
        suggestedAction: "replace_entry",
        replacementSuggestion: null,
      },
      {
        seconds: 40,
        rawHash: "raw-song",
        classification: "likely_song",
        suggestedAction: "keep",
        replacementSuggestion: null,
      },
    ],
  });
  writeJson(path.join(root, "data/review/sources/history-clean.json"), {
    video: { videoId: "BBBBBBBBBBB", title: "history" },
    source: { sourceId: "selected:BBBBBBBBBBB:history", sourceHash: "hash-history" },
    entries: [
      {
        seconds: 11,
        rawHash: "raw-history-confirmed",
        classification: "confirmed_noise",
        suggestedAction: "drop_entry",
        replacementSuggestion: null,
      },
      {
        seconds: 21,
        rawHash: "raw-history-parser",
        classification: "parser_corruption",
        suggestedAction: "replace_entry",
        replacementSuggestion: { title: "Fixed Title" },
      },
    ],
  });
  writeJson(path.join(root, "config/curation-overrides.json"), {
    schemaVersion: 1,
    records: [
      {
        action: "drop_entry",
        videoId: "AAAAAAAAAAA",
        occurrenceId: "",
        sourceId: "selected:AAAAAAAAAAA:current",
        sourceHash: "hash-current",
        seconds: 10,
        rawHash: "raw-confirmed",
        reason: "existing",
      },
    ],
  });
  fs.mkdirSync(path.join(root, "data/static/v1/days"), { recursive: true });
  fs.writeFileSync(path.join(root, "data/static/v1/days/sentinel.json"), "immutable\n");
  return root;
}

function runBatch(root, args) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      STATIC_REVIEW_ROOT: path.join(root, "data/review"),
      STATIC_CURATION_OVERRIDES_PATH: path.join(root, "config/curation-overrides.json"),
      STATIC_HEARTBEAT_STATE_PATH: path.join(root, "data/review/heartbeat-state.json"),
      STATIC_HEARTBEAT_PATCH_PATH: path.join(root, "data/review/heartbeat-patch.json"),
    },
  });
}

test("heartbeat batch is bounded, cross-scope, type-aware, and skips existing selectors", () => {
  const root = fixtureRoot();
  const output = runBatch(root, [
    "--max-records", "3",
    "--scope", "all",
    "--types", "confirmed_noise,parser_corruption",
    "--now", "2026-10-05T00:00:00.000Z",
  ]);
  assert.match(output, /selected=/);

  const patch = JSON.parse(fs.readFileSync(path.join(root, "data/review/heartbeat-patch.json"), "utf8"));
  assert.equal(patch.records.length, 3, "hard cap is enforced");
  const scopes = new Set(patch.records.map((record) => record.videoId === "AAAAAAAAAAA" ? "current" : "history"));
  assert.deepEqual([...scopes].sort(), ["current", "history"], "the batch covers current and history");
  assert.ok(patch.records.some((record) => record.action === "drop_entry"));
  assert.ok(patch.records.some((record) => record.action === "replace_entry"));
  assert.ok(!patch.records.some((record) => record.rawHash === "raw-confirmed"), "existing selector is skipped");
  assert.ok(!patch.records.some((record) => record.rawHash === "raw-invalid-parser"), "incomplete replacement is skipped");
  assert.equal(fs.readFileSync(path.join(root, "data/static/v1/days/sentinel.json"), "utf8"), "immutable\n");

  const summary = JSON.parse(fs.readFileSync(path.join(root, "data/review/heartbeat-summary.json"), "utf8"));
  assert.equal(summary.rawHistoryTouched, false);
  assert.equal(summary.selectedCounts["current:parser_corruption"], 1);
  assert.equal(summary.selectedCounts["history:confirmed_noise"], 1);
  assert.equal(summary.selectedCounts["history:parser_corruption"], 1);
});

test("heartbeat batch rejects unsafe scope and type input", () => {
  const root = fixtureRoot();
  assert.throws(() => runBatch(root, ["--scope", "maybe"]), /--scope/u);
  assert.throws(() => runBatch(root, ["--types", "likely_noise"]), /--types/u);
  assert.throws(() => runBatch(root, ["--max-records", "51"]), /--max-records/u);
});

test("heartbeat workflow and check-code gate expose the bounded publication contract", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /default: "25"/u);
  assert.match(workflow, /timeout-minutes: 35/u);
  assert.match(workflow, /Require a green Check code gate/u);
  assert.match(workflow, /Wait for the shared data publishers/u);
  assert.match(workflow, /group: daily-song-list-dirty-heartbeat/u);
  assert.match(workflow, /check-code\.yml/u);
  assert.match(workflow, /static:validate/u);
  assert.match(workflow, /rebuild-only\.js/u);
  assert.match(workflow, /HEARTBEAT_RAW_HISTORY_CHANGED/u);
  assert.match(workflow, /HEARTBEAT_STAGED_RAW_HISTORY/u);
  assert.match(workflow, /deploy-pages\.yml/u);
  assert.doesNotMatch(workflow, /self-hosted|PostgreSQL|WDC|ssh |\bjp\b/iu);

  const checkCode = fs.readFileSync(checkCodePath, "utf8");
  assert.match(checkCode, /heartbeat-dirty-data\.yml/u);
  assert.match(checkCode, /heartbeat-dirty-batch\.js/u);
  assert.match(checkCode, /rebuild-only\.js/u);
  assert.match(checkCode, /heartbeat-dirty-batch\.test\.mjs/u);
  assert.match(checkCode, /dirty-heartbeat\.trigger/u);
});

test("static rebuild-only preserves raw day shards and collector state", (t) => {
  if (!fs.existsSync(path.join(repoRoot, "scripts/static/collect-and-build.js"))) {
    t.skip("full static pipeline is only present in the GitHub sparse checkout");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-rebuild-only-"));
  const dataRoot = path.join(root, "data/static/v1");
  const dayPath = path.join(dataRoot, "days/2026-01-01.json");
  const statePath = path.join(dataRoot, "state.json");
  writeJson(dayPath, {
    videos: [{
      videoId: "AAAAAAAAAAA",
      title: "Raw Stream",
      channelName: "Channel",
      channelId: "UC1234567890",
      publishedAt: "2026-01-01T00:00:00.000Z",
      songs: [{
        occurrenceId: "AAAAAAAAAAA:1:0",
        time: "0:01",
        seconds: 1,
        title: "Song",
        artist: "Artist",
        raw: "0:01 Song / Artist",
        rawHash: "raw-hash",
        sourceId: "source",
        sourceHash: "source-hash",
      }],
    }],
  });
  writeJson(statePath, {
    schemaVersion: 1,
    continuityStart: "2026-01-01T00:00:00.000Z",
    historyGaps: [],
    processedVideoIds: ["AAAAAAAAAAA"],
    queue: [],
    lastSourceSnapshotId: "snapshot",
  });
  const dayBefore = fs.readFileSync(dayPath, "utf8");
  const stateBefore = fs.readFileSync(statePath, "utf8");
  execFileSync(process.execPath, [rebuildScriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, STATIC_DATA_ROOT: dataRoot, STATIC_NOW: "2026-01-02T00:00:00.000Z" },
  });
  assert.equal(fs.readFileSync(dayPath, "utf8"), dayBefore, "raw day shard must remain byte-identical");
  assert.equal(fs.readFileSync(statePath, "utf8"), stateBefore, "collector state must remain byte-identical");
  const meta = JSON.parse(fs.readFileSync(path.join(dataRoot, "meta.json"), "utf8"));
  assert.equal(meta.videoCount, 1);
  assert.equal(meta.songOccurrenceCount, 1);
});
