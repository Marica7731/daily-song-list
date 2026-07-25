from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sqlite3
import unittest


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "audit-runtime-db.py"
SPEC = importlib.util.spec_from_file_location("audit_runtime_db", SCRIPT_PATH)
assert SPEC and SPEC.loader
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class AuditRuntimeDbTest(unittest.TestCase):
    def test_source_audit_groups_artists_and_keeps_real_singleton(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            """
            CREATE TABLE source_occurrences (
              source_key TEXT,
              range_id TEXT,
              position INTEGER,
              video_id TEXT,
              title TEXT,
              is_unknown_artist INTEGER,
              payload_json TEXT
            )
            """
        )
        rows = [
            (
                "fixture",
                "all",
                0,
                "AAAAAAAAAAA",
                "One-time Original",
                0,
                {
                    "item": {"videoId": "AAAAAAAAAAA"},
                    "song": {
                        "title": "One-time Original",
                        "artist": "Fixture Artist",
                    },
                },
            ),
            (
                "fixture",
                "all",
                1,
                "BBBBBBBBBBB",
                "Known Song",
                0,
                {
                    "item": {"videoId": "BBBBBBBBBBB"},
                    "song": {"title": "Known Song", "artist": "Known Artist"},
                },
            ),
            (
                "fixture",
                "all",
                2,
                "CCCCCCCCCCC",
                "Known Song",
                0,
                {
                    "item": {"videoId": "CCCCCCCCCCC"},
                    "song": {"title": "Known Song", "artist": "Known Artist"},
                },
            ),
            (
                "fixture",
                "all",
                3,
                "EEEEEEEEEEE",
                "Known Song",
                0,
                {
                    "item": {"videoId": "EEEEEEEEEEE"},
                    "song": {"title": "Known Song", "artist": "Known Artist"},
                },
            ),
            (
                "fixture",
                "all",
                4,
                "FFFFFFFFFFF",
                "Known Song",
                1,
                {
                    "item": {"videoId": "FFFFFFFFFFF"},
                    "song": {"title": "Known Song", "artist": ""},
                },
            ),
            (
                "fixture",
                "all",
                5,
                "DDDDDDDDDDD",
                "168000",
                1,
                {
                    "item": {"videoId": "DDDDDDDDDDD"},
                    "song": {"title": "168000", "artist": ""},
                },
            ),
            (
                "fixture",
                "all",
                6,
                "GGGGGGGGGGG",
                "Shared Title",
                0,
                {
                    "item": {"videoId": "GGGGGGGGGGG"},
                    "song": {"title": "Shared Title", "artist": "Artist A"},
                },
            ),
            (
                "fixture",
                "all",
                7,
                "HHHHHHHHHHH",
                "Shared Title",
                0,
                {
                    "item": {"videoId": "HHHHHHHHHHH"},
                    "song": {"title": "Shared Title", "artist": "Artist A"},
                },
            ),
            (
                "fixture",
                "all",
                8,
                "IIIIIIIIIII",
                "Shared Title",
                0,
                {
                    "item": {"videoId": "IIIIIIIIIII"},
                    "song": {"title": "Shared Title", "artist": "Artist B"},
                },
            ),
        ]
        conn.executemany(
            "INSERT INTO source_occurrences VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                (*row[:-1], json.dumps(row[-1], ensure_ascii=False))
                for row in rows
            ],
        )

        result = AUDIT.read_channel_source_audit(
            conn, {"sourceDetailKey": "fixture"}
        )
        assert result is not None
        self.assertEqual(result["occurrences"], 9)
        self.assertEqual(result["songGroups"], 6)
        self.assertEqual(result["singletonSongs"], 4)
        self.assertEqual(result["singletonUnknownSongs"], 2)
        self.assertEqual(result["numericOnlySongs"], 1)
        self.assertEqual(result["unknownFillCandidateCount"], 1)
        self.assertEqual(
            result["unknownFillCandidates"][0]["knownArtist"],
            {"artist": "Known Artist", "occurrences": 3},
        )
        self.assertEqual(result["sameTitleArtistConflictCount"], 1)
        self.assertEqual(
            [row["artist"] for row in result["sameTitleArtistConflicts"][0]["knownArtists"]],
            ["Artist A", "Artist B"],
        )
        original = next(
            song
            for song in result["songs"]
            if song["title"] == "One-time Original"
        )
        self.assertEqual(original["artist"], "Fixture Artist")
        self.assertEqual(original["occurrences"], 1)

    def test_missing_artist_contract_is_unknown_only_with_evidence(self) -> None:
        self.assertTrue(AUDIT.is_unknown_artist(""))
        self.assertTrue(AUDIT.is_unknown_artist("未記載"))
        self.assertFalse(AUDIT.is_unknown_artist("After the Rain"))


if __name__ == "__main__":
    unittest.main()
