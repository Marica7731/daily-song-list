#!/usr/bin/env python3
"""Serial, candidate-only two-range PG bridge orchestration."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any, Mapping


CONVERTER_PATH = Path(__file__).resolve().parents[1] / "migration" / "snapshot-recovery-to-pg.py"
SHA40 = re.compile(r"^[0-9a-f]{40}$")
SHA64 = re.compile(r"^[0-9a-f]{64}$")


class Reject(ValueError):
    code = 78


def converter() -> Any:
    spec = importlib.util.spec_from_file_location("snapshot_recovery_to_pg_candidate", CONVERTER_PATH)
    if spec is None or spec.loader is None:
        raise Reject("cannot load candidate converter")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise Reject(f"invalid/missing proof JSON: {path}") from exc
    if not isinstance(value, dict):
        raise Reject(f"proof must be an object: {path}")
    return value


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def inside(root: Path, path: Path) -> Path:
    normalized_root = root.expanduser().resolve()
    normalized_path = path.expanduser().resolve()
    try:
        normalized_path.relative_to(normalized_root)
    except ValueError as exc:
        raise Reject("orchestrator output escapes caller-provided output root") from exc
    return normalized_path


def real(value: Any, field: str, pattern: re.Pattern[str] | None = None) -> str:
    if not isinstance(value, str) or not value.strip() or "\x24{" in value or "placeholder" in value.lower():
        raise Reject(f"missing/placeholder {field}")
    if pattern is not None and not pattern.fullmatch(value):
        raise Reject(f"invalid {field}")
    return value


def artifact_binding(path: Path) -> dict[str, str]:
    value = read_json(path)
    if value.get("kind") != "github-artifact-download-proof" or value.get("status") != "VERIFIED":
        raise Reject("artifact download proof must be VERIFIED")
    run_id = real(value.get("runId"), "artifact runId")
    artifact_id = real(value.get("artifactId"), "artifact artifactId")
    name = real(value.get("artifactName"), "artifact name")
    digest = real(value.get("artifactDigest"), "artifact digest")
    source_head = real(value.get("sourceHead"), "artifact source head", SHA40)
    if not run_id.isdecimal() or not artifact_id.isdecimal():
        raise Reject("artifact runId/artifactId must be decimal")
    if name != f"enrich-snapshot-pilot-two-day-candidate-{run_id}":
        raise Reject("artifact name is not bound to exact producer run")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise Reject("artifact digest must be sha256:<64 hex>")
    return {
        "runId": run_id,
        "artifactId": artifact_id,
        "artifactName": name,
        "artifactDigest": digest,
        "sourceHead": source_head,
    }


def stage_producer_artifact_proof(
    artifact_root: Path,
    download_proof: Path,
    binding: Mapping[str, str],
) -> None:
    """Bind the verified download to the producer-root consumed by the converter.

    The bridge must consume the downloaded producer root itself.  This small
    proof sidecar is derived from the API-verified download proof; it is not a
    second artifact tree or a locally dispatched input.
    """

    root = artifact_root.expanduser().resolve()
    if not root.is_dir():
        raise Reject(f"artifact-root is not a directory: {root}")
    source = read_json(download_proof)
    workflow_name = source.get("workflowName", "enrich-snapshot-pilot")
    if not isinstance(workflow_name, str) or not workflow_name.strip():
        raise Reject("producer workflow name is missing from artifact proof")
    derived = {
        "kind": "producer-artifact-proof",
        "verified": True,
        "runId": binding["runId"],
        "artifactId": binding["artifactId"],
        "artifactName": binding["artifactName"],
        "artifactDigest": binding["artifactDigest"],
        "producerHeadSha": binding["sourceHead"],
        "workflowName": workflow_name,
    }
    target = root / "producer-artifact-proof.json"
    if target.is_file():
        existing = read_json(target)
        for key, expected in derived.items():
            if existing.get(key) != expected:
                raise Reject(f"producer artifact proof mismatch: {key}")
        return
    write_json(target, derived)


def active_revision_proof(path: Path) -> str:
    value = read_json(path)
    if value.get("kind") != "active-revision-proof" or value.get("verified") is not True or value.get("locked") is not True:
        raise Reject("active revision proof must be verified/locked")
    return real(
        value.get("actual_active_revision", value.get("actualActiveRevision")),
        "actual active revision",
    )


def phase1_activation_proof(path: Path) -> tuple[str, str, str | None]:
    value = read_json(path)
    if value.get("kind") != "phase1-activation-proof" or value.get("verified") is not True or value.get("locked") is not True:
        raise Reject("phase1 activation proof must be verified/locked")
    activated = real(
        value.get("actual_activated_revision", value.get("actualActivatedRevision")),
        "actual activated revision",
    )
    parent = real(
        value.get("parent_revision_id", value.get("parentRevisionId")),
        "phase1 activation proof parent",
    )
    content = value.get("content_sha256", value.get("contentSha256"))
    if content is not None and (not isinstance(content, str) or not SHA64.fullmatch(content)):
        raise Reject("phase1 activation proof content hash is invalid")
    return activated, parent, content


def candidate_hash(manifest: Mapping[str, Any], output: Path) -> str:
    candidate = output / str(manifest.get("candidate", {}).get("path", "candidate.ndjson"))
    if not candidate.is_file():
        raise Reject(f"missing candidate payload: {candidate}")
    digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
    if manifest.get("candidate", {}).get("sha256") != digest:
        raise Reject("candidate hash does not match manifest")
    return digest


def add_phase_fields(
    output: Path,
    manifest: Mapping[str, Any],
    phase: str,
    parent: str,
    binding: Mapping[str, str],
) -> dict[str, Any]:
    expected_range = "7d" if phase == "phase1" else "all"
    if manifest.get("releaseRoute") != expected_range or manifest.get("rangeId") != expected_range:
        raise Reject(f"{phase} manifest must be explicit rangeId={expected_range}")
    updated = dict(manifest)
    updated.update(
        {
            "phase": phase,
            "parent": parent,
            "parentProofKind": "active-revision-proof" if phase == "phase1" else "phase1-activation-proof",
            "artifactBinding": dict(binding),
            "dbMutationCount": 0,
            "activationPerformed": False,
        }
    )
    if phase == "phase1" and updated.get("sourceCommitSha") != binding["sourceHead"]:
        raise Reject("phase1 source head is not bound to downloaded artifact")
    candidate_hash(updated, output)
    write_json(output / "manifest.json", updated)
    return updated


def handoff(
    output_root: Path,
    phase1: Mapping[str, Any],
    phase2: Mapping[str, Any] | None,
    phase1_status: str,
) -> dict[str, Any]:
    value: dict[str, Any] = {
        "schemaVersion": "two-day-pg-bridge/v2-handoff",
        "status": "CODE_CANDIDATE_ONLY",
        "candidateOnly": True,
        "formalArtifact": "PENDING",
        "phaseOrder": ["phase1:7d", "phase2:all"],
        "phase1Status": phase1_status,
        "phase2Status": "phase2-candidate-generated-after-verified-proof" if phase2 else "awaiting-phase1-locked-activation-proof",
        "phase1": {"path": "phase1", **dict(phase1)},
        "phase2": {"path": "phase2", **dict(phase2)} if phase2 else None,
        "parentCas": {
            "phase1Parent": phase1.get("parent"),
            "phase2Parent": phase2.get("parent") if phase2 else None,
            "phase2MustEqualPhase1ActualActivation": True,
            "placeholderParentsAllowed": False,
        },
        "requiresSequentialActivation": True,
        "concurrency": {"group": "daily-song-list-pg-bridge-v2", "cancelInProgress": False},
        "rollback": {
            "required": True,
            "entrypoint": ".github/workflows/deploy-pg-incremental.yml:rollback",
            "candidateAction": "not-run",
        },
        "productEntrypoints": {
            "importer": "scripts/migration/import-pg-incremental.py",
            "importerWorkflow": ".github/workflows/deploy-pg-incremental.yml",
            "lockedActivationWorkflow": ".github/workflows/activate-pg-ready-candidate.yml",
        },
        "actualIo": {
            "dbMutationCount": 0,
            "activationPerformed": False,
            "dispatchPerformed": False,
        },
    }
    write_json(inside(output_root, output_root / "orchestrator-manifest.json"), value)
    write_json(inside(output_root, output_root / "manifest.json"), value)
    return value


def run_phase1(
    artifact_root: Path,
    output_root: Path,
    route_as_of: str,
    active: Path,
    artifact_proof: Path,
) -> dict[str, Any]:
    output_root = output_root.expanduser().resolve()
    phase_dir = inside(output_root, output_root / "phase1")
    if phase_dir.exists():
        raise Reject("phase1 output already exists; use a fresh output root")
    binding = artifact_binding(artifact_proof)
    stage_producer_artifact_proof(artifact_root, artifact_proof, binding)
    parent = active_revision_proof(active)
    try:
        raw = converter().convert(artifact_root, phase_dir, route_as_of, "7d")
    except ValueError as exc:
        raise Reject(f"phase1 converter rejection: {exc}") from exc
    phase = add_phase_fields(phase_dir, raw, "phase1", parent, binding)
    handoff(output_root, phase, None, "awaiting-phase1-locked-activation-proof")
    return phase


def run_phase2(
    artifact_root: Path,
    output_root: Path,
    route_as_of: str,
    activation: Path,
    artifact_proof: Path,
) -> dict[str, Any]:
    output_root = output_root.expanduser().resolve()
    phase1_dir = inside(output_root, output_root / "phase1")
    phase1 = read_json(phase1_dir / "manifest.json")
    if (
        phase1.get("phase") != "phase1"
        or phase1.get("releaseRoute") != "7d"
        or phase1.get("rangeId") != "7d"
    ):
        raise Reject("phase1 7d manifest is missing or invalid")
    binding = artifact_binding(artifact_proof)
    stage_producer_artifact_proof(artifact_root, artifact_proof, binding)
    if phase1.get("artifactBinding") != binding:
        raise Reject("phase1 artifact binding changed before phase2")
    phase1_parent = real(phase1.get("parent"), "phase1 parent")
    activated, proof_parent, content = phase1_activation_proof(activation)
    if proof_parent != phase1_parent:
        raise Reject("phase1 activation proof parent does not match phase1 parent")
    if content is not None and content != candidate_hash(phase1, phase1_dir):
        print("PHASE1_ACTIVATION_CONTENT_SHA256_OBSERVATION_ONLY", file=sys.stderr)
    phase2_dir = inside(output_root, output_root / "phase2")
    if phase2_dir.exists():
        raise Reject("phase2 output already exists; use a fresh output root")
    try:
        raw = converter().convert(artifact_root, phase2_dir, route_as_of, "all")
    except ValueError as exc:
        raise Reject(f"phase2 converter rejection: {exc}") from exc
    phase2 = add_phase_fields(phase2_dir, raw, "phase2", activated, binding)
    phase2["phase1ActualActivatedRevision"] = activated
    write_json(phase2_dir / "manifest.json", phase2)
    handoff(output_root, phase1, phase2, "phase2-candidate-generated-after-verified-proof")
    return phase2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--route-as-of", required=True)
    parser.add_argument("--artifact-proof", type=Path, required=True)
    parser.add_argument("--active-proof", type=Path)
    parser.add_argument("--phase1-activation-proof", type=Path)
    parser.add_argument("--phase", choices=("phase1", "phase2"), required=True)
    args = parser.parse_args(argv)
    try:
        if args.phase == "phase1":
            if args.active_proof is None:
                raise Reject("phase1 requires active revision proof")
            value = run_phase1(
                args.artifact_root,
                args.output_root,
                args.route_as_of,
                args.active_proof,
                args.artifact_proof,
            )
        else:
            if args.phase1_activation_proof is None:
                raise Reject("phase2 requires phase1 activation proof")
            value = run_phase2(
                args.artifact_root,
                args.output_root,
                args.route_as_of,
                args.phase1_activation_proof,
                args.artifact_proof,
            )
        print(json.dumps(value, ensure_ascii=False, sort_keys=True))
        return 0
    except Reject as exc:
        print(f"REJECT: {exc}", file=sys.stderr)
        return Reject.code
    except (OSError, TypeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
