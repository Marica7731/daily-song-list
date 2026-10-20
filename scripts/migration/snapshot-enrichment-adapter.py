#!/usr/bin/env python3
"""Fail-closed adapter for the candidate enrichment artifact.

The adapter accepts needs_review records so the controller can audit every
expected video. It never turns an incomplete record into ok or release-ready.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
import sys
from pathlib import Path
from typing import Any


PROVIDER = "snapshot-enrichment-provider-v4"
CONTRACT = "luna-max-mac-enrichment/v4-candidate"
RECORD_FIELDS = (
    "recordType",
    "schemaVersion",
    "videoId",
    "trialRoute",
    "releaseRoute",
    "releaseCutoffUtc",
    "eventTime",
    "channelId",
    "channelTitle",
    "songs",
    "status",
    "diagnostic",
    "audit",
)
SONG_FIELDS = ("occurrenceId", "seconds", "title", "artist", "source")
SOURCE_FIELDS = ("sourceId", "sourceHash", "rawHash", "sourcePath", "sourceSystem", "provenance")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
ISO_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class ContractError(ValueError):
    pass


def required(mapping: dict[str, Any], key: str, context: str) -> Any:
    if key not in mapping:
        raise ContractError(f"missing {context}.{key}; absent is not null")
    return mapping[key]


def has_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


def valid_seconds(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and value >= 0
    )


def valid_iso_utc(value: Any) -> bool:
    if not isinstance(value, str) or not ISO_UTC.fullmatch(value):
        return False
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z") == value


def read_provider(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise ContractError(f"cannot read provider NDJSON: {exc}") from exc
    if not lines:
        raise ContractError("provider NDJSON is empty")
    try:
        header = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        raise ContractError(f"invalid provider header: {exc}") from exc
    if not isinstance(header, dict):
        raise ContractError("provider header must be an object")
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines[1:], 2):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ContractError(f"invalid provider record at line {line_number}: {exc}") from exc
        if not isinstance(value, dict):
            raise ContractError(f"provider record at line {line_number} is not an object")
        records.append(value)
    return header, records


def validate_header(header: dict[str, Any], record_count: int) -> list[str]:
    if header.get("provider") != PROVIDER:
        raise ContractError("unexpected provider version")
    if header.get("contract") != CONTRACT:
        raise ContractError("unexpected provider contract")
    expected_ids = required(header, "expectedIds", "header")
    if not isinstance(expected_ids, list) or not expected_ids or not all(
        isinstance(value, str) and value for value in expected_ids
    ):
        raise ContractError("header.expectedIds must be a non-empty string array")
    if len(set(expected_ids)) != len(expected_ids):
        raise ContractError("header.expectedIds contains duplicates")
    if header.get("sampleCount") != len(expected_ids):
        raise ContractError("header sampleCount does not equal expectedIds length")
    if header.get("recordCount") != record_count:
        raise ContractError(
            f"header recordCount mismatch: expected {header.get('recordCount')}, got {record_count}"
        )
    sample_sha = header.get("sampleSha256")
    if not isinstance(sample_sha, str) or not HEX64.fullmatch(sample_sha.lower()):
        raise ContractError("header.sampleSha256 must be a 64-character lowercase/uppercase hex string")
    if header.get("releaseReady") is not False:
        raise ContractError("header.releaseReady must be false")
    if not isinstance(header.get("needsReviewCount"), int) or isinstance(header["needsReviewCount"], bool):
        raise ContractError("header.needsReviewCount must be an integer")
    return expected_ids


def validate_source(value: Any, context: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError(f"{context}.source must be an object")
    if set(value) != set(SOURCE_FIELDS):
        raise ContractError(f"{context}.source fields must be exactly {list(SOURCE_FIELDS)}")
    for key in SOURCE_FIELDS:
        required(value, key, f"{context}.source")
        current = value[key]
        if key == "provenance":
            if current is not None and not isinstance(current, dict):
                raise ContractError(f"{context}.source.provenance must be an object or null")
        elif current is not None and not isinstance(current, str):
            raise ContractError(f"{context}.source.{key} must be a string or null")
    return {key: value[key] for key in SOURCE_FIELDS}


def validate_song(value: Any, context: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError(f"{context} must be an object")
    if set(value) != set(SONG_FIELDS):
        raise ContractError(f"{context} fields must be exactly {list(SONG_FIELDS)}")
    for key in SONG_FIELDS:
        required(value, key, context)
    if value["occurrenceId"] is not None and not isinstance(value["occurrenceId"], str):
        raise ContractError(f"{context}.occurrenceId must be a string or null")
    if value["seconds"] is not None and not valid_seconds(value["seconds"]):
        raise ContractError(f"{context}.seconds must be a non-negative number or null")
    for key in ("title", "artist"):
        if value[key] is not None and not isinstance(value[key], str):
            raise ContractError(f"{context}.{key} must be a string or null")
    return {
        "occurrenceId": value["occurrenceId"],
        "seconds": value["seconds"],
        "title": value["title"],
        "artist": value["artist"],
        "source": validate_source(value["source"], context),
    }


def completeness_missing(record: dict[str, Any], index: int) -> list[str]:
    context = f"record[{index}]"
    missing: list[str] = []
    if not valid_iso_utc(record["eventTime"]):
        missing.append(f"{context}.eventTime")
    if record["channelId"] is None or not has_value(record["channelId"]):
        missing.append(f"{context}.channelId")
    if record["channelTitle"] is None or not has_value(record["channelTitle"]):
        missing.append(f"{context}.channelTitle")
    if not record["songs"]:
        missing.append(f"{context}.songs")
    for song_index, song in enumerate(record["songs"]):
        prefix = f"{context}.songs[{song_index}]"
        if not has_value(song["occurrenceId"]):
            missing.append(f"{prefix}.occurrenceId")
        if song["seconds"] is None or not valid_seconds(song["seconds"]):
            missing.append(f"{prefix}.seconds")
        if not has_value(song["title"]):
            missing.append(f"{prefix}.title")
        if not has_value(song["artist"]):
            missing.append(f"{prefix}.artist")
        source = song["source"]
        for key in SOURCE_FIELDS:
            if key == "provenance":
                if not isinstance(source[key], dict) or not source[key]:
                    missing.append(f"{prefix}.source.provenance")
            elif not has_value(source[key]):
                missing.append(f"{prefix}.source.{key}")
    return missing


def validate_record(value: Any, index: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError(f"record {index} is not an object")
    context = f"record[{index}]"
    if set(value) != set(RECORD_FIELDS):
        raise ContractError(f"{context} fields must be exactly {list(RECORD_FIELDS)}")
    for key in RECORD_FIELDS:
        required(value, key, context)
    if value["recordType"] != "enrichment":
        raise ContractError(f"{context}.recordType must be enrichment")
    if value["schemaVersion"] != CONTRACT:
        raise ContractError(f"{context}.schemaVersion must be {CONTRACT}")
    video_id = value["videoId"]
    if not isinstance(video_id, str) or not video_id:
        raise ContractError(f"{context}.videoId must be a non-empty string")
    if value["trialRoute"] is not None and (not isinstance(value["trialRoute"], str) or not value["trialRoute"].strip()):
        raise ContractError(f"{context}.trialRoute must be a non-empty string or null")
    if value["releaseRoute"] is not None or value["releaseCutoffUtc"] is not None:
        raise ContractError(f"{context} release fields must remain null")
    for key in ("eventTime", "channelId", "channelTitle"):
        if value[key] is not None and not isinstance(value[key], str):
            raise ContractError(f"{context}.{key} must be a string or null")
    if value["eventTime"] is not None and not valid_iso_utc(value["eventTime"]):
        raise ContractError(f"{context}.eventTime must be canonical UTC ISO-8601")
    if not isinstance(value["songs"], list):
        raise ContractError(f"{context}.songs must be an array")
    if value["diagnostic"] is not None and not isinstance(value["diagnostic"], dict):
        raise ContractError(f"{context}.diagnostic must be an object or null")
    if value["audit"] is not None and not isinstance(value["audit"], dict):
        raise ContractError(f"{context}.audit must be an object or null")
    if value["status"] not in {"ok", "needs_review"}:
        raise ContractError(f"{context}.status must be ok or needs_review")

    songs = []
    occurrence_ids: set[str] = set()
    for song_index, song in enumerate(value["songs"]):
        normalized = validate_song(song, f"{context}.songs[{song_index}]")
        occurrence_id = normalized["occurrenceId"]
        if occurrence_id is not None:
            if not occurrence_id:
                raise ContractError(f"{context}.songs[{song_index}].occurrenceId must not be empty")
            if occurrence_id in occurrence_ids:
                raise ContractError(f"duplicate occurrenceId: {video_id}/{occurrence_id}")
            occurrence_ids.add(occurrence_id)
        songs.append(normalized)

    missing = completeness_missing({**value, "songs": songs}, index)
    if value["status"] == "ok":
        if missing:
            raise ContractError(f"status ok contradicts incomplete record {index}: missing={missing}")
        if value["diagnostic"] is not None:
            raise ContractError(f"status ok requires diagnostic=null at record {index}")
        if not isinstance(value["audit"], dict):
            raise ContractError(f"status ok requires audit object at record {index}")
    else:
        if not isinstance(value["diagnostic"], dict):
            raise ContractError(f"needs_review requires a per-video diagnostic at record {index}")
    return {**value, "songs": songs}


def convert(provider_path: Path) -> list[dict[str, Any]]:
    header, raw_records = read_provider(provider_path)
    expected_ids = validate_header(header, len(raw_records))
    records = [validate_record(record, index) for index, record in enumerate(raw_records)]
    actual_ids = [record["videoId"] for record in records]
    if len(set(actual_ids)) != len(actual_ids):
        duplicate = next(identifier for identifier in actual_ids if actual_ids.count(identifier) > 1)
        raise ContractError(f"duplicate videoId: {duplicate}")
    if actual_ids != expected_ids:
        actual_set = set(actual_ids)
        expected_set = set(expected_ids)
        missing = sorted(expected_set - actual_set)
        extra = sorted(actual_set - expected_set)
        raise ContractError(f"ID closure mismatch/order: missing={missing} extra={extra}")
    actual_review_count = sum(record["status"] == "needs_review" for record in records)
    if header["needsReviewCount"] != actual_review_count:
        raise ContractError(
            f"header needsReviewCount mismatch: expected {header['needsReviewCount']}, got {actual_review_count}"
        )
    return records


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        records = convert(args.provider)
        args.out.write_text(
            "".join(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n" for record in records),
            encoding="utf-8",
        )
    except (OSError, ContractError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, "recordCount": len(records), "needsReviewCount": sum(r["status"] == "needs_review" for r in records), "out": str(args.out)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
