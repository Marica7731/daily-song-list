-- Incremental release storage for daily-song-list.
-- The tables are append-only by revision. A revision stores only changed videos;
-- reads resolve unchanged rows through parent_revision_id. The active pointer is
-- switched only after the candidate is ready and its digest is verified.

CREATE TABLE IF NOT EXISTS migration_revisions (
  revision_id TEXT PRIMARY KEY,
  parent_revision_id TEXT REFERENCES migration_revisions(revision_id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'active', 'superseded', 'rolled_back')),
  source_manifest_sha256 TEXT NOT NULL,
  manifest_json JSONB NOT NULL,
  content_sha256 TEXT,
  video_count INTEGER NOT NULL DEFAULT 0,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS migration_video_rows (
  revision_id TEXT NOT NULL REFERENCES migration_revisions(revision_id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  title TEXT,
  channel_name TEXT,
  channel_id TEXT,
  channel_handle TEXT,
  channel_url TEXT,
  published_at TEXT,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  payload_json JSONB NOT NULL,
  PRIMARY KEY (revision_id, video_id)
);

CREATE TABLE IF NOT EXISTS migration_occurrence_rows (
  revision_id TEXT NOT NULL REFERENCES migration_revisions(revision_id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  occurrence_id TEXT,
  position INTEGER NOT NULL,
  range_id TEXT,
  song_key TEXT,
  seconds INTEGER CHECK (seconds IS NULL OR seconds >= 0),
  title TEXT,
  artist TEXT,
  source_id TEXT,
  raw_hash TEXT,
  source_system TEXT,
  payload_json JSONB NOT NULL,
  PRIMARY KEY (revision_id, video_id, occurrence_key)
);

CREATE TABLE IF NOT EXISTS migration_audit_rows (
  revision_id TEXT NOT NULL REFERENCES migration_revisions(revision_id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (revision_id, video_id)
);

-- Rows from the existing SQLite runtime projection that are not naturally
-- owned by a single video occurrence.  entity_key is the source-table
-- identity (for example song_key, channel_key, or a composite source key),
-- while payload_json preserves every existing field without changing the
-- public API contract.  A tombstone prevents an older parent row from being
-- inherited after an incremental delete.
CREATE TABLE IF NOT EXISTS migration_runtime_rows (
  revision_id TEXT NOT NULL REFERENCES migration_revisions(revision_id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  source_system TEXT,
  range_id TEXT,
  source_id TEXT,
  occurrence_id TEXT,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  payload_json JSONB NOT NULL,
  PRIMARY KEY (revision_id, entity_type, entity_key)
);

CREATE TABLE IF NOT EXISTS migration_state (
  state_key TEXT PRIMARY KEY,
  state_value TEXT NOT NULL
);

INSERT INTO migration_state (state_key, state_value)
VALUES ('active_revision_id', '')
ON CONFLICT (state_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS migration_video_lookup
  ON migration_video_rows (revision_id, video_id);

CREATE INDEX IF NOT EXISTS migration_occurrence_lookup
  ON migration_occurrence_rows (revision_id, video_id, position, occurrence_key);

CREATE INDEX IF NOT EXISTS migration_occurrence_source_lookup
  ON migration_occurrence_rows (revision_id, range_id, source_system, source_id, occurrence_id);

CREATE INDEX IF NOT EXISTS migration_runtime_lookup
  ON migration_runtime_rows (revision_id, entity_type, entity_key);

-- Full runtime projection.  These tables preserve the existing SQLite API's
-- materialized fields without copying SQLite/FTS files to VPS.  Every row is
-- revision-scoped so a candidate can be loaded, compared, and activated as a
-- single immutable snapshot; later 7d/user upserts use the same revision.
CREATE TABLE IF NOT EXISTS runtime_meta (
  revision_id TEXT NOT NULL REFERENCES migration_revisions(revision_id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (revision_id, key)
);

CREATE TABLE IF NOT EXISTS runtime_videos (
  revision_id TEXT NOT NULL REFERENCES migration_revisions(revision_id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  channel_name TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL DEFAULT '',
  channel_handle TEXT NOT NULL DEFAULT '',
  channel_url TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL DEFAULT '',
  published_timestamp BIGINT,
  published_text TEXT NOT NULL DEFAULT '',
  duration_text TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  PRIMARY KEY (revision_id, video_id)
);

CREATE TABLE IF NOT EXISTS runtime_occurrences (
  revision_id TEXT NOT NULL REFERENCES migration_revisions(revision_id) ON DELETE CASCADE,
  occurrence_id TEXT NOT NULL,
  range_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  song_key TEXT NOT NULL,
  seconds INTEGER,
  source_system TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  is_niche BOOLEAN NOT NULL DEFAULT FALSE,
  is_unknown_artist BOOLEAN NOT NULL DEFAULT FALSE,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (revision_id, occurrence_id)
);

CREATE TABLE IF NOT EXISTS runtime_songs (
  revision_id TEXT NOT NULL REFERENCES migration_revisions(revision_id) ON DELETE CASCADE,
  song_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  is_niche BOOLEAN NOT NULL DEFAULT FALSE,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (revision_id, song_key)
);

CREATE TABLE IF NOT EXISTS runtime_ranking_rows (
  revision_id TEXT NOT NULL REFERENCES migration_revisions(revision_id) ON DELETE CASCADE,
  row_id TEXT NOT NULL,
  range_id TEXT NOT NULL,
  view TEXT NOT NULL,
  metric TEXT NOT NULL DEFAULT 'count',
  scope_key TEXT NOT NULL DEFAULT 'all',
  rank INTEGER NOT NULL,
  detail_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  row_count INTEGER NOT NULL DEFAULT 0,
  song_count INTEGER NOT NULL DEFAULT 0,
  video_count INTEGER NOT NULL DEFAULT 0,
  timestamp_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  channel_search_text TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (revision_id, row_id)
);

CREATE TABLE IF NOT EXISTS runtime_source_details (
  revision_id TEXT NOT NULL REFERENCES migration_revisions(revision_id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  range_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (revision_id, source_key)
);

CREATE TABLE IF NOT EXISTS runtime_source_occurrences (
  revision_id TEXT NOT NULL REFERENCES migration_revisions(revision_id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  range_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  video_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  channel_name TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL DEFAULT '',
  channel_handle TEXT NOT NULL DEFAULT '',
  channel_url TEXT NOT NULL DEFAULT '',
  published_timestamp BIGINT,
  seconds INTEGER,
  is_niche BOOLEAN NOT NULL DEFAULT FALSE,
  is_unknown_artist BOOLEAN NOT NULL DEFAULT FALSE,
  search_text TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  PRIMARY KEY (revision_id, source_key, range_id, position)
);

CREATE TABLE IF NOT EXISTS runtime_channel_metadata (
  revision_id TEXT NOT NULL REFERENCES migration_revisions(revision_id) ON DELETE CASCADE,
  channel_key TEXT NOT NULL,
  channel_id TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  channel_url TEXT NOT NULL DEFAULT '',
  known_source_type TEXT NOT NULL DEFAULT '',
  is_collected BOOLEAN NOT NULL DEFAULT FALSE,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (revision_id, channel_key)
);

CREATE TABLE IF NOT EXISTS runtime_external_songs (
  revision_id TEXT NOT NULL REFERENCES migration_revisions(revision_id) ON DELETE CASCADE,
  source_system TEXT NOT NULL,
  external_song_id TEXT NOT NULL,
  canonical_song_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  PRIMARY KEY (revision_id, source_system, external_song_id)
);

CREATE TABLE IF NOT EXISTS runtime_external_videos (
  revision_id TEXT NOT NULL REFERENCES migration_revisions(revision_id) ON DELETE CASCADE,
  source_system TEXT NOT NULL,
  external_video_id TEXT NOT NULL,
  youtube_video_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  singer_name TEXT NOT NULL DEFAULT '',
  streamed_at TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  PRIMARY KEY (revision_id, source_system, external_video_id)
);

CREATE TABLE IF NOT EXISTS runtime_external_occurrences (
  revision_id TEXT NOT NULL REFERENCES migration_revisions(revision_id) ON DELETE CASCADE,
  source_system TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  canonical_song_id TEXT NOT NULL DEFAULT '',
  external_song_id TEXT NOT NULL DEFAULT '',
  external_video_id TEXT NOT NULL DEFAULT '',
  youtube_video_id TEXT NOT NULL DEFAULT '',
  seconds INTEGER,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (revision_id, source_system, occurrence_id)
);

CREATE INDEX IF NOT EXISTS runtime_ranking_lookup
  ON runtime_ranking_rows (revision_id, range_id, view, metric, rank);
CREATE INDEX IF NOT EXISTS runtime_ranking_search
  ON runtime_ranking_rows (revision_id, search_text);
CREATE INDEX IF NOT EXISTS runtime_occurrence_lookup
  ON runtime_occurrences (revision_id, range_id, video_id, song_key);
CREATE INDEX IF NOT EXISTS runtime_source_occurrence_lookup
  ON runtime_source_occurrences (revision_id, source_key, range_id, position);