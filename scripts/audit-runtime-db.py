#!/usr/bin/env python3
"""Extract a bounded, read-only quality report from a fully materialized runtime DB."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
from typing import Any


YOSHIKA_CHANNEL_ID = "UC3xQCiEPSkco54WhuiDcngw"
YOSHIKA_HANDLE = "@yoshika-ch"


def main() -> int:
    configure_stdio()
    args = parse_args()
    try:
        db_path = args.db.resolve()
        if not db_path.is_file():
            raise FileNotFoundError(f"database not found: {db_path}")
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        quick_check = conn.execute("PRAGMA quick_check(1)").fetchone()[0]
        if quick_check != "ok":
            raise RuntimeError(f"SQLite quick_check failed: {quick_check}")
        report = {
            "schemaVersion": 1,
            "status": "complete",
            "db": {
                "bytes": db_path.stat().st_size,
                "sha256": sha256_file(db_path),
                "quickCheck": quick_check,
            },
            "meta": read_meta(conn),
            "tableCounts": read_table_counts(conn),
            "global": read_global_counts(conn),
            "yoshika": read_yoshika(conn),
            "pages": read_requested_pages(conn),
        }
        conn.close()
        write_json_atomic(args.output.resolve(), report)
    except Exception as exc:
        print(f"CODEX_RUNTIME_DB_AUDIT_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(
        "CODEX_RUNTIME_DB_AUDIT_OK "
        f"db={args.db} bytes={report['db']['bytes']} "
        f"videos={report['global']['videos']} songs={report['global']['songs']} "
        f"occurrences={report['global']['occurrences']}"
    )
    return 0


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def read_meta(conn: sqlite3.Connection) -> dict[str, str]:
    return {
        row["key"]: row["value"]
        for row in conn.execute("SELECT key, value FROM meta ORDER BY key")
    }


def read_table_counts(conn: sqlite3.Connection) -> dict[str, int]:
    result = {}
    for table in (
        "videos",
        "songs",
        "occurrences",
        "ranking_rows",
        "channel_metadata",
        "source_details",
        "source_occurrences",
        "external_songs",
        "external_videos",
        "external_occurrences",
    ):
        result[table] = int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    return result


def read_global_counts(conn: sqlite3.Connection) -> dict[str, int]:
    row = conn.execute(
        """
        WITH all_occurrences AS (
          SELECT video_id, song_key, is_unknown_artist
          FROM occurrences
          WHERE range_id = 'all'
        ),
        grouped AS (
          SELECT
            song_key,
            COUNT(*) AS occurrence_count,
            MAX(is_unknown_artist) AS has_unknown_artist
          FROM all_occurrences
          GROUP BY song_key
        )
        SELECT
          (SELECT COUNT(DISTINCT video_id) FROM all_occurrences) AS videos,
          (SELECT COUNT(*) FROM grouped) AS songs,
          (SELECT COUNT(*) FROM all_occurrences) AS occurrences,
          (SELECT COUNT(*) FROM all_occurrences WHERE is_unknown_artist = 1) AS unknown_artist_occurrences,
          (SELECT COUNT(*) FROM grouped WHERE has_unknown_artist = 1) AS unknown_artist_songs,
          (SELECT COUNT(*) FROM grouped WHERE occurrence_count = 1) AS singleton_songs,
          (SELECT COUNT(*) FROM grouped WHERE occurrence_count = 1 AND has_unknown_artist = 1) AS singleton_unknown_songs
        """
    ).fetchone()
    return {key: int(row[key] or 0) for key in row.keys()}


def read_yoshika(conn: sqlite3.Connection) -> dict[str, Any] | None:
    rows = conn.execute(
        """
        SELECT rank, count, song_count, video_count, payload_json
        FROM ranking_rows
        WHERE range_id = 'all'
          AND view = 'vtubers'
          AND metric = 'count'
          AND scope_key = 'all'
        ORDER BY rank
        """
    )
    for row in rows:
        payload = json.loads(row["payload_json"])
        channel_id = clean_text(payload.get("channelId"))
        handle = normalize_handle(
            payload.get("channelHandle")
            or payload.get("channelUrl")
            or payload.get("sourceUrl")
        )
        name = clean_text(payload.get("name") or payload.get("channelName"))
        if (
            channel_id != YOSHIKA_CHANNEL_ID
            and handle != YOSHIKA_HANDLE
            and "YOSHIKA" not in name
        ):
            continue
        source_key = clean_text(payload.get("sourceDetailKey"))
        source_counts = {"occurrences": 0, "unknownArtistOccurrences": 0}
        if source_key:
            source_row = conn.execute(
                """
                SELECT
                  COUNT(*) AS occurrences,
                  COALESCE(SUM(is_unknown_artist), 0) AS unknown_artist_occurrences
                FROM source_occurrences
                WHERE source_key = ? AND range_id = 'all'
                """,
                (source_key,),
            ).fetchone()
            source_counts = {
                "occurrences": int(source_row["occurrences"] or 0),
                "unknownArtistOccurrences": int(
                    source_row["unknown_artist_occurrences"] or 0
                ),
            }
        return {
            "rank": int(row["rank"]),
            "name": name,
            "channelId": channel_id,
            "handle": handle,
            "sourceDetailKey": source_key,
            "songs": int(row["song_count"]),
            "videos": int(row["video_count"]),
            "occurrences": int(row["count"]),
            "singletonSongs": int(payload.get("singletonSongCount") or 0),
            "expandedSongs": len(payload.get("songs") or []),
            "source": source_counts,
        }
    return None


def read_requested_pages(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    pages = []
    for metric in ("count", "songs"):
        for page in (1, 2):
            offset = (page - 1) * 20
            rows = conn.execute(
                """
                SELECT rank, payload_json
                FROM ranking_rows
                WHERE range_id = 'all'
                  AND view = 'vtubers'
                  AND metric = ?
                  AND scope_key = 'all'
                ORDER BY rank
                LIMIT 20 OFFSET ?
                """,
                (metric, offset),
            ).fetchall()
            channels = []
            for row in rows:
                payload = json.loads(row["payload_json"])
                channels.append(
                    {
                        "rank": int(row["rank"]),
                        "key": clean_text(payload.get("key")),
                        "name": clean_text(
                            payload.get("name") or payload.get("channelName")
                        ),
                        "channelId": clean_text(payload.get("channelId")),
                        "handle": normalize_handle(
                            payload.get("channelHandle")
                            or payload.get("channelUrl")
                            or payload.get("sourceUrl")
                        ),
                        "songs": int(payload.get("songCount") or 0),
                        "videos": int(payload.get("videoCount") or 0),
                        "occurrences": int(payload.get("count") or 0),
                        "singletonSongs": int(
                            payload.get("singletonSongCount") or 0
                        ),
                        "expandedSongs": len(payload.get("songs") or []),
                    }
                )
            if len(channels) != 20:
                raise RuntimeError(
                    f"runtime DB {metric} page {page} expected 20 channels, "
                    f"found {len(channels)}"
                )
            incomplete = [
                row for row in channels if row["songs"] != row["expandedSongs"]
            ]
            if incomplete:
                raise RuntimeError(
                    f"runtime DB {metric} page {page} has incomplete song payloads"
                )
            pages.append(
                {
                    "metric": metric,
                    "page": page,
                    "channelCount": len(channels),
                    "expandedSongCount": sum(
                        row["expandedSongs"] for row in channels
                    ),
                    "channels": channels,
                }
            )
    return pages


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while True:
            block = handle.read(8 * 1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def normalize_handle(value: Any) -> str:
    text = clean_text(value)
    if "youtube.com/" in text:
        text = text.split("youtube.com/", 1)[1]
    text = text.split("?", 1)[0].split("#", 1)[0].split("/", 1)[0]
    return text.lower() if text.startswith("@") else ""


def write_json_atomic(file_path: Path, value: Any) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = file_path.with_name(f"{file_path.name}.tmp")
    temp_path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temp_path.replace(file_path)


if __name__ == "__main__":
    raise SystemExit(main())
