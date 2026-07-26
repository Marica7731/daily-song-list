#!/usr/bin/env python3
"""Export the complete runtime occurrence=1 cohort as deterministic gzip JSONL."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
from typing import Any


SCHEMA_VERSION = 1


def main() -> int:
    configure_stdio()
    args = parse_args()
    try:
        result = export_singleton_index(
            args.db.resolve(),
            args.output.resolve(),
            (args.meta_output or default_meta_path(args.output)).resolve(),
            args.db_audit.resolve() if args.db_audit else None,
        )
    except Exception as exc:
        print(
            f"CODEX_RUNTIME_SINGLETON_INDEX_ERROR {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return 1
    print(
        "CODEX_RUNTIME_SINGLETON_INDEX_OK "
        f"rows={result['rowCount']} output={result['output']['path']} "
        f"sha256={result['output']['sha256']}"
    )
    return 0


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--meta-output", type=Path)
    parser.add_argument("--db-audit", type=Path)
    return parser.parse_args()


def export_singleton_index(
    db_path: Path,
    output_path: Path,
    meta_path: Path,
    db_audit_path: Path | None = None,
) -> dict[str, Any]:
    if not db_path.is_file():
        raise FileNotFoundError(f"database not found: {db_path}")
    db_audit = read_json(db_audit_path) if db_audit_path else None
    db_bytes = db_path.stat().st_size
    db_sha256 = validated_db_audit_sha(db_audit, db_bytes)

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        quick_check = conn.execute("PRAGMA quick_check(1)").fetchone()[0]
        if quick_check != "ok":
            raise RuntimeError(f"SQLite quick_check failed: {quick_check}")
        meta = {
            row["key"]: row["value"]
            for row in conn.execute("SELECT key, value FROM meta ORDER BY key")
        }
        rows = conn.execute(
            """
            WITH singleton_songs AS (
              SELECT song_key
              FROM occurrences
              WHERE range_id = 'all'
              GROUP BY song_key
              HAVING COUNT(*) = 1
            )
            SELECT
              occurrence_id,
              song_key,
              video_id,
              seconds,
              source_system,
              source_id,
              title,
              artist,
              is_unknown_artist
            FROM occurrences
            WHERE range_id = 'all'
              AND song_key IN (SELECT song_key FROM singleton_songs)
            ORDER BY song_key, video_id, seconds, source_system, source_id
            """
        )
        row_count = write_rows_atomic(output_path, rows)
    finally:
        conn.close()

    output_digest = file_digest(output_path)
    result = {
        "schemaVersion": SCHEMA_VERSION,
        "status": "complete",
        "rowCount": row_count,
        "db": {
            "path": str(db_path),
            "bytes": db_bytes,
            "sha256": db_sha256,
            "quickCheck": "ok",
            "sourceCommit": meta.get("source_commit", ""),
            "runtimeSourceCommit": meta.get("runtime_source_commit", ""),
        },
        "output": {
            "path": str(output_path),
            **output_digest,
        },
    }
    write_json_atomic(meta_path, result)
    return result


def write_rows_atomic(output_path: Path, rows: Any) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = output_path.with_name(f"{output_path.name}.tmp")
    count = 0
    try:
        with temp_path.open("wb") as raw_output:
            with gzip.GzipFile(
                filename="",
                mode="wb",
                fileobj=raw_output,
                compresslevel=6,
                mtime=0,
            ) as compressed:
                for row in rows:
                    payload = {
                        "schemaVersion": SCHEMA_VERSION,
                        "candidateId": stable_candidate_id(row),
                        "cohort": "runtime_singleton",
                        "occurrenceId": clean_text(row["occurrence_id"]),
                        "songKey": clean_text(row["song_key"]),
                        "occurrenceCount": 1,
                        "videoId": clean_text(row["video_id"]),
                        "seconds": int(row["seconds"] or 0),
                        "title": clean_text(row["title"]),
                        "artist": clean_text(row["artist"]),
                        "isUnknownArtist": bool(row["is_unknown_artist"]),
                        "sourceSystem": clean_text(row["source_system"]),
                        "sourceId": clean_text(row["source_id"]),
                    }
                    compressed.write(
                        f"{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\n".encode(
                            "utf-8"
                        )
                    )
                    count += 1
        temp_path.replace(output_path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    return count


def stable_candidate_id(row: sqlite3.Row) -> str:
    value = "\0".join(
        [
            clean_text(row["song_key"]),
            clean_text(row["video_id"]),
            str(int(row["seconds"] or 0)),
            clean_text(row["source_system"]),
            clean_text(row["source_id"]),
        ]
    )
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]


def validated_db_audit_sha(
    db_audit: dict[str, Any] | None, db_bytes: int
) -> str:
    if not db_audit:
        return ""
    audit_db = db_audit.get("db") if isinstance(db_audit.get("db"), dict) else {}
    audit_bytes = int(audit_db.get("bytes") or 0)
    audit_sha = clean_text(audit_db.get("sha256"))
    if audit_bytes and audit_bytes != db_bytes:
        raise ValueError(
            f"db audit byte size mismatch: audit={audit_bytes} actual={db_bytes}"
        )
    if audit_sha and (
        len(audit_sha) != 64 or any(char not in "0123456789abcdef" for char in audit_sha)
    ):
        raise ValueError("db audit sha256 is invalid")
    return audit_sha


def default_meta_path(output_path: Path) -> Path:
    name = output_path.name
    if name.endswith(".jsonl.gz"):
        name = f"{name[:-9]}.meta.json"
    else:
        name = f"{name}.meta.json"
    return output_path.with_name(name)


def file_digest(file_path: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    with file_path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return {"bytes": file_path.stat().st_size, "sha256": digest.hexdigest()}


def read_json(file_path: Path | None) -> dict[str, Any]:
    if file_path is None:
        return {}
    return json.loads(file_path.read_text(encoding="utf-8"))


def write_json_atomic(file_path: Path, value: dict[str, Any]) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = file_path.with_name(f"{file_path.name}.tmp")
    try:
        temp_path.write_text(
            f"{json.dumps(value, ensure_ascii=False, indent=2)}\n",
            encoding="utf-8",
        )
        temp_path.replace(file_path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").split())


if __name__ == "__main__":
    raise SystemExit(main())
