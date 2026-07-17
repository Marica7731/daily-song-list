const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  classifyFailureLog,
  countRuns,
  durationStats,
  enrichRun,
  successGapMinutes,
} = require("../scripts/analyze-update-health");
const {
  CORE_RESTORE_PATHS,
  backfillVideosFromBundle,
  dedupeBackfillVideos,
  evaluateCorePreflight,
} = require("../scripts/run-core-update");
const {
  backfillBundleFileName,
  buildBackfillBundle,
  writeBackfillInboxBundle,
} = require("../scripts/run-backfill-update");
const {
  evaluateWatchdog,
  findBlockingCoreRun,
  findPriorCompensationForStaleEvent,
  isSuccessfulOrActiveCompensationRun,
} = require("../scripts/watchdog-update");
const {
  buildFailureStatus,
  itemCountsFromPayload,
} = require("../scripts/mark-failure");
const { waitForPublishedRuntime } = require("../scripts/check-published-runtime");

const repoRoot = path.join(__dirname, "..");

test("analyzer counts fast success, failure, timeout, cancelled, queued, and runner queue delay", () => {
  const runs = [
    run({ databaseId: 1, conclusion: "success" }),
    run({ databaseId: 2, conclusion: "failure" }),
    run({ databaseId: 3, conclusion: "timed_out" }),
    run({ databaseId: 4, conclusion: "cancelled" }),
    run({ databaseId: 5, status: "queued", conclusion: "" }),
    run({ databaseId: 6, status: "in_progress", conclusion: "" }),
  ];
  const counts = countRuns(runs);

  assert.equal(counts.success, 1);
  assert.equal(counts.failure, 1);
  assert.equal(counts.timeout, 1);
  assert.equal(counts.cancelled, 1);
  assert.equal(counts.queued, 1);
  assert.equal(counts.inProgress, 1);

  const enriched = enrichRun(
    run({ databaseId: 7, createdAt: "2026-07-17T00:00:00Z", startedAt: "2026-07-17T00:00:00Z", updatedAt: "2026-07-17T00:20:00Z" }),
    [
      {
        started_at: "2026-07-17T00:03:00Z",
        completed_at: "2026-07-17T00:20:00Z",
        steps: [
          step("Update compact runtime data", "2026-07-17T00:04:00Z", "2026-07-17T00:10:00Z"),
          step("Commit core data", "2026-07-17T00:10:00Z", "2026-07-17T00:11:00Z"),
          step("Push core data", "2026-07-17T00:11:00Z", "2026-07-17T00:12:00Z"),
          step("Published runtime health check", "2026-07-17T00:12:00Z", "2026-07-17T00:18:00Z"),
        ],
      },
    ],
  );

  assert.equal(enriched.queueDelaySeconds, 180);
  assert.equal(enriched.coreDurationSeconds, 360);
  assert.equal(enriched.commitDurationSeconds, 60);
  assert.equal(enriched.pushDurationSeconds, 60);
  assert.equal(enriched.publishVerificationDurationSeconds, 360);
});

test("analyzer reports >2h success gaps and classifies push, rebase, timeout, and CDN failures", () => {
  const gaps = successGapMinutes([
    run({ databaseId: 10, conclusion: "success", updatedAt: "2026-07-17T00:10:00Z" }),
    run({ databaseId: 11, conclusion: "success", updatedAt: "2026-07-17T03:00:00Z" }),
  ]);
  assert.equal(gaps[0].minutes, 170);
  assert.equal(classifyFailureLog("CONFLICT (content): Merge conflict in data/latest.json\nCould not apply abc"), "git_rebase_conflict");
  assert.equal(classifyFailureLog("Updates were rejected because the remote contains work"), "push_conflict");
  assert.equal(classifyFailureLog("The operation was canceled because it timed out"), "timeout");
  assert.equal(classifyFailureLog("published dataVersion old must match expected new"), "published_runtime_mismatch");
  assert.deepEqual(durationStats([60, 120, 180]).p95, 180);
});

