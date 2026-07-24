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
import unicodedata
from urllib.parse import parse_qs, unquote, urlparse


DEFAULT_DB_PATH = Path("artifacts/runtime/song-rank.sqlite")
MAX_RUNTIME_PAGE_SIZE = 200
MAX_RUNTIME_SEARCH_PAGE_SIZE = 50


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
    conn.execute("PRAGMA temp_store=MEMORY")
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
    q = first(query, "q", "").strip()
    page = parse_int(first(query, "page", "1"), "page")
    page_size_limit = MAX_RUNTIME_SEARCH_PAGE_SIZE if q else MAX_RUNTIME_PAGE_SIZE
    page_size = min(page_size_limit, max(1, parse_int(first(query, "pageSize", "50"), "pageSize")))
    validate_search_query(q)
    search_scope = normalize_search_scope(first(query, "searchScope", first(query, "searchField", "all")))
    search_fields = normalize_search_fields(first(query, "searchFields", ""))
    effective_search_scope = search_scope_from_fields(search_fields) if search_fields is not None and search_scope == "all" else search_scope
    ranking_search_scope = ranking_search_scope_for_source_fields(effective_search_scope, search_fields)
    metric = normalize_metric(view, first(query, "metric", "count"))
    min_count = max(1, parse_int(first(query, "minCount", "1"), "minCount"))
    niche_only = parse_bool(first(query, "nicheOnly", "0"), "nicheOnly")
    hide_unknown_artist = parse_bool(first(query, "hideUnknownArtist", "0"), "hideUnknownArtist")
    if range_id not in {"7d", "all"}:
        raise ValueError("range must be 7d or all")
    if view not in {"songs", "songIndex", "artists", "videos", "vtubers", "vsingerSongs"}:
        raise ValueError("view must be songs, songIndex, artists, videos, vtubers, or vsingerSongs")
    if q and view in {"songs", "songIndex", "vsingerSongs"} and effective_search_scope == "channel":
        source_payload = source_matched_rankings_payload(
            db_path,
            range_id,
            view,
            metric,
            q,
            "channel",
            page,
            page_size,
            min_count,
            search_fields,
            niche_only,
            hide_unknown_artist,
        )
        if source_payload["totalCount"] > 0:
            return source_payload
        with connect(db_path) as conn:
            base_total = base_total_for_view(conn, range_id, view, metric)
            return vtuber_song_fallback_payload(
                conn,
                range_id,
                q,
                view,
                page,
                page_size,
                min_count,
                base_total,
                "channel",
                search_fields,
                niche_only,
                hide_unknown_artist,
            )
    if q and view in {"songs", "songIndex", "artists", "vsingerSongs"} and effective_search_scope in {
        "source",
        "video",
        "channel",
    } and ranking_search_scope == effective_search_scope:
        return source_matched_rankings_payload(
            db_path, range_id, view, metric, q, effective_search_scope, page, page_size,
            min_count, search_fields, niche_only, hide_unknown_artist,
        )
    base_where = ["range_id = ?", "view = ?", "metric = ?", "scope_key = 'all'"]
    base_params: list[object] = [range_id, view, metric]
    where = list(base_where)
    params = list(base_params)
    filter_where, filter_params = ranking_filter_sql(view, niche_only, hide_unknown_artist)
    where.extend(filter_where)
    params.extend(filter_params)
    filtered_count_sql, filtered_song_count_sql, filtered_video_count_sql, filtered_timestamp_count_sql = ranking_row_count_sql(
        view, niche_only, hide_unknown_artist,
    )
    if min_count > 1 and view not in {"videos", "vtubers"}:
        column = filtered_video_count_sql if metric == "videos" else filtered_count_sql
        where.append(f"{column} >= ?")
        params.append(min_count)
    if q:
        clause, values = search_filter_for_view(view, q, ranking_search_scope)
        where.append(clause)
        params.extend(values)
    where_sql = " AND ".join(where)
    base_where_sql = " AND ".join(base_where)
    offset = (max(1, page) - 1) * page_size

    with connect(db_path) as conn:
        base_total = conn.execute(
            f"SELECT COUNT(*) AS total_count FROM ranking_rows r WHERE {base_where_sql}",
            base_params,
        ).fetchone()["total_count"]
        totals = conn.execute(
            f"SELECT COUNT(*) AS total_count, COALESCE(SUM({filtered_count_sql}), 0) AS total_occurrences, COALESCE(SUM({filtered_song_count_sql}), 0) AS total_songs, COALESCE(SUM({filtered_video_count_sql}), 0) AS total_videos FROM ranking_rows r WHERE {where_sql}",
            params,
        ).fetchone()
        total = totals["total_count"]
        if niche_only or hide_unknown_artist:
            order_column = filtered_video_count_sql if metric == "videos" else filtered_count_sql
            order_sql = f"{order_column} DESC, rank ASC"
        else:
            order_sql = f"{'video_count' if metric == 'videos' else 'count'} DESC, rank ASC" if q else "rank"
        rows = conn.execute(
            f"""
            SELECT rank, detail_key, title, artist, name,
              {filtered_count_sql} AS count,
              {filtered_song_count_sql} AS song_count,
              {filtered_video_count_sql} AS video_count,
              {filtered_timestamp_count_sql} AS timestamp_count,
              payload_json
            FROM ranking_rows r
            WHERE {where_sql}
            ORDER BY {order_sql}
            LIMIT ? OFFSET ?
            """,
            [*params, page_size, offset],
        ).fetchall()
        records = [
            decode_filtered_ranking_row(
                conn, row, range_id, view, niche_only, hide_unknown_artist,
            )
            for row in rows
        ]
        if (
            q
            and view == "songs"
            and metric == "count"
            and (effective_search_scope == "all" or is_mixed_entity_source_search_fields(search_fields))
            and total == 0
        ):
            if source_occurrence_matches_exist(
                conn, range_id, q, effective_search_scope, search_fields, niche_only, hide_unknown_artist,
            ):
                source_payload = source_matched_rankings_payload(
                    db_path,
                    range_id,
                    view,
                    metric,
                    q,
                    effective_search_scope,
                    page,
                    page_size,
                    min_count,
                    search_fields,
                    niche_only,
                    hide_unknown_artist,
                )
                if source_payload["totalCount"] > 0:
                    return source_payload
            vtuber_payload = vtuber_song_fallback_payload(
                conn, range_id, q, view, page, page_size, min_count, base_total,
                effective_search_scope, search_fields, niche_only, hide_unknown_artist,
            )
            if vtuber_payload["totalCount"] > 0:
                return vtuber_payload
            video_payload = video_song_fallback_payload(
                conn, range_id, q, view, page, page_size, min_count, base_total,
                effective_search_scope, search_fields, niche_only, hide_unknown_artist,
            )
            if video_payload["totalCount"] > 0:
                return video_payload
        if (
            q
            and view in {"songs", "songIndex"}
            and metric == "videos"
            and effective_search_scope in {"song", "title", "artist"}
            and search_fields in (["title", "artist"], ["title"], ["artist"])
            and total == 0
        ):
            return source_matched_rankings_payload(
                db_path,
                range_id,
                view,
                metric,
                q,
                "video",
                page,
                page_size,
                min_count,
                ["video"],
                niche_only,
                hide_unknown_artist,
            )
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


