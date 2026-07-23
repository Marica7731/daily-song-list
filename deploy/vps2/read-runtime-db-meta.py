#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sqlite3


DEFAULT_KEYS = ("source_commit_sha", "source_latest_sha256", "schema_version")


def main() -> int:
    parser = argparse.ArgumentParser(description="Print selected runtime DB meta values, one per line.")
    parser.add_argument("--db", required=True, help="Path to the runtime SQLite database.")
    parser.add_argument("keys", nargs="*", help="Meta keys to print in order.")
    args = parser.parse_args()

    keys = tuple(args.keys) or DEFAULT_KEYS
    placeholders = ",".join("?" for _ in keys)
    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    try:
        rows = dict(conn.execute(f"SELECT key, value FROM meta WHERE key IN ({placeholders})", keys))
    finally:
        conn.close()

    for key in keys:
        print(rows.get(key, ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
