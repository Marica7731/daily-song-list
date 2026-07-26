#!/usr/bin/env python3
"""Bounded storage guard for the persistent macOS self-hosted runner.

The runner is shared with other work and must never be allowed to fill its
volume.  This helper only deletes paths explicitly passed by a workflow; it
does not discover or remove arbitrary user directories.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time


GIB = 1024**3


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def free_bytes(path: Path) -> int:
    return shutil.disk_usage(path).free


def tree_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        try:
            return path.stat().st_size
        except OSError:
            return 0
    total = 0
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        else:
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def gib(value: int) -> str:
    return f"{value / GIB:.2f}"


def ensure_exists_or_parent(path: Path) -> Path:
    path = path.expanduser().resolve()
    if not path.exists() and not path.parent.exists():
        raise ValueError(f"storage path parent does not exist: {path}")
    return path


def preflight(args: argparse.Namespace) -> int:
    paths = [ensure_exists_or_parent(Path(value)) for value in args.path]
    if not paths:
        raise ValueError("at least one --path is required")
    free = min(free_bytes(path if path.exists() else path.parent) for path in paths)
    required = args.min_free_gib * GIB
    sizes = {str(path): tree_bytes(path) for path in paths if path.exists()}
    print(
        "CODEX_MAC_STORAGE_PREFLIGHT "
        f"freeBytes={free} freeGiB={gib(free)} requiredFreeGiB={args.min_free_gib} "
        f"watchedBytes={sum(sizes.values())} paths={list(sizes)}",
        flush=True,
    )
    if free < required:
        print(
            "CODEX_MAC_STORAGE_PREFLIGHT_ERROR "
            f"freeGiB={gib(free)} below requiredFreeGiB={args.min_free_gib}; refusing heavy job",
            file=sys.stderr,
            flush=True,
        )
        return 78
    print("CODEX_MAC_STORAGE_PREFLIGHT_OK", flush=True)
    return 0


def safe_run_root(path: Path) -> Path:
    path = path.expanduser().resolve()
    runner_temp = os.environ.get("RUNNER_TEMP", "")
    if not runner_temp:
        raise ValueError("RUNNER_TEMP is required for --run-root")
    allowed = Path(runner_temp).expanduser().resolve()
    if path == allowed or allowed not in path.parents:
        raise ValueError(f"refusing cleanup outside RUNNER_TEMP: {path}")
    return path


def safe_cache_root(path: Path) -> Path:
    path = path.expanduser().resolve()
    expected = Path("/Users/be/actions-runner-cache/daily-song-list-runtime-db").resolve()
    if path != expected:
        raise ValueError(f"refusing cleanup outside dedicated runtime cache: {path}")
    return path


def cleanup(args: argparse.Namespace) -> int:
    removed: list[str] = []
    if args.run_root:
        run_root = safe_run_root(Path(args.run_root))
        if run_root.exists():
            shutil.rmtree(run_root)
            removed.append(str(run_root))
    if args.cache_root:
        cache_root = safe_cache_root(Path(args.cache_root))
        if cache_root.exists():
            allowed_prefixes = (
                "song-rank.sqlite.tmp",
                "song-rank.sqlite.next.",
                "song-rank.sqlite.partial.",
                "artifact-",
                "run-",
            )
            cutoff = time.time() - args.retention_hours * 3600
            for child in cache_root.iterdir():
                if not child.name.startswith(allowed_prefixes):
                    continue
                try:
                    if child.stat().st_mtime >= cutoff:
                        continue
                    if child.is_dir():
                        shutil.rmtree(child)
                    else:
                        child.unlink()
                    removed.append(str(child))
                except FileNotFoundError:
                    pass
    print(f"CODEX_MAC_STORAGE_CLEANUP_OK removed={len(removed)}")
    for path in removed:
        print(f"removed={path}")
    return 0


def terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            pass


def run_guarded(args: argparse.Namespace) -> int:
    if not args.command:
        raise ValueError("command is required after --")
    paths = [ensure_exists_or_parent(Path(value)) for value in args.watch_path]
    if not paths:
        raise ValueError("at least one --watch-path is required")
    process = subprocess.Popen(args.command, start_new_session=True)
    print(f"CODEX_MAC_STORAGE_GUARD_START pid={process.pid}", flush=True)
    limit = args.max_watch_gib * GIB
    required = args.min_free_gib * GIB
    while process.poll() is None:
        free = min(free_bytes(path if path.exists() else path.parent) for path in paths)
        watched = sum(tree_bytes(path) for path in paths)
        if free < required or watched > limit:
            print(
                "CODEX_MAC_STORAGE_GUARD_STOP "
                f"freeGiB={gib(free)} requiredFreeGiB={args.min_free_gib} "
                f"watchedGiB={gib(watched)} maxWatchedGiB={args.max_watch_gib}",
                file=sys.stderr,
                flush=True,
            )
            terminate_process_group(process)
            return 78
        time.sleep(args.interval)
    result = process.wait()
    print(f"CODEX_MAC_STORAGE_GUARD_EXIT code={result}", flush=True)
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command_name", required=True)
    pre = subparsers.add_parser("preflight")
    pre.add_argument("--path", action="append", default=[])
    pre.add_argument("--min-free-gib", type=int, default=40)
    pre.set_defaults(handler=preflight)
    clean = subparsers.add_parser("cleanup")
    clean.add_argument("--run-root")
    clean.add_argument("--cache-root")
    clean.add_argument("--retention-hours", type=int, default=24)
    clean.set_defaults(handler=cleanup)
    run = subparsers.add_parser("run")
    run.add_argument("--watch-path", action="append", default=[])
    run.add_argument("--min-free-gib", type=int, default=40)
    run.add_argument("--max-watch-gib", type=int, default=60)
    run.add_argument("--interval", type=int, default=5)
    run.add_argument("command", nargs=argparse.REMAINDER)
    run.set_defaults(handler=run_guarded)
    args = parser.parse_args()
    if args.command_name == "run" and args.command[:1] == ["--"]:
        args.command = args.command[1:]
    return args


def main() -> int:
    configure_stdio()
    args = parse_args()
    try:
        return int(args.handler(args))
    except Exception as exc:
        print(f"CODEX_MAC_STORAGE_GUARD_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
