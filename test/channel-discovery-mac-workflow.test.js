const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const candidateRoot = path.join(__dirname, "..");
const workflowPath = path.join(candidateRoot, ".github", "workflows", "discover-one-channel-candidate.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");
const workflowLines = workflow.split("\n");

const expectedSourceFiles = new Map([
  ["assets/frontend-utils.js", ["81218", "946d916ec7af96b557a5f06003eec68578b9165a"]],
  ["assets/ranking-utils.js", ["59367", "2623a2f5e5d9bd688e694e1759fcc85d621d746a"]],
  ["assets/source-filter.js", ["61184", "54f8a1aacaed8471859cafd32d8fddd62ef06714"]],
  ["config/blocked-vtuber-channels.json", ["40392", "dcd02068f31a32b654a4baf26488e16a6289ee27"]],
  ["scripts/blocked-vtuber-utils.js", ["13983", "ae88220a840c0350d879c86b745af62951bee9cc"]],
  ["scripts/build-runtime-data.js", ["92299", "1afab30a25df5af27917534326e6469d22c2ca94"]],
  ["scripts/channel-discovery-candidate-artifact-gate.jq", ["9618", "54e348c83453515fa560d2a264a1307ceb8be2bb"]],
  ["scripts/channel-discovery-candidate-records-gate.jq", ["6993", "25097ed05c3abcf616e9fcb0f3a6e3d73136d22c"]],
  ["scripts/channel-metadata-cache.js", ["9419", "85d3caffac760d3e9e47f855157070645d81541e"]],
  ["scripts/curation.js", ["43979", "b3bc02ce4058ec1cd30e2df5df9da941ada1d511"]],
  ["scripts/entry-repair.js", ["24257", "970ec9d8e9bdfae21c3e904fe241547ad20de0a5"]],
  ["scripts/range-config.js", ["2160", "49d23580a15d32aaa201a68cc64cf405087ed456"]],
  ["scripts/recent-all-continuity.js", ["2452", "6411fe3212fc83648e962c247f7de21495783d64"]],
  ["scripts/song-aliases.js", ["5296", "16adce1dc66253a968c8dcd7702bb5fff247f8bd"]],
  ["scripts/song-search-index.js", ["16185", "76a920c26b01b2e3253ea52a8299602e6f82b62e"]],
  ["scripts/song-utils.js", ["60926", "b6202d3d3186adb76dfd2beb4b8fae1cdc4f10b7"]],
  ["scripts/update-songlist.js", ["137229", "cec90db7bb8b27f308908ce1e91d838d7d5789f1"]],
  ["scripts/video-catalog.js", ["18509", "fa561d4780156e9a37b908cbfeb174671c3b6ffa"]],
  ["scripts/vsinger-http/html-utils.js", ["4045", "68533aafd3df5c53c8a4fdd4b0cb416e34b764c1"]],
  ["scripts/vsinger-http/http-client.js", ["7000", "86e7317b3e0904ade6d39945df5888e11da46562"]],
  ["scripts/vsinger-http/model.js", ["4678", "811a8d65ae37f657717de4a8dc4c7320e00ef694"]],
  ["scripts/vsinger-http/runtime-importer.js", ["21502", "32e39dfd70200b0c6494b254695e33108f22f2fc"]],
  ["scripts/youtube-channel-discovery-core.js", ["90744", "fc08097cb9ccc67b3f179670b592d64ecc3fd6a8"]],
  ["scripts/youtube-channel-discovery.js", ["2444", "1d78bdeeefe0b9dc6db6e7caf185f531cfed51b4"]],
]);

function runBlocks(source = workflow) {
  const lines = source.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s{8}run: \|\s*$/u.test(lines[index])) continue;
    const body = [];
    for (index += 1; index < lines.length; index += 1) {
      if (lines[index] === "") {
        body.push("");
        continue;
      }
      if (!/^ {10}/u.test(lines[index])) break;
      body.push(lines[index].slice(10));
    }
    index -= 1;
    blocks.push(body.join("\n"));
  }
  return blocks;
}

function pinnedSourceRows(source = workflow) {
  const match = source.match(/done <<'PINNED_SOURCE_FILES'\n([\s\S]*?)\n {10}PINNED_SOURCE_FILES/u);
  assert.ok(match, "pinned source file block is missing");
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("|"));
}

