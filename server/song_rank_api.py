#!/usr/bin/env python3
"""Small HTTP API for the song-rank SQLite runtime database."""

from __future__ import annotations

import argparse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import sqlite3
import sys
from urllib.parse import parse_qs, unquote, urlparse


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
    search_scope = normalize_search_scope(first(query, "searchScope", first(query, "searchField", "all")))
    search_fields = normalize_search_fields(first(query, "searchFields", ""))
    effective_search_scope = search_scope_from_fields(search_fields) if search_fields is not None and search_scope == "all" else search_scope
    metric = normalize_metric(view, first(query, "metric", "count"))
    min_count = max(1, parse_int(first(query, "minCount", "1"), "minCount"))
    if range_id not in {"7d", "all"}:
        raise ValueError("range must be 7d or all")
    if view not in {"songs", "songIndex", "artists", "videos", "vtubers", "vsingerSongs"}:
        raise ValueError("view must be songs, songIndex, artists, videos, vtubers, or vsingerSongs")
    if q and view in {"songs", "songIndex", "artists", "vsingerSongs"} and effective_search_scope in {"source", "video", "channel"}:
        return source_matched_rankings_payload(db_path, range_id, view, metric, q, effective_search_scope, page, page_size, min_count, search_fields)
    base_where = ["range_id = ?", "view = ?", "metric = ?", "scope_key = 'all'"]
    base_params: list[object] = [range_id, view, metric]
    where = list(base_where)
    params = list(base_params)
    if min_count > 1 and view not in {"videos", "vtubers"}:
        column = "video_count" if metric == "videos" else "count"
        where.append(f"{column} >= ?")
        params.append(min_count)
    if q:
        clause, values = search_filter_for_view(view, q, effective_search_scope)
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
            f"SELECT COUNT(*) AS total_count, COALESCE(SUM(count), 0) AS total_occurrences, COALESCE(SUM(song_count), 0) AS total_songs, COALESCE(SUM(video_count), 0) AS total_videos FROM ranking_rows WHERE {where_sql}",
            params,
        ).fetchone()
        total = totals["total_count"]
        order_sql = f"{'video_count' if metric == 'videos' else 'count'} DESC, rank ASC" if q else "rank"
        rows = conn.execute(
            f"""
            SELECT rank, detail_key, title, artist, name, count, song_count, video_count, timestamp_count, payload_json
            FROM ranking_rows
            WHERE {where_sql}
            ORDER BY {order_sql}
            LIMIT ? OFFSET ?
            """,
            [*params, page_size, offset],
        ).fetchall()
        records = [decode_row(row) for row in rows]
    return {
        "schemaVersion": 1,
        "rangeId": range_id,
        "view": view,
        "metric": response_metric(metric),
        "searchScope": effective_search_scope,
        "searchFields": search_fields if search_fields is not None else search_fields_for_scope(effective_search_scope),
        "page": max(1, page),
        "pageSize": page_size,
        "totalCount": total,
        "filteredBaseCount": base_total,
        "totalOccurrenceCount": totals["total_occurrences"],
        "totalSongCount": totals["total_songs"],
        "totalVideoCount": totals["total_videos"],
        "pageCount": (total + page_size - 1) // page_size,
        "records": records,
    }


