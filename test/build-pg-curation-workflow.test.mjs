import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const workflowPath = path.resolve(".github/workflows/build-pg-curation-patch.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");

test("curation producer is Mac-only and never invokes the deployment consumer", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /runs-on: \[self-hosted, macOS, ARM64, daily-song-list-mac\]/);
  assert.match(workflow, /concurrency:\n  group: daily-song-list-pg-curation-producer/);
  assert.doesNotMatch(workflow, /deploy-pg-incremental\.yml/);
  assert.doesNotMatch(workflow, /accepted-increment-ready/);
  assert.doesNotMatch(workflow, /\bactivate-pg-candidate\b/);
});

test("curation producer binds rules and active revision before streaming", () => {
  assert.match(workflow, /rules_manifest_sha256:/);
  assert.match(workflow, /expected_active_revision_id:/);
  assert.match(workflow, /RULES_MANIFEST_PATH.*A-Za-z0-9_\.\/-/);
  assert.match(workflow, /test "\$remote_active" = "\$EXPECTED_ACTIVE_REVISION_ID"/);
  assert.match(workflow, /READ ONLY REPEATABLE READ|export-pg-active-curation-snapshot\.py' export/);
  assert.match(workflow, /--expected-active-revision '\$EXPECTED_ACTIVE_REVISION_ID'/);
});

test("VPS receives only small code and rules while the full snapshot streams to a capped Mac root", () => {
  assert.match(workflow, /REMOTE_TASK_ROOT="\/tmp\/daily-song-list-curation-producer-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/);
  assert.match(workflow, /export-pg-active-curation-snapshot\.py/);
  assert.match(workflow, /server\/pg_adapter\.py/);
  assert.match(workflow, /\|[\s\S]*export-pg-active-curation-snapshot\.py" capture/);
  assert.match(workflow, /--max-bytes "\$SNAPSHOT_HARD_CAP_BYTES"/);
  assert.match(workflow, /--max-rows 1000000/);
  assert.doesNotMatch(workflow, /scp[\s\S]{0,240}active-snapshot\.ndjson/);
});

test("producer has explicit expected, hard, task caps and non-resumable checkpoint cleanup", () => {
  assert.match(workflow, /default: 536870912/);
  assert.match(workflow, /default: 1073741824/);
  assert.match(workflow, /default: 2147483648/);
  assert.match(workflow, /--unit='\$REMOTE_UNIT'/);
  assert.match(workflow, /--property=MemorySwapMax=0/);
  assert.match(workflow, /systemctl stop '\$REMOTE_UNIT'/);
  assert.match(workflow, /expected_growth_cap=\$\(\( SNAPSHOT_EXPECTED_MAX_BYTES \* 120 \/ 100 \)\)/);
  assert.match(workflow, /producer-checkpoint\.json/);
  assert.match(workflow, /rm -f -- "\$TASK_ROOT\/active-snapshot\.ndjson"/);
  assert.match(workflow, /rm -rf -- '\$REMOTE_TASK_ROOT'/);
  assert.match(workflow, /taskAfterBytes=0 artifactAfterBytes=0/);
  assert.match(workflow, /remoteSnapshotBytes=0/);
  assert.match(workflow, /retained=github-artifact-only/);
  assert.match(workflow, /"\$RUNNER_TEMP"\/daily-song-list-curation-producer\.\*/);
  assert.match(workflow, /"\$RUNNER_TEMP"\/daily-song-list-curation-artifact\.\*/);
});

test("producer verifies retained audit bytes, digests, and large gzip payloads on Mac", () => {
  assert.match(workflow, /Verify retained curation audit and checkpoint artifacts/);
  assert.match(workflow, /actions\/artifacts\/\$artifact_id\/zip/);
  assert.match(workflow, /20282bfb75aecb92b9e745c1c766fa6fe6a1d1719542fcb80a30a0380b8430d9/);
  assert.match(workflow, /fetch_artifact 8633419597 79947767/);
  assert.match(workflow, /aa7dd87987a39db9f38d8c73b52f2433c0871c90b48ed016c0079cce2e19c2e0/);
  assert.match(workflow, /unzip -tq/);
  assert.match(workflow, /candidate-classifications\.jsonl\.gz/);
  assert.match(workflow, /inventory\.jsonl\.gz/);
  assert.match(workflow, /gzip -t "\$payload"/);
  assert.doesNotMatch(workflow, /\bmapfile\b/);
  assert.match(workflow, /audit\/global-quality\/candidate-classifications\.jsonl\.gz/);
  assert.match(workflow, /checkpoint\/global\/inventory\.jsonl\.gz/);
  assert.match(workflow, /for payload in "\$\{retained_large_gzip\[@\]\}"; do/);
  assert.match(workflow, /retained-artifact-verification\.txt/);
});

test("uploaded artifact excludes the full snapshot and contains only compact evidence", () => {
  const uploadStep = workflow.slice(
    workflow.indexOf("- name: Upload compact curation producer artifact"),
    workflow.indexOf("- name: Cleanup Mac and VPS producer roots"),
  );
  assert.match(uploadStep, /path: \$\{\{ env\.ARTIFACT_ROOT \}\}/);
  assert.doesNotMatch(uploadStep, /active-snapshot\.ndjson/);
  assert.match(workflow, /candidate\.ndjson/);
  assert.match(workflow, /manifest\.json/);
  assert.match(workflow, /review\.json/);
  assert.match(workflow, /storage\.txt/);
  assert.match(workflow, /artifact-sha256\.txt/);
  assert.match(workflow, /retained-artifact-verification\.txt/);
});

test("producer pins the current curation mutation budget", () => {
  assert.match(workflow, /--expected-selector-mutations 0/);
  assert.match(workflow, /--expected-alias-mutations 13/);
});