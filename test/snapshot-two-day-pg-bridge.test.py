#!/usr/bin/env python3
"""Adversarial and phase-proof tests for the isolated v1 bridge."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONVERTER = ROOT / "scripts/migration/snapshot-recovery-to-pg.py"
ORCHESTRATOR = ROOT / "scripts/orchestrator/snapshot-two-day-pg-bridge.py"
WORKFLOW = ROOT / ".github/workflows/snapshot-two-day-pg-bridge.yml"


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load(CONVERTER, "snapshot_recovery_to_pg_test")
orchestrator = load(ORCHESTRATOR, "two_day_pg_bridge_test")


class v1ContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.artifact = self.root / "formal-linkage"
        self.artifact.mkdir()
        self.rows = [
            {
                "linkageDay": "2026-07-29",
                "source": {"day": "2026-07-29", "sampleId": "sample25"},
                "videoId": "video-1",
                "occurrenceId": "occ-29",
                "position": 3,
                "seconds": 31,
                "title": "Jul29 song",
                "artist": "Artist 29",
                "sourceId": "source-29",
                "sourceHash": "a" * 64,
                "rawHash": "b" * 64,
                "eventTime": "2026-07-29T12:00:00Z",
                "releaseCutoffUtc": "2026-07-22T00:00:00Z",
                "provenance": {"fixture": "sample25"},
            },
            {
                "linkageDay": "2026-07-22",
                "source": {"day": "2026-07-22", "sampleId": "raw456"},
                "videoId": "video-1",
                "occurrenceId": "occ-22",
                "position": 4,
                "seconds": 42,
                "title": "Jul22 song",
                "artist": "Artist 22",
                "sourceId": "source-22",
                "sourceHash": "c" * 64,
                "rawHash": "d" * 64,
                "eventTime": "2026-07-22T12:00:00Z",
                "releaseCutoffUtc": "2026-07-22T00:00:00Z",
                "provenance": {"fixture": "raw456"},
            },
        ]
        self.write_formal_artifact()
        self.active_proof = self.root / "active-proof.json"
        self.active_proof.write_text(
            json.dumps({"kind": "active-revision-proof", "verified": True, "locked": True, "actual_active_revision": "active-42"}),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_formal_artifact(self, marker: bool = True, report_hash: bool = True) -> None:
        linked = self.artifact / "linked-output.ndjson"
        linked.write_bytes(b"".join(bridge.canon(row) + b"\n" for row in self.rows))
        hashes = {}
        for name in bridge.REQUIRED_REPORTS:
            report = {"status": "closed"}
            (self.artifact / name).write_text(json.dumps(report) + "\n", encoding="utf-8")
            hashes[name] = hashlib.sha256((self.artifact / name).read_bytes()).hexdigest()
        if marker:
            value = {
                "status": "linked",
                "closed": True,
                "linkedOutputSha256": hashlib.sha256(linked.read_bytes()).hexdigest(),
                "reports": hashes if report_hash else {},
                "artifact": {"sampleIds": ["sample25", "raw456"], "sourceCommit": "a" * 40, "routeAsOf": "2026-07-29T23:59:59Z", "releaseCutoffUtc": "2026-07-22T00:00:00Z"},
            }
            (self.artifact / "linked-output.ndjson.marker").write_text(json.dumps(value), encoding="utf-8")

    def run_converter(self, route: str | None = None) -> subprocess.CompletedProcess[str]:
        command = [sys.executable, str(CONVERTER), "--artifact-root", str(self.artifact), "--output-root", str(self.root / "output"), "--route-as-of", "2026-07-29T23:59:59Z"]
        if route:
            command.extend(["--release-route", route])
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )

    def test_adversarial_missing_marker_hash_closure_and_third_day(self) -> None:
        (self.artifact / "linked-output.ndjson.marker").unlink()
        result = self.run_converter()
        self.assertEqual(result.returncode, 78)
        self.assertIn("missing linked marker", result.stderr)
        self.write_formal_artifact(report_hash=False)
        result = self.run_converter()
        self.assertEqual(result.returncode, 78)
        self.assertIn("missing hash", result.stderr)
        (self.artifact / "occurrence-closure.json").write_text('{"status":"open"}\n', encoding="utf-8")
        self.write_formal_artifact()
        (self.artifact / "occurrence-closure.json").write_text('{"status":"open"}\n', encoding="utf-8")
        result = self.run_converter()
        self.assertEqual(result.returncode, 78)
        self.assertIn("closure status", result.stderr)
        self.rows[0]["source"] = {"day": "2026-07-21", "sampleId": "third-day"}
        self.rows[0]["linkageDay"] = "2026-07-21"
        self.write_formal_artifact()
        result = self.run_converter()
        self.assertEqual(result.returncode, 78)
        self.assertIn("outside frozen two-day set", result.stderr)

    def test_event_time_routing_shape_and_exact_counts(self) -> None:
        result = self.run_converter()
        self.assertEqual(result.returncode, 0, result.stderr)
        candidate = (self.root / "output/candidate.ndjson").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(candidate), 1)
        video = json.loads(candidate[0])
        self.assertEqual(video["videoId"], "video-1")
        self.assertEqual(len(video["songs"]), 2)
        self.assertEqual([song["releaseRoute"] for song in video["songs"]], ["7d", "all"])
        self.assertEqual(video["songs"][0]["releaseCutoffUtc"], "2026-07-22T00:00:00Z")
        manifest = json.loads((self.root / "output/manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["counts"]["inputOccurrences"], 2)
        self.assertEqual(manifest["counts"]["videoRecords"], 1)
        self.assertEqual(manifest["counts"]["songOccurrences"], 2)
        self.assertEqual(manifest["counts"]["sevenDayOccurrences"], 1)
        self.assertEqual(manifest["counts"]["allOccurrences"], 1)
        self.assertEqual(manifest["candidate"]["sha256"], hashlib.sha256((self.root / "output/candidate.ndjson").read_bytes()).hexdigest())

    def test_future_missing_and_conflicting_event_reject(self) -> None:
        self.rows[0]["eventTime"] = "2026-07-30T00:00:00Z"
        self.write_formal_artifact()
        result = self.run_converter()
        self.assertEqual(result.returncode, 78)
        self.assertIn("future eventTime", result.stderr)
        self.rows[0].pop("eventTime")
        self.write_formal_artifact()
        result = self.run_converter()
        self.assertEqual(result.returncode, 78)
        self.assertIn("eventTime is missing", result.stderr)
        self.rows[0]["eventTime"] = "2026-07-29T12:00:00Z"
        self.rows[0]["releaseCutoffUtc"] = "2026-07-21T00:00:00Z"
        self.write_formal_artifact()
        result = self.run_converter()
        self.assertEqual(result.returncode, 78)
        self.assertIn("releaseCutoffUtc conflict", result.stderr)
        self.rows[0]["releaseCutoffUtc"] = "2026-07-22T00:00:00Z"
        self.rows.append(dict(self.rows[0], rawHash="e" * 64))
        self.write_formal_artifact()
        result = self.run_converter()
        self.assertEqual(result.returncode, 78)
        self.assertIn("conflicting duplicate", result.stderr)

    def test_phase1_failure_does_not_enter_phase2(self) -> None:
        (self.artifact / "linked-output.ndjson.marker").unlink()
        with self.assertRaises(orchestrator.Reject):
            orchestrator.run_phase1(self.artifact, self.root / "handoff", "2026-07-29T23:59:59Z", self.active_proof)
        self.assertFalse((self.root / "handoff/phase2").exists())

    def test_output_scope_is_caller_provided_and_traversal_is_rejected(self) -> None:
        scope = self.root / "scope"
        accepted = orchestrator.ensure_inside(scope, scope / "nested" / ".." / "phase1")
        self.assertEqual(accepted, scope.resolve() / "phase1")
        with self.assertRaises(orchestrator.Reject):
            orchestrator.ensure_inside(scope, self.root / "outside")

    def test_phase2_requires_untampered_locked_proof(self) -> None:
        handoff = self.root / "handoff"
        phase1 = orchestrator.run_phase1(self.artifact, handoff, "2026-07-29T23:59:59Z", self.active_proof)
        tampered = self.root / "tampered-proof.json"
        tampered.write_text(json.dumps({"kind": "phase1-activation-proof", "verified": True, "locked": True, "actual_activated_revision": "phase1-99", "parent_revision_id": "wrong-parent"}), encoding="utf-8")
        with self.assertRaises(orchestrator.Reject):
            orchestrator.run_phase2(self.artifact, handoff, "2026-07-29T23:59:59Z", tampered)
        self.assertFalse((handoff / "phase2").exists())
        proof = self.root / "phase1-proof.json"
        proof.write_text(json.dumps({"kind": "phase1-activation-proof", "verified": True, "locked": True, "actual_activated_revision": "phase1-99", "parent_revision_id": phase1["parent"], "content_sha256": phase1["candidate"]["sha256"]}), encoding="utf-8")
        phase2 = orchestrator.run_phase2(self.artifact, handoff, "2026-07-29T23:59:59Z", proof)
        self.assertEqual(phase2["parent"], "phase1-99")
        root_manifest = json.loads((handoff / "orchestrator-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(root_manifest["parentCas"]["phase2Parent"], "phase1-99")
        self.assertEqual(root_manifest["actualIo"], {"dbMutationCount": 0, "activationPerformed": False, "dispatchPerformed": False})

    def test_workflow_yaml_and_bash_contract(self) -> None:
        try:
            import yaml
        except ImportError as exc:  # pragma: no cover - environment contract
            self.fail(f"PyYAML is required for workflow parse: {exc}")
        document = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
        self.assertIn("jobs", document)
        self.assertIn("candidate", document["jobs"])
        self.assertIn("release", document["jobs"])
        self.assertIn(".github/workflows/deploy-pg-incremental.yml", WORKFLOW.read_text(encoding="utf-8"))
        self.assertIn(".github/workflows/activate-pg-ready-candidate.yml", WORKFLOW.read_text(encoding="utf-8"))
        self.assertIn("secrets.GITHUB_TOKEN", WORKFLOW.read_text(encoding="utf-8"))
        self.assertIn('$RUNNER_TEMP/two-day-pg-bridge/artifact', WORKFLOW.read_text(encoding="utf-8"))
        self.assertIn('--artifact-root "$ARTIFACT_ROOT"', WORKFLOW.read_text(encoding="utf-8"))
        self.assertIn("$GITHUB_WORKSPACE/scripts/orchestrator/snapshot-two-day-pg-bridge.py", WORKFLOW.read_text(encoding="utf-8"))
        self.assertIn("phase1/candidate.ndjson", WORKFLOW.read_text(encoding="utf-8"))
        self.assertIn("phase1/manifest.json", WORKFLOW.read_text(encoding="utf-8"))
        self.assertIn("phase2/candidate.ndjson", WORKFLOW.read_text(encoding="utf-8"))
        self.assertIn("phase2/manifest.json", WORKFLOW.read_text(encoding="utf-8"))
        self.assertNotIn("output/workflows/", WORKFLOW.read_text(encoding="utf-8"))
        for job in document["jobs"].values():
            for step in job.get("steps", []):
                script = step.get("run")
                if script:
                    script = script.replace("\r\n", "\n").replace("\r", "\n")
                    checked = subprocess.run(
                        ["bash", "-n"],
                        input=script.encode("utf-8"),
                        capture_output=True,
                        timeout=10,
                    )
                    self.assertEqual(checked.returncode, 0, checked.stderr.decode("utf-8", "replace"))
        candidate_runs = "\n".join(step.get("run", "") for step in document["jobs"]["candidate"]["steps"])
        self.assertNotIn("gh workflow run", candidate_runs)
        self.assertIn("$GITHUB_WORKSPACE/test/snapshot-two-day-pg-bridge.test.py", candidate_runs)
        self.assertNotIn("python3 output/", WORKFLOW.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
