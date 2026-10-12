import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'deploy-pg-adapter-contract.yml');
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
const helperPattern = /^ {10}cleanup_candidate_unit\(\) \{\n[\s\S]*?^ {10}\}\n^ {10}(?:cleanup_candidate|finalize_remote_cleanup)\(\) \{/gm;
const helpers = [...workflow.matchAll(helperPattern)].map((match) => match[0]
  .replace(/\n {10}(?:cleanup_candidate|finalize_remote_cleanup)\(\) \{$/, '')
  .replace(/^ {10}/gm, ''));
const readinessPattern = /^ {10}wait_for_service_contract_inner\(\) \{\n[\s\S]*?^ {10}\}\n^ {10}wait_for_service_contract\(\) \{\n[\s\S]*?^ {10}\}\n/gm;
const readinessHelpers = [...workflow.matchAll(readinessPattern)].map((match) => match[0]
  .replace(/^ {10}/gm, ''));

const shellQuote = (value) => JSON.stringify(value);
function toShellPath(value) {
  if (process.platform !== 'win32') return value;
  return value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

function runShellBash(script, variables, timeout = 10000) {
  const exports = Object.entries(variables)
    .map(([name, value]) => `export ${name}=${shellQuote(String(value))}`)
    .join('\n');
  if (process.platform === 'win32') {
    return spawnSync('wsl.exe', ['bash', '-s'], {
      input: `${exports}\n${script}`,
      encoding: 'utf8',
      timeout,
    });
  }
  return spawnSync('bash', ['-s'], {
    input: `${exports}\n${script}`,
    encoding: 'utf8',
    timeout,
  });
}

function writeExecutable(path, body) {
  writeFileSync(path, body, { encoding: 'utf8', mode: 0o700 });
  chmodSync(path, 0o700);
}

function runCleanupFixture(fixture, expectedStatus) {
  const testRoot = join(ROOT, '.test-tmp-cleanup');
  rmSync(testRoot, { recursive: true, force: true });
  const bin = join(testRoot, 'bin');
  const remoteRoot = join(testRoot, 'remote');
  const resultPath = join(remoteRoot, 'result.txt');
  mkdirSync(bin, { recursive: true });
  mkdirSync(remoteRoot, { recursive: true });
  writeExecutable(join(bin, 'timeout'), '#!/usr/bin/env bash\nset -Eeuo pipefail\nwhile [[ "$1" == --* ]]; do shift; done\nshift\n"$@"\n');
  writeExecutable(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(join(bin, 'ss'), '#!/usr/bin/env bash\nif [[ "$FIXTURE" == *port* ]]; then echo "LISTEN 0 128 127.0.0.1:18766 0.0.0.0:*"; fi\n');
  writeExecutable(join(bin, 'systemctl'), [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    'case "$1" in',
    '  show)',
    '    if [[ "$FIXTURE" == showfail* ]]; then exit 1; fi',
    '    printf "LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nResult=success\\n"',
    '    ;;',
    '  stop) exit 0 ;;',
    '  reset-failed) exit 1 ;;',
    '  is-active) exit 3 ;;',
    '  *) exit 64 ;;',
    'esac',
    '',
  ].join('\n'));
  const helper = helpers[0];
  const shell = [
    'set -Eeuo pipefail',
    `remote_root=${shellQuote(toShellPath(remoteRoot))}`,
    'candidate_unit=daily-song-list-adapter-1',
    'set +e',
    helper,
    `cleanup_candidate_unit ${shellQuote(toShellPath(resultPath))}`,
    'cleanup_status=$?',
    `printf "cleanupStatus=%s\\n" "$cleanup_status"`,
    `cat ${shellQuote(toShellPath(resultPath))}`,
    'exit "$cleanup_status"',
    '',
  ].join('\n');
  try {
    const result = runShellBash(shell, {
      FIXTURE: fixture,
      PATH: `${toShellPath(bin)}:/usr/local/bin:/usr/bin:/bin`,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, expectedStatus, result.stderr);
    return result.stdout;
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function runReadinessFixture(fixture, expectedStatus) {
  const testRoot = join(ROOT, '.test-tmp-readiness');
  rmSync(testRoot, { recursive: true, force: true });
  const bin = join(testRoot, 'bin');
  const remoteRoot = join(testRoot, 'remote');
  const statePath = join(testRoot, 'state');
  mkdirSync(bin, { recursive: true });
  mkdirSync(remoteRoot, { recursive: true });
  writeExecutable(join(bin, 'timeout'), '#!/usr/bin/env bash\nset -Eeuo pipefail\nwhile [[ "$1" == --* ]]; do shift; done\nshift\n"$@"\n');
  writeExecutable(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(join(bin, 'systemctl'), [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    'if [[ "$1" != is-active ]]; then exit 64; fi',
    'if [[ "$FIXTURE" == never* ]]; then exit 3; fi',
    'count=0; test -f "$STATE_PATH" && count=$(cat "$STATE_PATH")',
    'count=$((count + 1)); printf "%s\\n" "$count" > "$STATE_PATH"',
    'if [[ "$FIXTURE" == delayed* && "$count" -le 2 ]]; then exit 3; fi',
    'exit 0',
    '',
  ].join('\n'));
  writeExecutable(join(bin, 'ss'), [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    'if [[ "$FIXTURE" == never* ]]; then exit 0; fi',
    'count=0; test -f "$STATE_PATH" && count=$(cat "$STATE_PATH")',
    'if [[ "$FIXTURE" == delayed* && "$count" -le 2 ]]; then exit 0; fi',
    'echo "LISTEN 0 128 127.0.0.1:8765 0.0.0.0:*"',
    '',
  ].join('\n'));
  writeExecutable(join(bin, 'curl'), [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    'if [[ "$*" == *healthz* ]]; then printf "{\\"status\\":\\"ok\\",\\"counts\\":{\\"videos\\":1,\\"occurrences\\":1}}\\n"; else printf "{\\"meta\\":{\\"active_revision_id\\":\\"rev\\",\\"migration_status\\":\\"active\\"}}\\n"; fi',
    '',
  ].join('\n'));
  writeExecutable(join(bin, 'jq'), [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    'if [[ "$FIXTURE" == healthbad* && "$*" == *healthz.json* ]]; then exit 1; fi',
    'if [[ "$FIXTURE" == metabad* && "$*" == *meta.json* ]]; then exit 1; fi',
    'exit 0',
    '',
  ].join('\n'));
  const shell = [
    'set -Eeuo pipefail',
    'set +e',
    readinessHelpers[0],
    `READINESS_DEADLINE_SECONDS=1 wait_for_service_contract http://127.0.0.1:8765 ${shellQuote(toShellPath(join(remoteRoot, 'healthz.json')))} ${shellQuote(toShellPath(join(remoteRoot, 'meta.json')))} rev`,
    'readiness_status=$?',
    'printf "readinessStatus=%s\\n" "$readiness_status"',
    'exit "$readiness_status"',
    '',
  ].join('\n');
  try {
    const result = runShellBash(shell, {
      FIXTURE: fixture,
      STATE_PATH: toShellPath(statePath),
      PATH: `${toShellPath(bin)}:/usr/local/bin:/usr/bin:/bin`,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, expectedStatus, result.stderr);
    return result.stdout;
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

test('candidate materializes both v5b cleanup helpers', () => {
  assert.equal(helpers.length, 2);
  assert.equal(helpers[0], helpers[1]);
  assert.match(workflow, /PG_ADAPTER_CLEANUP_ROLLBACK_VERIFIED/);
});

test('fixture shell runner is portable across Windows and Linux hosts', () => {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.match(source, /process\.platform === 'win32'/);
  assert.match(source, /spawnSync\('wsl\.exe', \['bash', '-s'\]/);
  assert.match(source, /spawnSync\('bash', \['-s'\]/);
  assert.match(source, /process\.platform !== 'win32'/);
});

test('reset-failed nonzero is accepted only with complete inactive cleanup evidence', () => {
  const output = runCleanupFixture('inactive-resetfail', 0);
  assert.match(output, /cleanupStatus=0/);
  assert.match(output, /resetStatus=1/);
  assert.match(output, /showStatusBefore=0/);
  assert.match(output, /showStatusAfterStop=0/);
  assert.match(output, /showStatusAfter=0/);
  assert.match(output, /activeStateAfter=inactive/);
  assert.match(output, /subStateAfter=dead/);
  assert.match(output, /resultAfter=success/);
  assert.match(output, /activeAfter=0/);
  assert.match(output, /port18766After=0/);
});

test('systemctl show failure remains fail-closed', () => {
  const output = runCleanupFixture('showfail-before', 1);
  assert.match(output, /cleanupStatus=1/);
  assert.match(output, /showStatusBefore=1/);
});

test('both rollback paths use the same hard-bounded readiness wrapper', () => {
  assert.equal(readinessHelpers.length, 2);
  assert.equal(readinessHelpers[0], readinessHelpers[1]);
  for (const helper of readinessHelpers) {
    assert.match(helper, /timeout --signal=TERM --kill-after=2s "\$\{deadline_seconds\}s"/);
    assert.match(helper, /systemctl is-active --quiet song-rank-pg-api/);
    assert.match(helper, /sport = :8765/);
    assert.match(helper, /\/healthz/);
    assert.match(helper, /\/api\/meta/);
    assert.match(helper, /return 1/);
  }
});

test('readiness retries delayed service and complete health/meta success', () => {
  const output = runReadinessFixture('delayed-success', 0);
  assert.match(output, /readinessStatus=0/);
});

test('readiness fails closed on deadline, bad health, and bad meta', () => {
  for (const fixture of ['never-ready', 'healthbad', 'metabad']) {
    const output = runReadinessFixture(fixture, 1);
    assert.match(output, /readinessStatus=1/, fixture);
  }
});

test('public contract is routed through VPS SSH and validates the verifier marker', () => {
  const start = workflow.indexOf('Verify real public TLS relay contract through VPS before finalize');
  const end = workflow.indexOf('Finalize only after public contract gate', start);
  assert.ok(start >= 0 && end > start);
  const publicStep = workflow.slice(start, end);
  assert.match(publicStep, /timeout --signal=TERM --kill-after=10s 120s ssh/);
  assert.match(publicStep, /<<'REMOTE_PUBLIC'/);
  assert.match(publicStep, /public_base.*ytb-song-rank\.culua\.com/);
  assert.match(publicStep, /\/healthz/);
  assert.match(publicStep, /\/api\/meta/);
  assert.match(publicStep, /\/api\/rankings/);
  assert.match(publicStep, /\/api\/sources/);
  assert.match(publicStep, /public-invalid-thumbnail/);
  assert.match(publicStep, /CONTRACT_VERIFIED phase=public videoId=/);
  assert.doesNotMatch(publicStep, /curl[^\n]*\$PUBLIC_BASE/);
});

console.log('P0_WORKFLOW_V6_FIRST_REGRESSION_COMPLETE assertions=32');
