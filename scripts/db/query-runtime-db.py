#!/usr/bin/env python3
"""Query a SQLite runtime database for smoke checks and operator diagnostics."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import sys


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def main() -> int:
    configure_stdio()
    args = parse_args()
    try:
        db_path = args.db.resolve()
        if not db_path.exists():
            raise FileNotFoundError(f"database not found: {db_path}")
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        payload = query_rankings(conn, args.range, args.view, args.metric, args.page, args.page_size, args.q)
        conn.close()
    except Exception as exc:  # pragma: no cover - CLI diagnostics
        print(f"CODEX_RUNTIME_DB_QUERY_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    if args.summary_only:
        summary = {
            key: payload[key]
            for key in (
                "schemaVersion",
                "rangeId",
                "view",
                "metric",
                "page",
                "pageSize",
                "totalCount",
                "totalOccurrenceCount",
                "totalVideoCount",
                "pageCount",
            )
        }
        if payload["records"]:
            first = payload["records"][0]
            summary["firstRecord"] = {
                key: first.get(key)
                for key in ("rank", "key", "title", "displayArtist", "name", "count", "videoCount", "sourceDetailKey")
                if key in first
            }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    print(
        "CODEX_RUNTIME_DB_QUERY_OK "
        f"db={args.db} range={args.range} view={args.view} total={payload['totalCount']} rows={len(payload['records'])}"
    )
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path("artifacts/runtime/song-rank.sqlite"))
    parser.add_argument("--range", default="all", choices=("7d", "all"))
    parser.add_argument("--view", default="songs", choices=("songs", "songIndex", "artists", "videos", "vsingerSongs"))
    parser.add_argument("--metric", default="occurrences", choices=("occurrences", "videos", "count"))
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--page-size", type=int, default=20)
    parser.add_argument("--q", default="")
    parser.add_argument("--summary-only", action="store_true", help="print counts and the first row identity only")
    return parser.parse_args()


def query_rankings(conn: sqlite3.Connection, range_id: str, view: str, metric: str, page: int, page_size: int, q: str) -> dict:
    page = max(1, int(page or 1))
    page_size = min(200, max(1, int(page_size or 20)))
    db_metric = "videos" if view in {"songs", "artists"} and metric == "videos" else "count"
    where = ["range_id = ?", "view = ?", "metric = ?", "scope_key = 'all'"]
    params: list[object] = [range_id, view, db_metric]
    if q:
        needle = f"%{q.strip().lower()}%"
        where.append("(lower(search_text) LIKE ? OR lower(title) LIKE ? OR lower(artist) LIKE ? OR lower(name) LIKE ?)")
        params.extend([needle, needle, needle, needle])
    where_sql = " AND ".join(where)
    totals = conn.execute(
        f"SELECT COUNT(*) AS total_count, COALESCE(SUM(count), 0) AS total_occurrences, COALESCE(SUM(video_count), 0) AS total_videos FROM ranking_rows WHERE {where_sql}",
        params,
    ).fetchone()
    total = totals["total_count"]
    offset = (page - 1) * page_size
    rows = conn.execute(
        f"""
        SELECT rank, detail_key, title, artist, name, count, video_count, timestamp_count, payload_json
        FROM ranking_rows
        WHERE {where_sql}
        ORDER BY rank
        LIMIT ? OFFSET ?
        """,
        [*params, page_size, offset],
    ).fetchall()
    return {
        "schemaVersion": 1,
        "rangeId": range_id,
        "view": view,
        "metric": "videos" if db_metric == "videos" else "occurrences",
        "page": page,
        "pageSize": page_size,
        "totalCount": total,
        "totalOccurrenceCount": totals["total_occurrences"],
        "totalVideoCount": totals["total_videos"],
        "pageCount": (total + page_size - 1) // page_size,
        "records": [decode_row(row) for row in rows],
    }


def decode_row(row: sqlite3.Row) -> dict:
    payload = json.loads(row["payload_json"])
    payload.setdefault("rank", row["rank"])
    payload.setdefault("key", row["detail_key"])
    payload.setdefault("count", row["count"])
    payload.setdefault("videoCount", row["video_count"])
    payload.setdefault("timestampCount", row["timestamp_count"])
    return payload


if __name__ == "__main__":
    sys.exit(main())
