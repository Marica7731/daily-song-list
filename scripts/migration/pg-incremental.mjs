import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

export const SCHEMA_SQL = readFileSync(new URL("./pg-schema.sql", import.meta.url), "utf8");

function resultRows(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function hasOwn(value, key) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function field(value, camelKey, snakeKey = camelKey) {
  if (hasOwn(value, camelKey)) return value[camelKey];
  if (hasOwn(value, snakeKey)) return value[snakeKey];
  return null;
}

function preservedText(value) {
  return value === null || value === undefined ? null : String(value);
}

function validateVideoId(videoId) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new Error(`invalid videoId: ${videoId || "<empty>"}`);
  }
}

function normalizeSong(song, index) {
  const seconds = field(song, "seconds");
  if (seconds !== null && (!Number.isInteger(seconds) || seconds < 0)) {
    throw new Error(`songs[${index}].seconds must be null or a non-negative integer`);
  }
  const positionValue = field(song, "position");
  const position = positionValue === null ? index : positionValue;
  if (!Number.isInteger(position) || position < 0) {
    throw new Error(`songs[${index}].position must be a non-negative integer`);
  }
  const occurrenceId = preservedText(field(song, "occurrenceId", "occurrence_id"));
  const occurrenceKey = occurrenceId === null || occurrenceId === ""
    ? `position:${position}`
    : `occurrence:${occurrenceId}`;
  return {
    seconds,
    occurrenceKey,
    occurrenceId,
    position,
    rangeId: preservedText(field(song, "rangeId", "range_id")),
    songKey: preservedText(field(song, "songKey", "song_key")),
    title: preservedText(field(song, "title")),
    artist: preservedText(field(song, "artist")),
    sourceId: preservedText(field(song, "sourceId", "source_id")),
    rawHash: preservedText(field(song, "rawHash", "raw_hash")),
    sourceSystem: preservedText(field(song, "sourceSystem", "source_system")),
    payload: song,
  };
}

export function normalizeRuntimeRecord(record) {
  const entityType = cleanText(record?.entityType ?? record?.entity_type);
  const entityKey = preservedText(record?.entityKey ?? record?.entity_key);
  if (!entityType || entityKey === null || entityKey === "") {
    throw new Error("runtime record requires entityType and entityKey");
  }
  return {
    entityType,
    entityKey,
    sourceSystem: preservedText(record?.sourceSystem ?? record?.source_system),
    rangeId: preservedText(record?.rangeId ?? record?.range_id),
    sourceId: preservedText(record?.sourceId ?? record?.source_id),
    occurrenceId: preservedText(record?.occurrenceId ?? record?.occurrence_id),
    tombstone: record?.deleted === true || record?.tombstone === true,
    payload: record?.payload && typeof record.payload === "object" ? record.payload : record,
  };
}

export function normalizeVideoRecord(record) {
  const videoId = cleanText(record?.videoId ?? record?.video_id ?? record?.item?.videoId);
  validateVideoId(videoId);
  const deleted = record?.deleted === true || record?.tombstone === true;
  const title = preservedText(record?.title ?? record?.item?.title);
  if (!deleted && title === null) throw new Error(`video ${videoId} requires title`);
  const songs = deleted ? [] : (Array.isArray(record?.songs) ? record.songs.map(normalizeSong) : []);
  if (!deleted && !songs.length) throw new Error(`video ${videoId} requires a non-empty songs array`);
  const seenOccurrenceKeys = new Set();
  for (const song of songs) {
    if (seenOccurrenceKeys.has(song.occurrenceKey)) {
      throw new Error(`video ${videoId} repeats occurrence identity=${song.occurrenceKey}`);
    }
    seenOccurrenceKeys.add(song.occurrenceKey);
  }
  songs.sort((left, right) => left.position - right.position || left.occurrenceKey.localeCompare(right.occurrenceKey));
  const reviewedAt = cleanText(record?.reviewedAt ?? record?.reviewed_at);
  const reviewedBy = cleanText(record?.reviewedBy ?? record?.reviewed_by);
  const reason = cleanText(record?.reason);
  if (!reviewedAt || !reviewedBy || !reason) {
    throw new Error(`video ${videoId} requires reason, reviewedAt, and reviewedBy`);
  }
  return {
    videoId,
    title,
    channelName: preservedText(record?.channelName ?? record?.channel_name ?? record?.item?.channelName),
    channelId: preservedText(record?.channelId ?? record?.channel_id ?? record?.item?.channelId),
    channelHandle: preservedText(record?.channelHandle ?? record?.channel_handle),
    channelUrl: preservedText(record?.channelUrl ?? record?.channel_url),
    publishedAt: record?.publishedAt ?? record?.published_at ?? null,
    deleted,
    songs,
    audit: {
      reason,
      reviewedAt,
      reviewedBy,
      note: cleanText(record?.note),
    },
    payload: record,
  };
}

