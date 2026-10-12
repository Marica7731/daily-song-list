#!/usr/bin/env python3
"""Build an importer-compatible two-day PG bridge candidate.

The converter is intentionally side-effect limited: it validates a formal
linkage handoff, routes occurrences by source ``eventTime``, groups them into
the top-level ``videoId``/``songs[]`` shape accepted by the live importer, and
writes an isolated candidate plus manifest.  It never connects to PG and
never dispatches or activates an Action.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


EXIT_REJECTED = 78
SUPPORTED_SOURCES = {
    ("2026-07-29", "sample25"),
    ("2026-07-22", "raw456"),
}
REQUIRED_REPORTS = (
    "occurrence-closure.json",
    "artist-binding-report.json",
    "release-route-report.json",
)
MARKER_NAMES = (
    "linked-output.ndjson.marker",
    "linked-output.marker",
    "marker.json",
    "marker",
)
HEX64 = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)
HEX40 = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)
AUTH_MANIFEST_NAMES = (
    "7d-manifest.json",
    "authoritative-7d-manifest.json",
    "candidate/7d-manifest.json",
    "candidate/authoritative-7d-manifest.json",
)
AUTH_COPY_FIELDS = (
    "handoffKind",
    "rangeId",
    "authoritativeRange",
    "rangeReset",
    "partialVideoRows",
    "rangeResetAppliedBy",
    "rangeResetTombstoneCount",
    "sourceReachedEnd",
    "mediaDownloaded",
    "statusAuditIncluded",
    "mutation_count",
    "acceptedVideoCount",
    "acceptedOccurrenceCount",
    "baseVideoCount",
    "baseOccurrenceCount",
    "rangeBoundaryMutationCount",
    "patch_sha256",
    "sourceBlobSha",
    "source_blob_sha",
    "sourceArtifactSha256",
    "sourceOccurrenceSemanticsSha256",
    "sourceManifestSha256",
    "sourceManifest",
    "sourceCommitSha",
    "generatedAt",
    "sourceCAS",
)


class Reject(ValueError):
    """A deterministic, non-release input-contract rejection."""

    code = EXIT_REJECTED


def _require_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise Reject(f"missing/invalid {field}")
    return value


def _require_sha(value: Any, field: str, width: int) -> str:
    value_text = _require_text(value, field).lower()
    pattern = HEX40 if width == 40 else HEX64
    if not pattern.fullmatch(value_text):
        raise Reject(f"invalid {field}: expected sha{width}")
    return value_text


def _require_positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise Reject(f"missing/invalid {field}")
    return value


def _authoritative_manifest_path(artifact: Path) -> Path:
    candidates = [artifact / name for name in AUTH_MANIFEST_NAMES if (artifact / name).is_file()]
    if len(candidates) != 1:
        if not candidates:
            raise Reject("missing formal authoritative 7d manifest")
        raise Reject("ambiguous formal authoritative 7d manifest")
    return candidates[0]


def load_authoritative_7d_manifest(
    artifact: Path,
    route_as_of: datetime,
    linkage_metadata: Mapping[str, Any],
) -> dict[str, Any]:
    manifest_path = _authoritative_manifest_path(artifact)
    value = read_object(manifest_path, "authoritative 7d manifest")
    if value.get("handoffKind") != "github-core-7d-authoritative-range":
        raise Reject("authoritative 7d manifest handoffKind is missing/invalid")
    if value.get("status") != "ready":
        raise Reject("authoritative 7d manifest status is not ready")
    if value.get("rangeId") != "7d" or value.get("authoritativeRange") != "7d":
        raise Reject("authoritative 7d manifest rangeId is not 7d")
    if value.get("rangeReset") is not True:
        raise Reject("authoritative 7d manifest rangeReset is missing/false")
    source_cas = value.get("sourceCAS")
    if not isinstance(source_cas, Mapping):
        raise Reject("authoritative 7d manifest sourceCAS is missing")
    for key, width in (
        ("sourceCommitSha", 40),
        ("sourceBlobSha", 40),
        ("sourceArtifactSha256", 64),
        ("sourceManifestSha256", 64),
    ):
        top = _require_sha(value.get(key), key, width)
        nested = _require_sha(source_cas.get(key), f"sourceCAS.{key}", width)
        if top != nested:
            raise Reject(f"authoritative 7d sourceCAS mismatch: {key}")
    for key in ("partialVideoRows", "sourceReachedEnd", "statusAuditIncluded"):
        if value.get(key) is not True:
            raise Reject(f"authoritative 7d manifest {key} is missing/false")
    if value.get("mediaDownloaded") is not False:
        raise Reject("authoritative 7d manifest mediaDownloaded must be false")
    if value.get("rangeResetAppliedBy") != "pg-adapter-authoritative-range-boundary-v2":
        raise Reject("authoritative 7d range reset implementation is invalid")
    if value.get("rangeResetTombstoneCount") != 0:
        raise Reject("authoritative 7d range reset tombstone count is not zero")
    for key in (
        "mutation_count",
        "acceptedVideoCount",
        "acceptedOccurrenceCount",
        "baseVideoCount",
        "baseOccurrenceCount",
        "rangeBoundaryMutationCount",
    ):
        _require_positive_int(value.get(key), f"authoritative 7d {key}")
    _require_sha(value.get("patch_sha256"), "authoritative 7d patch_sha256", 64)
    source_manifest = value.get("sourceManifest")
    if not isinstance(source_manifest, Mapping) or source_manifest.get("rangeId") != "7d":
        raise Reject("authoritative 7d sourceManifest is missing/invalid")
    for key in ("sourceCommitSha", "sourceBlobSha", "sourceArtifactSha256"):
        if source_manifest.get(key) != value.get(key):
            raise Reject(f"authoritative 7d sourceManifest {key} mismatch")
    if _require_sha(value.get("sourceManifestSha256"), "sourceManifestSha256", 64) != sha256_bytes(canon(source_manifest)):
        raise Reject("authoritative 7d sourceManifest SHA-256 mismatch")
    report_as_of = value.get("routeAsOfUtc", value.get("routeAsOf", value.get("route_as_of")))
    if report_as_of is None or parse_time(report_as_of, "authoritative 7d routeAsOf") != route_as_of:
        raise Reject("authoritative 7d manifest routeAsOf mismatch")
    metadata_head = linkage_metadata.get("sourceCommit", linkage_metadata.get("sourceCommitSha"))
    if metadata_head is not None and metadata_head != value.get("sourceCommitSha"):
        raise Reject("authoritative 7d source head mismatches linkage metadata")
    checked = dict(value)
    checked["_formalManifestSha256"] = sha256_file(manifest_path)
    checked["_formalManifestPath"] = manifest_path.as_posix()
    return checked


def normalized_root(path: Path, field: str) -> Path:
    try:
        return path.expanduser().resolve()
    except OSError as exc:
        raise Reject(f"invalid {field}: {exc}") from exc


def output_child(root: Path, name: str) -> Path:
    normalized = normalized_root(root, "output-root")
    child = (normalized / name).resolve()
    try:
        child.relative_to(normalized)
    except ValueError as exc:
        raise Reject(f"output path escapes caller-provided output root: {name}") from exc
    return child


def canon(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise Reject(f"invalid or missing {path.name}: {exc}") from exc


def read_object(path: Path, description: str) -> dict[str, Any]:
    value = read_json(path)
    if not isinstance(value, dict):
        raise Reject(f"{description} must be an object")
    return value


def parse_time(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise Reject(f"{field} is missing; event-time routing requires it")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise Reject(f"{field} is invalid ISO-8601") from exc
    if parsed.tzinfo is None:
        raise Reject(f"{field} must be timezone-aware")
    return parsed.astimezone(timezone.utc)


def text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise Reject(f"missing/invalid {field}")
    return value


def integer(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise Reject(f"missing/invalid {field}")
    return value


def hash_text(value: Any, field: str) -> str:
    value = text(value, field).lower()
    if not HEX64.fullmatch(value):
        raise Reject(f"invalid {field}: expected sha256")
    return value


def report_status(value: Mapping[str, Any]) -> bool:
    status = value.get(
        "status",
        value.get("result", value.get("gate", value.get("closureStatus", value.get("reportStatus")))),
    )
    if status is True:
        return True
    if isinstance(status, str) and status.casefold() in {
        "pass",
        "passed",
        "closed",
        "complete",
        "completed",
        "linked",
        "ok",
        "ready",
    }:
        return True
    return False


def marker_from_value(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        return {"linkedOutputSha256": value}
    if isinstance(value, dict):
        return value
    raise Reject("linked marker must be an object or sha256 string")


def marker_is_valid(marker: Mapping[str, Any]) -> bool:
    marker_type = marker.get("_type", marker.get("kind", ""))
    status = marker.get(
        "status",
        marker.get("linkageStatus", marker.get("closureStatus", marker.get("markerStatus"))),
    )
    if status is not None:
        if status is not True and (
            not isinstance(status, str)
            or status.casefold() not in {"pass", "passed", "closed", "complete", "linked", "ready"}
        ):
            return False
    # Embedded markers from the formal linkage producer use _type plus an
    # artifact/metadata object; reports carry the closed status in that form.
    if marker_type and marker_type not in {"linked-output", "metadata", "marker"}:
        return False
    if marker.get("closed") is False or marker.get("linkageClosed") is False:
        return False
    return True


def marker_report_hash(marker: Mapping[str, Any], report: Path) -> Any:
    reports = marker.get("reports", marker.get("reportHashes", {}))
    if isinstance(reports, Mapping):
        for key in (report.name, report.stem, report.stem + ".json"):
            if key in reports:
                return reports[key]
    for key in (
        f"{report.stem}Sha256",
        f"{report.stem}SHA256",
        f"{report.stem}Hash",
    ):
        if key in marker:
            return marker[key]
    return None


def report_declared_hash(report: Mapping[str, Any]) -> Any:
    for key in ("sha256", "reportSha256", "contentSha256", "hash"):
        if key in report:
            return report[key]
    return None


def load_formal_linkage(artifact: Path, route_as_of: datetime) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, str]]:
    linked_path = artifact / "linked-output.ndjson"
    try:
        lines = linked_path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise Reject(f"missing linked-output.ndjson: {exc}") from exc
    first_line = next((line for line in lines if line.strip()), "")
    embedded_marker: dict[str, Any] | None = None
    if first_line:
        try:
            first_value = json.loads(first_line)
        except json.JSONDecodeError as exc:
            raise Reject("missing linked marker") from exc
        if isinstance(first_value, dict) and first_value.get("_type") in {"linked-output", "metadata", "marker"}:
            embedded_marker = first_value

    external_marker_path = next(
        (artifact / name for name in MARKER_NAMES if (artifact / name).is_file()),
        None,
    )
    if embedded_marker is None and external_marker_path is None:
        raise Reject("missing linked marker")
    marker = embedded_marker or marker_from_value(read_json(external_marker_path))  # type: ignore[arg-type]
    if not marker_is_valid(marker):
        raise Reject("linked marker closure status is not closed")

    # A separate marker must bind the complete linked-output bytes.  Embedded
    # markers are part of the producer's NDJSON envelope and may instead bind
    # reports through the marker metadata.
    linked_hash = marker.get(
        "linkedOutputSha256",
        marker.get("linkedOutputHash", marker.get("sha256")),
    )
    if external_marker_path is not None:
        if linked_hash is None:
            raise Reject("linked marker missing linked-output hash")
        if hash_text(linked_hash, "linked marker linked-output hash") != sha256_file(linked_path):
            raise Reject("linked marker hash mismatch")
    elif linked_hash is not None and hash_text(linked_hash, "linked marker linked-output hash") != sha256_file(linked_path):
        # If an embedded producer supplies a hash, it must mean the complete
        # file bytes; silently accepting a wrong binding would make the handoff
        # non-auditable.
        raise Reject("linked marker hash mismatch")

    reports: dict[str, dict[str, Any]] = {}
    report_hashes: dict[str, str] = {}
    for name in REQUIRED_REPORTS:
        path = artifact / name
        if not path.is_file():
            raise Reject(f"missing required linkage report: {name}")
        value = read_object(path, name)
        if not report_status(value):
            raise Reject(f"{name} closure status is not closed/pass")
        declared = marker_report_hash(marker, path)
        if declared is None:
            declared = report_declared_hash(value)
        if declared is None:
            raise Reject(f"missing hash for {name}")
        if hash_text(declared, f"{name} hash") != sha256_file(path):
            raise Reject(f"hash mismatch for {name}")
        reports[name] = value
        report_hashes[name] = sha256_file(path)

    route_report = reports["release-route-report.json"]
    report_as_of = route_report.get("routeAsOf", route_report.get("route_as_of", route_report.get("routeAsOfUtc")))
    if report_as_of is not None and parse_time(report_as_of, "release route report routeAsOf") != route_as_of:
        raise Reject("release route report routeAsOf mismatch")
    route_entries = route_report.get("routes")
    if route_entries is not None:
        if not isinstance(route_entries, Mapping):
            raise Reject("release route report routes must be an object")
        for route in ("7d", "all"):
            entry = route_entries.get(route)
            if not isinstance(entry, Mapping) or not report_status(entry):
                raise Reject(f"release route report missing pass {route}")

    route_cutoff = route_report.get("releaseCutoffUtc", route_report.get("release_cutoff_utc"))
    if route_cutoff is not None:
        route_cutoff = parse_time(route_cutoff, "release route report releaseCutoffUtc").isoformat().replace("+00:00", "Z")
    metadata = marker.get("artifact", marker.get("metadata", {}))
    if metadata is None:
        metadata = {}
    if not isinstance(metadata, dict):
        raise Reject("linked marker metadata must be an object")

    rows: list[dict[str, Any]] = []
    marker_seen = False
    for line_no, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise Reject(f"invalid linked-output line {line_no}") from exc
        if not isinstance(value, dict):
            raise Reject(f"linked-output line {line_no} is not an object")
        if value.get("_type") in {"linked-output", "metadata", "marker"}:
            if marker_seen or line != first_line:
                raise Reject("linked-output marker must appear exactly once first")
            marker_seen = True
            continue
        rows.append(value)
    if embedded_marker is not None and not marker_seen:
        raise Reject("missing linked marker")
    marker_route_as_of = metadata.get("routeAsOf", metadata.get("routeAsOfUtc", metadata.get("route_as_of")))
    if marker_route_as_of is not None and parse_time(marker_route_as_of, "marker routeAsOf") != route_as_of:
        raise Reject("marker routeAsOf mismatch")
    marker_cutoff = metadata.get("releaseCutoffUtc", metadata.get("release_cutoff_utc"))
    if marker_cutoff is not None:
        marker_cutoff = parse_time(marker_cutoff, "marker releaseCutoffUtc").isoformat().replace("+00:00", "Z")
    row_cutoffs = {str(row.get("releaseCutoffUtc", row.get("release_cutoff_utc"))) for row in rows if row.get("releaseCutoffUtc", row.get("release_cutoff_utc")) is not None}
    normalized_row_cutoffs = {parse_time(value, "row releaseCutoffUtc").isoformat().replace("+00:00", "Z") for value in row_cutoffs}
    effective_cutoffs = {value for value in (route_cutoff, marker_cutoff) if value is not None} | normalized_row_cutoffs
    if len(effective_cutoffs) != 1:
        raise Reject("releaseCutoffUtc conflict or missing")
    metadata = dict(metadata)
    metadata["releaseCutoffUtc"] = next(iter(effective_cutoffs))
    if report_as_of is not None:
        metadata["routeAsOf"] = report_as_of
    return metadata, rows, report_hashes


def load_producer_artifact_proof(artifact: Path) -> dict[str, Any]:
    proof_path = artifact / "producer-artifact-proof.json"
    if not proof_path.is_file():
        raise Reject("producer artifact proof is missing")
    proof = read_object(proof_path, "producer-artifact-proof")
    required = (
        "runId",
        "artifactId",
        "artifactName",
        "artifactDigest",
        "producerHeadSha",
        "workflowName",
    )
    if proof.get("verified") is not True or any(
        not isinstance(proof.get(key), str) or not proof[key].strip() for key in required
    ):
        raise Reject("producer artifact proof is incomplete")
    if proof["artifactName"] != f"enrich-snapshot-pilot-two-day-candidate-{proof['runId']}":
        raise Reject("producer artifact proof name is not bound to runId")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", proof["artifactDigest"], re.IGNORECASE):
        raise Reject("producer artifact proof digest is invalid")
    if not re.fullmatch(r"[0-9a-f]{40}", proof["producerHeadSha"], re.IGNORECASE):
        raise Reject("producer artifact proof head SHA is invalid")
    return proof


def summary_sample(summary: Mapping[str, Any], sample_id: str) -> dict[str, Any]:
    samples = summary.get("samples")
    if not isinstance(samples, list):
        raise Reject("formal pilot summary samples are missing")
    matches = [sample for sample in samples if isinstance(sample, Mapping) and sample.get("sampleId") == sample_id]
    if len(matches) != 1:
        raise Reject(f"formal pilot summary sample is missing or ambiguous: {sample_id}")
    return dict(matches[0])


def load_formal_linkage_sample(
    linkage_root: Path,
    sample: Mapping[str, Any],
    route_as_of: datetime,
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, str]]:
    linked_path = linkage_root / "linked-output.ndjson"
    if not linked_path.is_file():
        raise Reject("formal Jul29 linkage bytes are missing")
    linkage_reports = sample.get("linkageReports")
    if not isinstance(linkage_reports, Mapping):
        raise Reject("formal Jul29 linkage report hashes are missing")
    linked_entry = linkage_reports.get("linked-output.ndjson")
    if not isinstance(linked_entry, Mapping):
        raise Reject("formal Jul29 linked-output hash is missing")
    expected_linked = linked_entry.get("sha256")
    if not isinstance(expected_linked, str) or expected_linked.lower() != sha256_file(linked_path):
        raise Reject("formal Jul29 linked-output hash mismatch")
    rows: list[dict[str, Any]] = []
    for line_no, line in enumerate(linked_path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise Reject(f"invalid formal Jul29 linkage line {line_no}") from exc
        if not isinstance(value, dict):
            raise Reject(f"formal Jul29 linkage line {line_no} is not an object")
        row = dict(value)
        row["source"] = {"day": "2026-07-29", "sampleId": "sample25"}
        row["linkageDay"] = "2026-07-29"
        row["provenance"] = dict(row.get("provenance") or row.get("providerEnrichment") or {})
        rows.append(row)
    expected_count = sample.get("realOccurrenceCount")
    if expected_count != len(rows) or expected_count != 90:
        raise Reject(f"formal Jul29 linkage count mismatch: expected 90 got {len(rows)}")
    report_hashes: dict[str, str] = {"jul29-25/linked-output.ndjson": sha256_file(linked_path)}
    for name in REQUIRED_REPORTS:
        path = linkage_root / name
        if not path.is_file():
            raise Reject(f"formal Jul29 linkage report is missing: {name}")
        value = read_object(path, name)
        if not report_status(value):
            raise Reject(f"formal Jul29 {name} is not CLOSED")
        entry = linkage_reports.get(name)
        expected = entry.get("sha256") if isinstance(entry, Mapping) else None
        if not isinstance(expected, str) or expected.lower() != sha256_file(path):
            raise Reject(f"formal Jul29 {name} hash mismatch")
        report_hashes[f"jul29-25/{name}"] = sha256_file(path)
    report_as_of = sample.get("routeAsOfUtc")
    if report_as_of is not None and parse_time(report_as_of, "formal Jul29 routeAsOf") != route_as_of:
        raise Reject("formal Jul29 routeAsOf mismatch")
    return (
        {
            "routeAsOf": route_as_of.isoformat().replace("+00:00", "Z"),
            "releaseCutoffUtc": text(sample.get("releaseCutoffUtc"), "formal Jul29 releaseCutoffUtc"),
            "sampleId": "jul29-25",
            "sourceCommitSha": sample.get("sourceCommit"),
            "formalInputPath": "candidate/jul29-25/linkage/linked-output.ndjson",
        },
        rows,
        report_hashes,
    )


def load_formal_raw_sample(
    raw_path: Path,
    sample: Mapping[str, Any],
    route_as_of: datetime,
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, str]]:
    if not raw_path.is_file():
        raise Reject("formal Jul22 raw input is missing")
    raw_bytes = raw_path.read_bytes()
    expected_hash = sample.get("inputSha256") or sample.get("copiedRawInputSha256")
    if not isinstance(expected_hash, str) or expected_hash.lower() != sha256_bytes(raw_bytes):
        raise Reject("formal Jul22 raw input hash mismatch")
    value = read_json(raw_path)
    if not isinstance(value, Mapping) or not isinstance(value.get("videos"), list):
        raise Reject("formal Jul22 raw input must contain videos[]")
    rows: list[dict[str, Any]] = []
    for video in value["videos"]:
        if not isinstance(video, Mapping):
            raise Reject("formal Jul22 raw video is not an object")
        songs = video.get("songs")
        if not isinstance(songs, list):
            raise Reject("formal Jul22 raw video songs[] is missing")
        for song in songs:
            if not isinstance(song, Mapping):
                raise Reject("formal Jul22 raw occurrence is not an object")
            row = dict(song)
            row.setdefault("videoId", video.get("videoId"))
            row["source"] = {"day": "2026-07-22", "sampleId": "raw456"}
            row["linkageDay"] = "2026-07-22"
            row["_formalRawOccurrence"] = True
            rows.append(row)
    expected_count = sample.get("occurrenceIdCount", sample.get("realOccurrenceCount"))
    expected_videos = sample.get("videoCount")
    if expected_videos != len(value["videos"]) or expected_videos != 19:
        raise Reject(f"formal Jul22 video count mismatch: expected 19 got {len(value['videos'])}")
    if expected_count != len(rows) or expected_count != 456:
        raise Reject(f"formal Jul22 occurrence count mismatch: expected 456 got {len(rows)}")
    return (
        {
            "routeAsOf": route_as_of.isoformat().replace("+00:00", "Z"),
            "releaseCutoffUtc": text(sample.get("releaseCutoffUtc"), "formal Jul22 releaseCutoffUtc"),
            "sampleId": "jul22-19",
            "sourceCommitSha": sample.get("sourceCommit"),
            "formalInputPath": "candidate/jul22-19/raw-input/sample.json",
            "rawInputSha256": sha256_bytes(raw_bytes),
            "providerSkipped": sample.get("providerSkipped") is True,
        },
        rows,
        {"jul22-19/raw-input/sample.json": sha256_bytes(raw_bytes)},
    )


def load_artifact(
    artifact: Path,
    route_as_of: datetime,
    release_route: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, str]]:
    """Load a flat handoff, or the formal artifact's exact linkage/raw roots."""

    flat = artifact / "linked-output.ndjson"
    if flat.is_file():
        metadata, rows, report_hashes = load_formal_linkage(artifact, route_as_of)
        metadata = dict(metadata)
        metadata["producerArtifactProof"] = load_producer_artifact_proof(artifact)
        return metadata, rows, report_hashes

    producer_root = artifact / "candidate"
    formal_linkage = producer_root / "jul29-25" / "linkage"
    formal_raw = producer_root / "jul22-19" / "raw-input" / "sample.json"
    summary_path = producer_root / "pilot-summary.json"
    if formal_linkage.joinpath("linked-output.ndjson").is_file() and formal_raw.is_file() and summary_path.is_file():
        proof = load_producer_artifact_proof(artifact)
        summary = read_object(summary_path, "pilot-summary")
        jul29 = summary_sample(summary, "jul29-25")
        jul22 = summary_sample(summary, "jul22-19")
        if release_route == "7d":
            metadata, rows, report_hashes = load_formal_linkage_sample(formal_linkage, jul29, route_as_of)
        elif release_route == "all":
            metadata, rows, report_hashes = load_formal_raw_sample(formal_raw, jul22, route_as_of)
        else:
            raise Reject("formal artifact conversion requires explicit 7d or all route")
        metadata = dict(metadata)
        metadata["producerArtifactProof"] = proof
        metadata["producerSummary"] = summary
        metadata["sourceCommitSha"] = metadata.get("sourceCommitSha") or summary.get("sourceCommit")
        return metadata, rows, report_hashes

    sample_roots = (
        ("jul29-25", producer_root / "jul29-25" / "linkage"),
        ("jul22-19", producer_root / "jul22-19" / "linkage"),
    )
    if not all((root / "linked-output.ndjson").is_file() for _, root in sample_roots):
        raise Reject("producer artifact linkage layout is missing one of the two samples")
    proof = load_producer_artifact_proof(artifact)
    merged_metadata: dict[str, Any] = {"producerArtifactProof": proof}
    merged_rows: list[dict[str, Any]] = []
    merged_hashes: dict[str, str] = {}
    sample_metadata: dict[str, Any] = {}
    for sample_id, root in sample_roots:
        metadata, rows, report_hashes = load_formal_linkage(root, route_as_of)
        if not merged_metadata.get("routeAsOf"):
            merged_metadata.update(metadata)
        elif metadata.get("releaseCutoffUtc") != merged_metadata.get("releaseCutoffUtc"):
            raise Reject("producer sample releaseCutoffUtc mismatch")
        sample_metadata[sample_id] = metadata
        merged_rows.extend(rows)
        merged_hashes.update({f"{sample_id}/{name}": value for name, value in report_hashes.items()})
    merged_metadata["sampleMetadata"] = sample_metadata
    summary_path = producer_root / "pilot-summary.json"
    if summary_path.is_file():
        summary = read_object(summary_path, "pilot-summary")
        merged_metadata["producerSummary"] = summary
        if isinstance(summary.get("sourceCommit"), str) and summary["sourceCommit"].strip():
            merged_metadata.setdefault("sourceCommitSha", summary["sourceCommit"])
    return merged_metadata, merged_rows, merged_hashes


