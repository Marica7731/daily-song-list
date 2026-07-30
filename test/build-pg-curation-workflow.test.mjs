import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const candidateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.resolve(process.env.CURATION_WORKFLOW_PATH || path.join(candidateRoot, ".github/workflows/build-pg-curation-patch.yml"));
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
  assert.match(workflow, /test "\$TASK_HARD_CAP_BYTES" -le 2147483648/);
  assert.match(workflow, /ulimit -v 2097152/);
  assert.match(workflow, /--unit='\$REMOTE_UNIT'/);
  assert.match(workflow, /--property=MemorySwapMax=0/);
  assert.match(workflow, /systemctl stop '\$REMOTE_UNIT'/);
  assert.match(workflow, /expected_growth_cap=\$\(\( SNAPSHOT_EXPECTED_MAX_BYTES \* 120 \/ 100 \)\)/);
  assert.match(workflow, /producer-checkpoint\.json/);
  assert.match(workflow, /rm -f -- "\$TASK_ROOT\/active-snapshot\.ndjson"/);
  assert.match(workflow, /rm -rf -- '\$REMOTE_TASK_ROOT'/);
  assert.match(workflow, /afterBytes=0 afterFreeBytes=/);
  assert.match(workflow, /remoteSnapshotBytes=0/);
  assert.match(workflow, /retained=github-artifact-only/);
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
  assert.match(workflow, /final evidence task cap exceeded/);
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
  assert.match(workflow, /bound-rules-manifest\.json/);
  assert.match(workflow, /current-active-binding\.json/);
});

test("uploaded artifact excludes the full snapshot and contains only compact evidence", () => {
  const uploadStep = workflow.slice(
    workflow.indexOf("- name: Upload compact curation producer artifact"),
    workflow.indexOf("- name: Cleanup Mac and VPS producer roots"),
  );
  assert.match(uploadStep, /if: \$\{\{ always\(\) && env\.ARTIFACT_UPLOAD_READY == 'true' \}\}/);
  assert.match(uploadStep, /path: \$\{\{ env\.ARTIFACT_UPLOAD_PATH \}\}/);
  assert.doesNotMatch(uploadStep, /active-snapshot\.ndjson/);
  assert.match(workflow, /candidate\.ndjson/);
  assert.match(workflow, /manifest\.json/);
  assert.match(workflow, /review\.json/);
  assert.match(workflow, /storage\.txt/);
  assert.match(workflow, /artifact-sha256\.txt/);
  assert.match(workflow, /retained-artifact-verification\.txt/);
  assert.match(workflow, /Prepare bounded producer failure evidence/);
  assert.match(workflow, /if: failure\(\)/);
  assert.match(workflow, /oversizedFailureArtifactBytes/);
  assert.match(workflow, /evidenceTruncated=true/);
  const failureStep = workflow.slice(workflow.indexOf("- name: Prepare bounded producer failure evidence"), workflow.indexOf("- name: Upload compact curation producer artifact"));
  const failureHash = failureStep.lastIndexOf("artifact-sha256.txt");
  const finalFailureCap = failureStep.lastIndexOf('if [ "$failure_artifact_bytes" -gt "$ARTIFACT_UPLOAD_CAP_BYTES" ]; then');
  const finalFailureExit = failureStep.lastIndexOf("exit 78");
  const failureEvidence = failureStep.lastIndexOf("PG_CURATION_PRODUCER_FAILURE_EVIDENCE");
  assert.ok(failureHash >= 0 && finalFailureCap > failureHash && finalFailureExit > finalFailureCap && failureEvidence > finalFailureExit, "failure cap must explicitly stop before the upload evidence marker");
  assert.match(failureStep, /evidenceTruncatedAfterHash=true/);
  assert.match(failureStep, /producerStatus=failure-evidence-minimal/);
  assert.ok(failureStep.indexOf("producerStatus=failure-evidence-minimal") < failureStep.lastIndexOf("artifact-sha256.txt"), "minimal status must be rewritten before final hash");
  assert.match(failureStep, /! -name producer-status\.txt -delete/);
  assert.doesNotMatch(failureStep, /! -name producer-status\.txt ! -name storage\.txt/);
  assert.doesNotMatch(failureStep, /cp[^\n]*active-snapshot/);
  const successStep = workflow.slice(workflow.indexOf("- name: Convert and finalize compact curation artifact"), workflow.indexOf("- name: Prepare bounded producer failure evidence"));
  assert.ok(successStep.indexOf("artifact-sha256.txt") < successStep.lastIndexOf('test "$artifact_bytes" -le "$ARTIFACT_UPLOAD_CAP_BYTES"'));
  assert.match(workflow, /PG_CURATION_PRODUCER_FAILURE_EVIDENCE/);
  assert.match(workflow, /rm -f -- "\$ARTIFACT_ROOT\/active-snapshot\.ndjson"/);
  assert.match(failureStep, /ARTIFACT_UPLOAD_READY=true/);
  assert.match(workflow, /name: Upload compact curation producer artifact\n        if: \$\{\{ always\(\) && env\.ARTIFACT_UPLOAD_READY == 'true' \}\}/);
});

test("producer derives the mutation budget only after binding current-active evidence", () => {
  assert.match(workflow, /--bind-current-active-evidence/);
  assert.match(workflow, /--binding-evidence-output "\$ARTIFACT_ROOT\/current-active-binding\.json"/);
  assert.match(workflow, /--rules-manifest "\$ARTIFACT_ROOT\/bound-rules-manifest\.json"/);
  assert.doesNotMatch(workflow, /--expected-selector-mutations/);
  assert.doesNotMatch(workflow, /--expected-alias-mutations/);
  assert.match(workflow, /final active drift expected=/);
});

test("producer validates the finalized artifact alias review with jq-compatible canonical bytes", () => {
  const successStep = workflow.slice(
    workflow.indexOf("- name: Convert and finalize compact curation artifact"),
    workflow.indexOf("- name: Prepare bounded producer failure evidence"),
  );
  assert.match(successStep, /python3 - "\$ARTIFACT_ROOT\/manifest\.json" <<'PY'/);
  assert.match(successStep, /aliasSourceReview/);
  assert.match(successStep, /selectedIdentityCount/);
  assert.match(successStep, /selectedIdentitiesSha256/);
  assert.match(successStep, /storedRangeId/);
  assert.match(successStep, /alias-source-review-seconds/);
  assert.match(successStep, /alias-source-review-physical-mutation-count/);
  assert.match(successStep, /aliasSourceGroupsSha256/);
  assert.match(successStep, /separators=\(",", ":"\), sort_keys=True\) \+ "\\n"/);
  assert.match(successStep, /alias-source-review-group-ledger-mismatch/);
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
    fs.writeFileSync(path.join(task, "storage.txt"), "baselineFreeBytes=100\nretainedStageBytes=10\nafterConvertBytes=20\n");
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
