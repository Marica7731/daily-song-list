const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const DEFAULT_API_URL = "https://ytb-song-rank.culua.com/api/meta";
const DEFAULT_STATIC_META_URL = "https://ytb-song-rank.culua.com/data/ui/meta.json";
const STALE_MINUTES = Number.parseInt(process.env.DAILY_SONG_WATCHDOG_STALE_MINUTES || "75", 10);
const configuredMetaUrl = process.env.DAILY_SONG_WATCHDOG_META_URL || "";

if (require.main === module) {
  main().catch((error) => {
    console.error(`[watchdog] ${error.stack || error.message}`);
    setOutput("triggered", "false");
    setOutput("reason", "error");
    process.exit(1);
  });
}

async function main() {
  const checkedAt = new Date();
  const { url: metaUrl, payload: meta } = await fetchFreshnessPayload();
  const capturedAt = freshnessTimestampFromPayload(meta);
  const ageMinutes = capturedAt ? Math.floor((checkedAt.getTime() - Date.parse(capturedAt)) / 60000) : Number.POSITIVE_INFINITY;
  const activeRun = findActiveCoreRun();

  setOutput("checked_at", checkedAt.toISOString());
  setOutput("meta_url", metaUrl);
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

async function fetchFreshnessPayload() {
  if (configuredMetaUrl) {
    return { url: configuredMetaUrl, payload: await fetchJson(configuredMetaUrl) };
  }
  const errors = [];
  for (const url of [DEFAULT_API_URL, DEFAULT_STATIC_META_URL]) {
    try {
      return { url, payload: await fetchJson(url) };
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(`published freshness metadata unavailable: ${errors.join("; ")}`);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "User-Agent": "daily-song-list-watchdog/1.0",
    },
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

function freshnessTimestampFromPayload(payload) {
  const apiMeta = payload && typeof payload.meta === "object" && payload.meta ? payload.meta : null;
  return firstText(
    apiMeta?.latest_captured_at,
    apiMeta?.latest_generated_at,
    apiMeta?.built_at,
    payload?.dataCapturedAt,
    payload?.capturedAt,
    payload?.generatedAt,
  );
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
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

module.exports = {
  freshnessTimestampFromPayload,
};
