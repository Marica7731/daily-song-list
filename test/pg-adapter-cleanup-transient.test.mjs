import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = join(
  ROOT,
  '.github',
  'workflows',
  'deploy-pg-adapter-contract.yml',
);
const workflow = readFileSync(workflowPath, 'utf8');
const helperPattern = /^ {10}cleanup_candidate_unit\(\) \{\n[\s\S]*?^ {10}\}\n^ {10}(?:cleanup_candidate|finalize_remote_cleanup)\(\) \{/gm;
const helperMatches = [...workflow.matchAll(helperPattern)];
assert.equal(helperMatches.length, 2, 'candidate and outer cleanup helpers must both be present');
const cleanupHelpers = helperMatches.map((match) => match[0]
  .replace(/\n {10}(?:cleanup_candidate|finalize_remote_cleanup)\(\) \{$/, '')
  .replace(/^ {10}/gm, ''));
assert.equal(cleanupHelpers[0], cleanupHelpers[1], 'candidate and outer cleanup helpers must be semantically identical');
for (const helper of cleanupHelpers) {
  assert.match(helper, /local active_after=0/);
  assert.match(helper, /local port_after=0/);
  assert.doesNotMatch(helper, /candidate_active_after|candidate_port_after/);
  assert.ok(helper.indexOf('failed_before=1') < helper.indexOf('systemctl stop "$candidate_unit"'));
}
const arrayCount = '$' + '{#selected[@]}';
const arrayValues = '$' + '{selected[@]}';
const escapedArrayCount = '\\' + arrayCount;
const escapedArrayValues = '\\' + arrayValues;
const outerHeredocMatch = workflow.match(/<<'REMOTE_CLEANUP'\n([\s\S]*?)\n          REMOTE_CLEANUP/);
assert.ok(outerHeredocMatch, 'outer cleanup heredoc must be present');
const outerHeredoc = outerHeredocMatch[1];
assert.ok(outerHeredoc.includes(arrayCount));
assert.ok(outerHeredoc.includes(arrayValues));
assert.ok(!outerHeredoc.includes(escapedArrayCount));
assert.ok(!outerHeredoc.includes(escapedArrayValues));
const archiveSnippetMatch = outerHeredoc.match(/            selected=\(\)\n[\s\S]*?\n            if \[ "\$candidate_cleanup_status" -eq 0 \]; then/);
assert.ok(archiveSnippetMatch, 'outer selected archive branch must be present');
const archiveSnippet = archiveSnippetMatch[0]
  .replace(/\n            if \[ "\$candidate_cleanup_status" -eq 0 \]; then$/, '')
  .replace(/^ {10}/gm, '');

const shellQuote = (value) => JSON.stringify(value);

const runFixture = (fixture, expectedStatus, rootGuard, helperIndex = 0) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'daily-song-list-p0-cleanup-'));
  const bin = join(tempRoot, 'bin');
  const remoteRoot = join(tempRoot, 'remote');
  const resultPath = join(remoteRoot, 'result.txt');
  const stateFile = join(tempRoot, 'show-count');
  mkdirSync(bin, { recursive: true });
  mkdirSync(remoteRoot, { recursive: true });

  const scripts = {
    timeout: [
      '#!/usr/bin/env bash',
      'set -Eeuo pipefail',
      'while [[ "$1" == --* ]]; do shift; done',
      'shift',
      '"$@"',
      '',
    ].join('\n'),
    sleep: ['#!/usr/bin/env bash', 'exit 0', ''].join('\n'),
    ss: [
      '#!/usr/bin/env bash',
      'if [[ "$FIXTURE" == *port* ]]; then',
      "  echo 'LISTEN 0 128 127.0.0.1:18766 0.0.0.0:*'",
      'fi',
      '',
    ].join('\n'),
    systemctl: [
      '#!/usr/bin/env bash',
      'set -Eeuo pipefail',
      'case "$1" in',
      '  show)',
      '    case "$FIXTURE" in',
      "      absent*) printf 'LoadState=not-found\\nActiveState=inactive\\nSubState=dead\\nResult=success\\n' ;;",
      '      showfail_before*) exit 1 ;;',
      '      showfail_after_stop*|showfail_after_reset*)',
      '        show_count=0',
      '        if [ -f "$STATE_FILE" ]; then show_count=$(cat "$STATE_FILE"); fi',
      '        show_count=$((show_count + 1))',
      '        printf "%s\\n" "$show_count" > "$STATE_FILE"',
      '        if [ "$FIXTURE" = showfail_after_stop ] && [ "$show_count" -eq 2 ]; then exit 1; fi',
      '        if [ "$FIXTURE" = showfail_after_reset ] && [ "$show_count" -eq 3 ]; then exit 1; fi',
      "        printf 'LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nResult=success\\n'",
      '        ;;',
      "      active*) printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nResult=success\\n' ;;",
      '      failed_then_cleared)',
      '        show_count=0',
      '        if [ -f "$STATE_FILE" ]; then show_count=$(cat "$STATE_FILE"); fi',
      '        show_count=$((show_count + 1))',
      '        printf "%s\\n" "$show_count" > "$STATE_FILE"',
      '        if [ "$show_count" -eq 1 ]; then',
      "          printf 'LoadState=loaded\\nActiveState=failed\\nSubState=failed\\nResult=exit-code\\n'",
      '        else',
      "          printf 'LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nResult=success\\n'",
      '        fi',
      '        ;;',
      "      failed*) printf 'LoadState=loaded\\nActiveState=failed\\nSubState=failed\\nResult=exit-code\\n' ;;",
      "      *) printf 'LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nResult=success\\n' ;;",
      '    esac',
      '    ;;',
      '  stop) exit 0 ;;',
      '  reset-failed)',
      '    if [[ "$FIXTURE" == *resetfail* ]]; then exit 7; fi',
      '    exit 0',
      '    ;;',
      '  is-active)',
      '    if [[ "$FIXTURE" == active* ]]; then exit 0; fi',
      '    exit 3',
      '    ;;',
      '  *) exit 64 ;;',
      'esac',
      '',
    ].join('\n'),
  };

  for (const [name, body] of Object.entries(scripts)) {
    const path = join(bin, name);
    writeFileSync(path, body, { encoding: 'utf8', mode: 0o700 });
    chmodSync(path, 0o700);
  }

  const shell = [
    'set -Eeuo pipefail',
    'remote_root=' + shellQuote(remoteRoot),
    'candidate_unit=daily-song-list-adapter-1',
    'set +e',
    cleanupHelpers[helperIndex],
    'cleanup_candidate_unit ' + shellQuote(resultPath),
    'cleanup_status=$?',
    rootGuard || '',
    'printf "cleanupStatus=%s\\n" "$cleanup_status"',
    'cat ' + shellQuote(resultPath) + ' 2>/dev/null || true',
    'exit "$cleanup_status"',
    '',
  ].join('\n');

  try {
    const result = spawnSync('bash', ['-c', shell], {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        FIXTURE: fixture,
        STATE_FILE: stateFile,
        PATH: bin + (process.env.PATH ? ':' + process.env.PATH : ''),
      },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, expectedStatus, result.stderr);
    return result.stdout;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
};

