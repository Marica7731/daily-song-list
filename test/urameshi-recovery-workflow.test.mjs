import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const workflow = fs.readFileSync(path.resolve(".github/workflows/recover-urameshi-source.yml"), "utf8");

test("urameshi recovery details one resumable shard before final activation", () => {
  assert.match(workflow, /- detail-shard/u);
  assert.match(workflow, /checkpoint_run_id:/u);
  assert.match(workflow, /checkpoint_artifact_name:/u);
  assert.match(workflow, /URAMESHI_7D_CHECKPOINT_REUSED/u);
  assert.match(workflow, /URAMESHI_7D_SHARD_CHECKPOINT/u);
  assert.match(workflow, /checkpoint_mirror/u);
  assert.match(workflow, /nextShardIndex/u);
  assert.doesNotMatch(workflow, /for shard in 0 1 2 3 4 5; do/u);
  assert.match(workflow, /inputs\.stage == 'detail-shard' && inputs\.detail_shard_index == '5'/u);
});
