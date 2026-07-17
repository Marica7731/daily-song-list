const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const COMPENSATION_CRON = "37 * * * *";
const FRESH_THRESHOLD_MINUTES = 75;

const eventName = process.env.GITHUB_EVENT_NAME || "";
const eventSchedule = process.env.DAILY_SONG_EVENT_SCHEDULE || "";
const runMode = process.env.DAILY_SONG_UPDATE_MODE || "fast";

if (eventName === "schedule" && eventSchedule === COMPENSATION_CRON) {
  const capturedAt = latestCapturedAt();
  const ageMinutes = capturedAt ? (Date.now() - Date.parse(capturedAt)) / 60000 : Number.POSITIVE_INFINITY;
  if (Number.isFinite(ageMinutes) && ageMinutes >= 0 && ageMinutes < FRESH_THRESHOLD_MINUTES) {
    console.log(`[core-preflight] skip compensation cron: capturedAt=${capturedAt} ageMinutes=${Math.round(ageMinutes)}`);
    setOutput("skipped", "true");
    setOutput("updated", "false");
    setOutput("reason", "fresh_data");
    setOutput("mode", runMode);
    process.exit(0);
  }
  console.log(
    `[core-preflight] run compensation cron: capturedAt=${capturedAt || "missing"} ageMinutes=${
      Number.isFinite(ageMinutes) ? Math.round(ageMinutes) : "unknown"
    }`,
  );
}

setOutput("skipped", "false");
setOutput("mode", runMode);
const command = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(command, ["run", "update:core"], {
  cwd: ROOT,
  stdio: "inherit",
});

if (result.error) {
  console.error(`[core-update] failed to start npm run update:core: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`[core-update] npm run update:core stopped by signal ${result.signal}`);
  process.exit(1);
}
if ((result.status || 0) === 0) setOutput("updated", "true");
process.exit(result.status || 0);

function latestCapturedAt() {
  const meta = readJson(path.join(ROOT, "data", "ui", "meta.json"));
  if (meta?.capturedAt) return meta.capturedAt;
  if (meta?.dataCapturedAt) return meta.dataCapturedAt;
  const latest = readJson(path.join(ROOT, "data", "latest.json"));
  return latest?.capturedAt || latest?.generatedAt || "";
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT || "";
  if (!outputPath) return;
  fs.appendFileSync(outputPath, `${name}=${String(value)}\n`, "utf8");
}