def source_matched_rankings_payload(
    db_path: Path,
    range_id: str,
    view: str,
    metric: str,
    q: str,
    search_scope: str,
    page: int,
    page_size: int,
    min_count: int,
    search_fields: list[str] | None = None,
) -> dict:
    base_where = ["r.range_id = ?", "r.view = ?", "r.metric = ?", "r.scope_key = 'all'", "r.detail_key != ''"]
    base_params: list[object] = [range_id, view, metric]
    source_clause, source_values = source_occurrence_filter(q, search_scope)
    candidate_where = list(base_where)
    candidate_params = list(base_params)
    if search_scope == "all":
        candidate_clause, candidate_values = search_filter_for_view(view, q, "all")
        candidate_where.append(candidate_clause)
        candidate_params.extend(candidate_values)
    matched_params = [*candidate_params, *source_values]
    having = ""
    if min_count > 1 and view not in {"videos", "vtubers"}:
        having = "HAVING matched_videos >= ?" if metric == "videos" else "HAVING matched_count >= ?"
        matched_params.append(min_count)
    matched_sql = f"""
        SELECT
          r.row_id, r.rank, r.detail_key, r.title, r.artist, r.name, r.count, r.song_count,
          r.video_count, r.timestamp_count, r.payload_json,
          sd.source_key AS matched_source_key,
          COUNT(*) AS matched_count,
          COUNT(DISTINCT COALESCE(NULLIF(so.video_id, ''), 'position:' || so.position)) AS matched_videos,
          MIN(so.position) AS first_match_position
        FROM (
          SELECT *
          FROM ranking_rows r
          WHERE {" AND ".join(candidate_where)}
        ) r
        JOIN source_details sd
          ON sd.range_id = r.range_id
         AND sd.entity_key = r.detail_key
        JOIN source_occurrences so
          ON so.range_id = r.range_id
         AND so.source_key = sd.source_key
        WHERE {source_clause}
        GROUP BY r.row_id
        {having}
    """
    offset = (max(1, page) - 1) * page_size
    with connect(db_path) as conn:
        base_total = conn.execute(
            "SELECT COUNT(*) AS total_count FROM ranking_rows WHERE range_id = ? AND view = ? AND metric = ? AND scope_key = 'all'",
            base_params,
        ).fetchone()["total_count"]
        totals = conn.execute(
            f"""
            SELECT
              COUNT(*) AS total_count,
              COALESCE(SUM(matched_count), 0) AS total_occurrences,
              COALESCE(SUM(song_count), 0) AS total_songs,
              COALESCE(SUM(matched_videos), 0) AS total_videos
            FROM ({matched_sql}) matched
            """,
            matched_params,
        ).fetchone()
        order_column = "matched_videos" if metric == "videos" else "matched_count"
        rows = conn.execute(
            f"""
            SELECT *
            FROM ({matched_sql}) matched
            ORDER BY {order_column} DESC, rank ASC, first_match_position ASC
            LIMIT ? OFFSET ?
            """,
            [*matched_params, page_size, offset],
        ).fetchall()
        records = [
            decode_source_matched_row(conn, row, q, search_scope)
            for row in rows
        ]
    total = totals["total_count"]
    return {
        "schemaVersion": 1,
        "rangeId": range_id,
        "view": view,
        "metric": response_metric(metric),
        "searchScope": search_scope,
        "searchFields": search_fields if search_fields is not None else search_fields_for_scope(search_scope),
        "page": max(1, page),
        "pageSize": page_size,
        "totalCount": total,
        "filteredBaseCount": base_total,
        "totalOccurrenceCount": totals["total_occurrences"],
        "totalSongCount": totals["total_songs"],
        "totalVideoCount": totals["total_videos"],
        "pageCount": (total + page_size - 1) // page_size,
        "records": records,
    }


def source_occurrence_filter(query: str, scope: str) -> tuple[str, list[str]]:
    groups = parse_search_groups(query)
    if not groups:
        return "1 = 1", []
    if scope == "channel":
        fields = ["lower(so.channel_name)", "lower(so.search_text)"]
    elif scope == "video":
        fields = ["lower(so.title)", "lower(so.video_id)", "lower(so.search_text)"]
    else:
        fields = ["lower(so.search_text)"]
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


def decode_source_matched_row(conn: sqlite3.Connection, row: sqlite3.Row, query: str, search_scope: str) -> dict:
    record = decode_row(row)
    matched_occurrences = matched_source_occurrences(conn, row["matched_source_key"], query, search_scope, 20)
    matched_count = int(row["matched_count"] or 0)
    matched_videos = int(row["matched_videos"] or 0)
    record["globalCount"] = record.get("count", 0)
    record["globalVideoCount"] = record.get("videoCount", 0)
    record["globalTimestampCount"] = record.get("timestampCount", record.get("count", 0))
    record["count"] = matched_count
    record["timestampCount"] = matched_count
    record["videoCount"] = matched_videos
    record["matchedBySource"] = True
    record["sourceFilterQuery"] = query
    record["occurrences"] = [json.loads(occurrence["payload_json"]) for occurrence in matched_occurrences]
    record["occurrencePreviewLimited"] = matched_count > len(record["occurrences"])
    return record


