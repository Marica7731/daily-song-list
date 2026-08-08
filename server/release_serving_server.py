"""Thin immutable release-serving API for the WDC shadow host.

Serves the versioned ranking read model that the Mac/GitHub release chain
materializes (see build-release-bundle.py).  It reads only local immutable
release files under releases/<content_sha256>/; it never contacts a
database and never recomputes a ranking.

Ranking pagination is correct by construction: the release bundle freezes
200-record chunks, and the server slices the requested user page
(pageSize=20/30) out of those chunks.  Responses are cached in-process
(bounded, keyed by content SHA) so a repeat request never re-decompresses
and re-serializes the same immutable file.

Endpoints:
  /healthz                      local release readiness
  /api/meta                     active release identity + counts + capabilities
  /api/rankings                 versioned compact pages (range/view/metric/page/pageSize)
  /api/sources/<key>            local serving.sqlite when present, else old-site proxy (transitional)
  /api/thumbnails/...           YouTube origin relay (allowlisted, cached)

The `current` release is selected by releases/current -> <sha> symlink or a
meta/current.json pointer written atomically at activation time.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import threading
import time
import uuid
from collections import OrderedDict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlencode, urlparse

import http.client
import socket
import sys

REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,96}$")
SUPPORTED_RANGES = {"all", "7d"}
SUPPORTED_VIEWS = {"songs", "vtubers", "videos"}
SUPPORTED_METRICS = {"occurrences", "songs", "videos"}
METRIC_ALIASES = {"count": "occurrences"}
MAX_PAGE_SIZE = 200
CHUNK_SIZE = 200

# In-process cache bounds (hard caps, never unbounded).
CACHE_MAX_BYTES = 256 * 1024 * 1024   # 256 MiB total across both tiers
CACHE_MAX_ENTRIES = 2000
CHUNK_MAX_ENTRIES = 512

# Thumbnail relay: fixed YouTube origin, allowlisted qualities only.
THUMBNAIL_HOST = "i.ytimg.com"
THUMBNAIL_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
THUMBNAIL_QUALITY_ALLOWLIST = frozenset(
    {"default", "mqdefault", "hqdefault", "sddefault", "maxresdefault"}
)
THUMBNAIL_MAX_BYTES = 512 * 1024
THUMBNAIL_CONNECT_TIMEOUT = 3.0
THUMBNAIL_READ_TIMEOUT = 5.0
THUMBNAIL_CACHE_CONTROL = "public, max-age=86400, immutable"

# Old-origin fallback for /api/sources and search.  Disabled by default once
# a local serving.sqlite exists; kept only for the transitional shadow phase.
OLD_ORIGIN_HOST = "ytb-song-rank.culua.com"
SOURCE_PROXY_TIMEOUT = 5.0
SOURCE_FALLBACK_ENABLED = False  # flips to True only if serving.sqlite is absent


class _BoundedCache:
    """Thread-safe LRU cache with a hard byte/entry cap."""

    __slots__ = ("_entries", "_bytes", "_lock", "_max_bytes", "_max_entries")

    def __init__(self, max_bytes: int, max_entries: int):
        self._entries: OrderedDict[Any, Any] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()
        self._max_bytes = max_bytes
        self._max_entries = max_entries

    def get(self, key: Any) -> Any | None:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            self._entries.move_to_end(key)
            return entry

    def put(self, key: Any, value: Any, byte_size: int) -> None:
        with self._lock:
            previous = self._entries.pop(key, None)
            if previous is not None:
                self._bytes -= previous[1]
            self._entries[key] = (value, byte_size)
            self._bytes += byte_size
            while (
                len(self._entries) > self._max_entries
                or self._bytes > self._max_bytes
            ):
                _, evicted = self._entries.popitem(last=False)
                self._bytes -= evicted[1]


_CHUNK_CACHE = _BoundedCache(CACHE_MAX_BYTES, CHUNK_MAX_ENTRIES)
_RESPONSE_CACHE = _BoundedCache(CACHE_MAX_BYTES, CACHE_MAX_ENTRIES)
_SERIES_TOTAL_CACHE = _BoundedCache(1_048_576, 256)  # totalCount per (sha,range,view,metric)
_LOCK_REGISTRY: dict[tuple[Any, ...], threading.Lock] = {}
_LOCK_REGISTRY_GUARD = threading.Lock()


def _key_lock(key: tuple[Any, ...]) -> threading.Lock:
    """Return a per-key lock so concurrent MISSes build once (single flight)."""
    with _LOCK_REGISTRY_GUARD:
        lock = _LOCK_REGISTRY.get(key)
        if lock is None:
            lock = threading.Lock()
            _LOCK_REGISTRY[key] = lock
        return lock


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


class ReleaseStore:
    """Resolve the current immutable release and serve its files."""

    def __init__(self, releases_root: Path):
        self.releases_root = releases_root

    def current_sha(self) -> str | None:
        current_link = self.releases_root / "current"
        if current_link.is_symlink() or current_link.exists():
            try:
                resolved = current_link.resolve()
                if resolved.parent == self.releases_root and resolved.is_dir():
                    return resolved.name
            except (OSError, RuntimeError):
                pass
        meta_file = self.releases_root / "meta" / "current.json"
        if meta_file.exists():
            pointer = _json_object(json.loads(meta_file.read_text(encoding="utf-8")))
            sha = str(pointer.get("contentSha256") or "").strip()
            if sha and (self.releases_root / sha).is_dir():
                return sha
        return None

    def release_dir(self, sha: str) -> Path:
        return self.releases_root / sha

    def _chunk_records(
        self,
        sha: str,
        range_id: str,
        view: str,
        metric: str,
        chunk_page: int,
    ) -> list[dict[str, Any]] | None:
        """Parse one 200-record chunk (cached, single-flight)."""
        cache_key = (sha, range_id, view, metric, chunk_page)
        cached = _CHUNK_CACHE.get(cache_key)
        if cached is not None:
            return cached[0]
        lock = _key_lock(("chunk",) + cache_key)
        with lock:
            cached = _CHUNK_CACHE.get(cache_key)
            if cached is not None:
                return cached[0]
            page_path = (
                self.release_dir(sha)
                / "rankings" / range_id / view / metric / f"page-{chunk_page:04d}.json.gz"
            )
            if not page_path.exists():
                return None
            with gzip.open(page_path, "rt", encoding="utf-8") as stream:
                payload = json.load(stream)
            records = payload.get("records")
            if not isinstance(records, list):
                return None
            chunk_size = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
            _CHUNK_CACHE.put(cache_key, records, chunk_size)
            return records

    def _series_total(self, sha: str, range_id: str, view: str, metric: str) -> int:
        """True total record count for a (range/view/metric) series.

        The release chunks are 200-record pages frozen from the old API; the
        first chunk's payload carries the authoritative totalCount.  Using the
        chunk length here would report only 200 (or the tail chunk length) for
        multi-chunk series, breaking pageCount/totalCount on the client.
        """
        cache_key = (sha, range_id, view, metric)
        cached = _SERIES_TOTAL_CACHE.get(cache_key)
        if cached is not None:
            return cached[0]
        lock = _key_lock(("total",) + cache_key)
        with lock:
            cached = _SERIES_TOTAL_CACHE.get(cache_key)
            if cached is not None:
                return cached[0]
            page_path = (
                self.release_dir(sha)
                / "rankings" / range_id / view / metric / "page-0001.json.gz"
            )
            total = 0
            if page_path.exists():
                with gzip.open(page_path, "rt", encoding="utf-8") as stream:
                    payload = json.load(stream)
                total = int(payload.get("totalCount") or 0)
            _SERIES_TOTAL_CACHE.put(cache_key, total, 64)
            return total

    def rankings_page(
        self,
        range_id: str,
        view: str,
        metric: str,
        user_page: int,
        page_size: int,
    ) -> dict[str, Any] | None:
        """Slice a user page out of the 200-record chunks."""
        sha = self.current_sha()
        if not sha:
            return None
        start = (user_page - 1) * page_size
        end = start + page_size
        first_chunk = start // CHUNK_SIZE + 1
        last_chunk = (end - 1) // CHUNK_SIZE + 1
        records: list[dict[str, Any]] = []
        chunk1 = self._chunk_records(sha, range_id, view, metric, first_chunk)
        if chunk1 is None:
            return None
        records = list(chunk1)
        if last_chunk != first_chunk:
            chunk2 = self._chunk_records(sha, range_id, view, metric, last_chunk)
            if chunk2 is None:
                # Partial tail chunk already covers the request; tolerate.
                pass
            else:
                records.extend(chunk2)
        total = self._series_total(sha, range_id, view, metric)
        if total == 0:
            # Fall back to chunk length only when the series payload lacks a
            # totalCount (defensive; never let pageCount collapse to a chunk).
            total = len(chunk1) if last_chunk == first_chunk else len(records)
        sliced = records[start % CHUNK_SIZE: start % CHUNK_SIZE + page_size]
        page_count = max(1, (total + page_size - 1) // page_size)
        return {
            "schemaVersion": 1,
            "rangeId": range_id,
            "view": view,
            "metric": metric,
            "page": user_page,
            "pageSize": page_size,
            "totalCount": total,
            "pageCount": page_count,
            "records": sliced,
        }

    def meta(self) -> dict[str, Any]:
        sha = self.current_sha()
        if not sha:
            return {"error": "no_current_release", "message": "release pointer not ready"}
        meta_file = self.release_dir(sha) / "meta.json"
        manifest_file = self.release_dir(sha) / "manifest.json"
        meta = _json_object(json.loads(meta_file.read_text(encoding="utf-8"))) if meta_file.exists() else {}
        manifest = _json_object(json.loads(manifest_file.read_text(encoding="utf-8"))) if manifest_file.exists() else {}
        pages = manifest.get("pages")
        page_stats: dict[str, int] = {"pages": 0, "bytes": 0}
        if isinstance(pages, list):
            page_stats = {
                "pages": len(pages),
                "bytes": sum(int(p.get("bytes") or 0) for p in pages if isinstance(p, dict)),
            }
        serving_sqlite = (self.release_dir(sha) / "serving.sqlite").exists()
        return {
            "schemaVersion": 1,
            "meta": {
                "active_revision_id": meta.get("activeRevisionId", ""),
                "expected_parent_revision_id": meta.get("expectedParentRevisionId", ""),
                "source_commit_sha": meta.get("sourceCommitSha", ""),
                "content_sha256": sha,
                "generated_at": meta.get("generatedAt", ""),
                "latest_event_time": meta.get("latestEventTime", ""),
                "release_schema_version": meta.get("schemaVersion", 1),
            },
            "counts": {},
            "release": {"pages": page_stats["pages"], "bytes": page_stats["bytes"]},
            "capabilities": {
                "ranges": ["7d", "all"],
                "views": ["songs", "vtubers", "videos"],
                "metrics": ["occurrences", "songs", "videos"],
                "localSources": serving_sqlite,
                "localSearch": serving_sqlite,
            },
        }

    def health(self) -> dict[str, Any]:
        sha = self.current_sha()
        if not sha:
            return {"status": "degraded", "schemaVersion": 1, "currentRelease": None}
        meta_file = self.release_dir(sha) / "meta.json"
        meta = _json_object(json.loads(meta_file.read_text(encoding="utf-8"))) if meta_file.exists() else {}
        return {
            "status": "ok",
            "schemaVersion": 1,
            "currentRelease": sha,
            "activeRevisionId": meta.get("activeRevisionId", ""),
            "generatedAt": meta.get("generatedAt", ""),
        }


def _query_value(query: dict[str, list[str]], key: str) -> str:
    values = query.get(key) or []
    return str(values[0]).strip() if values else ""


def _int_query(query: dict[str, list[str]], key: str, default: int) -> int:
    value = _query_value(query, key)
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return default


def make_handler(store: ReleaseStore) -> Callable:
    def proxy_source(key: str, query: dict[str, list[str]]) -> dict[str, Any] | None:
        """Local serving.sqlite lookup; falls back to old-site proxy only when
        explicitly enabled (transitional)."""
        sha = store.current_sha()
        if sha:
            sqlite_path = store.release_dir(sha) / "serving.sqlite"
            if sqlite_path.exists():
                return _local_source_payload(sqlite_path, key, query)
        if not SOURCE_FALLBACK_ENABLED:
            return {"error": "source_unavailable", "message": "local serving store missing"}
        page = _int_query(query, "page", 1)
        page_size = min(200, _int_query(query, "pageSize", 20))
        range_id = _query_value(query, "range") or "all"
        path = f"/api/sources/{key}?page={page}&pageSize={page_size}&range={range_id}"
        connection = http.client.HTTPSConnection(OLD_ORIGIN_HOST, timeout=SOURCE_PROXY_TIMEOUT)
        try:
            connection.request("GET", path, headers={"User-Agent": "daily-song-list-wdc-shadow/1"})
            response = connection.getresponse()
            body = response.read()
            return json.loads(body)
        finally:
            connection.close()

    def proxy_search(query: dict[str, list[str]]) -> dict[str, Any] | None:
        """Local FTS when serving.sqlite present; else transitional proxy (if enabled)."""
        sha = store.current_sha()
        if sha:
            sqlite_path = store.release_dir(sha) / "serving.sqlite"
            if sqlite_path.exists():
                return _local_search_payload(sqlite_path, query)
        if not SOURCE_FALLBACK_ENABLED:
            return {"error": "search_unavailable", "message": "local search index missing"}
        params = {k: v[-1] for k, v in query.items() if v}
        path = "/api/rankings?" + urlencode(params)
        connection = http.client.HTTPSConnection(OLD_ORIGIN_HOST, timeout=SOURCE_PROXY_TIMEOUT)
        try:
            connection.request("GET", path, headers={"User-Agent": "daily-song-list-wdc-shadow/1"})
            response = connection.getresponse()
            body = response.read()
            return json.loads(body)
        finally:
            connection.close()

    class ReleaseHandler(BaseHTTPRequestHandler):
        server_version = "daily-song-list-release-serving/1"

        def do_GET(self) -> None:  # noqa: N802
            self._dispatch()

        def _send_json(
            self,
            status: HTTPStatus,
            payload: dict[str, Any],
            rid: str,
            started: float,
            cache: str = "MISS",
            release_sha: str = "",
            data_source: str = "local-release",
            server_timing: str = "",
        ) -> None:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
            self.send_response(int(status))
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("X-Request-Id", rid)
            self.send_header("Cache-Control", "public, max-age=300, must-revalidate" if status == HTTPStatus.OK else "no-store")
            self.send_header("X-Cache", cache)
            self.send_header("X-Duration-Ms", f"{(time.monotonic() - started) * 1000:.2f}")
            self.send_header("X-Data-Source", data_source)
            if release_sha:
                self.send_header("X-Release-Sha", release_sha)
            if server_timing:
                self.send_header("Server-Timing", server_timing)
            self.end_headers()
            self.wfile.write(body)

        def _dispatch(self) -> None:
            supplied = str(self.headers.get("X-Request-Id", "")).strip()
            rid = supplied if REQUEST_ID_RE.fullmatch(supplied) else uuid.uuid4().hex
            started = time.monotonic()
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query, keep_blank_values=True)
            try:
                if parsed.path == "/healthz":
                    payload = store.health()
                    status = HTTPStatus.OK if payload.get("status") == "ok" else HTTPStatus.SERVICE_UNAVAILABLE
                    self._send_json(status, payload, rid, started, data_source="local-release")
                    return
                if parsed.path == "/api/meta":
                    self._send_json(HTTPStatus.OK, store.meta(), rid, started, data_source="local-release")
                    return
                if parsed.path == "/api/rankings":
                    q = _query_value(query, "q")
                    if q:
                        payload = proxy_search(query)
                        if payload is None:
                            self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "search_unavailable"}, rid, started)
                            return
                        self._send_json(HTTPStatus.OK, payload, rid, started, data_source="local-search" if store.current_sha() and (store.release_dir(store.current_sha()) / "serving.sqlite").exists() else "old-origin-proxy")
                        return
                    range_id = _query_value(query, "range") or "all"
                    view = _query_value(query, "view") or "songs"
                    metric = _query_value(query, "metric") or "occurrences"
                    metric = METRIC_ALIASES.get(metric, metric)
                    user_page = _int_query(query, "page", 1)
                    requested_size = _int_query(query, "pageSize", 30)
                    if requested_size > MAX_PAGE_SIZE:
                        raise ValueError("pageSize exceeds bounded maximum")
                    if range_id not in SUPPORTED_RANGES:
                        raise ValueError("range must be 7d or all")
                    if view not in SUPPORTED_VIEWS:
                        raise ValueError("view must be songs, vtubers, or videos")
                    if metric not in SUPPORTED_METRICS:
                        raise ValueError("metric must be occurrences, songs, or videos")

                    # Cached final response (SHA-bound, never crosses releases).
                    sha = store.current_sha()
                    resp_key = ("resp", sha, range_id, view, metric, user_page, requested_size)
                    cached = _RESPONSE_CACHE.get(resp_key)
                    if cached is not None:
                        payload = cached[0]
                        self._send_json(HTTPStatus.OK, payload, rid, started, cache="HIT", release_sha=sha, data_source="local-release")
                        return
                    lock = _key_lock(resp_key)
                    with lock:
                        cached = _RESPONSE_CACHE.get(resp_key)
                        if cached is not None:
                            payload = cached[0]
                            self._send_json(HTTPStatus.OK, payload, rid, started, cache="HIT", release_sha=sha, data_source="local-release")
                            return
                        t0 = time.monotonic()
                        payload = store.rankings_page(range_id, view, metric, user_page, requested_size)
                        if payload is None:
                            self._send_json(HTTPStatus.NOT_FOUND, {"error": "release_page_missing"}, rid, started)
                            return
                        body_size = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
                        _RESPONSE_CACHE.put(resp_key, (payload,), body_size)
                        server_timing = f"lookup;dur={int((time.monotonic() - t0) * 1000)}"
                        self._send_json(HTTPStatus.OK, payload, rid, started, cache="MISS", release_sha=sha, data_source="local-release", server_timing=server_timing)
                    return
                if parsed.path.startswith("/api/sources/"):
                    key = parsed.path.removeprefix("/api/sources/")
                    if not key:
                        raise ValueError("source key is required")
                    payload = proxy_source(key, query)
                    if payload is None:
                        self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "source_unavailable"}, rid, started)
                        return
                    sha = store.current_sha()
                    local = bool(sha and (store.release_dir(sha) / "serving.sqlite").exists())
                    self._send_json(HTTPStatus.OK, payload, rid, started, data_source="local-release" if local else "old-origin-proxy", release_sha=sha or "")
                    return
                if parsed.path.startswith("/api/thumbnails/"):
                    self._send_thumbnail(parsed.path, rid, started)
                    return
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"}, rid, started)
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "bad_request", "message": str(exc)}, rid, started)
            except (socket.timeout, TimeoutError):
                self._send_json(HTTPStatus.GATEWAY_TIMEOUT, {"error": "source_timeout", "message": "upstream timed out"}, rid, started)
            except Exception:  # pragma: no cover - fixed public boundary
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "internal_error", "message": "request failed"}, rid, started)

        def _send_thumbnail(self, path: str, rid: str, started: float) -> None:
            m = re.fullmatch(
                r"/api/thumbnails/([A-Za-z0-9_-]{11})/(default|mqdefault|hqdefault|sddefault|maxresdefault)\.jpg",
                path,
            )
            if m is None:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "bad_request", "message": "thumbnail path is not allowlisted"}, rid, started)
                return
            video_id, quality = m.group(1), m.group(2)
            upstream_path = f"/vi/{video_id}/{quality}.jpg"
            connection = http.client.HTTPSConnection(THUMBNAIL_HOST, timeout=THUMBNAIL_CONNECT_TIMEOUT)
            try:
                if connection.sock is not None:
                    connection.sock.settimeout(THUMBNAIL_READ_TIMEOUT)
                connection.request("GET", upstream_path, headers={"User-Agent": "daily-song-list-wdc-shadow/1", "Accept": "image/*"})
                response = connection.getresponse()
                body = response.read(THUMBNAIL_MAX_BYTES + 1)
                if len(body) > THUMBNAIL_MAX_BYTES or response.status != HTTPStatus.OK:
                    self._send_json(HTTPStatus.BAD_GATEWAY, {"error": "thumbnail_upstream", "message": "thumbnail upstream error"}, rid, started)
                    return
                content_type = (response.getheader("Content-Type") or "image/jpeg").split(";")[0].strip()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", THUMBNAIL_CACHE_CONTROL)
                self.send_header("X-Request-Id", rid)
                self.end_headers()
                self.wfile.write(body)
            finally:
                connection.close()

    return ReleaseHandler


def _local_source_payload(sqlite_path: Path, key: str, query: dict[str, list[str]]) -> dict[str, Any] | None:
    """Read one source page from the local serving.sqlite (indexed, LIMIT/OFFSET)."""
    try:
        import sqlite3
    except ImportError:  # pragma: no cover
        return None
    if not sqlite_path.exists():
        return None
    page = _int_query(query, "page", 1)
    page_size = min(200, _int_query(query, "pageSize", 20))
    range_id = _query_value(query, "range") or "all"
    conn = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT total_count, video_count FROM source_summary WHERE range_id=? AND source_key=?",
            (range_id, key),
        ).fetchone()
        if row is None:
            return {"schemaVersion": 1, "found": False, "sourceKey": key}
        total = int(row["total_count"])
        page_count = max(1, (total + page_size - 1) // page_size)
        offset = (page - 1) * page_size
        rows = conn.execute(
            """
            SELECT o.payload_json
            FROM source_members s
            JOIN occurrences o ON o.occurrence_id = s.occurrence_id
            WHERE s.range_id=? AND s.source_key=?
            ORDER BY s.source_sort_key, o.occurrence_id
            LIMIT ? OFFSET ?
            """,
            (range_id, key, page_size, offset),
        ).fetchall()
        records = [json.loads(r["payload_json"]) for r in rows]
        return {
            "schemaVersion": 1,
            "found": True,
            "sourceKey": key,
            "page": page,
            "pageSize": page_size,
            "totalCount": total,
            "totalOccurrenceCount": total,
            "totalVideoCount": int(row["video_count"]),
            "pageCount": page_count,
            "records": records,
        }
    finally:
        conn.close()


def _local_search_payload(sqlite_path: Path, query: dict[str, list[str]]) -> dict[str, Any] | None:
    """SQLite FTS5 search over local serving.sqlite (bounded candidates)."""
    try:
        import sqlite3
    except ImportError:  # pragma: no cover
        return None
    q = _query_value(query, "q").strip()
    if not q or len(q) < 1:
        return None
    page = _int_query(query, "page", 1)
    page_size = min(200, _int_query(query, "pageSize", 30))
    conn = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        try:
            total = conn.execute(
                "SELECT count(*) AS c FROM search_fts WHERE search_fts MATCH ?",
                (f'"{q}"*',),
            ).fetchone()["c"]
        except sqlite3.OperationalError:
            return None
        page_count = max(1, (total + page_size - 1) // page_size)
        offset = (page - 1) * page_size
        rows = conn.execute(
            """
            SELECT f.entity_key, f.title, f.artist, f.channel
            FROM search_fts f
            WHERE search_fts MATCH ?
            ORDER BY rank
            LIMIT ? OFFSET ?
            """,
            (f'"{q}"*', page_size, offset),
        ).fetchall()
        records = [dict(r) for r in rows]
        return {
            "schemaVersion": 1,
            "rangeId": _query_value(query, "range") or "all",
            "view": _query_value(query, "view") or "songs",
            "metric": "occurrences",
            "page": page,
            "pageSize": page_size,
            "totalCount": total,
            "pageCount": page_count,
            "records": records,
        }
    finally:
        conn.close()


def make_server(host: str, port: int, backlog: int, store: ReleaseStore) -> ThreadingHTTPServer:
    class _ReleaseHTTPServer(ThreadingHTTPServer):
        daemon_threads = True

        def __init__(self) -> None:
            self.request_queue_size = max(16, int(backlog))
            super().__init__((host, port), make_handler(store))

    return _ReleaseHTTPServer()


def serve(releases_root: Path, host: str, port: int, backlog: int = 128) -> None:
    store = ReleaseStore(releases_root)
    server = make_server(host, port, backlog, store)
    try:
        server.serve_forever()
    finally:
        server.server_close()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--releases-root", required=True, type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18777)
    parser.add_argument("--backlog", type=int, default=128)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    serve(args.releases_root, args.host, args.port, args.backlog)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
