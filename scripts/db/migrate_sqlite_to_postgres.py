#!/usr/bin/env python3
"""Stream a verified SQLite serving snapshot into PostgreSQL with COPY.

The importer never reads the complete database into Python memory.  It uses
temporary text staging tables, COPY, and transactional INSERT ... SELECT
upserts.  A failed transaction leaves the target database unchanged.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import time


ROOT = Path(__file__).resolve().parents[2]


IMPORTS = [
    {
        "name": "meta",
        "source": "meta",
        "columns": ["key", "value"],
        "select": "SELECT key, value FROM meta",
        "insert": """
            INSERT INTO meta(key, value)
            SELECT key, value FROM {stage}
            ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value
        """,
        "count": "SELECT COUNT(*) FROM meta",
    },
    {
        "name": "channels",
        "source": "channel_metadata",
        "columns": ["channel_key", "channel_id", "handle", "display_name", "avatar_url", "channel_url", "is_collected", "payload_json"],
        "select": "SELECT channel_key, channel_id, handle, display_name, avatar_url, channel_url, is_collected, payload_json FROM channel_metadata",
        "insert": """
            INSERT INTO channels(channel_id, handle, display_name, avatar_url, channel_url, is_collected, resolution_status, payload_json)
            SELECT
              COALESCE(NULLIF(channel_id, ''), 'pending:' || substr(md5(channel_key), 1, 24)),
              NULLIF(handle, ''), display_name, avatar_url, channel_url,
              CASE WHEN is_collected IN ('1', 'true', 't') THEN TRUE ELSE FALSE END,
              CASE WHEN NULLIF(channel_id, '') IS NOT NULL AND NULLIF(handle, '') IS NOT NULL THEN 'verified' ELSE 'pending' END,
              COALESCE(NULLIF(payload_json, '')::jsonb, '{{}}'::jsonb)
            FROM {stage}
            ON CONFLICT(channel_id) DO UPDATE SET
              handle=COALESCE(EXCLUDED.handle, channels.handle),
              display_name=COALESCE(NULLIF(EXCLUDED.display_name, ''), channels.display_name),
              avatar_url=COALESCE(NULLIF(EXCLUDED.avatar_url, ''), channels.avatar_url),
              channel_url=COALESCE(NULLIF(EXCLUDED.channel_url, ''), channels.channel_url),
              is_collected=channels.is_collected OR EXCLUDED.is_collected,
              resolution_status=CASE WHEN EXCLUDED.resolution_status='verified' THEN 'verified' ELSE channels.resolution_status END,
              payload_json=channels.payload_json || EXCLUDED.payload_json,
              updated_at=now()
        """,
        "count": "SELECT COUNT(*) FROM channel_metadata",
    },
    {
        "name": "videos",
        "source": "videos",
        "columns": ["video_id", "title", "channel_name", "channel_id", "channel_handle", "channel_url", "published_timestamp", "published_text", "duration_text", "thumbnail_url", "payload_json"],
        "select": "SELECT video_id, title, channel_name, channel_id, channel_handle, channel_url, published_timestamp, published_text, duration_text, thumbnail_url, payload_json FROM videos",
        "insert": """
            INSERT INTO videos(video_id, title, channel_id, channel_name, channel_handle, channel_url, published_at, published_text, duration_text, thumbnail_url, source_url, resolution_status, payload_json)
            SELECT
              video_id, title,
              NULLIF(channel_id, ''), channel_name, channel_handle, channel_url,
              CASE WHEN NULLIF(published_timestamp, '') IS NULL THEN NULL ELSE to_timestamp(published_timestamp::double precision / 1000.0) END,
              published_text, duration_text, thumbnail_url,
              'https://www.youtube.com/watch?v=' || video_id,
              CASE WHEN NULLIF(channel_id, '') IS NOT NULL AND NULLIF(channel_handle, '') IS NOT NULL THEN 'verified' ELSE 'pending' END,
              COALESCE(NULLIF(payload_json, '')::jsonb, '{{}}'::jsonb)
            FROM {stage}
            ON CONFLICT(video_id) DO UPDATE SET
              title=EXCLUDED.title, channel_id=COALESCE(EXCLUDED.channel_id, videos.channel_id),
              channel_name=EXCLUDED.channel_name, channel_handle=EXCLUDED.channel_handle,
              channel_url=EXCLUDED.channel_url, published_at=EXCLUDED.published_at,
              published_text=EXCLUDED.published_text, duration_text=EXCLUDED.duration_text,
              thumbnail_url=EXCLUDED.thumbnail_url,
              resolution_status=CASE WHEN EXCLUDED.resolution_status='verified' THEN 'verified' ELSE videos.resolution_status END,
              payload_json=videos.payload_json || EXCLUDED.payload_json, updated_at=now()
        """,
        "count": "SELECT COUNT(*) FROM videos",
    },
    {
        "name": "songs",
        "source": "songs",
        "columns": ["song_key", "title", "artist", "is_niche", "payload_json"],
        "select": "SELECT song_key, title, artist, is_niche, payload_json FROM songs",
        "insert": """
            INSERT INTO songs(song_key, title, artist, is_niche, payload_json)
            SELECT song_key, title, artist,
              CASE WHEN is_niche IN ('1', 'true', 't') THEN TRUE ELSE FALSE END,
              COALESCE(NULLIF(payload_json, '')::jsonb, '{{}}'::jsonb)
            FROM {stage}
            ON CONFLICT(song_key) DO UPDATE SET
              title=EXCLUDED.title, artist=EXCLUDED.artist, is_niche=EXCLUDED.is_niche,
              payload_json=songs.payload_json || EXCLUDED.payload_json, updated_at=now()
        """,
        "count": "SELECT COUNT(*) FROM songs",
    },
    {
        "name": "occurrences",
        "source": "occurrences",
        "columns": ["occurrence_id", "range_id", "video_id", "song_key", "seconds", "source_system", "source_id", "title", "artist", "is_niche", "is_unknown_artist", "payload_json"],
        "select": "SELECT occurrence_id, range_id, video_id, song_key, seconds, source_system, source_id, title, artist, is_niche, is_unknown_artist, payload_json FROM occurrences",
        "insert": """
            INSERT INTO occurrences(occurrence_id, range_id, video_id, song_key, seconds, source_system, source_id, title, artist, is_niche, is_unknown_artist, payload_json)
            SELECT occurrence_id, range_id, video_id, song_key,
              NULLIF(seconds, '')::integer, source_system, source_id, title, artist,
              CASE WHEN is_niche IN ('1', 'true', 't') THEN TRUE ELSE FALSE END,
              CASE WHEN is_unknown_artist IN ('1', 'true', 't') THEN TRUE ELSE FALSE END,
              COALESCE(NULLIF(payload_json, '')::jsonb, '{{}}'::jsonb)
            FROM {stage}
            ON CONFLICT(occurrence_id) DO UPDATE SET
              range_id=EXCLUDED.range_id, video_id=EXCLUDED.video_id, song_key=EXCLUDED.song_key,
              seconds=EXCLUDED.seconds, source_system=EXCLUDED.source_system, source_id=EXCLUDED.source_id,
              title=EXCLUDED.title, artist=EXCLUDED.artist, is_niche=EXCLUDED.is_niche,
              is_unknown_artist=EXCLUDED.is_unknown_artist, payload_json=occurrences.payload_json || EXCLUDED.payload_json,
              updated_at=now()
        """,
        "count": "SELECT COUNT(*) FROM occurrences",
    },
    {
        "name": "source_details",
        "source": "source_details",
        "columns": ["source_key", "range_id", "entity_type", "entity_key", "payload_json"],
        "select": "SELECT source_key, range_id, entity_type, entity_key, payload_json FROM source_details",
        "insert": """
            INSERT INTO source_details(source_key, range_id, entity_type, entity_key, payload_json)
            SELECT source_key, range_id, entity_type, entity_key, COALESCE(NULLIF(payload_json, '')::jsonb, '{{}}'::jsonb)
            FROM {stage}
            ON CONFLICT(source_key) DO UPDATE SET
              range_id=EXCLUDED.range_id, entity_type=EXCLUDED.entity_type, entity_key=EXCLUDED.entity_key,
              payload_json=source_details.payload_json || EXCLUDED.payload_json
        """,
        "count": "SELECT COUNT(*) FROM source_details",
    },
    {
        "name": "source_occurrences",
        "source": "source_occurrences",
        "columns": ["source_key", "range_id", "position", "video_id", "title", "channel_name", "channel_id", "channel_handle", "channel_url", "published_timestamp", "seconds", "is_niche", "is_unknown_artist", "search_text", "payload_json"],
        "select": "SELECT source_key, range_id, position, video_id, title, channel_name, channel_id, channel_handle, channel_url, published_timestamp, seconds, is_niche, is_unknown_artist, search_text, payload_json FROM source_occurrences",
        "insert": """
            INSERT INTO source_occurrences(source_key, range_id, position, video_id, title, channel_name, channel_id, channel_handle, channel_url, published_timestamp, seconds, is_niche, is_unknown_artist, search_text, payload_json)
            SELECT source_key, range_id, position::integer, video_id, title, channel_name, channel_id, channel_handle, channel_url,
              NULLIF(published_timestamp, '')::bigint, NULLIF(seconds, '')::integer,
              CASE WHEN is_niche IN ('1', 'true', 't') THEN TRUE ELSE FALSE END,
              CASE WHEN is_unknown_artist IN ('1', 'true', 't') THEN TRUE ELSE FALSE END,
              search_text, COALESCE(NULLIF(payload_json, '')::jsonb, '{{}}'::jsonb)
            FROM {stage}
            ON CONFLICT(source_key, position) DO UPDATE SET
              range_id=EXCLUDED.range_id, video_id=EXCLUDED.video_id, title=EXCLUDED.title,
              channel_name=EXCLUDED.channel_name, channel_id=EXCLUDED.channel_id, channel_handle=EXCLUDED.channel_handle,
              channel_url=EXCLUDED.channel_url, published_timestamp=EXCLUDED.published_timestamp,
              seconds=EXCLUDED.seconds, is_niche=EXCLUDED.is_niche, is_unknown_artist=EXCLUDED.is_unknown_artist,
              search_text=EXCLUDED.search_text, payload_json=source_occurrences.payload_json || EXCLUDED.payload_json
        """,
        "count": "SELECT COUNT(*) FROM source_occurrences",
    },
    {
        "name": "ranking_rows",
        "source": "ranking_rows",
        "columns": ["row_id", "range_id", "view", "metric", "scope_key", "rank", "detail_key", "title", "artist", "name", "count", "song_count", "video_count", "timestamp_count", "payload_json", "search_text", "channel_search_text"],
        "select": "SELECT row_id, range_id, view, metric, scope_key, rank, detail_key, title, artist, name, count, song_count, video_count, timestamp_count, payload_json, search_text, channel_search_text FROM ranking_rows",
        "insert": """
            INSERT INTO ranking_rows(row_id, range_id, view, metric, scope_key, rank, detail_key, title, artist, name, count, song_count, video_count, timestamp_count, payload_json, search_text, channel_search_text)
            SELECT row_id, range_id, view, metric, scope_key, rank::integer, detail_key, title, artist, name,
              count::integer, song_count::integer, video_count::integer, timestamp_count::integer,
              COALESCE(NULLIF(payload_json, '')::jsonb, '{{}}'::jsonb), search_text, channel_search_text
            FROM {stage}
            ON CONFLICT(row_id) DO UPDATE SET
              range_id=EXCLUDED.range_id, view=EXCLUDED.view, metric=EXCLUDED.metric, scope_key=EXCLUDED.scope_key,
              rank=EXCLUDED.rank, detail_key=EXCLUDED.detail_key, title=EXCLUDED.title, artist=EXCLUDED.artist,
              name=EXCLUDED.name, count=EXCLUDED.count, song_count=EXCLUDED.song_count, video_count=EXCLUDED.video_count,
              timestamp_count=EXCLUDED.timestamp_count, payload_json=EXCLUDED.payload_json,
              search_text=EXCLUDED.search_text, channel_search_text=EXCLUDED.channel_search_text, updated_at=now()
        """,
        "count": "SELECT COUNT(*) FROM ranking_rows",
    },
    {
        "name": "external_songs",
        "source": "external_songs",
        "columns": ["source_system", "external_song_id", "canonical_song_id", "title", "artist", "source_url", "payload_json"],
        "select": "SELECT source_system, external_song_id, canonical_song_id, title, artist, source_url, payload_json FROM external_songs",
        "insert": """
            INSERT INTO external_songs(source_system, external_song_id, canonical_song_id, title, artist, source_url, payload_json)
            SELECT source_system, external_song_id, canonical_song_id, title, artist, source_url, COALESCE(NULLIF(payload_json, '')::jsonb, '{{}}'::jsonb)
            FROM {stage}
            ON CONFLICT(source_system, external_song_id) DO UPDATE SET
              canonical_song_id=EXCLUDED.canonical_song_id, title=EXCLUDED.title, artist=EXCLUDED.artist,
              source_url=EXCLUDED.source_url, payload_json=external_songs.payload_json || EXCLUDED.payload_json
        """,
        "count": "SELECT COUNT(*) FROM external_songs",
    },
    {
        "name": "external_videos",
        "source": "external_videos",
        "columns": ["source_system", "external_video_id", "youtube_video_id", "title", "singer_name", "streamed_at", "source_url", "payload_json"],
        "select": "SELECT source_system, external_video_id, youtube_video_id, title, singer_name, streamed_at, source_url, payload_json FROM external_videos",
        "insert": """
            INSERT INTO external_videos(source_system, external_video_id, youtube_video_id, title, singer_name, streamed_at, source_url, payload_json)
            SELECT source_system, external_video_id, youtube_video_id, title, singer_name, streamed_at, source_url, COALESCE(NULLIF(payload_json, '')::jsonb, '{{}}'::jsonb)
            FROM {stage}
            ON CONFLICT(source_system, external_video_id) DO UPDATE SET
              youtube_video_id=EXCLUDED.youtube_video_id, title=EXCLUDED.title, singer_name=EXCLUDED.singer_name,
              streamed_at=EXCLUDED.streamed_at, source_url=EXCLUDED.source_url, payload_json=external_videos.payload_json || EXCLUDED.payload_json
        """,
        "count": "SELECT COUNT(*) FROM external_videos",
    },
    {
        "name": "external_occurrences",
        "source": "external_occurrences",
        "columns": ["source_system", "occurrence_id", "canonical_song_id", "external_song_id", "external_video_id", "youtube_video_id", "seconds", "payload_json"],
        "select": "SELECT source_system, occurrence_id, canonical_song_id, external_song_id, external_video_id, youtube_video_id, seconds, payload_json FROM external_occurrences",
        "insert": """
            INSERT INTO external_occurrences(source_system, occurrence_id, canonical_song_id, external_song_id, external_video_id, youtube_video_id, seconds, payload_json)
            SELECT source_system, occurrence_id, canonical_song_id, external_song_id, external_video_id, youtube_video_id, NULLIF(seconds, '')::integer, COALESCE(NULLIF(payload_json, '')::jsonb, '{{}}'::jsonb)
            FROM {stage}
            ON CONFLICT(source_system, occurrence_id) DO UPDATE SET
              canonical_song_id=EXCLUDED.canonical_song_id, external_song_id=EXCLUDED.external_song_id,
              external_video_id=EXCLUDED.external_video_id, youtube_video_id=EXCLUDED.youtube_video_id,
              seconds=EXCLUDED.seconds, payload_json=external_occurrences.payload_json || EXCLUDED.payload_json
        """,
        "count": "SELECT COUNT(*) FROM external_occurrences",
    },
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_table(pg_cur, sqlite_conn: sqlite3.Connection, definition: dict, batch_size: int) -> int:
    name = definition["name"]
    columns = definition["columns"]
    stage = f"_stage_{name}"
    pg_cur.execute(f"DROP TABLE IF EXISTS {stage}")
    pg_cur.execute("CREATE TEMP TABLE " + stage + " (" + ", ".join(f'"{column}" TEXT' for column in columns) + ") ON COMMIT DROP")
    source_cur = sqlite_conn.execute(definition["select"])
    count = 0
    with pg_cur.copy(f"COPY {stage} ({', '.join(columns)}) FROM STDIN") as copy:
        for row in source_cur:
            values = ["" if value is None else str(value) for value in row]
            copy.write_row(values)
            count += 1
            if count % batch_size == 0:
                print(f"CODEX_POSTGRES_IMPORT_PROGRESS table={name} rows={count}", flush=True)
    pg_cur.execute(definition["insert"].format(stage=stage))
    return count


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", type=Path, required=True)
    parser.add_argument("--dsn", required=True)
    parser.add_argument("--schema-file", type=Path, default=ROOT / "deploy/postgres/schema.sql")
    parser.add_argument("--manifest-out", type=Path, required=True)
    parser.add_argument("--replace", action="store_true", help="truncate target tables before import")
    parser.add_argument("--batch-size", type=int, default=50000)
    return parser.parse_args()


def main() -> int:
    try:
        import psycopg
    except ImportError:
        print("CODEX_POSTGRES_IMPORT_ERROR psycopg is required", file=sys.stderr)
        return 1
    args = parse_args()
    sqlite_path = args.sqlite.resolve()
    if not sqlite_path.exists():
        print(f"CODEX_POSTGRES_IMPORT_ERROR sqlite not found: {sqlite_path}", file=sys.stderr)
        return 1
    started = time.time()
    try:
        sqlite_conn = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
        sqlite_conn.row_factory = sqlite3.Row
        with psycopg.connect(args.dsn) as pg_conn:
            with pg_conn.cursor() as pg_cur:
                pg_cur.execute(args.schema_file.read_text(encoding="utf-8"))
                if args.replace:
                    pg_cur.execute("TRUNCATE TABLE external_occurrences, external_videos, external_songs, source_occurrences, source_details, occurrences, ranking_rows, videos, songs, channels, meta CASCADE")
                counts = {}
                for definition in IMPORTS:
                    counts[definition["name"]] = copy_table(pg_cur, sqlite_conn, definition, args.batch_size)
                    print(f"CODEX_POSTGRES_IMPORT_TABLE_OK table={definition['name']} rows={counts[definition['name']]}", flush=True)
                pg_cur.execute("SELECT key, value FROM meta WHERE key IN ('source_commit_sha', 'source_latest_sha256', 'built_at') ORDER BY key")
                meta = {row[0]: row[1] for row in pg_cur.fetchall()}
            pg_conn.commit()
        sqlite_conn.close()
        manifest = {
            "status": "complete",
            "sqlite": str(sqlite_path),
            "sqliteBytes": sqlite_path.stat().st_size,
            "sqliteSha256": sha256_file(sqlite_path),
            "counts": counts,
            "meta": meta,
            "elapsedSeconds": round(time.time() - started, 3),
        }
        args.manifest_out.parent.mkdir(parents=True, exist_ok=True)
        args.manifest_out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("CODEX_POSTGRES_IMPORT_OK " + json.dumps(manifest, ensure_ascii=False))
    except Exception as exc:
        print(f"CODEX_POSTGRES_IMPORT_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
