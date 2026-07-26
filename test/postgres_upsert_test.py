import importlib.util
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("postgres_upsert", ROOT / "scripts/db/postgres_upsert.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class PostgresUpsertTests(unittest.TestCase):
    def test_flat_playlist_rows_group_by_video_and_parse_time(self):
        operations = MODULE.build_operations(
            [
                {"video_id": "video-1", "video_url": "https://www.youtube.com/watch?v=video-1", "start_time": "01:02:03", "title": "Song A", "artist": "Artist A"},
                {"video_id": "video-1", "start_time": "1:04", "title": "Song B", "artist": "Artist B"},
            ]
        )
        self.assertEqual(len(operations), 1)
        self.assertEqual([song["seconds"] for song in operations[0]["songs"]], [3723, 64])
        self.assertEqual(MODULE.summary(operations)["songs"], 2)

    def test_unknown_channel_identity_stays_pending(self):
        operations = MODULE.build_operations(
            [{"video_id": "video-2", "start": 12, "title": "Song", "artist": ""}]
        )
        self.assertEqual(operations[0]["channel"]["resolutionStatus"], "pending")
        self.assertEqual(operations[0]["channel"]["channelId"], "")

    def test_invalid_handle_is_rejected(self):
        with self.assertRaises(ValueError):
            MODULE.build_operations(
                [{"video_id": "video-3", "start": 1, "title": "Song", "channel_handle": "channel"}]
            )

    def test_duplicate_timestamp_is_rejected(self):
        with self.assertRaises(ValueError):
            MODULE.build_operations(
                [
                    {"video_id": "video-4", "start": 1, "title": "Song A"},
                    {"video_id": "video-4", "start": 1, "title": "Song B"},
                ]
            )

    def test_operation_keys_are_stable(self):
        operation = MODULE.build_operations(
            [{"video_id": "video-5", "start": 99, "title": "Song", "artist": "Artist"}]
        )[0]
        first = MODULE.occurrence_id(operation, operation["songs"][0])
        second = MODULE.occurrence_id(operation, operation["songs"][0])
        self.assertEqual(first, second)
        self.assertTrue(first.startswith("occ:"))


if __name__ == "__main__":
    unittest.main()
