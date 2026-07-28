#!/usr/bin/env python3
"""Convert accepted channel increments into the PG overlay NDJSON protocol.

This is deliberately a streaming writer over files that are already accepted
artifacts. It does not build SQLite or merge a full runtime projection. The
workflow supplies ``--range-id 7d`` for the 7D release and keeps the source
manifest fields in each record for auditability.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
from typing import Any, Iterable


def text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def first_present(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return None


def published_at(value: Any) -> Any:
    if isinstance(value, (int, float)):
        timestamp = float(value)
        if timestamp > 100_000_000_000:
            timestamp /= 1000
        return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
    return value


def reviewed_timestamp(value: str | None) -> str:
    if not value:
        return datetime.now(timezone.utc).isoformat()
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("--reviewed-at must include a timezone")
    return parsed.astimezone(timezone.utc).isoformat()


def read_payload(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"accepted artifact must be an object: {path}")
    videos = payload.get("videos")
    if not isinstance(videos, list):
        raise ValueError(f"accepted artifact has no videos list: {path}")
    return payload


def input_paths(args: argparse.Namespace) -> list[Path]:
    paths = [Path(item) for item in args.input]
    if args.input_list:
        for line in Path(args.input_list).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                paths.append(Path(line))
    if not paths:
        raise ValueError("at least one --input or --input-list path is required")
    return paths


def occurrence_id(item: dict[str, Any], position: int) -> str:
    value = first_present(item, "occurrenceId", "occurrence_id")
    return text(value) or f"position:{position}"


def convert_video(video: dict[str, Any], source: dict[str, Any], source_path: Path, default_range: str, reviewed_at: str) -> dict[str, Any]:
    video_id = text(first_present(video, "videoId", "video_id"))
    if not video_id:
        raise ValueError(f"accepted video missing videoId: {source_path}")
    values = video.get("songs")
    if not isinstance(values, list):
        values = video.get("entries") if isinstance(video.get("entries"), list) else []
    songs: list[dict[str, Any]] = []
    seen: set[str] = set()
    range_id = first_present(video, "rangeId", "range_id")
    if range_id is None:
        range_id = first_present(source, "rangeId", "range_id", "range")
    if range_id is None:
        range_id = default_range
    source_system = first_present(video, "sourceSystem", "source_system")
    if source_system is None:
        source_system = first_present(source, "sourceSystem", "source_system")
    if source_system is None:
        source_system = "youtube_channel_discovery"
    for position, raw_item in enumerate(values):
        if not isinstance(raw_item, dict):
            raise ValueError(f"video {video_id} has non-object occurrence at position {position}")
        item = dict(raw_item)
        item_id = occurrence_id(item, position)
        if item_id in seen:
            raise ValueError(f"video {video_id} repeats occurrence identity={item_id}")
        seen.add(item_id)
        item["occurrenceId"] = item_id
        item["position"] = first_present(item, "position", "index")
        if item["position"] is None:
            item["position"] = position
        # Preserve null seconds, empty artist/sourceId, range and provenance.
        item["rangeId"] = first_present(item, "rangeId", "range_id")
        if item["rangeId"] is None:
            item["rangeId"] = range_id
        item["sourceSystem"] = first_present(item, "sourceSystem", "source_system")
        if item["sourceSystem"] is None:
            item["sourceSystem"] = source_system
        item["videoId"] = video_id
        item["sourcePath"] = str(source_path)
        item["reviewedAt"] = reviewed_at
        songs.append(item)
    record = dict(video)
    record["videoId"] = video_id
    record["publishedAt"] = published_at(first_present(video, "publishedAt", "published_at", "publishedTimestamp", "published_timestamp"))
    record["rangeId"] = range_id
    record["sourceSystem"] = source_system
    record["songs"] = songs
    record["sourcePath"] = str(source_path)
    record["reviewedAt"] = reviewed_at
    record.setdefault("reviewedBy", "accepted-file-converter")
    record.setdefault("reason", "accepted-channel-increment")
    return record


def convert(
    paths: Iterable[Path],
    output: Path,
    manifest_path: Path,
    default_range: str,
    source_key: str | None,
    status_audit_path: Path | None = None,
    reviewed_at: str | None = None,
) -> dict[str, Any]:
    reviewed_at = reviewed_timestamp(reviewed_at)
    source_hash = hashlib.sha256()
    records = 0
    occurrences = 0
    input_names: list[str] = []
    range_ids: set[str] = set()
    source_systems: set[str] = set()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as stream:
        for path in paths:
            payload = read_payload(path)
            raw = path.read_bytes()
            source_hash.update(raw)
            input_names.append(str(path))
            for video in payload["videos"]:
                if not isinstance(video, dict):
                    raise ValueError(f"accepted artifact has non-object video: {path}")
                record = convert_video(video, payload, path, default_range, reviewed_at)
                encoded = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
                stream.write(encoded)
                records += 1
                occurrences += len(record["songs"])
                range_ids.add(text(record["rangeId"]))
                source_systems.add(text(record["sourceSystem"]))
    status_audit = json.loads(status_audit_path.read_text(encoding="utf-8")) if status_audit_path else {}
    manifest = {
        "schemaVersion": 1,
        "kind": "accepted-increment",
        "generatedAt": reviewed_at,
        "sourceKey": source_key,
        "rangeId": default_range,
        "range": default_range,
        "sourceReachedEnd": True,
        "mediaDownloaded": False,
        "statusAuditIncluded": bool(status_audit_path),
        "inputFiles": input_names,
        "sourceManifestSha256": source_hash.hexdigest(),
        "acceptedVideoCount": records,
        "acceptedOccurrenceCount": occurrences,
        "rangeIds": sorted(range_ids),
        "sourceSystems": sorted(source_systems),
        "reviewAudit": status_audit.get("summary", {}) if isinstance(status_audit, dict) else {},
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", action="append", default=[])
    parser.add_argument("--input-list")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest-output", type=Path, required=True)
    parser.add_argument("--range-id", default="all")
    parser.add_argument("--source-key")
    parser.add_argument("--status-audit", type=Path)
    parser.add_argument(
        "--reviewed-at",
        help="Deterministic timezone-aware source review/commit timestamp",
    )
    args = parser.parse_args()
    try:
        manifest = convert(
            input_paths(args),
            args.output,
            args.manifest_output,
            args.range_id,
            args.source_key,
            args.status_audit,
            args.reviewed_at,
        )
        print(json.dumps({"status": "ok", **manifest}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"ACCEPTED_INCREMENT_CONVERTER_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
