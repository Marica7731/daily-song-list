#!/usr/bin/env python3
"""Stream the materialized SQLite runtime tables without copying the DB.

The output is a framed NDJSON protocol consumed by import-runtime-tables.py.
Rows are emitted one at a time in table order; FTS shadow tables are omitted
because PostgreSQL builds only the bounded indexes required by the API.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys


TABLES: dict[str, tuple[str, ...]] = {
    "meta": ("key", "value"),
    "videos": ("video_id", "title", "channel_name", "channel_id", "channel_handle", "channel_url", "keyword", "published_timestamp", "published_text", "duration_text", "thumbnail_url", "payload_json"),
    "occurrences": ("occurrence_id", "range_id", "video_id", "song_key", "seconds", "source_system", "source_id", "title", "artist", "is_niche", "is_unknown_artist", "payload_json"),
    "songs": ("song_key", "title", "artist", "is_niche", "payload_json"),
    "ranking_rows": ("row_id", "range_id", "view", "metric", "scope_key", "rank", "detail_key", "title", "artist", "name", "count", "song_count", "video_count", "timestamp_count", "payload_json", "search_text", "channel_search_text"),
    "source_details": ("source_key", "range_id", "entity_type", "entity_key", "payload_json"),
    "source_occurrences": ("source_key", "range_id", "position", "video_id", "title", "channel_name", "channel_id", "channel_handle", "channel_url", "published_timestamp", "seconds", "is_niche", "is_unknown_artist", "search_text", "payload_json"),
    "channel_metadata": ("channel_key", "channel_id", "handle", "display_name", "avatar_url", "thumbnail_url", "source_url", "channel_url", "known_source_type", "is_collected", "payload_json"),
    "external_songs": ("source_system", "external_song_id", "canonical_song_id", "title", "artist", "source_url", "payload_json"),
    "external_videos": ("source_system", "external_video_id", "youtube_video_id", "title", "singer_name", "streamed_at", "source_url", "payload_json"),
    "external_occurrences": ("source_system", "occurrence_id", "canonical_song_id", "external_song_id", "external_video_id", "youtube_video_id", "seconds", "payload_json"),
}


def json_line(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def stream(source: Path, selected: tuple[str, ...] = tuple(TABLES), limit: int = 0, progress_every: int = 1000) -> tuple[dict[str, int], str]:
    connection = sqlite3.connect(f"file:{source.resolve()}?mode=ro", uri=True)
    counts: dict[str, int] = {}
    digest = hashlib.sha256()
    try:
        existing = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        missing = sorted(set(TABLES) - existing)
        if missing:
            raise RuntimeError("SQLite source missing tables: " + ",".join(missing))
        for table in selected:
            columns = TABLES[table]
            sys.stdout.buffer.write(json_line({"type": "table", "name": table, "columns": list(columns)}))
            query = f"SELECT {', '.join(columns)} FROM {table}"
            count = 0
            for row in connection.execute(query):
                if limit and count >= limit:
                    break
                encoded = json_line(list(row))
                sys.stdout.buffer.write(encoded)
                digest.update(encoded)
                count += 1
                if count % 100 == 0:
                    sys.stdout.buffer.flush()
                if progress_every and count % progress_every == 0:
                    print(f"RUNTIME_EXPORT_PROGRESS table={table} rows={count}", file=sys.stderr, flush=True)
            sys.stdout.buffer.write(json_line({"type": "end", "name": table, "count": count}))
            counts[table] = count
            sys.stdout.buffer.flush()
        sys.stdout.buffer.write(json_line({"type": "stream_end", "counts": counts, "sha256": digest.hexdigest()}))
        sys.stdout.buffer.flush()
        return counts, digest.hexdigest()
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--tables", default=",".join(TABLES))
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--progress-every", type=int, default=1000)
    args = parser.parse_args()
    if not args.db.is_file():
        print(f"RUNTIME_EXPORT_ERROR missing-db={args.db}", file=sys.stderr)
        return 2
    try:
        selected = tuple(name for name in args.tables.split(",") if name)
        if not selected or any(name not in TABLES for name in selected):
            raise ValueError("--tables contains an unknown table")
        counts, digest = stream(args.db, selected, args.limit, args.progress_every)
        print(f"RUNTIME_EXPORT_OK sha256={digest} counts={json.dumps(counts, sort_keys=True)}", file=sys.stderr)
        return 0
    except Exception as exc:
        print(f"RUNTIME_EXPORT_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
