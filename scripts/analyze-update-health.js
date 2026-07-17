const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "artifacts", "update-health");
const DEFAULT_REPO = "Marica7731/daily-song-list";
const RUN_LIMIT = 100;
const WORKFLOWS = [
  { key: "core", file: "update-core.yml", label: "update-core" },
  { key: "backfill", file: "update-backfill.yml", label: "update-backfill" },
  { key: "watchdog", file: "update-watchdog.yml", label: "update-watchdog" },
];

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = await buildUpdateHealthReport();
  const jsonPath = path.join(OUT_DIR, "report.json");
  const mdPath = path.join(OUT_DIR, "report.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(mdPath, renderMarkdown(report), "utf8");
  console.log(
    `UPDATE_HEALTH_OK report=${path.relative(ROOT, jsonPath)} coreRuns=${report.workflows.core.counts.total} failures=${report.workflows.core.counts.failure}`,
  );
}

async function buildUpdateHealthReport({ repo = DEFAULT_REPO, limit = RUN_LIMIT, now = new Date(), ghText = defaultGhText } = {}) {
  const checkedAt = now.toISOString();
  const workflows = {};
  for (const workflow of WORKFLOWS) {
    const runs = ghJson(
      [
        "run",
        "list",
        "--repo",
        repo,
        "--workflow",
        workflow.file,
        "--limit",
        String(limit),
        "--json",
        "databaseId,status,conclusion,event,createdAt,startedAt,updatedAt,headSha,headBranch,displayTitle,url,workflowName",
      ],
      ghText,
    );
    const enriched = [];
    for (const run of runs) {
      const jobs = readRunJobs(repo, run.databaseId, ghText);
      const logs = shouldReadLog(run, jobs) ? readRunLog(repo, run.databaseId, run.conclusion, ghText) : "";
      enriched.push(enrichRun({ ...run, workflowKey: workflow.key, workflowFile: workflow.file, workflowLabel: workflow.label }, jobs, logs));
    }
    workflows[workflow.key] = summarizeWorkflow(workflow, enriched, limit);
  }

  const published = await fetchPublishedRuntimeAge(now).catch((error) => ({ ok: false, error: error.message }));
  const sla = summarizeSla(workflows.core.runs, published);
  return {
    schemaVersion: 2,
    checkedAt,
    repo,
    requestedRunsPerWorkflow: limit,
    dataSource: {
      actions: "gh run list plus GitHub Actions jobs API",
      publishedRuntime: "https://ytb-song-rank.culua.com/data/ui/meta.json",
    },
    workflows,
    sla,
    publishedRuntime: published,
    rootCauseSummary: summarizeRootCauses(workflows.core.runs),
  };
}

function summarizeWorkflow(workflow, runs, requestedLimit) {
  const counts = countRuns(runs);
  const successRuns = runs.filter((run) => run.conclusion === "success");
  const failedOrLongRuns = runs.filter((run) => run.logExcerpt);
  return {
    workflow: workflow.label,
    file: workflow.file,
    requestedLimit,
    availableRuns: runs.length,
    counts,
    durationSeconds: durationStats(successRuns.map((run) => run.totalDurationSeconds)),
    coreDurationSeconds: durationStats(successRuns.map((run) => run.coreDurationSeconds)),
    commitDurationSeconds: durationStats(successRuns.map((run) => run.commitDurationSeconds)),
    pushDurationSeconds: durationStats(successRuns.map((run) => run.pushDurationSeconds)),
    publishVerificationDurationSeconds: durationStats(successRuns.map((run) => run.publishVerificationDurationSeconds)),
    queueDelaySeconds: durationStats(runs.map((run) => run.queueDelaySeconds)),
    successGaps: successGapMinutes(successRuns),
    failureLogs: failedOrLongRuns.map((run) => ({
      databaseId: run.databaseId,
      conclusion: run.conclusion,
      totalDurationSeconds: run.totalDurationSeconds,
      failureStage: run.failureStage,
      failureClass: run.failureClass,
      logExcerpt: run.logExcerpt,
    })),
    watchdog: workflow.key === "watchdog" ? summarizeWatchdog(runs) : null,
    runs,
  };
}

