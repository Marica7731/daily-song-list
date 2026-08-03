#!/usr/bin/env python3
"""Offline fixture tests for fetch-nine-video-metadata.py."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "migration" / "fetch-nine-video-metadata.py"
SPEC = importlib.util.spec_from_file_location("fetch_nine_video_metadata", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot import {SCRIPT}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


VIDEO_IDS = [
    ("-2XWRPr7DXI", 5),
    ("-37IvEbCilw", 17),
    ("-jjFWXquCGU", 7),
    ("-wlTsHP4bPA", 12),
    ("04NpD4NkioM", 9),
    ("0Q08EOARqAw", 10),
    ("0ziidPsL5oc", 10),
    ("10fQiC4v_UM", 2),
    ("190iHYD9bMQ", 18),
]


def make_config() -> dict:
    return {
        "schemaVersion": "jul29-nine-video-input/v1",
        "sourceCandidateSha256": "c2609e63164d964cfcd565603eb3a5374d3d3426e456db4c8ac9d811884a84e6",
        "sourceArtifact": {"runId": "30815828860", "artifactId": "8856722284"},
        "occurrenceSourcePath": "phase1/candidate.ndjson",
        "videos": [
            {
                "videoId": video_id,
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "expectedOccurrenceCount": count,
                "sourceHash": f"source-{index}",
            }
            for index, (video_id, count) in enumerate(VIDEO_IDS)
        ],
    }


def make_fixture() -> list[dict]:
    return [
        {
            "id": video_id,
            "title": f"fixture title {index}",
            "channel_id": f"UCfixture{index:02d}",
            "channel": f"Fixture Channel {index}",
            "channel_handle": f"@fixture{index:02d}",
            "webpage_url": f"https://www.youtube.com/watch?v={video_id}",
            "timestamp": 1750000000 + index,
            "thumbnail": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
            "duration": 120 + index,
        }
        for index, (video_id, _count) in enumerate(VIDEO_IDS)
    ]


class FetchNineVideoMetadataTest(unittest.TestCase):
    def test_command_is_metadata_only(self) -> None:
        command = MODULE.build_ytdlp_command("https://www.youtube.com/watch?v=abc")
        self.assertIn("--skip-download", command)
        self.assertIn("--dump-single-json", command)
        self.assertIn("--no-playlist", command)
        self.assertNotIn("--write-thumbnail", command)
        self.assertNotIn("--write-info-json", command)

    def test_fixture_produces_nine_records_and_ninety_bound_occurrences(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            input_path = root / "input.json"
            fixture_path = root / "fixture.json"
            output_path = root / "artifact" / "metadata.ndjson"
            manifest_path = root / "artifact" / "manifest.json"
            input_path.write_text(json.dumps(make_config()), encoding="utf-8")
            fixture_path.write_text(json.dumps(make_fixture()), encoding="utf-8")

            self.assertEqual(
                MODULE.main(
                    [
                        "--input",
                        str(input_path),
                        "--output",
                        str(output_path),
                        "--manifest",
                        str(manifest_path),
                        "--fixture",
                        str(fixture_path),
                    ]
                ),
                0,
            )
            records = [json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines()]
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(len(records), 9)
            self.assertEqual(sum(record["occurrenceBinding"]["expectedOccurrenceCount"] for record in records), 90)
            self.assertEqual(manifest["videoCount"], 9)
            self.assertEqual(manifest["occurrenceCount"], 90)
            for record in records:
                for field in MODULE.REQUIRED_FIELDS:
                    self.assertTrue(record[field], field)
                self.assertTrue(record["candidateOnly"])
                self.assertFalse(record["releaseEligible"])
                self.assertTrue(record["source"]["metadataOnly"])
                self.assertFalse(record["source"]["downloaded"])
                self.assertTrue(record["occurrenceBinding"]["preserveIdentityAndProvenance"])
                self.assertEqual(
                    record["occurrenceBinding"]["sourceCandidateSha256"],
                    "c2609e63164d964cfcd565603eb3a5374d3d3426e456db4c8ac9d811884a84e6",
                )
                self.assertEqual(record["occurrenceBinding"]["sourcePath"], "phase1/candidate.ndjson")

    def test_missing_metadata_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            input_path = root / "input.json"
            fixture_path = root / "fixture.json"
            output_path = root / "metadata.ndjson"
            manifest_path = root / "manifest.json"
            input_path.write_text(json.dumps(make_config()), encoding="utf-8")
            fixture = make_fixture()
            fixture[0].pop("thumbnail")
            fixture_path.write_text(json.dumps(fixture), encoding="utf-8")
            self.assertEqual(
                MODULE.main(
                    [
                        "--input",
                        str(input_path),
                        "--output",
                        str(output_path),
                        "--manifest",
                        str(manifest_path),
                        "--fixture",
                        str(fixture_path),
                    ]
                ),
                MODULE.NEEDS_REVIEW_EXIT,
            )
            self.assertFalse(output_path.exists())

    def test_non_fixture_path_passes_resolved_executable_and_writes_nine_records(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            input_path = root / "input.json"
            output_path = root / "metadata.ndjson"
            manifest_path = root / "manifest.json"
            input_path.write_text(json.dumps(make_config()), encoding="utf-8")
            fixture_by_id = {record["id"]: record for record in make_fixture()}
            resolved_executable = "/runner/temp/jul29-metadata-venv/bin/yt-dlp"
            calls: list[tuple[str, str, str]] = []

            def fake_run_ytdlp(url: str, video_id: str, executable: str) -> dict:
                calls.append((url, video_id, executable))
                return fixture_by_id[video_id]

            with patch.object(MODULE, "run_ytdlp", side_effect=fake_run_ytdlp):
                result = MODULE.main(
                    [
                        "--input",
                        str(input_path),
                        "--output",
                        str(output_path),
                        "--manifest",
                        str(manifest_path),
                        "--yt-dlp",
                        resolved_executable,
                    ]
                )

            self.assertEqual(result, 0)
            self.assertEqual(len(calls), 9)
            self.assertEqual({call[2] for call in calls}, {resolved_executable})
            self.assertEqual({call[1] for call in calls}, {video_id for video_id, _count in VIDEO_IDS})
            records = [json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(records), 9)
            self.assertEqual(sum(record["occurrenceBinding"]["expectedOccurrenceCount"] for record in records), 90)


if __name__ == "__main__":
    unittest.main()