test("watchdog triggers stale data, skips fresh data, skips active fast, and dedupes one stale event", () => {
  const now = new Date("2026-07-17T02:00:00Z");
  const fresh = evaluateWatchdog({
    meta: { dataCapturedAt: "2026-07-17T01:00:00Z" },
    coreRuns: [],
    now,
    staleMinutes: 75,
  });
  assert.equal(fresh.shouldDispatch, false);
  assert.equal(fresh.triggerReason, "fresh_data");

  const activeRun = { databaseId: 20, status: "in_progress", conclusion: "", event: "schedule", createdAt: "2026-07-17T01:50:00Z" };
  assert.equal(findBlockingCoreRun([activeRun]).databaseId, 20);
  const active = evaluateWatchdog({
    meta: { dataCapturedAt: "2026-07-16T23:00:00Z" },
    coreRuns: [activeRun],
    now,
    staleMinutes: 75,
  });
  assert.equal(active.shouldDispatch, false);
  assert.equal(active.triggerReason, "active_core_run");

  const stale = evaluateWatchdog({
    meta: { dataCapturedAt: "2026-07-16T23:00:00Z" },
    coreRuns: [run({ databaseId: 21, conclusion: "failure", event: "schedule", createdAt: "2026-07-17T01:00:00Z" })],
    now,
    staleMinutes: 75,
  });
  assert.equal(stale.shouldDispatch, true);
  assert.equal(stale.triggerReason, "stale_data");

  const priorDispatch = run({ databaseId: 22, conclusion: "failure", event: "workflow_dispatch", createdAt: "2026-07-17T01:10:00Z" });
  assert.equal(findPriorCompensationForStaleEvent([priorDispatch], "2026-07-16T23:00:00Z", now), null);
  assert.equal(isSuccessfulOrActiveCompensationRun(priorDispatch), false);
  const duplicateDispatch = run({ databaseId: 23, conclusion: "success", event: "workflow_dispatch", createdAt: "2026-07-17T01:20:00Z" });
  assert.equal(findPriorCompensationForStaleEvent([priorDispatch, duplicateDispatch], "2026-07-16T23:00:00Z", now).databaseId, 23);
  assert.equal(isSuccessfulOrActiveCompensationRun(run({ databaseId: 24, status: "in_progress", conclusion: "", event: "workflow_dispatch" })), true);
  const duplicate = evaluateWatchdog({
    meta: { dataCapturedAt: "2026-07-16T23:00:00Z" },
    coreRuns: [priorDispatch, duplicateDispatch],
    now,
    staleMinutes: 75,
  });
  assert.equal(duplicate.shouldDispatch, false);
  assert.equal(duplicate.triggerReason, "duplicate_stale_event");
});

test("core preflight skips duplicate watchdog or compensation runs only when data is fresh", () => {
  const nowMs = Date.parse("2026-07-17T02:00:00Z");
  const freshWatchdog = evaluateCorePreflight({
    dispatchReason: "watchdog",
    capturedAt: "2026-07-17T01:15:00Z",
    nowMs,
  });
  assert.equal(freshWatchdog.skip, true);
  assert.equal(freshWatchdog.reason, "fresh_data");

  const staleCompensation = evaluateCorePreflight({
    eventName: "schedule",
    eventSchedule: "37 * * * *",
    capturedAt: "2026-07-16T23:00:00Z",
    nowMs,
  });
  assert.equal(staleCompensation.skip, false);
  assert.equal(staleCompensation.reason, "stale_data");
});

test("backfill bundle is immutable per run attempt and fast consumption dedupes by videoId", () => {
  const bundle = buildBackfillBundle({
    latest: { capturedAt: "2026-07-17T00:00:00Z", dataVersion: "a".repeat(64) },
    env: {
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "2",
      DAILY_SONG_MONTH_BACKFILL_TARGET: "3000",
      DAILY_SONG_MYGIT_TODAY_SNAPSHOT_DAYS: "7",
    },
    now: new Date("2026-07-17T01:00:00Z"),
  });
  assert.equal(bundle.baseCapturedAt, "2026-07-17T00:00:00Z");
  assert.equal(backfillBundleFileName(bundle), "12345-attempt-2.json");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-song-backfill-"));
  const written = writeBackfillInboxBundle(bundle, { outDir: tempDir });
  assert.equal(fs.existsSync(written), true);

  const videos = backfillVideosFromBundle({
    kind: "daily-song-list-backfill-inbox",
    catalogVideos: [
      video("VIDEOID0001", 1),
      video("VIDEOID0001", 2),
      { videoId: "bad", songs: [{ seconds: 1, title: "ignored" }] },
    ],
  });
  const deduped = dedupeBackfillVideos(videos);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].songs.length, 2);
});