function enrichRun(run, jobs = [], logText = "") {
  const scheduledAt = run.createdAt || "";
  const runnerStartedAt = earliestJobStartedAt(jobs) || run.startedAt || "";
  const completedAt = latestJobCompletedAt(jobs) || run.updatedAt || "";
  const stepMetrics = stepDurations(jobs);
  const logClassification = classifyFailureLog(logText);
  return {
    ...run,
    scheduledAt,
    runnerStartedAt,
    completedAt,
    queueDelaySeconds: secondsBetween(scheduledAt, runnerStartedAt),
    totalDurationSeconds: secondsBetween(scheduledAt, completedAt),
    runDurationSeconds: secondsBetween(runnerStartedAt, completedAt),
    coreDurationSeconds: stepMetrics.core,
    commitDurationSeconds: stepMetrics.commit,
    pushDurationSeconds: stepMetrics.push,
    publishVerificationDurationSeconds: stepMetrics.publishVerification,
    backfillDurationSeconds: stepMetrics.backfill,
    watchdogDurationSeconds: stepMetrics.watchdog,
    failureStage: failedStepName(jobs),
    failureClass: logClassification,
    logExcerpt: logText ? logText.slice(-12_000) : "",
  };
}

function stepDurations(jobs) {
  const steps = jobs.flatMap((job) => job.steps || []);
  return {
    core: durationForStep(steps, /^Update compact runtime data$/u),
    backfill: durationForStep(steps, /^Prepare immutable backfill bundle$/u),
    watchdog: durationForStep(steps, /^Check published freshness$/u),
    commit: durationForStep(steps, /^Commit core data|^Commit backfill bundle/u),
    push: durationForStep(steps, /^Push core data|^Push backfill bundle/u),
    publishVerification: durationForStep(steps, /^Published runtime health check$/u),
  };
}

function classifyFailureLog(logText) {
  if (!logText) return "";
  if (/CONFLICT \([^)]*\):|CONFLICT .*Merge conflict|could not apply .*chore: update core song-list data/u.test(logText)) return "git_rebase_conflict";
  if (/failed to push|non-fast-forward|fetch first|Updates were rejected/u.test(logText)) return "push_conflict";
  if (/timed out|timeout-minutes|The operation was canceled/u.test(logText)) return "timeout";
  if (/PUBLISHED_RUNTIME|published .*must match expected|CDN propagation/u.test(logText)) return "published_runtime_mismatch";
  if (/Process completed with exit code 1|core update failed/u.test(logText)) return "core_update_failure";
  return "unclassified";
}

function countRuns(runs) {
  return {
    total: runs.length,
    success: runs.filter((run) => run.status === "completed" && run.conclusion === "success").length,
    failure: runs.filter((run) => run.status === "completed" && run.conclusion === "failure").length,
    cancelled: runs.filter((run) => run.status === "completed" && run.conclusion === "cancelled").length,
    timeout: runs.filter((run) => run.status === "completed" && run.conclusion === "timed_out").length,
    skipped: runs.filter((run) => run.status === "completed" && run.conclusion === "skipped").length,
    queued: runs.filter((run) => run.status === "queued").length,
    inProgress: runs.filter((run) => run.status === "in_progress").length,
    completed: runs.filter((run) => run.status === "completed").length,
  };
}

function summarizeWatchdog(runs) {
  return {
    triggered: runs.filter((run) => /\[watchdog\] dispatched/u.test(run.logExcerpt)).length,
    skipped: runs.filter((run) => /\[watchdog\] skip/u.test(run.logExcerpt)).length,
  };
}

