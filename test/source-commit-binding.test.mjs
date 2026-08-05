import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidateRoot = path.resolve(here, '..');
const workflowPath = process.env.DEPLOY_PG_INCREMENTAL_WORKFLOW_PATH
  || path.join(candidateRoot, '.github', 'workflows', 'deploy-pg-incremental.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

test('workflow binds REST commit responses by scoped SHA and first parent', () => {
  const start = workflow.indexOf('source_commit_json="$TASK_ROOT/workflow-run-source-commit.json"');
  const end = workflow.indexOf('WORKFLOW_RUN_ROUTE=authoritative-7d', start);
  assert.ok(start >= 0 && end > start, 'source commit binding block must be present');

  const block = workflow.slice(start, end);
  assert.match(block, /repos\/\$\{GITHUB_REPOSITORY\}\/commits\/\$\{SOURCE_SHA\}/u);
  assert.match(block, /\(\.sha == \$source\) and\s+\(\.parents\[0\]\.sha == \$base\)/u);
  assert.doesNotMatch(block, /\.repository\.full_name/u);
  assert.match(block, /source-commit-binding-failed/u);
});
