#!/usr/bin/env python3
"""Materialize the fixed artifact's two raw-input/manifests only.

This is a candidate-only, filesystem-only gate.  It intentionally ignores the
old provider/enriched files that are also present in the downloaded artifact.
No route time is inferred from capture time, sample date, or the current clock.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


REJECT = 78
SOURCE_RUN_ID = "30765216583"
SOURCE_ARTIFACT_ID = "8838723011"
SOURCE_ARTIFACT_DIGEST = "sha256:414372e0fedbfe94d6b187df75ec35e12dc3af70061d678eb29ab56fc0ec3fa1"
STRICT_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

SAMPLES: dict[str, dict[str, Any]] = {
    "jul29-25": {
        "sampleId": "jul29-25",
        "linkageSampleId": "jul29-sample25",
        "videoCount": 25,
        "rawSongCount": None,
        "rawSha256": "4b53aeb1a7b72c4efc34c6fa972b60a245e6a6bda49868f38d145fdc4c220fcf",
    },
    "jul22-19": {
        "sampleId": "jul22-19",
        "linkageSampleId": "jul22-raw456",
        "videoCount": 19,
        "rawSongCount": 456,
        "rawSha256": "e882b4387553f67c86db53877d025614d5fc808104490c3cdbbc195a4e697eb6",
    },
}


class RejectError(ValueError):
    pass


def reject(message: str) -> None:
    raise RejectError(message)


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        reject(f"json-read-failed:{path}:{exc}")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_route(value: str) -> datetime:
    if not STRICT_UTC.fullmatch(value):
        reject("route-as-of-must-be-strict-utc-iso:YYYY-MM-DDTHH:MM:SSZ")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        reject(f"route-as-of-invalid:{exc}")


def verify_download_proof(path: Path) -> dict[str, Any]:
    proof = read_json(path)
    if not isinstance(proof, dict):
        reject("download-proof-not-object")
    if str(proof.get("runId")) != SOURCE_RUN_ID:
        reject(f"artifact-run-id-mismatch:expected={SOURCE_RUN_ID}:actual={proof.get('runId')}")
    if str(proof.get("artifactId")) != SOURCE_ARTIFACT_ID:
        reject(f"artifact-id-mismatch:expected={SOURCE_ARTIFACT_ID}:actual={proof.get('artifactId')}")
    actual = proof.get("actualDigest") or proof.get("artifactDigest")
    if str(actual) != SOURCE_ARTIFACT_DIGEST:
        reject(f"artifact-digest-mismatch:expected={SOURCE_ARTIFACT_DIGEST}:actual={actual}")
    if proof.get("status") not in {None, "VERIFIED"}:
        reject(f"artifact-download-not-verified:{proof.get('status')}")
    return proof


def locate_direct_manifests(artifact_root: Path) -> dict[str, Path]:
    found: dict[str, Path] = {}
    for path in artifact_root.rglob("input-manifest.json"):
        sample_id = path.parent.name
        if sample_id in SAMPLES:
            if sample_id in found:
                reject(f"duplicate-direct-input-manifest:{sample_id}")
            found[sample_id] = path
    if set(found) != set(SAMPLES):
        reject(f"fixed-artifact-layout-mismatch:found={sorted(found)}:expected={sorted(SAMPLES)}")
    return found


def raw_rows(payload: Any, sample_id: str) -> list[dict[str, Any]]:
    if sample_id == "jul29-25":
        rows = payload
    else:
        rows = payload.get("videos") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        reject(f"raw-shape-invalid:{sample_id}")
    return rows


def raw_song_count(rows: list[dict[str, Any]], sample_id: str) -> int | None:
    if sample_id == "jul29-25":
        return None
    total = 0
    for row in rows:
        songs = row.get("songs")
        if not isinstance(songs, list):
            reject(f"raw-songs-missing:{sample_id}:{row.get('videoId')}")
        total += len(songs)
    return total


def ignored_provider_paths(artifact_root: Path) -> list[str]:
    ignored: list[str] = []
    for path in artifact_root.rglob("*"):
        if not path.is_file():
            continue
        name = path.name.lower()
        if name in {"provider.raw.ndjson", "enriched-output.ndjson"} or name.startswith("provider") or name.startswith("enriched"):
            ignored.append(path.relative_to(artifact_root).as_posix())
    return sorted(ignored)


def materialize(args: argparse.Namespace) -> int:
    artifact_root = args.artifact_root.resolve()
    if not artifact_root.is_dir():
        reject(f"artifact-root-missing:{artifact_root}")
    proof = verify_download_proof(args.download_proof.resolve())
    route = parse_route(args.route_as_of_utc)
    cutoff = route - timedelta(days=7)
    manifests = locate_direct_manifests(artifact_root)
    ignored = ignored_provider_paths(artifact_root)
    if not ignored:
        reject("old-provider-enriched-evidence-not-observed")

    output = args.output_root.resolve()
    if output.exists() and any(output.iterdir()):
        reject(f"output-root-must-be-empty:{output}")
    output.mkdir(parents=True, exist_ok=True)
    selected: list[dict[str, Any]] = []
    counts: dict[str, Any] = {"jul29VideoCount": 0, "jul22VideoCount": 0, "jul22RawSongCount": 0}
    selected_ids: list[str] = []

    for sample_id in ("jul29-25", "jul22-19"):
        spec = SAMPLES[sample_id]
        manifest_path = manifests[sample_id]
        day_root = manifest_path.parent
        raw_path = day_root / "raw-input" / "sample.json"
        if not raw_path.is_file():
            reject(f"raw-input-missing:{sample_id}:{raw_path}")
        manifest = read_json(manifest_path)
        if not isinstance(manifest, dict):
            reject(f"input-manifest-not-object:{sample_id}")
        if manifest.get("sampleId") != sample_id:
            reject(f"input-manifest-sample-mismatch:{sample_id}:{manifest.get('sampleId')}")
        if manifest.get("NOT_FOR_RELEASE") is not True or manifest.get("releaseEligible") is not False:
            reject(f"input-manifest-release-gate-mismatch:{sample_id}")
        raw_meta = manifest.get("rawInput")
        if not isinstance(raw_meta, dict):
            reject(f"raw-input-metadata-missing:{sample_id}")
        expected_sha = str(raw_meta.get("sha256", "")).lower()
        if expected_sha != spec["rawSha256"]:
            reject(f"frozen-raw-sha-contract-mismatch:{sample_id}:manifest={expected_sha}")
        actual_sha = sha256_file(raw_path)
        if actual_sha != expected_sha:
            reject(f"raw-input-sha256-mismatch:{sample_id}:expected={expected_sha}:actual={actual_sha}")
        payload = read_json(raw_path)
        rows = raw_rows(payload, sample_id)
        ids = [row.get("videoId") for row in rows]
        expected_ids = raw_meta.get("expectedIds")
        if len(rows) != spec["videoCount"] or any(not isinstance(value, str) or not value for value in ids):
            reject(f"raw-video-count-or-id-mismatch:{sample_id}")
        if len(set(ids)) != len(ids):
            reject(f"raw-duplicate-video-id:{sample_id}")
        if isinstance(expected_ids, list) and ids != expected_ids:
            reject(f"raw-video-order-or-id-mismatch:{sample_id}")
        songs = raw_song_count(rows, sample_id)
        if songs != spec["rawSongCount"]:
            reject(f"raw-song-count-mismatch:{sample_id}:expected={spec['rawSongCount']}:actual={songs}")

        target = output / "input" / sample_id
        target.mkdir(parents=True, exist_ok=True)
        (target / "raw-input").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(raw_path, target / "raw-input" / "sample.json")
        shutil.copyfile(manifest_path, target / "input-manifest.json")
        write_json(
            target / "metadata.json",
            {
                "schemaVersion": "two-day-route-metadata/v2",
                "sampleId": sample_id,
                "linkageSampleId": spec["linkageSampleId"],
                "sourceManifestPath": str(manifest_path.relative_to(artifact_root)).replace("\\", "/"),
                "sourceCommit": manifest.get("sourceCommit"),
                "routeAsOfUtc": args.route_as_of_utc,
                "releaseCutoffUtc": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "inclusiveWindow": {
                    "fromUtc": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "toUtc": args.route_as_of_utc,
                },
                "source": "workflow_dispatch.route_as_of_utc",
                "providerInput": False,
            },
        )
        write_json(target / "expected-ids.json", ids)
        selected.extend(
            {
                "sampleId": sample_id,
                "kind": kind,
                "path": str(path.relative_to(artifact_root)).replace("\\", "/"),
                "sha256": sha256_file(path),
                "bytes": path.stat().st_size,
            }
            for kind, path in (("raw-input", raw_path), ("input-manifest", manifest_path))
        )
        selected_ids.append(sample_id)
        counts["jul29VideoCount" if sample_id == "jul29-25" else "jul22VideoCount"] = len(rows)
        if sample_id == "jul22-19":
            counts["jul22RawSongCount"] = songs

    marker = output / "NOT_FOR_RELEASE.marker"
    marker.write_text("MATERIALIZED_ROUTE_VERIFIED\n", encoding="utf-8")
    report = {
        "schemaVersion": "two-day-selfcontained-materialize/v2",
        "status": "MATERIALIZED_ROUTE_VERIFIED",
        "NOT_FOR_RELEASE": True,
        "releaseEligible": False,
        "sourceRunId": SOURCE_RUN_ID,
        "sourceArtifactId": SOURCE_ARTIFACT_ID,
        "sourceArtifactDigest": SOURCE_ARTIFACT_DIGEST,
        "downloadProof": proof,
        "sampleIds": selected_ids,
        "selectedFileCount": len(selected),
        "selectedFiles": selected,
        "ignoredProviderArtifactCount": len(ignored),
        "ignoredProviderArtifacts": ignored,
        "counts": counts,
        "routeAsOfUtc": args.route_as_of_utc,
        "releaseCutoffUtc": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "inclusiveWindow": {
            "fromUtc": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "toUtc": args.route_as_of_utc,
        },
        "providerInput": False,
        "closure": "provider-generated-during-rerun",
        "firstError": None,
        "markerSha256": sha256_file(marker),
    }
    write_json(output / "materialized-manifest.json", report)
    print("MATERIALIZE_OK " + json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--download-proof", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--route-as-of-utc", required=True)
    args = parser.parse_args(argv)
    try:
        return materialize(args)
    except RejectError as exc:
        print(f"REJECT: {exc}", file=sys.stderr)
        return REJECT


if __name__ == "__main__":
    raise SystemExit(main())