def source_pair(row: Mapping[str, Any]) -> tuple[str, str]:
    source = row.get("source")
    if isinstance(source, Mapping):
        day = source.get("day", source.get("linkageDay", row.get("linkageDay", row.get("day"))))
        sample = source.get(
            "sampleId",
            source.get("sample_id", row.get("sampleId", row.get("sample_id"))),
        )
    else:
        day = row.get("linkageDay", row.get("day"))
        sample = row.get("sampleId", row.get("sample_id"))
    pair = (str(day or ""), str(sample or ""))
    if pair not in SUPPORTED_SOURCES:
        raise Reject(f"source outside frozen two-day set: {pair}")
    claimed_day = row.get("linkageDay")
    if claimed_day is not None and str(claimed_day) != pair[0]:
        raise Reject("linkageDay conflicts with source day")
    return pair


def route_for(event: datetime, route_as_of: datetime) -> str:
    if event > route_as_of:
        raise Reject("future eventTime")
    return "7d" if route_as_of - timedelta(days=7) <= event <= route_as_of else "all"


def occurrence_payload(
    row: Mapping[str, Any],
    pair: tuple[str, str],
    event: datetime | None,
    route: str,
    release_cutoff_utc: str,
    range_id: str,
    raw_occurrence: bool = False,
) -> dict[str, Any]:
    video_id = text(row.get("videoId", row.get("video_id")), "videoId")
    occurrence_id = text(row.get("occurrenceId", row.get("occurrence_id")), "occurrenceId")
    position_value = row.get("position", row.get("index", 0))
    position = integer(position_value, "position")
    seconds_value = row.get("seconds", row.get("durationSeconds", row.get("duration")))
    seconds = None if seconds_value is None else integer(seconds_value, "seconds")
    title_value = row.get("title", row.get("songTitle"))
    title = title_value if raw_occurrence else text(title_value, "title")
    artist_value = row.get("artist", row.get("artistName"))
    artist = artist_value if raw_occurrence or artist_value is None or (isinstance(artist_value, str) and not artist_value.strip()) else text(artist_value, "artist")
    source_id = row.get("sourceId", row.get("source_id")) if raw_occurrence else text(row.get("sourceId", row.get("source_id", video_id)), "sourceId")
    source_hash = row.get("sourceHash", row.get("source_hash")) if raw_occurrence else hash_text(row.get("sourceHash", row.get("source_hash")), "sourceHash")
    raw_hash = hash_text(row.get("rawHash", row.get("raw_hash")), "rawHash")
    provenance = row.get("provenance")
    if not isinstance(provenance, dict):
        raise Reject(f"{occurrence_id} provenance is missing")
    payload: OrderedDict[str, Any] = OrderedDict(
        (
            ("occurrenceId", occurrence_id),
            ("position", position),
            ("seconds", seconds),
            ("title", title),
            ("artist", artist),
            ("sourceId", source_id),
            ("sourceHash", source_hash),
            ("rawHash", raw_hash),
        )
    )
    if event is not None:
        payload["eventTime"] = row.get("eventTime", row.get("event_time"))
    payload.update(
        {
            "releaseRoute": route,
            "rangeId": range_id,
            "releaseCutoffUtc": release_cutoff_utc,
            "provenance": dict(provenance) if raw_occurrence else {
                **provenance,
                "linkageDay": pair[0],
                "sampleId": pair[1],
                "releaseCutoffUtc": release_cutoff_utc,
            },
        }
    )
    if raw_occurrence:
        for key in ("sourceSystem", "sourcePath", "rawTimeText", "evidenceSource", "evidenceExcerpt", "dateEvidence", "videoUrl", "reviewedAt", "reviewedBy"):
            if key in row:
                payload[key] = row[key]
    return payload