test('inactive/dead Result=success accepts nonzero reset-failed in both helpers', () => {
  for (const helperIndex of cleanupHelpers.keys()) {
    const output = runFixture('inactiveresetfail', 0, '', helperIndex);
    assert.match(output, /resetStatus=7/);
    assert.match(output, /failedAfter=0/);
    assert.match(output, /unitPresentAfter=1/);
  }
});

test('LoadState=not-found absent unit accepts nonzero reset-failed in both helpers', () => {
  for (const helperIndex of cleanupHelpers.keys()) {
    const output = runFixture('absentresetfail', 0, '', helperIndex);
    assert.match(output, /resetStatus=7/);
    assert.match(output, /unitPresentAfter=0/);
  }
});

test('systemctl show query failure is fail-closed at every cleanup phase in both helpers', () => {
  const fixtures = [
    ['showfail_before', /showStatusBefore=1/],
    ['showfail_after_stop', /showStatusAfterStop=1/],
    ['showfail_after_reset', /showStatusAfter=1/],
  ];
  for (const helperIndex of cleanupHelpers.keys()) {
    for (const [fixture, marker] of fixtures) {
      const output = runFixture(fixture, 1, '', helperIndex);
      assert.match(output, /cleanupStatus=1/);
      assert.match(output, marker);
    }
  }
});

