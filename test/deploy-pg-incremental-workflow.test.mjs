import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const deployWorkflow = fs.readFileSync(
  path.resolve(".github/workflows/deploy-pg-incremental.yml"),
  "utf8",
);
const acceptedWorkflow = fs.readFileSync(
  path.resolve(".github/workflows/deploy-pg-accepted-increment.yml"),
  "utf8",
);

function workflowRunBlocks(workflow) {
  const lines = workflow.split(/\r?\n/u);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/u.exec(lines[index]);
    if (!match) continue;
    const contentIndent = match[1].length + 2;
    const body = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() && line.search(/\S/u) < contentIndent) {
        index -= 1;
        break;
      }
      body.push(line.slice(Math.min(contentIndent, line.length)));
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

function sourceIdentityGate(payload) {
  const predicate = `
    (.found == true) and
    ([
      .record.occurrences[]? |
      select(
        (.videoId == $video_id) and
        (.song.title == $title) and
        ((.song.artist // null) == $artist) and
        ((.song.seconds // null) == $seconds)
      )
    ] | length) == 1
  `;
  return spawnSync(
    "jq",
    [
      "-e",
      "--arg", "video_id", "G7cNtd_Gy9c",
      "--argjson", "title", JSON.stringify("song"),
      "--argjson", "artist", JSON.stringify("artist"),
      "--argjson", "seconds", "770",
      predicate,
    ],
    { input: JSON.stringify(payload), encoding: "utf8" },
  ).status;
}

