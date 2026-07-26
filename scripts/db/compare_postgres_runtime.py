#!/usr/bin/env python3
"""Compare a PostgreSQL runtime import with its SQLite source snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import time


TABLE_PAIRS = (
    ("meta", "meta"),
    ("channel_metadata", "channels"),
    ("videos", "videos"),
    ("songs", "songs"),
    ("occurrences", "occurrences"),
    ("source_details", "source_details"),
    ("source_occurrences", "source_occurrences"),
    ("ranking_rows", "ranking_rows"),
)


def canonical_hash(value: object) -> str:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            pass
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", type=Path, required=True)
    parser.add_argument("--dsn", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sample-size", type=int, default=20)
    return parser.parse_args()


def main() -> int:
    try:
        import psycopg
    except ImportError:
        print("CODEX_POSTGRES_COMPARE_ERROR psycopg is required", file=sys.stderr)
        return 1
    args = parse_args()
    started = time.time()
    result = {"status": "complete", "counts": {}, "samples": {}, "mismatches": []}
    try:
        sqlite_conn = sqlite3.connect(f"file:{args.sqlite.resolve()}?mode=ro", uri=True)
        with psycopg.connect(args.dsn) as pg_conn:
            with pg_conn.cursor() as pg_cur:
                for source_table, target_table in TABLE_PAIRS:
                    source_count = sqlite_conn.execute(f"SELECT COUNT(*) FROM {source_table}").fetchone()[0]
                    pg_cur.execute(f"SELECT COUNT(*) FROM {target_table}")
                    target_count = pg_cur.fetchone()[0]
                    result["counts"][source_table] = {"source": source_count, "target": target_count}
                    if source_count != target_count:
                        result["mismatches"].append({"table": source_table, "source": source_count, "target": target_count})

                sqlite_rows = sqlite_conn.execute(
                    "SELECT row_id, payload_json FROM ranking_rows ORDER BY row_id LIMIT ?", (args.sample_size,)
                ).fetchall()
                for row_id, payload in sqlite_rows:
                    pg_cur.execute("SELECT payload_json FROM ranking_rows WHERE row_id=%s", (row_id,))
                    row = pg_cur.fetchone()
                    sample = {"source": canonical_hash(payload), "target": canonical_hash(row[0]) if row else None}
                    result["samples"][f"ranking_rows:{row_id}"] = sample
                    if sample["source"] != sample["target"]:
                        result["mismatches"].append({"table": "ranking_rows", "key": row_id, **sample})
        sqlite_conn.close()
        if result["mismatches"]:
            result["status"] = "mismatch"
        result["elapsedSeconds"] = round(time.time() - started, 3)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        marker = "CODEX_POSTGRES_COMPARE_OK" if result["status"] == "complete" else "CODEX_POSTGRES_COMPARE_MISMATCH"
        print(marker + " " + json.dumps(result, ensure_ascii=False))
        return 0 if result["status"] == "complete" else 2
    except Exception as exc:
        print(f"CODEX_POSTGRES_COMPARE_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
