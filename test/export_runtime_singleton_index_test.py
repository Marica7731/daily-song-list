#!/usr/bin/env python3
"""Regression tests for the complete runtime singleton index exporter."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "export-runtime-singleton-index.py"


class ExportRuntimeSingletonIndexTest(unittest.TestCase):
    def test_exports_every_singleton_row_with_stable_identity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codex-runtime-singleton-") as temp:
            root = Path(temp)
            db_path = root / "song-rank.sqlite"
            create_fixture_db(db_path)
            audit_path = root / "runtime-db-audit.json"
            audit_path.write_text(
                json.dumps(
                    {
                        "db": {
                            "bytes": db_path.stat().st_size,
                            "sha256": "a" * 64,
                        }
                    }
                ),
                encoding="utf-8",
            )

            first_output = root / "first.jsonl.gz"
            first_meta = root / "first.meta.json"
            first = run_export(db_path, first_output, first_meta, audit_path)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertIn("CODEX_RUNTIME_SINGLETON_INDEX_OK rows=2", first.stdout)

            rows = read_jsonl_gzip(first_output)
            self.assertEqual([row["songKey"] for row in rows], ["song-b", "song-c"])
            self.assertEqual({row["videoId"] for row in rows}, {"BBBBBBBBBBB", "CCCCCCCCCCC"})
            self.assertTrue(all(row["cohort"] == "runtime_singleton" for row in rows))
            self.assertTrue(all(len(row["candidateId"]) == 24 for row in rows))

            meta = json.loads(first_meta.read_text(encoding="utf-8"))
            self.assertEqual(meta["status"], "complete")
            self.assertEqual(meta["rowCount"], 2)
            self.assertEqual(meta["db"]["quickCheck"], "ok")
            self.assertEqual(meta["db"]["sha256"], "a" * 64)
            self.assertEqual(meta["db"]["sourceCommit"], "fixture-source")
            self.assertEqual(meta["db"]["runtimeSourceCommit"], "fixture-runtime")
            self.assertEqual(meta["output"]["sha256"], sha256_file(first_output))

            second_output = root / "second.jsonl.gz"
            second_meta = root / "second.meta.json"
            second = run_export(db_path, second_output, second_meta, audit_path)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(first_output.read_bytes(), second_output.read_bytes())

    def test_rejects_db_audit_for_a_different_database(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codex-runtime-singleton-audit-") as temp:
            root = Path(temp)
            db_path = root / "song-rank.sqlite"
            create_fixture_db(db_path)
            audit_path = root / "runtime-db-audit.json"
            audit_path.write_text(
                json.dumps(
                    {
                        "db": {
                            "bytes": db_path.stat().st_size + 1,
                            "sha256": "b" * 64,
                        }
                    }
                ),
                encoding="utf-8",
            )
            result = run_export(
                db_path,
                root / "output.jsonl.gz",
                root / "output.meta.json",
                audit_path,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("db audit byte size mismatch", result.stderr)


def create_fixture_db(db_path: Path) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE occurrences (
              occurrence_id TEXT PRIMARY KEY,
              range_id TEXT NOT NULL,
              song_key TEXT NOT NULL,
              video_id TEXT NOT NULL,
              seconds INTEGER NOT NULL,
              source_system TEXT NOT NULL,
              source_id TEXT NOT NULL,
              title TEXT NOT NULL,
              artist TEXT NOT NULL,
              is_unknown_artist INTEGER NOT NULL
            );
            """
        )
        conn.executemany(
            "INSERT INTO meta(key, value) VALUES (?, ?)",
            [
                ("source_commit", "fixture-source"),
                ("runtime_source_commit", "fixture-runtime"),
            ],
        )
        conn.executemany(
            """
            INSERT INTO occurrences(
              occurrence_id, range_id, song_key, video_id, seconds,
              source_system, source_id, title, artist, is_unknown_artist
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                ("a-1", "all", "song-a", "AAAAAAAAAAA", 10, "base", "a1", "Song A", "Artist", 0),
                ("a-2", "all", "song-a", "AAAAAAAAAAA", 20, "base", "a2", "Song A", "Artist", 0),
                ("b-1", "all", "song-b", "BBBBBBBBBBB", 30, "youtube", "b1", "Song B", "", 1),
                ("c-1", "all", "song-c", "CCCCCCCCCCC", 40, "vsinger", "c1", "Song C", "Artist C", 0),
                ("d-1", "7d", "song-d", "DDDDDDDDDDD", 50, "base", "d1", "Song D", "Artist D", 0),
            ],
        )
        conn.commit()
    finally:
        conn.close()


def run_export(
    db_path: Path,
    output_path: Path,
    meta_path: Path,
    audit_path: Path,
) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--db",
            str(db_path),
            "--output",
            str(output_path),
            "--meta-output",
            str(meta_path),
            "--db-audit",
            str(audit_path),
        ],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )


def read_jsonl_gzip(file_path: Path) -> list[dict[str, object]]:
    with gzip.open(file_path, "rt", encoding="utf-8") as source:
        return [json.loads(line) for line in source if line.strip()]


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    unittest.main()
