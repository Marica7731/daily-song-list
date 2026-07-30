const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const YAML = require("yaml");

const root = path.join(__dirname, "..");
const workflowPath = path.join(root, ".github", "workflows", "discover-one-channel-candidate.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");
const workflowLines = workflow.split("\n");

function runBlocks(source = workflow) {
  const lines = source.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s{8}run: \|\s*$/u.test(lines[index])) continue;
    const body = [];
    for (index += 1; index < lines.length && /^ {10}/u.test(lines[index]); index += 1) {
      body.push(lines[index].slice(10));
    }
    index -= 1;
    blocks.push(body.join("\n"));
  }
  return blocks;
}

function isMinimalCandidateWorkflow(source) {
  const lines = source.split("\n").length;
  return (
    lines >= 250 &&
    lines <= 400 &&
    !/(?:git archive|git for-each-ref|VERIFY_ARTIFACT_TREE|verify_pinned_export_blob|write_bound_evidence)/u.test(source)
  );
}

test("rejected tree 64e92f giant workflow is red and the replacement is minimal green", () => {
  const rejectedMarkers = [
    "git archive",
    "git for-each-ref",
    "VERIFY_ARTIFACT_TREE",
    "verify_pinned_export_blob",
    "write_bound_evidence",
  ];
  const rejectedWorkflowFixture = [
    "# tree 64e92f6420bf3fbb10c4509d242d94c508bf7476",
    ...rejectedMarkers,
    ...Array.from({ length: 1161 }, (_, index) => `# rejected-line-${index}`),
  ].join("\n");
  assert.equal(rejectedWorkflowFixture.split("\n").length, 1167);
  assert.equal(isMinimalCandidateWorkflow(rejectedWorkflowFixture), false);
  assert.equal(isMinimalCandidateWorkflow(workflow), true);
  assert.ok(workflowLines.length >= 250 && workflowLines.length <= 400);
  for (const marker of rejectedMarkers) assert.doesNotMatch(workflow, new RegExp(marker.replaceAll(" ", "\\s+"), "u"));
});

test("workflow dispatch contract is strict, generic, and Mac candidate-only", () => {
  const parsed = YAML.parse(workflow);
  assert.equal(parsed.permissions.contents, "read");
  assert.equal(parsed.concurrency["cancel-in-progress"], false);
  assert.deepEqual(parsed.jobs.discover["runs-on"], ["self-hosted", "macOS", "ARM64", "daily-song-list-mac"]);
  assert.equal(parsed.jobs.discover["timeout-minutes"], 25);
  const inputs = parsed.on.workflow_dispatch.inputs;
  assert.equal(inputs.channel_id.required, true);
  assert.equal(inputs.channel_handle.required, true);
  assert.equal(inputs.channel_slug.required, true);
  assert.deepEqual(inputs.max_channel_pages.options, ["10", "25"]);
  assert.deepEqual(inputs.max_videos.options, ["250", "500", "1000"]);
  assert.deepEqual(inputs.force_refresh.options, ["false", "true"]);
  assert.equal(inputs.force_refresh.default, "false");
  assert.match(workflow, /\[\[ "\$CHANNEL_ID" =~ \^UC\[A-Za-z0-9_-\]\{22\}\$ \]\]/u);
  assert.match(workflow, /\[\[ "\$CHANNEL_HANDLE" =~ \^@\[A-Za-z0-9._-\]\{3,30\}\$ \]\]/u);
  assert.match(workflow, /case "\$MAX_CHANNEL_PAGES" in 10\|25\)/u);
  assert.match(workflow, /case "\$MAX_VIDEOS" in 250\|500\|1000\)/u);
  assert.match(workflow, /case "\$FORCE_REFRESH" in false\|true\)/u);
  assert.match(workflow, /--tab streams[\s\S]*--tab videos[\s\S]*--candidate-only/u);
});

test("force refresh maps only to a literal fresh flag and defaults to continuation-safe false", () => {
  assert.match(workflow, /FRESH_ARGS=\(\)[\s\S]*true\) FRESH_ARGS=\(--fresh\)[\s\S]*false\) ;;/u);
  assert.match(workflow, /--force-refresh "\$FORCE_REFRESH"/u);
  assert.match(workflow, /"\$\{FRESH_ARGS\[@\]\}"/u);
  assert.doesNotMatch(workflow, /eval|bash -c "\$FORCE_REFRESH"|--fresh\s*(?:\\\n|\n)\s*--candidate-only/u);
});

