const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const STATUS_PATH = path.join(DATA_DIR, "status.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

const previous = readJsonIfExists(LATEST_PATH);
const now = new Date().toISOString();
const itemCounts = itemCountsFromPayload(previous);
const retainedCapturedAt = previous?.capturedAt || previous?.generatedAt || "";
const retainedCompletedAt = previous?.completedAt || previous?.generatedAt || retainedCapturedAt;
const retainedDataVersion = previous?.dataVersion || previous?.source?.dataVersion || previous?.status?.dataVersion || "";
writeJson(STATUS_PATH, {
  status: "failed",
  mode: process.env.DAILY_SONG_UPDATE_MODE || process.env.DAILY_SONG_RUN_MODE || "",
  outcome: "failed",
  attemptedAt: now,
  failedAt: now,
  completedAt: retainedCompletedAt,
  capturedAt: retainedCapturedAt,
  dataCapturedAt: retainedCapturedAt,
  rebuiltDerivedAt: previous?.source?.rebuiltDerivedAt || "",
  dataVersion: retainedDataVersion,
  itemCounts,
  message: process.env.DAILY_SONG_FAILURE_MESSAGE || "Update workflow failed before writing a successful snapshot.",
  fallback: previous ? "kept previous validated data/latest.json" : "no previous data available",
  failureOutcome: process.env.DAILY_SONG_FAILURE_OUTCOME || "",
  failureStage: process.env.DAILY_SONG_FAILURE_STAGE || "core",
  retainedDataCapturedAt: retainedCapturedAt,
  retainedCompletedAt,
  retainedDataVersion,
  runId: process.env.GITHUB_RUN_ID || "",
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
  workflow: process.env.GITHUB_WORKFLOW || "",
  headSha: process.env.GITHUB_SHA || "",
  eventSchedule: process.env.DAILY_SONG_EVENT_SCHEDULE || process.env.GITHUB_EVENT_SCHEDULE || "",
  scheduledAt: process.env.DAILY_SONG_SCHEDULED_AT || "",
  runnerStartedAt: process.env.DAILY_SONG_RUNNER_STARTED_AT || "",
  queueDelaySeconds: finiteNumber(process.env.DAILY_SONG_QUEUE_DELAY_SECONDS),
  phaseDurations: {},
});

console.log(previous ? "[mark-failure] previous latest data kept." : "[mark-failure] no previous latest data exists.");

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

function itemCountsFromPayload(payload) {
  const source = payload?.groups || payload?.ranges || {};
  return {
    "7d": countRangeItems(source, "7d", "72h"),
    all: countRangeItems(source, "all", "1m"),
  };
}

function countRangeItems(source, primary, legacy) {
  const range = source?.[primary] || source?.[legacy] || {};
  return Array.isArray(range.items) ? range.items.length : 0;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
