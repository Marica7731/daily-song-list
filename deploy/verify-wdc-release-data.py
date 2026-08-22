#!/usr/bin/env python3
"""Verify expensive WDC release invariants before any production activation."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import unicodedata
from pathlib import Path


SONG_SOURCE = ("all", "0007036316d9dffa", 771, 1, 737)
ARTIST_SOURCE = ("all", "000c1914748382f4", 7, 1, 7)
WIDTH_SOURCE = ("7d", "9d99a4a482ed24b2536f0058")
WIDTH_SONG_KEY = "e3bf8d66f08c946857927c15"


def _atomic_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(mode=0o700, parents=False, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(
            descriptor,
            (json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n").encode(),
        )
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)


def _source_counts(
    connection: sqlite3.Connection,
    range_id: str,
    source_key: str,
) -> tuple[int, int, int]:
    row = connection.execute(
        """
        SELECT d.total_occurrence_count,
               count(DISTINCT nullif(o.canonical_song_key,'')),
               d.total_video_count
        FROM source_details AS d
        LEFT JOIN source_occurrences AS o
          ON o.range_id=d.range_id AND o.source_key=d.source_key
        WHERE d.range_id=? AND d.source_key=?
        GROUP BY d.range_id,d.source_key
        """,
        (range_id, source_key),
    ).fetchone()
    if row is None:
        raise RuntimeError(
            f"WDC_RELEASE_SOURCE_MISSING range={range_id} source={source_key}"
        )
    return tuple(int(value or 0) for value in row)  # type: ignore[return-value]


def verify(database: Path) -> dict[str, object]:
    if not database.is_absolute() or database.is_symlink() or not database.is_file():
        raise RuntimeError(f"WDC_RELEASE_DATABASE_UNSAFE path={database}")
    uri = f"file:{database.as_posix()}?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True)
    try:
        connection.execute("PRAGMA query_only=ON")
        integrity = str(connection.execute("PRAGMA quick_check").fetchone()[0])
        if integrity != "ok":
            raise RuntimeError(f"WDC_RELEASE_DATABASE_QUICK_CHECK_FAILED result={integrity}")

        required_tables = {
            "serving_meta",
            "source_details",
            "source_occurrences",
            "source_videos",
            "ranking_rows",
        }
        actual_tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        missing = sorted(required_tables - actual_tables)
        if missing:
            raise RuntimeError(f"WDC_RELEASE_DATABASE_TABLES_MISSING tables={missing}")

        exact_sources: dict[str, dict[str, int]] = {}
        for range_id, source_key, occurrences, songs, videos in (
            SONG_SOURCE,
            ARTIST_SOURCE,
        ):
            actual = _source_counts(connection, range_id, source_key)
            expected = (occurrences, songs, videos)
            if actual != expected:
                raise RuntimeError(
                    "WDC_RELEASE_EXACT_SOURCE_MISMATCH "
                    f"range={range_id} source={source_key} actual={actual} expected={expected}"
                )
            exact_sources[f"{range_id}/{source_key}"] = {
                "occurrences": actual[0],
                "songs": actual[1],
                "videos": actual[2],
            }

        width_range, width_source = WIDTH_SOURCE
        width_row = connection.execute(
            """
            SELECT d.payload_json,
                   count(DISTINCT CASE WHEN o.canonical_song_key=?
                                       THEN o.canonical_song_name END),
                   min(CASE WHEN o.canonical_song_key=?
                            THEN o.canonical_song_name END),
                   count(CASE WHEN o.canonical_song_key=? THEN 1 END)
            FROM source_details AS d
            LEFT JOIN source_occurrences AS o
              ON o.range_id=d.range_id AND o.source_key=d.source_key
            WHERE d.range_id=? AND d.source_key=?
            GROUP BY d.range_id,d.source_key
            """,
            (WIDTH_SONG_KEY, WIDTH_SONG_KEY, WIDTH_SONG_KEY, width_range, width_source),
        ).fetchone()
        if width_row is None:
            raise RuntimeError("WDC_RELEASE_WIDTH_SOURCE_MISSING")
        detail = json.loads(str(width_row[0]))
        songs = detail.get("songs") or []
        owner_rows = [
            item
            for item in songs
            if isinstance(item, dict) and str(item.get("key") or "") == WIDTH_SONG_KEY
        ]
        canonical_name_count = int(width_row[1] or 0)
        canonical_name = str(width_row[2] or "")
        canonical_occurrences = int(width_row[3] or 0)
        if len(owner_rows) != 1 or canonical_name_count != 1 or canonical_occurrences <= 0:
            raise RuntimeError(
                "WDC_RELEASE_WIDTH_OWNER_AMBIGUOUS "
                f"owners={len(owner_rows)} names={canonical_name_count} occurrences={canonical_occurrences}"
            )
        owner_name = str(owner_rows[0].get("name") or "")
        if unicodedata.normalize("NFKC", owner_name) != "サインはB":
            raise RuntimeError(f"WDC_RELEASE_WIDTH_OWNER_INVALID name={owner_name!r}")
        if canonical_name != owner_name:
            raise RuntimeError(
                "WDC_RELEASE_WIDTH_OCCURRENCE_OWNER_DRIFT "
                f"detail={owner_name!r} occurrence={canonical_name!r}"
            )

        probe = connection.execute(
            """
            SELECT source_key,total_occurrence_count,total_video_count
            FROM source_details
            WHERE range_id='all'
              AND total_video_count=31
              AND total_occurrence_count>total_video_count
            ORDER BY total_occurrence_count DESC,source_key
            LIMIT 1
            """
        ).fetchone()
        if probe is None:
            raise RuntimeError("WDC_RELEASE_31_VIDEO_PROBE_MISSING")
        probe_key = str(probe[0])
        probe_occurrences = int(probe[1])
        probe_videos = int(probe[2])
        actual_videos = int(
            connection.execute(
                """
                SELECT count(DISTINCT video_id)
                FROM source_occurrences
                WHERE range_id='all' AND source_key=? AND video_id<>''
                """,
                (probe_key,),
            ).fetchone()[0]
        )
        if (probe_videos, actual_videos) != (31, 31):
            raise RuntimeError(
                f"WDC_RELEASE_31_VIDEO_PROBE_INVALID declared={probe_videos} actual={actual_videos}"
            )

        result: dict[str, object] = {
            "databaseQuickCheck": integrity,
            "exactSources": exact_sources,
            "widthOwner": {
                "range": width_range,
                "sourceKey": width_source,
                "songKey": WIDTH_SONG_KEY,
                "name": owner_name,
                "occurrences": canonical_occurrences,
            },
            "crossPageProbe": {
                "range": "all",
                "sourceKey": probe_key,
                "occurrences": probe_occurrences,
                "videos": probe_videos,
            },
        }
        return result
    finally:
        connection.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = verify(args.database)
    _atomic_json(args.output, result)
    print("WDC_RELEASE_DATA_VERIFIED", json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
