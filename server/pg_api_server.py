"""HTTP adapter for the PostgreSQL migration runtime.

The existing SQLite service is intentionally left untouched.  This adapter
serves the same four GET paths on a separate candidate port so a deployer can
smoke-test it before changing the active service.  It reads the immutable
active revision through :mod:`pg_adapter`; it never writes or advances the
active pointer.
"""

from __future__ import annotations

import argparse
from collections import OrderedDict
import http.client
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import socket
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, unquote, urlparse

try:
    from .pg_adapter import (
        PostgresAdapterError,
        connect_from_env,
        health_payload,
        meta_payload,
        rankings_payload,
        source_payload,
    )
except ImportError:  # executed as ``python server/pg_api_server.py``
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from pg_adapter import (  # type: ignore[no-redef]
        PostgresAdapterError,
        connect_from_env,
        health_payload,
        meta_payload,
        rankings_payload,
        source_payload,
    )


REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,96}$")
THUMBNAIL_HOST = "i.ytimg.com"
THUMBNAIL_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
THUMBNAIL_ROUTE_RE = re.compile(
    r"^/api/thumbnails/([A-Za-z0-9_-]{11})/"
    r"(default|mqdefault|hqdefault|sddefault|maxresdefault)\.jpg$"
)
THUMBNAIL_QUALITY_ALLOWLIST = frozenset(
    {"default", "mqdefault", "hqdefault", "sddefault", "maxresdefault"}
)
THUMBNAIL_CONNECT_TIMEOUT_SECONDS = 3.0
THUMBNAIL_READ_TIMEOUT_SECONDS = 5.0
THUMBNAIL_MAX_BYTES = 512 * 1024
THUMBNAIL_CACHE_CONTROL = "public, max-age=86400, immutable"
THUMBNAIL_MEMORY_CACHE_MAX_ENTRIES = 128
THUMBNAIL_MEMORY_CACHE_MAX_BYTES = 8 * 1024 * 1024
THUMBNAIL_MEMORY_CACHE_TTL_SECONDS = 86400.0
THUMBNAIL_CONTENT_TYPES = frozenset(
    {"image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"}
)


class ThumbnailResult:
    """A validated response from the fixed YouTube thumbnail origin."""

    __slots__ = ("status", "content_type", "body", "content_length", "etag", "last_modified")

    def __init__(
        self,
        status: int,
        content_type: str = "",
        body: bytes = b"",
        content_length: int | None = None,
        etag: str | None = None,
        last_modified: str | None = None,
    ):
        self.status = status
        self.content_type = content_type
        self.body = body
        self.content_length = content_length
        self.etag = etag
        self.last_modified = last_modified


def _thumbnail_condition_matches(request_headers: dict[str, str] | None, result: ThumbnailResult) -> bool:
    headers = request_headers or {}
    if_none_match = str(headers.get("If-None-Match", "")).strip()
    if if_none_match:
        if if_none_match == "*":
            return True
        current_etag = str(result.etag or "").strip()
        if not current_etag:
            return False
        normalized_current = current_etag[2:].lstrip() if current_etag.startswith("W/") else current_etag
        candidates = re.findall(r'(?:W/)?"[^"]*"|\*', if_none_match)
        return any(
            candidate == "*"
            or (candidate[2:].lstrip() if candidate.startswith("W/") else candidate) == normalized_current
            for candidate in candidates
        )
    if_modified_since = str(headers.get("If-Modified-Since", "")).strip()
    return bool(
        if_modified_since
        and result.last_modified
        and if_modified_since == str(result.last_modified).strip()
    )


