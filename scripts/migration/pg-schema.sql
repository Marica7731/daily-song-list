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