function diagnosticFunctionBlock(source = workflow) {
  const match = source.match(
    / {10}# DIAGNOSTIC_FUNCTION_BEGIN\n([\s\S]*?) {10}# DIAGNOSTIC_FUNCTION_END/u,
  );
  assert.ok(match, "bounded discovery diagnostic function is missing");
  return match[1]
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
}

test("workflow has no repository checkout, Git command, or workspace dependency", () => {
  assert.doesNotMatch(workflow, /actions\/checkout|actions\/setup-node|GITHUB_WORKSPACE|(?:^|\s)git(?:\s|$)/mu);
  assert.match(workflow, /Prepare pinned source bundle/u);
  assert.match(workflow, /https:\/\/raw\.githubusercontent\.com\/\$GITHUB_REPOSITORY\/\$GITHUB_SHA/u);
  assert.match(workflow, /\[\[ "\$GITHUB_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/u);
});

test("installed Mac Node is resolved once, version-checked, and propagated as an absolute executable", () => {
  assert.match(
    workflow,
    /export PATH="\/Users\/be\/\.local\/codex-toolchains\/node\/bin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\/Users\/be\/\.local\/bin:\$PATH"/u,
  );
  assert.match(workflow, /NODE_BIN="\$\(command -v node \|\| true\)"/u);
  assert.match(workflow, /\[ -n "\$NODE_BIN" \] && \[ -x "\$NODE_BIN" \] \|\| fail "node-runtime-missing"/u);
  assert.match(workflow, /case "\$NODE_BIN" in \/\*\) ;; \*\) fail "node-runtime-not-absolute" ;; esac/u);
  assert.ok(workflow.includes('NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null || true)"'));
  assert.ok(workflow.includes('[[ "$NODE_VERSION" =~ ^v([0-9]+)\\. ]] || fail "node-version-invalid"'));
  assert.match(workflow, /\[ "\$\{BASH_REMATCH\[1\]\}" -ge 18 \] \|\| fail "node-version-unsupported"/u);
  assert.match(workflow, /printf '%s\\n' "\$\(dirname "\$NODE_BIN"\)" >> "\$GITHUB_PATH"/u);
  assert.match(workflow, /printf 'NODE_BIN=%s\\n' "\$NODE_BIN" >> "\$GITHUB_ENV"/u);
  assert.match(workflow, /CHANNEL_DISCOVERY_NODE_RUNTIME path=%s version=%s/u);
  assert.doesNotMatch(workflow, /curl[\s\S]{0,120}(?:nodejs\.org|node-v[0-9]|setup-node)/iu);
  assert.doesNotMatch(workflow, /(?:^|[ =])node (?=--check|--max-old-space-size|-e)/mu);
  assert.ok((workflow.match(/"\$NODE_BIN"/gu) || []).length >= 10);
});

test("pinned source bundle is the exact audited runtime and gate closure", () => {
  const actual = new Map(
    pinnedSourceRows().map(([relative, bytes, blob]) => [relative, [bytes, blob]]),
  );
  assert.deepEqual(actual, expectedSourceFiles);
  assert.equal(actual.size, 24);
  assert.equal([...actual.keys()].filter((file) => file.endsWith(".js")).length, 21);
  for (const [relative, [bytes, blob]] of actual) {
    assert.match(relative, /^(?:assets|config|scripts)\//u);
    assert.match(bytes, /^[1-9][0-9]*$/u);
    assert.match(blob, /^[0-9a-f]{40}$/u);
  }
});

test("each downloaded file is fail-closed on HTTP, exact size, Git blob SHA, and JS compile", () => {
  assert.match(workflow, /curl --fail --location --silent --show-error/u);
  assert.match(workflow, /--connect-timeout 10 --max-time 60 --max-filesize 262144[\s\S]*--retry 3 --retry-all-errors/u);
  assert.match(workflow, /\[ "\$actual_bytes" = "\$expected_bytes" \] \|\| fail "size-\$relative"/u);
  assert.match(workflow, /printf 'blob %s\\0' "\$actual_bytes"/u);
  assert.match(workflow, /\[ "\$actual_blob_sha" = "\$expected_blob_sha" \] \|\| fail "sha-\$relative"/u);
  assert.match(workflow, /"\$NODE_BIN" --check "\$js_file"/u);
  assert.match(workflow, /source-module-load/u);
  assert.match(workflow, /SOURCE_BUNDLE_CAP_BYTES: "2097152"/u);
  assert.match(workflow, /\[ "\$source_files" -eq 24 \]/u);
  assert.match(workflow, /\[ "\$js_files" -eq 21 \]/u);
});

test("false force-refresh path is Bash-3-safe and cannot receive fresh", () => {
  assert.doesNotMatch(workflow, /FRESH_ARGS|\$\{[^}\n]*\[@\]\}/u);
  const branch = workflow.match(
    /if \[ "\$FORCE_REFRESH" = "true" \]; then\n([\s\S]*?)\n {10}else\n([\s\S]*?)\n {10}fi\n {10}discovery_pid=\$!/u,
  );
  assert.ok(branch, "literal force-refresh branch is missing");
  assert.match(branch[1], /--fresh/u);
  assert.doesNotMatch(branch[2], /--fresh/u);
  assert.match(branch[1], /--candidate-only/u);
  assert.match(branch[2], /--candidate-only/u);

  for (const value of ["false", "true"]) {
    const probe = spawnSync("bash", ["-u", "-c", `
      FORCE_REFRESH="$1"
      if [ "$FORCE_REFRESH" = "true" ]; then
        printf '%s\n' fresh
      else
        printf '%s\n' continuation
      fi
    `, "probe", value], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout.trim(), value === "true" ? "fresh" : "continuation");
  }
});

test("workflow dispatch contract remains strict, generic, and candidate-only", () => {
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.match(workflow, /^  cancel-in-progress: false$/mu);
  assert.match(workflow, /^    runs-on: \[self-hosted, macOS, ARM64, daily-song-list-mac\]$/mu);
  assert.match(workflow, /^    timeout-minutes: 25$/mu);
  for (const input of ["channel_id", "channel_handle", "channel_slug"]) {
    assert.match(workflow, new RegExp(`^      ${input}:\\n(?: {8}.+\\n)* {8}required: true$`, "mu"));
  }
  assert.match(workflow, /^        options: \["10", "25"\]$/mu);
  assert.match(workflow, /^        options: \["250", "500", "1000"\]$/mu);
  assert.match(workflow, /^        options: \["false", "true"\]$/mu);
  assert.match(workflow, /^        default: "false"$/mu);
  assert.match(workflow, /--tab streams[\s\S]*--tab videos[\s\S]*--candidate-only/u);
});

test("one owned root still has bounded source, Node memory, PID RSS, task, and artifact bytes", () => {
  assert.match(workflow, /TASK_ROOT="\$RUNNER_TEMP\/daily-song-channel-discovery-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/u);
  assert.match(workflow, /SOURCE_ROOT="\$TASK_ROOT\/source"/u);
  assert.match(workflow, /ARTIFACT_DIR="\$TASK_ROOT\/artifact"/u);
  assert.match(workflow, /CACHE_DIR="\$TASK_ROOT\/cache"/u);
  assert.match(workflow, /NODE_MAX_OLD_SPACE_SIZE_MB: "1536"/u);
  assert.match(workflow, /TASK_CAP_BYTES: "2147483648"/u);
  assert.match(workflow, /ARTIFACT_CAP_BYTES: "134217728"/u);
  assert.match(workflow, /ps -o rss= -p "\$discovery_pid"/u);
  assert.match(workflow, /du -sk "\$TASK_ROOT"/u);
  assert.match(workflow, /\[ "\$rss_bytes" -le "\$TASK_CAP_BYTES" \]/u);
  assert.match(workflow, /\[ "\$current_task_bytes" -le "\$TASK_CAP_BYTES" \]/u);
  assert.match(workflow, /\[ "\$artifact_bytes" -le "\$ARTIFACT_CAP_BYTES" \]/u);
  assert.match(workflow, /DISCOVERY_TIMEOUT_SECONDS: "1200"/u);
});

test("raw page replay and both frozen candidate gates use only the pinned source root", () => {
  assert.match(workflow, /-f "\$SOURCE_ROOT\/scripts\/channel-discovery-candidate-artifact-gate\.jq"/u);
  assert.match(workflow, /-f "\$SOURCE_ROOT\/scripts\/channel-discovery-candidate-records-gate\.jq"/u);
  assert.match(workflow, /SOURCE_ROOT="\$SOURCE_ROOT"/u);
  assert.match(workflow, /recomputeCandidateArtifactEvidence/u);
  assert.match(workflow, /VERIFY_RAW_CONTINUATIONS/u);
  assert.match(workflow, /\.pageEvidenceFiles\[\]/u);
  assert.match(workflow, /shasum -a 256/u);
});

test("failed discovery emits only a bounded log tail and minimal resource state", () => {
  const diagnostic = diagnosticFunctionBlock();
  assert.match(diagnostic, /CHANNEL_DISCOVERY_DIAGNOSTIC_BEGIN/u);
  assert.match(diagnostic, /tail -n 80 "\$log_file" \| LC_ALL=C tail -c 16384/u);
  assert.match(diagnostic, /CHANNEL_DISCOVERY_DIAGNOSTIC_END/u);
  assert.doesNotMatch(diagnostic, /pages|raw-videos|CACHE_DIR|find |tar |upload/iu);
  assert.match(
    workflow,
    /if \[ "\$discovery_status" -ne 0 \]; then\n {12}emit_discovery_failure_diagnostic "\$discovery_status"\n {12}fail "discovery-exit-\$discovery_status"\n {10}fi/u,
  );

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-diagnostic-"));
  const artifactDir = path.join(fixtureRoot, "artifact");
  const cacheDir = path.join(fixtureRoot, "cache");
  fs.mkdirSync(path.join(artifactDir, "pages"), { recursive: true });
  fs.mkdirSync(cacheDir);
  const logLines = Array.from(
    { length: 120 },
    (_, index) => `DIAGNOSTIC-LINE-${String(index + 1).padStart(3, "0")}-${"x".repeat(500)}`,
  );
  fs.writeFileSync(path.join(artifactDir, "discovery.log"), `${logLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(artifactDir, "pages", "secret.html"), "RAW_HTML_MUST_NOT_APPEAR", "utf8");
  fs.writeFileSync(path.join(cacheDir, "secret.html"), "CACHE_MUST_NOT_APPEAR", "utf8");

  const script = `
    set -Eeuo pipefail
    task_bytes() { printf '4242\\n'; }
    ARTIFACT_DIR="$1"
    ${diagnostic}
    emit_discovery_failure_diagnostic 1
  `;
  const result = spawnSync("bash", ["-c", script, "diagnostic", artifactDir], {
    cwd: candidateRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    /CHANNEL_DISCOVERY_DIAGNOSTIC_BEGIN status=1 state=regular logBytes=[0-9]+ taskBytes=4242 tailLines=80 tailBytes=16384/u,
  );
  assert.match(result.stderr, /DIAGNOSTIC-LINE-120/u);
  assert.doesNotMatch(result.stderr, /DIAGNOSTIC-LINE-001|RAW_HTML_MUST_NOT_APPEAR|CACHE_MUST_NOT_APPEAR/u);
  const boundedTail = result.stderr
    .split(/\n?CHANNEL_DISCOVERY_DIAGNOSTIC_BEGIN[^\n]*\n/u)[1]
    .split(/\nCHANNEL_DISCOVERY_DIAGNOSTIC_END/u)[0];
  assert.ok(Buffer.byteLength(boundedTail) <= 16384);
  assert.match(result.stderr, /CHANNEL_DISCOVERY_DIAGNOSTIC_END status=1/u);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test("workflow has no accepted, PG, Urameshi, push, dispatch, or broad cancellation path", () => {
  assert.doesNotMatch(
    workflow,
    /accepted|export-channel|import-channel|deploy-pg|postgres|urameshi|workflow run|gh run cancel|git push|git commit|pkill|killall/iu,
  );
  assert.match(workflow, /retention-days: 3/u);
  assert.match(workflow, /if-no-files-found: error/u);
});

test("owned cleanup removes only the exact run-attempt root and reports zero", () => {
  const blocks = runBlocks();
  assert.equal(blocks.length, 3);
  const cleanup = blocks[2];
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
    cwd: candidateRoot,
    env: {
      ...process.env,
      RUNNER_TEMP: runnerTemp,
      GITHUB_RUN_ID: "17",
      GITHUB_RUN_ATTEMPT: "2",
      TASK_ROOT: taskRoot,
      GITHUB_STEP_SUMMARY: summary,
      SOURCE_BUNDLE_BYTES: "10",
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

test("all shell blocks are expression-free and pass Bash syntax without external JS modules", () => {
  assert.doesNotMatch(fs.readFileSync(__filename, "utf8"), /require\(["']yaml["']\)/u);
  const blocks = runBlocks();
  assert.equal(blocks.length, 3);
  for (const block of blocks) {
    assert.equal(block.includes("${{"), false);
    const result = spawnSync("bash", ["-n"], { input: block, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.ok(workflowLines.length >= 350 && workflowLines.length <= 620);
});
