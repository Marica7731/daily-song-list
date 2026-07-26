-- PostgreSQL online source of truth for daily-song-list.
-- Raw JSON/HTML and large audit artifacts stay in object storage; payload_json
-- contains only the small row-level provenance needed by the API and rollback.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  handle TEXT UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  channel_url TEXT NOT NULL DEFAULT '',
  is_collected BOOLEAN NOT NULL DEFAULT FALSE,
  resolution_status TEXT NOT NULL DEFAULT 'pending',
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_channels_handle ON channels (lower(handle));
CREATE INDEX IF NOT EXISTS idx_channels_display_name ON channels (lower(display_name));

CREATE TABLE IF NOT EXISTS videos (
  video_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  channel_id TEXT REFERENCES channels(channel_id) ON UPDATE CASCADE,
  channel_name TEXT NOT NULL DEFAULT '',
  channel_handle TEXT NOT NULL DEFAULT '',
  channel_url TEXT NOT NULL DEFAULT '',
  published_at TIMESTAMPTZ,
  published_text TEXT NOT NULL DEFAULT '',
  duration_text TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  resolution_status TEXT NOT NULL DEFAULT 'pending',
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel_id);
CREATE INDEX IF NOT EXISTS idx_videos_published ON videos(published_at DESC);

CREATE TABLE IF NOT EXISTS songs (
  song_key TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  is_niche BOOLEAN NOT NULL DEFAULT FALSE,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_songs_title_artist ON songs (lower(title), lower(artist), song_key);

CREATE TABLE IF NOT EXISTS occurrences (
  occurrence_id TEXT PRIMARY KEY,
  range_id TEXT NOT NULL,
  video_id TEXT NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
  song_key TEXT NOT NULL REFERENCES songs(song_key),
  seconds INTEGER,
  source_system TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  is_niche BOOLEAN NOT NULL DEFAULT FALSE,
  is_unknown_artist BOOLEAN NOT NULL DEFAULT FALSE,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (range_id, video_id, seconds, source_system, source_id)
);
CREATE INDEX IF NOT EXISTS idx_occurrences_range_song ON occurrences (range_id, song_key);
CREATE INDEX IF NOT EXISTS idx_occurrences_range_video ON occurrences (range_id, video_id);
CREATE INDEX IF NOT EXISTS idx_occurrences_title_artist ON occurrences (lower(title), lower(artist));

CREATE TABLE IF NOT EXISTS song_aggregates (
  range_id TEXT NOT NULL,
  song_key TEXT NOT NULL REFERENCES songs(song_key) ON DELETE CASCADE,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  video_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (range_id, song_key)
);
CREATE INDEX IF NOT EXISTS idx_song_aggregates_rank ON song_aggregates (range_id, occurrence_count DESC, video_count DESC);

CREATE TABLE IF NOT EXISTS channel_aggregates (
  range_id TEXT NOT NULL,
  channel_id TEXT,
  channel_key TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  song_count INTEGER NOT NULL DEFAULT 0,
  video_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (range_id, channel_key)
);
CREATE INDEX IF NOT EXISTS idx_channel_aggregates_rank ON channel_aggregates (range_id, occurrence_count DESC, video_count DESC);

CREATE TABLE IF NOT EXISTS source_evidence (
  evidence_id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  captured_at TIMESTAMPTZ,
  object_uri TEXT NOT NULL DEFAULT '',
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_system, source_uri, sha256)
);

-- Compatibility projections used by the existing ranking API while the API
-- is moved from SQLite SQL to native PostgreSQL queries.
CREATE TABLE IF NOT EXISTS source_details (
  source_key TEXT PRIMARY KEY,
  range_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_source_details_entity ON source_details (range_id, entity_type, entity_key);
CREATE INDEX IF NOT EXISTS idx_source_details_match ON source_details (range_id, entity_type, source_key, entity_key);

CREATE TABLE IF NOT EXISTS source_occurrences (
  source_key TEXT NOT NULL REFERENCES source_details(source_key) ON DELETE CASCADE,
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
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (source_key, position)
);
CREATE INDEX IF NOT EXISTS idx_source_occurrences_range ON source_occurrences (range_id, source_key);
CREATE INDEX IF NOT EXISTS idx_source_occurrences_filter ON source_occurrences (source_key, is_niche, is_unknown_artist, position);

CREATE OR REPLACE VIEW channel_metadata AS
SELECT
  channel_id AS channel_key,
  channel_id,
  handle,
  display_name,
  avatar_url,
  ''::TEXT AS thumbnail_url,
  channel_url AS source_url,
  channel_url,
  ''::TEXT AS known_source_type,
  is_collected,
  payload_json
FROM channels;

CREATE TABLE IF NOT EXISTS curation_operations (
  operation_id UUID PRIMARY KEY,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  input_json JSONB NOT NULL,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_curation_operations_created ON curation_operations (created_at DESC);

CREATE TABLE IF NOT EXISTS ranking_rows (
  row_id TEXT PRIMARY KEY,
  range_id TEXT NOT NULL,
  view TEXT NOT NULL,
  metric TEXT NOT NULL DEFAULT 'count',
  scope_key TEXT NOT NULL DEFAULT 'all',
  rank INTEGER NOT NULL,
  detail_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  song_count INTEGER NOT NULL DEFAULT 0,
  video_count INTEGER NOT NULL DEFAULT 0,
  timestamp_count INTEGER NOT NULL DEFAULT 0,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  search_text TEXT NOT NULL DEFAULT '',
  channel_search_text TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (range_id, view, metric, scope_key, detail_key)
);
CREATE INDEX IF NOT EXISTS idx_ranking_lookup ON ranking_rows (range_id, view, metric, scope_key, rank);
CREATE INDEX IF NOT EXISTS idx_ranking_search ON ranking_rows USING GIN (to_tsvector('simple', search_text));
CREATE INDEX IF NOT EXISTS idx_ranking_channel_search ON ranking_rows USING GIN (to_tsvector('simple', channel_search_text));

CREATE TABLE IF NOT EXISTS external_songs (
  source_system TEXT NOT NULL,
  external_song_id TEXT NOT NULL,
  canonical_song_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (source_system, external_song_id)
);

CREATE TABLE IF NOT EXISTS external_videos (
  source_system TEXT NOT NULL,
  external_video_id TEXT NOT NULL,
  youtube_video_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  singer_name TEXT NOT NULL DEFAULT '',
  streamed_at TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (source_system, external_video_id)
);

CREATE TABLE IF NOT EXISTS external_occurrences (
  source_system TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  canonical_song_id TEXT NOT NULL DEFAULT '',
  external_song_id TEXT NOT NULL DEFAULT '',
  external_video_id TEXT NOT NULL DEFAULT '',
  youtube_video_id TEXT NOT NULL DEFAULT '',
  seconds INTEGER,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (source_system, occurrence_id)
);

INSERT INTO schema_migrations(version) VALUES ('20260727-postgres-v1')
ON CONFLICT (version) DO NOTHING;
INSERT INTO meta(key, value) VALUES ('schema_version', '3')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

COMMIT;
