const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.join(__dirname, "..");
const workflowPath = path.join(root, ".github", "workflows", "discover-one-channel-detail.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");

test("generic Mac detail workflow has exact three-video and immutable channel defaults", () => {
  assert.match(workflow, /^name: Discover one channel detail$/mu);
  assert.match(workflow, /^      video_ids:[\s\S]*?default: y0KqY2Wgaiw,OG_Td-kXSzE,DtKGpOOZBIE$/mu);
  assert.match(workflow, /^        default: UCahlYbdb3AHrNQdojztSMvQ$/mu);
  assert.match(workflow, /^        default: "@natori_hinata"$/mu);
  assert.match(workflow, /^    runs-on: \[self-hosted, macOS, ARM64, daily-song-list-mac\]$/mu);
  assert.match(workflow, /^    timeout-minutes: 25$/mu);
  assert.match(workflow, /^      MAX_INSPECT: "3"$/mu);
  assert.match(workflow, /^      TASK_CAP_BYTES: "2147483648"$/mu);
  assert.match(workflow, /^      NODE_MAX_OLD_SPACE_SIZE_MB: "1536"$/mu);
  assert.match(workflow, /printf '%s\\n' "\$VIDEO_IDS" \| tr ',' '\\n'/u);
});

test("detail invocation is explicit, single-shard, bounded, and never fresh or accepted", () => {
  assert.match(workflow, /--candidate-manifest "\$INPUT_ROOT\/candidate-manifest\.ndjson"/u);
  assert.equal((workflow.match(/--video-id /gu) || []).length, 3);
  assert.match(workflow, /--max-candidates 3/u);
  assert.match(workflow, /--max-inspect 3/u);
  assert.match(workflow, /--inspect-shard-count 1/u);
  assert.match(workflow, /--inspect-shard-index 0/u);
  assert.match(workflow, /--expected-channel-id "\$CHANNEL_ID"/u);
  assert.match(workflow, /--expected-channel-handle "\$CHANNEL_HANDLE"/u);
  assert.match(workflow, /DAILY_SONG_RETAIN_AUDIT_SOURCE_TEXT=1/u);
  assert.match(workflow, /ps -o rss= -p "\$detail_pid"/u);
  assert.match(workflow, /du -sk "\$TASK_ROOT"/u);
  assert.match(workflow, /DETAIL_TIMEOUT_SECONDS: "1200"/u);
  assert.doesNotMatch(workflow, /--fresh|export-channel-increment|data\/external\/youtube-channel-discovery\/accepted/u);
  assert.doesNotMatch(workflow, /server\/pg_adapter|deploy-pg|recover-urameshi|locked[-_ ]activate/u);
});

test("candidate and detail artifacts bind source commits, ZIP hash, evidence, and review-only output", () => {
  assert.match(workflow, /candidate-artifact-not-unique/u);
  assert.match(workflow, /\[ "\$actual_zip_sha" = "\$CANDIDATE_ZIP_SHA256" \]/u);
  assert.match(workflow, /channel-discovery-detail-artifact-gate\.mjs" select/u);
  assert.match(workflow, /--expected-source-commit "\$candidate_source_commit"/u);
  assert.match(workflow, /channel-discovery-detail-artifact-gate\.mjs" verify/u);
  assert.match(workflow, /--expected-source-commit "\$GITHUB_SHA"/u);
  assert.match(workflow, /expectedChannelId:\$channelId/u);
  assert.match(workflow, /expectedChannelHandle:\$channelHandle/u);
  assert.match(workflow, /expectedChannelUrl:\$channelUrl/u);
  assert.match(workflow, /source-evidence\.json/u);
  assert.match(workflow, /review-ready-manifest\.json/u);
  assert.match(workflow, /acceptedEligible:false/u);
});

test("one owned temp root mirrors checkpoints, uploads bounded evidence, and cleans exact root", () => {
  assert.match(workflow, /TASK_ROOT="\$RUNNER_TEMP\/daily-song-channel-detail-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/u);
  assert.match(workflow, /checkpoint_mirror/u);
  assert.match(workflow, /sleep 20/u);
  assert.match(workflow, /compression-level: 6/u);
  assert.match(workflow, /retention-days: 3/u);
  assert.match(workflow, /cleanupStatus:"pending_owned_temp_root_removal"/u);
  assert.match(workflow, /expected="\$RUNNER_TEMP\/daily-song-channel-detail-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/u);
  assert.match(workflow, /rm -rf -- "\$TASK_ROOT"/u);
  assert.match(workflow, /\[ ! -e "\$TASK_ROOT" \] \|\| exit 78/u);
  assert.match(workflow, /CHANNEL_DETAIL_CLEANUP_OK beforeBytes=%s afterBytes=0/u);
  assert.doesNotMatch(workflow, /rm -rf -- ["']?(?:\/|~|\$HOME)["']?(?:\s|$)/mu);
});

test("all workflow Bash blocks and changed JavaScript files pass syntax checks", () => {
  const blocks = workflowRunBlocks(workflow);
  assert.equal(blocks.length, 4);
  for (const [index, block] of blocks.entries()) {
    const checked = spawnSync("bash", ["-n"], {
      input: block,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(checked.status, 0, `run block ${index + 1}: ${checked.stderr}`);
  }
  for (const relative of [
    "scripts/channel-discovery-detail-artifact-gate.mjs",
    "scripts/youtube-channel-discovery-core.js",
    "scripts/update-songlist.js",
  ]) {
    const checked = spawnSync(process.execPath, ["--check", path.join(root, relative)], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(checked.status, 0, `${relative}: ${checked.stderr}`);
  }
});

test("source bundle contains the exact runtime closure and no checkout", () => {
  const files = pinnedSourceFiles(workflow);
  assert.equal(files.length, 23);
  assert.equal(new Set(files).size, files.length);
  for (const required of [
    "scripts/channel-discovery-detail-artifact-gate.mjs",
    "scripts/youtube-channel-discovery-core.js",
    "scripts/youtube-channel-discovery.js",
    "scripts/update-songlist.js",
  ]) {
    assert.ok(files.includes(required), `missing ${required}`);
  }
  assert.doesNotMatch(workflow, /actions\/checkout|GITHUB_WORKSPACE/u);
  assert.match(workflow, /github_api "git\/trees\/\$GITHUB_SHA\?recursive=1" "\$tree_json"/u);
  assert.match(workflow, /github_api "actions\/artifacts\/\$candidate_artifact_id\/zip" "\$TASK_ROOT\/candidate\.zip"/u);
  assert.doesNotMatch(workflow, /(^|\s)gh api(?:\s|$)/mu);
  assert.match(workflow, /printf 'blob %s\\0'/u);
  assert.match(workflow, /\[ "\$actual_blob_sha" = "\$expected_blob_sha" \]/u);
});

function workflowRunBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s{8}run: \|\s*$/u.test(lines[index])) continue;
    const block = [];
    for (index += 1; index < lines.length; index += 1) {
      if (lines[index] === "") {
        block.push("");
        continue;
      }
      if (!/^ {10}/u.test(lines[index])) break;
      block.push(lines[index].slice(10));
    }
    index -= 1;
    blocks.push(block.join("\n"));
  }
  return blocks;
}

function pinnedSourceFiles(source) {
  const match = source.match(/done <<'PINNED_SOURCE_PATHS'\n([\s\S]*?)\n {10}PINNED_SOURCE_PATHS/u);
  assert.ok(match, "pinned source block missing");
  return match[1].split("\n").map((line) => line.trim()).filter(Boolean);
}