test("one owned task root has bounded Node memory, real PID RSS, task bytes, and artifact bytes", () => {
  assert.match(workflow, /TASK_ROOT: \$\{\{ runner\.temp \}\}\/daily-song-channel-discovery-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(workflow, /EXPECTED_TASK_ROOT="\$RUNNER_TEMP\/daily-song-channel-discovery-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/u);
  assert.match(workflow, /NODE_MAX_OLD_SPACE_SIZE_MB: "1536"/u);
  assert.match(workflow, /TASK_CAP_BYTES: "2147483648"/u);
  assert.match(workflow, /ARTIFACT_CAP_BYTES: "134217728"/u);
  assert.match(workflow, /node "--max-old-space-size=\$NODE_MAX_OLD_SPACE_SIZE_MB"/u);
  assert.match(workflow, /ps -o rss= -p "\$discovery_pid"/u);
  assert.match(workflow, /du -sk "\$TASK_ROOT"/u);
  assert.match(workflow, /\[ "\$rss_bytes" -le "\$TASK_CAP_BYTES" \]/u);
  assert.match(workflow, /\[ "\$current_task_bytes" -le "\$TASK_CAP_BYTES" \]/u);
  assert.match(workflow, /\[ "\$artifact_bytes" -le "\$ARTIFACT_CAP_BYTES" \]/u);
  assert.match(workflow, /DISCOVERY_TIMEOUT_SECONDS: "1200"/u);
  assert.match(workflow, /beforeBytes:[\s\S]*peakTaskBytes:[\s\S]*peakDiscoveryRssBytes:[\s\S]*afterBytes:/u);
});

test("core artifacts go directly through both frozen jq gates without archive or reprojection", () => {
  assert.match(workflow, /--slurpfile sourceManifestFile "\$ARTIFACT_DIR\/manifest\.json"/u);
  assert.match(workflow, /--slurpfile checkpointFile "\$ARTIFACT_DIR\/checkpoint\.json"/u);
  assert.match(workflow, /channel-discovery-candidate-artifact-gate\.jq/u);
  assert.match(workflow, /channel-discovery-candidate-records-gate\.jq/u);
  assert.match(workflow, /"\$ARTIFACT_DIR\/candidate-manifest\.ndjson"/u);
  assert.match(workflow, /\.pageEvidenceFiles\[\]/u);
  assert.match(workflow, /shasum -a 256/u);
  assert.match(workflow, /recomputeCandidateArtifactEvidence/u);
  assert.match(workflow, /VERIFY_RAW_CONTINUATIONS/u);
  assert.doesNotMatch(workflow, /source-manifest\.json|cp -R|checksums\.sha256|git\s+(?:archive|for-each-ref|cat-file|hash-object)/u);
});

test("workflow has no accepted, export, PG, Urameshi, dispatch, push, or broad cancellation path", () => {
  assert.doesNotMatch(
    workflow,
    /accepted|export-channel|import-channel|deploy-pg|postgres|urameshi|workflow run|gh run cancel|git push|git commit|pkill|killall/iu,
  );
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /retention-days: 3/u);
  assert.match(workflow, /if-no-files-found: error/u);
});

test("owned cleanup removes only the exact run-attempt task root and reports zero after cleanup", () => {
  const blocks = runBlocks();
  assert.equal(blocks.length, 2);
  const cleanup = blocks[1];
  assert.match(cleanup, /expected="\$RUNNER_TEMP\/daily-song-channel-discovery-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/u);
  assert.match(cleanup, /\[ "\$TASK_ROOT" = "\$expected" \] \|\| exit 78/u);
  assert.match(cleanup, /rm -rf -- "\$TASK_ROOT"/u);
  assert.match(cleanup, /cleanup_after_bytes=0/u);

  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-cleanup-"));
  const taskRoot = path.join(runnerTemp, "daily-song-channel-discovery-17-2");
  const summary = path.join(runnerTemp, "summary.md");
  fs.mkdirSync(taskRoot);
  fs.writeFileSync(path.join(taskRoot, "owned.txt"), "owned", "utf8");
  const result = spawnSync("bash", ["-c", cleanup], {
    cwd: root,
    env: {
      ...process.env,
      RUNNER_TEMP: runnerTemp,
      GITHUB_RUN_ID: "17",
      GITHUB_RUN_ATTEMPT: "2",
      TASK_ROOT: taskRoot,
      GITHUB_STEP_SUMMARY: summary,
      REPORT_BEFORE_BYTES: "1",
      REPORT_PEAK_TASK_BYTES: "2",
      REPORT_PEAK_RSS_BYTES: "3",
      REPORT_AFTER_BYTES: "4",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(taskRoot), false);
  assert.match(fs.readFileSync(summary, "utf8"), /cleanup after: 0 bytes/u);
  fs.rmSync(runnerTemp, { recursive: true, force: true });
});

test("YAML parses and every run block passes bash syntax with no GitHub expression residue", () => {
  assert.doesNotThrow(() => YAML.parse(workflow));
  const blocks = runBlocks();
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    assert.equal(block.includes("${{"), false);
    const result = spawnSync("bash", ["-n"], { input: block, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});
