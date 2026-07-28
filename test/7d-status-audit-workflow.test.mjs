import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const workflow = fs.readFileSync(
  path.resolve(".github/workflows/recover-urameshi-source.yml"),
  "utf8",
);

test("7d recovery explicitly wires bounded shard-5 follow-up audit evidence", () => {
  assert.match(workflow, /status_followup:/u);
  assert.match(workflow, /STATUS_FOLLOWUP: \$\{\{ inputs\.status_followup && '1' \|\| '0' \}\}/u);
  assert.match(workflow, /status-followup-requires-detail-shard-5/u);
  assert.match(workflow, /status_audit_args=\(/u);
  assert.match(workflow, /status_audit_args\+=\(--followup\)/u);
  assert.match(workflow, /statusFollowup:\(\$status_followup == "1"\)/u);
  assert.match(workflow, /\.statusAuditFollowup=\(\$statusAudit\[0\]\.followup \/\/ false\)/u);
  assert.match(workflow, /\.reviewAudit=\(\$statusAudit\[0\]\.summary \/\/ \{\}\)/u);
  assert.match(workflow, /--accepted-details-output "\$FILTERED_DISCOVERY\/video-details\.json"/u);
  assert.match(workflow, /FILTERED_DISCOVERY="\$TASK_ROOT\/discovery-accepted"/u);
  assert.match(workflow, /--input-dir "\$FILTERED_DISCOVERY"/u);
  assert.match(workflow, /non-accepted-status-video-leaked/u);
});