#!/usr/bin/env python3
"""Build local sources sqlite from PG runtime_occurrences full export.

Export format (gzipped TSV): song_key \t payload_json
The 24-char public sourceDetailKey is derived:
    dk = sha256("source-song\\0{range}\\0{song_key}")[:24]
So we can index by the exact key the frontend sends, and serve the FULL
occurrence set per song (no page truncation).
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Sequence


def dk(range_id: str, song_key: str) -> str:
    v = f"source-song\0{range_id}\0{song_key}"
    return hashlib.sha256(v.encode("utf-8")).hexdigest()[:24]


def build(feed: Path, target: Path) -> int:
    groups: dict[tuple[str, str], dict[str, object]] = {}
    rows = 0
    with gzip.open(feed, "rt", encoding="utf-8") as stream:
        for line in stream:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            song_key, payload_json = parts[0], parts[1]
            try:
                payload = json.loads(payload_json)
            except Exception:  # noqa: BLE001
                continue
            rng = str(payload.get("rangeId") or "7d")
            key = dk(rng, song_key)
            group = groups.get((key, rng))
            if group is None:
                group = {"song_key": song_key, "occurrences": []}
                groups[(key, rng)] = group
            group["occurrences"].append(payload)
            rows += 1
    if target.exists():
        target.unlink()
    conn = sqlite3.connect(str(target))
    try:
        conn.execute("PRAGMA journal_mode=OFF")
        conn.execute("PRAGMA synchronous=OFF")
        conn.execute("CREATE TABLE source_details ("
                     " source_key TEXT NOT NULL, range_id TEXT NOT NULL,"
                     " song_key TEXT NOT NULL, occurrences_json TEXT NOT NULL,"
                     " PRIMARY KEY (source_key, range_id))")
        for (key, rng), group in groups.items():
            occ = group["occurrences"]
            conn.execute(
                "INSERT OR REPLACE INTO source_details"
                " (source_key, range_id, song_key, occurrences_json) VALUES (?,?,?,?)",
                (key, rng, group["song_key"], json.dumps(occ, ensure_ascii=False)),
            )
        conn.execute("CREATE INDEX idx_sd_range ON source_details (range_id)")
        conn.commit()
        conn.execute("PRAGMA optimize")
    finally:
        conn.close()
    return rows


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--feed", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    n = build(args.feed, args.output)
    print(f"PG_SOURCES_DONE rows={n} size={args.output.stat().st_size} path={args.output}")
    return 0


if __name__ == "__main__":
    import argparse
    raise SystemExit(main())