class _ThumbnailMemoryCache:
    """Bounded, process-local cache for already validated image responses."""

    __slots__ = ("_entries", "_bytes", "_lock")

    def __init__(self) -> None:
        self._entries: OrderedDict[tuple[str, str], tuple[float, ThumbnailResult]] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._bytes = 0

    def get(
        self,
        video_id: str,
        quality: str,
        method: str,
        request_headers: dict[str, str] | None,
    ) -> ThumbnailResult | None:
        key = (video_id, quality)
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            expires_at, cached = entry
            if expires_at <= time.monotonic():
                self._entries.pop(key, None)
                self._bytes -= len(cached.body)
                return None
            self._entries.move_to_end(key)
        if _thumbnail_condition_matches(request_headers, cached):
            return ThumbnailResult(
                status=HTTPStatus.NOT_MODIFIED,
                content_length=0,
                etag=cached.etag,
                last_modified=cached.last_modified,
            )
        return ThumbnailResult(
            status=cached.status,
            content_type=cached.content_type,
            body=b"" if method == "HEAD" else cached.body,
            content_length=len(cached.body),
            etag=cached.etag,
            last_modified=cached.last_modified,
        )

    def put(self, video_id: str, quality: str, result: ThumbnailResult) -> None:
        body = bytes(result.body)
        if not body or len(body) > THUMBNAIL_MEMORY_CACHE_MAX_BYTES:
            return
        key = (video_id, quality)
        cached = ThumbnailResult(
            status=HTTPStatus.OK,
            content_type=result.content_type,
            body=body,
            content_length=len(body),
            etag=result.etag,
            last_modified=result.last_modified,
        )
        with self._lock:
            previous = self._entries.pop(key, None)
            if previous is not None:
                self._bytes -= len(previous[1].body)
            self._entries[key] = (time.monotonic() + THUMBNAIL_MEMORY_CACHE_TTL_SECONDS, cached)
            self._bytes += len(body)
            while (
                len(self._entries) > THUMBNAIL_MEMORY_CACHE_MAX_ENTRIES
                or self._bytes > THUMBNAIL_MEMORY_CACHE_MAX_BYTES
            ):
                _, evicted = self._entries.popitem(last=False)
                self._bytes -= len(evicted[1].body)


_THUMBNAIL_MEMORY_CACHE = _ThumbnailMemoryCache()


class ThumbnailRelayError(RuntimeError):
    """A diagnostic, fail-closed thumbnail relay failure."""

    def __init__(self, code: str, message: str, status: HTTPStatus = HTTPStatus.BAD_GATEWAY):
        super().__init__(message)
        self.code = code
        self.status = status


THUMBNAIL_PUBLIC_ERROR_MESSAGES = {
    "thumbnail_invalid_length": "thumbnail upstream returned an invalid Content-Length",
    "thumbnail_upstream": "thumbnail upstream request failed",
    "thumbnail_content_type": "thumbnail upstream did not return an allowed image Content-Type",
    "thumbnail_too_large": "thumbnail upstream response exceeds the bounded body limit",
    "thumbnail_empty": "thumbnail upstream returned an empty image body",
    "thumbnail_length_mismatch": "thumbnail upstream Content-Length does not match the bounded body",
    "thumbnail_timeout": "thumbnail upstream connect/read timed out",
}


def _thumbnail_public_error(exc: ThumbnailRelayError) -> tuple[HTTPStatus, str, str]:
    """Return a fixed public error tuple without exposing upstream exception text."""

    code = exc.code if exc.code in THUMBNAIL_PUBLIC_ERROR_MESSAGES else "thumbnail_upstream"
    status = HTTPStatus.GATEWAY_TIMEOUT if code == "thumbnail_timeout" else HTTPStatus.BAD_GATEWAY
    return status, code, THUMBNAIL_PUBLIC_ERROR_MESSAGES[code]


def thumbnail_upstream_url(video_id: str, quality: str) -> str:
    """Construct the only upstream URL the thumbnail relay is allowed to use."""

    if not THUMBNAIL_VIDEO_ID_RE.fullmatch(video_id):
        raise ValueError("videoId must be exactly 11 ASCII YouTube characters")
    if quality not in THUMBNAIL_QUALITY_ALLOWLIST:
        raise ValueError("thumbnail quality is not allowlisted")
    return f"https://{THUMBNAIL_HOST}/vi/{video_id}/{quality}.jpg"


def _open_thumbnail_connection() -> http.client.HTTPSConnection:
    connection = http.client.HTTPSConnection(
        THUMBNAIL_HOST,
        timeout=THUMBNAIL_CONNECT_TIMEOUT_SECONDS,
    )
    connection.connect()
    if connection.sock is not None:
        connection.sock.settimeout(THUMBNAIL_READ_TIMEOUT_SECONDS)
    return connection


def _response_header(response: Any, name: str) -> str | None:
    value = response.getheader(name)
    if value is None:
        return None
    value = str(value).strip()
    if not value or "\r" in value or "\n" in value:
        return None
    return value


