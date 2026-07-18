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
                    self.send_json(HTTPStatus.OK, source_payload(db_path, key))
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
    if view not in {"songs", "songIndex", "artists", "videos", "vsingerSongs"}:
        raise ValueError("view must be songs, songIndex, artists, videos, or vsingerSongs")

    base_where = ["range_id = ?", "view = ?", "metric = ?", "scope_key = 'all'"]
    base_params: list[object] = [range_id, view, metric]
    where = list(base_where)
    params = list(base_params)
    if min_count > 1 and view != "videos":
        column = "video_count" if metric == "videos" else "count"
        where.append(f"{column} >= ?")
        params.append(min_count)
    if q:
        needle = f"%{q.lower()}%"
        where.append("(lower(search_text) LIKE ? OR lower(title) LIKE ? OR lower(artist) LIKE ? OR lower(name) LIKE ?)")
        params.extend([needle, needle, needle, needle])
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
    if view in {"songs", "artists"}:
        if metric in {"count", "occurrences"}:
            return "count"
        if metric == "videos":
            return "videos"
        raise ValueError("metric must be occurrences or videos")
    return "count"


def source_payload(db_path: Path, key: str) -> dict:
    if not key:
        raise ValueError("source key is required")
    with connect(db_path) as conn:
        row = conn.execute("SELECT payload_json FROM source_details WHERE source_key = ?", (key,)).fetchone()
        occurrence_rows = conn.execute(
            "SELECT payload_json FROM source_occurrences WHERE source_key = ? ORDER BY position",
            (key,),
        ).fetchall()
    if row is None:
        return {"schemaVersion": 1, "found": False, "sourceKey": key}
    record = json.loads(row["payload_json"])
    record["occurrences"] = [json.loads(occurrence["payload_json"]) for occurrence in occurrence_rows]
    return {"schemaVersion": 1, "found": True, "sourceKey": key, "record": record}


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
