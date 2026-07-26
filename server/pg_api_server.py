"""HTTP adapter for the PostgreSQL migration runtime.

The existing SQLite service is intentionally left untouched.  This adapter
serves the same four GET paths on a separate candidate port so a deployer can
smoke-test it before changing the active service.  It reads the immutable
active revision through :mod:`pg_adapter`; it never writes or advances the
active pointer.
"""

from __future__ import annotations

import argparse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import sys
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


def request_id(headers: Any) -> str:
    supplied = str(headers.get("X-Request-Id", "")).strip()
    return supplied if REQUEST_ID_RE.fullmatch(supplied) else uuid.uuid4().hex


def _close(connection: Any) -> None:
    close = getattr(connection, "close", None)
    if close:
        close()


def make_handler(connection_factory: Callable[[], Any]):
    """Build a handler with an injected DB connection factory.

    Injection keeps route contract tests independent of a live PostgreSQL
    server and prevents one connection from being shared across HTTP threads.
    """

    class PgApiHandler(BaseHTTPRequestHandler):
        server_version = "daily-song-list-pg-adapter/1"

        def do_GET(self) -> None:  # noqa: N802 - stdlib hook
            rid = request_id(self.headers)
            parsed = urlparse(self.path)
            try:
                connection = connection_factory()
                try:
                    query = parse_qs(parsed.query, keep_blank_values=True)
                    if parsed.path == "/healthz":
                        payload = health_payload(connection)
                    elif parsed.path == "/api/meta":
                        payload = meta_payload(connection)
                    elif parsed.path == "/api/rankings":
                        payload = rankings_payload(connection, query)
                    elif parsed.path.startswith("/api/sources/"):
                        key = unquote(parsed.path.removeprefix("/api/sources/"))
                        payload = source_payload(connection, key, query)
                    else:
                        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"}, rid)
                        return
                finally:
                    _close(connection)
                self.send_json(HTTPStatus.OK, payload, rid)
            except ValueError as exc:
                self.send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "bad_request", "message": str(exc)},
                    rid,
                )
            except PostgresAdapterError as exc:
                # A candidate adapter must fail diagnostically.  The release
                # gate keeps the old SQLite service active instead of turning
                # this into a 502 during migration.
                self.send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {
                        "error": "postgres_unavailable",
                        "message": str(exc),
                        "activePreserved": True,
                    },
                    rid,
                )
            except Exception as exc:  # pragma: no cover - operator diagnostics
                self.send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "internal_error", "message": str(exc)},
                    rid,
                )

        def send_json(self, status: HTTPStatus, payload: dict[str, Any], rid: str) -> None:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
            self.send_response(int(status))
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("X-Request-Id", rid)
            self.send_header("Cache-Control", "public, max-age=30" if status == HTTPStatus.OK else "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

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
