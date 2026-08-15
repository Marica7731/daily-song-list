#!/usr/bin/env python3
"""Bounded loopback TCP relay to a PostgreSQL Unix socket.

The relay is intended to run as ``www-data`` on VPS2.  The Mac release job
reaches it only through a strict-known-host SSH local forward, so PostgreSQL
continues to authenticate the Unix-socket peer and no database password or
public listener is introduced.
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


LOOPBACK = "127.0.0.1"
DEFAULT_SOCKET = "/var/run/postgresql/.s.PGSQL.5432"


class RelayState:
    def __init__(self, max_connections: int):
        self.stop = threading.Event()
        self.connections: set[socket.socket] = set()
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(max_connections)

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


def pump(left: socket.socket, right: socket.socket, stop: threading.Event) -> None:
    selector = selectors.DefaultSelector()
    try:
        selector.register(left, selectors.EVENT_READ, right)
        selector.register(right, selectors.EVENT_READ, left)
        while not stop.is_set():
            for key, _ in selector.select(0.5):
                data = key.fileobj.recv(64 * 1024)
                if not data:
                    return
                key.data.sendall(data)
    except (ConnectionError, OSError):
        return
    finally:
        selector.close()


def _write_ready(path: Path, port: int, socket_path: str) -> None:
    if not path.is_absolute() or path.exists() or path.is_symlink():
        raise RuntimeError(f"unsafe or existing ready file: {path}")
    payload = json.dumps(
        {"host": LOOPBACK, "port": port, "socket": socket_path, "pid": os.getpid()},
        sort_keys=True,
    ) + "\n"
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary, flags, 0o600)
    try:
        os.write(descriptor, payload.encode("utf-8"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)


def serve(
    listen_port: int,
    socket_path: str,
    max_connections: int,
    ready_file: Path | None = None,
) -> int:
    state = RelayState(max_connections)

    class Handler(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            state.add(self.request)
            state.add(upstream)
            try:
                upstream.connect(socket_path)
                pump(self.request, upstream, state.stop)
            finally:
                state.remove(self.request)
                state.remove(upstream)
                upstream.close()

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = False
        daemon_threads = True

        def verify_request(self, request: socket.socket, client_address: object) -> bool:
            return state.slots.acquire(blocking=False)

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
            _write_ready(ready_file, int(server.server_address[1]), socket_path)
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        state.close_all()
        if ready_file is not None:
            ready_file.unlink(missing_ok=True)
    return 0


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


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen-host", default=LOOPBACK, choices=(LOOPBACK,))
    parser.add_argument("--listen-port", type=_port, required=True)
    parser.add_argument("--socket", default=DEFAULT_SOCKET)
    parser.add_argument("--max-connections", type=_connection_limit, default=8)
    parser.add_argument("--ready-file", type=Path)
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
    return serve(args.listen_port, str(socket_path), args.max_connections, args.ready_file)


if __name__ == "__main__":
    raise SystemExit(main())