function summarizeSla(coreRuns, published) {
  const successfulFastRuns = coreRuns.filter((run) => run.conclusion === "success");
  const durations = successfulFastRuns.map((run) => run.totalDurationSeconds).filter(Number.isFinite);
  const p95 = percentile(durations, 0.95);
  return {
    normalFastUnder15Minutes: durations.length ? durations.filter((value) => value <= 15 * 60).length : 0,
    normalFastRunCount: durations.length,
    p95FastDurationSeconds: p95,
    p95FastUnder25Minutes: Number.isFinite(p95) ? p95 <= 25 * 60 : null,
    currentPublishedAgeMinutes: published.ok ? published.ageMinutes : null,
    currentPublishedAgeUnder75Minutes: published.ok ? published.ageMinutes < 75 : null,
  };
}

function summarizeRootCauses(coreRuns) {
  const causes = [];
  const conflictRuns = coreRuns.filter((run) => run.failureClass === "git_rebase_conflict" || run.failureClass === "push_conflict");
  if (conflictRuns.length) {
    causes.push({
      cause: "generated_data_rebase_conflict",
      evidenceRunIds: conflictRuns.map((run) => run.databaseId),
      summary: "Core data was generated on an older main, then git pull --rebase conflicted against newer generated data shards before push.",
    });
  }
  const timeoutRuns = coreRuns.filter((run) => run.failureClass === "timeout" || run.conclusion === "timed_out");
  if (timeoutRuns.length) {
    causes.push({
      cause: "workflow_timeout",
      evidenceRunIds: timeoutRuns.map((run) => run.databaseId),
      summary: "One or more update runs exceeded the workflow timeout or were cancelled by the runner.",
    });
  }
  const gaps = successGapMinutes(coreRuns.filter((run) => run.conclusion === "success")).filter((gap) => gap.minutes > 120);
  if (gaps.length) {
    causes.push({
      cause: "success_gap_over_120_minutes",
      evidenceRunIds: uniqueValues(gaps.flatMap((gap) => [gap.fromRun, gap.toRun])),
      summary: "Published freshness exceeded two hours between successful core runs.",
      gaps,
    });
  }
  if (!causes.length) causes.push({ cause: "none_detected", evidenceRunIds: [], summary: "No >2h success gap or classified failed update was found in the queried runs." });
  return causes;
}

function successGapMinutes(successes) {
  return successes
    .slice()
    .sort((a, b) => Date.parse(a.completedAt || a.updatedAt || "") - Date.parse(b.completedAt || b.updatedAt || ""))
    .map((run, index, sorted) => {
      if (index === 0) return null;
      const previous = sorted[index - 1];
      return {
        fromRun: previous.databaseId,
        toRun: run.databaseId,
        fromCompletedAt: previous.completedAt || previous.updatedAt,
        toCompletedAt: run.completedAt || run.updatedAt,
        minutes: Math.round((Date.parse(run.completedAt || run.updatedAt || "") - Date.parse(previous.completedAt || previous.updatedAt || "")) / 60000),
      };
    })
    .filter(Boolean);
}

function durationStats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0 };
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    average: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function durationForStep(steps, pattern) {
  const step = steps.find((candidate) => pattern.test(candidate.name || ""));
  return step ? secondsBetween(step.started_at || step.startedAt, step.completed_at || step.completedAt) : null;
}

function failedStepName(jobs) {
  const step = jobs.flatMap((job) => job.steps || []).find((candidate) => candidate.conclusion === "failure" || candidate.conclusion === "timed_out");
  return step?.name || "";
}

function earliestJobStartedAt(jobs) {
  return minIso(jobs.map((job) => job.started_at || job.startedAt).filter(Boolean));
}

function latestJobCompletedAt(jobs) {
  return maxIso(jobs.map((job) => job.completed_at || job.completedAt).filter(Boolean));
}

function minIso(values) {
  return values.sort((a, b) => Date.parse(a) - Date.parse(b))[0] || "";
}

function maxIso(values) {
  return values.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || "";
}

