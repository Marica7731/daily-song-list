from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "orchestrator" / "snapshot-two-day-pg-bridge.py"
spec = importlib.util.spec_from_file_location("pg_bridge_v2_candidate", SCRIPT)
assert spec and spec.loader
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

ROUTE = "2026-07-29T23:59:59Z"
CUTOFF = "2026-07-23T00:00:00Z"
HEAD = "a" * 40


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical(value) + b"\n")


class BridgeV2FocusedTest(unittest.TestCase):
    def make_artifact(self, root: Path) -> tuple[Path, Path, Path]:
        artifact = root / "formal-artifact"
        artifact.mkdir()
        rows = [
            {
                "linkageDay": "2026-07-29",
                "source": {"day": "2026-07-29", "sampleId": "sample25"},
                "videoId": "video-7d",
                "occurrenceId": "occ-7d",
                "position": 0,
                "seconds": 10,
                "title": "Seven day",
                "artist": "Fixture",
                "sourceId": "source-7d",
                "sourceHash": "b" * 64,
                "rawHash": "c" * 64,
                "eventTime": "2026-07-29T12:00:00Z",
                "releaseCutoffUtc": CUTOFF,
                "provenance": {"fixture": "focused"},
            },
            {
                "linkageDay": "2026-07-22",
                "source": {"day": "2026-07-22", "sampleId": "raw456"},
                "videoId": "video-all",
                "occurrenceId": "occ-all",
                "position": 0,
                "seconds": 11,
                "title": "Historical all",
                "artist": "Fixture",
                "sourceId": "source-all",
                "sourceHash": "d" * 64,
                "rawHash": "e" * 64,
                "eventTime": "2026-07-22T12:00:00Z",
                "releaseCutoffUtc": CUTOFF,
                "provenance": {"fixture": "focused"},
            },
        ]
        linked = artifact / "linked-output.ndjson"
        linked.write_bytes(b"".join(canonical(row) + b"\n" for row in rows))
        reports: dict[str, str] = {}
        for name in ("occurrence-closure.json", "artist-binding-report.json"):
            report = artifact / name
            write_json(report, {"status": "closed"})
            reports[name] = hashlib.sha256(report.read_bytes()).hexdigest()
        route_report = artifact / "release-route-report.json"
        write_json(
            route_report,
            {
                "status": "closed",
                "routeAsOf": ROUTE,
                "releaseCutoffUtc": CUTOFF,
                "routes": {"7d": {"status": "closed"}, "all": {"status": "closed"}},
            },
        )
        reports[route_report.name] = hashlib.sha256(route_report.read_bytes()).hexdigest()
        write_json(
            artifact / "linked-output.ndjson.marker",
            {
                "kind": "linked-output",
                "status": "closed",
                "linkedOutputSha256": hashlib.sha256(linked.read_bytes()).hexdigest(),
                "reports": reports,
                "artifact": {
                    "sourceCommit": HEAD,
                    "routeAsOf": ROUTE,
                    "releaseCutoffUtc": CUTOFF,
                },
            },
        )

        source_manifest = {
            "schemaVersion": 1,
            "path": "data/7d.json",
            "rangeId": "7d",
            "sourceCommitSha": HEAD,
            "sourceBlobSha": "1" * 40,
            "sourceArtifactSha256": "2" * 64,
            "generatedAt": ROUTE,
            "acceptedVideoCount": 1,
            "acceptedOccurrenceCount": 1,
            "sourceOccurrenceSemanticsSha256": "3" * 64,
        }
        source_manifest_sha = hashlib.sha256(canonical(source_manifest)).hexdigest()
        write_json(
            artifact / "7d-manifest.json",
            {
                "handoffKind": "github-core-7d-authoritative-range",
                "status": "ready",
                "rangeId": "7d",
                "authoritativeRange": "7d",
                "rangeReset": True,
                "partialVideoRows": True,
                "rangeResetAppliedBy": "pg-adapter-authoritative-range-boundary-v2",
                "rangeResetTombstoneCount": 0,
                "sourceReachedEnd": True,
                "mediaDownloaded": False,
                "statusAuditIncluded": True,
                "mutation_count": 3,
                "acceptedVideoCount": 1,
                "acceptedOccurrenceCount": 1,
                "baseVideoCount": 1,
                "baseOccurrenceCount": 1,
                "rangeBoundaryMutationCount": 1,
                "patch_sha256": "4" * 64,
                "sourceCommitSha": HEAD,
                "sourceBlobSha": "1" * 40,
                "source_blob_sha": "1" * 40,
                "sourceArtifactSha256": "2" * 64,
                "sourceOccurrenceSemanticsSha256": "3" * 64,
                "sourceManifestSha256": source_manifest_sha,
                "sourceManifest": source_manifest,
                "sourceCAS": {
                    "sourceCommitSha": HEAD,
                    "sourceBlobSha": "1" * 40,
                    "sourceArtifactSha256": "2" * 64,
                    "sourceManifestSha256": source_manifest_sha,
                },
                "generatedAt": ROUTE,
                "routeAsOfUtc": ROUTE,
            },
        )

        artifact_proof = root / "artifact-proof.json"
        write_json(
            artifact_proof,
            {
                "kind": "github-artifact-download-proof",
                "status": "VERIFIED",
                "runId": "123",
                "artifactId": "456",
                "artifactName": "enrich-snapshot-pilot-two-day-candidate-123",
                "artifactDigest": "sha256:" + "f" * 64,
                "sourceHead": HEAD,
            },
        )
        active_proof = root / "active-proof.json"
        write_json(
            active_proof,
            {
                "kind": "active-revision-proof",
                "verified": True,
                "locked": True,
                "actual_active_revision": "active-before",
            },
        )
        return artifact, artifact_proof, active_proof

    def test_exact_artifact_binding_and_sequential_7d_to_all(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact, artifact_proof, active_proof = self.make_artifact(root)
            output = root / "output"
            phase1 = bridge.run_phase1(artifact, output, ROUTE, active_proof, artifact_proof)
            self.assertEqual(phase1["releaseRoute"], "7d")
            self.assertEqual(phase1["rangeId"], "7d")
            self.assertEqual(phase1["handoffKind"], "github-core-7d-authoritative-range")
            self.assertEqual(phase1["sourceCAS"]["sourceCommitSha"], HEAD)
            self.assertEqual(phase1["artifactBinding"]["artifactName"], "enrich-snapshot-pilot-two-day-candidate-123")
            phase1_rows = [json.loads(line) for line in (output / "phase1/candidate.ndjson").read_text().splitlines()]
            self.assertEqual({row["rangeId"] for row in phase1_rows}, {"7d"})
            self.assertTrue(all(row["partialRangeReset"] for row in phase1_rows))

            activation = root / "activation-proof.json"
            write_json(
                activation,
                {
                    "kind": "phase1-activation-proof",
                    "verified": True,
                    "locked": True,
                    "actual_activated_revision": "active-after",
                    "parent_revision_id": phase1["parent"],
                    "content_sha256": phase1["candidate"]["sha256"],
                },
            )
            phase2 = bridge.run_phase2(artifact, output, ROUTE, activation, artifact_proof)
            self.assertEqual(phase2["releaseRoute"], "all")
            self.assertEqual(phase2["rangeId"], "all")
            self.assertEqual(phase2["parent"], "active-after")
            phase2_rows = [json.loads(line) for line in (output / "phase2/candidate.ndjson").read_text().splitlines()]
            self.assertEqual({row["rangeId"] for row in phase2_rows}, {"all"})
            self.assertFalse(any(row.get("rangeId") == "7d" for row in phase2_rows))
            handoff = json.loads((output / "orchestrator-manifest.json").read_text())
            self.assertEqual(handoff["status"], "CODE_CANDIDATE_ONLY")
            self.assertEqual(handoff["parentCas"]["phase2Parent"], "active-after")

    def test_missing_artifact_proof_is_real_io_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact, _, active_proof = self.make_artifact(root)
            with self.assertRaisesRegex(bridge.Reject, "invalid/missing proof JSON"):
                bridge.run_phase1(artifact, root / "missing-output", ROUTE, active_proof, root / "missing-proof.json")

    def test_third_day_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact, artifact_proof, active_proof = self.make_artifact(root)
            linked = artifact / "linked-output.ndjson"
            third_day = {
                "linkageDay": "2026-07-21",
                "source": {"day": "2026-07-21", "sampleId": "third-day"},
                "videoId": "third-day",
                "occurrenceId": "third-day",
                "position": 0,
                "seconds": 12,
                "title": "Forbidden",
                "artist": "Fixture",
                "sourceId": "third-day",
                "sourceHash": "a" * 64,
                "rawHash": "b" * 64,
                "eventTime": "2026-07-21T12:00:00Z",
                "releaseCutoffUtc": CUTOFF,
                "provenance": {"fixture": "focused"},
            }
            linked.write_bytes(linked.read_bytes() + canonical(third_day) + b"\n")
            marker_path = artifact / "linked-output.ndjson.marker"
            marker = json.loads(marker_path.read_text())
            marker["linkedOutputSha256"] = hashlib.sha256(linked.read_bytes()).hexdigest()
            write_json(marker_path, marker)
            with self.assertRaisesRegex(bridge.Reject, "outside frozen two-day set"):
                bridge.run_phase1(artifact, root / "third-day-output", ROUTE, active_proof, artifact_proof)


if __name__ == "__main__":
    unittest.main(verbosity=2)

