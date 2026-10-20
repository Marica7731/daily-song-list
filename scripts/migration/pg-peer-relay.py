#!/usr/bin/env python3
"""Bounded loopback TCP relay to a PostgreSQL Unix socket.

The relay is intended to run as ``www-data`` on VPS2.  The WDC release host
reaches it only through a strict-known-host SSH local forward, so PostgreSQL
continues to authenticate the Unix-socket peer and no database password or
public listener is introduced.  A cumulative byte budget is enforced across
all connections for one release run.
"""

from __future__ import annotations

import argparse
import json
import os
import pwd
import selectors
import signal
import socket
import socketserver
import stat
import threading
from pathlib import Path
from typing import Callable


LOOPBACK = "127.0.0.1"
DEFAULT_SOCKET = "/var/run/postgresql/.s.PGSQL.5432"
DEFAULT_MAX_BYTES = 16_000_000_000
STATS_GRANULARITY_BYTES = 64 * 1024 * 1024


class RelayState:
    def __init__(
        self,
        max_connections: int,
        max_bytes: int,
        stats_file: Path | None = None,
    ):
        self.stop = threading.Event()
        self.connections: set[socket.socket] = set()
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(max_connections)
        self.max_connections = max_connections
        self.max_bytes = max_bytes
        self.stats_file = stats_file
        self.bytes_forwarded = 0
        self.connections_accepted = 0
        self.byte_limit_exceeded = False
        self._next_stats_bytes = STATS_GRANULARITY_BYTES

    def add(self, connection: socket.socket) -> None:
        with self.lock:
            self.connections.add(connection)

    def remove(self, connection: socket.socket) -> None:
        with self.lock:
            self.connections.discard(connection)

    def close_all(self) -> None:
        with self.lock:
            connections = list(self.connections)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()

    def account(self, count: int) -> bool:
        if count <= 0:
            raise ValueError("relay byte count must be positive")
        write_stats = False
        with self.lock:
            proposed = self.bytes_forwarded + count
            if proposed > self.max_bytes:
                self.byte_limit_exceeded = True
                self.stop.set()
                write_stats = True
                accepted = False
            else:
                self.bytes_forwarded = proposed
                accepted = True
                if proposed >= self._next_stats_bytes:
                    while self._next_stats_bytes <= proposed:
                        self._next_stats_bytes += STATS_GRANULARITY_BYTES
                    write_stats = True
        if write_stats:
            self.write_stats()
        return accepted

    def reserve_slot(self) -> bool:
        if not self.slots.acquire(blocking=False):
            return False
        with self.lock:
            self.connections_accepted += 1
        self.write_stats()
        return True

    def stats_payload(self) -> dict[str, int | bool]:
        with self.lock:
            return {
                "bytesForwarded": self.bytes_forwarded,
                "byteLimitExceeded": self.byte_limit_exceeded,
                "connectionsAccepted": self.connections_accepted,
                "maxBytes": self.max_bytes,
                "maxConnections": self.max_connections,
                "pid": os.getpid(),
            }

    def write_stats(self) -> None:
        if self.stats_file is None:
            return
        _replace_json(self.stats_file, self.stats_payload())


def pump(
    left: socket.socket,
    right: socket.socket,
    state: RelayState,
    stop_server: Callable[[], None],
) -> None:
    selector = selectors.DefaultSelector()
    try:
        selector.register(left, selectors.EVENT_READ, right)
        selector.register(right, selectors.EVENT_READ, left)
        while not state.stop.is_set():
            for key, _ in selector.select(0.5):
                data = key.fileobj.recv(64 * 1024)
                if not data:
                    return
                if not state.account(len(data)):
                    stop_server()
                    return
                key.data.sendall(data)
    except (ConnectionError, OSError):
        return
    finally:
        selector.close()


def _replace_json(path: Path, payload: dict[str, object]) -> None:
    if not path.is_absolute() or path.is_symlink():
        raise RuntimeError(f"unsafe JSON marker path: {path}")
    path.parent.mkdir(parents=False, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary, flags, 0o600)
    try:
        encoded = (json.dumps(payload, sort_keys=True) + "\n").encode("utf-8")
        os.write(descriptor, encoded)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)


