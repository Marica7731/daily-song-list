#!/usr/bin/env python3
"""Query a SQLite runtime database for smoke checks and operator diagnostics."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import sys

SEARCH_FIELD_ORDER = ("title", "artist", "channel", "video")
SEARCH_FIELD_ALIASES = {
    "song": "title",
    "songs": "title",
    "songTitle": "title",
    "singer": "artist",
    "vtuber": "channel",
    "vtubers": "channel",
    "source": "channel",
    "sources": "channel",
    "videos": "video",
}


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
        payload = query_rankings(conn, args.range, args.view, args.metric, args.page, args.page_size, args.q, args.fields)
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
                for key in (
                    "rank",
                    "globalRank",
                    "key",
                    "title",
                    "displayArtist",
                    "name",
                    "count",
                    "globalCount",
                    "videoCount",
                    "globalVideoCount",
                    "matchedBySource",
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
    parser.add_argument("--metric", default="occurrences", choices=("occurrences", "videos", "count"))
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--page-size", type=int, default=20)
    parser.add_argument("--q", default="")
    parser.add_argument("--fields", default="", help="comma-separated title,artist,channel,video; use all for all fields")
    parser.add_argument("--summary-only", action="store_true", help="print counts and the first row identity only")
    return parser.parse_args()


def query_rankings(conn: sqlite3.Connection, range_id: str, view: str, metric: str, page: int, page_size: int, q: str, fields_raw: str = "") -> dict:
    page = max(1, int(page or 1))
    page_size = min(200, max(1, int(page_size or 20)))
    db_metric = "videos" if view in {"songs", "artists", "vtubers"} and metric == "videos" else "count"
    search_fields = parse_search_fields(fields_raw, view)
    if q and view in {"songs", "songIndex"}:
        return query_contextual_songs(conn, range_id, view, db_metric, page, page_size, q, search_fields)
    where = ["range_id = ?", "view = ?", "metric = ?", "scope_key = 'all'"]
    params: list[object] = [range_id, view, db_metric]
    if q:
        clause, values = search_filter_for_view(view, q, search_fields)
        where.append(clause)
        params.extend(values)
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


def query_contextual_songs(
    conn: sqlite3.Connection,
    range_id: str,
    view: str,
    db_metric: str,
    page: int,
    page_size: int,
    q: str,
    search_fields: set[str],
) -> dict:
    needle = f"%{q.strip().lower()}%"
    record_terms: list[str] = []
    record_params: list[object] = []
    if "title" in search_fields:
        record_terms.append("lower(r.title) LIKE ?")
        record_params.append(needle)
    if "artist" in search_fields:
        record_terms.append("lower(r.artist) LIKE ?")
        record_params.append(needle)
    record_match_sql = f"({' OR '.join(record_terms)})" if record_terms else "0"
    source_terms: list[str] = []
    source_params: list[object] = []
    if "channel" in search_fields:
        source_terms.append("(lower(so.channel_name) LIKE ? OR lower(so.channel_id) LIKE ? OR lower(so.channel_handle) LIKE ? OR lower(so.channel_url) LIKE ?)")
        source_params.extend([needle, needle, needle, needle])
    if "video" in search_fields:
        source_terms.append("(lower(so.title) LIKE ? OR lower(so.video_id) LIKE ?)")
        source_params.extend([needle, needle])
    source_match_sql = f"({' OR '.join(source_terms)})" if source_terms else "0"
    source_match_cte = """
        WITH source_matches AS (
          SELECT sd.entity_key AS detail_key,
                 sd.source_key AS source_key,
                 COUNT(*) AS matched_count,
                 COUNT(DISTINCT NULLIF(so.video_id, '')) AS matched_video_count
          FROM source_details sd
          JOIN source_occurrences so
            ON so.source_key = sd.source_key
           AND so.range_id = sd.range_id
          WHERE sd.range_id = ?
            AND sd.entity_type = 'song'
            AND {source_match_sql}
          GROUP BY sd.entity_key, sd.source_key
        )
    """.format(source_match_sql=source_match_sql)
    occurrence_value = "CASE WHEN sm.matched_count IS NOT NULL THEN sm.matched_count ELSE r.count END"
    video_value = "CASE WHEN sm.matched_count IS NOT NULL THEN sm.matched_video_count ELSE r.video_count END"
    rank_value = video_value if db_metric == "videos" else occurrence_value
    base_params: list[object] = [range_id, view, db_metric]
    cte_params: list[object] = [range_id, *source_params]
    where_sql = """
        r.range_id = ?
        AND r.view = ?
        AND r.metric = ?
        AND r.scope_key = 'all'
        AND ({record_match_sql} OR sm.matched_count IS NOT NULL)
    """.format(record_match_sql=record_match_sql)
    params: list[object] = [*base_params, *record_params]
    order_sql = "r.rank" if view == "songIndex" else f"{rank_value} DESC, lower(r.title), lower(r.artist), r.detail_key"
    rank_sql = "r.rank" if view == "songIndex" else f"RANK() OVER (ORDER BY {rank_value} DESC)"
    totals = conn.execute(
        f"""
        {source_match_cte}
        SELECT COUNT(*) AS total_count,
               COALESCE(SUM({occurrence_value}), 0) AS total_occurrences,
               COALESCE(SUM({video_value}), 0) AS total_videos
        FROM ranking_rows r
        LEFT JOIN source_matches sm ON sm.detail_key = r.detail_key
        WHERE {where_sql}
        """,
        [*cte_params, *params],
    ).fetchone()
    total = totals["total_count"]
    offset = (page - 1) * page_size
    rows = conn.execute(
        f"""
        {source_match_cte}
        SELECT {rank_sql} AS contextual_rank,
               r.rank AS global_rank,
               r.detail_key,
               r.title,
               r.artist,
               r.name,
               r.count,
               r.video_count,
               r.timestamp_count,
               r.payload_json,
               sm.source_key,
               sm.matched_count,
               sm.matched_video_count
        FROM ranking_rows r
        LEFT JOIN source_matches sm ON sm.detail_key = r.detail_key
        WHERE {where_sql}
        ORDER BY {order_sql}
        LIMIT ? OFFSET ?
        """,
        [*cte_params, *params, page_size, offset],
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
        "records": [decode_contextual_song_row(row) for row in rows],
    }


def decode_row(row: sqlite3.Row) -> dict:
    payload = json.loads(row["payload_json"])
    payload.setdefault("rank", row["rank"])
    payload.setdefault("key", row["detail_key"])
    payload.setdefault("count", row["count"])
    payload.setdefault("videoCount", row["video_count"])
    payload.setdefault("timestampCount", row["timestamp_count"])
    return payload


def decode_contextual_song_row(row: sqlite3.Row) -> dict:
    payload = json.loads(row["payload_json"])
    payload.setdefault("key", row["detail_key"])
    payload.setdefault("count", row["count"])
    payload.setdefault("videoCount", row["video_count"])
    payload.setdefault("timestampCount", row["timestamp_count"])
    payload["globalRank"] = row["global_rank"]
    payload["globalCount"] = row["count"]
    payload["globalVideoCount"] = row["video_count"]
    payload["globalTimestampCount"] = row["timestamp_count"]
    payload["rank"] = row["contextual_rank"]
    if row["matched_count"] is not None and row["source_key"]:
        payload["matchedBySource"] = True
        payload["count"] = int(row["matched_count"] or 0)
        payload["videoCount"] = int(row["matched_video_count"] or 0)
        payload["timestampCount"] = int(row["matched_count"] or 0)
        payload["occurrences"] = []
    return payload


def default_search_fields_for_view(view: str) -> set[str]:
    if view in {"songs", "songIndex", "vsingerSongs"}:
        return {"title", "artist"}
    if view == "artists":
        return {"artist"}
    if view == "vtubers":
        return {"channel"}
    if view == "videos":
        return {"video", "channel"}
    return {"title", "artist"}


def parse_search_fields(raw: str, view: str) -> set[str]:
    value = (raw or "").strip()
    if not value:
        return default_search_fields_for_view(view)
    fields: list[str] = []
    for part in value.split(","):
        key = part.strip()
        if not key:
            continue
        if key in {"all", "*"}:
            return set(SEARCH_FIELD_ORDER)
        canonical = SEARCH_FIELD_ALIASES.get(key, key)
        if canonical in SEARCH_FIELD_ORDER and canonical not in fields:
            fields.append(canonical)
    return set(fields) if fields else set(SEARCH_FIELD_ORDER)


def search_filter_for_view(view: str, query: str, search_fields: set[str] | None = None) -> tuple[str, list[str]]:
    needle = f"%{query.strip().lower()}%"
    fields = search_fields or set(SEARCH_FIELD_ORDER)
    clauses: list[str] = []
    values: list[str] = []

    def add(sql: str, count: int = 1) -> None:
        clauses.append(sql)
        values.extend([needle] * count)

    if view in {"songs", "songIndex", "vsingerSongs"}:
        if "title" in fields:
            add("lower(title) LIKE ?")
        if "artist" in fields:
            add("lower(artist) LIKE ?")
        if "channel" in fields or "video" in fields:
            add("lower(search_text) LIKE ?")
    elif view == "artists":
        if "artist" in fields or fields == set(SEARCH_FIELD_ORDER):
            add("(lower(search_text) LIKE ? OR lower(name) LIKE ?)", 2)
    elif view == "vtubers":
        if "channel" in fields or fields == set(SEARCH_FIELD_ORDER):
            add("(lower(search_text) LIKE ? OR lower(name) LIKE ?)", 2)
    else:
        if "video" in fields:
            add("(lower(title) LIKE ? OR lower(detail_key) LIKE ?)", 2)
        if "channel" in fields:
            add("lower(channel_search_text) LIKE ?")
        if "title" in fields or "artist" in fields:
            add("lower(search_text) LIKE ?")
    if not clauses:
        return "0", []
    return f"({' OR '.join(clauses)})", values


if __name__ == "__main__":
    sys.exit(main())
