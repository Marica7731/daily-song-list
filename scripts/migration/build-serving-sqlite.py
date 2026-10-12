"""Build the local serving.sqlite for one release bundle.

The immutable release bundle freezes compact ranking pages only; the source
detail view is rebuilt locally from those cards so the shadow host stops
depending on the old production PostgreSQL for /api/sources/* and text search.

Tables (schema matches server/release_serving_server.py queries):

  occurrences(occurrence_id PK, payload_json)      one row per distinct
                                                   preview occurrence
  source_members(range_id, source_key,             card -> member rows
                 occurrence_id, source_sort_key)
  source_summary(range_id, source_key,             per-card counts
                 total_count, video_count)
  search_fts (FTS5)                                entity_key, title,
                                                   artist, channel

The sqlite file is written into the release bundle directory (deployed with
the bundle) but is deliberately excluded from the content_sha256 computation:
it is derived data, not ranking content.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any, Mapping, Sequence

SCHEMA_VERSION = 1


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _load_page(path: Path) -> dict[str, Any]:
    if path.suffix == ".gz":
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            return json.load(stream)
    return json.loads(path.read_text(encoding="utf-8"))


def _card_key(record: Mapping[str, Any]) -> str:
    key = record.get("sourceDetailKey") or record.get("key") or ""
    return str(key)


def _build_sqlite(bundle_dir: Path, target: Path) -> int:
    rankings = bundle_dir / "rankings"
    if not rankings.is_dir():
        raise ValueError(f"no rankings/ under {bundle_dir}")
    page_files = sorted(rankings.rglob("page-*.json*"))
    if not page_files:
        raise ValueError(f"no ranking pages under {rankings}")

    occurrences: dict[str, dict[str, Any]] = {}
    members: list[tuple[str, str, str, int]] = []
    summary: dict[tuple[str, str], tuple[int, int]] = {}
    fts_rows: list[tuple[str, str, str, str]] = []

    for page_path in page_files:
        rel = page_path.relative_to(bundle_dir).as_posix()
        parts = rel.split("/")  # rankings/<range>/<view>/<metric>/page-0001.json[.gz]
        if len(parts) < 5:
            continue
        range_id, view, metric = parts[1], parts[2], parts[3]
        payload = _load_page(page_path)
        records = payload.get("records") or []
        for record in records:
            if not isinstance(record, dict):
                continue
            key = _card_key(record)
            if not key:
                continue
            previews = record.get("occurrences") or []
            if not isinstance(previews, list):
                previews = []
            # members: distinct preview occurrences in card order
            seen: set[str] = set()
            for idx, preview in enumerate(previews):
                if not isinstance(preview, dict):
                    continue
                video_id = str(preview.get("videoId") or "")
                occ_key = f"{video_id}|{json.dumps(preview, ensure_ascii=False, sort_keys=True)}"
                if video_id in seen and occ_key in occurrences:
                    continue
                seen.add(video_id)
                if occ_key not in occurrences:
                    occurrences[occ_key] = {
                        "occurrence_id": _sha256(occ_key.encode()),
                        "payload_json": json.dumps(preview, ensure_ascii=False),
                    }
                members.append((range_id, key, occurrences[occ_key]["occurrence_id"], idx))
            video_ids = {str(p.get("videoId") or "") for p in previews if isinstance(p, dict)}
            prev_total, prev_video = summary.get((range_id, key), (0, 0))
            summary[(range_id, key)] = (prev_total + len(previews), prev_video + len(video_ids))
            # FTS row: searchable identity of the card
            title = str(record.get("title") or record.get("name") or key)
            artist = ""
            if view == "songs":
                artists = record.get("artists")
                if isinstance(artists, list):
                    artist = " ".join(
                        str(a.get("name") or "") for a in artists if isinstance(a, dict)
                    )
            elif view in ("vtubers", "videos"):
                channel = str(record.get("channel") or "")
                artist = channel
            fts_rows.append((key, title, artist, artist))

    if not members:
        raise ValueError("no source members extracted; bundle looks empty")

    if target.exists():
        target.unlink()
    conn = sqlite3.connect(str(target))
    try:
        conn.execute("PRAGMA journal_mode=OFF")
        conn.execute("PRAGMA synchronous=OFF")
        conn.execute(
            "CREATE TABLE occurrences (occurrence_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)"
        )
        conn.execute(
            "CREATE TABLE source_members ("
            " range_id TEXT NOT NULL, source_key TEXT NOT NULL,"
            " occurrence_id TEXT NOT NULL, source_sort_key INTEGER NOT NULL,"
            " PRIMARY KEY (range_id, source_key, occurrence_id))"
        )
        conn.execute(
            "CREATE TABLE source_summary ("
            " range_id TEXT NOT NULL, source_key TEXT NOT NULL,"
            " total_count INTEGER NOT NULL, video_count INTEGER NOT NULL,"
            " PRIMARY KEY (range_id, source_key))"
        )
        conn.execute(
            "CREATE VIRTUAL TABLE search_fts USING fts5("
            " entity_key UNINDEXED, title, artist, channel)"
        )
        conn.executemany(
            "INSERT OR REPLACE INTO occurrences (occurrence_id, payload_json) VALUES (?, ?)",
            [(v["occurrence_id"], v["payload_json"]) for v in occurrences.values()],
        )
        conn.executemany(
            "INSERT OR REPLACE INTO source_members"
            " (range_id, source_key, occurrence_id, source_sort_key) VALUES (?,?,?,?)",
            members,
        )
        conn.executemany(
            "INSERT OR REPLACE INTO source_summary"
            " (range_id, source_key, total_count, video_count) VALUES (?,?,?,?)",
            [(r, k, t, v) for (r, k), (t, v) in sorted(summary.items())],
        )
        conn.executemany(
            "INSERT INTO search_fts (entity_key, title, artist, channel) VALUES (?,?,?,?)",
            fts_rows,
        )
        conn.execute(
            "CREATE INDEX idx_members_source ON source_members (range_id, source_key)"
        )
        conn.commit()
        conn.execute("PRAGMA optimize")
    finally:
        conn.close()
    return len(members)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle-dir", required=True, type=Path,
                        help="release bundle directory (releases/<content_sha256>)")
    parser.add_argument("--output", default=None, type=Path,
                        help="target sqlite path (default <bundle_dir>/serving.sqlite)")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    target = args.output or (args.bundle_dir / "serving.sqlite")
    n = _build_sqlite(args.bundle_dir, target)
    print(f"SQLITE_DONE members={n} size={target.stat().st_size} path={target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