def _write_ready(
    path: Path,
    port: int,
    socket_path: str,
    max_connections: int,
    max_bytes: int,
    stats_file: Path | None,
) -> None:
    if not path.is_absolute() or path.exists() or path.is_symlink():
        raise RuntimeError(f"unsafe or existing ready file: {path}")
    _replace_json(
        path,
        {
            "host": LOOPBACK,
            "maxBytes": max_bytes,
            "maxConnections": max_connections,
            "pid": os.getpid(),
            "port": port,
            "socket": socket_path,
            "statsFile": str(stats_file) if stats_file is not None else "",
        },
    )


def serve(
    listen_port: int,
    socket_path: str,
    max_connections: int,
    max_bytes: int,
    ready_file: Path | None = None,
    stats_file: Path | None = None,
) -> int:
    state = RelayState(max_connections, max_bytes, stats_file)

    class Handler(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            state.add(self.request)
            state.add(upstream)
            try:
                upstream.connect(socket_path)
                pump(
                    self.request,
                    upstream,
                    state,
                    lambda: threading.Thread(
                        target=server.shutdown,
                        daemon=True,
                    ).start(),
                )
            finally:
                state.remove(self.request)
                state.remove(upstream)
                upstream.close()

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = False
        daemon_threads = True

        def verify_request(self, request: socket.socket, client_address: object) -> bool:
            return state.reserve_slot()

        def process_request_thread(self, request: socket.socket, client_address: object) -> None:
            try:
                super().process_request_thread(request, client_address)
            finally:
                state.slots.release()

    server = Server((LOOPBACK, listen_port), Handler)

    def shutdown(_signum: int, _frame: object) -> None:
        state.stop.set()
        state.close_all()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        if ready_file is not None:
            _write_ready(
                ready_file,
                int(server.server_address[1]),
                socket_path,
                max_connections,
                max_bytes,
                stats_file,
            )
        state.write_stats()
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        state.close_all()
        state.write_stats()
        if ready_file is not None:
            ready_file.unlink(missing_ok=True)
    return 75 if state.byte_limit_exceeded else 0


def _port(value: str) -> int:
    port = int(value)
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be in [0, 65535]")
    return port


def _connection_limit(value: str) -> int:
    limit = int(value)
    if not 1 <= limit <= 64:
        raise argparse.ArgumentTypeError("max connections must be in [1, 64]")
    return limit


def _byte_limit(value: str) -> int:
    limit = int(value)
    if not 1 <= limit <= DEFAULT_MAX_BYTES:
        raise argparse.ArgumentTypeError(
            f"max bytes must be in [1, {DEFAULT_MAX_BYTES}]"
        )
    return limit


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen-host", default=LOOPBACK, choices=(LOOPBACK,))
    parser.add_argument("--listen-port", type=_port, required=True)
    parser.add_argument("--socket", default=DEFAULT_SOCKET)
    parser.add_argument("--max-connections", type=_connection_limit, default=8)
    parser.add_argument("--max-bytes", type=_byte_limit, default=DEFAULT_MAX_BYTES)
    parser.add_argument("--ready-file", type=Path)
    parser.add_argument("--stats-file", type=Path)
    parser.add_argument("--require-user", default="")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    socket_path = Path(args.socket)
    if not socket_path.is_absolute():
        raise SystemExit("PostgreSQL Unix socket path must be absolute")
    try:
        socket_mode = socket_path.stat().st_mode
    except FileNotFoundError as error:
        raise SystemExit(f"PostgreSQL Unix socket does not exist: {socket_path}") from error
    if not stat.S_ISSOCK(socket_mode):
        raise SystemExit(f"PostgreSQL path is not a Unix socket: {socket_path}")
    if args.require_user:
        expected_uid = pwd.getpwnam(args.require_user).pw_uid
        if os.geteuid() != expected_uid:
            raise SystemExit(f"relay must run as {args.require_user}")
    marker_parent = (
        args.ready_file.parent
        if args.ready_file is not None
        else args.stats_file.parent if args.stats_file is not None else None
    )
    for marker in (args.ready_file, args.stats_file):
        if marker is not None:
            if not marker.is_absolute() or marker.parent != marker_parent:
                raise SystemExit("relay marker paths must be absolute siblings")
            if marker.exists() or marker.is_symlink():
                raise SystemExit(f"relay marker already exists: {marker}")
    return serve(
        args.listen_port,
        str(socket_path),
        args.max_connections,
        args.max_bytes,
        args.ready_file,
        args.stats_file,
    )


if __name__ == "__main__":
    raise SystemExit(main())
