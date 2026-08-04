#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { eventTimeOf } from '../scripts/migration/snapshot-enrichment-provider.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const jul22Fixture = path.resolve(here, 'fixtures/snapshot-pilot/jul22-sample19.json.gz');

test('explicit eventTime remains authoritative', () => {
  assert.equal(
    eventTimeOf({ eventTime: '2026-07-22T16:18:31.000Z', publishedAt: '2026-07-01T00:00:00Z' }),
    '2026-07-22T16:18:31.000Z',
  );
});

test('publishedAtIso supplies canonical eventTime', () => {
  assert.equal(eventTimeOf({ publishedAtIso: '2026-07-22T09:18:31-07:00' }), '2026-07-22T16:18:31.000Z');
});

test('publishedAt supplies canonical eventTime', () => {
  assert.equal(eventTimeOf({ publishedAt: '2026-07-22T16:18:31Z' }), '2026-07-22T16:18:31.000Z');
});

test('publishedTimestampIsoUtc supplies canonical eventTime', () => {
  assert.equal(eventTimeOf({ publishedTimestampIsoUtc: '2026-07-22T16:18:31Z' }), '2026-07-22T16:18:31.000Z');
});

test('Jul22 immutable fixture supplies eventTime for all 19 videos', () => {
  const payload = JSON.parse(gunzipSync(readFileSync(jul22Fixture)).toString('utf8'));
  assert.equal(payload.videos.length, 19);
  const target = payload.videos.find((value) => value.videoId === '1b9E79L7PmQ');
  assert.equal(target?.publishedTimestamp, 1784737111000);
  assert.equal(eventTimeOf(target), '2026-07-22T16:18:31.000Z');
  assert.ok(
    payload.videos.every((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(eventTimeOf(value))),
  );
});