def _response_content_length(response: Any) -> int | None:
    value = _response_header(response, "Content-Length")
    if value is None:
        return None
    try:
        length = int(value)
    except ValueError as exc:
        raise ThumbnailRelayError("thumbnail_invalid_length", "upstream Content-Length is invalid") from exc
    if length < 0:
        raise ThumbnailRelayError("thumbnail_invalid_length", "upstream Content-Length is negative")
    return length


def fetch_thumbnail(
    video_id: str,
    quality: str,
    method: str = "GET",
    request_headers: dict[str, str] | None = None,
) -> ThumbnailResult:
    """Fetch one allowlisted thumbnail without redirects or unbounded reads."""

    if method not in {"GET", "HEAD"}:
        raise ValueError("thumbnail method must be GET or HEAD")
    upstream_url = thumbnail_upstream_url(video_id, quality)
    upstream_path = urlparse(upstream_url).path
    headers = {
        "Accept": "image/*",
        "User-Agent": "daily-song-list-thumbnail-relay/1",
    }
    for name in ("If-None-Match", "If-Modified-Since"):
        value = str((request_headers or {}).get(name, "")).strip()
        if value and "\r" not in value and "\n" not in value:
            headers[name] = value
    cached = _THUMBNAIL_MEMORY_CACHE.get(video_id, quality, method, request_headers)
    if cached is not None:
        return cached

    connection: http.client.HTTPSConnection | None = None
    try:
        connection = _open_thumbnail_connection()
        # HTTPSConnection sends only this fixed path.  It does not implement
        # redirect handling, so a 3xx response is returned as a relay error.
        connection.request(method, upstream_path, headers=headers)
        response = connection.getresponse()
        status = int(response.status)
        content_type_header = _response_header(response, "Content-Type") or ""
        content_type = content_type_header.split(";", 1)[0].strip().lower()
        content_length = _response_content_length(response)
        etag = _response_header(response, "ETag")
        last_modified = _response_header(response, "Last-Modified")

        if status == HTTPStatus.NOT_MODIFIED:
            return ThumbnailResult(
                status=status,
                content_type=content_type_header,
                content_length=0,
                etag=etag,
                last_modified=last_modified,
            )
        if status != HTTPStatus.OK:
            raise ThumbnailRelayError(
                "thumbnail_upstream",
                f"thumbnail upstream returned HTTP {status}",
            )
        if content_type not in THUMBNAIL_CONTENT_TYPES:
            raise ThumbnailRelayError(
                "thumbnail_content_type",
                "thumbnail upstream did not return an allowed image Content-Type",
            )
        if content_length is not None and content_length > THUMBNAIL_MAX_BYTES:
            raise ThumbnailRelayError(
                "thumbnail_too_large",
                "thumbnail upstream response exceeds the bounded body limit",
            )
        if method == "HEAD":
            return ThumbnailResult(
                status=status,
                content_type=content_type_header,
                content_length=content_length,
                etag=etag,
                last_modified=last_modified,
            )
        body = response.read(THUMBNAIL_MAX_BYTES + 1)
        if len(body) > THUMBNAIL_MAX_BYTES:
            raise ThumbnailRelayError(
                "thumbnail_too_large",
                "thumbnail upstream response exceeds the bounded body limit",
            )
        if not body:
            raise ThumbnailRelayError("thumbnail_empty", "thumbnail upstream returned an empty image body")
        if content_length is not None and content_length != len(body):
            raise ThumbnailRelayError(
                "thumbnail_length_mismatch",
                "thumbnail upstream Content-Length does not match the bounded body",
            )
        result = ThumbnailResult(
            status=status,
            content_type=content_type_header,
            body=body,
            content_length=len(body),
            etag=etag,
            last_modified=last_modified,
        )
        _THUMBNAIL_MEMORY_CACHE.put(video_id, quality, result)
        return result
    except ThumbnailRelayError:
        raise
    except (socket.timeout, TimeoutError) as exc:
        raise ThumbnailRelayError(
            "thumbnail_timeout",
            "thumbnail upstream connect/read timed out",
            HTTPStatus.GATEWAY_TIMEOUT,
        ) from exc
    except (OSError, http.client.HTTPException) as exc:
        raise ThumbnailRelayError(
            "thumbnail_upstream",
            "thumbnail upstream request failed",
        ) from exc
    finally:
        if connection is not None:
            connection.close()