def vtuber_song_fallback_payload(
    conn: sqlite3.Connection,
    range_id: str,
    q: str,
    view: str,
    page: int,
    page_size: int,
    min_count: int,
    base_total: int,
    search_scope: str = "all",
    search_fields: list[str] | None = None,
    niche_only: bool = False,
    hide_unknown_artist: bool = False,
) -> dict:
    clause, values = search_filter_for_view("vtubers", q, search_scope)
    rows = conn.execute(
        f"""
        SELECT rank, detail_key, title, artist, name, count, song_count, video_count, timestamp_count, payload_json
        FROM ranking_rows
        WHERE range_id = ?
          AND view = 'vtubers'
          AND metric = 'count'
          AND scope_key = 'all'
          AND {clause}
        ORDER BY count DESC, rank ASC
        LIMIT 12
        """,
        [range_id, *values],
    ).fetchall()
    if niche_only or hide_unknown_artist:
        return filtered_vtuber_song_fallback_payload(
            conn,
            rows,
            range_id,
            q,
            view,
            page,
            page_size,
            min_count,
            base_total,
            search_scope,
            search_fields,
            niche_only,
            hide_unknown_artist,
        )
    songs_by_key: dict[str, dict] = {}
    total_videos = 0
    for row in rows:
        vtuber = decode_row(row)
        channel_name = vtuber.get("name") or vtuber.get("title") or row["name"] or ""
        channel_key = vtuber.get("channelId") or vtuber.get("channelHandle") or vtuber.get("key") or row["detail_key"] or channel_name
        match_terms = vtuber_fallback_match_terms(vtuber, row, q)
        total_videos += as_non_negative_int(vtuber.get("videoCount"))
        for song in vtuber.get("songs") or []:
            title = str(song.get("name") or song.get("title") or song.get("key") or "").strip()
            if not title:
                continue
            count = as_non_negative_int(song.get("count"))
            if count < min_count:
                continue
            key = compact_text(song.get("key") or title)
            record = songs_by_key.get(key)
            if record is None:
                record = {
                    "type": "song",
                    "key": key,
                    "title": title,
                    "displayArtist": "",
                    "artists": [],
                    "channels": [],
                    "occurrences": [],
                    "count": 0,
                    "videoCount": 0,
                    "timestampCount": 0,
                    "matchedByVtuber": True,
                    "sourceFilterQuery": q,
                    "searchText": compact_text(f"{title} {channel_name} {q}"),
                    "_channelMap": {},
                    "_matchTerms": [],
                }
                songs_by_key[key] = record
            record["count"] += count
            record["videoCount"] += as_non_negative_int(song.get("videoCount"))
            record["_matchTerms"].extend(match_terms)
            channel_map = record["_channelMap"]
            if channel_key:
                channel_entry = channel_map.setdefault(
                    channel_key,
                    {"key": channel_key, "name": channel_name, "count": 0},
                )
                channel_entry["count"] += count
    records = sorted(songs_by_key.values(), key=lambda item: (-item["count"], item["title"]))
    ranked_records: list[dict] = []
    previous_count: int | None = None
    current_rank = 0
    for index, record in enumerate(records):
        if record["count"] != previous_count:
            current_rank = index + 1
            previous_count = record["count"]
        record["rank"] = current_rank
        record["channels"] = sorted(
            record.pop("_channelMap").values(),
            key=lambda item: (-item["count"], item["name"]),
        )
        ranked_records.append(record)
    total = len(ranked_records)
    offset = (max(1, page) - 1) * page_size
    page_records = ranked_records[offset : offset + page_size]
    for record in page_records:
        enrich_vtuber_song_fallback_record(conn, range_id, record)
        record.pop("_matchTerms", None)
    return {
        "schemaVersion": 1,
        "rangeId": range_id,
        "view": view,
        "metric": response_metric("count"),
        "searchScope": search_scope,
        "searchFields": search_fields if search_fields is not None else search_fields_for_scope(search_scope),
        "page": max(1, page),
        "pageSize": page_size,
        "totalCount": total,
        "filteredBaseCount": base_total,
        "totalOccurrenceCount": sum(record["count"] for record in ranked_records),
        "totalSongCount": total,
        "totalVideoCount": total_videos,
        "pageCount": (total + page_size - 1) // page_size,
        "records": page_records,
    }


def filtered_vtuber_song_fallback_payload(
    conn: sqlite3.Connection,
    rows: list[sqlite3.Row],
    range_id: str,
    q: str,
    view: str,
    page: int,
    page_size: int,
    min_count: int,
    base_total: int,
    search_scope: str,
    search_fields: list[str] | None,
    niche_only: bool,
    hide_unknown_artist: bool,
) -> dict:
    songs_by_key: dict[str, dict] = {}
    global_counts: dict[str, int] = {}
    for row in rows:
        vtuber = decode_row(row)
        channel_name = str(vtuber.get("name") or vtuber.get("channelName") or row["name"] or "").strip()
        channel_key = str(
            vtuber.get("channelId")
            or vtuber.get("channelHandle")
            or vtuber.get("key")
            or row["detail_key"]
            or channel_name
        ).strip()
        canonical_titles: dict[str, str] = {}
        for song in vtuber.get("songs") or []:
            title = str(song.get("name") or song.get("title") or song.get("key") or "").strip()
            title_key = song_title_lookup_key(title)
            if not title_key:
                continue
            canonical_titles.setdefault(title_key, title)
            global_counts[compact_text(title)] = global_counts.get(compact_text(title), 0) + as_non_negative_int(song.get("count"))
        channel_clause, channel_params = vtuber_video_identity_sql(vtuber, row)
        if not channel_params:
            continue
        occurrence_filter, occurrence_filter_params = occurrence_scope_sql("o", niche_only, hide_unknown_artist)
        occurrence_rows = conn.execute(
            f"""
            SELECT
              o.title,
              o.artist,
              o.video_id,
              o.is_unknown_artist,
              COUNT(*) AS occurrence_count
            FROM occurrences o
            JOIN videos v ON v.video_id = o.video_id
            WHERE o.range_id = ?
              AND ({channel_clause})
              AND {occurrence_filter}
            GROUP BY o.title, o.artist, o.video_id, o.is_unknown_artist
            """,
            [range_id, *channel_params, *occurrence_filter_params],
        ).fetchall()
        for occurrence_row in occurrence_rows:
            raw_title = str(occurrence_row["title"] or "").strip()
            title = canonical_titles.get(song_title_lookup_key(raw_title), raw_title)
            if not title:
                continue
            key = compact_text(title)
            count = as_non_negative_int(occurrence_row["occurrence_count"])
            record = songs_by_key.get(key)
            if record is None:
                record = {
                    "type": "song",
                    "key": key,
                    "title": title,
                    "displayArtist": "",
                    "artists": {},
                    "channels": {},
                    "occurrences": [],
                    "count": 0,
                    "videoCount": 0,
                    "timestampCount": 0,
                    "matchedByVtuber": True,
                    "sourceFilterQuery": q,
                    "searchText": compact_text(f"{title} {channel_name} {q}"),
                    "_artistUnknown": {},
                    "_channelSelectors": [],
                    "_rawTitles": set(),
                    "_videoIds": set(),
                }
                songs_by_key[key] = record
            record["count"] += count
            record["timestampCount"] += count
            record["_rawTitles"].add(raw_title)
            record["_videoIds"].add(str(occurrence_row["video_id"] or ""))
            artist = str(occurrence_row["artist"] or "").strip()
            if artist:
                record["artists"][artist] = record["artists"].get(artist, 0) + count
                record["_artistUnknown"][artist] = bool(occurrence_row["is_unknown_artist"])
            if channel_key:
                channel = record["channels"].setdefault(
                    channel_key,
                    {"key": channel_key, "name": channel_name, "count": 0},
                )
                channel["count"] += count
            selector = (channel_clause, tuple(channel_params))
            if selector not in record["_channelSelectors"]:
                record["_channelSelectors"].append(selector)

    records = []
    for record in songs_by_key.values():
        if record["count"] < min_count:
            continue
        record["globalCount"] = global_counts.get(record["key"], record["count"])
        record["videoCount"] = len({video_id for video_id in record.pop("_videoIds") if video_id})
        artist_unknown = record.pop("_artistUnknown")
        record["artists"] = [
            {"key": compact_text(name), "name": name, "count": count}
            for name, count in sorted(
                record["artists"].items(),
                key=lambda item: (artist_unknown.get(item[0], False), -item[1], item[0]),
            )
        ]
        record["channels"] = sorted(
            record["channels"].values(),
            key=lambda item: (-item["count"], item["name"]),
        )
        if record["artists"]:
            record["displayArtist"] = record["artists"][0]["name"]
        records.append(record)
    records.sort(key=lambda item: (-item["count"], item["title"]))
    previous_count: int | None = None
    current_rank = 0
    for index, record in enumerate(records):
        if record["count"] != previous_count:
            current_rank = index + 1
            previous_count = record["count"]
        record["rank"] = current_rank
    total = len(records)
    offset = (max(1, page) - 1) * page_size
    page_records = records[offset : offset + page_size]
    for record in page_records:
        record["occurrences"] = filtered_vtuber_fallback_occurrences(
            conn,
            range_id,
            record["_rawTitles"],
            record["_channelSelectors"],
            niche_only,
            hide_unknown_artist,
        )
        record["occurrencePreviewLimited"] = record["count"] > len(record["occurrences"])
    for record in records:
        record.pop("_rawTitles", None)
        record.pop("_channelSelectors", None)
    return {
        "schemaVersion": 1,
        "rangeId": range_id,
        "view": view,
        "metric": response_metric("count"),
        "searchScope": search_scope,
        "searchFields": search_fields if search_fields is not None else search_fields_for_scope(search_scope),
        "page": max(1, page),
        "pageSize": page_size,
        "totalCount": total,
        "filteredBaseCount": base_total,
        "totalOccurrenceCount": sum(record["count"] for record in records),
        "totalSongCount": total,
        "totalVideoCount": sum(record["videoCount"] for record in records),
        "pageCount": (total + page_size - 1) // page_size,
        "records": page_records,
    }


