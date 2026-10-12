#!/usr/bin/env python3
"""Candidate-only, metadata-only enrichment for the frozen Jul29 nine-video set.

The only external operation is one ``yt-dlp --skip-download`` metadata query per
video.  The script never downloads media and never writes a product database,
index, or checkout file.  It emits normalized records plus the raw JSON payload
inside an artifact so the source hash remains auditable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = "jul29-nine-video-metadata/v1"
MANIFEST_TYPE = "jul29-nine-video-metadata-artifact"
EXPECTED_VIDEO_COUNT = 9
EXPECTED_OCCURRENCE_COUNT = 90
REQUIRED_FIELDS = (
    "title",
    "channelId",
    "channelName",
    "handle",
    "url",
    "publishedAt",
    "thumbnail",
    "duration",
)
NEEDS_REVIEW_EXIT = 78


class CandidateError(RuntimeError):
    """A fail-closed input, provider, or output-contract error."""


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise CandidateError(f"cannot read JSON {path}: {exc}") from exc


def required_string(value: dict[str, Any], key: str, context: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result.strip():
        raise CandidateError(f"{context}.{key} must be a non-empty string")
    return result.strip()


def load_config(path: Path) -> dict[str, Any]:
    config = read_json(path)
    if not isinstance(config, dict):
        raise CandidateError("input config must be an object")
    videos = config.get("videos")
    if not isinstance(videos, list) or len(videos) != EXPECTED_VIDEO_COUNT:
        raise CandidateError(f"input config must contain exactly {EXPECTED_VIDEO_COUNT} videos")

    seen: set[str] = set()
    occurrence_total = 0
    for index, video in enumerate(videos):
        if not isinstance(video, dict):
            raise CandidateError(f"videos[{index}] must be an object")
        video_id = required_string(video, "videoId", f"videos[{index}]")
        if video_id in seen:
            raise CandidateError(f"duplicate videoId: {video_id}")
        seen.add(video_id)
        url = required_string(video, "url", f"videos[{index}]")
        if video_id not in url:
            raise CandidateError(f"videos[{index}].url does not bind videoId {video_id}")
        count = video.get("expectedOccurrenceCount")
        if not isinstance(count, int) or count < 0:
            raise CandidateError(f"videos[{index}].expectedOccurrenceCount must be a non-negative integer")
        required_string(video, "sourceHash", f"videos[{index}]")
        occurrence_total += count
    if occurrence_total != EXPECTED_OCCURRENCE_COUNT:
        raise CandidateError(f"expected 90 bound occurrences, got {occurrence_total}")
    return config


def build_ytdlp_command(url: str, executable: str = "yt-dlp") -> list[str]:
    """Build a command that requests metadata and explicitly skips media."""

    return [
        executable,
        "--skip-download",
        "--dump-single-json",
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--no-write-info-json",
        "--no-write-thumbnail",
        "--no-write-description",
        "--no-write-comments",
        "--",
        url,
    ]


def parse_provider_stdout(stdout: str, video_id: str) -> dict[str, Any]:
    text = stdout.strip()
    if not text:
        raise CandidateError(f"yt-dlp returned empty metadata for {video_id}")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                candidate = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict) and candidate.get("id") == video_id:
                parsed = candidate
                break
        if parsed is None:
            raise CandidateError(f"cannot parse yt-dlp JSON for {video_id}")
    if not isinstance(parsed, dict):
        raise CandidateError(f"yt-dlp metadata for {video_id} is not an object")
    return parsed


def run_ytdlp(url: str, video_id: str, executable: str = "yt-dlp") -> dict[str, Any]:
    command = build_ytdlp_command(url, executable)
    try:
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError as exc:
        raise CandidateError(f"cannot execute {executable}: {exc}") from exc
    if completed.returncode != 0:
        stderr = completed.stderr.strip().replace("\n", " ")
        raise CandidateError(f"yt-dlp failed for {video_id} with exit {completed.returncode}: {stderr[-500:]}")
    return parse_provider_stdout(completed.stdout, video_id)


def load_fixture(path: Path) -> dict[str, dict[str, Any]]:
    fixture = read_json(path)
    records = fixture.get("records") if isinstance(fixture, dict) else fixture
    if not isinstance(records, list):
        raise CandidateError("fixture must be a list or an object with records[]")
    result: dict[str, dict[str, Any]] = {}
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise CandidateError(f"fixture[{index}] must be an object")
        video_id = required_string(record, "id", f"fixture[{index}]")
        if video_id in result:
            raise CandidateError(f"duplicate fixture videoId: {video_id}")
        result[video_id] = record
    return result


def utc_timestamp(raw: dict[str, Any], video_id: str) -> str:
    value = raw.get("release_timestamp", raw.get("timestamp"))
    if value is None and isinstance(raw.get("upload_date"), str):
        upload_date = raw["upload_date"]
        if len(upload_date) == 8 and upload_date.isdigit():
            value = datetime.strptime(upload_date, "%Y%m%d").replace(tzinfo=timezone.utc).timestamp()
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise CandidateError(f"metadata for {video_id} has no numeric published timestamp")
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def numeric_duration(raw: dict[str, Any], video_id: str) -> int | float:
    duration = raw.get("duration")
    if not isinstance(duration, (int, float)) or isinstance(duration, bool) or duration < 0:
        raise CandidateError(f"metadata for {video_id} has no valid duration")
    return duration


def provider_record(
    video: dict[str, Any], raw: dict[str, Any], input_path: Path, config: dict[str, Any]
) -> dict[str, Any]:
    video_id = required_string(video, "videoId", "input video")
    actual_id = raw.get("id", raw.get("video_id"))
    if actual_id != video_id:
        raise CandidateError(f"provider videoId mismatch: expected {video_id}, got {actual_id!r}")

    title = required_string(raw, "title", f"metadata[{video_id}]")
    channel_id = required_string(raw, "channel_id", f"metadata[{video_id}]")
    channel_name = raw.get("channel", raw.get("uploader"))
    if not isinstance(channel_name, str) or not channel_name.strip():
        raise CandidateError(f"metadata[{video_id}].channel is missing")
    handle = raw.get("channel_handle", raw.get("uploader_id"))
    if not isinstance(handle, str) or not handle.strip():
        raise CandidateError(f"metadata[{video_id}].channel_handle is missing")
    url = required_string(raw, "webpage_url", f"metadata[{video_id}]")
    thumbnail = required_string(raw, "thumbnail", f"metadata[{video_id}]")
    duration = numeric_duration(raw, video_id)
    raw_bytes = canonical_json(raw)

    return {
        "recordType": "video-metadata",
        "schemaVersion": SCHEMA_VERSION,
        "candidateOnly": True,
        "releaseEligible": False,
        "videoId": video_id,
        "title": title,
        "channelId": channel_id,
        "channelName": channel_name.strip(),
        "handle": handle.strip(),
        "url": url,
        "publishedAt": utc_timestamp(raw, video_id),
        "thumbnail": thumbnail,
        "duration": duration,
        "source": {
            "system": "yt-dlp",
            "metadataOnly": True,
            "downloaded": False,
            "inputUrl": video["url"],
            "rawMetadataSha256": sha256_bytes(raw_bytes),
            "rawMetadata": raw,
        },
        "occurrenceBinding": {
            "expectedOccurrenceCount": video["expectedOccurrenceCount"],
            "sourceHash": video["sourceHash"],
            "sourceCandidateSha256": video.get("sourceCandidateSha256", config.get("sourceCandidateSha256")),
            "sourcePath": video.get("occurrenceSourcePath", config.get("occurrenceSourcePath")),
            "preserveIdentityAndProvenance": True,
        },
        "inputConfig": str(input_path),
    }


def write_artifacts(
    records: list[dict[str, Any]], input_path: Path, output_path: Path, manifest_path: Path, config: dict[str, Any]
) -> None:
    output_bytes = b"".join(canonical_json(record) for record in records)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(output_bytes)
    manifest = {
        "manifestType": MANIFEST_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "candidateOnly": True,
        "releaseEligible": False,
        "activated": False,
        "metadataOnly": True,
        "downloaded": False,
        "videoCount": len(records),
        "occurrenceCount": sum(record["occurrenceBinding"]["expectedOccurrenceCount"] for record in records),
        "videoIds": [record["videoId"] for record in records],
        "inputConfigSha256": sha256_file(input_path),
        "outputSha256": sha256_file(output_path),
        "sourceCandidateSha256": config.get("sourceCandidateSha256"),
        "sourceArtifact": config.get("sourceArtifact"),
        "noProductWrite": True,
        "noIndexWrite": True,
        "noPgWrite": True,
    }
    manifest_path.write_bytes(canonical_json(manifest))


def execute(args: argparse.Namespace) -> None:
    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()
    manifest_path = Path(args.manifest).resolve()
    config = load_config(input_path)
    fixture = load_fixture(Path(args.fixture)) if args.fixture else None
    expected_ids = {video["videoId"] for video in config["videos"]}
    if fixture is not None and set(fixture) != expected_ids:
        missing = sorted(expected_ids - set(fixture))
        extra = sorted(set(fixture) - expected_ids)
        raise CandidateError(f"fixture ID set mismatch; missing={missing}, extra={extra}")
    records: list[dict[str, Any]] = []
    for video in config["videos"]:
        video_id = video["videoId"]
        if fixture is not None:
            if video_id not in fixture:
                raise CandidateError(f"fixture is missing {video_id}")
            raw = fixture[video_id]
        else:
            raw = run_ytdlp(video["url"], video_id, args.yt_dlp)
        records.append(provider_record(video, raw, input_path, config))
    if len(records) != EXPECTED_VIDEO_COUNT:
        raise CandidateError(f"expected {EXPECTED_VIDEO_COUNT} output records, got {len(records)}")
    write_artifacts(records, input_path, output_path, manifest_path, config)


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="frozen nine-video JSON binding")
    parser.add_argument("--output", required=True, help="candidate metadata NDJSON artifact path")
    parser.add_argument("--manifest", required=True, help="candidate artifact manifest path")
    parser.add_argument("--fixture", help="offline yt-dlp JSON fixture for tests")
    parser.add_argument("--yt-dlp", default="yt-dlp", help="yt-dlp executable")
    return parser.parse_args(list(argv) if argv is not None else None)


def main(argv: Iterable[str] | None = None) -> int:
    try:
        execute(parse_args(argv))
    except CandidateError as exc:
        print(f"candidate error: {exc}", file=sys.stderr)
        return NEEDS_REVIEW_EXIT
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