export async function ensureSchema(client) {
  const statements = SCHEMA_SQL
    .split(/;\s*(?=\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await client.query(statement);
}

async function activeRevisionId(client) {
  const result = await client.query(
    "SELECT state_value FROM migration_state WHERE state_key = 'active_revision_id'",
  );
  return cleanText(resultRows(result)[0]?.state_value);
}

async function createRevision(client, manifest, revisionId = `rev_${Date.now()}_${randomUUID().slice(0, 8)}`) {
  const parentRevisionId = await activeRevisionId(client);
  const sourceManifestSha256 = cleanText(manifest?.sourceManifestSha256)
    || sha256(stableJson(manifest ?? {}));
  await client.query(
    `INSERT INTO migration_revisions
      (revision_id, parent_revision_id, status, source_manifest_sha256, manifest_json)
     VALUES ($1, NULLIF($2, ''), 'draft', $3, $4::jsonb)`,
    [revisionId, parentRevisionId, sourceManifestSha256, JSON.stringify(manifest ?? {})],
  );
  return { revisionId, parentRevisionId, sourceManifestSha256 };
}

async function upsertVideo(client, revisionId, record) {
  const video = normalizeVideoRecord(record);
  await client.query(
    `INSERT INTO migration_video_rows
      (revision_id, video_id, title, channel_name, channel_id, channel_handle, channel_url, published_at, tombstone, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (revision_id, video_id) DO UPDATE SET
       title = EXCLUDED.title,
       channel_name = EXCLUDED.channel_name,
       channel_id = EXCLUDED.channel_id,
       channel_handle = EXCLUDED.channel_handle,
       channel_url = EXCLUDED.channel_url,
       published_at = EXCLUDED.published_at,
       tombstone = EXCLUDED.tombstone,
       payload_json = EXCLUDED.payload_json`,
    [
      revisionId,
      video.videoId,
      video.title,
      video.channelName,
      video.channelId,
      video.channelHandle,
      video.channelUrl,
      video.publishedAt,
      video.deleted,
      JSON.stringify(video.payload),
    ],
  );
  await client.query(
    "DELETE FROM migration_occurrence_rows WHERE revision_id = $1 AND video_id = $2",
    [revisionId, video.videoId],
  );
  for (const song of video.songs) {
    await client.query(
      `INSERT INTO migration_occurrence_rows
        (revision_id, video_id, occurrence_key, occurrence_id, position, range_id, song_key, seconds, title, artist, source_id, raw_hash, source_system, payload_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
      [
        revisionId,
        video.videoId,
        song.occurrenceKey,
        song.occurrenceId,
        song.position,
        song.rangeId,
        song.songKey,
        song.seconds,
        song.title,
        song.artist,
        song.sourceId,
        song.rawHash,
        song.sourceSystem,
        JSON.stringify(song.payload),
      ],
    );
  }
  await client.query(
    `INSERT INTO migration_audit_rows (revision_id, video_id, reason, reviewed_at, reviewed_by, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (revision_id, video_id) DO UPDATE SET
       reason = EXCLUDED.reason,
       reviewed_at = EXCLUDED.reviewed_at,
       reviewed_by = EXCLUDED.reviewed_by,
       note = EXCLUDED.note`,
    [
      revisionId,
      video.videoId,
      video.audit.reason,
      video.audit.reviewedAt,
      video.audit.reviewedBy,
      video.audit.note,
    ],
  );
  return video;
}

async function upsertRuntime(client, revisionId, record) {
  const runtime = normalizeRuntimeRecord(record);
  await client.query(
    `INSERT INTO migration_runtime_rows
      (revision_id, entity_type, entity_key, source_system, range_id, source_id, occurrence_id, tombstone, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (revision_id, entity_type, entity_key) DO UPDATE SET
       source_system = EXCLUDED.source_system,
       range_id = EXCLUDED.range_id,
       source_id = EXCLUDED.source_id,
       occurrence_id = EXCLUDED.occurrence_id,
       tombstone = EXCLUDED.tombstone,
       payload_json = EXCLUDED.payload_json`,
    [
      revisionId,
      runtime.entityType,
      runtime.entityKey,
      runtime.sourceSystem,
      runtime.rangeId,
      runtime.sourceId,
      runtime.occurrenceId,
      runtime.tombstone,
      JSON.stringify(runtime.payload),
    ],
  );
  return runtime;
}

async function revisionLineage(client, revisionId) {
  const lineage = [];
  const seen = new Set();
  let current = cleanText(revisionId);
  while (current) {
    if (seen.has(current)) throw new Error(`revision parent cycle: ${current}`);
    seen.add(current);
    const result = await client.query(
      "SELECT revision_id, parent_revision_id FROM migration_revisions WHERE revision_id = $1",
      [current],
    );
    const row = resultRows(result)[0];
    if (!row) throw new Error(`unknown revision: ${current}`);
    lineage.push(row.revision_id);
    current = cleanText(row.parent_revision_id);
  }
  return lineage;
}

export async function resolveRevision(client, revisionId) {
  const videos = new Map();
  const occurrences = new Map();
  const audits = new Map();
  const runtimeRows = new Map();
  for (const revision of await revisionLineage(client, revisionId)) {
    const videoRows = resultRows(await client.query(
       `SELECT video_id, title, channel_name, channel_id, channel_handle, channel_url, published_at, tombstone, payload_json
       FROM migration_video_rows WHERE revision_id = $1`,
      [revision],
    ));
    for (const row of videoRows) {
      if (videos.has(row.video_id)) continue;
      videos.set(row.video_id, row);
      if (row.tombstone) occurrences.set(row.video_id, []);
    }
    const occurrenceRows = resultRows(await client.query(
      `SELECT video_id, occurrence_key, occurrence_id, position, range_id, song_key, seconds, title, artist, source_id, raw_hash, source_system, payload_json
       FROM migration_occurrence_rows WHERE revision_id = $1 ORDER BY video_id, position, occurrence_key`,
      [revision],
    ));
    const revisionOccurrences = new Map();
    for (const row of occurrenceRows) {
      if (!revisionOccurrences.has(row.video_id)) revisionOccurrences.set(row.video_id, []);
      revisionOccurrences.get(row.video_id).push(row);
    }
    for (const [videoId, rows] of revisionOccurrences) {
      if (!occurrences.has(videoId)) occurrences.set(videoId, rows);
    }
    const auditRows = resultRows(await client.query(
      "SELECT video_id, reason, reviewed_at, reviewed_by, note FROM migration_audit_rows WHERE revision_id = $1",
      [revision],
    ));
    for (const row of auditRows) if (!audits.has(row.video_id)) audits.set(row.video_id, row);
    const runtime = resultRows(await client.query(
      `SELECT entity_type, entity_key, source_system, range_id, source_id,
              occurrence_id, tombstone, payload_json
       FROM migration_runtime_rows WHERE revision_id = $1
       ORDER BY entity_type, entity_key`,
      [revision],
    ));
    for (const row of runtime) {
      const key = `${row.entity_type}\u0000${row.entity_key}`;
      if (!runtimeRows.has(key)) runtimeRows.set(key, row);
    }
  }
  const records = [...videos.values()].filter((video) => !video.tombstone).sort((left, right) => left.video_id.localeCompare(right.video_id)).map((video) => ({
    videoId: video.video_id,
    title: video.title,
    channelName: video.channel_name,
    channelId: video.channel_id,
    channelHandle: video.channel_handle,
    channelUrl: video.channel_url,
    publishedAt: video.published_at,
    songs: (occurrences.get(video.video_id) ?? []).sort((left, right) => left.position - right.position || left.occurrence_key.localeCompare(right.occurrence_key)).map((song) => ({
      occurrenceId: song.occurrence_id,
      position: Number(song.position),
      rangeId: song.range_id,
      songKey: song.song_key,
      seconds: song.seconds === null ? null : Number(song.seconds),
      title: song.title,
      artist: song.artist,
      sourceId: song.source_id,
      rawHash: song.raw_hash,
      sourceSystem: song.source_system,
    })),
    audit: audits.get(video.video_id) ?? null,
  }));
  return {
    revisionId: cleanText(revisionId),
    records,
    runtimeRows: [...runtimeRows.values()].filter((row) => !row.tombstone),
    videoCount: records.length,
    occurrenceCount: records.reduce((sum, record) => sum + record.songs.length, 0),
    contentSha256: sha256(stableJson({ records, runtimeRows: [...runtimeRows.values()].filter((row) => !row.tombstone) })),
  };
}

export async function compareRevisions(client, candidateRevisionId, activeId = undefined) {
  const activeRevision = activeId === undefined ? await activeRevisionId(client) : cleanText(activeId);
  const [candidate, active] = await Promise.all([
    resolveRevision(client, candidateRevisionId),
    activeRevision ? resolveRevision(client, activeRevision) : {
      revisionId: "",
      records: [],
      runtimeRows: [],
      videoCount: 0,
      occurrenceCount: 0,
      contentSha256: sha256(stableJson([])),
    },
  ]);
  const activeById = new Map(active.records.map((record) => [record.videoId, stableJson(record)]));
  const changedVideoIds = candidate.records
    .filter((record) => activeById.get(record.videoId) !== stableJson(record))
    .map((record) => record.videoId);
  const candidateIds = new Set(candidate.records.map((record) => record.videoId));
  for (const record of active.records) if (!candidateIds.has(record.videoId)) changedVideoIds.push(record.videoId);
  return {
    activeRevisionId: activeRevision,
    candidateRevisionId,
    active,
    candidate,
    changedVideoIds: [...new Set(changedVideoIds)].sort(),
  };
}

export async function prepareCandidate(client, records, manifest = {}, options = {}) {
  await client.query("BEGIN");
  try {
    const revision = await createRevision(client, manifest, options.revisionId);
    let upserted = 0;
    for await (const record of records) {
      if (record?.kind === "runtime" || record?.entityType || record?.entity_type) {
        await upsertRuntime(client, revision.revisionId, record);
      } else {
        await upsertVideo(client, revision.revisionId, record);
      }
      upserted += 1;
    }
    const comparison = await compareRevisions(client, revision.revisionId, revision.parentRevisionId);
    await client.query(
      `UPDATE migration_revisions
       SET status = 'ready', content_sha256 = $2, video_count = $3, occurrence_count = $4
       WHERE revision_id = $1`,
      [revision.revisionId, comparison.candidate.contentSha256, comparison.candidate.videoCount, comparison.candidate.occurrenceCount],
    );
    await client.query("COMMIT");
    return { ...revision, ...comparison, upsertedRecords: upserted };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function activateCandidate(client, revisionId, expectedSha256 = "") {
  await client.query("BEGIN");
  try {
    const state = resultRows(await client.query(
      "SELECT state_value FROM migration_state WHERE state_key = 'active_revision_id' FOR UPDATE",
    ))[0];
    const currentId = cleanText(state?.state_value);
    const candidate = resultRows(await client.query(
      "SELECT revision_id, status, content_sha256, parent_revision_id FROM migration_revisions WHERE revision_id = $1 FOR UPDATE",
      [revisionId],
    ))[0];
    if (!candidate || candidate.status !== "ready") throw new Error(`candidate is not ready: ${revisionId}`);
    if (expectedSha256 && candidate.content_sha256 !== expectedSha256) {
      throw new Error(`candidate digest mismatch: ${candidate.content_sha256}`);
    }
    if (cleanText(candidate.parent_revision_id) !== currentId) {
      throw new Error(`candidate parent mismatch: candidate=${cleanText(candidate.parent_revision_id) || "<none>"} active=${currentId || "<none>"}`);
    }
    if (currentId) await client.query(
      "UPDATE migration_revisions SET status = 'superseded' WHERE revision_id = $1 AND status = 'active'",
      [currentId],
    );
    await client.query(
      "UPDATE migration_revisions SET status = 'active', activated_at = CURRENT_TIMESTAMP WHERE revision_id = $1",
      [revisionId],
    );
    await client.query(
      "UPDATE migration_state SET state_value = $1 WHERE state_key = 'active_revision_id'",
      [revisionId],
    );
    await client.query("COMMIT");
    return health(client);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function rollbackActive(client) {
  await client.query("BEGIN");
  try {
    const state = resultRows(await client.query(
      "SELECT state_value FROM migration_state WHERE state_key = 'active_revision_id' FOR UPDATE",
    ))[0];
    const currentId = cleanText(state?.state_value);
    if (!currentId) throw new Error("no active revision to rollback");
    const current = resultRows(await client.query(
      "SELECT parent_revision_id FROM migration_revisions WHERE revision_id = $1 FOR UPDATE",
      [currentId],
    ))[0];
    const previousId = cleanText(current?.parent_revision_id);
    if (!previousId) throw new Error("active revision has no rollback parent");
    const previous = resultRows(await client.query(
      "SELECT revision_id FROM migration_revisions WHERE revision_id = $1 FOR UPDATE",
      [previousId],
    ))[0];
    if (!previous) throw new Error(`rollback parent missing: ${previousId}`);
    await client.query("UPDATE migration_revisions SET status = 'rolled_back' WHERE revision_id = $1", [currentId]);
    await client.query("UPDATE migration_revisions SET status = 'active', activated_at = CURRENT_TIMESTAMP WHERE revision_id = $1", [previousId]);
    await client.query("UPDATE migration_state SET state_value = $1 WHERE state_key = 'active_revision_id'", [previousId]);
    await client.query("COMMIT");
    return health(client);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function health(client) {
  const revisionId = await activeRevisionId(client);
  if (!revisionId) return { status: "ok", activeRevisionId: null, videoCount: 0, occurrenceCount: 0, contentSha256: sha256(stableJson([])) };
  const resolved = await resolveRevision(client, revisionId);
  return {
    status: "ok",
    activeRevisionId: revisionId,
    videoCount: resolved.videoCount,
    occurrenceCount: resolved.occurrenceCount,
    contentSha256: resolved.contentSha256,
  };
}

export function resolveDsnFromEnv(env = process.env) {
  for (const key of ["DAILY_SONG_POSTGRES_DSN", "DATABASE_URL", "PG_DSN"]) {
    if (cleanText(env[key])) return { key, present: true };
  }
  return { key: null, present: false };
}

export async function openNodePostgres(connectionString, moduleName = process.env.DAILY_SONG_PG_MODULE || "pg") {
  const { Pool } = await import(moduleName);
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  return {
    query: (text, values) => client.query(text, values),
    close: async () => { client.release(); await pool.end(); },
  };
}