def decode_all_field_matched_row(conn: sqlite3.Connection, row: sqlite3.Row, query: str, range_id: str) -> dict:
    record = decode_row(row)
    source_key_row = conn.execute(
        "SELECT source_key FROM source_details WHERE range_id = ? AND entity_key = ? LIMIT 1",
        (range_id, row["detail_key"]),
    ).fetchone()
    source_key = source_key_row["source_key"] if source_key_row else ""
    if not source_key:
        return record
    matched_occurrences = matched_source_occurrences(conn, source_key, query, "all", 20)
    if not matched_occurrences:
        return record
    source_clause, source_values = source_occurrence_filter(query, "all")
    matched_count_row = conn.execute(
        f"""
        SELECT
          COUNT(*) AS matched_count,
          COUNT(DISTINCT COALESCE(NULLIF(so.video_id, ''), 'position:' || so.position)) AS matched_videos
        FROM source_occurrences so
        WHERE so.source_key = ?
          AND {source_clause}
        """,
        [source_key, *source_values],
    ).fetchone()
    matched_count = int(matched_count_row["matched_count"] or 0)
    matched_videos = int(matched_count_row["matched_videos"] or 0)
    record["globalCount"] = record.get("count", 0)
    record["globalVideoCount"] = record.get("videoCount", 0)
    record["globalTimestampCount"] = record.get("timestampCount", record.get("count", 0))
    record["count"] = matched_count
    record["timestampCount"] = matched_count
    record["videoCount"] = matched_videos
    record["matchedBySource"] = True
    record["sourceFilterQuery"] = query
    record["occurrences"] = [json.loads(occurrence["payload_json"]) for occurrence in matched_occurrences]
    record["occurrencePreviewLimited"] = matched_count > len(record["occurrences"])
    return record


def matched_source_occurrences(
    conn: sqlite3.Connection,
    source_key: str,
    query: str,
    search_scope: str,
    limit: int,
) -> list[sqlite3.Row]:
    clause, values = source_occurrence_filter(query, search_scope)
    return conn.execute(
        f"""
        SELECT payload_json, video_id
        FROM source_occurrences so
        WHERE so.source_key = ?
          AND {clause}
        ORDER BY position
        LIMIT ?
        """,
        [source_key, *values, limit],
    ).fetchall()


def normalize_metric(view: str, metric: str) -> str:
    metric = (metric or "count").strip()
    if view in {"songs", "artists", "vtubers"}:
        if metric in {"count", "occurrences"}:
            return "count"
        if metric == "videos":
            return "videos"
        if view == "vtubers" and metric == "songs":
            return "songs"
        raise ValueError("metric must be occurrences, songs, or videos")
    return "count"


def response_metric(metric: str) -> str:
    if metric == "videos":
        return "videos"
    if metric == "songs":
        return "songs"
    return "occurrences"


def normalize_search_scope(scope: str) -> str:
    value = (scope or "all").strip().lower().replace("_", "-")
    aliases = {
        "": "all",
        "all": "all",
        "any": "all",
        "full": "all",
        "song": "song",
        "songs": "song",
        "entity": "entity",
        "title": "title",
        "artist": "artist",
        "artists": "artist",
        "singer": "artist",
        "channel": "channel",
        "channels": "channel",
        "vtuber": "channel",
        "video": "video",
        "videos": "video",
        "source": "source",
        "sources": "source",
    }
    if value not in aliases:
        raise ValueError("searchScope must be all, song, entity, title, artist, channel, video, or source")
    return aliases[value]


def normalize_search_fields(value: str) -> list[str] | None:
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    if text.lower() in {"all", "any", "*"}:
        return []
    result: list[str] = []
    for raw_field in re.split(r"[,| ]+", text):
        field = raw_field.strip().lower().replace("_", "-")
        if not field:
            continue
        aliases = {
            "title": "title",
            "song": "title",
            "name": "title",
            "artist": "artist",
            "artists": "artist",
            "singer": "artist",
            "channel": "channel",
            "channels": "channel",
            "vtuber": "channel",
            "video": "video",
            "videos": "video",
            "source": "source",
            "sources": "source",
        }
        if field not in aliases:
            raise ValueError("searchFields must contain title, artist, channel, video, or source")
        normalized = aliases[field]
        if normalized not in result:
            result.append(normalized)
    return result


def search_scope_from_fields(fields: list[str] | None) -> str:
    if fields is None:
        return "all"
    if not fields:
        return "source"
    if fields == ["title"]:
        return "title"
    if fields == ["artist"]:
        return "artist"
    if fields == ["channel"]:
        return "channel"
    if fields == ["video"]:
        return "video"
    if fields == ["source"]:
        return "source"
    if set(fields) == {"title", "artist"}:
        return "song"
    if any(field in {"channel", "video", "source"} for field in fields):
        return "source"
    return "all"


def search_fields_for_scope(scope: str) -> list[str]:
    if scope == "title":
        return ["title"]
    if scope == "artist":
        return ["artist"]
    if scope == "song":
        return ["title", "artist"]
    return []


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
        "channel": ["lower(search_text)", "lower(name)"],
        "video": ["lower(search_text)", "lower(title)"],
        "source": ["lower(search_text)"],
    }[scope]
    if scope == "all" and view in {"songs", "songIndex", "artists", "vsingerSongs"}:
        candidates = ["lower(title)", "lower(artist)", "lower(name)"]
    if view == "artists" and scope in {"song", "title"}:
        candidates = ["lower(name)"]
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
        "channel_metadata",
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
