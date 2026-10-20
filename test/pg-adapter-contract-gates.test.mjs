import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkflowPath = resolve(testDir, '..', '.github', 'workflows', 'deploy-pg-adapter-contract.yml');
const resolveWorkflowPath = (env = process.env) => env.WORKFLOW_PATH || defaultWorkflowPath;
const workflowPath = resolveWorkflowPath();
const workflow = readFileSync(workflowPath, 'utf8');

test('workflow path defaults from import.meta.url and still permits an env override', () => {
  assert.equal(resolveWorkflowPath({}), defaultWorkflowPath);
  assert.equal(
    resolveWorkflowPath({ WORKFLOW_PATH: '/tmp/isolated-workflow.yml' }),
    '/tmp/isolated-workflow.yml',
  );
  assert.ok(workflow.length > 0);
});

test('P0 is explicitly song-only with exact Haru entity and opaque detail inputs', () => {
  assert.doesNotMatch(workflow, /^\s+source_type:/m);
  assert.doesNotMatch(workflow, /^\s+source_channel_id:/m);
  assert.match(workflow, /default: "晴る"/);
  assert.doesNotMatch(workflow, /default: "æ™´ã‚‹"/);
  assert.match(workflow, /source_entity_key:/);
  assert.match(workflow, /default: "晴る::ヨルシカ"/);
  assert.match(workflow, /default: "01fc9d6830d3c230"/);
  assert.match(workflow, /default: "4697"/);
  assert.match(workflow, /default: "4485"/);
  assert.match(workflow, /\[\[ "\$SOURCE_KEY" =~ \^\[0-9a-f\]\{16\}/);
  assert.match(workflow, /test "\$SOURCE_ENTITY_KEY" != "\$SOURCE_KEY"/);
  assert.match(workflow, /sourceType=song/);
  assert.match(workflow, /channel_regression_handle:/);
  assert.match(workflow, /channel_regression_id:/);
  assert.match(workflow, /--channel-probe "\$regression_handle=\$regression_id"/);
});

test('all workflow inputs sent through root SSH use validated canonical base64 tokens', () => {
  for (const name of [
    'SOURCE_TITLE', 'SOURCE_ENTITY_KEY', 'SOURCE_KEY', 'SOURCE_OCCURRENCE_COUNT',
    'SOURCE_VIDEO_COUNT', 'CHANNEL_REGRESSION_HANDLE', 'CHANNEL_REGRESSION_ID',
    'EXPECTED_ACTIVE_REVISION',
  ]) {
    assert.match(workflow, new RegExp(`${name}_B64=%s`));
  }
  assert.ok((workflow.match(/decode_b64\(\)/g) ?? []).length >= 4);
  assert.match(workflow, /base64 --decode/);
  assert.match(workflow, /test "\$\(printf '%s' "\$decoded" \| base64 -w0\)" = "\$encoded"/);
  assert.match(workflow, /\[\[ "\$remote_root" =~ \^\/tmp\/daily-song-list-adapter-\[0-9\]\+\$ \]\]/);
  const rootRemoteLines = workflow.split('\n').filter((line) => /\b(?:ssh|scp)\b/.test(line));
  const rawInputs = [
    'SOURCE_TITLE', 'SOURCE_ENTITY_KEY', 'SOURCE_KEY', 'SOURCE_OCCURRENCE_COUNT',
    'SOURCE_VIDEO_COUNT', 'CHANNEL_REGRESSION_HANDLE', 'CHANNEL_REGRESSION_ID',
    'EXPECTED_ACTIVE_REVISION',
  ];
  for (const line of rootRemoteLines) {
    for (const name of rawInputs) {
      assert.doesNotMatch(line, new RegExp(`\\$${name}(?!_B64)`), `${name} leaked into remote command: ${line}`);
    }
  }
  assert.doesNotMatch(workflow, /ssh[^\n]*q=\$SOURCE_TITLE/);
  assert.doesNotMatch(workflow, /ssh[^\n]*api\/sources\/\$SOURCE_KEY/);
  assert.match(workflow, /ServerAliveInterval=10/);
  assert.match(workflow, /ServerAliveCountMax=3/);
  assert.match(workflow, /timeout --signal=TERM --kill-after=10s 360s ssh/);
});

test('contract verifier separates entity and detail identities and validates video paging', () => {
  assert.match(workflow, /parser\.add_argument\("--source-entity-key", required=True\)/);
  assert.doesNotMatch(workflow, /parser\.add_argument\("--source-type"/);
  assert.doesNotMatch(workflow, /args\.channel_id|args\.source_channel_id/);
  assert.match(workflow, /if card_key != args\.source_entity_key:/);
  assert.match(workflow, /card_key == card_source_detail_key/);
  assert.match(workflow, /record\.get\("key"\)\) != args\.source_entity_key/);
  assert.match(workflow, /entity key conflates opaque source detail key/);
  assert.match(workflow, /source_total_count = integer\(source\.get\("totalCount"\)/);
  assert.match(workflow, /integer\(source\.get\("totalVideoCount"\), "source video total"\)/);
  assert.match(workflow, /integer\(first\(record, "count", "occurrenceCount", "timestampCount"\), "source record count"\)/);
  assert.match(workflow, /integer\(first\(record, "videoCount", "videos"\), "source record video count"\)/);
  assert.match(workflow, /page_video_ids = set\(\)/);
  assert.match(workflow, /page_video_ids\.add\(current\)/);
  assert.match(workflow, /expected_page_videos = min\(source_page_size, args\.videos\)/);
  assert.match(workflow, /len\(page_video_ids\) != expected_page_videos/);
  assert.doesNotMatch(workflow, /len\(occurrences\) > 20/);
  assert.match(workflow, /migrationStatus"\)\) != "active"/);
  assert.doesNotMatch(workflow, /migrationStatus\) == "ready"|\{"active", "ready"\}/);
});

test('P0 has fatal preinstall, public, rollback, finalize, storage, and cleanup gates', () => {
  for (const marker of [
    'PG_ADAPTER_SHA256', 'PG_API_SERVER_SHA256', 'PG_ADAPTER_INSTALLED_HASHES_OK',
    'PG_ADAPTER_PUBLIC_RELAY_CONTRACT_OK', 'PG_ADAPTER_ROLLBACK_RUNTIME_VERIFIED',
    'PG_ADAPTER_CLEANUP_ROLLBACK_VERIFIED', 'systemctl is-active --quiet song-rank-pg-api',
    'sport = :8765', 'rollback-healthz.json', 'rollback-meta.json', 'cleanup-healthz.json',
    'cleanup-meta.json', 'finalize-healthz.json', 'finalize-meta.json',
    'df -B1 /', 'vps-storage-before.txt', 'vps-storage-peak.txt', 'vps-storage-after.txt',
    'vpsStorageBeforeBytes', 'vpsStoragePeakBytes', 'vpsStorageAfterBytes', 'REMOTE_VERIFY_CLEANUP',
    'searchScope=song', '/api/sources/', 'Cache-Control', 'no-store',
    'THUMBNAIL_PATH_PREFIX', 'dQw4w9WgXcQ', 'hqdefault.jpg', 'file --brief --mime-type',
    'invalid/hqdefault.jpg', 'PG_ADAPTER_CONTRACT_FINALIZED', 'release-finalized', 'cmp -s',
  ]) assert.match(workflow, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(workflow, /concurrency:\n\s+group: daily-song-list-pg-adapter-contract\n\s+cancel-in-progress: false/);
  assert.match(workflow, /timeout-minutes: 30/);
  assert.doesNotMatch(workflow, /public_hashes|public adapter hashes|\.meta\.pg_adapter_sha256|\.meta\.pgApiServerSha256|\.meta\.pg_api_server_sha256/);
  assert.match(workflow, /\^\[A-Za-z0-9_-\]\{11\}\$/);
  assert.equal((workflow.match(/release=\$GITHUB_RUN_ID/g) ?? []).length, 3);
  assert.match(workflow, /thumbnail_url="\$PUBLIC_BASE\$THUMBNAIL_PATH_PREFIX\/\$public_video_id\/hqdefault\.jpg"/);
  assert.doesNotMatch(workflow, /THUMBNAIL_PATH_PREFIX\/\$public_video_id\/hqdefault\.jpg\?release=/);
  assert.doesNotMatch(workflow, /THUMBNAIL_PATH_PREFIX\/invalid\/hqdefault\.jpg\?release=/);
  const candidateRelay = workflow.indexOf('candidate_thumbnail_code=');
  const installStep = workflow.indexOf('Install adapter candidate with two-file rollback guard');
  assert.ok(candidateRelay >= 0 && installStep >= 0 && candidateRelay < installStep);
  assert.match(workflow, /candidate_thumbnail_code[^\n]*= 200/);
  assert.match(workflow, /candidate_invalid_thumbnail_code[^\n]*= 400/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /set \+e\n\s+set -o pipefail/);
  assert.match(workflow, /remote_cleanup_ok=0/);
  assert.match(workflow, /test ! -e "\$remote_root"/);
  assert.doesNotMatch(workflow, /assets\/app\.js|\/assets\/app\.js|deploy-pages|deploy-vps-static/);
  assert.doesNotMatch(workflow, /rankings[^\n]*\|\| echo|source[^\n]*\|\| echo|thumbnail[^\n]*\|\| echo/);
});

test('P0 diagnostics and evidence remain fail-closed, bounded, and upload before deletion', () => {
  for (const marker of [
    'source totalCount mismatch ',
    'actual={source_total_count} expected={args.videos}',
    'sourceKey={args.source_key}',
    'source totalVideoCount mismatch ',
    'actual={source_video_count} expected={args.videos}',
    'source totalOccurrenceCount mismatch ',
    'actual={source_occurrence_count} expected={args.occurrences}',
    'Stage bounded pre-cleanup release evidence',
    'Prepare bounded upload sanitizer',
    'Sanitize bounded upload evidence',
    'UPLOAD_EVIDENCE_SANITIZED',
    'remote-archive-failure.txt',
    'candidate-unit-status.txt',
    'candidate-unit-journal.txt',
    'install-failure-service-status.txt',
    'rollback-service-journal.txt',
    'cleanup-service-status.txt',
    'cleanup-service-journal.txt',
    'REMOTE_EVIDENCE_ALLOWLIST',
    'LOCAL_EVIDENCE_ALLOWLIST',
    'remote-candidate-evidence.tar.gz',
    'cleanup-healthz.json',
    'cleanup-meta.json',
    'cleanup-state.txt',
    'cleanup-summary.txt',
    'Upload bounded release evidence',
    'actions/upload-artifact@v4',
    'if-no-files-found: error',
    'Remove runner evidence only after upload attempt',
    'PG_ADAPTER_RUNNER_EVIDENCE_CLEANUP_OK',
  ]) assert.match(workflow, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(workflow, /test "\$bytes" -le 12582912/);
  assert.match(workflow, /test "\$total" -le 33554432/);
  assert.match(workflow, /\[ "\$archive_bytes" -gt 16777216 \]/);
  assert.match(workflow, /test "\$evidence_bytes" -le 35651584/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(workflow, /contents: write|git push|gh workflow run|gh run cancel/);
  const stage = workflow.indexOf('Stage bounded pre-cleanup release evidence');
  const cleanup = workflow.indexOf('Record result and rollback/cleanup on any pre-finalize failure');
  const sanitize = workflow.indexOf('Sanitize bounded upload evidence');
  const upload = workflow.indexOf('Upload bounded release evidence');
  const remove = workflow.indexOf('Remove runner evidence only after upload attempt');
  assert.ok(stage >= 0 && cleanup > stage && sanitize > cleanup && upload > sanitize && remove > upload);
  assert.equal((workflow.match(/rm -rf -- "\$TASK_ROOT"/g) ?? []).length, 1);
  assert.ok(workflow.indexOf('rm -rf -- "$TASK_ROOT"') > upload);
  const uploadTail = workflow.slice(upload, remove);
  assert.match(uploadTail, /path: \$\{\{ env\.TASK_ROOT \}\}\/upload-evidence\//);
  assert.doesNotMatch(uploadTail, /release-evidence|ssh|askpass|backup|server\//i);
  assert.match(workflow, /rm -f -- "\$archive_path" "\$archive_list" "\$archive_sha"/);
  assert.match(workflow, /archive_failure="archive_oversized bytes=/);
  assert.match(workflow, /archive_failure="archive_corrupt_or_listing_unbounded"/);
  assert.match(workflow, /archive_failure="archive_forbidden_path"/);
  assert.match(workflow, /trap cleanup_candidate EXIT/);
  assert.ok(workflow.indexOf('capture_candidate_unit_diagnostics') < workflow.indexOf('systemctl stop "$candidate_unit"'));
  assert.match(workflow, /journalctl --no-pager --output=short-iso[\s\S]*-n 200/);
  assert.match(workflow, /StrictHostKeyChecking=no/);
});

test('v5b transient cleanup helpers and outer archive arrays stay fail-closed', () => {
  const helperPattern = /^ {10}cleanup_candidate_unit\(\) \{\n[\s\S]*?^ {10}\}\n^ {10}(?:cleanup_candidate|finalize_remote_cleanup)\(\) \{/gm;
  const helperMatches = [...workflow.matchAll(helperPattern)];
  assert.equal(helperMatches.length, 2);
  const helpers = helperMatches.map((match) => match[0]
    .replace(/\n {10}(?:cleanup_candidate|finalize_remote_cleanup)\(\) \{$/, '')
    .replace(/^ {10}/gm, ''));
  assert.equal(helpers[0], helpers[1]);
  for (const helper of helpers) {
    assert.match(helper, /local active_after=0/);
    assert.match(helper, /local port_after=0/);
    assert.doesNotMatch(helper, /candidate_active_after|candidate_port_after/);
    assert.match(helper, /resetStatus=%s/);
    assert.match(helper, /failedBefore=%s/);
    assert.match(helper, /failedAfter=%s/);
    assert.ok(helper.indexOf('failed_before=1') < helper.indexOf('systemctl stop "$candidate_unit"'));
    for (const [status, state] of [
      ['show_before_status', 'state_before'],
      ['show_after_stop_status', 'state_after_stop'],
      ['show_after_reset_status', 'state_after_reset'],
    ]) {
      assert.match(helper, new RegExp(String.raw`if \[ "\$${status}" -eq 0 \] && \[ -n "\$${state}" \]`));
      assert.doesNotMatch(helper, new RegExp(String.raw`elif \[ "\$${status}" -eq 1 \]`));
    }
    assert.doesNotMatch(helper, /show_(?:before|after_stop|after_reset)_status"\] -eq 1/);
  }
  const arrayCount = '$' + '{#selected[@]}';
  const arrayValues = '$' + '{selected[@]}';
  const outer = workflow.match(/<<'REMOTE_CLEANUP'\n([\s\S]*?)\n          REMOTE_CLEANUP/);
  assert.ok(outer);
  assert.ok(outer[1].includes(arrayCount));
  assert.ok(outer[1].includes(arrayValues));
  assert.ok(!outer[1].includes('\\' + arrayCount));
  assert.ok(!outer[1].includes('\\' + arrayValues));
  const helperCall = workflow.indexOf('cleanup_candidate_unit "$remote_root/cleanup-candidate-unit-result.txt"');
  const rootDelete = workflow.lastIndexOf('rm -rf -- "$remote_root"');
  assert.ok(helperCall >= 0 && rootDelete > helperCall);
});

console.log('PG_ADAPTER_CONTRACT_GATES_TEST_COMPLETE');