def vtuber_video_identity_sql(vtuber: dict, row: sqlite3.Row) -> tuple[str, list[object]]:
    candidates = [
        ("v.channel_id", vtuber.get("channelId")),
        ("v.channel_handle", vtuber.get("channelHandle")),
        ("v.channel_name", vtuber.get("channelName")),
        ("v.channel_name", vtuber.get("name")),
        ("v.channel_name", row["name"]),
        ("v.channel_url", vtuber.get("channelUrl")),
        ("v.channel_url", vtuber.get("sourceUrl")),
    ]
    detail_key = str(row["detail_key"] or "").strip()
    if detail_key.lower().startswith("uc"):
        candidates.append(("v.channel_id", detail_key))
    elif detail_key.lstrip("/").startswith("@"):
        candidates.append(("v.channel_handle", detail_key))
    elif detail_key:
        candidates.append(("v.channel_name", detail_key))
    clauses: list[str] = []
    params: list[object] = []
    seen: set[tuple[str, str]] = set()
    for column, raw_value in candidates:
        value = str(raw_value or "").strip()
        identity = (column, compact_text(value))
        if not value or identity in seen:
            continue
        seen.add(identity)
        if column == "v.channel_handle":
            clauses.append("lower(trim(replace(v.channel_handle, '/', ''))) = lower(trim(replace(?, '/', '')))")
        else:
            clauses.append(f"lower(trim({column})) = lower(trim(?))")
        params.append(value)
    return " OR ".join(clauses) or "0 = 1", params


def filtered_vtuber_fallback_occurrences(
    conn: sqlite3.Connection,
    range_id: str,
    raw_titles: set[str],
    channel_selectors: list[tuple[str, tuple[object, ...]]],
    niche_only: bool,
    hide_unknown_artist: bool,
) -> list[dict]:
    titles = sorted(title for title in raw_titles if title)
    if not titles or not channel_selectors:
        return []
    title_placeholders = ",".join("?" for _ in titles)
    channel_sql = " OR ".join(f"({clause})" for clause, _ in channel_selectors)
    channel_params = [value for _, values in channel_selectors for value in values]
    occurrence_filter, occurrence_filter_params = occurrence_scope_sql("o", niche_only, hide_unknown_artist)
    rows = conn.execute(
        f"""
        SELECT o.payload_json
        FROM occurrences o
        JOIN videos v ON v.video_id = o.video_id
        WHERE o.range_id = ?
          AND o.title IN ({title_placeholders})
          AND ({channel_sql})
          AND {occurrence_filter}
        ORDER BY o.rowid
        LIMIT 20
        """,
        [range_id, *titles, *channel_params, *occurrence_filter_params],
    ).fetchall()
    return [client_occurrence_payload(json.loads(row["payload_json"])) for row in rows]


def video_song_fallback_payload(
    conn: sqlite3.Connection,
    range_id: str,
    q: str,
    view: str,
    page: int,
    page_size: int,
    min_count: int,
    base_total: int,
    search_scope: str = "all",
    search_fields: list[str] | None = None,
    niche_only: bool = False,
    hide_unknown_artist: bool = False,
) -> dict:
    clause, values = column_search_filter(q, ["lower(title)", "lower(detail_key)"])
    rows = conn.execute(
        f"""
        SELECT rank, detail_key, title, artist, name, count, song_count, video_count, timestamp_count, payload_json
        FROM ranking_rows
        WHERE range_id = ?
          AND view = 'videos'
          AND metric = 'count'
          AND scope_key = 'all'
          AND {clause}
        ORDER BY rank ASC
        LIMIT 500
        """,
        [range_id, *values],
    ).fetchall()
    filtered_occurrences_by_video = (
        filtered_video_fallback_occurrences(
            conn,
            range_id,
            [str(row["detail_key"] or "") for row in rows],
            niche_only,
            hide_unknown_artist,
        )
        if niche_only or hide_unknown_artist
        else None
    )
    songs_by_key: dict[str, dict] = {}
    for row in rows:
        video = decode_row(row)
        video_id = str(video.get("videoId") or row["detail_key"] or "").strip()
        item = {
            "videoId": video_id,
            "title": video.get("title") or row["title"] or "",
            "channelName": video.get("channelName") or row["name"] or "",
            "channelId": video.get("channelId") or "",
            "channelHandle": video.get("channelHandle") or "",
            "channelUrl": video.get("channelUrl") or video.get("sourceUrl") or "",
            "avatarUrl": video.get("avatarUrl") or video.get("channelAvatarUrl") or "",
            "sourceUrl": video.get("sourceUrl") or video.get("channelUrl") or "",
            "knownSourceType": video.get("knownSourceType") or "",
            "isCollected": video.get("isCollected") is True,
            "sourceGroups": video.get("sourceGroups") if isinstance(video.get("sourceGroups"), list) else [],
            "sourceQuality": video.get("sourceQuality") if isinstance(video.get("sourceQuality"), dict) else None,
            "thumbnailUrl": video.get("thumbnailUrl") or "",
            "publishedTimestamp": video.get("publishedTimestamp"),
            "publishedText": video.get("publishedText") or "",
        }
        if filtered_occurrences_by_video is None:
            occurrences = [
                {"item": item, "song": song, "videoId": video_id}
                for song in video.get("songs") or []
            ]
        else:
            occurrences = filtered_occurrences_by_video.get(video_id, [])
        for occurrence in occurrences:
            occurrence_item = occurrence.get("item") if isinstance(occurrence.get("item"), dict) else {}
            occurrence_item = {**item, **occurrence_item}
            song = occurrence.get("song") if isinstance(occurrence.get("song"), dict) else {}
            title = str(song.get("title") or song.get("name") or "").strip()
            if not title:
                continue
            artist = str(song.get("artist") or "").strip()
            key = compact_text(song.get("key") or f"{title}::{artist}")
            record = songs_by_key.get(key)
            if record is None:
                record = {
                    "type": "song",
                    "key": key,
                    "title": title,
                    "displayArtist": artist,
                    "artist": artist,
                    "artists": {},
                    "channels": {},
                    "occurrences": [],
                    "count": 0,
                    "videoCount": 0,
                    "timestampCount": 0,
                    "matchedBySource": True,
                    "sourceFilterQuery": q,
                    "searchText": compact_text(f"{title} {artist} {q}"),
                    "_videoIds": set(),
                }
                songs_by_key[key] = record
            record["count"] += 1
            record["timestampCount"] += 1
            record["_videoIds"].add(video_id)
            if artist:
                record["artists"][artist] = record["artists"].get(artist, 0) + 1
            channel_name = str(occurrence_item.get("channelName") or "").strip()
            if channel_name:
                record["channels"][channel_name] = record["channels"].get(channel_name, 0) + 1
            record["occurrences"].append(
                {
                    **occurrence,
                    "item": occurrence_item,
                    "song": song,
                    "videoId": video_id,
                }
            )
    records = [
        record
        for record in songs_by_key.values()
        if record["count"] >= min_count
    ]
    records.sort(key=lambda item: (-item["count"], item["title"]))
    previous_count: int | None = None
    current_rank = 0
    for index, record in enumerate(records):
        if record["count"] != previous_count:
            current_rank = index + 1
            previous_count = record["count"]
        record["rank"] = current_rank
        record["videoCount"] = len(record.pop("_videoIds"))
        record["artists"] = [
            {"key": compact_text(name), "name": name, "count": count}
            for name, count in sorted(record["artists"].items(), key=lambda item: (-item[1], item[0]))
        ]
        record["channels"] = [
            {"key": compact_text(name), "name": name, "count": count}
            for name, count in sorted(record["channels"].items(), key=lambda item: (-item[1], item[0]))
        ]
        if record["artists"]:
            record["displayArtist"] = record["artists"][0]["name"]
        record["occurrencePreviewLimited"] = len(record["occurrences"]) > 20
        record["occurrences"] = record["occurrences"][:20]
    total = len(records)
    offset = (max(1, page) - 1) * page_size
    page_records = records[offset : offset + page_size]
    return {
        "schemaVersion": 1,
        "rangeId": range_id,
        "view": view,
        "metric": response_metric("count"),
        "searchScope": search_scope,
        "searchFields": search_fields if search_fields is not None else search_fields_for_scope(search_scope),
        "page": max(1, page),
        "pageSize": page_size,
        "totalCount": total,
        "filteredBaseCount": base_total,
        "totalOccurrenceCount": sum(record["count"] for record in records),
        "totalSongCount": total,
        "totalVideoCount": sum(record["videoCount"] for record in records),
        "pageCount": (total + page_size - 1) // page_size,
        "records": page_records,
    }


