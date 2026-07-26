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
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeCommand = process.execPath;

const steps = [
  ["update-songlist", nodeCommand, ["scripts/update-songlist.js"]],
  ["apply-song-search-niche", nodeCommand, ["scripts/apply-song-search-niche.js"]],
  ["fetch-channel-avatar-cache", nodeCommand, ["scripts/fetch-channel-avatar-cache.js", "--daily"]],
  ["build-runtime-data", nodeCommand, ["scripts/build-runtime-data.js"]],
  ["validate-core", npmCommand, ["run", "validate:core"]],
];

for (const [name, command, args] of steps) {
  runStep(name, command, args);
}

setOutput("updated", "true");
process.exit(0);

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

function runStep(name, command, args) {
  const startedAt = Date.now();
  console.log(`[core-update] start ${name}: ${command} ${args.join(" ")}`);
  const childEnv = { ...process.env };
  if (name === "build-runtime-data") {
    childEnv.NODE_OPTIONS = [childEnv.NODE_OPTIONS, "--max-old-space-size=8192"].filter(Boolean).join(" ");
  }
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: childEnv,
    stdio: "inherit",
  });
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  if (result.error) {
    console.error(`[core-update] ${name} failed to start after ${elapsedSeconds}s: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`[core-update] ${name} stopped by signal ${result.signal} after ${elapsedSeconds}s`);
    process.exit(1);
  }
  if ((result.status || 0) !== 0) {
    console.error(`[core-update] ${name} failed after ${elapsedSeconds}s with exit code ${result.status}`);
    process.exit(result.status || 1);
  }
  console.log(`[core-update] done ${name} elapsed=${elapsedSeconds}s`);
}
