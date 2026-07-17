const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const DEFAULT_URL = "https://ytb-song-rank.culua.com/data/ui/meta.json";
const STALE_MINUTES = Number.parseInt(process.env.DAILY_SONG_WATCHDOG_STALE_MINUTES || "75", 10);
const metaUrl = process.env.DAILY_SONG_WATCHDOG_META_URL || DEFAULT_URL;

if (require.main === module) {
  runWatchdog().catch((error) => {
    console.error(`[watchdog] ${error.stack || error.message}`);
    setOutput("triggered", "false");
    setOutput("reason", "error");
    setOutput("triggerReason", "error");
    process.exit(1);
  });
}

async function runWatchdog(options = {}) {
  const checkedAt = options.now || new Date();
  const outputs = options.outputs || setOutput;
  const logger = options.logger || console;
  const publishedMeta = await (options.fetchJson || fetchJson)(options.metaUrl || metaUrl);
  const coreRuns = await (options.listCoreRuns || listCoreRuns)();
  const decision = evaluateWatchdog({
    meta: publishedMeta,
    coreRuns,
    now: checkedAt,
    staleMinutes: options.staleMinutes || STALE_MINUTES,
  });

  writeDecisionOutputs(outputs, checkedAt, decision);

  if (!decision.shouldDispatch) {
    logger.log(`[watchdog] skip: ${decision.triggerReason} capturedAt=${decision.previousCapturedAt || "missing"} ageMinutes=${formatAgeMinutes(decision.ageMinutes)}`);
    return decision;
  }

  const dispatchedAt = new Date();
  await (options.dispatchWorkflow || dispatchCoreWorkflow)();
  const refreshedRuns = await (options.listCoreRuns || listCoreRuns)();
  const dispatchedRun = findDispatchedRun(refreshedRuns, dispatchedAt) || null;
  const dispatchedRunId = dispatchedRun?.databaseId || "";
  logger.log(
    `[watchdog] dispatched fast update: reason=${decision.triggerReason} capturedAt=${decision.previousCapturedAt || "missing"} ageMinutes=${formatAgeMinutes(
      decision.ageMinutes,
    )} dispatchedRunId=${dispatchedRunId || "unknown"}`,
  );
  outputs("triggered", "true");
  outputs("reason", decision.triggerReason);
  outputs("triggerReason", decision.triggerReason);
  outputs("dispatchedRunId", dispatchedRunId);
  outputs("dispatched_run_id", dispatchedRunId);
  return { ...decision, triggered: true, dispatchedRunId };
}

function evaluateWatchdog({ meta, coreRuns = [], now = new Date(), staleMinutes = STALE_MINUTES }) {
  const previousCapturedAt = meta?.dataCapturedAt || meta?.capturedAt || meta?.generatedAt || "";
  const ageMinutes = previousCapturedAt ? Math.floor((now.getTime() - Date.parse(previousCapturedAt)) / 60000) : Number.POSITIVE_INFINITY;
  const activeRun = findBlockingCoreRun(coreRuns);
  const latestCoreRun = latestRun(coreRuns);

  if (activeRun) {
    return {
      shouldDispatch: false,
      triggered: false,
      triggerReason: "active_core_run",
      previousCapturedAt,
      ageMinutes,
      sourceRunId: activeRun.databaseId || "",
    };
  }

  if (Number.isFinite(ageMinutes) && ageMinutes < staleMinutes) {
    return {
      shouldDispatch: false,
      triggered: false,
      triggerReason: "fresh_data",
      previousCapturedAt,
      ageMinutes,
      sourceRunId: latestCoreRun?.databaseId || "",
    };
  }

  const duplicateRun = findPriorCompensationForStaleEvent(coreRuns, previousCapturedAt, now);
  if (duplicateRun) {
    return {
      shouldDispatch: false,
      triggered: false,
      triggerReason: "duplicate_stale_event",
      previousCapturedAt,
      ageMinutes,
      sourceRunId: duplicateRun.databaseId || "",
    };
  }

  return {
    shouldDispatch: true,
    triggered: false,
    triggerReason: previousCapturedAt ? "stale_data" : "missing_published_capture",
    previousCapturedAt,
    ageMinutes,
    sourceRunId: latestCoreRun?.databaseId || "",
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

function findBlockingCoreRun(runs) {
  return runs.find((run) => run.status === "queued" || run.status === "in_progress") || null;
}

function findPriorCompensationForStaleEvent(runs, previousCapturedAt, now = new Date()) {
  const previousMs = Date.parse(previousCapturedAt || "");
  const lowerBound = Number.isFinite(previousMs) ? previousMs : now.getTime() - STALE_MINUTES * 60 * 1000;
  return runs
    .filter((run) => run.event === "workflow_dispatch")
    .filter((run) => isSuccessfulOrActiveCompensationRun(run))
    .filter((run) => Date.parse(run.createdAt || "") >= lowerBound)
    .sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""))[0] || null;
}

function isSuccessfulOrActiveCompensationRun(run) {
  if (!run || run.event !== "workflow_dispatch") return false;
  if (run.status === "queued" || run.status === "in_progress") return true;
  return run.status === "completed" && run.conclusion === "success";
}

function latestRun(runs) {
  return runs.slice().sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""))[0] || null;
}

function findDispatchedRun(runs, dispatchedAt) {
  const lowerBound = dispatchedAt.getTime() - 30_000;
  return runs
    .filter((run) => run.event === "workflow_dispatch")
    .filter((run) => Date.parse(run.createdAt || "") >= lowerBound)
    .sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""))[0] || null;
}

function listCoreRuns() {
  const result = spawnSync("gh", [
    "run",
    "list",
    "--workflow",
    "update-core.yml",
    "--limit",
    "50",
    "--json",
    "databaseId,status,conclusion,event,createdAt,startedAt,updatedAt,headSha,displayTitle",
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    console.warn(`[watchdog] gh run list unavailable: ${result.stderr || result.stdout || result.status}`);
    return [];
  }
  try {
    return JSON.parse(result.stdout || "[]");
  } catch {
    return [];
  }
}

function dispatchCoreWorkflow() {
  const result = spawnSync("gh", ["workflow", "run", "update-core.yml", "-f", "mode=fast", "-f", "reason=watchdog"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    console.error(result.stdout || "");
    console.error(result.stderr || "");
    throw new Error(`gh workflow run failed with exit ${result.status}`);
  }
}

function writeDecisionOutputs(outputs, checkedAt, decision) {
  outputs("checked_at", checkedAt.toISOString());
  outputs("captured_at", decision.previousCapturedAt);
  outputs("previousCapturedAt", decision.previousCapturedAt);
  outputs("age_minutes", formatAgeMinutes(decision.ageMinutes));
  outputs("ageMinutes", formatAgeMinutes(decision.ageMinutes));
  outputs("sourceRunId", decision.sourceRunId || "");
  outputs("triggered", "false");
  outputs("reason", decision.triggerReason);
  outputs("triggerReason", decision.triggerReason);
  outputs("dispatchedRunId", "");
}

function formatAgeMinutes(value) {
  return Number.isFinite(value) ? String(Math.floor(value)) : "unknown";
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT || "";
  if (!outputPath) return;
  fs.appendFileSync(outputPath, `${name}=${String(value)}\n`, "utf8");
}

module.exports = {
  DEFAULT_URL,
  STALE_MINUTES,
  evaluateWatchdog,
  fetchJson,
  findBlockingCoreRun,
  findDispatchedRun,
  findPriorCompensationForStaleEvent,
  isSuccessfulOrActiveCompensationRun,
  runWatchdog,
};