def _thumbnail_route(path: str) -> tuple[str, str] | None:
    """Parse the strict same-origin thumbnail route, rejecting encoded bypasses."""

    prefix = "/api/thumbnails/"
    if not path.startswith(prefix):
        return None
    if unquote(path) != path:
        raise ValueError("thumbnail path must not contain percent-encoded characters")
    match = THUMBNAIL_ROUTE_RE.fullmatch(path)
    if not match:
        raise ValueError("thumbnail path must contain an 11-character videoId and allowlisted quality")
    return match.group(1), match.group(2)


def _query_value(query: dict[str, list[str]], key: str) -> str:
    values = query.get(key) or []
    return str(values[0]).strip() if values else ""


def _normalize_rankings_query(query: dict[str, list[str]]) -> dict[str, list[str]]:
    """Make the public song-search scope match the actual song fields."""

    normalized = {key: list(values) for key, values in query.items()}
    view = _query_value(normalized, "view") or "songs"
    q = _query_value(normalized, "q")
    explicit_scope = _query_value(normalized, "searchScope") or _query_value(normalized, "searchField")
    if q and view in {"songs", "songIndex"} and not explicit_scope:
        normalized["searchScope"] = ["song"]
    return normalized


def request_id(headers: Any) -> str:
    supplied = str(headers.get("X-Request-Id", "")).strip()
    return supplied if REQUEST_ID_RE.fullmatch(supplied) else uuid.uuid4().hex


def _close(connection: Any) -> None:
    close = getattr(connection, "close", None)
    if close:
        close()


def _meta_identity_only(query: dict[str, list[str]]) -> bool:
    """Return whether a meta request is the bounded identity-only probe."""

    unexpected = set(query) - {"identityOnly"}
    if unexpected:
        raise ValueError("unsupported meta query parameter")
    values = query.get("identityOnly")
    if values is None:
        return False
    if values != ["1"]:
        raise ValueError("identityOnly must be exactly 1")
    return True


