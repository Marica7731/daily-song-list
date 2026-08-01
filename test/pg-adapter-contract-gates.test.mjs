import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(process.env.WORKFLOW_PATH, 'utf8');

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

console.log('PG_ADAPTER_CONTRACT_GATES_TEST_COMPLETE');
