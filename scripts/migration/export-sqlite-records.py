#!/usr/bin/env python3
"""Stream existing SQLite video/occurrence rows as bounded JSON records.

The exporter never copies or loads the SQLite database. It opens the source
read-only, reads one video and its occurrences at a time, and writes NDJSON so
the PostgreSQL adapter can upsert through a single candidate revision.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
import sqlite3
import sys


def json_object(value: str | None) -> dict:
    try:
        parsed = json.loads(value or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def first_present(mapping: dict, *keys: str):
    for key in keys:
        if key in mapping:
            return mapping[key]
    return None


def runtime_payload(row: sqlite3.Row) -> dict:
    """Keep typed SQLite columns and the original JSON payload together."""

    payload = {key: row[key] for key in row.keys()}
    payload["payload"] = json_object(payload.get("payload_json"))
    return payload


def key_part(value) -> str:
    return "" if value is None else str(value)


def runtime_record(entity_type: str, entity_key: str, row: sqlite3.Row):
    payload = runtime_payload(row)
    return {
        "kind": "runtime",
        "entityType": entity_type,
        "entityKey": entity_key,
        "sourceSystem": row["source_system"] if "source_system" in row.keys() else None,
        "rangeId": row["range_id"] if "range_id" in row.keys() else None,
        "sourceId": row["source_id"] if "source_id" in row.keys() else None,
        "occurrenceId": row["occurrence_id"] if "occurrence_id" in row.keys() else None,
        "payload": payload,
    }


def export_runtime_records(connection, tables: set[str], range_id: str):
    """Stream non-video runtime tables without loading any table in memory."""

    specs = (
        ("meta", "meta", lambda row: key_part(row["key"])),
        ("videos", "videos", lambda row: key_part(row["video_id"])),
        ("songs", "songs", lambda row: key_part(row["song_key"])),
        ("occurrences", "occurrences", lambda row: "\x1f".join(key_part(row[key]) for key in ("video_id", "range_id", "occurrence_id"))),
        ("channel_metadata", "channel_metadata", lambda row: key_part(row["channel_key"])),
        ("source_occurrences", "source_occurrences", lambda row: "\x1f".join(key_part(row[key]) for key in ("source_key", "range_id", "position", "video_id"))),
        ("source_details", "source_details", lambda row: "\x1f".join(key_part(row[key]) for key in ("source_key", "range_id", "entity_type", "entity_key"))),
        ("ranking_rows", "ranking_rows", lambda row: key_part(row["row_id"])),
        ("external_songs", "external_songs", lambda row: "\x1f".join(key_part(row[key]) for key in ("source_system", "external_song_id"))),
        ("external_videos", "external_videos", lambda row: "\x1f".join(key_part(row[key]) for key in ("source_system", "external_video_id"))),
        ("external_occurrences", "external_occurrences", lambda row: "\x1f".join(key_part(row[key]) for key in ("source_system", "occurrence_id"))),
    )
    for table, entity_type, key_fn in specs:
        if table not in tables:
            continue
        for row in connection.execute(f"SELECT * FROM {table}"):
            row_range = row["range_id"] if "range_id" in row.keys() else None
            if range_id != "all" and row_range not in (None, "", range_id):
                continue
            yield runtime_record(entity_type, key_fn(row), row)


def export_records(source: Path, range_id: str):
    connection = sqlite3.connect(f"file:{source.resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        required = {"videos", "occurrences"}
        missing = sorted(required - tables)
        if missing:
            raise RuntimeError(f"SQLite source missing tables: {','.join(missing)}")
        reviewed_at = dt.datetime.now(dt.timezone.utc).isoformat()
        videos = connection.execute(
            """
            SELECT video_id, title, channel_name, channel_id, channel_handle,
                   channel_url, published_timestamp, payload_json
            FROM videos
            ORDER BY video_id
            """
        )
        for video in videos:
            occurrences = connection.execute(
                """
                SELECT occurrence_id, range_id, song_key, seconds, source_system,
                       source_id, title, artist, payload_json
                FROM occurrences
                WHERE range_id = ? AND video_id = ?
                ORDER BY occurrence_id
                """,
                (range_id, video["video_id"]),
            ).fetchall()
            if not occurrences:
                continue
            songs = []
            for position, occurrence in enumerate(occurrences):
                payload = json_object(occurrence["payload_json"])
                songs.append(
                    {
                        "occurrenceId": occurrence["occurrence_id"],
                        "position": position,
                        "rangeId": occurrence["range_id"],
                        "songKey": occurrence["song_key"],
                        "seconds": occurrence["seconds"],
                        "title": occurrence["title"],
                        "artist": occurrence["artist"],
                        "sourceId": occurrence["source_id"],
                        "rawHash": first_present(payload, "rawHash", "raw_hash"),
                        "sourceSystem": occurrence["source_system"],
                        "payload": payload,
                    }
                )
            video_payload = json_object(video["payload_json"])
            yield {
                "videoId": video["video_id"],
                "title": video["title"] or "",
                "channelName": video["channel_name"] or "",
                "channelId": video["channel_id"] or "",
                "channelHandle": video["channel_handle"] or "",
                "channelUrl": video["channel_url"] or "",
                "publishedAt": video_payload.get("publishedAt") or video["published_timestamp"],
                "songs": songs,
                "reason": "existing_sqlite_runtime",
                "reviewedAt": reviewed_at,
                "reviewedBy": "sqlite-stream-migration",
                "note": "Read-only streamed source; no SQLite copy created.",
            }
        yield from export_runtime_records(connection, tables, range_id)
    finally:
        connection.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--range", default="all", choices=("all", "7d"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.db.is_file():
        print(f"SQLITE_STREAM_ERROR missing-db={args.db}", file=sys.stderr)
        return 2
    try:
        for record in export_records(args.db, args.range):
            print(json.dumps(record, ensure_ascii=False, separators=(",", ":")), flush=True)
    except Exception as exc:  # pragma: no cover - exercised by CLI failure paths
        print(f"SQLITE_STREAM_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())