#!/usr/bin/env python3
"""Self-contained candidate checks; provider data is generated in a temp fixture."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
FIXED_ARTIFACT = REPO / ".codex-snapshot-run-30765216583-audit-luna" / "artifact-8838723011"
PRODUCT = REPO / ".codex-snapshot-two-day-release-overlay-v1-luna" / "product"
MATERIALIZER_PATH = ROOT / "scripts" / "migration" / "materialize-two-day-rerun.py"
RUNNER_PATH = ROOT / "scripts" / "migration" / "run-snapshot-enrichment-pilot.py"
BRIDGE_PATH = ROOT / "scripts" / "migration" / "provider-output-to-source-index.py"
ROUTE = "2026-07-30T00:00:00Z"


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


MATERIALIZER = load_module(MATERIALIZER_PATH, "candidate_materializer_test")
RUNNER = load_module(RUNNER_PATH, "candidate_runner_test")


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def proof(path: Path) -> None:
    write_json(
        path,
        {
            "status": "VERIFIED",
            "runId": "30765216583",
            "artifactId": "8838723011",
            "actualDigest": "sha256:414372e0fedbfe94d6b187df75ec35e12dc3af70061d678eb29ab56fc0ec3fa1",
        },
    )


def materialize_from_fixed(base: Path) -> Path:
    if not FIXED_ARTIFACT.is_dir():
        raise unittest.SkipTest("fixed artifact audit input is unavailable")
    artifact = base / "source-artifact"
    shutil.copytree(FIXED_ARTIFACT, artifact)
    output = base / "materialized"
    download_proof = base / "download-proof.json"
    proof(download_proof)
    result = MATERIALIZER.main(
        [
            "--artifact-root",
            str(artifact),
            "--download-proof",
            str(download_proof),
            "--output-root",
            str(output),
            "--route-as-of-utc",
            ROUTE,
        ]
    )
    if result != 0:
        raise AssertionError(f"materializer exit={result}")
    return output


def source_fixture(root: Path, materialized: Path) -> Path:
    fixture = root / "provider-fixture"
    for sample_id in ("jul29-25", "jul22-19"):
        sample_dir = fixture / sample_id
        source_dir = sample_dir / "raw"
        source_dir.mkdir(parents=True, exist_ok=True)
        ids = json.loads((materialized / "input" / sample_id / "expected-ids.json").read_text(encoding="utf-8"))
        provider_lines: list[str] = []
        capture_lines: list[str] = []
        occurrence_number = 0
        if sample_id == "jul29-25":
            counts = [4] * 15 + [5] * 6 + [4] * 4
        else:
            counts = [24] * 19
        for video_index, (video_id, occurrence_count) in enumerate(zip(ids, counts)):
            source_id = f"source-{sample_id}-{video_index}"
            source_bytes = f"fixture source {source_id}\n".encode("utf-8")
            source_path = source_dir / f"{video_index}.txt"
            source_path.write_bytes(source_bytes)
            raw_hash = hashlib.sha256(source_bytes).hexdigest()
            source_hash = hashlib.sha256(f"parsed {source_id}".encode("utf-8")).hexdigest()
            capture_lines.append(
                json.dumps(
                    {
                        "videoId": video_id,
                        "sourceId": source_id,
                        "sourceHash": source_hash,
                        "rawHash": raw_hash,
                        "sourceBytesPath": f"raw/{video_index}.txt",
                    },
                    sort_keys=True,
                )
            )
            songs = []
            event = "2026-07-29T00:00:00Z" if sample_id == "jul29-25" else "2026-07-22T00:00:00Z"
            for local_position in range(occurrence_count):
                sentinel = sample_id == "jul29-25" and occurrence_number >= 90
                songs.append(
                    {
                        "videoId": video_id,
                        "occurrenceId": f"{sample_id}-occ-{occurrence_number}",
                        "position": local_position,
                        "seconds": occurrence_number + 1,
                        "sourceLineOrdinal": occurrence_number,
                        "sourceOccurrenceOrdinal": local_position,
                        "sourceStartOffsetUtf16": occurrence_number * 4,
                        "isSentinel": sentinel,
                        "title": f"song-{occurrence_number}",
                        "artist": "Fixture Artist",
                    }
                )
                occurrence_number += 1
            provider_lines.append(json.dumps({"videoId": video_id, "eventTime": event, "songs": songs}, sort_keys=True))
        (sample_dir / "provider.ndjson").write_text("\n".join(provider_lines) + "\n", encoding="utf-8")
        (sample_dir / "source-capture.ndjson").write_text("\n".join(capture_lines) + "\n", encoding="utf-8")
    return fixture


class TwoDayRerunTests(unittest.TestCase):
    def test_fixed_artifact_layout_hashes_route_and_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            materialized = materialize_from_fixed(Path(directory))
            report = json.loads((materialized / "materialized-manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(report["sampleIds"], ["jul29-25", "jul22-19"])
            self.assertEqual(report["selectedFileCount"], 4)
            self.assertGreater(report["ignoredProviderArtifactCount"], 0)
            self.assertEqual(report["counts"], {"jul22RawSongCount": 456, "jul22VideoCount": 19, "jul29VideoCount": 25})
            self.assertEqual(report["routeAsOfUtc"], ROUTE)
            self.assertEqual(report["releaseCutoffUtc"], "2026-07-23T00:00:00Z")
            self.assertFalse((materialized / "input" / "jul29-25" / "provider.raw.ndjson").exists())

    def test_provider_mock_runs_bridge_and_existing_linkage_in_order(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            materialized = materialize_from_fixed(base)
            fixture = source_fixture(base, materialized)
            bindings = base / "artist-bindings.json"
            write_json(bindings, {"bindings": []})
            output = base / "candidate"
            result = RUNNER.main(
                [
                    "--source-root",
                    str(base),
                    "--materialized-root",
                    str(materialized),
                    "--output-root",
                    str(output),
                    "--route-as-of-utc",
                    ROUTE,
                    "--source-commit",
                    "a" * 40,
                    "--provider-script",
                    str(PRODUCT / "scripts/migration/snapshot-enrichment-provider.mjs"),
                    "--linkage-script",
                    str(PRODUCT / "scripts/migration/snapshot-pilot-linkage.py"),
                    "--artist-bindings",
                    str(bindings),
                    "--provider-fixture-root",
                    str(fixture),
                ]
            )
            self.assertEqual(result, 0)
            summary = json.loads((output / "pilot-summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["status"], "READY_SELFCONTAINED_RERUN_CANDIDATE_ONLY")
            self.assertEqual(summary["sequence"], ["jul29-25", "jul22-19"])
            self.assertEqual([(row["realOccurrenceCount"], row["sentinelOccurrenceCount"]) for row in summary["samples"]], [(90, 16), (456, 0)])
            self.assertTrue(all(row["linkageReports"]["release-route-report.json"]["status"] == "CLOSED" for row in summary["samples"]))
            self.assertFalse(summary["releaseEligible"])
            self.assertFalse(summary["pg"])

    def test_bridge_missing_occurrence_rejects_exit_78(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / "source.txt"
            source.write_text("source\n", encoding="utf-8")
            raw_hash = hashlib.sha256(source.read_bytes()).hexdigest()
            provider = base / "provider.ndjson"
            provider.write_text(json.dumps({"videoId": "v1", "eventTime": "2026-07-29T00:00:00Z", "songs": [{"position": 0}]}) + "\n", encoding="utf-8")
            capture = base / "capture.ndjson"
            capture.write_text(json.dumps({"videoId": "v1", "sourceId": "s1", "sourceHash": "a" * 64, "rawHash": raw_hash, "sourceBytesPath": "source.txt"}) + "\n", encoding="utf-8")
            expected = base / "expected.json"
            write_json(expected, ["v1"])
            result = subprocess.run(
                [
                    sys.executable,
                    str(BRIDGE_PATH),
                    "--provider-output",
                    str(provider),
                    "--source-capture",
                    str(capture),
                    "--source-root",
                    str(base),
                    "--expected-ids",
                    str(expected),
                    "--expected-video-count",
                    "1",
                    "--expected-real-occurrences",
                    "1",
                    "--expected-sentinel-occurrences",
                    "0",
                    "--route-as-of-utc",
                    "2026-07-30T00:00:00Z",
                    "--output",
                    str(base / "index.json"),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 78)
            self.assertIn("SOURCE_POSITION_MISSING", result.stderr)

    def test_bridge_absolute_sidecar_outside_root_rejects_exit_78(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source_root = base / "source-root"
            outside = base / "outside.txt"
            source_root.mkdir()
            outside.write_text("outside\n", encoding="utf-8")
            raw_hash = hashlib.sha256(outside.read_bytes()).hexdigest()
            provider = base / "provider.ndjson"
            provider.write_text(
                json.dumps(
                    {
                        "videoId": "v-outside",
                        "eventTime": "2026-07-29T00:00:00Z",
                        "songs": [
                            {
                                "videoId": "v-outside",
                                "occurrenceId": "occ-outside",
                                "position": 0,
                                "sourceLineOrdinal": 0,
                                "sourceOccurrenceOrdinal": 0,
                                "sourceStartOffsetUtf16": 0,
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            capture = base / "capture.ndjson"
            capture.write_text(
                json.dumps(
                    {
                        "videoId": "v-outside",
                        "sourceId": "s-outside",
                        "sourceHash": "a" * 64,
                        "rawHash": raw_hash,
                        "sourceBytesPath": str(outside),
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            expected = base / "expected.json"
            write_json(expected, ["v-outside"])
            output = base / "index.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(BRIDGE_PATH),
                    "--provider-output",
                    str(provider),
                    "--source-capture",
                    str(capture),
                    "--source-root",
                    str(source_root),
                    "--expected-ids",
                    str(expected),
                    "--expected-video-count",
                    "1",
                    "--expected-real-occurrences",
                    "1",
                    "--expected-sentinel-occurrences",
                    "0",
                    "--route-as-of-utc",
                    "2026-07-30T00:00:00Z",
                    "--output",
                    str(output),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 78)
            self.assertIn("SOURCE_PATH_OUTSIDE_ROOT", result.stdout + result.stderr)
            self.assertFalse(output.exists())

    def test_bridge_root_relative_sidecar_succeeds(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source_root = base / "source-root"
            source_root.mkdir()
            sidecar = source_root / "inside.txt"
            sidecar.write_text("inside\n", encoding="utf-8")
            raw_hash = hashlib.sha256(sidecar.read_bytes()).hexdigest()
            provider = base / "provider.ndjson"
            provider.write_text(
                json.dumps(
                    {
                        "videoId": "v-inside",
                        "eventTime": "2026-07-29T00:00:00Z",
                        "songs": [
                            {
                                "videoId": "v-inside",
                                "occurrenceId": "occ-inside",
                                "position": 0,
                                "sourceLineOrdinal": 0,
                                "sourceOccurrenceOrdinal": 0,
                                "sourceStartOffsetUtf16": 0,
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            capture = base / "capture.ndjson"
            capture.write_text(
                json.dumps(
                    {
                        "videoId": "v-inside",
                        "sourceId": "s-inside",
                        "sourceHash": "b" * 64,
                        "rawHash": raw_hash,
                        "sourceBytesPath": "inside.txt",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            expected = base / "expected.json"
            write_json(expected, ["v-inside"])
            output = base / "index.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(BRIDGE_PATH),
                    "--provider-output",
                    str(provider),
                    "--source-capture",
                    str(capture),
                    "--source-root",
                    str(source_root),
                    "--expected-ids",
                    str(expected),
                    "--expected-video-count",
                    "1",
                    "--expected-real-occurrences",
                    "1",
                    "--expected-sentinel-occurrences",
                    "0",
                    "--route-as-of-utc",
                    "2026-07-30T00:00:00Z",
                    "--output",
                    str(output),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.is_file())

    def test_old_provider_is_not_accepted_as_materialized_input(self):
        with tempfile.TemporaryDirectory() as directory:
            materialized = Path(directory) / "materialized"
            materialized.mkdir()
            write_json(
                materialized / "materialized-manifest.json",
                {"status": "MATERIALIZED_ROUTE_VERIFIED", "releaseEligible": False, "providerInput": True, "routeAsOfUtc": ROUTE, "sampleIds": ["jul29-25", "jul22-19"]},
            )
            with self.assertRaises(RUNNER.RejectError):
                RUNNER.load_materialized(materialized, ROUTE)


if __name__ == "__main__":
    unittest.main(verbosity=2)
