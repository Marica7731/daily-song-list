#!/usr/bin/env python3
"""Query a SQLite runtime database for smoke checks and operator diagnostics."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
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
        payload = query_rankings(conn, args.range, args.view, args.metric, args.page, args.page_size, args.q, args.search_scope)
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
                "searchScope",
                "page",
                "pageSize",
                "totalCount",
                "totalOccurrenceCount",
                "totalSongCount",
                "totalVideoCount",
                "pageCount",
            )
        }
        if payload["records"]:
            first = payload["records"][0]
            summary["firstRecord"] = {
                key: first.get(key)
                for key in (
                    "rank",
                    "key",
                    "title",
                    "displayArtist",
                    "name",
                    "count",
                    "songCount",
                    "videoCount",
                    "sourceDetailKey",
                )
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
    parser.add_argument("--view", default="songs", choices=("songs", "songIndex", "artists", "videos", "vtubers", "vsingerSongs"))
    parser.add_argument("--metric", default="occurrences", choices=("occurrences", "videos", "songs", "count"))
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--page-size", type=int, default=20)
    parser.add_argument("--q", default="")
    parser.add_argument("--search-scope", default="all", choices=("all", "song", "entity", "title", "artist", "channel", "video", "source"))
    parser.add_argument("--summary-only", action="store_true", help="print counts and the first row identity only")
    return parser.parse_args()


def query_rankings(conn: sqlite3.Connection, range_id: str, view: str, metric: str, page: int, page_size: int, q: str, search_scope: str = "all") -> dict:
    page = max(1, int(page or 1))
    page_size = min(200, max(1, int(page_size or 20)))
    db_metric = "videos" if view in {"songs", "artists", "vtubers"} and metric == "videos" else "count"
    if view == "vtubers" and metric == "songs":
        db_metric = "songs"
    where = ["range_id = ?", "view = ?", "metric = ?", "scope_key = 'all'"]
    params: list[object] = [range_id, view, db_metric]
    if q:
        clause, values = search_filter_for_view(view, q, search_scope)
        where.append(clause)
        params.extend(values)
    where_sql = " AND ".join(where)
    totals = conn.execute(
        f"SELECT COUNT(*) AS total_count, COALESCE(SUM(count), 0) AS total_occurrences, COALESCE(SUM(song_count), 0) AS total_songs, COALESCE(SUM(video_count), 0) AS total_videos FROM ranking_rows WHERE {where_sql}",
        params,
    ).fetchone()
    total = totals["total_count"]
    offset = (page - 1) * page_size
    rows = conn.execute(
        f"""
        SELECT rank, detail_key, title, artist, name, count, song_count, video_count, timestamp_count, payload_json
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
        "metric": response_metric(db_metric),
        "searchScope": search_scope,
        "page": page,
        "pageSize": page_size,
        "totalCount": total,
        "totalOccurrenceCount": totals["total_occurrences"],
        "totalSongCount": totals["total_songs"],
        "totalVideoCount": totals["total_videos"],
        "pageCount": (total + page_size - 1) // page_size,
        "records": [decode_row(row) for row in rows],
    }


def decode_row(row: sqlite3.Row) -> dict:
    payload = json.loads(row["payload_json"])
    payload.setdefault("rank", row["rank"])
    payload.setdefault("key", row["detail_key"])
    payload.setdefault("count", row["count"])
    payload.setdefault("songCount", row["song_count"])
    payload.setdefault("videoCount", row["video_count"])
    payload.setdefault("timestampCount", row["timestamp_count"])
    return payload


def search_filter_for_view(view: str, query: str, scope: str = "all") -> tuple[str, list[str]]:
    groups = parse_search_groups(query)
    if not groups:
        return "1 = 1", []
    fields = search_fields_for_view(view, scope)
    values: list[str] = []
    or_clauses = []
    for group in groups:
        and_clauses = []
        for term in group:
            like = like_pattern(term)
            and_clauses.append("(" + " OR ".join(f"{field} LIKE ? ESCAPE '\\'" for field in fields) + ")")
            values.extend([like] * len(fields))
        if and_clauses:
            or_clauses.append("(" + " AND ".join(and_clauses) + ")")
    if not or_clauses:
        return "1 = 1", []
    return "(" + " OR ".join(or_clauses) + ")", values


def search_fields_for_view(view: str, scope: str) -> list[str]:
    candidates = {
        "all": ["lower(search_text)", "lower(title)", "lower(artist)", "lower(name)"],
        "entity": ["lower(title)", "lower(artist)", "lower(name)"],
        "song": ["lower(title)", "lower(artist)"],
        "title": ["lower(title)"],
        "artist": ["lower(artist)", "lower(name)"],
        "channel": ["lower(channel_search_text)", "lower(name)"],
        "video": ["lower(search_text)", "lower(title)"],
        "source": ["lower(search_text)"],
    }[scope]
    if view == "artists" and scope in {"song", "title"}:
        candidates = ["lower(name)"]
    if view == "videos" and scope == "channel":
        candidates = ["lower(channel_search_text)", "lower(name)"]
    if view == "vtubers" and scope in {"song", "title", "artist"}:
        candidates = ["lower(name)"]
    result = []
    for field in candidates:
        if field not in result:
            result.append(field)
    return result


def parse_search_groups(query: str) -> list[list[str]]:
    tokens = []
    for match in re.finditer(r'"([^"]+)"|\'([^\']+)\'|(\S+)', query or ""):
        token = next((part for part in match.groups() if part is not None), "").strip()
        if token:
            tokens.append(token)
    groups: list[list[str]] = [[]]
    for token in tokens:
        upper = token.upper()
        if upper in {"OR", "|", "或"}:
            if groups[-1]:
                groups.append([])
            continue
        if upper in {"AND", "+", "与", "和"}:
            continue
        groups[-1].append(token[:80])
    return [group[:12] for group in groups if group]


def like_pattern(term: str) -> str:
    value = (term or "").strip().lower()
    value = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{value}%"


def response_metric(metric: str) -> str:
    if metric == "videos":
        return "videos"
    if metric == "songs":
        return "songs"
    return "occurrences"


if __name__ == "__main__":
    sys.exit(main())
