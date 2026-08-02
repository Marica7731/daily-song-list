#!/usr/bin/env node

/* Candidate-only provider for the frozen enrichment samples.
 *
 * The production dependency boundary is intentionally strict: the updater
 * export returns exactly { detail, audit }, not a bare detail. A per-video
 * dependency error becomes an auditable needs_review record; input, hash, and
 * contract errors remain batch-fatal.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROVIDER_VERSION = 'snapshot-enrichment-provider-v4';
export const SCHEMA_VERSION = 'luna-max-mac-enrichment/v4-candidate';

const RECORD_FIELDS = [
  'recordType',
  'schemaVersion',
  'videoId',
  'trialRoute',
  'releaseRoute',
  'releaseCutoffUtc',
  'eventTime',
  'channelId',
  'channelTitle',
  'songs',
  'status',
  'diagnostic',
  'audit',
];

const SONG_FIELDS = ['occurrenceId', 'seconds', 'title', 'artist', 'source'];
const SOURCE_FIELDS = ['sourceId', 'sourceHash', 'rawHash', 'sourcePath', 'sourceSystem', 'provenance'];

function fail(message, exitCode = 2) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`);
    const key = token.slice(2).replaceAll('-', '_');
    if (key === 'mock') {
      args.mock = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class ContractViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractViolation';
    this.code = 'batch_contract_violation';
    this.batchFatal = true;
  }
}

function isContractViolation(error) {
  return error instanceof ContractViolation || error?.batchFatal === true;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function firstString(...values) {
  for (const value of values) {
    const normalized = nonEmptyString(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function nonEmptyObject(value) {
  return isObject(value) && Object.keys(value).length > 0 ? value : null;
}

function hasEvidence(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function firstEvidence(...values) {
  for (const value of values) {
    if (hasEvidence(value)) return value;
  }
  return null;
}

function videoIdOf(video) {
  const id = video?.videoId ?? video?.enrichmentKey?.videoId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function routeOf(video, sampleTrialRoute) {
  const route = firstEvidence(video?.trialRoute, video?.route, sampleTrialRoute);
  return typeof route === 'string' && route.trim() ? route : null;
}

function extractVideos(payload, samplePath) {
  if (Array.isArray(payload)) return { videos: payload, trialRoute: null };
  if (isObject(payload) && Array.isArray(payload.videos)) {
    return { videos: payload.videos, trialRoute: payload.trialRoute ?? null };
  }
  fail(`sample must be an array or an object with videos[]: ${samplePath}`);
}

function readSample(samplePath) {
  let bytes;
  let payload;
  try {
    bytes = readFileSync(samplePath);
    payload = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`sample is not valid UTF-8 JSON: ${samplePath}: ${error.message}`);
  }
  const extracted = extractVideos(payload, samplePath);
  const ids = [];
  const seen = new Set();
  for (let index = 0; index < extracted.videos.length; index += 1) {
    const id = videoIdOf(extracted.videos[index]);
    if (id === null) fail(`sample row ${index} has no non-empty videoId`);
    if (seen.has(id)) fail(`sample contains duplicate videoId: ${id}`);
    seen.add(id);
    ids.push(id);
  }
  return {
    bytes,
    payload,
    videos: extracted.videos,
    trialRoute: extracted.trialRoute,
    sha256: sha256(bytes),
    ids,
  };
}

function timestampToIso(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dateStringToIso(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value.trim());
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isCanonicalIsoUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function eventTimeOf(value) {
  if (!isObject(value)) return null;
  const direct = firstEvidence(
    value.eventTime,
    value.publishedAtIso,
    value.publishedAt,
    value.publishedTimestampIsoUtc,
  );
  if (typeof direct === 'string') return dateStringToIso(direct);
  if (typeof direct === 'number') return timestampToIso(direct);
  return timestampToIso(value.publishedTimestamp);
}

function sourceField(record, source, provenance, key) {
  return firstString(source?.[key], record?.[key], provenance?.[key]);
}

function numericSeconds(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function songFromOccurrence(record) {
  const occurrence = isObject(record?.occurrence) ? record.occurrence : null;
  const sourceValue = isObject(record?.source) ? record.source : null;
  const provenance = nonEmptyObject(record?.provenance) ?? nonEmptyObject(sourceValue?.provenance);
  const song = isObject(record?.song) ? record.song : null;
  return {
    occurrenceId: firstString(
      record?.occurrenceId,
      occurrence?.occurrenceId,
      occurrence?.id,
      record?.id,
    ),
    seconds: numericSeconds(record?.seconds, occurrence?.seconds, song?.seconds),
    title: firstString(record?.title, record?.cleanedTitle, record?.rawTitle, song?.title),
    artist: firstString(record?.artist, record?.cleanedArtist, record?.rawArtist, song?.artist),
    source: {
      sourceId: sourceField(record, sourceValue, provenance, 'sourceId'),
      sourceHash: sourceField(record, sourceValue, provenance, 'sourceHash'),
      rawHash: sourceField(record, sourceValue, provenance, 'rawHash'),
      sourcePath: sourceField(record, sourceValue, provenance, 'sourcePath'),
      sourceSystem: sourceField(record, sourceValue, provenance, 'sourceSystem'),
      provenance: provenance ?? null,
    },
  };
}

function missingRequirements(record, detailPresent) {
  const missing = [];
  if (!detailPresent) missing.push('detail');
  if (!isObject(record.audit)) missing.push('audit');
  if (!isCanonicalIsoUtc(record.eventTime)) missing.push('eventTime');
  if (nonEmptyString(record.channelId) === null) missing.push('channelId');
  if (nonEmptyString(record.channelTitle) === null) missing.push('channelTitle');
  if (!Array.isArray(record.songs) || record.songs.length === 0) missing.push('songs');
  for (let index = 0; index < (Array.isArray(record.songs) ? record.songs.length : 0); index += 1) {
    const song = record.songs[index];
    const prefix = `songs[${index}]`;
    if (nonEmptyString(song.occurrenceId) === null) missing.push(`${prefix}.occurrenceId`);
    if (typeof song.seconds !== 'number' || !Number.isFinite(song.seconds) || song.seconds < 0) {
      missing.push(`${prefix}.seconds`);
    }
    if (nonEmptyString(song.title) === null) missing.push(`${prefix}.title`);
    if (nonEmptyString(song.artist) === null) missing.push(`${prefix}.artist`);
    for (const key of SOURCE_FIELDS) {
      if (key === 'provenance') {
        if (nonEmptyObject(song.source?.provenance) === null) missing.push(`${prefix}.source.provenance`);
      } else if (nonEmptyString(song.source?.[key]) === null) {
        missing.push(`${prefix}.source.${key}`);
      }
    }
  }
  return missing;
}

export function recordStatus(record, detailPresent) {
  return missingRequirements(record, detailPresent).length === 0 ? 'ok' : 'needs_review';
}

function diagnosticFor(record, detailPresent, existing) {
  const missing = missingRequirements(record, detailPresent);
  if (existing) {
    return missing.length ? { ...existing, missing } : existing;
  }
  return missing.length ? { code: 'incomplete_record', missing } : null;
}

function outputRecord(video, detail, enriched, occurrenceRows, sampleTrialRoute, audit, diagnostic = null) {
  const source = isObject(enriched) ? enriched : isObject(detail) ? detail : {};
  const channelId = firstString(source.channelId, source.channel?.id, video?.channelId, video?.channel?.id);
  const channelTitle = firstString(
    source.channelTitle,
    source.channelName,
    source.channel?.title,
    source.channel?.name,
    video?.channelTitle,
    video?.channelName,
    video?.channel?.title,
    video?.channel?.name,
  );
  const eventTime = eventTimeOf(enriched) ?? eventTimeOf(detail) ?? eventTimeOf(video);
  const record = {
    recordType: 'enrichment',
    schemaVersion: SCHEMA_VERSION,
    videoId: videoIdOf(video),
    trialRoute: routeOf(video, sampleTrialRoute),
    releaseRoute: null,
    releaseCutoffUtc: null,
    eventTime,
    channelId,
    channelTitle,
    songs: Array.isArray(occurrenceRows) ? occurrenceRows.map(songFromOccurrence) : [],
    status: null,
    diagnostic,
    audit: audit ?? null,
  };
  const detailPresent = detail !== null && detail !== undefined;
  record.status = recordStatus(record, detailPresent);
  record.diagnostic = diagnosticFor(record, detailPresent, record.diagnostic);
  return record;
}

function errorRecord(video, sampleTrialRoute, audit, phase, error) {
  return outputRecord(
    video,
    null,
    null,
    [],
    sampleTrialRoute,
    audit,
    { code: 'video_dependency_error', phase, message: error.message },
  );
}

export function normalizeFetchedResult(value, videoId) {
  const keys = isObject(value) ? Object.keys(value).sort() : [];
  if (keys.length !== 2 || keys[0] !== 'audit' || keys[1] !== 'detail') {
    throw new ContractViolation(`fetchVideoSongList contract violation for ${videoId}: expected exactly {detail,audit} wrapper`);
  }
  if (value.detail !== null && !isObject(value.detail)) {
    throw new ContractViolation(`fetchVideoSongList contract violation for ${videoId}: detail must be object or null`);
  }
  if (value.audit !== null && !isObject(value.audit)) {
    throw new ContractViolation(`fetchVideoSongList contract violation for ${videoId}: audit must be object or null`);
  }
  return { detail: value.detail, audit: value.audit };
}

export function createMockDependencies() {
  return {
    async fetchVideoSongList(candidate) {
      if (candidate?.providerError) throw new Error(String(candidate.providerError));
      const detail = candidate?.detail ?? candidate;
      return {
        detail: detail === null ? null : detail,
        audit: { videoId: candidate.videoId, result: detail === null ? 'no_detail' : 'mock' },
      };
    },
    async enrichDetail(detail) {
      return detail;
    },
    occurrenceRecordsFromDetail(detail) {
      if (Array.isArray(detail?.occurrences)) return detail.occurrences;
      if (Array.isArray(detail?.occurrenceRecords)) return detail.occurrenceRecords;
      if (Array.isArray(detail?.songs)) return detail.songs;
      return [];
    },
  };
}

function exported(moduleValue, name) {
  return moduleValue?.[name] ?? moduleValue?.default?.[name];
}

export async function loadRepositoryDependencies(repoRoot) {
  const coreUrl = pathToFileURL(path.resolve(repoRoot, 'scripts/youtube-channel-discovery-core.js')).href;
  const updaterUrl = pathToFileURL(path.resolve(repoRoot, 'scripts/update-songlist.js')).href;
  const [core, updater] = await Promise.all([import(coreUrl), import(updaterUrl)]);
  const dependencies = {
    fetchVideoSongList: exported(updater, 'fetchVideoSongList'),
    enrichDetail: exported(core, 'enrichDetail'),
    occurrenceRecordsFromDetail: exported(core, 'occurrenceRecordsFromDetail'),
  };
  for (const [name, value] of Object.entries(dependencies)) {
    if (typeof value !== 'function') fail(`repository dependency is not exported: ${name}`);
  }
  return dependencies;
}

export async function runProvider({
  sample,
  expectedSha,
  expectedCount,
  out,
  repoRoot,
  dependencies,
  mock = false,
  curationContext,
  singerName = '',
}) {
  if (!sample) fail('--sample is required');
  if (!out) fail('--out is required');
  const loaded = readSample(sample);
  if (expectedSha && loaded.sha256.toLowerCase() !== String(expectedSha).toLowerCase()) {
    fail(`sample SHA-256 mismatch: expected ${expectedSha}, got ${loaded.sha256}`);
  }
  if (expectedCount !== undefined && loaded.videos.length !== Number(expectedCount)) {
    fail(`sample count mismatch: expected ${expectedCount}, got ${loaded.videos.length}`);
  }
  const deps = dependencies ?? (mock ? createMockDependencies() : await loadRepositoryDependencies(repoRoot ?? process.cwd()));
  const records = [];
  for (let index = 0; index < loaded.videos.length; index += 1) {
    const video = loaded.videos[index];
    const id = videoIdOf(video);
    let audit = null;
    try {
      const fetched = normalizeFetchedResult(await deps.fetchVideoSongList(video, curationContext), id);
      audit = fetched.audit;
      if (fetched.detail === null) {
        records.push(outputRecord(video, null, null, [], loaded.trialRoute, audit, {
          code: 'detail_null',
          phase: 'fetchVideoSongList',
          message: 'fetchVideoSongList returned detail=null',
        }));
        continue;
      }
      const enriched = await deps.enrichDetail(fetched.detail, video, singerName);
      const occurrenceRows = await deps.occurrenceRecordsFromDetail(enriched, singerName);
      if (!Array.isArray(occurrenceRows)) {
        throw new ContractViolation('occurrenceRecordsFromDetail contract violation: expected an array');
      }
      records.push(outputRecord(video, fetched.detail, enriched, occurrenceRows, loaded.trialRoute, audit));
    } catch (error) {
      if (isContractViolation(error)) throw error;
      records.push(errorRecord(video, loaded.trialRoute, audit, error.phase ?? 'dependency', error));
    }
  }
  if (records.length !== loaded.ids.length) fail(`internal record cardinality mismatch: expected ${loaded.ids.length}, got ${records.length}`);
  const header = {
    provider: PROVIDER_VERSION,
    contract: SCHEMA_VERSION,
    sample: path.resolve(sample),
    sampleSha256: loaded.sha256,
    sampleCount: loaded.videos.length,
    expectedIds: loaded.ids,
    recordCount: records.length,
    needsReviewCount: records.filter((record) => record.status === 'needs_review').length,
    releaseReady: false,
  };
  const output = [JSON.stringify(header), ...records.map((record) => JSON.stringify(record))].join('\n') + '\n';
  await writeFile(out, output, 'utf8');
  return {
    sampleSha256: loaded.sha256,
    sampleCount: loaded.videos.length,
    expectedIds: loaded.ids,
    recordCount: records.length,
    needsReviewCount: header.needsReviewCount,
    out,
  };
}

export { RECORD_FIELDS, SONG_FIELDS, SOURCE_FIELDS, videoIdOf };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  runProvider(args).then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  });
}