def filtered_video_fallback_occurrences(
    conn: sqlite3.Connection,
    range_id: str,
    video_ids: list[str],
    niche_only: bool,
    hide_unknown_artist: bool,
) -> dict[str, list[dict]]:
    unique_video_ids = sorted({video_id for video_id in video_ids if video_id})
    if not unique_video_ids:
        return {}
    placeholders = ",".join("?" for _ in unique_video_ids)
    occurrence_filter, occurrence_filter_params = occurrence_scope_sql("o", niche_only, hide_unknown_artist)
    rows = conn.execute(
        f"""
        SELECT o.video_id, o.payload_json
        FROM occurrences o
        WHERE o.range_id = ?
          AND o.video_id IN ({placeholders})
          AND {occurrence_filter}
        ORDER BY o.rowid
        """,
        [range_id, *unique_video_ids, *occurrence_filter_params],
    ).fetchall()
    by_video: dict[str, list[dict]] = {}
    for row in rows:
        by_video.setdefault(str(row["video_id"] or ""), []).append(
            client_occurrence_payload(json.loads(row["payload_json"]))
        )
    return by_video


def base_total_for_view(conn: sqlite3.Connection, range_id: str, view: str, metric: str) -> int:
    return conn.execute(
        """
        SELECT COUNT(*) AS total_count
        FROM ranking_rows
        WHERE range_id = ?
          AND view = ?
          AND metric = ?
          AND scope_key = 'all'
        """,
        (range_id, view, metric),
    ).fetchone()["total_count"]


def column_search_filter(query: str, fields: list[str]) -> tuple[str, list[str]]:
    groups = parse_search_groups(query)
    if not groups or not fields:
        return "1 = 1", []
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


def vtuber_fallback_match_terms(vtuber: dict, row: sqlite3.Row, q: str) -> list[str]:
    raw_terms: list[object] = [
        q,
        row["detail_key"],
        row["title"],
        row["artist"],
        row["name"],
        vtuber.get("key"),
        vtuber.get("name"),
        vtuber.get("title"),
        vtuber.get("channelName"),
        vtuber.get("channelId"),
        vtuber.get("channelHandle"),
        vtuber.get("handle"),
        vtuber.get("channelUrl"),
        vtuber.get("sourceUrl"),
    ]
    aliases = vtuber.get("aliases")
    if isinstance(aliases, list):
        for alias in aliases:
            if isinstance(alias, dict):
                raw_terms.extend(alias.values())
            else:
                raw_terms.append(alias)
    terms: list[str] = []
    seen: set[str] = set()
    for raw_term in raw_terms:
        value = compact_text(raw_term)
        if not value:
            continue
        candidates = {value}
        if "youtube.com/" in value:
            candidates.add(value.rstrip("/").rsplit("/", 1)[-1])
        if value.startswith("/@"):
            candidates.add(value[1:])
            candidates.add(value[2:])
        elif value.startswith("@"):
            candidates.add(value[1:])
        for candidate in candidates:
            candidate = candidate.strip().lower()
            if len(candidate) < 3 or candidate in seen:
                continue
            seen.add(candidate)
            terms.append(candidate)
    return terms


