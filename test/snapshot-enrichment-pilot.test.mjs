#!/usr/bin/env node

/* Integration contract test for the projection overlay.
 *
 * This is intentionally not a byte-copy of the provider snapshot test.  It
 * imports the projected provider, resolves the projected adapter and binding,
 * and decompresses the projected gzip fixtures into a temporary directory.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ContractViolation,
  runProvider,
} from '../scripts/migration/snapshot-enrichment-provider.mjs';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const providerPath = path.resolve(here, '../scripts/migration/snapshot-enrichment-provider.mjs');
const adapterPath = path.resolve(here, '../scripts/migration/snapshot-enrichment-adapter.py');
const bindingPath = path.resolve(here, '../scripts/migration/snapshot-enrichment-provider-binding.json');
const manifestPath = path.resolve(here, 'fixtures/snapshot-pilot/snapshot-enrichment-provider-v4-manifest.json');
const fixtureRoot = path.resolve(here, 'fixtures/snapshot-pilot');
const frozen = [
  {
    id: 'jul29-25',
    fixture: path.join(fixtureRoot, 'jul29-sample25.json.gz'),
    sha256: '4b53aeb1a7b72c4efc34c6fa972b60a245e6a6bda49868f38d145fdc4c220fcf',
    count: 25,
  },
  {
    id: 'jul22-19',
    fixture: path.join(fixtureRoot, 'jul22-sample19.json.gz'),
    sha256: 'e882b4387553f67c86db53877d025614d5fc808104490c3cdbbc195a4e697eb6',
    count: 19,
  },
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readNdjson(file) {
  return readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function videosFromSample(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.videos)) return payload.videos;
  throw new Error('fixture has no supported video list');
}

function dependenciesFor(spec, payload) {
  const videos = videosFromSample(payload);
  return {
    async fetchVideoSongList(candidate) {
      const index = videos.findIndex((value) => value.videoId === candidate.videoId);
      if (spec.id === 'jul29-25' && index === 0) {
        return {
          detail: null,
          audit: { videoId: candidate.videoId, result: 'no_timestamp_source', testOnly: true },
        };
      }
      return {
        detail: candidate,
        audit: { videoId: candidate.videoId, result: 'fixture_detail', testOnly: true },
      };
    },
    async enrichDetail(detail) {
      return detail;
    },
    occurrenceRecordsFromDetail(detail) {
      if (Array.isArray(detail?.songs)) return detail.songs;
      if (Array.isArray(detail?.occurrences)) return detail.occurrences;
      return [];
    },
  };
}

async function runAdapter(providerFile, outputFile) {
  const result = await execFileAsync('python3', [adapterPath, '--provider', providerFile, '--out', outputFile], { timeout: 30000 });
  assert.match(result.stdout, /"ok": true/);
  return readNdjson(outputFile);
}

async function main() {
  assert.equal(existsSync(providerPath), true, 'projected provider missing');
  assert.equal(existsSync(adapterPath), true, 'projected adapter missing');
  assert.equal(existsSync(bindingPath), true, 'projected binding missing');
  assert.equal(existsSync(manifestPath), true, 'projected v4 manifest missing');
  const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
  const providerManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(binding.status, 'BOUND_V4');
  assert.equal(binding.providerV4.sha256, sha256(readFileSync(providerPath)));
  assert.equal(binding.adapterV4.sha256, sha256(readFileSync(adapterPath)));
  assert.equal(binding.v4EvidenceManifest.sha256, sha256(readFileSync(manifestPath)));
  assert.equal(providerManifest.provider, 'snapshot-enrichment-provider-v4');

  const temp = await mkdtemp(path.join(os.tmpdir(), 'snapshot-pilot-overlay-'));
  const results = [];
  try {
    for (const spec of frozen) {
      const rawFile = path.join(temp, `${spec.id}.json`);
      const providerFile = path.join(temp, `${spec.id}.provider.ndjson`);
      const outputFile = path.join(temp, `${spec.id}.enriched.ndjson`);
      const raw = gunzipSync(readFileSync(spec.fixture));
      assert.equal(sha256(raw), spec.sha256, `${spec.id} decompressed SHA`);
      const payload = JSON.parse(raw.toString('utf8'));
      assert.equal(videosFromSample(payload).length, spec.count, `${spec.id} count`);
      await writeFile(rawFile, raw);
      const providerResult = await runProvider({
        sample: rawFile,
        expectedSha: spec.sha256,
        expectedCount: spec.count,
        out: providerFile,
        dependencies: dependenciesFor(spec, payload),
        singerName: 'projection-test',
      });
      assert.equal(providerResult.recordCount, spec.count);
      const providerLines = readNdjson(providerFile);
      const header = providerLines.shift();
      const expectedIds = videosFromSample(payload).map((value) => value.videoId);
      assert.deepEqual(header.expectedIds, expectedIds, `${spec.id} expectedIds`);
      assert.equal(header.provider, 'snapshot-enrichment-provider-v4');
      assert.equal(header.contract, 'luna-max-mac-enrichment/v4-candidate');
      assert.equal(header.releaseReady, false);
      const records = await runAdapter(providerFile, outputFile);
      assert.deepEqual(records.map((value) => value.videoId), expectedIds, `${spec.id} adapter closure`);
      assert.ok(records.every((value) => value.audit !== undefined), `${spec.id} audit retained`);
      if (spec.id === 'jul29-25') {
        assert.equal(records[0].status, 'needs_review');
        assert.equal(records[0].diagnostic.code, 'detail_null');
      }
      assert.ok(records.every((value) => value.status !== 'ok' || value.songs.length > 0), `${spec.id} empty songs not ok`);
      results.push({ id: spec.id, count: records.length, needsReviewCount: records.filter((value) => value.status === 'needs_review').length });
    }

    const malformedOut = path.join(temp, 'malformed.provider.ndjson');
    const malformed = {
      fetchVideoSongList: async () => ({ detail: {} }),
      enrichDetail: async (detail) => detail,
      occurrenceRecordsFromDetail: () => [],
    };
    await assert.rejects(
      () => runProvider({ sample: path.join(temp, 'jul29-25.json'), expectedSha: frozen[0].sha256, expectedCount: 25, out: malformedOut, dependencies: malformed }),
      (error) => error instanceof ContractViolation && error.batchFatal === true,
      'wrapper shape violation must be batch-fatal',
    );
    results.push({ wrapperShapeViolation: 'batch_fatal' });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ status: 'PASS', overlay: true, results, NOT_FOR_RELEASE: true }));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
