const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const STATUS_PATH = path.join(DATA_DIR, "status.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

const previous = readJsonIfExists(LATEST_PATH);
const now = new Date().toISOString();
writeJson(STATUS_PATH, {
  status: "failed",
  attemptedAt: now,
  completedAt: now,
  failedAt: now,
  capturedAt: previous?.capturedAt || previous?.generatedAt || "",
  dataCapturedAt: previous?.capturedAt || previous?.generatedAt || "",
  rebuiltDerivedAt: previous?.source?.rebuiltDerivedAt || "",
  message: process.env.DAILY_SONG_FAILURE_MESSAGE || "Update workflow failed before writing a successful snapshot.",
  fallback: previous ? "kept previous data/latest.json" : "no previous data available",
  runId: process.env.GITHUB_RUN_ID || "",
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
  workflow: process.env.GITHUB_WORKFLOW || "",
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