def make_handler(
    connection_factory: Callable[[], Any],
    thumbnail_fetcher: Callable[..., ThumbnailResult] | None = None,
):
    """Build a handler with an injected DB connection factory.

    Injection keeps route contract tests independent of a live PostgreSQL
    server and prevents one connection from being shared across HTTP threads.
    """

    relay_thumbnail = thumbnail_fetcher or fetch_thumbnail

    class PgApiHandler(BaseHTTPRequestHandler):
        server_version = "daily-song-list-pg-adapter/1"

        def do_GET(self) -> None:  # noqa: N802 - stdlib hook
            self._dispatch("GET")

        def do_HEAD(self) -> None:  # noqa: N802 - stdlib hook
            self._dispatch("HEAD")

        def _dispatch(self, method: str) -> None:
            rid = request_id(self.headers)
            parsed = urlparse(self.path)
            source_route = parsed.path.startswith("/api/sources/")
            # Per-request observability baseline: every response records
            # request id, active revision/content SHA (when the payload
            # carries them), cache mode, db/prepare/serialize/total
            # milliseconds and response bytes in headers and the access log.
            self._dsl = {
                "rid": rid,
                "method": method,
                "path": parsed.path,
                "started": time.monotonic(),
                "db_ms": None,
                "prepare_ms": None,
                "serialize_ms": None,
                "revision": None,
                "content_sha": None,
                "request_cache": str(self.headers.get("Cache-Control", "")).strip() or "-",
                "response_cache": "",
                "bytes": 0,
            }
            try:
                thumbnail = _thumbnail_route(parsed.path)
                if thumbnail is not None:
                    if parsed.query:
                        raise ValueError("thumbnail query parameters are not allowed")
                    self._send_thumbnail(thumbnail[0], thumbnail[1], method, rid)
                    return
                if method == "HEAD":
                    self.send_json(
                        HTTPStatus.METHOD_NOT_ALLOWED,
                        {"error": "method_not_allowed", "message": "only thumbnail HEAD is supported"},
                        rid,
                        write_body=False,
                        extra_headers={"Allow": "GET"},
                    )
                    return
                if parsed.path not in {"/healthz", "/api/meta", "/api/rankings"} and not source_route:
                    self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"}, rid)
                    return
                query = parse_qs(parsed.query, keep_blank_values=True)
                source_key = ""
                if source_route:
                    source_key = unquote(parsed.path.removeprefix("/api/sources/"))
                    if not source_key:
                        raise ValueError("source key is required")
                meta_identity_only = (
                    _meta_identity_only(query)
                    if parsed.path == "/api/meta"
                    else False
                )
                connection = connection_factory()
                try:
                    if parsed.path == "/healthz":
                        payload = health_payload(connection)
                    elif parsed.path == "/api/meta":
                        payload = meta_payload(
                            connection,
                            identity_only=meta_identity_only,
                        )
                    elif parsed.path == "/api/rankings":
                        query = _normalize_rankings_query(query)
                        payload = rankings_payload(connection, query)
                        if isinstance(payload, dict):
                            scope = _query_value(query, "searchScope") or _query_value(query, "searchField")
                            if scope:
                                payload = {**payload, "searchScope": scope}
                    elif source_route:
                        payload = source_payload(connection, source_key, query)
                finally:
                    _close(connection)
                if isinstance(payload, dict):
                    meta_fields = payload.get("meta") or payload
                    revision = str(meta_fields.get("active_revision_id") or "").strip()
                    content_sha = str(meta_fields.get("content_sha256") or "").strip()
                    if revision:
                        self._dsl["revision"] = revision
                    if content_sha:
                        self._dsl["content_sha"] = content_sha
                self.send_json(HTTPStatus.OK, payload, rid)
            except ValueError as exc:
                self.send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "bad_request", "message": str(exc)},
                    rid,
                    write_body=method == "GET",
                )
            except (socket.timeout, TimeoutError):
                self.send_json(
                    HTTPStatus.GATEWAY_TIMEOUT,
                    {
                        "error": "source_timeout" if source_route else "upstream_timeout",
                        "message": "source detail query timed out" if source_route else "request timed out",
                        "activePreserved": True,
                    },
                    rid,
                )
            except PostgresAdapterError:
                # Keep the diagnostic code stable without exposing connection
                # or SQL details.  The release gate preserves the old active
                # service while operators inspect private workflow logs.
                self.send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {
                        "error": "postgres_unavailable",
                        "message": "PostgreSQL adapter is unavailable",
                        "activePreserved": True,
                    },
                    rid,
                )
            except Exception:  # pragma: no cover - fixed public boundary
                self.send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "internal_error", "message": "request failed"},
                    rid,
                )

        def _send_thumbnail(self, video_id: str, quality: str, method: str, rid: str) -> None:
            request_headers = {
                name: self.headers.get(name, "")
                for name in ("If-None-Match", "If-Modified-Since")
            }
            try:
                result = relay_thumbnail(video_id, quality, method, request_headers)
            except ThumbnailRelayError as exc:
                status, code, message = _thumbnail_public_error(exc)
                self.send_json(
                    status,
                    {"error": code, "message": message},
                    rid,
                    write_body=method == "GET",
                )
                return
            except (socket.timeout, TimeoutError):
                self.send_json(
                    HTTPStatus.GATEWAY_TIMEOUT,
                    {"error": "thumbnail_timeout", "message": "thumbnail upstream connect/read timed out"},
                    rid,
                    write_body=method == "GET",
                )
                return
            except Exception:  # pragma: no cover - fixed public boundary
                self.send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"error": "thumbnail_upstream", "message": "thumbnail upstream request failed"},
                    rid,
                    write_body=method == "GET",
                )
                return

            if not isinstance(result, ThumbnailResult):
                self.send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"error": "thumbnail_upstream", "message": "thumbnail relay returned an invalid response"},
                    rid,
                    write_body=method == "GET",
                )
                return
            if result.status == HTTPStatus.NOT_MODIFIED:
                self._send_thumbnail_response(result, method, rid, b"")
                return
            if result.status != HTTPStatus.OK:
                self.send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"error": "thumbnail_upstream", "message": "thumbnail upstream returned a non-success status"},
                    rid,
                    write_body=method == "GET",
                )
                return
            content_type = result.content_type.split(";", 1)[0].strip().lower()
            if "\r" in result.content_type or "\n" in result.content_type or content_type not in THUMBNAIL_CONTENT_TYPES:
                self.send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"error": "thumbnail_content_type", "message": "thumbnail relay returned a non-image Content-Type"},
                    rid,
                    write_body=method == "GET",
                )
                return
            if result.content_length is not None and result.content_length > THUMBNAIL_MAX_BYTES:
                self.send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"error": "thumbnail_too_large", "message": "thumbnail relay response exceeds the bounded body limit"},
                    rid,
                    write_body=method == "GET",
                )
                return
            body = bytes(result.body or b"") if method == "GET" else b""
            if method == "GET" and not body:
                self.send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"error": "thumbnail_empty", "message": "thumbnail relay returned an empty image body"},
                    rid,
                    write_body=True,
                )
                return
            if len(body) > THUMBNAIL_MAX_BYTES:
                self.send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"error": "thumbnail_too_large", "message": "thumbnail relay response exceeds the bounded body limit"},
                    rid,
                    write_body=method == "GET",
                )
                return
            if method == "GET" and result.content_length is not None and result.content_length != len(body):
                self.send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"error": "thumbnail_length_mismatch", "message": "thumbnail relay Content-Length mismatch"},
                    rid,
                    write_body=True,
                )
                return
            self._send_thumbnail_response(result, method, rid, body)

        def _send_thumbnail_response(
            self,
            result: ThumbnailResult,
            method: str,
            rid: str,
            body: bytes,
        ) -> None:
            self.send_response(int(result.status))
            if result.content_type and result.status == HTTPStatus.OK:
                self.send_header("Content-Type", result.content_type)
            content_length = result.content_length if method == "HEAD" else len(body)
            self.send_header("Content-Length", str(max(0, int(content_length or 0))))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("X-Request-Id", rid)
            self.send_header("Cache-Control", THUMBNAIL_CACHE_CONTROL)
            if result.etag and "\r" not in result.etag and "\n" not in result.etag:
                self.send_header("ETag", result.etag)
            if result.last_modified and "\r" not in result.last_modified and "\n" not in result.last_modified:
                self.send_header("Last-Modified", result.last_modified)
            self.end_headers()
            self._dsl["response_cache"] = THUMBNAIL_CACHE_CONTROL
            self._dsl["bytes"] = max(0, int(content_length or 0))
            if method == "GET" and body:
                self.wfile.write(body)

        def send_json(
            self,
            status: HTTPStatus,
            payload: dict[str, Any],
            rid: str,
            write_body: bool = True,
            extra_headers: dict[str, str] | None = None,
        ) -> None:
            started = time.monotonic()
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
            self._dsl["serialize_ms"] = round((time.monotonic() - started) * 1000, 2)
            self._dsl["bytes"] = len(body)
            self._dsl["response_cache"] = "public, max-age=30" if status == HTTPStatus.OK else "no-store"
            self.send_response(int(status))
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("X-Request-Id", rid)
            self.send_header("Cache-Control", self._dsl["response_cache"])
            if self._dsl["revision"]:
                self.send_header("X-Active-Revision", self._dsl["revision"])
            if self._dsl["content_sha"]:
                self.send_header("X-Content-Sha256", self._dsl["content_sha"])
            if status == HTTPStatus.OK and self._dsl["serialize_ms"] is not None:
                self.send_header("X-Duration-Ms", f"{self._dsl['serialize_ms']:.2f}")
            for name, value in (extra_headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            if write_body:
                self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            dsl = getattr(self, "_dsl", None)
            if dsl is None:
                sys.stderr.write(
                    "%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args)
                )
                return
            line = format % args
            status = "-"
            parts = line.split()
            if len(parts) >= 2:
                status = parts[1]
            total_ms = round((time.monotonic() - dsl["started"]) * 1000, 2)
            db_ms = f"{dsl['db_ms']:.2f}" if dsl["db_ms"] is not None else "-"
            serialize_ms = f"{dsl['serialize_ms']:.2f}" if dsl["serialize_ms"] is not None else "-"
            sys.stderr.write(
                "req_metric rid=%s method=%s path=%s status=%s bytes=%d "
                "total_ms=%.2f db_ms=%s serialize_ms=%s cache_req=%s cache_resp=%s "
                "revision=%s content_sha=%s %s\n"
                % (
                    dsl["rid"], dsl["method"], dsl["path"], status,
                    dsl["bytes"], total_ms, db_ms, serialize_ms,
                    dsl["request_cache"], dsl["response_cache"], dsl["revision"] or "-",
                    dsl["content_sha"] or "-", line,
                )
            )

    return PgApiHandler


def serve(host: str, port: int) -> None:
    """Start the PG adapter only after the configured schema is reachable."""

    initial = connect_from_env()
    _close(initial)
    server = ThreadingHTTPServer((host, port), make_handler(connect_from_env))
    try:
        server.serve_forever()
    finally:
        server.server_close()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18766)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    serve(args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
