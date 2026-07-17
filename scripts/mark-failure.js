const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const STATUS_PATH = path.join(DATA_DIR, "status.json");
const RUNTIME_META_PATH = path.join(DATA_DIR, "ui", "meta.json");

if (require.main === module) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const previous = readJsonIfExists(LATEST_PATH);
  const previousStatus = readJsonIfExists(STATUS_PATH);
  const runtimeMeta = readJsonIfExists(RUNTIME_META_PATH);
  const status = buildFailureStatus({
    previous,
    previousStatus,
    runtimeMeta,
    env: process.env,
    now: new Date(),
  });
  writeJson(STATUS_PATH, status);

  console.log(previous ? "[mark-failure] previous latest data kept." : "[mark-failure] no previous latest data exists.");
}

function buildFailureStatus({ previous = null, previousStatus = null, runtimeMeta = null, env = process.env, now = new Date() } = {}) {
  const attemptedAt = now.toISOString();
  const retainedCapturedAt =
    previous?.capturedAt || previous?.dataCapturedAt || runtimeMeta?.dataCapturedAt || runtimeMeta?.capturedAt || previousStatus?.dataCapturedAt || "";
  const retainedCompletedAt = previous?.completedAt || previous?.generatedAt || previousStatus?.completedAt || retainedCapturedAt;
  const retainedDataVersion = previous?.dataVersion || previous?.source?.dataVersion || previous?.status?.dataVersion || runtimeMeta?.dataVersion || "";
  const lastSuccessfulStatus = lastSuccessStatus(previousStatus, runtimeMeta);
  const failureMessage = env.DAILY_SONG_FAILURE_MESSAGE || "Update workflow failed before writing a successful snapshot.";
  return {
    status: "failed",
    mode: env.DAILY_SONG_UPDATE_MODE || env.DAILY_SONG_RUN_MODE || "",
    outcome: "failed",
    attemptedAt,
    failedAt: attemptedAt,
    completedAt: retainedCompletedAt,
    capturedAt: retainedCapturedAt,
    dataCapturedAt: retainedCapturedAt,
    rebuiltDerivedAt: previous?.source?.rebuiltDerivedAt || runtimeMeta?.rebuiltDerivedAt || "",
    dataVersion: retainedDataVersion,
    itemCounts: itemCountsFromPayload(previous, runtimeMeta),
    message: failureMessage,
    failureMessage,
    fallback: previous ? "kept previous validated data/latest.json" : "no previous data available",
    failureOutcome: env.DAILY_SONG_FAILURE_OUTCOME || "",
    failureStage: env.DAILY_SONG_FAILURE_STAGE || "core",
    retainedDataCapturedAt: retainedCapturedAt,
    retainedCompletedAt,
    retainedDataVersion,
    lastSuccessfulStatus,
    runtimeMeta: runtimeMeta
      ? {
          dataVersion: runtimeMeta.dataVersion || "",
          capturedAt: runtimeMeta.capturedAt || "",
          dataCapturedAt: runtimeMeta.dataCapturedAt || "",
          status: runtimeMeta.status?.status || "",
        }
      : null,
    runId: env.GITHUB_RUN_ID || "",
    runAttempt: env.GITHUB_RUN_ATTEMPT || "",
    workflow: env.GITHUB_WORKFLOW || "",
    headSha: env.GITHUB_SHA || "",
    eventSchedule: env.DAILY_SONG_EVENT_SCHEDULE || env.GITHUB_EVENT_SCHEDULE || "",
    scheduledAt: env.DAILY_SONG_SCHEDULED_AT || "",
    runnerStartedAt: env.DAILY_SONG_RUNNER_STARTED_AT || "",
    queueDelaySeconds: finiteNumber(env.DAILY_SONG_QUEUE_DELAY_SECONDS),
    phaseDurations: {},
  };
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function itemCountsFromPayload(payload, runtimeMeta = null) {
  const source = payload?.groups || payload?.ranges || {};
  return {
    "7d": countRangeItems(source, runtimeMeta, "7d"),
    all: countRangeItems(source, runtimeMeta, "all"),
  };
}

function countRangeItems(source, runtimeMeta, rangeId) {
  const range = source?.[rangeId] || {};
  if (Array.isArray(range.items)) return range.items.length;
  if (Number.isFinite(Number(range.itemCount))) return Number(range.itemCount);
  const metaCount = runtimeMeta?.ranges?.[rangeId]?.itemCount;
  return Number.isFinite(metaCount) ? metaCount : 0;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function lastSuccessStatus(previousStatus, runtimeMeta) {
  const candidate = previousStatus?.status === "success" ? previousStatus : runtimeMeta?.status?.status === "success" ? runtimeMeta.status : null;
  if (!candidate) return null;
  return {
    status: "success",
    completedAt: candidate.completedAt || runtimeMeta?.capturedAt || "",
    capturedAt: candidate.capturedAt || runtimeMeta?.capturedAt || "",
    dataCapturedAt: candidate.dataCapturedAt || runtimeMeta?.dataCapturedAt || runtimeMeta?.capturedAt || "",
    dataVersion: candidate.dataVersion || runtimeMeta?.dataVersion || "",
    itemCounts: candidate.itemCounts || itemCountsFromPayload(null, runtimeMeta),
  };
}

module.exports = {
  buildFailureStatus,
  itemCountsFromPayload,
};
