#!/usr/bin/env python3
"""Contract tests for the isolated v1 snapshot bridge candidate."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve()
ROOT = HERE.parents[1]
SCRIPT = ROOT / "scripts" / "migration" / "snapshot-recovery-to-pg.py"


def load_module():
    spec = importlib.util.spec_from_file_location("snapshot_recovery_to_pg", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load_module()


class SnapshotRecoveryContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.input_root = self.root / "linked"
        self.output_root = self.root / "out"
        self.input_root.mkdir()
        self.records = [
            {
                "linkageDay": "2026-07-29",
                "source": {"day": "2026-07-29", "sampleId": "sample25"},
                "videoId": "vid-a",
                "occurrenceId": "occ-a",
                "position": 1,
                "seconds": 12,
                "title": "Song A",
                "artist": "Artist A",
                "sourceId": "src-a",
                "sourceHash": "a" * 64,
                "rawHash": "b" * 64,
                "eventTime": "2026-07-29T12:00:00Z",
                "releaseCutoffUtc": "2026-07-22T00:00:00Z",
                "provenance": {"fixture": "jul29"},
            },
            {
                "linkageDay": "2026-07-22",
                "source": {"day": "2026-07-22", "sampleId": "raw456"},
                "videoId": "vid-a",
                "occurrenceId": "occ-b",
                "position": 2,
                "seconds": 20,
                "title": "Song B",
                "artist": "Artist B",
                "sourceId": "src-b",
                "sourceHash": "c" * 64,
                "rawHash": "d" * 64,
                "eventTime": "2026-07-22T12:00:00Z",
                "releaseCutoffUtc": "2026-07-22T00:00:00Z",
                "provenance": {"fixture": "jul22"},
            },
        ]
        self.write_linkage()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_linkage(self, marker: bool = True, reports: bool = True) -> None:
        linked = self.input_root / "linked-output.ndjson"
        linked.write_bytes(bridge.ndjson_bytes(self.records))
        report_hashes = {}
        if reports:
            for name in bridge.REQUIRED_REPORTS:
                path = self.input_root / name
                path.write_bytes(b'{"status":"closed"}\n')
                report_hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        if marker:
            marker_obj = {
                "status": "linked",
                "closed": True,
                "linkedOutputSha256": hashlib.sha256(linked.read_bytes()).hexdigest(),
                "reports": report_hashes,
                "artifact": {"sampleIds": ["sample25", "raw456"], "sourceCommit": "a" * 40, "routeAsOf": "2026-07-29T23:59:59Z", "releaseCutoffUtc": "2026-07-22T00:00:00Z"},
            }
            (self.input_root / "linked-output.ndjson.marker").write_text(
                json.dumps(marker_obj), encoding="utf-8"
            )

    def run_cli(self, route_as_of: str = "2026-07-29T23:59:59Z") -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--artifact-root",
                str(self.input_root),
                "--output-root",
                str(self.output_root),
                "--route-as-of",
                route_as_of,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )

    def test_three_v2_regressions_are_fixed(self) -> None:
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        candidate = (self.output_root / "candidate.ndjson").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(candidate), 1)
        record = json.loads(candidate[0])
        self.assertEqual(record["videoId"], "vid-a")
        self.assertEqual(len(record["songs"]), 2)
        self.assertEqual(record["songs"][0]["releaseRoute"], "7d")
        self.assertEqual(record["songs"][1]["releaseRoute"], "all")
        self.assertEqual(record["songs"][0]["releaseCutoffUtc"], "2026-07-22T00:00:00Z")
        self.assertNotIn("__CURRENT_ACTIVE__", (self.output_root / "manifest.json").read_text(encoding="utf-8"))

    def test_missing_marker_is_rejected(self) -> None:
        (self.input_root / "linked-output.ndjson.marker").unlink()
        result = self.run_cli()
        self.assertEqual(result.returncode, 78)
        self.assertIn("missing linked marker", result.stderr)

    def test_missing_report_is_rejected(self) -> None:
        (self.input_root / bridge.REQUIRED_REPORTS[0]).unlink()
        result = self.run_cli()
        self.assertEqual(result.returncode, 78)
        self.assertIn("missing required linkage report", result.stderr)

    def test_importer_shape_and_counts_are_exact(self) -> None:
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.output_root / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(
            manifest["counts"],
            {
                "inputOccurrences": 2,
                "videoRecords": 1,
                "songOccurrences": 2,
                "sevenDayOccurrences": 1,
                "allOccurrences": 1,
                "byRoute": {"7d": {"videos": 1, "occurrences": 1}, "all": {"videos": 1, "occurrences": 1}},
            },
        )
        self.assertEqual(
            manifest["candidate"]["sha256"],
            hashlib.sha256((self.output_root / "candidate.ndjson").read_bytes()).hexdigest(),
        )

    def test_future_and_missing_event_are_rejected(self) -> None:
        self.records[0]["eventTime"] = "2026-07-30T00:00:00Z"
        self.write_linkage()
        result = self.run_cli()
        self.assertEqual(result.returncode, 78)
        self.assertIn("future eventTime", result.stderr)
        self.records[0].pop("eventTime")
        self.write_linkage()
        result = self.run_cli()
        self.assertEqual(result.returncode, 78)
        self.assertIn("eventTime is missing", result.stderr)
        self.records[0]["releaseCutoffUtc"] = "2026-07-21T00:00:00Z"
        self.write_linkage()
        result = self.run_cli()
        self.assertEqual(result.returncode, 78)
        self.assertIn("releaseCutoffUtc conflict", result.stderr)

    def test_third_day_and_conflict_are_rejected(self) -> None:
        self.records[0]["source"] = {"day": "2026-07-21", "sampleId": "third-day"}
        self.records[0]["linkageDay"] = "2026-07-21"
        self.write_linkage()
        result = self.run_cli()
        self.assertEqual(result.returncode, 78)
        self.assertIn("outside frozen two-day set", result.stderr)
        self.records[0]["source"] = {"day": "2026-07-29", "sampleId": "sample25"}
        self.records[0]["linkageDay"] = "2026-07-29"
        self.records.append(dict(self.records[0], rawHash="e" * 64))
        self.write_linkage()
        result = self.run_cli()
        self.assertEqual(result.returncode, 78)
        self.assertIn("conflicting duplicate", result.stderr)


if __name__ == "__main__":
    unittest.main()