def enrich_vtuber_song_fallback_record(conn: sqlite3.Connection, range_id: str, record: dict) -> None:
    match_terms = sorted({term for term in record.get("_matchTerms") or [] if isinstance(term, str) and len(term) >= 3})
    if not match_terms:
        return
    title_key = song_title_lookup_key(record.get("title") or "")
    if not title_key:
        return
    title_like = title_like_pattern_for_lookup(record.get("title") or "")
    candidate_rows = conn.execute(
        """
        SELECT r.detail_key, r.title, r.artist, r.count, r.video_count, r.timestamp_count, r.payload_json, sd.source_key
        FROM ranking_rows r
        LEFT JOIN source_details sd
          ON sd.range_id = r.range_id
         AND sd.entity_type = 'song'
         AND sd.entity_key = r.detail_key
        WHERE r.range_id = ?
          AND r.view = 'songs'
          AND r.metric = 'count'
          AND r.scope_key = 'all'
          AND (lower(r.title) = lower(?) OR lower(r.title) LIKE ? ESCAPE '\\')
        ORDER BY r.count DESC, r.rank ASC
        LIMIT 200
        """,
        (range_id, record.get("title") or "", title_like),
    ).fetchall()
    if not candidate_rows:
        return
    matched_occurrences: list[dict] = []
    artists: dict[str, int] = {}
    seen_occurrences: set[tuple[str, int, str, str]] = set()
    global_count = as_non_negative_int(record.get("count"))
    global_video_count = as_non_negative_int(record.get("videoCount"))
    global_timestamp_count = as_non_negative_int(record.get("timestampCount", record.get("count", 0)))
    for candidate in candidate_rows:
        if song_title_lookup_key(candidate["title"]) != title_key:
            continue
        source_key = candidate["source_key"]
        if not source_key:
            continue
        occurrence_rows = conn.execute(
            """
            SELECT payload_json
            FROM source_occurrences
            WHERE range_id = ?
              AND source_key = ?
            ORDER BY published_timestamp DESC, position ASC
            LIMIT 500
            """,
            (range_id, source_key),
        ).fetchall()
        candidate_matched = False
        for occurrence_row in occurrence_rows:
            occurrence = json.loads(occurrence_row["payload_json"])
            if not vtuber_fallback_occurrence_matches(occurrence, match_terms):
                continue
            candidate_matched = True
            item = occurrence.get("item") if isinstance(occurrence.get("item"), dict) else {}
            song = occurrence.get("song") if isinstance(occurrence.get("song"), dict) else {}
            video_id = str(item.get("videoId") or occurrence.get("videoId") or "").strip()
            seconds = as_non_negative_int(song.get("seconds") if song.get("seconds") is not None else occurrence.get("seconds"))
            dedupe_key = (
                video_id,
                seconds,
                compact_text(song.get("title") or record.get("title")),
                compact_text(song.get("artist") or candidate["artist"]),
            )
            if dedupe_key in seen_occurrences:
                continue
            seen_occurrences.add(dedupe_key)
            artist = str(song.get("artist") or candidate["artist"] or "").strip()
            if artist:
                artists[artist] = artists.get(artist, 0) + 1
            matched_occurrences.append(occurrence)
        if candidate_matched:
            global_count = max(global_count, as_non_negative_int(candidate["count"]))
            global_video_count = max(global_video_count, as_non_negative_int(candidate["video_count"]))
            global_timestamp_count = max(global_timestamp_count, as_non_negative_int(candidate["timestamp_count"]))
    if not matched_occurrences:
        return
    matched_occurrences.sort(
        key=lambda occurrence: (
            -as_non_negative_int((occurrence.get("item") if isinstance(occurrence.get("item"), dict) else {}).get("publishedTimestamp")),
            as_non_negative_int((occurrence.get("song") if isinstance(occurrence.get("song"), dict) else {}).get("seconds")),
        )
    )
    matched_video_count = len(
        {
            str((occurrence.get("item") if isinstance(occurrence.get("item"), dict) else {}).get("videoId") or occurrence.get("videoId") or "")
            for occurrence in matched_occurrences
        }
    )
    record["globalCount"] = global_count
    record["globalVideoCount"] = global_video_count
    record["globalTimestampCount"] = global_timestamp_count
    record["count"] = len(matched_occurrences)
    record["timestampCount"] = len(matched_occurrences)
    record["videoCount"] = matched_video_count
    record["matchedBySource"] = True
    record["occurrences"] = matched_occurrences[:20]
    record["occurrencePreviewLimited"] = len(matched_occurrences) > len(record["occurrences"])
    record["artists"] = [
        {"key": compact_text(name), "name": name, "count": count}
        for name, count in sorted(artists.items(), key=lambda item: (-item[1], item[0]))
    ]
    if record["artists"]:
        record["displayArtist"] = record["artists"][0]["name"]