test('failed unit remains fail-closed when reset-failed is nonzero in both helpers', () => {
  for (const helperIndex of cleanupHelpers.keys()) {
    const output = runFixture('failedresetfail', 1, '', helperIndex);
    assert.match(output, /resetStatus=7/);
    assert.match(output, /failedBefore=1/);
    assert.match(output, /failedAfter=1/);
  }
});

test('initial failed state remains fail-closed if reset-failed clears it', () => {
  for (const helperIndex of cleanupHelpers.keys()) {
    const output = runFixture('failed_then_cleared', 1, '', helperIndex);
    assert.match(output, /resetStatus=0/);
    assert.match(output, /failedBefore=1/);
    assert.match(output, /failedAfter=0/);
  }
});

test('active unit remains fail-closed in both helpers', () => {
  for (const helperIndex of cleanupHelpers.keys()) {
    const output = runFixture('active', 1, '', helperIndex);
    assert.match(output, /activeAfter=1/);
  }
});

test('port residue remains fail-closed in both helpers', () => {
  for (const helperIndex of cleanupHelpers.keys()) {
    const output = runFixture('portresetfail', 1, '', helperIndex);
    assert.match(output, /port18766After=1/);
  }
});

test('real outer heredoc selected archive branch executes with unescaped arrays', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'daily-song-list-p0-archive-'));
  const remoteRoot = join(tempRoot, 'remote');
  const archivePath = join(tempRoot, 'archive.tar.gz');
  mkdirSync(remoteRoot, { recursive: true });
  writeFileSync(join(remoteRoot, 'cleanup-healthz.json'), '{}\n');
  writeFileSync(join(remoteRoot, 'cleanup-candidate-unit-result.txt'), 'resetStatus=7\nfailedAfter=0\n');
  const shell = [
    'set -Eeuo pipefail',
    'remote_root=' + shellQuote(remoteRoot),
    'evidence_status=0',
    archiveSnippet,
    '',
  ].join('\n');
  try {
    const result = spawnSync('bash', ['-c', shell], { timeout: 30000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr.toString());
    writeFileSync(archivePath, result.stdout);
    const listing = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8', timeout: 30000 });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /cleanup-healthz\.json/);
    assert.match(listing.stdout, /cleanup-candidate-unit-result\.txt/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('outer cleanup removes and verifies the exact root only after safe cleanup in both helpers', () => {
  for (const helperIndex of cleanupHelpers.keys()) {
    const output = runFixture(
      'inactiveresetfail',
      0,
      [
        'if [ "$cleanup_status" -eq 0 ]; then',
        '  rm -rf -- "$remote_root"',
        'fi',
        'test ! -e "$remote_root"',
      ].join('\n'),
      helperIndex,
    );
    assert.match(output, /cleanupStatus=0/);
  }
});

test('outer cleanup retains the exact root when cleanup is unsafe in both helpers', () => {
  for (const helperIndex of cleanupHelpers.keys()) {
    const output = runFixture(
      'portresetfail',
      1,
      [
        'if [ "$cleanup_status" -eq 0 ]; then',
        '  rm -rf -- "$remote_root"',
        'fi',
        'test -e "$remote_root"',
      ].join('\n'),
      helperIndex,
    );
    assert.match(output, /cleanupStatus=1/);
  }
});

/*
 * Keep the original short assertions below as a readable contract summary.
 */
test('cleanup evidence keeps reset and failure state bounded', () => {
  const output = runFixture('inactiveresetfail', 0);
  assert.match(output, /resetStatus=7/);
  assert.match(output, /failedAfter=0/);
});


console.log('PG_ADAPTER_CLEANUP_TRANSIENT_REGRESSION_COMPLETE');
