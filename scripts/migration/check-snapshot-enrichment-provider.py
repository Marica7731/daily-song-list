#!/usr/bin/env python3
"""Validate a snapshot-enrichment provider artifact without claiming release."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any


def fail(message: str) -> None:
    raise SystemExit(f"SNAPSHOT_PROVIDER_CHECK_FAILED: {message}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"invalid UTF-8 JSON {path}: {error}")


def non_empty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def canonical_utc(value: Any) -> bool:
    if not non_empty(value) or not value.endswith("Z"):
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return True


def require_sha(path: Path, expected: str, label: str) -> None:
    actual = sha256(path)
    if actual != expected.lower():
        fail(f"{label} SHA-256 mismatch: expected {expected.lower()}, got {actual}")


def validate_inputs(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    sample = read_json(args.sample)
    manifest = read_json(args.input_manifest)
    if not isinstance(sample, dict) or not isinstance(sample.get("videos"), list):
        fail("sample must be an object with videos[]")
    if sample.get("trialRoute") != "all":
        fail("Jul27 pilot sample must route to historical all")
    videos = sample["videos"]
    if len(videos) != args.expected_count:
        fail(f"sample count mismatch: expected {args.expected_count}, got {len(videos)}")
    ids = [row.get("videoId") if isinstance(row, dict) else None for row in videos]
    if any(not non_empty(video_id) for video_id in ids):
        fail("sample has a row without a non-empty videoId")
    if len(set(ids)) != len(ids):
        fail("sample contains duplicate videoId values")

    if not isinstance(manifest, dict):
        fail("input manifest must be an object")
    selection = manifest.get("selection")
    source = manifest.get("source")
    inputs = manifest.get("inputs")
    if manifest.get("route") != "all" or manifest.get("targetDate") != "2026-07-27":
        fail("input manifest route/date binding mismatch")
    if not isinstance(selection, dict) or selection.get("uniqueVideoInputs") != args.expected_count:
        fail("input manifest uniqueVideoInputs mismatch")
    if not isinstance(inputs, list) or len(inputs) != args.expected_count:
        fail("input manifest inputs cardinality mismatch")
    manifest_ids = [row.get("videoId") if isinstance(row, dict) else None for row in inputs]
    if manifest_ids != ids:
        fail("sample video order/identity does not match input manifest")
    if not isinstance(source, dict):
        fail("input manifest source binding is missing")
    if source.get("sha256") != args.expected_source_sha256.lower():
        fail("input manifest source SHA-256 binding mismatch")
    if source.get("bytes") != args.source.stat().st_size:
        fail("input manifest source byte-size binding mismatch")
    return sample, manifest, ids


def read_provider(path: Path) -> list[dict[str, Any]]:
    try:
        raw_lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    except (OSError, UnicodeDecodeError) as error:
        fail(f"invalid provider NDJSON {path}: {error}")
    rows: list[dict[str, Any]] = []
    for index, line in enumerate(raw_lines, start=1):
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            fail(f"provider NDJSON line {index} is invalid: {error}")
        if not isinstance(value, dict):
            fail(f"provider NDJSON line {index} is not an object")
        rows.append(value)
    return rows


def validate_provider(args: argparse.Namespace, expected_ids: list[str]) -> dict[str, Any]:
    rows = read_provider(args.provider)
    if len(rows) != args.expected_count + 1:
        fail(f"provider line count mismatch: expected {args.expected_count + 1}, got {len(rows)}")
    header, records = rows[0], rows[1:]
    if header.get("provider") != "snapshot-enrichment-provider-v4":
        fail("provider version mismatch")
    if header.get("sampleSha256") != args.expected_sample_sha256.lower():
        fail("provider header sample SHA-256 mismatch")
    if header.get("sampleCount") != args.expected_count or header.get("recordCount") != args.expected_count:
        fail("provider header cardinality mismatch")
    if header.get("expectedIds") != expected_ids:
        fail("provider header expectedIds mismatch")
    if header.get("releaseReady") is not False:
        fail("provider evidence must remain not-for-release")

    record_ids = [row.get("videoId") for row in records]
    if record_ids != expected_ids or len(set(record_ids)) != len(record_ids):
        fail("provider record order/identity mismatch")

    status_counts: Counter[str] = Counter()
    missing_counts: Counter[str] = Counter()
    occurrence_count = 0
    videos_with_songs = 0
    for index, record in enumerate(records):
        prefix = f"records[{index}]"
        if record.get("recordType") != "enrichment" or record.get("trialRoute") != "all":
            fail(f"{prefix} recordType/trialRoute mismatch")
        status = record.get("status")
        if status not in {"ok", "needs_review"}:
            fail(f"{prefix} invalid status: {status!r}")
        status_counts[status] += 1
        songs = record.get("songs")
        if not isinstance(songs, list):
            fail(f"{prefix}.songs must be an array")
        if songs:
            videos_with_songs += 1
        occurrence_count += len(songs)
        for field in ("eventTime", "channelId", "channelTitle"):
            value = record.get(field)
            if field == "eventTime" and not canonical_utc(value):
                missing_counts[field] += 1
            elif field != "eventTime" and not non_empty(value):
                missing_counts[field] += 1
        if not songs:
            missing_counts["songs"] += 1
        for song in songs:
            if not isinstance(song, dict):
                fail(f"{prefix}.songs contains a non-object")
            for field in ("occurrenceId", "title", "artist"):
                if not non_empty(song.get(field)):
                    missing_counts[f"song.{field}"] += 1
            seconds = song.get("seconds")
            if not isinstance(seconds, (int, float)) or seconds < 0:
                missing_counts["song.seconds"] += 1
            source = song.get("source")
            if not isinstance(source, dict):
                missing_counts["song.source"] += 1
                continue
            for field in ("sourceId", "sourceHash", "rawHash", "sourcePath", "sourceSystem"):
                if not non_empty(source.get(field)):
                    missing_counts[f"song.source.{field}"] += 1
            if not isinstance(source.get("provenance"), dict) or not source["provenance"]:
                missing_counts["song.source.provenance"] += 1

    process = read_json(args.process)
    if not isinstance(process, dict) or process.get("exitCode") != 0:
        fail("provider process evidence is missing a zero exitCode")
    if process.get("sourceCommit") != args.source_commit:
        fail("provider process sourceCommit mismatch")
    if process.get("sampleSha256") != args.expected_sample_sha256.lower():
        fail("provider process sample SHA-256 mismatch")

    release_ready = (
        status_counts["ok"] == args.expected_count
        and status_counts["needs_review"] == 0
        and occurrence_count > 0
        and not missing_counts
    )
    return {
        "schemaVersion": "snapshot-recovery-field-completeness/v1",
        "state": "SOURCE_READY" if release_ready else "DISCOVERED",
        "candidateReady": False,
        "activationReady": False,
        "releaseReady": release_ready,
        "sourceCommit": args.source_commit,
        "route": "all",
        "targetDate": "2026-07-27",
        "sampleSha256": args.expected_sample_sha256.lower(),
        "inputManifestSha256": args.expected_input_manifest_sha256.lower(),
        "sourceSha256": args.expected_source_sha256.lower(),
        "videoCount": args.expected_count,
        "recordCount": len(records),
        "okCount": status_counts["ok"],
        "needsReviewCount": status_counts["needs_review"],
        "videosWithSongs": videos_with_songs,
        "occurrenceCount": occurrence_count,
        "missingFieldCounts": dict(sorted(missing_counts.items())),
        "providerHeader": header,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", type=Path, required=True)
    parser.add_argument("--input-manifest", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--expected-sample-sha256", required=True)
    parser.add_argument("--expected-input-manifest-sha256", required=True)
    parser.add_argument("--expected-source-sha256", required=True)
    parser.add_argument("--expected-count", type=int, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--preflight-only", action="store_true")
    parser.add_argument("--provider", type=Path)
    parser.add_argument("--process", type=Path)
    parser.add_argument("--summary", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if len(args.source_commit) != 40 or any(char not in "0123456789abcdef" for char in args.source_commit):
        fail("source commit must be a lowercase 40-hex SHA")
    require_sha(args.sample, args.expected_sample_sha256, "sample")
    require_sha(args.input_manifest, args.expected_input_manifest_sha256, "input manifest")
    require_sha(args.source, args.expected_source_sha256, "source")
    _, _, expected_ids = validate_inputs(args)
    if args.preflight_only:
        print(f"SNAPSHOT_PROVIDER_PREFLIGHT_OK videos={len(expected_ids)} route=all")
        return
    if args.provider is None or args.process is None or args.summary is None:
        fail("--provider, --process, and --summary are required outside --preflight-only")
    summary = validate_provider(args, expected_ids)
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        "SNAPSHOT_PROVIDER_CHECK_OK "
        f"videos={summary['videoCount']} occurrences={summary['occurrenceCount']} "
        f"ok={summary['okCount']} needs_review={summary['needsReviewCount']} "
        f"state={summary['state']}"
    )


if __name__ == "__main__":
    main()
