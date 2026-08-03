#!/usr/bin/env python3
"""Bridge fresh provider output into a verified source-index candidate.

The bridge never derives occurrence IDs, positions, source IDs, or source
bytes.  A missing or conflicting field is a not-ready result (exit 78).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


REJECT = 78
SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
PATH_KEYS = ("sourceBytesPath", "source_bytes_path", "rawSourcePath", "raw_source_path", "sourcePath", "source_path")
ID_KEYS = ("sourceId", "source_id")
SOURCE_HASH_KEYS = ("sourceHash", "source_hash")
RAW_HASH_KEYS = ("rawHash", "raw_hash")


class BridgeError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def fail(code: str, message: str) -> None:
    raise BridgeError(code, message)


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail("INPUT_JSON_INVALID", f"{path}: {exc}")


def read_records(path: Path) -> list[dict[str, Any]]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        fail("INPUT_UNREADABLE", f"{path}: {exc}")
    if path.suffix.lower() == ".json":
        value = read_json(path)
        if isinstance(value, dict):
            for key in ("records", "items", "sources", "sourceCaptures"):
                if isinstance(value.get(key), list):
                    value = value[key]
                    break
        if not isinstance(value, list):
            fail("INPUT_SHAPE_INVALID", f"{path}: expected an array or records[]")
        records = value
    else:
        records = []
        for line_number, line in enumerate(text.splitlines(), 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                fail("INPUT_NDJSON_INVALID", f"{path}:{line_number}: {exc}")
            records.append(value)
    if not all(isinstance(item, dict) for item in records):
        fail("INPUT_SHAPE_INVALID", f"{path}: every record must be an object")
    return [dict(item) for item in records]


def provider_records(path: Path) -> list[dict[str, Any]]:
    records = read_records(path)
    if records and "videoId" not in records[0] and "provider" in records[0]:
        records = records[1:]
    return records


def walk_mappings(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_mappings(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_mappings(child)


def first(mapping: dict[str, Any], keys: Iterable[str]) -> Any:
    for key in keys:
        if mapping.get(key) not in (None, ""):
            return mapping[key]
    return None


def source_fields(value: Any) -> dict[str, Any]:
    for mapping in walk_mappings(value):
        values = {
            "sourceId": first(mapping, ID_KEYS),
            "sourceHash": first(mapping, SOURCE_HASH_KEYS),
            "rawHash": first(mapping, RAW_HASH_KEYS),
            "sourcePath": first(mapping, PATH_KEYS),
        }
        if any(item is not None for item in values.values()):
            return values
    return {}


def source_maps(records: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    by_id: dict[str, dict[str, Any]] = {}
    by_video: dict[str, dict[str, Any]] = {}
    for record in records:
        fields = source_fields(record)
        source_id = fields.get("sourceId")
        video_id = record.get("videoId") or record.get("video_id")
        if isinstance(source_id, str) and source_id:
            previous = by_id.get(source_id)
            if previous is not None and previous != fields:
                fail("SOURCE_CAPTURE_CONFLICT", f"sourceId={source_id}")
            by_id[source_id] = fields
        if isinstance(video_id, str) and video_id and fields:
            previous = by_video.get(video_id)
            if previous is not None and previous != fields:
                fail("SOURCE_CAPTURE_CONFLICT", f"videoId={video_id}")
            by_video[video_id] = fields
    return by_id, by_video


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checked_source_path(source_root: Path, value: Any, video_id: str) -> tuple[str, Path]:
    if not isinstance(value, str) or not value.strip():
        fail("PROVIDER_RAW_SIDECAR_REQUIRED", f"{video_id}: local source bytes path is required")
    normalized = value.replace("\\", "/")
    if normalized.startswith(("http://", "https://")):
        fail("PROVIDER_RAW_SIDECAR_REQUIRED", f"{video_id}: URL is not a raw source sidecar")
    posix = PurePosixPath(normalized)
    if any(part in {"", ".", ".."} for part in posix.parts):
        fail("SOURCE_PATH_TRAVERSAL", f"{video_id}: {value!r}")
    candidate = Path(*posix.parts) if posix.is_absolute() else source_root / Path(*posix.parts)
    resolved = candidate.resolve()
    if not resolved.is_file():
        fail("SOURCE_BYTES_MISSING", f"{video_id}: {value!r}")
    try:
        relative = resolved.relative_to(source_root.resolve()).as_posix()
    except ValueError:
        fail("SOURCE_PATH_OUTSIDE_ROOT", f"{video_id}: {value!r}")
    return relative, resolved


def event_time(value: Any, route_as_of: datetime, video_id: str) -> str:
    if isinstance(value, list) or not isinstance(value, str) or not value.endswith("Z"):
        fail("EVENT_TIME_CONFLICT", f"{video_id}: eventTime is missing or conflicting")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00").astimezone(timezone.utc)
    except ValueError as exc:
        fail("EVENT_TIME_INVALID", f"{video_id}: {exc}")
    if parsed > route_as_of:
        fail("EVENT_TIME_FUTURE", f"{video_id}: eventTime={value} routeAsOfUtc={route_as_of.isoformat()}")
    return value


def occurrence_list(record: dict[str, Any], video_id: str) -> list[dict[str, Any]]:
    for key in ("occurrences", "songs", "sourceOccurrences", "records"):
        value = record.get(key)
        if isinstance(value, list):
            if not all(isinstance(item, dict) for item in value):
                fail("OCCURRENCE_SHAPE_INVALID", f"{video_id}: {key}")
            if not value:
                fail("OCCURRENCES_EMPTY", f"{video_id}")
            return value
    fail("OCCURRENCES_MISSING", f"{video_id}: provider output has no occurrences/songs")


def convert(args: argparse.Namespace) -> dict[str, Any]:
    route = datetime.fromisoformat(args.route_as_of_utc[:-1] + "+00:00").astimezone(timezone.utc)
    records = provider_records(args.provider_output)
    capture_records = read_records(args.source_capture)
    capture_by_id, capture_by_video = source_maps(capture_records)
    expected_ids = None
    if args.expected_ids:
        expected_value = read_json(args.expected_ids)
        expected_ids = expected_value if isinstance(expected_value, list) else expected_value.get("expectedIds") if isinstance(expected_value, dict) else None
        if not isinstance(expected_ids, list) or not all(isinstance(item, str) and item for item in expected_ids):
            fail("EXPECTED_IDS_INVALID", str(args.expected_ids))
    rows_by_video: dict[str, dict[str, Any]] = {}
    all_rows: list[dict[str, Any]] = []
    seen_occurrences: set[str] = set()
    seen_positions: set[tuple[Any, ...]] = set()
    for record in records:
        video_id = record.get("videoId") or record.get("video_id")
        if not isinstance(video_id, str) or not video_id:
            fail("VIDEO_ID_MISSING", "provider record")
        if video_id in rows_by_video:
            fail("VIDEO_ID_DUPLICATE", video_id)
        event = event_time(record.get("eventTime"), route, video_id)
        occurrences = occurrence_list(record, video_id)
        base = source_fields(record)
        if base.get("sourceId") in capture_by_id:
            base = {**capture_by_id[base["sourceId"]], **{k: v for k, v in base.items() if v is not None}}
        elif video_id in capture_by_video:
            base = {**capture_by_video[video_id], **{k: v for k, v in base.items() if v is not None}}
        source_key: tuple[str, str, str, str] | None = None
        normalized_rows: list[dict[str, Any]] = []
        row_sentinel = record.get("detailNull") is True or record.get("status") == "detail_null"
        for occurrence in occurrences:
            occurrence_id = occurrence.get("occurrenceId") or occurrence.get("occurrence_id")
            if not isinstance(occurrence_id, str) or not occurrence_id:
                fail("SOURCE_POSITION_MISSING", f"{video_id}: occurrenceId")
            if occurrence_id in seen_occurrences:
                fail("OCCURRENCE_ID_DUPLICATE", occurrence_id)
            seen_occurrences.add(occurrence_id)
            if (occurrence.get("videoId") or occurrence.get("video_id") or video_id) != video_id:
                fail("OCCURRENCE_VIDEO_MISMATCH", f"{video_id}/{occurrence_id}")
            position = occurrence.get("position")
            if not isinstance(position, int) or isinstance(position, bool) or position < 0:
                fail("POSITION_INVALID", f"{video_id}/{occurrence_id}")
            line = occurrence.get("sourceLineOrdinal")
            ordinal = occurrence.get("sourceOccurrenceOrdinal")
            offset = occurrence.get("sourceStartOffsetUtf16", occurrence.get("sourceStartOffset"))
            if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in (line, ordinal, offset)):
                fail("SOURCE_POSITION_MISSING", f"{video_id}/{occurrence_id}")
            direct = source_fields(occurrence)
            source = {**base, **{k: v for k, v in direct.items() if v is not None}}
            source_id = source.get("sourceId")
            source_hash = source.get("sourceHash")
            raw_hash = source.get("rawHash")
            if not isinstance(source_id, str) or not source_id:
                fail("SOURCE_ID_MISSING", f"{video_id}/{occurrence_id}")
            if not isinstance(source_hash, str) or not SHA256.fullmatch(source_hash):
                fail("HASH_INVALID", f"{video_id}/{occurrence_id}:sourceHash")
            if not isinstance(raw_hash, str) or not SHA256.fullmatch(raw_hash):
                fail("HASH_INVALID", f"{video_id}/{occurrence_id}:rawHash")
            path_value = source.get("sourcePath") or source.get("sourceBytesPath")
            relative_path, resolved_path = checked_source_path(args.source_root, path_value, video_id)
            if sha256_file(resolved_path) != raw_hash.lower():
                fail("RAW_HASH_MISMATCH", f"{video_id}/{occurrence_id}")
            key = (source_id, source_hash.lower(), raw_hash.lower(), relative_path)
            if source_key is None:
                source_key = key
            elif source_key != key:
                fail("SOURCE_METADATA_CONFLICT", video_id)
            position_key = (source_id, line, ordinal, offset)
            if position_key in seen_positions:
                fail("SOURCE_POSITION_COLLISION", f"{video_id}/{occurrence_id}")
            seen_positions.add(position_key)
            sentinel = row_sentinel or occurrence.get("isSentinel") is True or occurrence.get("detailNull") is True
            normalized = {key: value for key, value in occurrence.items() if key not in {"source", "sourceCapture"}}
            normalized.update(
                {
                    "videoId": video_id,
                    "occurrenceId": occurrence_id,
                    "position": position,
                    "sourceLineOrdinal": line,
                    "sourceOccurrenceOrdinal": ordinal,
                    "sourceStartOffsetUtf16": offset,
                    "sourceId": source_id,
                    "sourceHash": source_hash.lower(),
                    "rawHash": raw_hash.lower(),
                    "sourcePath": str(resolved_path),
                    "sourceBytesPath": relative_path,
                    "sourceComplete": True,
                    "sourceVerified": True,
                    "eventTime": event,
                    "isSentinel": sentinel,
                }
            )
            if sentinel:
                normalized["detailNull"] = True
                normalized["status"] = "detail_null"
            normalized_rows.append(normalized)
            all_rows.append(normalized)
        rows_by_video[video_id] = {
            "videoId": video_id,
            "eventTime": event,
            "sourceId": source_key[0] if source_key else None,
            "sourceHash": source_key[1] if source_key else None,
            "rawHash": source_key[2] if source_key else None,
            "sourcePath": str((args.source_root / source_key[3]).resolve()) if source_key and not Path(source_key[3]).is_absolute() else source_key[3] if source_key else None,
            "sourceBytesPath": source_key[3] if source_key else None,
            "occurrences": sorted(normalized_rows, key=lambda row: (row["sourceLineOrdinal"], row["sourceOccurrenceOrdinal"], row["occurrenceId"])),
        }
    actual_ids = sorted(rows_by_video)
    if expected_ids is not None and actual_ids != sorted(expected_ids):
        fail("EXPECTED_IDS_MISMATCH", f"missing={sorted(set(expected_ids) - set(actual_ids))}:extra={sorted(set(actual_ids) - set(expected_ids))}")
    if args.expected_video_count is not None and len(actual_ids) != args.expected_video_count:
        fail("VIDEO_COUNT_MISMATCH", f"expected={args.expected_video_count}:actual={len(actual_ids)}")
    real = sum(not row["isSentinel"] for row in all_rows)
    sentinel = sum(row["isSentinel"] for row in all_rows)
    if real != args.expected_real_occurrences:
        fail("REAL_COUNT_MISMATCH", f"expected={args.expected_real_occurrences}:actual={real}")
    if sentinel != args.expected_sentinel_occurrences:
        fail("SENTINEL_COUNT_MISMATCH", f"expected={args.expected_sentinel_occurrences}:actual={sentinel}")
    return {
        "schemaVersion": "formal-source-index/v2",
        "status": "CLOSED",
        "videoCount": len(actual_ids),
        "realOccurrenceCount": real,
        "sentinelOccurrenceCount": sentinel,
        "providerOutputSha256": sha256_file(args.provider_output),
        "sources": [rows_by_video[key] for key in actual_ids],
        "occurrences": sorted(all_rows, key=lambda row: (row["videoId"], row["sourceLineOrdinal"], row["sourceOccurrenceOrdinal"], row["occurrenceId"])),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider-output", type=Path, required=True)
    parser.add_argument("--source-capture", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-ids", type=Path, required=True)
    parser.add_argument("--expected-video-count", type=int, required=True)
    parser.add_argument("--expected-real-occurrences", type=int, required=True)
    parser.add_argument("--expected-sentinel-occurrences", type=int, required=True)
    parser.add_argument("--route-as-of-utc", required=True)
    args = parser.parse_args(argv)
    try:
        result = convert(args)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        print("BRIDGE_OK " + json.dumps({key: result[key] for key in ("videoCount", "realOccurrenceCount", "sentinelOccurrenceCount")}, sort_keys=True))
        return 0
    except BridgeError as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        return REJECT


if __name__ == "__main__":
    raise SystemExit(main())