function secondsBetween(start, end) {
  const startMs = Date.parse(start || "");
  const endMs = Date.parse(end || "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.round((endMs - startMs) / 1000);
}

function shouldReadLog(run, jobs) {
  const totalSeconds = secondsBetween(run.createdAt, run.updatedAt);
  return run.conclusion === "failure" || run.conclusion === "timed_out" || totalSeconds > 25 * 60 || Boolean(failedStepName(jobs));
}

function readRunJobs(repo, runId, ghText) {
  if (!runId) return [];
  const payload = ghJson(["api", `repos/${repo}/actions/runs/${runId}/jobs`, "--paginate"], ghText);
  return payload.jobs || [];
}

function readRunLog(repo, runId, conclusion, ghText) {
  const args = conclusion === "failure" || conclusion === "timed_out" ? ["run", "view", String(runId), "--repo", repo, "--log-failed"] : ["run", "view", String(runId), "--repo", repo, "--log"];
  try {
    return ghText(args);
  } catch (error) {
    return `[log-unavailable] ${error.message}`;
  }
}

async function fetchPublishedRuntimeAge(now = new Date()) {
  const url = "https://ytb-song-rank.culua.com/data/ui/meta.json";
  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const meta = JSON.parse(text);
  const capturedAt = meta.dataCapturedAt || meta.capturedAt || meta.generatedAt || "";
  const ageMinutes = capturedAt ? Math.floor((now.getTime() - Date.parse(capturedAt)) / 60000) : null;
  return {
    ok: true,
    url,
    dataVersion: meta.dataVersion || "",
    capturedAt,
    ageMinutes,
  };
}

function renderMarkdown(report) {
  const lines = [
    "# Update Health Report",
    "",
    `- checkedAt: ${report.checkedAt}`,
    `- repo: ${report.repo}`,
    `- data source: ${report.dataSource.actions}`,
    `- published runtime: ${report.publishedRuntime.ok ? `${report.publishedRuntime.capturedAt} age=${report.publishedRuntime.ageMinutes}m` : report.publishedRuntime.error}`,
    "",
    "## Workflow Counts",
    "",
    "| Workflow | Runs | Success | Failure | Cancelled | Timeout | Queued | In progress |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const workflow of Object.values(report.workflows)) {
    lines.push(
      `| ${workflow.workflow} | ${workflow.counts.total} | ${workflow.counts.success} | ${workflow.counts.failure} | ${workflow.counts.cancelled} | ${workflow.counts.timeout} | ${workflow.counts.queued} | ${workflow.counts.inProgress} |`,
    );
  }
  lines.push("", "## Core SLA", "");
  lines.push(`- successful fast runs: ${report.sla.normalFastRunCount}`);
  lines.push(`- fast runs <=15m: ${report.sla.normalFastUnder15Minutes}`);
  lines.push(`- p95 fast duration seconds: ${report.sla.p95FastDurationSeconds ?? "n/a"}`);
  lines.push(`- p95 <=25m: ${report.sla.p95FastUnder25Minutes}`);
  lines.push(`- current published age <=75m: ${report.sla.currentPublishedAgeUnder75Minutes}`);
  lines.push("", "## Root Causes", "");
  for (const cause of report.rootCauseSummary) {
    lines.push(`- ${cause.cause}: ${cause.summary} runs=${cause.evidenceRunIds.join(",") || "n/a"}`);
  }
  lines.push("", "## Failure And Long Run Logs", "");
  for (const failure of report.workflows.core.failureLogs) {
    lines.push(`- run ${failure.databaseId}: class=${failure.failureClass || "none"} stage=${failure.failureStage || "unknown"} duration=${failure.totalDurationSeconds ?? "n/a"}s excerptBytes=${failure.logExcerpt.length}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function ghJson(args, ghText = defaultGhText) {
  const text = ghText(args);
  return JSON.parse(text || "{}");
}

function defaultGhText(args) {
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

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

module.exports = {
  buildUpdateHealthReport,
  classifyFailureLog,
  countRuns,
  durationStats,
  enrichRun,
  renderMarkdown,
  successGapMinutes,
};
