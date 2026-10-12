import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const converter = process.env.CONVERTER_PATH || join(repositoryRoot, 'scripts/migration/7d-json-to-patch.py');
const importer = process.env.IMPORTER_PATH || join(repositoryRoot, 'scripts/migration/import-pg-incremental.py');
const adapter = process.env.ADAPTER_PATH || join(repositoryRoot, 'server/pg_adapter.py');
const verifier = process.env.VERIFIER_PATH || join(repositoryRoot, 'scripts/migration/verify-7d-api-contract.py');
const activator = process.env.ACTIVATOR_PATH || join(repositoryRoot, 'scripts/migration/activate-pg-candidate.py');
const workflowPath = process.env.WORKFLOW_PATH || join(repositoryRoot, '.github/workflows/deploy-pg-incremental.yml');
const python = process.env.PYTHON || process.env.PYTHON3 || 'python3';
const workflow = readFileSync(workflowPath, 'utf8');
const activatorSource = readFileSync(activator, 'utf8');
const adapterSource = readFileSync(adapter, 'utf8');
const verifierSource = readFileSync(verifier, 'utf8');
const workspace = mkdtempSync(join(tmpdir(), 'pg-7d-authoritative-v3-'));
const commit = 'a'.repeat(40);
const baseCommit = 'b'.repeat(40);
const channelId = 'UC' + 'x'.repeat(22);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gitBlob(value) {
  const body = Buffer.from(value);
  return createHash('sha1').update(Buffer.from(`blob ${body.length}\0`)).update(body).digest('hex');
}

function video(videoId, songs) {
  return {
    videoId,
    channelId,
    channelName: 'Channel',
    publishedTimestamp: 1770000000000,
    title: `Video ${videoId}`,
    songs,
  };
}

function song(sourceId, title, artist = 'Artist') {
  return { sourceId, index: 1, seconds: 10, title, artist, rawHash: `raw-${sourceId}` };
}

function snapshot(generatedAt, items) {
  return { id: '7d', generatedAt, items };
}

function runConverter(base, current, overrides = {}) {
  const basePath = join(workspace, `base-${Date.now()}-${Math.random()}.json`);
  const currentPath = join(workspace, `current-${Date.now()}-${Math.random()}.json`);
  const output = join(workspace, `patch-${Date.now()}-${Math.random()}.ndjson`);
  const manifest = join(workspace, `manifest-${Date.now()}-${Math.random()}.json`);
  const baseRaw = JSON.stringify(base);
  const currentRaw = JSON.stringify(current);
  writeFileSync(basePath, baseRaw);
  writeFileSync(currentPath, currentRaw);
  const result = spawnSync(python, [
    converter,
    '--base-input', basePath,
    '--input', currentPath,
    '--output', output,
    '--manifest-output', manifest,
    '--source-commit', commit,
    '--source-base', baseCommit,
    '--source-blob', overrides.sourceBlob || gitBlob(currentRaw),
    '--base-blob', overrides.baseBlob || gitBlob(baseRaw),
  ], { encoding: 'utf8' });
  return { result, output, manifest, currentRaw, currentPath };
}

test('converter binds Git blobs, source manifest and exact public semantics', () => {
  const base = snapshot('2026-08-01T01:00:00Z', [video('video-old', [song('old-1', 'Old')])]);
  const current = snapshot('2026-08-01T02:00:00Z', [
    video('video-old', [song('old-1', 'Updated')]),
    video('video-new', [song('new-1', 'New')]),
  ]);
  const { result, output, manifest, currentRaw } = runConverter(base, current);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /7D_AUTHORITATIVE_PATCH_COMPLETE/);
  const rows = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.rangeId === '7d' && row.partialRangeReset === true));
  const evidence = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.equal(evidence.rangeResetAppliedBy, 'pg-adapter-authoritative-range-boundary-v2');
  assert.equal(evidence.sourceBlobSha, gitBlob(currentRaw));
  assert.equal(evidence.sourceArtifactSha256, sha256(Buffer.from(currentRaw)));
  assert.equal(evidence.sourceManifestSha256, sha256(Buffer.from(stable(evidence.sourceManifest))));
  assert.equal(evidence.sourceManifest.sourceOccurrenceSemanticsSha256, evidence.sourceOccurrenceSemanticsSha256);
  assert.match(evidence.sourceOccurrenceSemanticsSha256, /^[0-9a-f]{64}$/);
  assert.equal(evidence.acceptedVideoCount, 2);
  assert.equal(evidence.acceptedOccurrenceCount, 2);
  assert.equal(evidence.mutation_count, 5);
  const bad = runConverter(base, current, { sourceBlob: 'c'.repeat(40) });
  assert.notEqual(bad.result.status, 0, 'mismatched immutable source blob must fail');
});