test("workflow YAML parses and every run block has valid bash syntax", () => {
  for (const [name, workflow] of [
    ["deploy-pg-incremental", deployWorkflow],
    ["deploy-pg-accepted-increment", acceptedWorkflow],
  ]) {
    assert.ok(workflowRunBlocks(workflow).length > 0);
    for (const [index, script] of workflowRunBlocks(workflow).entries()) {
      assert.doesNotMatch(
        script,
        /\$\{\{/u,
        `${name} run block ${index + 1} must keep Actions expressions in env to avoid GitHub's expression-length limit`,
      );
      const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      assert.equal(
        result.status,
        0,
        `${name} run block ${index + 1}: ${result.stderr}`,
      );
    }
  }
});

test("source identity gate uses the API-visible tuple and fails closed on ambiguity", () => {
  const matchingOccurrence = {
    videoId: "G7cNtd_Gy9c",
    song: { title: "song", artist: "artist", seconds: 770 },
  };
  assert.equal(
    sourceIdentityGate({ found: true, record: { occurrences: [matchingOccurrence] } }),
    0,
  );
  assert.notEqual(
    sourceIdentityGate({
      found: true,
      record: { occurrences: [matchingOccurrence, matchingOccurrence] },
    }),
    0,
  );
  assert.notEqual(
    sourceIdentityGate({
      found: true,
      record: {
        occurrences: [{
          ...matchingOccurrence,
          videoId: "wrong-video",
        }],
      },
    }),
    0,
  );
});

test("PG incremental dispatch can resume only an explicit same-repository artifact run", () => {
  assert.match(deployWorkflow, /artifact_run_id:/u);
  assert.match(
    deployWorkflow,
    /run-id: \$\{\{ inputs\.artifact_run_id \|\| github\.run_id \}\}/u,
  );
  assert.match(deployWorkflow, /repository: \$\{\{ github\.repository \}\}/u);
  assert.match(deployWorkflow, /github-token: \$\{\{ github\.token \}\}/u);
  assert.match(deployWorkflow, /if: \$\{\{ inputs\.artifact_name != '' \}\}/u);
});

test("accepted commits prepare a deterministic hashed artifact before the reusable deploy", () => {
  assert.match(acceptedWorkflow, /push:\s+branches: \[main\]/u);
  assert.match(
    acceptedWorkflow,
    /data\/external\/youtube-channel-discovery\/accepted\/\*\.json/u,
  );
  assert.match(acceptedWorkflow, /handoffKind:"github-accepted-paths"/u);
  assert.match(acceptedWorkflow, /source_commit_sha:\$source_commit_sha/u);
  assert.match(acceptedWorkflow, /source_base_sha:\$source_base_sha/u);
  assert.match(acceptedWorkflow, /patch_sha256:\$patch_sha256/u);
  assert.match(acceptedWorkflow, /accepted_files_sha256:\$accepted_files_sha256/u);
  assert.match(acceptedWorkflow, /--reviewed-at "\$source_committed_at"/u);
  assert.match(acceptedWorkflow, /duplicate-video-across-accepted-files/u);
  assert.match(acceptedWorkflow, /missing-source-detail-identity/u);
  assert.match(acceptedWorkflow, /occurrenceId:\$song\.occurrenceId/u);
  assert.match(acceptedWorkflow, /repository_root="\$TASK_ROOT\/repository"/u);
  assert.match(acceptedWorkflow, /destination="\$repository_root\/\$repo_path"/u);
  assert.match(acceptedWorkflow, /--source-root "\$repository_root"/u);
  assert.match(
    acceptedWorkflow,
    /uses: \.\/\.github\/workflows\/deploy-pg-incremental\.yml/u,
  );
  assert.match(
    acceptedWorkflow,
    /artifact_run_id: \$\{\{ github\.run_id \}\}/u,
  );
});

test("PG release fails closed, verifies its real source, and rolls back post-activation failures", () => {
  assert.match(deployWorkflow, /PG_INCREMENT_WAIT concurrent-release/u);
  assert.match(deployWorkflow, /existing-ready-source/u);
  assert.match(deployWorkflow, /\.activeSnapshotRevisionId/u);
  assert.match(deployWorkflow, /curation-active-snapshot-mismatch/u);
  assert.match(deployWorkflow, /PG_INCREMENT_CURATION_SOURCE_GATE/u);
  assert.match(deployWorkflow, /candidate-parent-changed/u);
  assert.match(deployWorkflow, /video-count-mismatch/u);
  assert.match(deployWorkflow, /occurrence-count-mismatch/u);
  assert.match(deployWorkflow, /candidate-source-commit-mismatch/u);
  assert.match(deployWorkflow, /candidate-meta-stream-sha-mismatch/u);
  assert.match(
    deployWorkflow,
    /\.identityEvidence\.sourceDetailKey \/\/ empty/u,
  );
  assert.match(deployWorkflow, /source-detail-identity-unparseable/u);
  assert.doesNotMatch(
    deployWorkflow,
    /\.song\.occurrenceId/u,
    "the source API does not expose occurrenceId inside song",
  );
  assert.match(deployWorkflow, /\.record\.occurrences\[\]\? \|/u);
  assert.match(deployWorkflow, /\] \| length\) == 1/u);
  assert.match(deployWorkflow, /candidate-source-identity-mismatch/u);
  assert.match(deployWorkflow, /public-source-identity-mismatch/u);
  assert.match(deployWorkflow, /source-detail-key-missing/u);
  assert.doesNotMatch(
    deployWorkflow,
    /api\/sources\/Naraetan/u,
    "source detail must never fall back to an unrelated known channel",
  );
  assert.match(deployWorkflow, /rollback guard failed current=/u);
  assert.match(deployWorkflow, /pg_adapter\.py\.bak/u);
  assert.match(deployWorkflow, /systemctl disable --now song-rank-api/u);
  assert.match(deployWorkflow, /https:\/\/ytb-song-rank\.culua\.com\/healthz/u);
});

test("workflow-run accepted conversion sorts repository paths and uses a stable source root", () => {
  assert.match(deployWorkflow, /\] \| sort\[\]/u);
  assert.match(deployWorkflow, /ACCEPTED_ROOT="\$TASK_ROOT\/repository"/u);
  assert.match(deployWorkflow, /destination="\$ACCEPTED_ROOT\/\$source_path"/u);
  assert.match(deployWorkflow, /--source-root "\$ACCEPTED_ROOT"/u);
});