test("failure status uses 7d/all, runtime meta, and previous success without legacy 72h/1m fallback", () => {
  assert.deepEqual(
    itemCountsFromPayload({
      groups: {
        "7d": { items: [{ videoId: "A" }] },
        all: { items: [{ videoId: "B" }, { videoId: "C" }] },
        "72h": { items: [{ videoId: "legacy" }] },
      },
    }),
    { "7d": 1, all: 2 },
  );
  assert.deepEqual(itemCountsFromPayload({ groups: { "72h": { items: [{ videoId: "legacy" }] }, "1m": { items: [{ videoId: "legacy" }] } } }), {
    "7d": 0,
    all: 0,
  });

  const status = buildFailureStatus({
    previous: { capturedAt: "2026-07-17T00:00:00Z", dataVersion: "b".repeat(64), groups: { "7d": { items: [{}] }, all: { items: [{}, {}] } } },
    previousStatus: { status: "success", completedAt: "2026-07-17T00:10:00Z", dataCapturedAt: "2026-07-17T00:00:00Z", dataVersion: "b".repeat(64) },
    runtimeMeta: { status: { status: "success" }, dataVersion: "b".repeat(64), dataCapturedAt: "2026-07-17T00:00:00Z", ranges: { "7d": { itemCount: 1 }, all: { itemCount: 2 } } },
    env: {
      DAILY_SONG_UPDATE_MODE: "fast",
      DAILY_SONG_FAILURE_STAGE: "push",
      DAILY_SONG_FAILURE_MESSAGE: "push failed",
      GITHUB_RUN_ID: "99",
      GITHUB_RUN_ATTEMPT: "3",
      GITHUB_SHA: "abc",
    },
    now: new Date("2026-07-17T01:00:00Z"),
  });
  assert.equal(status.mode, "fast");
  assert.equal(status.failureStage, "push");
  assert.equal(status.failureMessage, "push failed");
  assert.equal(status.retainedDataCapturedAt, "2026-07-17T00:00:00Z");
  assert.equal(status.runId, "99");
  assert.equal(status.runAttempt, "3");
  assert.equal(status.headSha, "abc");
  assert.deepEqual(status.itemCounts, { "7d": 1, all: 2 });
  assert.equal(status.lastSuccessfulStatus.status, "success");
});

test("published runtime wait helper retries through CDN delay", async () => {
  const attempts = [];
  const result = await waitForPublishedRuntime(
    async (attempt) => {
      attempts.push(attempt);
      if (attempt < 3) throw new Error("old dataVersion");
      return "matched";
    },
    { attempts: 4, delayMs: 1, sleep: async () => {} },
  );
  assert.equal(result, "matched");
  assert.deepEqual(attempts, [1, 2, 3]);
});

test("workflow static checks keep backfill isolated and failure restore non-destructive", () => {
  const core = readWorkflow("update-core.yml");
  const backfill = readWorkflow("update-backfill.yml");
  const watchdog = readWorkflow("update-watchdog.yml");

  assert.doesNotMatch(core, /git clean/u);
  assert.match(core, /node scripts\/run-core-update\.js restore-after-failure/u);
  assert.match(core, /steps\.regenerate\.outcome == 'failure'/u);
  assert.match(core, /DAILY_SONG_FAILURE_STAGE: \$\{\{ steps\.regenerate\.outcome == 'failure' && 'regenerate' \|\| 'core' \}\}/u);
  assert.match(core, /git add data\/status\.json/u);
  assert.match(core, /git reset --hard origin\/main/u);
  assert.match(core, /npm run check:published -- https:\/\/ytb-song-rank\.culua\.com\/ --expected-meta data\/ui\/meta\.json/u);
  assert.equal(CORE_RESTORE_PATHS.includes("data/backfill-inbox"), false);
  assert.equal(CORE_RESTORE_PATHS.includes("data/review"), false);
  assert.equal(CORE_RESTORE_PATHS.includes("config"), false);

  assert.match(backfill, /git add data\/backfill-inbox/u);
  assert.doesNotMatch(backfill, /git add data\/latest\.json|git add data\/ui|git add data\/video-catalog\.json/u);
  assert.match(backfill, /Push backfill bundle/u);

  assert.match(watchdog, /trigger_reason/u);
  assert.match(watchdog, /source_run_id/u);
  assert.match(watchdog, /dispatched_run_id/u);
});

function run(overrides = {}) {
  return {
    databaseId: overrides.databaseId || 1,
    status: overrides.status ?? "completed",
    conclusion: overrides.conclusion ?? "success",
    event: overrides.event || "schedule",
    createdAt: overrides.createdAt || "2026-07-17T00:00:00Z",
    startedAt: overrides.startedAt || overrides.createdAt || "2026-07-17T00:00:00Z",
    updatedAt: overrides.updatedAt || "2026-07-17T00:10:00Z",
  };
}

function step(name, startedAt, completedAt, conclusion = "success") {
  return { name, started_at: startedAt, completed_at: completedAt, conclusion };
}

function video(videoId, songCount) {
  return {
    videoId,
    title: `Video ${videoId}`,
    channelName: "Channel",
    songs: Array.from({ length: songCount }, (_, index) => ({ seconds: index + 1, title: `Song ${index + 1}` })),
  };
}

function readWorkflow(name) {
  return fs.readFileSync(path.join(repoRoot, ".github", "workflows", name), "utf8");
}
