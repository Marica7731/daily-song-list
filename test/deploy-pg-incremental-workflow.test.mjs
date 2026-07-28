import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const workflow = fs.readFileSync(path.resolve(".github/workflows/deploy-pg-incremental.yml"), "utf8");

test("PG incremental dispatch can resume only an explicit same-repository artifact run", () => {
  assert.match(workflow, /artifact_run_id:/u);
  assert.match(workflow, /run-id: \$\{\{ inputs\.artifact_run_id \|\| github\.run_id \}\}/u);
  assert.match(workflow, /repository: \$\{\{ github\.repository \}\}/u);
  assert.match(workflow, /github-token: \$\{\{ github\.token \}\}/u);
  assert.match(workflow, /if: \$\{\{ inputs\.artifact_name != '' \}\}/u);
});
