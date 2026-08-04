import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = process.env.SNAPSHOT_RECOVERY_WORKFLOW_PATH
  ? path.resolve(process.env.SNAPSHOT_RECOVERY_WORKFLOW_PATH)
  : path.join(root, '.github', 'workflows', 'enrich-snapshot-recovery.yml');
const checkerPath = process.env.SNAPSHOT_RECOVERY_CHECKER_PATH
  ? path.resolve(process.env.SNAPSHOT_RECOVERY_CHECKER_PATH)
  : path.join(root, 'scripts', 'migration', 'check-snapshot-enrichment-provider.py');
const workflow = readFileSync(workflowPath, 'utf8');
const checker = readFileSync(checkerPath, 'utf8');

function runBlocks(source) {
  const lines = source.split(/\r?\n/u);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/u.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length + 2;
    const block = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() && line.search(/\S/u) < indent) {
        index -= 1;
        break;
      }
      block.push(line.length >= indent ? line.slice(indent) : '');
    }
    blocks.push(block.join('\n'));
  }
  return blocks;
}

test('workflow is provider-only, serial, Mac-bound, and exact-input driven', () => {
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /group: snapshot-recovery-enrichment-provider-singleton/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /runs-on: \[self-hosted, macOS, ARM64, daily-song-list-mac\]/u);
  assert.match(workflow, /timeout-minutes: 240/u);
  assert.match(workflow, /--expected-sha "\$EXPECTED_SAMPLE_SHA256"/u);
  assert.match(workflow, /--expected-count "\$EXPECTED_VIDEO_COUNT"/u);
  assert.match(workflow, /field-completeness\.json/u);
  assert.doesNotMatch(workflow, /\bpsql\b|\bactivate\b|git push|git commit/u);
});

test('workflow retains actual command failures and uploads evidence', () => {
  assert.match(workflow, /if \(\( provider_rc != 0 \)\); then[\s\S]*exit "\$provider_rc"/u);
  assert.match(workflow, /if: always\(\)[\s\S]*actions\/upload-artifact@v4/u);
  assert.match(workflow, /refusing cleanup outside RUNNER_TEMP/u);
  assert.match(checker, /releaseReady/u);
  assert.match(checker, /SOURCE_READY/u);
  assert.match(checker, /candidateReady": False/u);
});

test('every workflow run block parses under bash', () => {
  const blocks = runBlocks(workflow);
  assert.equal(blocks.length, 4);
  const scratch = mkdtempSync(path.join(tmpdir(), 'snapshot-recovery-workflow-'));
  try {
    blocks.forEach((block, index) => {
      const script = path.join(scratch, `run-${index + 1}.sh`);
      writeFileSync(script, `${block}\n`, 'utf8');
      const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
      assert.equal(result.status, 0, `run block ${index + 1}: ${result.stderr}`);
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('checker distinguishes structural success from release readiness', () => {
  assert.match(checker, /status not in \{"ok", "needs_review"\}/u);
  assert.match(checker, /state": "SOURCE_READY" if release_ready else "DISCOVERED"/u);
  assert.match(checker, /provider evidence must remain not-for-release/u);
});
