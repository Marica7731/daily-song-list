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

function workflowJob(workflow, jobName, nextJobName) {
  const pattern = new RegExp(
    `^  ${jobName}:\\n([\\s\\S]*?)^  ${nextJobName}:`,
    "mu",
  );
  const match = pattern.exec(workflow);
  assert.ok(match, `missing ${jobName} job`);
  return match[1];
}

function sourceIdentityGate(payload, {
  channelId = "UC7cZJOAJZD1W4aOfqnRgWiA",
  channelHandle = "/@MunMosh",
} = {}) {
  const predicate = `
    def normalize_handle:
      if type == "string" then ltrimstr("/") else "" end;
    ([
      .record.occurrences[]? |
      select(
        (.videoId == $video_id) and
        (.song.title == $title) and
        ((.song.artist // null) == $artist) and
        ((.song.seconds // null) == $seconds)
      )
    ] | length) as $tuple_match_count |
    (.found == true) and
    (($expected_channel_id == "") or
      ((.record.channelId // "") == $expected_channel_id)) and
    (($expected_channel_handle == "") or
      (((.record.channelHandle // "") | normalize_handle) ==
        ($expected_channel_handle | normalize_handle))) and
    ($tuple_match_count == 1)
  `;
  return spawnSync(
    "jq",
    [
      "-e",
      "--arg", "expected_channel_id", channelId,
      "--arg", "expected_channel_handle", channelHandle,
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
    sourceIdentityGate({
      found: true,
      record: {
        channelId: "UC7cZJOAJZD1W4aOfqnRgWiA",
        channelHandle: "/@MunMosh",
        occurrences: [matchingOccurrence],
      },
    }),
    0,
  );
  assert.equal(
    sourceIdentityGate({
      found: true,
      record: {
        channelId: "UC7cZJOAJZD1W4aOfqnRgWiA",
        channelHandle: "@MunMosh",
        occurrences: [matchingOccurrence],
      },
    }),
    0,
    "source identity accepts only the benign leading-slash handle variant",
  );
  assert.notEqual(
    sourceIdentityGate({
      found: true,
      record: {
        channelId: "UC7cZJOAJZD1W4aOfqnRgWiA",
        channelHandle: "/@MunMosh",
        occurrences: [matchingOccurrence, matchingOccurrence],
      },
    }),
    0,
  );
  assert.notEqual(
    sourceIdentityGate({
      found: true,
      record: {
        channelId: "UC7cZJOAJZD1W4aOfqnRgWiA",
        channelHandle: "/@MunMosh",
        occurrences: [{
          ...matchingOccurrence,
          videoId: "wrong-video",
        }],
      },
    }),
    0,
  );
  assert.notEqual(
    sourceIdentityGate({
      found: true,
      record: {
        channelId: "UC8VlcljjGFb4-Ny2Heb0-ew",
        channelHandle: "/@urameshi_conta",
        occurrences: [matchingOccurrence],
      },
    }),
    0,
    "a fuzzy source lookup must not pass using an unrelated record identity",
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

test("rollback-only is a locked artifact-free CAS restore with exact online gates", () => {
  const rollbackJob = workflowJob(deployWorkflow, "rollback", "candidate");
  assert.match(deployWorkflow, /rollback_only:/u);
  assert.match(
    deployWorkflow,
    /EXPECTED_CURRENT_REVISION: "accepted_30389564789_1"/u,
  );
  assert.match(
    deployWorkflow,
    /EXPECTED_TARGET_REVISION: "accepted_30347149376_1"/u,
  );
  assert.match(
    deployWorkflow,
    /EXPECTED_TARGET_CONTENT_SHA256: "5d8a123075e2de5d0221a935004d74fe7e7daf18d0aa90f1f071ebdb3f104b6c"/u,
  );
  assert.match(
    rollbackJob,
    /github\.event_name == 'workflow_dispatch' && inputs\.rollback_only == true/u,
  );
  assert.doesNotMatch(rollbackJob, /download-artifact|ARTIFACT_NAME|import-pg-incremental|activate-pg-candidate/u);
  assert.match(rollbackJob, /PG_ROLLBACK_WAIT concurrent-release/u);
  assert.match(rollbackJob, /pg_advisory_xact_lock\(hashtext\('daily-song-list\/active'\)\)/u);
  assert.match(rollbackJob, /WHERE state_key='active_revision_id'\s+FOR UPDATE/u);
  assert.match(rollbackJob, /current_revision IS DISTINCT FROM '\$EXPECTED_CURRENT_REVISION'/u);
  assert.match(rollbackJob, /current_parent IS DISTINCT FROM '\$EXPECTED_TARGET_REVISION'/u);
  assert.match(rollbackJob, /target_status IS DISTINCT FROM 'superseded'/u);
  assert.match(rollbackJob, /target_content_sha256 IS DISTINCT FROM '\$EXPECTED_TARGET_CONTENT_SHA256'/u);
  assert.match(rollbackJob, /target_status IS DISTINCT FROM 'active'/u);
  assert.match(rollbackJob, /SET status='rolled_back'/u);
  assert.match(rollbackJob, /SET status='active', activated_at=CURRENT_TIMESTAMP/u);
  assert.match(rollbackJob, /SET state_value='\$EXPECTED_TARGET_REVISION'/u);
  assert.equal(
    rollbackJob.match(/GET DIAGNOSTICS affected_rows = ROW_COUNT/gu)?.length,
    3,
    "all three rollback updates must assert exactly one affected row",
  );
  assert.match(rollbackJob, /systemctl restart song-rank-pg-api/u);
  assert.match(rollbackJob, /q=%40urameshi_conta/u);
  assert.match(rollbackJob, /\.totalCount == 0/u);
  assert.match(rollbackJob, /UC8VlcljjGFb4-Ny2Heb0-ew/u);
  assert.match(rollbackJob, /d24ec2cab8f7f564/u);
  assert.match(rollbackJob, /PG_ROLLBACK_PUBLIC_OK/u);
  assert.match(rollbackJob, /PG_ROLLBACK_CLEANUP/u);
  assert.match(
    rollbackJob,
    /TASK_ROOT=.*?[\s\S]*?trap cleanup EXIT INT TERM\s+baseline_free_bytes=/u,
    "cleanup trap must be installed before Mac storage probing",
  );
  const cleanupBody = /cleanup\(\) \{([\s\S]*?)^\s+\}\s+trap cleanup/mu.exec(rollbackJob)?.[1];
  assert.ok(cleanupBody, "missing rollback cleanup body");
  assert.doesNotMatch(
    cleanupBody,
    /UPDATE migration_(?:state|revisions)/u,
    "rollback cleanup must never perform a second pointer mutation",
  );
  assert.match(
    deployWorkflow,
    /github\.event_name != 'workflow_dispatch' \|\| inputs\.rollback_only != true/u,
    "normal candidate work must be skipped in rollback-only mode",
  );
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
  assert.match(deployWorkflow, /identityMatch:/u);
  assert.match(deployWorkflow, /videoMatchCount:\$video_match_count/u);
  assert.match(deployWorkflow, /tupleMatchCount:\$tuple_match_count/u);
  assert.match(deployWorkflow, /PG_INCREMENT_SOURCE_PAGE/u);
  assert.match(deployWorkflow, /PG_INCREMENT_PUBLIC_SOURCE_PAGE/u);
  assert.doesNotMatch(
    deployWorkflow,
    /source_detail_matches_probe/u,
    "candidate and public gates must both use the defined metrics helper",
  );
  assert.match(deployWorkflow, /candidate-source-identity-mismatch/u);
  assert.match(deployWorkflow, /public-source-identity-mismatch/u);
  assert.match(deployWorkflow, /source-detail-key-missing/u);
  assert.doesNotMatch(
    deployWorkflow,
    /api\/sources\/Naraetan/u,
    "source detail must never fall back to an unrelated known channel",
  );
  assert.match(deployWorkflow, /rollback guard failed current=/u);
  assert.match(
    deployWorkflow,
    /cleanup\(\) \{\s+status=\$\?\s+set \+e/u,
    "cleanup must preserve the original status and disable errexit before rollback",
  );
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