def vtuber_fallback_occurrence_matches(occurrence: dict, match_terms: list[str]) -> bool:
    item = occurrence.get("item") if isinstance(occurrence.get("item"), dict) else {}
    values = [
        item.get("channelName"),
        item.get("channelId"),
        item.get("channelHandle"),
        item.get("handle"),
        item.get("channelUrl"),
        item.get("authorUrl"),
        item.get("ownerUrl"),
    ]
    compact_values = [compact_text(value) for value in values if value]
    if not compact_values:
        return False
    for value in compact_values:
        for term in match_terms:
            if value == term or term in value or value in term:
                return True
    return False


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
    niche_only: bool = False,
    hide_unknown_artist: bool = False,
) -> dict:
    base_where = ["r.range_id = ?", "r.view = ?", "r.metric = ?", "r.scope_key = 'all'", "r.detail_key != ''"]
    base_params: list[object] = [range_id, view, metric]
    candidate_where = list(base_where)
    candidate_params = list(base_params)
    filter_where, filter_params = ranking_filter_sql(view, niche_only, hide_unknown_artist)
    candidate_where.extend(filter_where)
    candidate_params.extend(filter_params)
    having = ""
    if min_count > 1 and view not in {"videos", "vtubers"}:
        having = "HAVING matched_videos >= ?" if metric == "videos" else "HAVING matched_count >= ?"
    offset = (max(1, page) - 1) * page_size
    with connect(db_path) as conn:
        source_rows_sql, source_values = source_occurrence_match_rows_sql(
            conn, range_id, q, search_scope, search_fields, niche_only, hide_unknown_artist,
        )
        source_entity_type = source_detail_entity_type_for_view(view)
        entity_clause, entity_values = search_filter_for_view(view, q, entity_source_search_scope_for_view(view))
        conn.execute("DROP TABLE IF EXISTS temp.matched_sources")
        conn.execute(
            """
            CREATE TEMP TABLE matched_sources(
              source_key TEXT PRIMARY KEY,
              matched_count INTEGER NOT NULL,
              matched_videos INTEGER NOT NULL,
              first_match_position INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            f"""
            INSERT INTO temp.matched_sources(source_key, matched_count, matched_videos, first_match_position)
            SELECT
              source_key,
              COUNT(*) AS matched_count,
              COUNT(DISTINCT COALESCE(NULLIF(video_id, ''), 'position:' || position)) AS matched_videos,
              MIN(position) AS first_match_position
            FROM ({source_rows_sql}) source_matches
            GROUP BY source_key
            """,
            source_values,
        )
        conn.execute("CREATE INDEX temp.idx_matched_sources_rank ON matched_sources(matched_count, matched_videos, first_match_position)")
        matched_sql = f"""
            SELECT
              MIN(r.row_id) AS row_id,
              MIN(r.rank) AS rank,
              r.detail_key,
              MIN(r.title) AS title,
              MIN(r.artist) AS artist,
              MIN(r.name) AS name,
              MIN(r.count) AS count,
              MIN(r.song_count) AS song_count,
              MIN(r.video_count) AS video_count,
              MIN(r.timestamp_count) AS timestamp_count,
              MIN(r.payload_json) AS payload_json,
              MIN(sd.source_key) AS matched_source_key,
              CASE WHEN {entity_clause} THEN 0 ELSE 1 END AS entity_match_order,
              SUM(ms.matched_count) AS matched_count,
              SUM(ms.matched_videos) AS matched_videos,
              MIN(ms.first_match_position) AS first_match_position
            FROM temp.matched_sources ms
            JOIN source_details sd
              ON sd.range_id = ?
             AND sd.entity_type = ?
             AND sd.source_key = ms.source_key
            JOIN ranking_rows r
              ON r.range_id = sd.range_id
             AND r.detail_key = sd.entity_key
            WHERE {" AND ".join(candidate_where)}
            GROUP BY r.row_id
            {having}
        """
        matched_params: list[object] = [*entity_values, range_id, source_entity_type, *candidate_params]
        if min_count > 1 and view not in {"videos", "vtubers"}:
            matched_params.append(min_count)
        base_filter_clauses, base_filter_params = ranking_filter_sql(view, niche_only, hide_unknown_artist)
        base_filter_sql = " AND ".join(base_filter_clauses) or "1 = 1"
        base_total = conn.execute(
            f"SELECT COUNT(*) AS total_count FROM ranking_rows r WHERE range_id = ? AND view = ? AND metric = ? AND scope_key = 'all' AND {base_filter_sql}",
            [*base_params, *base_filter_params],
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
        global_order_column = "video_count" if metric == "videos" else "count"
        rows = conn.execute(
            f"""
            SELECT *
            FROM ({matched_sql}) matched
            ORDER BY
              entity_match_order ASC,
              CASE WHEN entity_match_order = 0 THEN {global_order_column} ELSE {order_column} END DESC,
              rank ASC,
              first_match_position ASC
            LIMIT ? OFFSET ?
            """,
            [*matched_params, page_size, offset],
        ).fetchall()
        records = [
            decode_source_matched_row(conn, row, q, search_scope, search_fields, niche_only, hide_unknown_artist)
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


def source_detail_entity_type_for_view(view: str) -> str:
    if view == "artists":
        return "artist"
    if view == "videos":
        return "video"
    if view == "vtubers":
        return "vtuber"
    if view == "vsingerSongs":
        return "vsingerSong"
    return "song"


def entity_source_search_scope_for_view(view: str) -> str:
    if view == "artists":
        return "artist"
    return "song"


def source_occurrence_match_rows_sql(
    conn: sqlite3.Connection,
    range_id: str,
    query: str,
    scope: str,
    search_fields: list[str] | None = None,
    niche_only: bool = False,
    hide_unknown_artist: bool = False,
) -> tuple[str, list[object]]:
    fts_table = source_occurrence_fts_table(conn, query, scope, search_fields)
    if fts_table:
        source_filter, source_filter_values = source_occurrence_scope_sql(niche_only, hide_unknown_artist)
        return (
            f"""
            SELECT f.source_key, f.video_id, CAST(f.position AS INTEGER) AS position
            FROM {fts_table} f
            JOIN source_occurrences so
              ON so.source_key = f.source_key AND so.position = CAST(f.position AS INTEGER)
            WHERE f.range_id = ?
              AND {fts_table} MATCH ?
              AND {source_filter}
            """,
            [range_id, source_fts_match_query(query), *source_filter_values],
        )
    source_clause, source_values = source_occurrence_filter(query, scope, search_fields)
    source_filter, source_filter_values = source_occurrence_scope_sql(niche_only, hide_unknown_artist)
    return (
        f"""
        SELECT so.source_key, so.video_id, so.position
        FROM source_occurrences so
        WHERE so.range_id = ?
          AND {source_clause}
          AND {source_filter}
        """,
        [range_id, *source_values, *source_filter_values],
    )


def source_occurrence_matches_exist(
    conn: sqlite3.Connection,
    range_id: str,
    query: str,
    scope: str,
    search_fields: list[str] | None = None,
    niche_only: bool = False,
    hide_unknown_artist: bool = False,
) -> bool:
    source_rows_sql, source_values = source_occurrence_match_rows_sql(
        conn, range_id, query, scope, search_fields, niche_only, hide_unknown_artist,
    )
    row = conn.execute(
        f"SELECT 1 FROM ({source_rows_sql}) source_matches LIMIT 1",
        source_values,
    ).fetchone()
    return row is not None


def source_occurrence_fts_table(
    conn: sqlite3.Connection,
    query: str,
    scope: str,
    search_fields: list[str] | None = None,
) -> str:
    if not source_fts_match_query(query):
        return ""
    requested = set(search_fields or [])
    table = ""
    if (
        search_fields == []
        or (search_fields is None and scope == "all")
        or requested == {"source"}
        or is_mixed_entity_source_search_fields(search_fields)
        or (not requested and scope == "source")
    ):
        table = "source_occurrences_fts"
    elif requested == {"channel"} or (not requested and scope == "channel"):
        table = "source_occurrences_channel_fts"
    if not table or not sqlite_table_exists(conn, table):
        return ""
    return table


def source_fts_match_query(query: str) -> str:
    groups = parse_search_groups(query)
    if not groups:
        return ""
    fts_groups: list[str] = []
    for group in groups:
        terms = []
        for term in group:
            text = unicodedata.normalize("NFKC", term or "").strip().lower()
            if len(text) < 3:
                return ""
            terms.append(quote_fts_phrase(text))
        if terms:
            fts_groups.append(" ".join(terms))
    return " OR ".join(fts_groups)


def quote_fts_phrase(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def sqlite_table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ? LIMIT 1",
        (table,),
    ).fetchone()
    return row is not None


def source_occurrence_scope_sql(niche_only: bool, hide_unknown_artist: bool) -> tuple[str, list[object]]:
    return occurrence_scope_sql("so", niche_only, hide_unknown_artist)


def occurrence_scope_sql(alias: str, niche_only: bool, hide_unknown_artist: bool) -> tuple[str, list[object]]:
    clauses = []
    if niche_only:
        clauses.append(f"{alias}.is_niche = 1")
    if hide_unknown_artist:
        clauses.append(f"{alias}.is_unknown_artist = 0")
    return " AND ".join(clauses) or "1 = 1", []


def source_occurrence_filter(query: str, scope: str, search_fields: list[str] | None = None) -> tuple[str, list[str]]:
    groups = parse_search_groups(query)
    if not groups:
        return "1 = 1", []
    fields = source_occurrence_search_fields(scope, search_fields)
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


def source_occurrence_search_fields(scope: str, search_fields: list[str] | None = None) -> list[str]:
    if search_fields == []:
        return ["lower(so.search_text)"]
    requested = set(search_fields or [])
    if requested:
        fields: list[str] = []
        if any(field in requested for field in ("title", "artist")):
            fields.append("lower(so.search_text)")
        if "channel" in requested:
            fields.extend(["lower(so.channel_name)", "lower(so.channel_id)", "lower(so.channel_handle)", "lower(so.channel_url)"])
        if "video" in requested:
            fields.extend(["lower(so.title)", "lower(so.video_id)"])
        if "source" in requested:
            fields.append("lower(so.search_text)")
        return unique_fields(fields) or ["lower(so.search_text)"]
    if scope == "channel":
        return ["lower(so.channel_name)", "lower(so.channel_id)", "lower(so.channel_handle)", "lower(so.channel_url)"]
    if scope == "video":
        return ["lower(so.title)", "lower(so.video_id)"]
    return ["lower(so.search_text)"]


def decode_source_matched_row(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    query: str,
    search_scope: str,
    search_fields: list[str] | None = None,
    niche_only: bool = False,
    hide_unknown_artist: bool = False,
) -> dict:
    record = decode_row(row)
    matched_occurrences = matched_source_occurrences(
        conn, row["matched_source_key"], query, search_scope, 20, search_fields, niche_only, hide_unknown_artist,
    )
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
    search_fields: list[str] | None = None,
    niche_only: bool = False,
    hide_unknown_artist: bool = False,
) -> list[sqlite3.Row]:
    clause, values = source_occurrence_filter(query, search_scope, search_fields)
    source_filter, source_filter_values = source_occurrence_scope_sql(niche_only, hide_unknown_artist)
    return conn.execute(
        f"""
        SELECT payload_json, video_id
        FROM source_occurrences so
        WHERE so.source_key = ?
          AND {clause}
          AND {source_filter}
        ORDER BY position
        LIMIT ?
        """,
        [source_key, *values, *source_filter_values, limit],
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
        return "all"
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


def ranking_search_scope_for_source_fields(scope: str, fields: list[str] | None) -> str:
    if not is_mixed_entity_source_search_fields(fields):
        return scope
    entity_fields = [field for field in fields or [] if field in {"title", "artist"}]
    return search_scope_from_fields(entity_fields)


def is_mixed_entity_source_search_fields(fields: list[str] | None) -> bool:
    if not fields:
        return False
    requested = set(fields)
    return bool(requested & {"title", "artist"}) and bool(requested & {"channel", "video", "source"})


def unique_fields(fields: list[str]) -> list[str]:
    result: list[str] = []
    for field in fields:
        if field not in result:
            result.append(field)
    return result


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
    if scope == "all" and view in {"songs", "songIndex", "artists", "vsingerSongs"}:
        candidates = ["lower(title)", "lower(artist)", "lower(name)"]
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


def source_payload(db_path: Path, key: str, query: dict[str, list[str]] | None = None) -> dict:
    if not key:
        raise ValueError("source key is required")
    source_query = query or {}
    q = first(source_query, "q", "").strip()
    validate_search_query(q)
    niche_only = parse_bool(first(source_query, "nicheOnly", "0"), "nicheOnly")
    hide_unknown_artist = parse_bool(first(source_query, "hideUnknownArtist", "0"), "hideUnknownArtist")
    filter_active = niche_only or hide_unknown_artist
    use_paging = "page" in source_query or "pageSize" in source_query
    page = max(1, parse_int(first(source_query, "page", "1"), "page"))
    page_size_limit = MAX_RUNTIME_SEARCH_PAGE_SIZE if q else MAX_RUNTIME_PAGE_SIZE
    page_size = min(page_size_limit, max(1, parse_int(first(source_query, "pageSize", "50"), "pageSize")))
    with connect(db_path) as conn:
        row = conn.execute("SELECT payload_json FROM source_details WHERE source_key = ?", (key,)).fetchone()
        if use_paging:
            occurrence_rows, total_occurrences, total_videos, page = paged_source_occurrences(
                conn, key, q, page, page_size, niche_only, hide_unknown_artist,
            )
        else:
            occurrence_rows = all_source_occurrences(conn, key, q, niche_only, hide_unknown_artist)
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
    if q or use_paging or filter_active:
        record["sourceFilterQuery"] = q
        record["nicheOnly"] = niche_only
        record["hideUnknownArtist"] = hide_unknown_artist
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


def all_source_occurrences(
    conn: sqlite3.Connection,
    key: str,
    q: str,
    niche_only: bool = False,
    hide_unknown_artist: bool = False,
) -> list[sqlite3.Row]:
    source_filter, source_filter_values = source_occurrence_scope_sql(niche_only, hide_unknown_artist)
    if q:
        return conn.execute(
            """
            SELECT so.payload_json, so.video_id FROM source_occurrences so
            WHERE so.source_key = ? AND lower(so.search_text) LIKE ? AND {source_filter}
            ORDER BY position
            """.format(source_filter=source_filter),
            [key, f"%{q.lower()}%", *source_filter_values],
        ).fetchall()
    return conn.execute(
        f"SELECT so.payload_json, so.video_id FROM source_occurrences so WHERE so.source_key = ? AND {source_filter} ORDER BY so.position",
        [key, *source_filter_values],
    ).fetchall()


def paged_source_occurrences(
    conn: sqlite3.Connection,
    key: str,
    q: str,
    page: int,
    page_size: int,
    niche_only: bool = False,
    hide_unknown_artist: bool = False,
) -> tuple[list[sqlite3.Row], int, int, int]:
    group_expr = "COALESCE(NULLIF(video_id, ''), 'position:' || position)"
    source_filter, source_filter_values = source_occurrence_scope_sql(niche_only, hide_unknown_artist)
    where = ["so.source_key = ?", source_filter]
    params: list[object] = [key]
    if q:
        where.append("lower(so.search_text) LIKE ?")
        params.append(f"%{q.lower()}%")
    where_sql = " AND ".join(where)
    params.extend(source_filter_values)
    total_occurrences = conn.execute(
        f"SELECT COUNT(*) AS total_count FROM source_occurrences so WHERE {where_sql}",
        params,
    ).fetchone()["total_count"]
    total_videos = conn.execute(
        f"SELECT COUNT(*) AS total_count FROM (SELECT 1 FROM source_occurrences so WHERE {where_sql} GROUP BY {group_expr})",
        params,
    ).fetchone()["total_count"]
    page_count = max(1, (total_videos + page_size - 1) // page_size)
    page = min(page, page_count)
    offset = (page - 1) * page_size
    group_rows = conn.execute(
        f"""
        SELECT {group_expr} AS group_key
        FROM source_occurrences so
        WHERE {where_sql}
        GROUP BY group_key
        ORDER BY MIN(so.position)
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
        SELECT so.payload_json, so.video_id FROM source_occurrences so
        WHERE {where_sql}
        AND {group_expr} IN ({placeholders})
        ORDER BY so.position
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


def parse_bool(value: str, label: str) -> bool:
    normalized = (value or "").strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"", "0", "false", "no", "off"}:
        return False
    raise ValueError(f"{label} must be a boolean")