def build_candidate(
    rows: Sequence[Mapping[str, Any]],
    route_as_of: datetime,
    release_route: str | None = None,
    release_cutoff_utc: str | None = None,
    authoritative: Mapping[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if release_route not in {None, "7d", "all"}:
        raise Reject(f"invalid release route: {release_route}")
    if not isinstance(release_cutoff_utc, str) or not release_cutoff_utc.strip():
        raise Reject("missing releaseCutoffUtc")
    cutoff = parse_time(release_cutoff_utc, "releaseCutoffUtc")
    cutoff_text = cutoff.isoformat().replace("+00:00", "Z")
    groups: OrderedDict[str, dict[str, Any]] = OrderedDict()
    seen: dict[tuple[str, str], str] = {}
    counts: dict[str, Any] = {
        "inputOccurrences": 0,
        "videoRecords": 0,
        "songOccurrences": 0,
        "sevenDayOccurrences": 0,
        "allOccurrences": 0,
        "byRoute": {"7d": {"videos": 0, "occurrences": 0}, "all": {"videos": 0, "occurrences": 0}},
    }
    for index, original in enumerate(rows, 1):
        row = dict(original)
        pair = source_pair(row)
        event_value = row.get("eventTime", row.get("event_time"))
        raw_occurrence = row.get("_formalRawOccurrence") is True
        if event_value is None and raw_occurrence and release_route == "all":
            event = None
            derived_route = "all"
        else:
            event = parse_time(event_value, f"row {index} eventTime")
            derived_route = route_for(event, route_as_of)
        row_cutoff = row.get("releaseCutoffUtc", row.get("release_cutoff_utc"))
        if row_cutoff is not None and parse_time(row_cutoff, f"row {index} releaseCutoffUtc") != cutoff:
            raise Reject(f"row {index} releaseCutoffUtc conflict")
        claimed_route = row.get("releaseRoute", row.get("route"))
        if claimed_route not in (None, "", derived_route, "authoritative-7d" if derived_route == "7d" else derived_route):
            raise Reject(f"row {index} releaseRoute conflicts with eventTime")
        if release_route is not None and derived_route != release_route:
            continue
        payload = occurrence_payload(
            row,
            pair,
            event,
            derived_route,
            cutoff_text,
            release_route or derived_route,
            raw_occurrence,
        )
        video_id = text(row.get("videoId", row.get("video_id")), "videoId")
        occurrence_id = payload["occurrenceId"]
        key = (video_id, occurrence_id)
        encoded = canon(payload).decode("utf-8")
        if key in seen:
            if seen[key] != encoded:
                raise Reject(f"conflicting duplicate video/occurrence {video_id}/{occurrence_id}")
            raise Reject(f"duplicate occurrence {video_id}/{occurrence_id}")
        seen[key] = encoded
        group = groups.setdefault(video_id, OrderedDict((("videoId", video_id), ("songs", []))))
        group["songs"].append(payload)
        counts["inputOccurrences"] += 1
        if derived_route == "7d":
            counts["sevenDayOccurrences"] += 1
        else:
            counts["allOccurrences"] += 1
    records = list(groups.values())
    if release_route is not None:
        for record in records:
            record["rangeId"] = release_route
            if release_route == "7d":
                record["partialRangeReset"] = True
                if authoritative is None:
                    raise Reject("phase1 authoritative 7d manifest is required")
                for key in ("sourceCommitSha", "sourceBlobSha", "sourceArtifactSha256"):
                    record[key] = authoritative[key]
            for song in record["songs"]:
                song["rangeId"] = release_route
    counts["videoRecords"] = len(records)
    counts["songOccurrences"] = sum(len(record["songs"]) for record in records)
    for record in records:
        route_counts = {song["releaseRoute"] for song in record["songs"]}
        # A single top-level video may carry occurrences from both ranges in a
        # combined candidate; phase candidates normally contain one route.
        for route in route_counts:
            occurrence_count = sum(1 for song in record["songs"] if song["releaseRoute"] == route)
            counts["byRoute"][route]["occurrences"] += occurrence_count
            counts["byRoute"][route]["videos"] += 1
    return records, counts


def ndjson_bytes(records: Iterable[Mapping[str, Any]]) -> bytes:
    return b"".join(canon(record) + b"\n" for record in records)


def git_blob_sha(value: bytes) -> str:
    header = f"blob {len(value)}\0".encode("ascii")
    return hashlib.sha1(header + value).hexdigest()


def synthesized_authoritative_manifest(
    payload: bytes,
    counts: Mapping[str, Any],
    route_as_of: datetime,
    release_cutoff_utc: str,
    metadata: Mapping[str, Any],
) -> dict[str, Any]:
    proof = metadata.get("producerArtifactProof")
    if not isinstance(proof, Mapping) or proof.get("verified") is not True:
        raise Reject("phase1 requires verified producer artifact proof when no formal 7d manifest is present")
    source_commit = metadata.get("sourceCommitSha") or proof.get("producerHeadSha")
    if not isinstance(source_commit, str) or not HEX40.fullmatch(source_commit):
        raise Reject("phase1 sourceCommitSha is not a real producer head SHA")
    artifact_digest = proof.get("artifactDigest")
    if not isinstance(artifact_digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", artifact_digest, re.IGNORECASE):
        raise Reject("phase1 producer artifact digest is missing")
    source_artifact_sha = artifact_digest.split(":", 1)[1].lower()
    by_route = counts.get("byRoute", {})
    accepted_video_count = int(by_route.get("7d", {}).get("videos", 0))
    accepted_occurrence_count = int(by_route.get("7d", {}).get("occurrences", 0))
    if accepted_video_count <= 0 or accepted_occurrence_count <= 0:
        raise Reject("phase1 source count is empty")
    source_blob_sha = git_blob_sha(payload)
    source_occurrence_sha = sha256_bytes(payload)
    source_manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "path": "producer/candidate/jul29-25/linkage/linked-output.ndjson",
        "rangeId": "7d",
        "sourceCommitSha": source_commit,
        "sourceBlobSha": source_blob_sha,
        "sourceArtifactSha256": source_artifact_sha,
        "generatedAt": route_as_of.isoformat().replace("+00:00", "Z"),
        "acceptedVideoCount": accepted_video_count,
        "acceptedOccurrenceCount": accepted_occurrence_count,
        "sourceOccurrenceSemanticsSha256": source_occurrence_sha,
    }
    source_manifest_sha = sha256_bytes(canon(source_manifest))
    mutation_count = accepted_video_count + accepted_occurrence_count
    source_cas = {
        "sourceCommitSha": source_commit,
        "sourceBlobSha": source_blob_sha,
        "sourceArtifactSha256": source_artifact_sha,
        "sourceManifestSha256": source_manifest_sha,
        "sourceOccurrenceSemanticsSha256": source_occurrence_sha,
        "producerRunId": proof["runId"],
        "producerArtifactId": proof["artifactId"],
        "producerArtifactDigest": proof["artifactDigest"],
        "count": accepted_occurrence_count,
    }
    return {
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
        "mutation_count": mutation_count,
        "acceptedVideoCount": accepted_video_count,
        "acceptedOccurrenceCount": accepted_occurrence_count,
        "baseVideoCount": accepted_video_count,
        "baseOccurrenceCount": accepted_occurrence_count,
        "rangeBoundaryMutationCount": 0,
        "patch_sha256": sha256_bytes(payload),
        "sourceBlobSha": source_blob_sha,
        "source_blob_sha": source_blob_sha,
        "sourceArtifactSha256": source_artifact_sha,
        "sourceOccurrenceSemanticsSha256": source_occurrence_sha,
        "sourceManifestSha256": source_manifest_sha,
        "sourceManifest": source_manifest,
        "sourceCommitSha": source_commit,
        "generatedAt": route_as_of.isoformat().replace("+00:00", "Z"),
        "sourceCAS": source_cas,
        "sourceCount": accepted_occurrence_count,
        "routeAsOfUtc": route_as_of.isoformat().replace("+00:00", "Z"),
        "releaseCutoffUtc": release_cutoff_utc,
        "_formalManifestSha256": source_manifest_sha,
        "_formalManifestPath": "derived-from-formal-artifact/candidate/jul29-25/linkage/linked-output.ndjson",
    }


def write_candidate(
    output: Path,
    records: Sequence[Mapping[str, Any]],
    counts: Mapping[str, Any],
    route_as_of: datetime,
    route: str | None,
    metadata: Mapping[str, Any],
    report_hashes: Mapping[str, str],
    release_cutoff_utc: str,
    authoritative: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    output = normalized_root(output, "output-root")
    candidate_path = output_child(output, "candidate.ndjson")
    manifest_path = output_child(output, "manifest.json")
    output.mkdir(parents=True, exist_ok=True)
    payload = ndjson_bytes(records)
    candidate_path.write_bytes(payload)
    manifest: dict[str, Any] = OrderedDict(
        (
            ("schemaVersion", "two-day-pg-bridge/v2"),
            ("bridgeKind", "two-day-pg-bridge-v2"),
            ("status", "ready"),
            ("candidateOnly", True),
            ("releaseRoute", route or "combined"),
            ("routeAsOf", route_as_of.isoformat().replace("+00:00", "Z")),
            ("releaseCutoffUtc", release_cutoff_utc),
            ("sourceDays", ["2026-07-29/sample25", "2026-07-22/raw456"]),
            ("sourceMetadata", dict(metadata)),
            ("reports", dict(report_hashes)),
            ("candidate", {"path": "candidate.ndjson", "sha256": sha256_bytes(payload), "bytes": len(payload)}),
            ("counts", dict(counts)),
            ("videoRecordShape", "top-level videoId with songs[]"),
            ("dbMutationCount", 0),
            ("activationPerformed", False),
        )
    )
    if route is not None:
        manifest["rangeId"] = route
    if authoritative is not None:
        for key in AUTH_COPY_FIELDS:
            if key not in authoritative:
                raise Reject(f"authoritative 7d manifest missing {key}")
            manifest[key] = authoritative[key]
        manifest["formal7dManifestSha256"] = authoritative["_formalManifestSha256"]
        manifest["formal7dManifestPath"] = authoritative["_formalManifestPath"]
    elif route == "7d":
        raise Reject("phase1 authoritative 7d manifest is required")
    if route == "all":
        manifest.update(
            {
                "handoffKind": "two-day-pg-bridge-v2-all-range",
                "rangeReset": False,
                "require_7d_gate": False,
                "sourceCount": int(counts.get("byRoute", {}).get("all", {}).get("occurrences", 0)),
            }
        )
    elif route == "7d":
        manifest["require_7d_gate"] = True
        manifest["handoffKind"] = "github-core-7d-authoritative-range"
        manifest["sourceCount"] = int(counts.get("byRoute", {}).get("7d", {}).get("occurrences", 0))
    manifest_path.write_bytes(canon(manifest) + b"\n")
    checked = read_object(manifest_path, "manifest")
    if checked["candidate"]["sha256"] != sha256_bytes(candidate_path.read_bytes()):
        raise Reject("candidate hash consistency check failed")
    if checked["counts"] != dict(counts):
        raise Reject("candidate counts consistency check failed")
    return checked


def convert(
    artifact: Path,
    output: Path,
    route_as_of: str,
    release_route: str | None = None,
) -> dict[str, Any]:
    artifact = normalized_root(artifact, "artifact-root")
    if not artifact.is_dir():
        raise Reject(f"artifact-root is not a directory: {artifact}")
    output = normalized_root(output, "output-root")
    as_of = parse_time(route_as_of, "routeAsOf")
    metadata, rows, report_hashes = load_artifact(artifact, as_of, release_route)
    authoritative = None
    if release_route == "7d":
        manifest_candidates = [artifact / name for name in AUTH_MANIFEST_NAMES if (artifact / name).is_file()]
        if manifest_candidates:
            authoritative = load_authoritative_7d_manifest(artifact, as_of, metadata)
        else:
            source_path = artifact / "candidate" / "jul29-25" / "linkage" / "linked-output.ndjson"
            if not source_path.is_file():
                raise Reject("formal Jul29 linkage source bytes are missing")
            preliminary = {
                "byRoute": {
                    "7d": {
                        "videos": len({text(row.get("videoId", row.get("video_id")), "videoId") for row in rows}),
                        "occurrences": len(rows),
                    }
                }
            }
            authoritative = synthesized_authoritative_manifest(
                source_path.read_bytes(),
                preliminary,
                as_of,
                text(metadata.get("releaseCutoffUtc"), "releaseCutoffUtc"),
                metadata,
            )
    release_cutoff_utc = metadata.get("releaseCutoffUtc")
    if not isinstance(release_cutoff_utc, str) or not release_cutoff_utc.strip():
        raise Reject("missing releaseCutoffUtc")
    records, counts = build_candidate(rows, as_of, release_route, release_cutoff_utc, authoritative)
    manifest = write_candidate(
        output,
        records,
        counts,
        as_of,
        release_route,
        metadata,
        report_hashes,
        release_cutoff_utc,
        authoritative,
    )
    return manifest


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--route-as-of", required=True)
    parser.add_argument("--release-route", choices=("7d", "all"))
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        manifest = convert(args.artifact_root, args.output_root, args.route_as_of, args.release_route)
        print(json.dumps({"status": manifest["status"], "counts": manifest["counts"]}, ensure_ascii=False, sort_keys=True))
        return 0
    except Reject as exc:
        print(f"REJECT: {exc}", file=sys.stderr)
        return EXIT_REJECTED
    except (OSError, TypeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
