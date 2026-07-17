const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "artifacts", "update-health");
const WORKFLOW = "update-core.yml";
const LIMIT = "50";

main();

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const checkedAt = new Date().toISOString();
  const runs = ghJson(["run", "list", "--workflow", WORKFLOW, "--limit", LIMIT, "--json", "databaseId,status,conclusion,event,createdAt,startedAt,updatedAt,headSha"]);
  const enriched = runs.map((run) => enrichRun(run));
  const completed = enriched.filter((run) => run.status === "completed");
  const successes = completed.filter((run) => run.conclusion === "success");
  const failures = completed.filter((run) => run.conclusion === "failure");
  const cancelled = completed.filter((run) => run.conclusion === "cancelled");
  const successGaps = successGapMinutes(successes);

  const report = {
    checkedAt,
    workflow: WORKFLOW,
    limit: Number(LIMIT),
    counts: {
      total: enriched.length,
      completed: completed.length,
      success: successes.length,
      failure: failures.length,
      cancelled: cancelled.length,
      active: enriched.filter((run) => run.status !== "completed").length,
      successGapsOver120Minutes: successGaps.filter((gap) => gap.minutes > 120).length,
    },
    durations: durationStats(successes),
    successGaps,
    runs: enriched,
    failureLogs: failures.slice(0, 8).map((run) => ({
      databaseId: run.databaseId,
      conclusion: run.conclusion,
      logExcerpt: ghText(["run", "view", String(run.databaseId), "--log-failed"]).slice(-12000),
    })),
    rootCauseSummary: [
      "Regular core runs previously mixed fresh updates with heavy month backfill, creating 25-32 minute successful runs.",
      "The compensation cron shared the same core concurrency group and skipped when local data was younger than 75 minutes, leaving long success gaps after scheduler jitter.",
      "Several failures happened after data generation during git pull --rebase conflicts against newer data commits.",
      "The previous published check accepted any self-consistent online runtime and did not require the just-built dataVersion.",
    ],
  };

  const jsonPath = path.join(OUT_DIR, "report.json");
  const mdPath = path.join(OUT_DIR, "report.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(mdPath, renderMarkdown(report), "utf8");
  console.log(`UPDATE_HEALTH_OK report=${path.relative(ROOT, jsonPath)} runs=${enriched.length} failures=${failures.length}`);
}

function enrichRun(run) {
  const createdAt = Date.parse(run.createdAt || "");
  const startedAt = Date.parse(run.startedAt || run.createdAt || "");
  const updatedAt = Date.parse(run.updatedAt || "");
  return {
    ...run,
    queueDelaySeconds: finiteSeconds(startedAt - createdAt),
    durationSeconds: finiteSeconds(updatedAt - startedAt),
    totalSeconds: finiteSeconds(updatedAt - createdAt),
  };
}

function durationStats(runs) {
  const values = runs.map((run) => run.durationSeconds).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return { count: 0 };
  return {
    count: values.length,
    minSeconds: values[0],
    maxSeconds: values[values.length - 1],
    averageSeconds: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50Seconds: values[Math.floor(values.length * 0.5)],
    p90Seconds: values[Math.floor(values.length * 0.9)],
  };
}

function successGapMinutes(successes) {
  return successes
    .slice()
    .sort((a, b) => Date.parse(a.updatedAt || "") - Date.parse(b.updatedAt || ""))
    .map((run, index, sorted) => {
      if (index === 0) return null;
      const previous = sorted[index - 1];
      return {
        fromRun: previous.databaseId,
        toRun: run.databaseId,
        fromUpdatedAt: previous.updatedAt,
        toUpdatedAt: run.updatedAt,
        minutes: Math.round((Date.parse(run.updatedAt || "") - Date.parse(previous.updatedAt || "")) / 60000),
      };
    })
    .filter(Boolean);
}

function renderMarkdown(report) {
  const lines = [
    "# Update Health Report",
    "",
    `- checkedAt: ${report.checkedAt}`,
    `- workflow: ${report.workflow}`,
    `- total runs: ${report.counts.total}`,
    `- success/failure/cancelled/active: ${report.counts.success}/${report.counts.failure}/${report.counts.cancelled}/${report.counts.active}`,
    `- success gaps >120m: ${report.counts.successGapsOver120Minutes}`,
    `- success duration seconds p50/p90/max: ${report.durations.p50Seconds || 0}/${report.durations.p90Seconds || 0}/${report.durations.maxSeconds || 0}`,
    "",
    "## Root Cause Summary",
    "",
    ...report.rootCauseSummary.map((item) => `- ${item}`),
    "",
    "## Recent Failures",
    "",
  ];
  for (const failure of report.failureLogs) {
    lines.push(`- run ${failure.databaseId}: ${failure.conclusion}, log excerpt bytes=${failure.logExcerpt.length}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function ghJson(args) {
  const text = ghText(args);
  return JSON.parse(text || "[]");
}

function ghText(args) {
  const result = spawnSync("gh", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`);
  }
  return result.stdout || "";
}

function finiteSeconds(ms) {
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}