def validate_search_query(query: str) -> None:
    terms = [term for group in parse_search_groups(query) for term in group]
    if terms and all(
        len(unicodedata.normalize("NFKC", term).strip()) < 2
        and any(character.isalnum() for character in unicodedata.normalize("NFKC", term).strip())
        for term in terms
    ):
        raise ValueError("q terms must contain at least 2 characters")


def ranking_filter_sql(view: str, niche_only: bool, hide_unknown_artist: bool) -> tuple[list[str], list[object]]:
    clauses: list[str] = []
    if view in {"songs", "songIndex"}:
        if niche_only or hide_unknown_artist:
            occurrence_filter, _ = occurrence_scope_sql("o", niche_only, hide_unknown_artist)
            clauses.append(
                "EXISTS (SELECT 1 FROM occurrences o "
                "WHERE o.range_id = r.range_id AND o.title = r.title AND o.artist = r.artist "
                f"AND {occurrence_filter})"
            )
    elif view == "artists":
        if niche_only or hide_unknown_artist:
            occurrence_filter, _ = occurrence_scope_sql("o", niche_only, hide_unknown_artist)
            clauses.append(
                "EXISTS (SELECT 1 FROM occurrences o JOIN songs s ON s.song_key = o.song_key "
                "WHERE o.range_id = r.range_id AND lower(trim(s.artist)) = lower(trim(r.name)) "
                f"AND {occurrence_filter})"
            )
    elif view == "videos":
        if niche_only or hide_unknown_artist:
            occurrence_filter, _ = occurrence_scope_sql("o", niche_only, hide_unknown_artist)
            clauses.append(
                "EXISTS (SELECT 1 FROM occurrences o "
                "WHERE o.range_id = r.range_id AND o.video_id = r.detail_key "
                f"AND {occurrence_filter})"
            )
    elif view == "vtubers":
        if niche_only or hide_unknown_artist:
            occurrence_filter, _ = occurrence_scope_sql("o", niche_only, hide_unknown_artist)
            clauses.append(
                "EXISTS (SELECT 1 FROM occurrences o "
                "WHERE o.range_id = r.range_id AND "
                f"{vtuber_row_occurrence_match_sql('o', 'r')} AND {occurrence_filter})"
            )
    return clauses, []


def ranking_row_count_sql(
    view: str,
    niche_only: bool,
    hide_unknown_artist: bool,
) -> tuple[str, str, str, str]:
    if not (niche_only or hide_unknown_artist):
        return "r.count", "r.song_count", "r.video_count", "r.timestamp_count"
    occurrence_filter, _ = occurrence_scope_sql("o", niche_only, hide_unknown_artist)
    if view in {"songs", "songIndex"}:
        where_sql = f"o.range_id = r.range_id AND o.title = r.title AND o.artist = r.artist AND {occurrence_filter}"
        count_sql = f"(SELECT COUNT(*) FROM occurrences o WHERE {where_sql})"
        video_count_sql = f"(SELECT COUNT(DISTINCT o.video_id) FROM occurrences o WHERE {where_sql})"
        return count_sql, "r.song_count", video_count_sql, count_sql
    if view == "artists":
        where_sql = f"o.range_id = r.range_id AND lower(trim(s.artist)) = lower(trim(r.name)) AND {occurrence_filter}"
        count_sql = f"(SELECT COUNT(*) FROM occurrences o JOIN songs s ON s.song_key = o.song_key WHERE {where_sql})"
        song_count_sql = f"(SELECT COUNT(DISTINCT o.song_key) FROM occurrences o JOIN songs s ON s.song_key = o.song_key WHERE {where_sql})"
        video_count_sql = f"(SELECT COUNT(DISTINCT o.video_id) FROM occurrences o JOIN songs s ON s.song_key = o.song_key WHERE {where_sql})"
        return count_sql, song_count_sql, video_count_sql, count_sql
    if view == "videos":
        where_sql = f"o.range_id = r.range_id AND o.video_id = r.detail_key AND {occurrence_filter}"
        count_sql = f"(SELECT COUNT(*) FROM occurrences o WHERE {where_sql})"
        song_count_sql = f"(SELECT COUNT(DISTINCT o.song_key) FROM occurrences o WHERE {where_sql})"
        video_count_sql = f"(CASE WHEN {count_sql} > 0 THEN 1 ELSE 0 END)"
        return count_sql, song_count_sql, video_count_sql, count_sql
    if view == "vtubers":
        where_sql = f"o.range_id = r.range_id AND {vtuber_row_occurrence_match_sql('o', 'r')} AND {occurrence_filter}"
        count_sql = f"(SELECT COUNT(*) FROM occurrences o WHERE {where_sql})"
        song_count_sql = f"(SELECT COUNT(DISTINCT o.song_key) FROM occurrences o WHERE {where_sql})"
        video_count_sql = f"(SELECT COUNT(DISTINCT o.video_id) FROM occurrences o WHERE {where_sql})"
        return count_sql, song_count_sql, video_count_sql, count_sql
    return "r.count", "r.song_count", "r.video_count", "r.timestamp_count"


