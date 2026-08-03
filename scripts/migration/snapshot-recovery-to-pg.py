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


class Reject(ValueError):
    """A deterministic, non-release input-contract rejection."""

    code = EXIT_REJECTED


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


def occurrence_payload(row: Mapping[str, Any], pair: tuple[str, str], event: datetime, route: str, release_cutoff_utc: str) -> dict[str, Any]:
    video_id = text(row.get("videoId", row.get("video_id")), "videoId")
    occurrence_id = text(row.get("occurrenceId", row.get("occurrence_id")), "occurrenceId")
    position_value = row.get("position", row.get("index", 0))
    position = integer(position_value, "position")
    seconds_value = row.get("seconds", row.get("durationSeconds", row.get("duration")))
    seconds = None if seconds_value is None else integer(seconds_value, "seconds")
    title = text(row.get("title", row.get("songTitle")), "title")
    artist = text(row.get("artist", row.get("artistName")), "artist")
    source_id = text(row.get("sourceId", row.get("source_id", video_id)), "sourceId")
    source_hash = hash_text(row.get("sourceHash", row.get("source_hash")), "sourceHash")
    raw_hash = hash_text(row.get("rawHash", row.get("raw_hash")), "rawHash")
    provenance = row.get("provenance")
    if not isinstance(provenance, dict):
        raise Reject(f"{occurrence_id} provenance is missing")
    return OrderedDict(
        (
            ("occurrenceId", occurrence_id),
            ("position", position),
            ("seconds", seconds),
            ("title", title),
            ("artist", artist),
            ("sourceId", source_id),
            ("sourceHash", source_hash),
            ("rawHash", raw_hash),
            ("eventTime", event.isoformat().replace("+00:00", "Z")),
            ("releaseRoute", route),
            ("releaseCutoffUtc", release_cutoff_utc),
            (
                "provenance",
                {
                    **provenance,
                    "linkageDay": pair[0],
                    "sampleId": pair[1],
                    "releaseCutoffUtc": release_cutoff_utc,
                },
            ),
        )
    )


def build_candidate(
    rows: Sequence[Mapping[str, Any]],
    route_as_of: datetime,
    release_route: str | None = None,
    release_cutoff_utc: str | None = None,
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
        event = parse_time(event_value, f"row {index} eventTime")
        derived_route = route_for(event, route_as_of)
        row_cutoff = row.get("releaseCutoffUtc", row.get("release_cutoff_utc"))
        if row_cutoff is not None and parse_time(row_cutoff, f"row {index} releaseCutoffUtc") != cutoff:
            raise Reject(f"row {index} releaseCutoffUtc conflict")
        claimed_route = row.get("releaseRoute", row.get("route"))
        if claimed_route not in (None, "", derived_route):
            raise Reject(f"row {index} releaseRoute conflicts with eventTime")
        if release_route is not None and derived_route != release_route:
            continue
        payload = occurrence_payload(row, pair, event, derived_route, cutoff_text)
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


def write_candidate(
    output: Path,
    records: Sequence[Mapping[str, Any]],
    counts: Mapping[str, Any],
    route_as_of: datetime,
    route: str | None,
    metadata: Mapping[str, Any],
    report_hashes: Mapping[str, str],
    release_cutoff_utc: str,
) -> dict[str, Any]:
    output = normalized_root(output, "output-root")
    candidate_path = output_child(output, "candidate.ndjson")
    manifest_path = output_child(output, "manifest.json")
    output.mkdir(parents=True, exist_ok=True)
    payload = ndjson_bytes(records)
    candidate_path.write_bytes(payload)
    manifest: dict[str, Any] = OrderedDict(
        (
            ("schemaVersion", "two-day-pg-bridge/v1"),
            ("status", "READY_CANDIDATE_ONLY"),
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
    metadata, rows, report_hashes = load_formal_linkage(artifact, as_of)
    release_cutoff_utc = metadata.get("releaseCutoffUtc")
    if not isinstance(release_cutoff_utc, str) or not release_cutoff_utc.strip():
        raise Reject("missing releaseCutoffUtc")
    records, counts = build_candidate(rows, as_of, release_route, release_cutoff_utc)
    manifest = write_candidate(output, records, counts, as_of, release_route, metadata, report_hashes, release_cutoff_utc)
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
