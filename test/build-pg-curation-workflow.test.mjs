import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const candidateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.resolve(process.env.CURATION_WORKFLOW_PATH || path.join(candidateRoot, ".github/workflows/build-pg-curation-patch.yml"));
const workflow = fs.readFileSync(workflowPath, "utf8");

function stepRun(name, nextName) {
  const start = workflow.indexOf(`- name: ${name}`);
  const end = workflow.indexOf(`- name: ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `missing workflow step ${name}`);
  const step = workflow.slice(start, end);
  const runStart = step.indexOf("run: |");
  assert.ok(runStart >= 0, `missing run block for ${name}`);
  return step.slice(runStart + "run: |".length)
    .split(/\r?\n/u)
    .filter((line) => !line || line.startsWith("          "))
    .map((line) => line.slice(10))
    .join("\n");
}

function linesBetween(script, startNeedle, endNeedle, includeEnd = false) {
  const lines = script.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.includes(startNeedle));
  const end = lines.findIndex((line, index) => index > start && line.includes(endNeedle));
  assert.ok(start >= 0 && end > start, `missing contract slice ${startNeedle} -> ${endNeedle}`);
  return lines.slice(start, end + (includeEnd ? 1 : 0)).join("\n");
}

function braceContract(script, startNeedle) {
  const lines = script.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.includes(startNeedle));
  const end = lines.findIndex((line, index) => index > start && line.trim() === "}");
  assert.ok(start >= 0 && end > start, `missing brace contract ${startNeedle}`);
  return lines.slice(start, end + 1).join("\n");
}

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
  assert.equal(
    (workflow.match(/default: "artifacts\/migration\/p2-curation-rules\.json"/gu) || []).length,
    2,
    "dispatch and reusable entry points must default to the committed P2 rules manifest",
  );
  assert.doesNotMatch(workflow, /curation-global-singleton-minimal\.json/);
  assert.match(workflow, /RULES_MANIFEST_PATH.*A-Za-z0-9_\.\/-/);
  assert.match(workflow, /test "\$remote_active" = "\$EXPECTED_ACTIVE_REVISION_ID"/);
  assert.match(workflow, /READ ONLY REPEATABLE READ|export-pg-active-curation-snapshot\.py' export/);
  assert.match(workflow, /--expected-active-revision '\$EXPECTED_ACTIVE_REVISION_ID'/);
});

test("rules manifest SHA mismatch fails before producer input use", () => {
  const run = stepRun("Download exact producer inputs", "Prepare bounded SSH helper");
  const contract = linesBetween(run, "actual_rules_sha=", 'find "$PRODUCER_ROOT"');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-curation-rules-sha-"));
  try {
    const producerRoot = path.join(root, "repo");
    const rulesPath = "artifacts/migration/p2-curation-rules.json";
    const target = path.join(producerRoot, rulesPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const raw = Buffer.from("rules-bytes\n");
    fs.writeFileSync(target, raw);
    const expected = createHash("sha256").update(raw).digest("hex");
    const env = { ...process.env, PRODUCER_ROOT: producerRoot, RULES_MANIFEST_PATH: rulesPath };
    const good = spawnSync("bash", ["-s"], { input: contract, encoding: "utf8", env: { ...env, RULES_MANIFEST_SHA256: expected } });
    assert.equal(good.status, 0, good.stderr);
    const mismatch = spawnSync("bash", ["-s"], { input: contract, encoding: "utf8", env: { ...env, RULES_MANIFEST_SHA256: "0".repeat(64) } });
    assert.equal(mismatch.status, 78, mismatch.stderr);
    assert.match(mismatch.stderr, /PG_CURATION_PRODUCER_INTEGRITY_FAILED rules SHA/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("initial active revision drift fails without overwriting caller CAS", () => {
  const run = stepRun("Verify active revision and install only small remote inputs", "Stream active snapshot to capped Mac task root");
  const contract = braceContract(run, 'test "$remote_active" = "$EXPECTED_ACTIVE_REVISION_ID"');
  assert.doesNotMatch(run, /export EXPECTED_ACTIVE_REVISION_ID=|printf 'EXPECTED_ACTIVE_REVISION_ID=/);
  const good = spawnSync("bash", ["-s"], { input: contract, encoding: "utf8", env: { ...process.env, remote_active: "active-a", EXPECTED_ACTIVE_REVISION_ID: "active-a" } });
  assert.equal(good.status, 0, good.stderr);
  const mismatch = spawnSync("bash", ["-s"], { input: contract, encoding: "utf8", env: { ...process.env, remote_active: "active-b", EXPECTED_ACTIVE_REVISION_ID: "active-a" } });
  assert.equal(mismatch.status, 75, mismatch.stderr);
  assert.match(mismatch.stderr, /PG_CURATION_PRODUCER_PARENT_CAS_FAILED/);
});

test("final active revision drift fails before conversion", () => {
  const run = stepRun("Convert and finalize compact curation artifact", "Prepare bounded producer failure evidence");
  const contract = braceContract(run, 'test "$final_remote_active" = "$EXPECTED_ACTIVE_REVISION_ID"');
  const good = spawnSync("bash", ["-s"], { input: contract, encoding: "utf8", env: { ...process.env, final_remote_active: "active-a", EXPECTED_ACTIVE_REVISION_ID: "active-a" } });
  assert.equal(good.status, 0, good.stderr);
  const mismatch = spawnSync("bash", ["-s"], { input: contract, encoding: "utf8", env: { ...process.env, final_remote_active: "active-b", EXPECTED_ACTIVE_REVISION_ID: "active-a" } });
  assert.equal(mismatch.status, 75, mismatch.stderr);
  assert.match(mismatch.stderr, /PG_CURATION_PRODUCER_PARENT_CAS_FAILED final active drift/);
});

test("artifact digest mismatch or unstable evidence never enables upload", () => {
  const run = stepRun("Convert and finalize compact curation artifact", "Prepare bounded producer failure evidence");
  const lines = run.split(/\r?\n/u);
  const digestLine = lines.findIndex((line) => line.includes("shasum -a 256 -c artifact-sha256.txt"));
  const digestStart = lines.findLastIndex((line, index) => index < digestLine && line.trim() === "(");
  const digestEnd = lines.findIndex((line, index) => index > digestLine && line.trim() === "}");
  assert.ok(digestStart >= 0 && digestEnd > digestLine, "missing digest integrity contract");
  const digestContract = lines.slice(digestStart, digestEnd + 1).join("\n");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-curation-digest-integrity-"));
  try {
    const artifact = path.join(root, "upload");
    fs.mkdirSync(artifact);
    fs.writeFileSync(path.join(artifact, "candidate.ndjson"), "candidate\n");
    fs.writeFileSync(path.join(artifact, "artifact-sha256.txt"), `${"0".repeat(64)}  candidate.ndjson\n`);
    const digestMismatch = spawnSync("bash", ["-s"], { input: digestContract, encoding: "utf8", env: { ...process.env, ARTIFACT_ROOT: artifact } });
    assert.equal(digestMismatch.status, 78, digestMismatch.stderr);
    assert.match(digestMismatch.stderr, /PG_CURATION_PRODUCER_INTEGRITY_FAILED artifact digest mismatch/);

    const stabilizationContract = linesBetween(
      run,
      'test "$final_upload_verified" = true',
      "printf 'ARTIFACT_UPLOAD_READY=true",
      true,
    );
    const githubEnv = path.join(root, "github-env");
    const unstable = spawnSync("bash", ["-s"], {
      input: stabilizationContract,
      encoding: "utf8",
      env: { ...process.env, final_upload_verified: "false", task_peak_bytes: "1", ARTIFACT_ROOT: artifact, GITHUB_ENV: githubEnv },
    });
    assert.equal(unstable.status, 78, unstable.stderr);
    assert.match(unstable.stderr, /PG_CURATION_PRODUCER_INTEGRITY_FAILED final evidence peak did not stabilize/);
    assert.equal(fs.existsSync(githubEnv), false, "unstable evidence must not export ARTIFACT_UPLOAD_READY");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VPS receives only small code and rules while the full snapshot streams to the Mac task root", () => {
  assert.match(workflow, /REMOTE_TASK_ROOT="\/tmp\/daily-song-list-curation-producer-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/);
  assert.match(workflow, /export-pg-active-curation-snapshot\.py/);
  assert.match(workflow, /server\/pg_adapter\.py/);
  assert.match(workflow, /\|[\s\S]*export-pg-active-curation-snapshot\.py" capture/);
  assert.match(workflow, /--output "\$SNAPSHOT_PATH"/);
  assert.match(workflow, /--checkpoint-output "\$SNAPSHOT_CHECKPOINT"/);
  assert.doesNotMatch(workflow, /scp[\s\S]{0,240}active-snapshot\.ndjson/);
});

test("producer observes storage caps, directly executes converters, and cleans the snapshot", () => {
  assert.match(workflow, /default: 536870912/);
  assert.match(workflow, /default: 1073741824/);
  assert.match(workflow, /default: 2147483648/);
  assert.doesNotMatch(workflow, /\bulimit\s+-v\b/);
  assert.match(workflow, /readonly MAC_CONVERTER_RSS_LIMIT_BYTES=0/);
  assert.match(workflow, /run_with_rss_watchdog\(\) \{\s+shift 2\s+"\$@"\s+\}/);
  assert.doesNotMatch(workflow, /ps -o rss= -p "\$child_pid"|kill -(?:TERM|KILL) "\$child_pid"/);
  assert.equal(
    (workflow.match(/run_with_rss_watchdog "\$MAC_CONVERTER_RSS_LIMIT_BYTES" (?:bind-current-active|build-candidate)/g) || []).length,
    2,
    "both converter invocations must directly execute through the compatibility wrapper",
  );
  assert.match(workflow, /--unit='\$REMOTE_UNIT'/);
  assert.match(workflow, /--property=MemorySwapMax=0/);
  assert.match(workflow, /systemctl stop '\$REMOTE_UNIT'/);
  assert.match(workflow, /PG_CURATION_PRODUCER_OBSERVATION expected snapshot growth exceeded/);
  assert.match(workflow, /producer-checkpoint\.json/);
  assert.match(workflow, /rm -f -- "\$TASK_ROOT\/active-snapshot\.ndjson"/);
  assert.match(workflow, /rm -rf -- '\$REMOTE_TASK_ROOT'/);
  assert.match(workflow, /afterBytes=0 afterFreeBytes=/);
  assert.match(workflow, /remoteSnapshotBytes=0/);
  assert.match(workflow, /"\$RUNNER_TEMP"\/daily-song-list-curation-producer\.\*/);
  assert.match(workflow, /ARTIFACT_ROOT="\$TASK_ROOT\/upload"/);
  assert.match(workflow, /test "\$ARTIFACT_ROOT" = "\$TASK_ROOT\/upload"/);
  assert.equal((workflow.match(/mktemp -d/g) || []).length, 1, "producer must have one Mac temp root");
  assert.match(workflow, /afterFinalizeBytes=/);
  assert.match(workflow, /afterConvertBytes=/);
  assert.match(workflow, /afterSnapshotRemovalBytes=/);
  assert.match(workflow, /final_storage="\$TASK_ROOT\/final-storage\.txt"/);
  assert.match(workflow, /final_artifact_bytes=/);
  assert.match(workflow, /shasum -a 256 -c artifact-sha256\.txt/);
  assert.match(workflow, /beforeCleanupBytes=\$task_before_bytes afterBytes=0/);
  assert.doesNotMatch(workflow, /rm -rf -- "\$ARTIFACT_ROOT"/);
});

test("producer records the single-root peak after conversion and before snapshot removal", () => {
  const successStep = workflow.slice(
    workflow.indexOf("- name: Convert and finalize compact curation artifact"),
    workflow.indexOf("- name: Prepare bounded producer failure evidence"),
  );
  const afterConvert = successStep.indexOf("task_after_convert_bytes=");
  const finalize = successStep.indexOf("export-pg-active-curation-snapshot.py\" finalize");
  const beforeRemoval = successStep.lastIndexOf("task_before_snapshot_removal_bytes=");
  const removal = successStep.indexOf('rm -f -- "$TASK_ROOT/active-snapshot.ndjson"');
  assert.ok(afterConvert >= 0 && afterConvert < finalize, "converter output must be included in the task peak before finalize");
  assert.ok(beforeRemoval > finalize && beforeRemoval < removal, "final artifact peak must be checked while snapshot still exists");
  assert.ok(successStep.lastIndexOf('test "$task_peak_bytes" -le "$TASK_HARD_CAP_BYTES"') > beforeRemoval);
});

test("producer has no historical retained-artifact dependency and uses only this run current-active evidence", () => {
  for (const staleEvidence of [
    /Verify retained curation audit and checkpoint artifacts/,
    /actions\/artifacts\/\$artifact_id\/zip/,
    /8633425268/,
    /8633419597/,
    /audit\.zip/,
    /checkpoint\.zip/,
    /candidate-classifications\.jsonl\.gz/,
    /inventory\.jsonl\.gz/,
    /RETAINED_ROOT/,
    /retained-artifact-verification\.txt/,
    /retainedArtifactBytes/,
    /retainedStageBytes/,
  ]) {
    assert.doesNotMatch(workflow, staleEvidence);
  }
  assert.match(workflow, /active-snapshot\.ndjson/);
  assert.match(workflow, /snapshot-checkpoint\.json/);
  assert.match(workflow, /--checkpoint-output "\$SNAPSHOT_CHECKPOINT"/);
  assert.match(workflow, /--snapshot-checkpoint "\$TASK_ROOT\/snapshot-checkpoint\.json"/);
  assert.match(workflow, /--bind-current-active-evidence/);
  assert.match(workflow, /bound-rules-manifest\.json/);
  assert.match(workflow, /current-active-binding\.json/);
  assert.match(workflow, /--producer-commit "\$GITHUB_SHA"/);
  assert.match(workflow, /shasum -a 256 -c artifact-sha256\.txt/);
});

test("uploaded artifact keeps candidate and manifest at the artifact root", () => {
  const uploadStep = workflow.slice(
    workflow.indexOf("- name: Upload compact curation producer artifact"),
    workflow.indexOf("- name: Cleanup Mac and VPS producer roots"),
  );
  const successStep = workflow.slice(
    workflow.indexOf("- name: Convert and finalize compact curation artifact"),
    workflow.indexOf("- name: Prepare bounded producer failure evidence"),
  );
  assert.match(uploadStep, /if: \$\{\{ always\(\) && env\.ARTIFACT_UPLOAD_READY == 'true' \}\}/);
  assert.match(uploadStep, /path: \$\{\{ env\.ARTIFACT_UPLOAD_PATH \}\}/);
  assert.doesNotMatch(uploadStep, /active-snapshot\.ndjson/);
  assert.match(successStep, /--output "\$ARTIFACT_ROOT\/candidate\.ndjson"/);
  assert.match(successStep, /--output-manifest "\$ARTIFACT_ROOT\/manifest\.json"/);
  assert.doesNotMatch(successStep, /--output "\$TASK_ROOT\/candidate\.ndjson"|--output-manifest "\$TASK_ROOT\/manifest\.json"/);
  assert.match(workflow, /review\.json/);
  assert.match(workflow, /storage\.txt/);
  assert.match(workflow, /artifact-sha256\.txt/);
  assert.match(workflow, /Prepare bounded producer failure evidence/);
  assert.match(workflow, /if: failure\(\)/);
  const failureStep = workflow.slice(workflow.indexOf("- name: Prepare bounded producer failure evidence"), workflow.indexOf("- name: Upload compact curation producer artifact"));
  assert.match(failureStep, /producerStatus=failure-evidence-minimal/);
  assert.match(failureStep, /evidenceTruncatedAfterHash=true/);
  assert.doesNotMatch(failureStep, /cp[^\n]*active-snapshot/);
  assert.match(failureStep, /ARTIFACT_UPLOAD_READY=true/);
  assert.match(workflow, /PG_CURATION_PRODUCER_FAILURE_EVIDENCE/);
  assert.match(workflow, /rm -f -- "\$ARTIFACT_ROOT\/active-snapshot\.ndjson"/);
});

test("producer derives the mutation budget only after binding current-active evidence", () => {
  assert.match(workflow, /--bind-current-active-evidence/);
  assert.match(workflow, /--binding-evidence-output "\$ARTIFACT_ROOT\/current-active-binding\.json"/);
  assert.match(workflow, /--rules-manifest "\$ARTIFACT_ROOT\/bound-rules-manifest\.json"/);
  assert.doesNotMatch(workflow, /--expected-selector-mutations/);
  assert.doesNotMatch(workflow, /--expected-alias-mutations/);
  assert.match(workflow, /final active drift expected=/);
});

test("producer removes alias-review blocking code and directly writes resumable artifact files", () => {
  const successStep = workflow.slice(
    workflow.indexOf("- name: Convert and finalize compact curation artifact"),
    workflow.indexOf("- name: Prepare bounded producer failure evidence"),
  );
  assert.match(successStep, /run_with_rss_watchdog\(\) \{\s+shift 2\s+"\$@"\s+\}/);
  assert.match(successStep, /--output "\$ARTIFACT_ROOT\/candidate\.ndjson"/);
  assert.match(successStep, /--output-manifest "\$ARTIFACT_ROOT\/manifest\.json"/);
  assert.doesNotMatch(successStep, /selectedIdentityCount|selectedIdentitiesSha256|alias-source-review-physical-mutation-count/);
  const bash = successStep.slice(successStep.indexOf("run: |") + "run: |".length)
    .split(/\r?\n/u)
    .filter((line) => !line || line.startsWith("          "))
    .map((line) => line.slice(10))
    .join("\n");
  const syntax = spawnSync("bash", ["-n"], { input: bash, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("success evidence stabilizes final storage, bytes, peak, and digest inside the one task root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-curation-success-evidence-"));
  try {
    const task = path.join(root, "daily-song-list-curation-producer.case");
    const artifact = path.join(task, "upload");
    const githubEnv = path.join(root, "github-env");
    fs.mkdirSync(artifact, { recursive: true });
    fs.writeFileSync(path.join(task, "active-snapshot.ndjson"), Buffer.alloc(512 * 1024, "s"));
    fs.writeFileSync(path.join(task, "converter-manifest.json"), "converter\n");
    fs.writeFileSync(path.join(artifact, "candidate.ndjson"), "candidate\n");
    fs.writeFileSync(path.join(artifact, "manifest.json"), "manifest\n");
    fs.writeFileSync(path.join(artifact, "review.json"), "review\n");
    fs.writeFileSync(path.join(artifact, "producer-status.txt"), "producerStatus=success\n");
    fs.writeFileSync(path.join(task, "storage.txt"), "baselineFreeBytes=100\nafterConvertBytes=20\n");
    const fixture = path.join(root, "success-evidence.sh");
    fs.writeFileSync(fixture, String.raw`set -Eeuo pipefail
test "$ARTIFACT_ROOT" = "$TASK_ROOT/upload"
TASK_HARD_CAP_BYTES=10485760
ARTIFACT_UPLOAD_CAP_BYTES=67108864
snapshot_bytes=$(wc -c < "$TASK_ROOT/active-snapshot.ndjson" | tr -d '[:space:]')
find "$ARTIFACT_ROOT" -maxdepth 1 -type f ! -name artifact-sha256.txt -print0 |
  xargs -0 shasum -a 256 > "$ARTIFACT_ROOT/artifact-sha256.txt"
artifact_bytes=$(( $(du -sk "$ARTIFACT_ROOT" | awk '{print $1}') * 1024 ))
task_peak_bytes=$(( $(du -sk "$TASK_ROOT" | awk '{print $1}') * 1024 ))
test "$artifact_bytes" -le "$ARTIFACT_UPLOAD_CAP_BYTES"
test "$task_peak_bytes" -le "$TASK_HARD_CAP_BYTES"
task_before_snapshot_removal_bytes=$(( $(du -sk "$TASK_ROOT" | awk '{print $1}') * 1024 ))
if [ "$task_before_snapshot_removal_bytes" -gt "$task_peak_bytes" ]; then task_peak_bytes="$task_before_snapshot_removal_bytes"; fi
rm -f -- "$TASK_ROOT/active-snapshot.ndjson"
test ! -e "$TASK_ROOT/active-snapshot.ndjson"
task_after_snapshot_removal_bytes=$(( $(du -sk "$TASK_ROOT" | awk '{print $1}') * 1024 ))
final_upload_verified=false
final_storage="$TASK_ROOT/final-storage.txt"
for final_pass in 1 2 3; do
  awk '!/^(snapshotBytes|afterFinalizeBytes|afterSnapshotRemovalBytes|snapshotAfterFinalizeBytes|artifactBytes|taskPeakBytes|finalEvidencePass)=/' \
    "$TASK_ROOT/storage.txt" > "$final_storage"
  printf 'snapshotBytes=%s\nafterFinalizeBytes=%s\nafterSnapshotRemovalBytes=%s\nsnapshotAfterFinalizeBytes=0\nartifactBytes=%s\ntaskPeakBytes=%s\nfinalEvidencePass=%s\n' \
    "$snapshot_bytes" "$task_before_snapshot_removal_bytes" "$task_after_snapshot_removal_bytes" \
    "$artifact_bytes" "$task_peak_bytes" "$final_pass" >> "$final_storage"
  cp "$final_storage" "$ARTIFACT_ROOT/storage.txt"
  rm -f -- "$ARTIFACT_ROOT/artifact-sha256.txt"
  find "$ARTIFACT_ROOT" -maxdepth 1 -type f ! -name artifact-sha256.txt -print0 |
    xargs -0 shasum -a 256 > "$ARTIFACT_ROOT/artifact-sha256.txt"
  final_artifact_bytes=$(( $(du -sk "$ARTIFACT_ROOT" | awk '{print $1}') * 1024 ))
  test "$final_artifact_bytes" -le "$ARTIFACT_UPLOAD_CAP_BYTES"
  task_final_evidence_bytes=$(( $(du -sk "$TASK_ROOT" | awk '{print $1}') * 1024 ))
  test "$task_final_evidence_bytes" -le "$TASK_HARD_CAP_BYTES"
  if [ "$task_final_evidence_bytes" -gt "$task_peak_bytes" ]; then task_peak_bytes="$task_final_evidence_bytes"; continue; fi
  if [ "$final_artifact_bytes" -ne "$artifact_bytes" ]; then artifact_bytes="$final_artifact_bytes"; continue; fi
  ( cd "$ARTIFACT_ROOT"; shasum -a 256 -c artifact-sha256.txt )
  final_upload_verified=true
  break
done
test "$final_upload_verified" = true
printf 'ARTIFACT_UPLOAD_READY=true\nARTIFACT_UPLOAD_PATH=%s\n' "$ARTIFACT_ROOT" >> "$GITHUB_ENV"
`);
    const result = spawnSync("bash", [fixture], {
      encoding: "utf8",
      env: { ...process.env, TASK_ROOT: task, ARTIFACT_ROOT: artifact, GITHUB_ENV: githubEnv },
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(fs.readFileSync(githubEnv, "utf8"), /ARTIFACT_UPLOAD_READY=true/);
    assert.match(fs.readFileSync(githubEnv, "utf8"), new RegExp(`ARTIFACT_UPLOAD_PATH=${artifact.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`));
    const fields = fs.readFileSync(path.join(artifact, "storage.txt"), "utf8").trim().split("\n");
    const values = new Map(fields.map((line) => line.split("=", 2)));
    assert.equal(values.size, fields.length, "final storage must not append duplicate evidence keys");
    for (const key of ["snapshotBytes", "afterFinalizeBytes", "afterSnapshotRemovalBytes", "snapshotAfterFinalizeBytes", "artifactBytes", "taskPeakBytes", "finalEvidencePass"]) {
      assert.ok(values.has(key), `missing ${key}`);
    }
    const actualArtifactBytes = Number(spawnSync("du", ["-sk", artifact], { encoding: "utf8" }).stdout.trim().split(/\s+/u)[0]) * 1024;
    assert.equal(Number(values.get("artifactBytes")), actualArtifactBytes);
    assert.ok(Number(values.get("taskPeakBytes")) >= Number(values.get("afterFinalizeBytes")));
    assert.ok(Number(values.get("taskPeakBytes")) >= Number(values.get("afterSnapshotRemovalBytes")));
    assert.ok(Number(values.get("afterSnapshotRemovalBytes")) < Number(values.get("afterFinalizeBytes")));
    assert.equal(fs.existsSync(path.join(task, "active-snapshot.ndjson")), false);
    const digest = spawnSync("shasum", ["-a", "256", "-c", "artifact-sha256.txt"], { cwd: artifact, encoding: "utf8" });
    assert.equal(digest.status, 0, `${digest.stderr}\n${digest.stdout}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failure evidence executes a deterministic minimal rebuild before always-upload", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-curation-failure-cap-"));
  try {
    const task = path.join(root, "daily-song-list-curation-producer.case");
    const artifact = path.join(task, "upload");
    fs.mkdirSync(task);
    fs.mkdirSync(artifact);
    fs.writeFileSync(path.join(task, "storage.txt"), Buffer.alloc(67_200_000));
    const step = workflow.slice(
      workflow.indexOf("- name: Prepare bounded producer failure evidence"),
      workflow.indexOf("- name: Upload compact curation producer artifact"),
    );
    const run = step.slice(step.indexOf("run: |") + "run: |".length)
      .split(/\r?\n/u)
      .filter((line) => !line || line.startsWith("          "))
      .map((line) => line.slice(10))
      .join("\n");
    const result = spawnSync("bash", ["-s"], {
      input: run,
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        ARTIFACT_ROOT: artifact,
        TASK_ROOT: task,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        ARTIFACT_UPLOAD_CAP_BYTES: "67108864",
        GITHUB_ENV: path.join(root, "github-env"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(path.join(artifact, "producer-status.txt"), "utf8"), /failure-evidence-minimal/);
    assert.deepEqual(fs.readdirSync(artifact).sort(), ["artifact-sha256.txt", "producer-status.txt"]);
    assert.ok(fs.statSync(path.join(artifact, "artifact-sha256.txt")).size > 0);
    assert.match(fs.readFileSync(path.join(root, "github-env"), "utf8"), /ARTIFACT_UPLOAD_READY=true/);

    const unsafeEnv = path.join(root, "github-env-unsafe");
    const unsafe = spawnSync("bash", ["-s"], {
      input: run,
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        ARTIFACT_ROOT: path.join(root, "outside-upload"),
        TASK_ROOT: task,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        ARTIFACT_UPLOAD_CAP_BYTES: "67108864",
        GITHUB_ENV: unsafeEnv,
      },
    });
    assert.equal(unsafe.status, 78, unsafe.stderr);
    assert.equal(fs.existsSync(unsafeEnv), false, "an external upload root must not be enabled");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("oversized minimal failure evidence exits and leaves the upload gate false", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-curation-failure-extreme-"));
  try {
    const task = path.join(root, "daily-song-list-curation-producer.case");
    const artifact = path.join(task, "upload");
    const githubEnv = path.join(root, "github-env");
    fs.mkdirSync(task);
    fs.mkdirSync(artifact);
    fs.writeFileSync(path.join(task, "storage.txt"), Buffer.alloc(67_200_000));
    // A nested unexpected payload survives the top-level minimal rebuild;
    // the final byte check must still fail closed instead of enabling upload.
    fs.mkdirSync(path.join(artifact, "unexpected"));
    fs.writeFileSync(path.join(artifact, "unexpected", "still-large.bin"), Buffer.alloc(67_200_000));
    const fixture = path.join(root, "failure-evidence.sh");
    fs.writeFileSync(fixture, String.raw`set +e
printf 'producerStatus=failure\n' > "$ARTIFACT_ROOT/producer-status.txt"
find "$ARTIFACT_ROOT" -maxdepth 1 -type f ! -name artifact-sha256.txt -print0 | xargs -0 shasum -a 256 > "$ARTIFACT_ROOT/artifact-sha256.txt"
failure_artifact_bytes=$(( $(du -sk "$ARTIFACT_ROOT" | awk '{print $1}') * 1024 ))
if [ "$failure_artifact_bytes" -gt "$ARTIFACT_UPLOAD_CAP_BYTES" ]; then
  rm -f -- "$ARTIFACT_ROOT/artifact-sha256.txt"
  find "$ARTIFACT_ROOT" -maxdepth 1 -type f ! -name producer-status.txt -delete
  printf 'producerStatus=failure-evidence-minimal\n' > "$ARTIFACT_ROOT/producer-status.txt"
  find "$ARTIFACT_ROOT" -maxdepth 1 -type f ! -name artifact-sha256.txt -print0 | xargs -0 shasum -a 256 > "$ARTIFACT_ROOT/artifact-sha256.txt"
  failure_artifact_bytes=$(( $(du -sk "$ARTIFACT_ROOT" | awk '{print $1}') * 1024 ))
fi
if [ "$failure_artifact_bytes" -gt "$ARTIFACT_UPLOAD_CAP_BYTES" ]; then
  exit 78
fi
printf 'ARTIFACT_UPLOAD_READY=true\n' >> "$GITHUB_ENV"
`);
    const result = spawnSync("bash", [fixture], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: root, ARTIFACT_ROOT: artifact, TASK_ROOT: task, GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1", ARTIFACT_UPLOAD_CAP_BYTES: "1", GITHUB_ENV: githubEnv },
    });
    assert.equal(result.status, 78, `${result.stderr}\n${result.stdout}`);
    assert.equal(fs.existsSync(githubEnv), false, "over-cap minimal evidence must not export READY");
    assert.match(fs.readFileSync(path.join(artifact, "producer-status.txt"), "utf8"), /failure-evidence-minimal/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
