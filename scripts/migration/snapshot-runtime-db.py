#!/usr/bin/env python3
"""Create one verified SQLite snapshot for a release build.

Both ranking-page materialization and serving-store construction consume this
same file.  They therefore cannot accidentally read two different runtime DB
revisions when the live database is refreshed during a long build.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Sequence

REQUIRED_TABLES = {"meta", "ranking_rows", "source_details", "source_occurrences"}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _revision(connection: sqlite3.Connection) -> str:
    values = {str(row[0]): str(row[1]) for row in connection.execute("SELECT key, value FROM meta")}
    for key in ("active_revision_id", "activeRevisionId", "revision_id", "revisionId"):
        value = values.get(key, "").strip()
        if value:
            return value
    return ""


def snapshot(source: Path, output: Path, *, expected_revision: str) -> dict[str, object]:
    if not source.is_file():
        raise FileNotFoundError(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".tmp", dir=output.parent
    )
    os.close(fd)
    temporary = Path(temporary_name)
    temporary.unlink(missing_ok=True)
    source_connection = sqlite3.connect(f"file:{source.resolve()}?mode=ro", uri=True, timeout=30)
    target_connection = sqlite3.connect(temporary)
    try:
        source_connection.execute("PRAGMA query_only=ON")
        source_connection.execute("PRAGMA busy_timeout=30000")
        tables = {
            str(row[0])
            for row in source_connection.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
            )
        }
        missing = sorted(REQUIRED_TABLES - tables)
        if missing:
            raise RuntimeError("runtime DB missing tables: " + ", ".join(missing))
        source_revision = _revision(source_connection)
        if not source_revision:
            raise RuntimeError("runtime DB has no revision marker")
        if source_revision != expected_revision:
            raise RuntimeError(
                f"runtime DB revision mismatch: source={source_revision} expected={expected_revision}"
            )
        source_connection.backup(target_connection, pages=4096, sleep=0.01)
        target_connection.commit()
        copied_revision = _revision(target_connection)
        if copied_revision != expected_revision:
            raise RuntimeError(
                f"snapshot revision mismatch: copied={copied_revision} expected={expected_revision}"
            )
        check = str(target_connection.execute("PRAGMA quick_check").fetchone()[0])
        if check.casefold() != "ok":
            raise RuntimeError(f"snapshot quick_check failed: {check}")
    except Exception:
        target_connection.close()
        source_connection.close()
        temporary.unlink(missing_ok=True)
        raise
    else:
        target_connection.close()
        source_connection.close()
    os.replace(temporary, output)
    return {
        "path": str(output),
        "bytes": output.stat().st_size,
        "sha256": _sha256(output),
        "activeRevisionId": expected_revision,
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--expected-revision", required=True)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        result = snapshot(args.source, args.output, expected_revision=args.expected_revision)
    except Exception as exc:  # noqa: BLE001
        print(f"RUNTIME_SNAPSHOT_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(
        "RUNTIME_SNAPSHOT_OK "
        + json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
