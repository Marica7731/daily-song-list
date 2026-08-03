#!/usr/bin/env python3
"""Serial candidate builder for the two-day PG bridge v1 contract.

This script has no PG, GitHub, VPS, or activation client.  The workflow owns
the real importer/locked-activation calls; this module only accepts proofs,
builds the next isolated artifact, and fails closed on an invalid parent.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence


SOURCE_ROOT = Path(__file__).resolve().parents[2]
CONVERTER_PATH = SOURCE_ROOT / "scripts" / "migration" / "snapshot-recovery-to-pg.py"
PLACEHOLDER = re.compile(r"\$\{|placeholder|<[^>]+>", re.IGNORECASE)


class Reject(ValueError):
    code = 78


def converter() -> Any:
    spec = importlib.util.spec_from_file_location("snapshot_recovery_to_pg", CONVERTER_PATH)
    if spec is None or spec.loader is None:
        raise Reject("cannot load stable converter")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise Reject(f"invalid proof/manifest JSON: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise Reject(f"{path} must contain an object")
    return value


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def normalized_output_root(path: Path) -> Path:
    try:
        return path.expanduser().resolve()
    except OSError as exc:
        raise Reject(f"invalid caller-provided output root: {exc}") from exc


def ensure_inside(root: Path, path: Path) -> Path:
    normalized_root = normalized_output_root(root)
    normalized_path = path.expanduser().resolve()
    try:
        normalized_path.relative_to(normalized_root)
    except ValueError as exc:
        raise Reject("orchestrator output escapes the caller-provided output root") from exc
    return normalized_path


def actual_revision(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip() or PLACEHOLDER.search(value):
        raise Reject(f"{field} must be a real non-placeholder revision")
    return value


def read_proof(path: Path, kind: str) -> dict[str, Any]:
    proof = read_json(path)
    if proof.get("kind") != kind or proof.get("verified") is not True or proof.get("locked") is not True:
        raise Reject(f"invalid {kind}; verified locked proof required")
    if kind == "active-revision-proof":
        actual_revision(proof.get("actual_active_revision", proof.get("actualActiveRevision")), "actual active revision")
    else:
        actual_revision(
            proof.get("actual_activated_revision", proof.get("actualActivatedRevision")),
            "actual activated revision",
        )
        actual_revision(
            proof.get("parent_revision_id", proof.get("parentRevisionId")),
            "phase1 activation proof parent",
        )
    return proof


def candidate_hash(manifest: Mapping[str, Any], output: Path) -> str:
    candidate_path = output / str(manifest.get("candidate", {}).get("path", "candidate.ndjson"))
    if not candidate_path.is_file():
        raise Reject(f"missing candidate payload: {candidate_path}")
    digest = hashlib.sha256(candidate_path.read_bytes()).hexdigest()
    declared = manifest.get("candidate", {}).get("sha256")
    if declared != digest:
        raise Reject("candidate hash does not match manifest")
    return digest


def augment_phase_manifest(
    output: Path,
    manifest: Mapping[str, Any],
    phase: str,
    parent: str,
    parent_kind: str,
) -> dict[str, Any]:
    updated = dict(manifest)
    updated.update(
        {
            "phase": phase,
            "parent": parent,
            "parentProofKind": parent_kind,
            "dbMutationCount": 0,
            "activationPerformed": False,
        }
    )
    candidate_hash(updated, output)
    write_json(output / "manifest.json", updated)
    return updated


def write_handoff(
    output_root: Path,
    phase1: Mapping[str, Any],
    phase2: Mapping[str, Any] | None,
    phase1_status: str,
) -> dict[str, Any]:
    output_root = normalized_output_root(output_root)
    handoff_path = ensure_inside(output_root, output_root / "orchestrator-manifest.json")
    manifest_path = ensure_inside(output_root, output_root / "manifest.json")
    phase1_parent = phase1.get("parent")
    phase2_parent = phase2.get("parent") if phase2 else None
    handoff: dict[str, Any] = {
        "schemaVersion": "two-day-pg-bridge/v1-handoff",
        "status": "READY_CANDIDATE_ONLY",
        "candidateOnly": True,
        "phaseOrder": ["phase1:7d", "phase2:all"],
        "phase1Status": phase1_status,
        "phase1": {"path": "phase1", **dict(phase1)},
        "phase2": {"path": "phase2", **dict(phase2)} if phase2 else None,
        "parentCas": {
            "phase1Parent": phase1_parent,
            "phase2Parent": phase2_parent,
            "phase2MustEqualPhase1ActualActivation": True,
            "placeholderParentsAllowed": False,
        },
        "requiresSequentialActivation": True,
        "productEntrypoints": {
            "importer": "scripts/migration/import-pg-incremental.py",
            "importerWorkflow": ".github/workflows/deploy-pg-incremental.yml",
            "lockedActivationWorkflow": ".github/workflows/activate-pg-ready-candidate.yml",
        },
        "concurrency": {"group": "daily-song-list-pg-bridge-v1", "cancelInProgress": False},
        "rollback": {
            "required": True,
            "entrypoint": ".github/workflows/deploy-pg-incremental.yml:rollback",
            "candidateAction": "not-run",
        },
        "actualIo": {"dbMutationCount": 0, "activationPerformed": False, "dispatchPerformed": False},
    }
    write_json(handoff_path, handoff)
    write_json(manifest_path, handoff)
    return handoff


def run_phase1(artifact_root: Path, output_root: Path, route_as_of: str, active_proof: Path) -> dict[str, Any]:
    output_root = normalized_output_root(output_root)
    phase1_dir = ensure_inside(output_root, output_root / "phase1")
    proof = read_proof(active_proof, "active-revision-proof")
    parent = actual_revision(
        proof.get("actual_active_revision", proof.get("actualActiveRevision")),
        "actual active revision",
    )
    if phase1_dir.exists():
        raise Reject("phase1 output already exists; use a fresh output root")
    bridge = converter()
    # If converter validation fails, this function raises before any phase2
    # directory or phase2 manifest can be created.
    try:
        raw_manifest = bridge.convert(artifact_root, phase1_dir, route_as_of, "7d")
    except ValueError as exc:
        raise Reject(f"phase1 converter rejection: {exc}") from exc
    phase1 = augment_phase_manifest(phase1_dir, raw_manifest, "phase1", parent, "active-revision-proof")
    output_root.mkdir(parents=True, exist_ok=True)
    write_handoff(output_root, phase1, None, "awaiting-phase1-locked-activation-proof")
    return phase1


def run_phase2(
    artifact_root: Path,
    output_root: Path,
    route_as_of: str,
    phase1_activation_proof: Path,
) -> dict[str, Any]:
    output_root = normalized_output_root(output_root)
    phase1_dir = ensure_inside(output_root, output_root / "phase1")
    phase1_manifest = read_json(phase1_dir / "manifest.json")
    if phase1_manifest.get("phase") != "phase1":
        raise Reject("phase1 manifest is missing or has the wrong phase")
    phase1_parent = actual_revision(phase1_manifest.get("parent"), "phase1 parent")
    phase1_candidate = candidate_hash(phase1_manifest, phase1_dir)
    proof = read_proof(phase1_activation_proof, "phase1-activation-proof")
    proof_parent = actual_revision(
        proof.get("parent_revision_id", proof.get("parentRevisionId")),
        "phase1 activation proof parent",
    )
    activated = actual_revision(
        proof.get("actual_activated_revision", proof.get("actualActivatedRevision")),
        "actual activated revision",
    )
    if proof_parent != phase1_parent:
        raise Reject("phase1 activation proof parent does not match phase1 actual current active")
    proof_content = proof.get("content_sha256", proof.get("contentSha256"))
    if proof_content is not None and proof_content != phase1_candidate:
        raise Reject("phase1 activation proof content does not match phase1 candidate")
    phase2_dir = ensure_inside(output_root, output_root / "phase2")
    if phase2_dir.exists():
        raise Reject("phase2 output already exists; use a fresh output root")
    bridge = converter()
    try:
        raw_manifest = bridge.convert(artifact_root, phase2_dir, route_as_of, "all")
    except ValueError as exc:
        raise Reject(f"phase2 converter rejection: {exc}") from exc
    phase2 = augment_phase_manifest(output_root / "phase2", raw_manifest, "phase2", activated, "phase1-activation-proof")
    phase2["phase1ActualActivatedRevision"] = activated
    write_json(phase2_dir / "manifest.json", phase2)
    write_handoff(output_root, phase1_manifest, phase2, "phase2-candidate-generated-after-verified-proof")
    return phase2


def orchestrate(
    artifact_root: Path,
    output_root: Path,
    route_as_of: str,
    active_proof: Path,
    phase1_activation_proof: Path | None = None,
) -> dict[str, Any]:
    phase1 = run_phase1(artifact_root, output_root, route_as_of, active_proof)
    if phase1_activation_proof is None:
        return read_json(output_root / "orchestrator-manifest.json")
    run_phase2(artifact_root, output_root, route_as_of, phase1_activation_proof)
    return read_json(output_root / "orchestrator-manifest.json")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--route-as-of", required=True)
    parser.add_argument("--active-proof", type=Path, required=True)
    parser.add_argument("--phase", choices=("phase1", "phase2", "all"), default="phase1")
    parser.add_argument("--phase1-activation-proof", type=Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        if args.phase == "phase1":
            value = run_phase1(args.artifact_root, args.output_root, args.route_as_of, args.active_proof)
        elif args.phase == "phase2":
            if args.phase1_activation_proof is None:
                raise Reject("phase2 requires --phase1-activation-proof")
            value = run_phase2(args.artifact_root, args.output_root, args.route_as_of, args.phase1_activation_proof)
        else:
            value = orchestrate(args.artifact_root, args.output_root, args.route_as_of, args.active_proof, args.phase1_activation_proof)
        print(json.dumps(value, ensure_ascii=False, sort_keys=True))
        return 0
    except Reject as exc:
        print(f"REJECT: {exc}", file=sys.stderr)
        return exc.code
    except (OSError, TypeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
