#!/usr/bin/env python3
"""Small HTTP API for the song-rank SQLite runtime database."""

from __future__ import annotations

import argparse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import sys
from urllib.parse import parse_qs, quote, unquote, urlparse


DEFAULT_DB_PATH = Path("artifacts/runtime/song-rank.sqlite")


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def main() -> int:
    configure_stdio()
    args = parse_args()
    db_path = args.db.resolve()
    if not db_path.exists():
        print(f"CODEX_RUNTIME_API_ERROR database not found: {db_path}", file=sys.stderr)
        return 1
    handler = make_handler(db_path)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"CODEX_RUNTIME_API_READY host={args.host} port={args.port} db={db_path}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    return parser.parse_args()


def make_handler(db_path: Path):
    class SongRankHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:  # noqa: N802 - stdlib hook
            parsed = urlparse(self.path)
            try:
                if parsed.path == "/healthz":
                    self.send_json(HTTPStatus.OK, health_payload(db_path))
                elif parsed.path == "/api/meta":
                    self.send_json(HTTPStatus.OK, meta_payload(db_path))
                elif parsed.path == "/api/rankings":
                    self.send_json(HTTPStatus.OK, rankings_payload(db_path, parse_qs(parsed.query)))
                elif parsed.path.startswith("/api/sources/"):
                    key = unquote(parsed.path.removeprefix("/api/sources/"))
                    self.send_json(HTTPStatus.OK, source_payload(db_path, key, parse_qs(parsed.query)))
                else:
                    self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            except ValueError as exc:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "bad_request", "message": str(exc)})
            except Exception as exc:  # pragma: no cover - operator diagnostics
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "internal_error", "message": str(exc)})

        def log_message(self, format: str, *args) -> None:  # noqa: A002 - stdlib signature
            sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

        def send_json(self, status: HTTPStatus, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(int(status))
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "public, max-age=30" if status == HTTPStatus.OK else "no-store")
            self.end_headers()
            self.wfile.write(body)

    return SongRankHandler


def connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def health_payload(db_path: Path) -> dict:
    with connect(db_path) as conn:
        meta = read_meta(conn)
        return {
            "status": "ok",
            "schemaVersion": int(meta.get("schema_version", "0")),
            "builtAt": meta.get("built_at", ""),
            "latestGeneratedAt": meta.get("latest_generated_at", ""),
            "counts": table_counts(conn),
        }


def meta_payload(db_path: Path) -> dict:
    with connect(db_path) as conn:
        return {"schemaVersion": 1, "meta": read_meta(conn), "counts": table_counts(conn)}


def rankings_payload(db_path: Path, query: dict[str, list[str]]) -> dict:
    range_id = first(query, "range", "all")
    view = first(query, "view", "songs")
    page = parse_int(first(query, "page", "1"), "page")
    page_size = min(200, max(1, parse_int(first(query, "pageSize", "50"), "pageSize")))
    q = first(query, "q", "").strip()
    metric = normalize_metric(view, first(query, "metric", "count"))
    min_count = max(1, parse_int(first(query, "minCount", "1"), "minCount"))
    if range_id not in {"7d", "all"}:
        raise ValueError("range must be 7d or all")
    if view not in {"songs", "songIndex", "artists", "videos", "vtubers", "vsingerSongs"}:
        raise ValueError("view must be songs, songIndex, artists, videos, vtubers, or vsingerSongs")
    if q and view in {"songs", "songIndex"}:
        return contextual_song_rankings_payload(db_path, range_id, view, page, page_size, q, metric, min_count)

    base_where = ["range_id = ?", "view = ?", "metric = ?", "scope_key = 'all'"]
    base_params: list[object] = [range_id, view, metric]
    where = list(base_where)
    params = list(base_params)
    if min_count > 1 and view not in {"videos", "vtubers"}:
        column = "video_count" if metric == "videos" else "count"
        where.append(f"{column} >= ?")
        params.append(min_count)
    if q:
        clause, values = search_filter_for_view(view, q)
        where.append(clause)
        params.extend(values)
    where_sql = " AND ".join(where)
    base_where_sql = " AND ".join(base_where)
    offset = (max(1, page) - 1) * page_size

    with connect(db_path) as conn:
        base_total = conn.execute(
            f"SELECT COUNT(*) AS total_count FROM ranking_rows WHERE {base_where_sql}",
            base_params,
        ).fetchone()["total_count"]
        totals = conn.execute(
            f"SELECT COUNT(*) AS total_count, COALESCE(SUM(count), 0) AS total_occurrences, COALESCE(SUM(video_count), 0) AS total_videos FROM ranking_rows WHERE {where_sql}",
            params,
        ).fetchone()
        total = totals["total_count"]
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
        "metric": "videos" if metric == "videos" else "occurrences",
        "page": max(1, page),
        "pageSize": page_size,
        "totalCount": total,
        "filteredBaseCount": base_total,
        "totalOccurrenceCount": totals["total_occurrences"],
        "totalVideoCount": totals["total_videos"],
        "pageCount": (total + page_size - 1) // page_size,
        "records": [decode_row(row) for row in rows],
    }


