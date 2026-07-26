#!/usr/bin/env python3
"""Bounded TCP-to-PostgreSQL Unix-socket relay for a Mac migration task.

The process is intended to run as the PostgreSQL peer role on VPS2.  It keeps
no database, candidate, raw input, or checkpoint on the VPS; the Mac runner
owns the migration client and streams the accepted increment through the
temporary SSH tunnel.  SIGTERM stops the listener and all active connections.
"""

from __future__ import annotations

import argparse
import selectors
import signal
import socket
import socketserver
import threading
from pathlib import Path


class RelayState:
    def __init__(self, socket_path: str):
        self.socket_path = socket_path
        self.stop = threading.Event()
        self.connections: set[socket.socket] = set()
        self.lock = threading.Lock()

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
            events = selector.select(0.5)
            if not events:
                continue
            for key, _ in events:
                data = key.fileobj.recv(64 * 1024)
                if not data:
                    return
                key.data.sendall(data)
    except (ConnectionError, OSError):
        return
    finally:
        selector.close()


def serve(listen_host: str, listen_port: int, socket_path: str) -> int:
    state = RelayState(socket_path)

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

    server = Server((listen_host, listen_port), Handler)

    def shutdown(_signum: int, _frame: object) -> None:
        state.stop.set()
        state.close_all()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        state.close_all()
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen-host", default="127.0.0.1")
    parser.add_argument("--listen-port", type=int, required=True)
    parser.add_argument("--socket", default="/var/run/postgresql/.s.PGSQL.5432")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not Path(args.socket).exists():
        raise SystemExit(f"PostgreSQL Unix socket does not exist: {args.socket}")
    return serve(args.listen_host, args.listen_port, args.socket)


if __name__ == "__main__":
    raise SystemExit(main())