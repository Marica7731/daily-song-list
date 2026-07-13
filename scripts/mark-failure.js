const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const STATUS_PATH = path.join(DATA_DIR, "status.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

const previous = readJsonIfExists(LATEST_PATH);
const now = new Date().toISOString();
const itemCounts = previous?.ranges
  ? {
      "72h": Array.isArray(previous.ranges["72h"]?.items) ? previous.ranges["72h"].items.length : 0,
      "1m": Array.isArray(previous.ranges["1m"]?.items) ? previous.ranges["1m"].items.length : 0,
    }
  : {};
const retainedCapturedAt = previous?.capturedAt || previous?.generatedAt || "";
const retainedCompletedAt = previous?.completedAt || previous?.generatedAt || retainedCapturedAt;
writeJson(STATUS_PATH, {
  status: "failed",
  attemptedAt: now,
  failedAt: now,
  completedAt: retainedCompletedAt,
  capturedAt: retainedCapturedAt,
  dataCapturedAt: retainedCapturedAt,
  rebuiltDerivedAt: previous?.source?.rebuiltDerivedAt || "",
  dataVersion: previous?.dataVersion || previous?.source?.dataVersion || "",
  itemCounts,
  message: process.env.DAILY_SONG_FAILURE_MESSAGE || "Update workflow failed before writing a successful snapshot.",
  fallback: previous ? "kept previous validated data/latest.json" : "no previous data available",
  failureOutcome: process.env.DAILY_SONG_FAILURE_OUTCOME || "",
  failureStage: process.env.DAILY_SONG_FAILURE_STAGE || "core",
  retainedDataCapturedAt: retainedCapturedAt,
  retainedCompletedAt,
  retainedDataVersion: previous?.dataVersion || previous?.source?.dataVersion || "",
  runId: process.env.GITHUB_RUN_ID || "",
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
  workflow: process.env.GITHUB_WORKFLOW || "",
  headSha: process.env.GITHUB_SHA || "",
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
