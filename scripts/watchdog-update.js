const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const DEFAULT_URL = "https://ytb-song-rank.culua.com/data/ui/meta.json";
const STALE_MINUTES = Number.parseInt(process.env.DAILY_SONG_WATCHDOG_STALE_MINUTES || "75", 10);
const metaUrl = process.env.DAILY_SONG_WATCHDOG_META_URL || DEFAULT_URL;

main().catch((error) => {
  console.error(`[watchdog] ${error.stack || error.message}`);
  setOutput("triggered", "false");
  setOutput("reason", "error");
  process.exit(1);
});

async function main() {
  const checkedAt = new Date();
  const meta = await fetchJson(metaUrl);
  const capturedAt = meta.dataCapturedAt || meta.capturedAt || meta.generatedAt || "";
  const ageMinutes = capturedAt ? Math.floor((checkedAt.getTime() - Date.parse(capturedAt)) / 60000) : Number.POSITIVE_INFINITY;
  const activeRun = findActiveCoreRun();

  setOutput("checked_at", checkedAt.toISOString());
  setOutput("captured_at", capturedAt);
  setOutput("age_minutes", Number.isFinite(ageMinutes) ? String(ageMinutes) : "unknown");

  if (activeRun) {
    console.log(`[watchdog] skip: active update-core run ${activeRun.databaseId || ""} status=${activeRun.status}`);
    setOutput("triggered", "false");
    setOutput("reason", "active_core_run");
    return;
  }

  if (Number.isFinite(ageMinutes) && ageMinutes < STALE_MINUTES) {
    console.log(`[watchdog] skip: fresh published data capturedAt=${capturedAt} ageMinutes=${ageMinutes}`);
    setOutput("triggered", "false");
    setOutput("reason", "fresh_data");
    return;
  }

  const result = spawnSync("gh", ["workflow", "run", "update-core.yml", "-f", "mode=fast", "-f", "reason=watchdog"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    console.error(result.stdout || "");
    console.error(result.stderr || "");
    throw new Error(`gh workflow run failed with exit ${result.status}`);
  }
  console.log(`[watchdog] dispatched fast update: capturedAt=${capturedAt || "missing"} ageMinutes=${ageMinutes}`);
  setOutput("triggered", "true");
  setOutput("reason", "stale_data");
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

function findActiveCoreRun() {
  const result = spawnSync("gh", ["run", "list", "--workflow", "update-core.yml", "--limit", "20", "--json", "databaseId,status,conclusion,createdAt"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    console.warn(`[watchdog] gh run list unavailable: ${result.stderr || result.stdout || result.status}`);
    return null;
  }
  let runs = [];
  try {
    runs = JSON.parse(result.stdout || "[]");
  } catch {
    return null;
  }
  return runs.find((run) => run.status === "queued" || run.status === "in_progress") || null;
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT || "";
  if (!outputPath) return;
  fs.appendFileSync(outputPath, `${name}=${String(value)}\n`, "utf8");
}
