#!/usr/bin/env python3
"""Materialize one catalog-approved local gzip fixture into runner.temp.

The catalog is deliberately local-only.  No URL, dispatch payload, controller
absolute path, or network fallback can select the input bytes.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


HEX40 = re.compile(r"^[0-9a-f]{40}$")


class MaterializationError(ValueError):
    pass


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise MaterializationError(f"cannot read JSON {path}: {exc}") from exc


def load_catalog(catalog_path: Path) -> dict[str, Any]:
    catalog = read_json(catalog_path.resolve())
    if not isinstance(catalog, dict):
        raise MaterializationError("catalog must be an object")
    if catalog.get("status") != "CANDIDATE_ONLY" or catalog.get("releaseEligible") is not False:
        raise MaterializationError("catalog is not a non-release candidate catalog")
    if catalog.get("materialization", {}).get("localOnly") is not True:
        raise MaterializationError("catalog must declare localOnly=true")
    allowed = catalog.get("allowedFixturePaths")
    if allowed != [
        "test/fixtures/snapshot-pilot/jul29-sample25.json.gz",
        "test/fixtures/snapshot-pilot/jul22-sample19.json.gz",
    ]:
        raise MaterializationError("catalog allowedFixturePaths must be the two fixed local gzip paths")
    return catalog


def catalog_entry(catalog: dict[str, Any], sample_id: str) -> dict[str, Any]:
    entry = catalog.get("samples", {}).get(sample_id)
    if not isinstance(entry, dict):
        raise MaterializationError(f"unknown sample id: {sample_id}")
    return entry


def safe_relative_fixture(catalog: dict[str, Any], entry: dict[str, Any]) -> str:
    fixture = entry.get("fixturePath")
    allowed = catalog["allowedFixturePaths"]
    if not isinstance(fixture, str) or fixture not in allowed:
        raise MaterializationError("fixturePath is not one of the two catalog allowlisted paths")
    path = Path(fixture)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise MaterializationError(f"fixturePath is not a safe relative path: {fixture}")
    if path.parent.as_posix() != catalog.get("fixtureRoot"):
        raise MaterializationError(f"fixturePath is outside catalog fixtureRoot: {fixture}")
    if path.suffix != ".gz":
        raise MaterializationError("fixturePath must be a gzip fixture")
    return fixture


def resolve_local_fixture(workspace: Path, fixture: str, fixture_root: str) -> Path:
    workspace = workspace.resolve(strict=True)
    root = workspace / fixture_root
    if root.is_symlink():
        raise MaterializationError(f"fixture root must not be a symlink: {root}")
    root_resolved = root.resolve(strict=True)
    if root_resolved != root or not root_resolved.is_dir():
        raise MaterializationError(f"fixture root is not a regular directory: {root}")
    candidate = workspace / fixture
    if candidate.parent != root:
        raise MaterializationError(f"fixture path has unexpected parent: {candidate}")
    if candidate.is_symlink() or not candidate.is_file():
        raise MaterializationError(f"fixture must be a regular local file: {candidate}")
    resolved = candidate.resolve(strict=True)
    try:
        resolved.relative_to(workspace)
    except ValueError as exc:
        raise MaterializationError(f"fixture resolves outside workspace: {resolved}") from exc
    if resolved != candidate:
        raise MaterializationError(f"fixture path resolves through a symlink: {candidate}")
    return candidate


def extracted_videos(payload: Any, sample_id: str) -> tuple[list[dict[str, Any]], list[str]]:
    if isinstance(payload, list):
        values = payload
        routes = [value.get("route") if isinstance(value, dict) else None for value in values]
    elif isinstance(payload, dict) and isinstance(payload.get("videos"), list):
        values = payload["videos"]
        top_route = payload.get("trialRoute")
        routes = [
            value.get("route", top_route) if isinstance(value, dict) else None
            for value in values
        ]
    else:
        raise MaterializationError(f"{sample_id} sample has no supported video array")
    if not all(isinstance(value, dict) for value in values):
        raise MaterializationError(f"{sample_id} sample contains a non-object video")
    if any(not isinstance(route, str) or not route for route in routes):
        raise MaterializationError(f"{sample_id} sample has a missing route")
    counts: dict[str, int] = {}
    for route in routes:
        counts[route] = counts.get(route, 0) + 1
    signature = ",".join(f"{key}={value}" for key, value in counts.items())
    return [dict(value) for value in values], [signature, json.dumps(counts, sort_keys=True)]


def event_date(value: Any) -> str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return dt.datetime.fromtimestamp(value / 1000, tz=dt.timezone.utc).date().isoformat()
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str) and value.strip():
        candidate = value.strip().replace("Z", "+00:00")
        try:
            return dt.datetime.fromisoformat(candidate).date().isoformat()
        except ValueError:
            return None
    return None


def event_date_candidates(value: dict[str, Any]) -> list[Any]:
    evidence = value.get("dateEvidence")
    evidence_values = []
    if isinstance(evidence, dict):
        evidence_values.extend(
            evidence.get(key)
            for key in ("publishedAtIso", "publishedAt", "publishedTimestampIsoUtc", "publishedTimestamp")
        )
    return [
        value.get("eventTime"),
        value.get("publishedAtIso"),
        value.get("publishedAt"),
        value.get("publishedTimestampIsoUtc"),
        value.get("publishedTimestamp"),
        value.get("date"),
        *evidence_values,
    ]


def validate_metadata(payload: Any, entry: dict[str, Any], sample_id: str) -> list[str]:
    values, route_info = extracted_videos(payload, sample_id)
    expected_count = int(entry["count"])
    if len(values) != expected_count:
        raise MaterializationError(f"sample count mismatch: expected {expected_count}, got {len(values)}")
    expected_routes = {str(key): int(value) for key, value in entry["routeCounts"].items()}
    actual_routes = json.loads(route_info[1])
    if actual_routes != expected_routes:
        raise MaterializationError(f"route count mismatch: expected {expected_routes}, got {actual_routes}")
    if route_info[0] != entry["routeSignature"]:
        raise MaterializationError(f"route signature mismatch: expected {entry['routeSignature']}, got {route_info[0]}")
    sample_date = entry.get("sampleDate")
    if not isinstance(sample_date, str) or event_date(sample_date) != sample_date:
        raise MaterializationError("catalog sampleDate must be an ISO date")
    date_counts: dict[str, int] = {}
    for index, value in enumerate(values):
        video_id = value.get("videoId")
        if not isinstance(video_id, str) or not video_id:
            raise MaterializationError(f"sample row {index} has no videoId")
        occurrences = value.get("occurrences")
        if not isinstance(occurrences, list):
            occurrences = value.get("songs")
        units = occurrences if int(entry.get("occurrenceCount", 0)) > 0 and isinstance(occurrences, list) else [value]
        for unit_index, unit in enumerate(units):
            unit_value = unit if isinstance(unit, dict) else value
            candidates = [*event_date_candidates(unit_value), *event_date_candidates(value)]
            date = next((parsed for candidate in candidates if (parsed := event_date(candidate))), None)
            if date is None:
                raise MaterializationError(f"sample row {index} unit {unit_index} has no usable event date evidence")
            date_counts[date] = date_counts.get(date, 0) + 1
    if date_counts != {str(key): int(value) for key, value in entry["eventDateCounts"].items()}:
        raise MaterializationError(f"event date closure mismatch: expected {entry['eventDateCounts']}, got {date_counts}")
    ids: list[str] = []
    seen: set[str] = set()
    for index, value in enumerate(values):
        video_id = value["videoId"]
        if video_id in seen:
            raise MaterializationError(f"duplicate videoId: {video_id}")
        seen.add(video_id)
        ids.append(video_id)
    return ids


def child_path(root: Path, name: str) -> Path:
    root = root.resolve()
    child = (root / name).resolve()
    if child.parent != root:
        raise MaterializationError(f"unsafe output path: {child}")
    return child


def materialize(args: argparse.Namespace) -> dict[str, Any]:
    source_commit = str(args.source_commit).lower()
    if not HEX40.fullmatch(source_commit):
        raise MaterializationError("source_commit must be exactly 40 lowercase hexadecimal characters")
    catalog_path = args.catalog.resolve(strict=True)
    catalog = load_catalog(catalog_path)
    entry = catalog_entry(catalog, args.sample_id)
    fixture = safe_relative_fixture(catalog, entry)
    local_fixture = resolve_local_fixture(args.workspace, fixture, str(catalog["fixtureRoot"]))
    gzip_bytes = local_fixture.read_bytes()
    actual_gzip_sha = sha256_bytes(gzip_bytes)
    if actual_gzip_sha != entry["gzipSha256"]:
        raise MaterializationError(f"gzip SHA-256 mismatch: expected {entry['gzipSha256']}, got {actual_gzip_sha}")
    if len(gzip_bytes) != int(entry["gzipBytes"]):
        raise MaterializationError(f"gzip byte count mismatch: expected {entry['gzipBytes']}, got {len(gzip_bytes)}")
    try:
        raw_bytes = gzip.decompress(gzip_bytes)
    except (OSError, EOFError) as exc:
        raise MaterializationError(f"invalid gzip fixture: {exc}") from exc
    actual_sample_sha = sha256_bytes(raw_bytes)
    if actual_sample_sha != entry["sampleSha256"]:
        raise MaterializationError(f"decompressed sample SHA-256 mismatch: expected {entry['sampleSha256']}, got {actual_sample_sha}")
    if len(raw_bytes) != int(entry["sampleBytes"]):
        raise MaterializationError(f"sample byte count mismatch: expected {entry['sampleBytes']}, got {len(raw_bytes)}")
    try:
        payload = json.loads(raw_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MaterializationError(f"decompressed sample is not UTF-8 JSON: {exc}") from exc
    ids = validate_metadata(payload, entry, args.sample_id)

    output_root = args.output_root.resolve()
    raw_root = output_root / "raw-input"
    raw_root.mkdir(parents=True, exist_ok=True)
    raw_path = child_path(raw_root, "sample.json")
    raw_path.write_bytes(raw_bytes)
    manifest = {
        "manifestType": "luna-max-snapshot-pilot-input",
        "schemaVersion": 2,
        "status": "MATERIALIZED",
        "releaseEligible": False,
        "sampleId": args.sample_id,
        "sourceCommit": source_commit,
        "fixture": {
            "path": fixture,
            "realpath": str(local_fixture),
            "bytes": len(gzip_bytes),
            "sha256": actual_gzip_sha,
            "compression": "gzip",
            "deterministic": "verified_against_catalog"
        },
        "rawInput": {
            "path": str(raw_path),
            "bytes": len(raw_bytes),
            "sha256": actual_sample_sha,
            "count": len(ids),
            "sampleDate": entry["sampleDate"],
            "routeSignature": entry["routeSignature"],
            "expectedIds": ids,
            "eventDateCounts": entry["eventDateCounts"]
        },
        "materialization": {
            "localOnly": True,
            "network": False,
            "fixtureCommitMustEqualSourceCommit": True,
            "checkoutCommitCheck": "runner verifies source_commit == github.sha == HEAD"
        },
        "NOT_FOR_RELEASE": True
    }
    (output_root / "input-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--sample-id", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--output-root", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        manifest = materialize(args)
    except (MaterializationError, OSError, ValueError) as exc:
        print(json.dumps({"status": "input_error", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, "sampleId": manifest["sampleId"], "count": manifest["rawInput"]["count"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