test('importer validates source manifest hash and per-row provenance', () => {
  const script = String.raw`
import hashlib, importlib.util, json, sys, types
sys.modules['psycopg'] = types.SimpleNamespace(connect=lambda *a, **k: None)
spec = importlib.util.spec_from_file_location('candidate_importer', sys.argv[1])
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
source = {
 'schemaVersion':1,'path':'data/7d.json','rangeId':'7d','sourceCommitSha':'a'*40,
 'sourceBlobSha':'c'*40,'sourceArtifactSha256':'d'*64,'generatedAt':'2026-08-01T02:00:00Z',
 'acceptedVideoCount':1,'acceptedOccurrenceCount':1,'sourceOccurrenceSemanticsSha256':'e'*64,
}
digest = hashlib.sha256(json.dumps(source, ensure_ascii=False, sort_keys=True, separators=(',',':')).encode()).hexdigest()
manifest = {
 'handoffKind':'github-core-7d-authoritative-range','status':'ready','rangeId':'7d',
 'authoritativeRange':'7d','rangeReset':True,'partialVideoRows':True,
 'rangeResetAppliedBy':'pg-adapter-authoritative-range-boundary-v2',
 'sourceReachedEnd':True,'mediaDownloaded':False,'statusAuditIncluded':True,
 'mutation_count':3,'acceptedVideoCount':1,'acceptedOccurrenceCount':1,
 'baseVideoCount':1,'baseOccurrenceCount':1,'rangeBoundaryMutationCount':1,
 'rangeResetTombstoneCount':0,'patch_sha256':'f'*64,
 'sourceCommitSha':'a'*40,'sourceBlobSha':'c'*40,'source_blob_sha':'c'*40,
 'sourceArtifactSha256':'d'*64,'generatedAt':'2026-08-01T02:00:00Z',
 'sourceOccurrenceSemanticsSha256':'e'*64,'sourceManifest':source,'sourceManifestSha256':digest,
}
mod.validate_authoritative_7d_manifest(manifest)
row = {'partialRangeReset':True,'rangeId':'7d','sourceCommitSha':'a'*40,
 'sourceBlobSha':'c'*40,'sourceArtifactSha256':'d'*64,'songs':[{'rangeId':'7d'}]}
assert mod.validate_authoritative_7d_record(row, manifest) == 'video'
manifest['sourceManifestSha256'] = '0'*64
try: mod.validate_authoritative_7d_manifest(manifest); raise AssertionError('bad source manifest hash accepted')
except ValueError: pass
print('AUTHORITATIVE_7D_IMPORT_PROVENANCE_OK')
`;
  const result = spawnSync(python, ['-', importer], { input: script, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AUTHORITATIVE_7D_IMPORT_PROVENANCE_OK/);
});

test('activator takes common advisory lock before pointer and enforces every CAS', () => {
  assert.match(activatorSource, /PROJECT_ACTIVE_LOCK = "daily-song-list\/active"/);
  assert.match(activatorSource, /--expected-active-revision/);
  assert.match(activatorSource, /captured active pointer CAS failed/);
  assert.match(activatorSource, /candidate parent\/current active CAS failed/);
  assert.match(workflow, /--expected-active-revision='\$active_revision_before'/);
  const lockAt = activatorSource.indexOf('pg_advisory_xact_lock');
  const pointerAt = activatorSource.indexOf("state_key='active_revision_id' FOR UPDATE");
  assert.ok(lockAt >= 0 && pointerAt > lockAt, 'advisory lock must precede pointer row lock');
  for (const marker of [
    '--expected-parent-revision', '--expected-content-sha256',
    '--expected-source-blob-sha', '--expected-source-manifest-sha256',
    'candidate parent CAS failed', 'candidate content SHA-256 CAS failed',
    'candidate source blob SHA CAS failed', 'active pointer update affected unexpected rows',
  ]) assert.match(activatorSource, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('adapter and verifier make 7d source range explicit and exhaustive', () => {
  assert.match(adapterSource, /_query_options\(query\)\.get\("range"\) == "7d"/);
  assert.match(adapterSource, /pg-adapter-authoritative-range-boundary-v2/);
  assert.match(verifierSource, /\{"range": "7d", "page": page, "pageSize": args\.page_size\}/);
  assert.match(verifierSource, /for source_key in sorted\(source_keys\)/);
  assert.match(verifierSource, /7d source tuple repeated/);
  assert.match(verifierSource, /actual_rows != expected_rows/);
  assert.match(verifierSource, /stale public cache Age/);
  assert.doesNotMatch(verifierSource, /\/api\/sources\/\{quote\(source_key.*\?page=/);
});

test('generic meta validates a top-level 7d boundary but resolves its descendants', () => {
  const script = String.raw`
import importlib.util, sys, types
sys.modules['psycopg'] = types.SimpleNamespace(connect=lambda *a, **k: None)
spec = importlib.util.spec_from_file_location('candidate_adapter', sys.argv[1])
adapter = importlib.util.module_from_spec(spec); sys.modules[spec.name] = adapter; spec.loader.exec_module(adapter)

records = ({'video': {'videoId': 'seven'}, 'occurrences': ({'videoId': 'seven', 'occurrenceId': 'seven-1'},)},)
def run(overlay_ids, candidate_manifest):
    adapter._GENERIC_META_COUNTS_CACHE.clear()
    top = {'manifest_json': candidate_manifest, 'status': 'active'}
    adapter._runtime_projection_revision = lambda connection: None
    adapter._generic_runtime_projection_revision = lambda connection: ('top', top)
    adapter._generic_parent_runtime_revision = lambda connection, revision_id, revision: ('full', {'manifest_json': {}})
    adapter._rows = lambda connection, sql, params=(): [
        {'key': 'latest_occurrences', 'value': '99'},
        {'key': 'source_occurrences_rows', 'value': '297'},
    ] if 'runtime_meta' in sql else []
    adapter._overlay_revision_ids = lambda connection, revision_id, parent_id: list(overlay_ids)
    adapter._apply_generic_overlay_meta_counts = lambda connection, parent_id, ids, counts: dict(counts)
    adapter._authoritative_7d_overlay_ids = lambda connection, ids: tuple(ids)
    adapter._authoritative_7d_records = lambda connection, ids: records
    adapter._generic_overlay_rankings_payload = lambda *args, **kwargs: {'totalOccurrenceCount': 17}
    return adapter.meta_payload(object())

boundary = run(('boundary',), {'acceptedOccurrenceCount': 1})
assert boundary['counts']['occurrences'] == 18, boundary
assert boundary['counts']['source_occurrences'] == 54, boundary
try:
    run(('boundary',), {'acceptedOccurrenceCount': 2})
    raise AssertionError('top-level 7d manifest mismatch accepted')
except adapter.PostgresAdapterError as error:
    assert 'authoritative 7d meta occurrence count mismatch' in str(error), error
descendant = run(('top', 'boundary'), {})
assert descendant['counts']['occurrences'] == 18, descendant
assert descendant['counts']['source_occurrences'] == 54, descendant
print('GENERIC_META_7D_DESCENDANT_BOUNDARY_OK')
`;
  const result = spawnSync(python, ['-', adapter], { input: script, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GENERIC_META_7D_DESCENDANT_BOUNDARY_OK/);
});

test('activator rejects captured-active drift and both reverse CAS mismatches', () => {
  const script = [
    'import contextlib, importlib.util, io, sys, types',
    'state = {}',
    'class Cursor:',
    '  def __init__(self, current, parent): self.current, self.parent, self.row, self.rowcount = current, parent, None, 0',
    '  def __enter__(self): return self',
    '  def __exit__(self, *args): return False',
    '  def execute(self, sql, params=()):',
    '    if "pg_advisory_xact_lock" in sql: return',
    '    if "FROM migration_state" in sql:',
    '      self.row = (self.current,)',
    '      return',
    '    if "FROM migration_revisions" in sql:',
    '      self.row = ("candidate", self.parent, "ready", "c" * 64, "", {})',
    '      return',
    '    self.rowcount = 1',
    '  def fetchone(self): return self.row',
    'class Conn:',
    '  def __init__(self, current, parent): self.current, self.parent = current, parent',
    '  def transaction(self): return self',
    '  def cursor(self): return Cursor(self.current, self.parent)',
    '  def __enter__(self): return self',
    '  def __exit__(self, *args): return False',
    '  def rollback(self): pass',
    '  def close(self): pass',
    'fake = types.SimpleNamespace(connect=lambda *args, **kwargs: state["conn"])',
    'sys.modules["psycopg"] = fake',
    'spec = importlib.util.spec_from_file_location("candidate_activator", sys.argv[1])',
    'mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)',
    'def run(expected_active, expected_parent, current, parent):',
    '  state["conn"] = Conn(current, parent)',
    '  sys.argv = ["activate", "--revision", "candidate", "--expected-active-revision", expected_active, "--expected-parent-revision", expected_parent, "--expected-content-sha256", "c" * 64]',
    '  capture = io.StringIO()',
    '  with contextlib.redirect_stdout(capture): code = mod.main()',
    '  return code, capture.getvalue()',
    'code1 = run("A", "A", "B", "A")',
    'code2 = run("A", "B", "A", "A")',
    'code3 = run("A", "A", "A", "B")',
    'assert code1[0] != 0 and "captured active pointer CAS failed" in code1[1], code1',
    'assert code2[0] != 0 and "expected parent is not the captured active revision" in code2[1], code2',
    'assert code3[0] != 0 and "candidate parent/current active CAS failed" in code3[1], code3',
    'print("ACTIVATOR_CAPTURED_ACTIVE_CAS_OK")',
  ].join('\n');
  const result = spawnSync(python, ['-', activator], { input: script, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ACTIVATOR_CAPTURED_ACTIVE_CAS_OK/);
});

test('small public API projection round-trips every canonical tuple', () => {
  const base = snapshot('2026-08-01T01:00:00Z', [video('video-old', [song('old-1', 'Old')])]);
  const current = snapshot('2026-08-01T02:00:00Z', [
    video('video-old', [song('old-1', 'Updated')]),
    video('video-new', [song('new-1', 'New')]),
  ]);
  const built = runConverter(base, current);
  assert.equal(built.result.status, 0, built.result.stderr);
  const script = String.raw`
import importlib.util, json, pathlib, sys, types
sys.modules['psycopg'] = types.SimpleNamespace(connect=lambda *a, **k: None)
def load(name, path):
 spec=importlib.util.spec_from_file_location(name,path); mod=importlib.util.module_from_spec(spec); sys.modules[name]=mod; spec.loader.exec_module(mod); return mod
adapter=load('candidate_adapter',sys.argv[1]); verifier=load('candidate_verifier',sys.argv[2])
rows=[json.loads(line) for line in pathlib.Path(sys.argv[3]).read_text().splitlines() if line]
records=[]
for row in rows:
 video=adapter._overlay_public_video({'video_payload_json':row})
 songs=tuple(adapter._overlay_public_occurrence(song) for song in row['songs'])
 records.append({'video':video,'occurrences':songs})
rankings=adapter.rankings_payload_from_records(records,{'range':'7d','view':'songs','metric':'occurrences','page':1,'pageSize':200})
actual=[]
for card in rankings['records']:
 source=adapter.source_payload_from_records(records,card['sourceDetailKey'],{'range':'7d','page':1,'pageSize':200})
 assert source['found'] is True
 actual.extend(verifier.api_semantic(item) for item in source['record']['occurrences'])
actual.sort(key=lambda value:(value['videoId'],value['occurrenceId']))
_meta,expected=verifier.expected_semantics(pathlib.Path(sys.argv[4]))
assert actual == expected, (actual,expected)
print('SMALL_PUBLIC_7D_EXHAUSTIVE_OK')
`;
  const result = spawnSync(python, ['-', adapter, verifier, built.output, built.currentPath], { input: script, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SMALL_PUBLIC_7D_EXHAUSTIVE_OK/);
});

test('workflow closes blob-CAS, compatibility, rollback residue and cleanup gates', () => {
  for (const marker of [
    'workflow_run:', 'workflows: ["Update core song-list data"]',
    'WORKFLOW_RUN_HEAD_SHA', 'github.event.workflow_run.conclusion',
    'github-accepted-paths', 'core-data-changed-without-accepted-increment',
    'contents/data/7d.json?ref=main', 'main-7d-blob-drift',
    'locked-pre-activate-7d-blob-cas', 'post-verify-7d-blob-cas',
    'PG_7D_ADAPTER_COMPATIBILITY_OK', 'adapter-install-changed-active',
    "pg_advisory_xact_lock(hashtext('daily-song-list/active'))",
    '--expected-parent-revision', '--expected-source-manifest-sha256',
    'active-lineage', 'orphaned-7d-source-revision',
    'PG_7D_CANDIDATE_DB_CLEAN residue=0', 'candidate-db-residue',
    'PG_7D_REMOTE_CLEANUP_VERIFIED', 'cleanupFailed=',
    '--require-fresh-cache', '--expected-7d', '--source-semantics-sha256',
    'pg-adapter-authoritative-range-boundary-v2',
  ]) assert.match(workflow, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(
    workflow.indexOf('PG_7D_RANGE_ADAPTER_INSTALLED') < workflow.indexOf('--expected-parent-revision'),
    'range-aware adapter install must precede locked activation',
  );
  assert.doesNotMatch(workflow, /git hash-object/);
  assert.doesNotMatch(workflow, /pg-7d-baseline-all\.json/);
  assert.doesNotMatch(workflow, /range-boundary-v1/);
  for (const path of [converter, importer, adapter, verifier, activator]) {
    const result = spawnSync(python, ['-B', '-c', 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), sys.argv[1], "exec")', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
  }
});

test('workflow bounds 7d source probing and retains backups after unrecoverable cleanup', () => {
  const sourceProbeStart = workflow.indexOf('source_identity_probes="$TASK_ROOT/source-identity-probes.jsonl"');
  const sourceProbeEnd = workflow.indexOf('source_detail_probe_metrics()', sourceProbeStart);
  assert.ok(sourceProbeStart >= 0 && sourceProbeEnd > sourceProbeStart, 'source probe block must be present');
  const sourceProbeBlock = workflow.slice(sourceProbeStart, sourceProbeEnd);
  assert.match(sourceProbeBlock, /handoffKind == "github-core-7d-authoritative-range"/);
  assert.match(sourceProbeBlock, /sourceIdentityEvidence\[0\]/);
  assert.match(sourceProbeBlock, /sourceIdentityEvidence\[\]/);
  assert.match(sourceProbeBlock, /elif ! jq -e '\.kind == "accepted-increment"'/);
  assert.match(sourceProbeBlock, /accepted-source-identities-output-missing/);
  const cleanupStart = workflow.indexOf('remote_backup_action=remove');
  const cleanupEnd = workflow.indexOf('PG_INCREMENT_CLEANUP status=', cleanupStart);
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart, 'cleanup block must be present');
  const cleanupBlock = workflow.slice(cleanupStart, cleanupEnd);
  for (const marker of [
    'reason=pointer-not-restored', 'reason=service-restore-failed',
    'PG_7D_OLD_ACTIVE_PRESERVED', 'PG_7D_REMOTE_BACKUP_RETAINED',
    'invalid-backup-action', 'PG_7D_REMOTE_CLEANUP_VERIFIED',
  ]) assert.match(cleanupBlock, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(cleanupBlock.indexOf('remote_backup_action=retain') < cleanupBlock.indexOf('PG_7D_REMOTE_BACKUP_RETAINED'));
});

console.log('7D_AUTHORITATIVE_HANDOFF_V3_TEST_COMPLETE');