def normalize_metric(view: str, metric: str) -> str:
    metric = (metric or "count").strip()
    if view in {"songs", "artists", "vtubers"}:
        if metric in {"count", "occurrences"}:
            return "count"
        if metric == "videos":
            return "videos"
        raise ValueError("metric must be occurrences or videos")
    return "count"


def contextual_song_rankings_payload(
    db_path: Path,
    range_id: str,
    view: str,
    page: int,
    page_size: int,
    q: str,
    metric: str,
    min_count: int,
) -> dict:
    needle = f"%{q.lower()}%"
    page = max(1, page)
    offset = (page - 1) * page_size
    base_params: list[object] = [range_id, view, metric]
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
            AND lower(so.search_text) LIKE ?
          GROUP BY sd.entity_key, sd.source_key
        )
    """
    cte_params: list[object] = [range_id, needle]
    occurrence_value = "CASE WHEN sm.matched_count IS NOT NULL THEN sm.matched_count ELSE r.count END"
    video_value = "CASE WHEN sm.matched_count IS NOT NULL THEN sm.matched_video_count ELSE r.video_count END"
    rank_value = video_value if metric == "videos" else occurrence_value
    where = [
        "r.range_id = ?",
        "r.view = ?",
        "r.metric = ?",
        "r.scope_key = 'all'",
        "(lower(r.search_text) LIKE ? OR lower(r.title) LIKE ? OR lower(r.artist) LIKE ? OR sm.matched_count IS NOT NULL)",
    ]
    params: list[object] = [*base_params, needle, needle, needle]
    if min_count > 1:
        where.append(f"{rank_value} >= ?")
        params.append(min_count)
    where_sql = " AND ".join(where)
    order_sql = "r.rank" if view == "songIndex" else f"{rank_value} DESC, lower(r.title), lower(r.artist), r.detail_key"
    rank_sql = "r.rank" if view == "songIndex" else f"RANK() OVER (ORDER BY {rank_value} DESC)"
    with connect(db_path) as conn:
        base_total = conn.execute(
            "SELECT COUNT(*) AS total_count FROM ranking_rows WHERE range_id = ? AND view = ? AND metric = ? AND scope_key = 'all'",
            base_params,
        ).fetchone()["total_count"]
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
        records = [decode_contextual_song_row(conn, row, q) for row in rows]
    return {
        "schemaVersion": 1,
        "rangeId": range_id,
        "view": view,
        "metric": "videos" if metric == "videos" else "occurrences",
        "page": page,
        "pageSize": page_size,
        "totalCount": total,
        "filteredBaseCount": base_total,
        "totalOccurrenceCount": totals["total_occurrences"],
        "totalVideoCount": totals["total_videos"],
        "pageCount": (total + page_size - 1) // page_size,
        "records": records,
    }


def search_filter_for_view(view: str, query: str) -> tuple[str, list[str]]:
    needle = f"%{query.lower()}%"
    if view in {"songs", "songIndex", "vsingerSongs"}:
        return "(lower(search_text) LIKE ? OR lower(title) LIKE ? OR lower(artist) LIKE ?)", [needle, needle, needle]
    if view == "artists":
        return "(lower(search_text) LIKE ? OR lower(name) LIKE ?)", [needle, needle]
    if view == "vtubers":
        return "(lower(search_text) LIKE ? OR lower(name) LIKE ?)", [needle, needle]
    return "(lower(search_text) LIKE ? OR lower(title) LIKE ? OR lower(name) LIKE ?)", [needle, needle, needle]


def decode_contextual_song_row(conn: sqlite3.Connection, row: sqlite3.Row, q: str) -> dict:
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
    matched_count = row["matched_count"]
    source_key = row["source_key"]
    if matched_count is not None and source_key:
        matched_video_count = int(row["matched_video_count"] or 0)
        occurrences = matching_source_occurrences(conn, source_key, q, limit=20)
        payload["matchedBySource"] = True
        payload["sourceFilterQuery"] = q
        payload["count"] = int(matched_count or 0)
        payload["videoCount"] = matched_video_count
        payload["timestampCount"] = int(matched_count or 0)
        payload["occurrences"] = occurrences
        payload["channels"] = count_occurrence_channels(occurrences)
        payload["occurrencePreviewLimited"] = int(matched_count or 0) > len(occurrences)
        payload["sourceDetailPath"] = f"/api/sources/{quote(source_key, safe='')}?q={quote(q, safe='')}"
    return payload


def matching_source_occurrences(conn: sqlite3.Connection, source_key: str, q: str, limit: int = 0) -> list[dict]:
    sql = """
        SELECT payload_json
        FROM source_occurrences
        WHERE source_key = ?
          AND lower(search_text) LIKE ?
        ORDER BY position
    """
    params: list[object] = [source_key, f"%{q.lower()}%"]
    if limit > 0:
        sql = f"{sql} LIMIT ?"
        params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    return [json.loads(row["payload_json"]) for row in rows]


def count_occurrence_channels(occurrences: list[dict]) -> list[dict]:
    counts: dict[str, dict] = {}
    for occurrence in occurrences:
        item = occurrence.get("item") if isinstance(occurrence.get("item"), dict) else {}
        name = str(item.get("channelName") or "").strip()
        if not name:
            continue
        key = name.lower()
        if key not in counts:
            counts[key] = {"key": key, "name": name, "count": 0}
        counts[key]["count"] += 1
    return sorted(counts.values(), key=lambda row: (-int(row["count"]), row["name"].lower()))


def source_payload(db_path: Path, key: str, query: dict[str, list[str]] | None = None) -> dict:
    if not key:
        raise ValueError("source key is required")
    source_query = query or {}
    q = first(source_query, "q", "").strip()
    use_paging = "page" in source_query or "pageSize" in source_query
    page = max(1, parse_int(first(source_query, "page", "1"), "page"))
    page_size = min(200, max(1, parse_int(first(source_query, "pageSize", "50"), "pageSize")))
    with connect(db_path) as conn:
        row = conn.execute("SELECT payload_json FROM source_details WHERE source_key = ?", (key,)).fetchone()
        if use_paging:
            occurrence_rows, total_occurrences, total_videos, page = paged_source_occurrences(conn, key, q, page, page_size)
        else:
            occurrence_rows = all_source_occurrences(conn, key, q)
            total_occurrences = len(occurrence_rows)
            total_videos = len({
                occurrence["video_id"]
                for occurrence in occurrence_rows
                if occurrence["video_id"]
            })
    if row is None:
        return {"schemaVersion": 1, "found": False, "sourceKey": key}
    record = json.loads(row["payload_json"])
    record["occurrences"] = [json.loads(occurrence["payload_json"]) for occurrence in occurrence_rows]
    if q or use_paging:
        record["sourceFilterQuery"] = q
        record["count"] = total_occurrences
        record["timestampCount"] = total_occurrences
        record["videoCount"] = total_videos
        record["occurrencePreviewLimited"] = total_occurrences > len(record["occurrences"])
    payload = {"schemaVersion": 1, "found": True, "sourceKey": key, "record": record}
    if use_paging:
        page_count = max(1, (total_videos + page_size - 1) // page_size)
        payload.update(
            {
                "page": page,
                "pageSize": page_size,
                "pageCount": page_count,
                "totalCount": total_videos,
                "totalVideoCount": total_videos,
                "totalOccurrenceCount": total_occurrences,
            }
        )
    return payload


def all_source_occurrences(conn: sqlite3.Connection, key: str, q: str) -> list[sqlite3.Row]:
    if q:
        return conn.execute(
            """
            SELECT payload_json, video_id FROM source_occurrences
            WHERE source_key = ? AND lower(search_text) LIKE ?
            ORDER BY position
            """,
            (key, f"%{q.lower()}%"),
        ).fetchall()
    return conn.execute(
        "SELECT payload_json, video_id FROM source_occurrences WHERE source_key = ? ORDER BY position",
        (key,),
    ).fetchall()


def paged_source_occurrences(
    conn: sqlite3.Connection,
    key: str,
    q: str,
    page: int,
    page_size: int,
) -> tuple[list[sqlite3.Row], int, int, int]:
    group_expr = "COALESCE(NULLIF(video_id, ''), 'position:' || position)"
    where = ["source_key = ?"]
    params: list[object] = [key]
    if q:
        where.append("lower(search_text) LIKE ?")
        params.append(f"%{q.lower()}%")
    where_sql = " AND ".join(where)
    total_occurrences = conn.execute(
        f"SELECT COUNT(*) AS total_count FROM source_occurrences WHERE {where_sql}",
        params,
    ).fetchone()["total_count"]
    total_videos = conn.execute(
        f"SELECT COUNT(*) AS total_count FROM (SELECT 1 FROM source_occurrences WHERE {where_sql} GROUP BY {group_expr})",
        params,
    ).fetchone()["total_count"]
    page_count = max(1, (total_videos + page_size - 1) // page_size)
    page = min(page, page_count)
    offset = (page - 1) * page_size
    group_rows = conn.execute(
        f"""
        SELECT {group_expr} AS group_key
        FROM source_occurrences
        WHERE {where_sql}
        GROUP BY group_key
        ORDER BY MIN(position)
        LIMIT ? OFFSET ?
        """,
        [*params, page_size, offset],
    ).fetchall()
    group_keys = [row["group_key"] for row in group_rows]
    if not group_keys:
        return [], total_occurrences, total_videos, page
    placeholders = ",".join("?" for _ in group_keys)
    occurrence_rows = conn.execute(
        f"""
        SELECT payload_json, video_id FROM source_occurrences
        WHERE {where_sql}
          AND {group_expr} IN ({placeholders})
        ORDER BY position
        """,
        [*params, *group_keys],
    ).fetchall()
    return occurrence_rows, total_occurrences, total_videos, page


def decode_row(row: sqlite3.Row) -> dict:
    payload = json.loads(row["payload_json"])
    payload.setdefault("rank", row["rank"])
    payload.setdefault("key", row["detail_key"])
    payload.setdefault("count", row["count"])
    payload.setdefault("videoCount", row["video_count"])
    payload.setdefault("timestampCount", row["timestamp_count"])
    return payload


def read_meta(conn: sqlite3.Connection) -> dict[str, str]:
    return {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM meta ORDER BY key")}


def table_counts(conn: sqlite3.Connection) -> dict[str, int]:
    tables = (
        "videos",
        "songs",
        "occurrences",
        "ranking_rows",
        "source_occurrences",
        "external_songs",
        "external_videos",
        "external_occurrences",
    )
    return {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables}


def first(query: dict[str, list[str]], key: str, default: str) -> str:
    values = query.get(key)
    if not values:
        return default
    return values[0]


def parse_int(value: str, label: str) -> int:
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{label} must be an integer") from exc


if __name__ == "__main__":
    sys.exit(main())
