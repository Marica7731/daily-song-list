"""Thin immutable release-serving API for the WDC shadow host.

Serves the versioned ranking read model that the Mac/GitHub release chain
materializes (see build-release-bundle.py).  It reads only local immutable
release files under releases/<content_sha256>/; it never contacts a
database and never recomputes a ranking.  The dynamic source detail path is
transparently proxied to the old production API for the shadow transition
until a local serving store is provisioned.

Endpoints:
  /healthz                      local release readiness
  /api/meta                     active release identity + counts
  /api/rankings                 versioned compact pages (range/view/metric/page)
  /api/sources/<key>            proxied to old production (transitional)

The `current` release is selected by releases/current -> <sha> symlink or a
meta/current.json pointer written atomically at activation time.
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

import http.client
import socket
import sys
import threading
import time
import uuid

REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,96}$")
SUPPORTED_RANGES = {"all", "7d"}
SUPPORTED_VIEWS = {"songs", "vtubers", "videos"}
SUPPORTED_METRICS = {"occurrences", "songs", "videos"}
# The public adapter treats metric=count as an alias for occurrences.
METRIC_ALIASES = {"count": "occurrences"}
MAX_PAGE_SIZE = 200

# The shadow host has no search index or thumbnail origin of its own: the
# release bundle only freezes compact ranking pages.  Dynamic search and
# thumbnail requests are therefore proxied to the old production API for the
# shadow transition (the same transitional pattern as /api/sources).  Plain
# pagination still reads the local immutable release files.
OLD_ORIGIN_HOST = "ytb-song-rank.culua.com"
THUMBNAIL_ROUTE_RE = re.compile(
    r"^/api/thumbnails/([A-Za-z0-9_-]{11})/"
    r"(default|mqdefault|hqdefault|sddefault|maxresdefault)\.jpg$"
)

OLD_ORIGIN_HOST = "ytb-song-rank.culua.com"
SOURCE_PROXY_TIMEOUT = 30


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

    def read_page(self, range_id: str, view: str, metric: str, page: int) -> dict[str, Any] | None:
        sha = self.current_sha()
        if not sha:
            return None
        page_path = (
            self.release_dir(sha)
            / "rankings" / range_id / view / metric / f"page-{page:04d}.json.gz"
        )
        if not page_path.exists():
            return None
        with gzip.open(page_path, "rt", encoding="utf-8") as stream:
            return json.load(stream)

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
        counts: dict[str, int] = {}
        for page in pages if isinstance(pages, list) else []:
            if not isinstance(page, dict):
                continue
            sha256 = str(page.get("sha256") or "")
            rel = str(page.get("path") or "")
            counts.setdefault("files", 0)
            counts["files"] += 1
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
            "counts": counts,
            "release": {"pages": page_stats["pages"], "bytes": page_stats["bytes"]},
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


def make_handler(store: ReleaseStore, proxy_host: str = OLD_ORIGIN_HOST) -> Callable:
    def proxy_source(key: str, query: dict[str, list[str]]) -> dict[str, Any]:
        page = _int_query(query, "page", 1)
        page_size = min(200, _int_query(query, "pageSize", 20))
        range_id = _query_value(query, "range") or "all"
        path = f"/api/sources/{key}?page={page}&pageSize={page_size}&range={range_id}"
        connection = http.client.HTTPSConnection(proxy_host, timeout=SOURCE_PROXY_TIMEOUT)
        try:
            connection.request("GET", path, headers={"User-Agent": "daily-song-list-wdc-shadow/1"})
            response = connection.getresponse()
            body = response.read()
            return json.loads(body)
        finally:
            connection.close()

    def proxy_search(query: dict[str, list[str]]) -> dict[str, Any]:
        """Proxy a rankings request that carries a text filter to the old API.

        The release bundle only freezes unfiltered compact pages; text search
        needs the full source index, which lives on the old production
        PostgreSQL.  Forward the exact query string so results match the old
        site during the shadow transition.
        """
        from urllib.parse import urlencode
        params = {k: v[-1] for k, v in query.items() if v}
        path = "/api/rankings?" + urlencode(params)
        connection = http.client.HTTPSConnection(proxy_host, timeout=SOURCE_PROXY_TIMEOUT)
        try:
            connection.request("GET", path, headers={"User-Agent": "daily-song-list-wdc-shadow/1"})
            response = connection.getresponse()
            body = response.read()
            return json.loads(body)
        finally:
            connection.close()

    def proxy_thumbnail(video_id: str, quality: str) -> tuple[int, str, bytes]:
        """Forward one allowlisted thumbnail to the old site's same-origin relay."""
        path = f"/api/thumbnails/{video_id}/{quality}.jpg"
        connection = http.client.HTTPSConnection(proxy_host, timeout=SOURCE_PROXY_TIMEOUT)
        try:
            connection.request("GET", path, headers={"User-Agent": "daily-song-list-wdc-shadow/1"})
            response = connection.getresponse()
            body = response.read()
            return response.status, response.getheader("Content-Type", "image/jpeg"), body
        finally:
            connection.close()

    class ReleaseHandler(BaseHTTPRequestHandler):
        server_version = "daily-song-list-release-serving/1"

        def do_GET(self) -> None:  # noqa: N802
            self._dispatch()

        def _dispatch(self) -> None:
            supplied = str(self.headers.get("X-Request-Id", "")).strip()
            rid = supplied if REQUEST_ID_RE.fullmatch(supplied) else uuid.uuid4().hex
            started = time.monotonic()
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query, keep_blank_values=True)
            try:
                thumbnail_match = THUMBNAIL_ROUTE_RE.fullmatch(parsed.path)
                if thumbnail_match:
                    status, content_type, body = proxy_thumbnail(
                        thumbnail_match.group(1), thumbnail_match.group(2)
                    )
                    if status != HTTPStatus.OK:
                        self._send_json(
                            HTTPStatus.BAD_GATEWAY,
                            {"error": "thumbnail_upstream", "message": "thumbnail upstream error"},
                            rid,
                            started,
                        )
                        return
                    self.send_response(HTTPStatus.OK)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Cache-Control", "public, max-age=86400, immutable")
                    self.send_header("X-Request-Id", rid)
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if parsed.path == "/healthz":
                    payload = store.health()
                    status = HTTPStatus.OK if payload.get("status") == "ok" else HTTPStatus.SERVICE_UNAVAILABLE
                    self._send_json(status, payload, rid, started)
                    return
                if parsed.path == "/api/meta":
                    self._send_json(HTTPStatus.OK, store.meta(), rid, started)
                    return
                if parsed.path == "/api/rankings":
                    q = _query_value(query, "q")
                    if q:
                        # Text search is not in the release bundle; proxy to old site.
                        payload = proxy_search(query)
                        self._send_json(HTTPStatus.OK, payload, rid, started)
                        return
                    range_id = _query_value(query, "range") or "all"
                    view = _query_value(query, "view") or "songs"
                    metric = _query_value(query, "metric") or "occurrences"
                    metric = METRIC_ALIASES.get(metric, metric)
                    page = _int_query(query, "page", 1)
                    requested_size = _int_query(query, "pageSize", 50)
                    if requested_size > MAX_PAGE_SIZE:
                        raise ValueError("pageSize exceeds bounded maximum")
                    page_size = requested_size
                    if range_id not in SUPPORTED_RANGES:
                        raise ValueError("range must be 7d or all")
                    if view not in SUPPORTED_VIEWS:
                        raise ValueError("view must be songs, vtubers, or videos")
                    if metric not in SUPPORTED_METRICS:
                        raise ValueError("metric must be occurrences, songs, or videos")
                    payload = store.read_page(range_id, view, metric, page)
                    if payload is None:
                        self._send_json(HTTPStatus.NOT_FOUND, {"error": "release_page_missing"}, rid, started)
                        return
                    self._send_json(HTTPStatus.OK, payload, rid, started)
                    return
                if parsed.path.startswith("/api/sources/"):
                    key = parsed.path.removeprefix("/api/sources/")
                    if not key:
                        raise ValueError("source key is required")
                    payload = proxy_source(key, query)
                    self._send_json(HTTPStatus.OK, payload, rid, started)
                    return
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"}, rid, started)
            except ValueError as exc:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "bad_request", "message": str(exc)},
                    rid,
                    started,
                )
            except (socket.timeout, TimeoutError):
                self._send_json(
                    HTTPStatus.GATEWAY_TIMEOUT,
                    {"error": "source_timeout", "message": "source detail query timed out"},
                    rid,
                    started,
                )
            except Exception:  # pragma: no cover - fixed public boundary
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "internal_error", "message": "request failed"},
                    rid,
                    started,
                )

        def _send_json(
            self,
            status: HTTPStatus,
            payload: dict[str, Any],
            rid: str,
            started: float,
        ) -> None:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
            self.send_response(int(status))
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("X-Request-Id", rid)
            self.send_header(
                "Cache-Control",
                "public, max-age=300, must-revalidate" if status == HTTPStatus.OK else "no-store",
            )
            self.send_header("X-Duration-Ms", f"{(time.monotonic() - started) * 1000:.2f}")
            self.end_headers()
            self.wfile.write(body)

    return ReleaseHandler


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
