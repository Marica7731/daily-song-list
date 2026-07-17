const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data", "backfill-inbox");

if (require.main === module) {
  const latest = readJson(path.join(ROOT, "data", "latest.json")) || {};
  const bundle = buildBackfillBundle({
    latest,
    env: process.env,
    now: new Date(),
  });
  const filePath = writeBackfillInboxBundle(bundle, { outDir: OUT_DIR });
  console.log(`[backfill] wrote ${path.relative(ROOT, filePath)}`);
}

function buildBackfillBundle({ latest = {}, env = process.env, now = new Date() } = {}) {
  return {
    schemaVersion: 2,
    kind: "daily-song-list-backfill-inbox",
    runId: env.GITHUB_RUN_ID || `local-${now.getTime()}`,
    runAttempt: env.GITHUB_RUN_ATTEMPT || "1",
    createdAt: now.toISOString(),
    mode: "backfill",
    baseCapturedAt: latest.capturedAt || latest.generatedAt || "",
    baseDataVersion: latest.dataVersion || latest.source?.dataVersion || latest.status?.dataVersion || "",
    status: "prepared",
    catalogVideos: [],
    note: "Backfill runs write immutable inbox bundles only; fast updates merge accepted bundle videos by videoId before publishing runtime.",
    inputs: {
      monthBackfillTarget: env.DAILY_SONG_MONTH_BACKFILL_TARGET || "",
      mygitSnapshotDays: env.DAILY_SONG_MYGIT_TODAY_SNAPSHOT_DAYS || "",
    },
  };
}

function writeBackfillInboxBundle(bundle, { outDir = OUT_DIR } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, backfillBundleFileName(bundle));
  fs.writeFileSync(filePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return filePath;
}

function backfillBundleFileName(bundle) {
  const runId = safeFileToken(bundle?.runId || "local");
  const attempt = safeFileToken(bundle?.runAttempt || "1");
  return `${runId}-attempt-${attempt}.json`;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeFileToken(value) {
  return String(value || "").replace(/[^A-Za-z0-9_.-]/gu, "-") || "unknown";
}

module.exports = {
  backfillBundleFileName,
  buildBackfillBundle,
  writeBackfillInboxBundle,
};
