const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data", "backfill-inbox");
const runId = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
const now = new Date().toISOString();

fs.mkdirSync(OUT_DIR, { recursive: true });

const latest = readJson(path.join(ROOT, "data", "latest.json")) || {};
const bundle = {
  schemaVersion: 1,
  kind: "daily-song-list-backfill-inbox",
  runId,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
  createdAt: now,
  mode: "backfill",
  baseCapturedAt: latest.capturedAt || latest.generatedAt || "",
  baseDataVersion: latest.dataVersion || latest.source?.dataVersion || "",
  status: "prepared",
  note: "Backfill runs write immutable inbox bundles only; fast updates merge accepted bundles before publishing runtime.",
  inputs: {
    monthBackfillTarget: process.env.DAILY_SONG_MONTH_BACKFILL_TARGET || "",
    mygitSnapshotDays: process.env.DAILY_SONG_MYGIT_TODAY_SNAPSHOT_DAYS || "",
  },
};

const filePath = path.join(OUT_DIR, `${runId}.json`);
fs.writeFileSync(filePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
console.log(`[backfill] wrote ${path.relative(ROOT, filePath)}`);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