def vtuber_row_occurrence_match_sql(occurrence_alias: str, row_alias: str) -> str:
    return (
        f"(lower(trim(COALESCE(json_extract({occurrence_alias}.payload_json, '$.video.channelId'), ''))) = "
        f"lower(trim({row_alias}.detail_key)) OR "
        f"lower(trim(COALESCE(json_extract({occurrence_alias}.payload_json, '$.video.channelHandle'), ''))) = "
        f"lower(trim({row_alias}.detail_key)) OR "
        f"lower(trim(COALESCE(json_extract({occurrence_alias}.payload_json, '$.video.channelName'), ''))) = "
        f"lower(trim({row_alias}.name)))"
    )


def decode_filtered_ranking_row(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    range_id: str,
    view: str,
    niche_only: bool,
    hide_unknown_artist: bool,
) -> dict:
    record = decode_row(row)
    if not (niche_only or hide_unknown_artist):
        return record
    record["count"] = int(row["count"] or 0)
    record["songCount"] = int(row["song_count"] or 0)
    record["videoCount"] = int(row["video_count"] or 0)
    record["timestampCount"] = int(row["timestamp_count"] or 0)
    if view in {"songs", "songIndex"}:
        occurrences = filtered_occurrence_payloads(
            conn, range_id, row["detail_key"], "song", niche_only, hide_unknown_artist,
            title=row["title"], artist=row["artist"],
        )
        record["occurrences"] = occurrences[:20]
        record["occurrencePreviewLimited"] = len(occurrences) > len(record["occurrences"])
        record["channels"] = occurrence_channel_counts(occurrences)
    elif view == "videos":
        occurrences = filtered_occurrence_payloads(
            conn, range_id, row["detail_key"], "video_id", niche_only, hide_unknown_artist,
        )
        songs = []
        seen_song_keys: set[str] = set()
        for occurrence in occurrences:
            song = occurrence.get("song") if isinstance(occurrence.get("song"), dict) else {}
            title = str(song.get("title") or "").strip()
            artist = str(song.get("artist") or "").strip()
            song_key = compact_text(f"{title}::{artist}")
            if title and song_key not in seen_song_keys:
                seen_song_keys.add(song_key)
                songs.append(song)
        record["songs"] = songs
        record["songCount"] = len(songs)
    elif view in {"artists", "vtubers"}:
        key_column = "artist" if view == "artists" else "vtuber"
        occurrences = filtered_occurrence_payloads(
            conn,
            range_id,
            row["detail_key"],
            key_column,
            niche_only,
            hide_unknown_artist,
            artist=row["name"] if view == "artists" else "",
            channel_name=row["name"] if view == "vtubers" else "",
        )
        record["occurrences"] = occurrences[:20]
        record["occurrencePreviewLimited"] = len(occurrences) > len(record["occurrences"])
        record["songs"] = occurrence_song_counts(occurrences)
        record["songCount"] = len(record["songs"])
        if view == "artists":
            record["channels"] = occurrence_channel_counts(occurrences)
    return record


def filtered_occurrence_payloads(
    conn: sqlite3.Connection,
    range_id: str,
    key: str,
    key_column: str,
    niche_only: bool,
    hide_unknown_artist: bool,
    title: str = "",
    artist: str = "",
    channel_name: str = "",
) -> list[dict]:
    if key_column not in {"song", "artist", "video_id", "vtuber"}:
        raise ValueError("unsupported occurrence key column")
    occurrence_filter, _ = occurrence_scope_sql("o", niche_only, hide_unknown_artist)
    if key_column in {"song", "artist"}:
        from_sql = "occurrences o JOIN songs s ON s.song_key = o.song_key"
        if key_column == "song":
            from_sql = "occurrences o"
            key_clause = "o.title = ? AND o.artist = ?"
            key_params = (title, artist)
        else:
            key_clause = "lower(trim(s.artist)) = lower(trim(?))"
            key_params = (artist,)
    elif key_column == "video_id":
        from_sql = "occurrences o"
        key_clause = "o.video_id = ?"
        key_params = (key,)
    else:
        from_sql = "occurrences o"
        key_clause = (
            "(lower(trim(COALESCE(json_extract(o.payload_json, '$.video.channelId'), ''))) = lower(trim(?)) "
            "OR lower(trim(COALESCE(json_extract(o.payload_json, '$.video.channelHandle'), ''))) = lower(trim(?)) "
            "OR lower(trim(COALESCE(json_extract(o.payload_json, '$.video.channelName'), ''))) = lower(trim(?)))"
        )
        key_params = (key, key, channel_name)
    limit_sql = "LIMIT 21" if key_column == "song" else ""
    rows = conn.execute(
        f"""
        SELECT o.payload_json
        FROM {from_sql}
        WHERE o.range_id = ?
          AND {key_clause}
          AND {occurrence_filter}
        ORDER BY o.rowid
        {limit_sql}
        """,
        (range_id, *key_params),
    ).fetchall()
    return [client_occurrence_payload(json.loads(row["payload_json"])) for row in rows]


def occurrence_song_counts(occurrences: list[dict]) -> list[dict]:
    counts: dict[str, int] = {}
    for occurrence in occurrences:
        song = occurrence.get("song") if isinstance(occurrence.get("song"), dict) else {}
        name = str(song.get("title") or "").strip()
        if name:
            counts[name] = counts.get(name, 0) + 1
    return [
        {"name": name, "count": count}
        for name, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]


def client_occurrence_payload(payload: dict) -> dict:
    if isinstance(payload.get("item"), dict):
        return payload
    video = payload.get("video") if isinstance(payload.get("video"), dict) else {}
    song = payload.get("song") if isinstance(payload.get("song"), dict) else {}
    return {
        "rangeId": payload.get("rangeId", ""),
        "videoId": payload.get("videoId") or video.get("videoId", ""),
        "item": video,
        "song": song,
    }


def occurrence_channel_counts(occurrences: list[dict]) -> list[dict]:
    counts: dict[str, int] = {}
    for occurrence in occurrences:
        item = occurrence.get("item") if isinstance(occurrence.get("item"), dict) else occurrence.get("video")
        if not isinstance(item, dict):
            item = {}
        name = str(item.get("channelName") or "").strip()
        if name:
            counts[name] = counts.get(name, 0) + 1
    return [
        {"name": name, "count": count}
        for name, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]


def as_non_negative_int(value: object) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def compact_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def song_title_lookup_key(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    return re.sub(r"[\s._:：・･/\\\-ー—–~〜～!！?？()[\]【】「」『』\"'“”‘’]+", "", text)


def title_like_pattern_for_lookup(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    tokens = [
        token
        for token in re.split(r"[\s._:：・･/\\\-ー—–~〜～!！?？()[\]【】「」『』\"'“”‘’]+", text)
        if token
    ]
    if not tokens:
        return "%"
    return "%" + "%".join(escape_like_value(token) for token in tokens) + "%"


def escape_like_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


if __name__ == "__main__":
    sys.exit(main())
