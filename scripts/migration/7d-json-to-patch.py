#!/usr/bin/env python3
"""Build a range-scoped authoritative 7D overlay from two immutable snapshots.

The stream deliberately tombstones every occurrence from the previous 7D
snapshot before adding the current snapshot.  Tombstones and additions carry
``rangeId=7d``; the adapter therefore removes/replaces only the rolling-window
projection and leaves the physical ``all`` projection untouched.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import unicodedata
from typing import Any

SHA1 = re.compile(r"^[0-9a-f]{40}$")
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{6,}$")
CHANNEL_ID = re.compile(r"^UC[A-Za-z0-9_-]{20,}$")
MAX_BYTES = 64 * 1024 * 1024
MAX_VIDEOS = 100_000
MAX_OCCURRENCES = 200_000


def text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def fail(message: str) -> None:
    raise ValueError(message)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def git_blob_sha(value: bytes) -> str:
    return hashlib.sha1(f"blob {len(value)}\0".encode("ascii") + value).hexdigest()


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def normalized(value: Any) -> str:
    return " ".join(unicodedata.normalize("NFKC", text(value)).casefold().split())


def derived_song_key(title: Any, artist: Any) -> str:
    return hashlib.sha256(
        f"song\0{normalized(title)}\0{normalized(artist)}".encode("utf-8")
    ).hexdigest()[:24]


def parse_timestamp(value: Any, label: str) -> tuple[str, datetime]:
    raw = text(value)
    if not raw or not raw.endswith("Z"):
        fail(f"{label}.generatedAt must be RFC3339 UTC ending in Z")
    try:
        parsed = datetime.fromisoformat(raw[:-1] + "+00:00")
    except ValueError as exc:
        fail(f"{label}.generatedAt is malformed: {raw}")
        raise exc
    if parsed.utcoffset() is None:
        fail(f"{label}.generatedAt must include timezone")
    return raw, parsed.astimezone(timezone.utc)


def published_at(video: dict[str, Any]) -> Any:
    direct = video.get("publishedAt")
    if isinstance(direct, str) and direct.strip():
        return direct
    value = video.get("publishedTimestamp")
    if isinstance(value, bool):
        fail("publishedTimestamp cannot be boolean")
    if isinstance(value, (int, float)):
        seconds = float(value)
        if seconds > 100_000_000_000:
            seconds /= 1000
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat()
    return direct


def occurrence_id(song: dict[str, Any], position: int) -> str:
    value = text(
        song.get("occurrenceId")
        or song.get("occurrence_id")
    )
    return value or f"position:{position}"


def canonical_song(
    song: dict[str, Any], video_id: str, position: int
) -> dict[str, Any] | None:
    title = text(song.get("title"))
    # Core snapshots can contain timestamped commentary such as
    # "encore encore encore" with no actual song title.  It is not a song
    # occurrence, so do not manufacture one from the video's title.  The
    # containing video and every titled occurrence remain authoritative.
    if not title:
        return None
    if len(title) > 500:
        fail(f"video {video_id} occurrence {position} has invalid title")
    artist = song.get("artist")
    if artist is not None and not isinstance(artist, str):
        fail(f"video {video_id} occurrence {position} has invalid artist")
    seconds = song.get("seconds")
    if seconds is not None and (
        isinstance(seconds, bool)
        or not isinstance(seconds, (int, float))
        or seconds < 0
        or int(seconds) != seconds
    ):
        fail(f"video {video_id} occurrence {position} has invalid seconds")
    identity = occurrence_id(song, position)
    if len(identity) > 300:
        fail(f"video {video_id} occurrence identity is too long")
    item = dict(song)
    item.update(
        {
            "videoId": video_id,
            "occurrenceId": identity,
            "position": song.get("position", song.get("index", position)),
            "rangeId": "7d",
            "songKey": text(song.get("songKey")) or derived_song_key(title, artist),
            "sourceSystem": text(song.get("sourceSystem")) or "core-7d",
        }
    )
    return item


def load_snapshot(path: Path, label: str, args: argparse.Namespace) -> dict[str, Any]:
    raw = path.read_bytes()
    if not raw or len(raw) > args.max_bytes:
        fail(f"{label} input exceeds byte cap: {len(raw)}")
    try:
        root = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"{label} input is malformed: {exc}")
    if not isinstance(root, dict) or root.get("id") != "7d":
        fail(f"{label} root id must be exactly 7d")
    generated_raw, generated = parse_timestamp(root.get("generatedAt"), label)
    items = root.get("items")
    if not isinstance(items, list) or not items:
        fail(f"{label} items must be a non-empty array")
    if len(items) > args.max_videos:
        fail(f"{label} video cap exceeded")
    seen_videos: set[str] = set()
    input_occurrence_count = 0
    occurrence_count = 0
    skipped_titleless_count = 0
    skipped_empty_video_count = 0
    records: list[dict[str, Any]] = []
    identities: dict[tuple[str, str], dict[str, Any]] = {}
    for video_index, raw_video in enumerate(items):
        if not isinstance(raw_video, dict):
            fail(f"{label} video {video_index} is not an object")
        video_id = text(raw_video.get("videoId"))
        channel_id = text(raw_video.get("channelId"))
        if not VIDEO_ID.fullmatch(video_id) or not CHANNEL_ID.fullmatch(channel_id):
            fail(f"{label} video {video_index} has invalid videoId/channelId")
        if video_id in seen_videos:
            fail(f"{label} duplicate videoId: {video_id}")
        seen_videos.add(video_id)
        songs = raw_video.get("songs")
        if not isinstance(songs, list) or not songs:
            fail(f"{label} video {video_id} has zero songs")
        converted: list[dict[str, Any]] = []
        per_video: set[str] = set()
        for position, raw_song in enumerate(songs):
            input_occurrence_count += 1
            if input_occurrence_count > args.max_occurrences:
                fail(f"{label} occurrence cap exceeded")
            if not isinstance(raw_song, dict):
                fail(f"{label} video {video_id} occurrence {position} is not an object")
            song = canonical_song(raw_song, video_id, position)
            if song is None:
                skipped_titleless_count += 1
                continue
            identity = text(song["occurrenceId"])
            if identity in per_video:
                fail(f"{label} duplicate occurrence identity: {video_id}/{identity}")
            per_video.add(identity)
            identities[(video_id, identity)] = song
            converted.append(song)
        if not converted:
            skipped_empty_video_count += 1
            continue
        occurrence_count += len(converted)
        record = dict(raw_video)
        record.update(
            {
                "kind": "accepted-increment",
                "schemaVersion": 1,
                "rangeId": "7d",
                "range": "7d",
                "partialRangeReset": True,
                "videoId": video_id,
                "channelId": channel_id,
                "publishedAt": published_at(raw_video),
                "songs": converted,
                "sourceReachedEnd": True,
                "mediaDownloaded": False,
            }
        )
        records.append(record)
    return {
        "raw": raw,
        "generatedAt": generated_raw,
        "generated": generated,
        "records": records,
        "identities": identities,
        "inputVideoCount": len(items),
        "videoCount": len(records),
        "inputOccurrenceCount": input_occurrence_count,
        "occurrenceCount": occurrence_count,
        "skippedEmptyVideoCount": skipped_empty_video_count,
        "skippedTitlelessOccurrenceCount": skipped_titleless_count,
    }


def public_semantics(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return the exact public video/occurrence fields the PG adapter exposes."""

    video_fields = (
        "videoId", "title", "channelId", "channelName", "channelHandle",
        "channelUrl", "thumbnailUrl", "publishedAt", "publishedTimestamp",
        "videoThumbnailUrl", "avatarUrl", "sourceUrl", "sourceSystem", "rangeId",
    )
    song_fields = (
        "videoId", "occurrenceId", "position", "rangeId", "songKey", "seconds",
        "title", "artist", "sourceId", "sourceHash", "rawHash", "sourceSystem",
        "isNiche", "isUnknownArtist",
    )
    values: list[dict[str, Any]] = []
    for record in records:
        video = {
            key: record[key]
            for key in video_fields
            if key in record and record[key] is not None and record[key] != ""
        }
        for song in record["songs"]:
            public_song = {
                key: song[key]
                for key in song_fields
                if key in song and song[key] is not None
            }
            values.append(
                {
                    "videoId": public_song["videoId"],
                    "occurrenceId": public_song["occurrenceId"],
                    "video": video,
                    "song": public_song,
                }
            )
    values.sort(key=lambda value: (value["videoId"], value["occurrenceId"]))
    return values


def convert(args: argparse.Namespace) -> dict[str, Any]:
    previous = load_snapshot(args.base_input, "base", args)
    current = load_snapshot(args.input, "current", args)
    if git_blob_sha(current["raw"]) != args.source_blob:
        fail("current data/7d.json Git blob SHA does not match --source-blob")
    if git_blob_sha(previous["raw"]) != args.base_blob:
        fail("base data/7d.json Git blob SHA does not match --base-blob")
    if current["generated"] <= previous["generated"]:
        fail("current generatedAt must be newer than base generatedAt")
    current_records: list[dict[str, Any]] = []
    source_sha = sha256_bytes(current["raw"])
    for record in current["records"]:
        current_records.append(
            {
                **record,
                "sourceCommitSha": args.source_commit,
                "sourceBlobSha": args.source_blob,
                "sourceArtifactSha256": source_sha,
            }
        )
    # The active 7D projection is not guaranteed to equal the previous Git
    # snapshot (that missing handoff is the architecture defect this stream
    # repairs).  Do not manufacture tombstones from push-before.  The reviewed
    # manifest is a first-class, range-scoped replacement boundary consumed by
    # pg_adapter; the stream therefore carries only the authoritative new rows.
    rows = current_records
    output_bytes = b"".join(
        (
            json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            + "\n"
        ).encode("utf-8")
        for row in rows
    )
    if not rows or not output_bytes:
        fail("authoritative 7d patch is empty")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(output_bytes)
    patch_sha = sha256_bytes(output_bytes)
    semantics = public_semantics(current_records)
    semantics_sha = sha256_bytes(canonical_bytes(semantics))
    source_manifest = {
        "schemaVersion": 1,
        "path": "data/7d.json",
        "rangeId": "7d",
        "sourceCommitSha": args.source_commit,
        "sourceBlobSha": args.source_blob,
        "sourceArtifactSha256": source_sha,
        "generatedAt": current["generatedAt"],
        "inputVideoCount": current["inputVideoCount"],
        "acceptedVideoCount": current["videoCount"],
        "inputOccurrenceCount": current["inputOccurrenceCount"],
        "acceptedOccurrenceCount": current["occurrenceCount"],
        "skippedTitlelessOccurrenceCount": current[
            "skippedTitlelessOccurrenceCount"
        ],
        "sourceOccurrenceSemanticsSha256": semantics_sha,
    }
    source_manifest_sha = sha256_bytes(canonical_bytes(source_manifest))
    manifest = {
        "schemaVersion": 1,
        "kind": "accepted-increment",
        "handoffKind": "github-core-7d-authoritative-range",
        "status": "ready",
        "rangeId": "7d",
        "range": "7d",
        "generatedAt": current["generatedAt"],
        "baseGeneratedAt": previous["generatedAt"],
        "sourceReachedEnd": True,
        "mediaDownloaded": False,
        "statusAuditIncluded": True,
        "authoritativeRange": "7d",
        "partialVideoRows": True,
        "rangeReset": True,
        "rangeResetStrategy": "adapter-authoritative-range-boundary",
        "rangeResetAppliedBy": "pg-adapter-authoritative-range-boundary-v2",
        "rangeBoundaryMutationCount": 1,
        "rangeResetTombstoneCount": 0,
        "mutation_count": 1 + current["videoCount"] + current["occurrenceCount"],
        "acceptedVideoCount": current["videoCount"],
        "acceptedOccurrenceCount": current["occurrenceCount"],
        "skippedEmptyVideoCount": current["skippedEmptyVideoCount"],
        "skippedTitlelessOccurrenceCount": current[
            "skippedTitlelessOccurrenceCount"
        ],
        "baseVideoCount": previous["videoCount"],
        "baseOccurrenceCount": previous["occurrenceCount"],
        "baseSkippedEmptyVideoCount": previous["skippedEmptyVideoCount"],
        "baseSkippedTitlelessOccurrenceCount": previous[
            "skippedTitlelessOccurrenceCount"
        ],
        "sourceCommitSha": args.source_commit,
        "source_commit_sha": args.source_commit,
        "sourceBaseSha": args.source_base,
        "source_base_sha": args.source_base,
        "sourceBlobSha": args.source_blob,
        "source_blob_sha": args.source_blob,
        "sourceBaseBlobSha": args.base_blob,
        "source_base_blob_sha": args.base_blob,
        "sourceArtifactSha256": source_sha,
        "sourceBaseArtifactSha256": sha256_bytes(previous["raw"]),
        "sourceOccurrenceSemanticsSha256": semantics_sha,
        "sourceManifest": source_manifest,
        "sourceManifestSha256": source_manifest_sha,
        "patch_sha256": patch_sha,
        "inputFiles": ["data/7d.json"],
    }
    args.manifest_output.parent.mkdir(parents=True, exist_ok=True)
    args.manifest_output.write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--base-input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest-output", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--source-base", required=True)
    parser.add_argument("--source-blob", required=True)
    parser.add_argument("--base-blob", required=True)
    parser.add_argument("--max-bytes", type=int, default=MAX_BYTES)
    parser.add_argument("--max-videos", type=int, default=MAX_VIDEOS)
    parser.add_argument("--max-occurrences", type=int, default=MAX_OCCURRENCES)
    args = parser.parse_args()
    if not SHA1.fullmatch(args.source_commit) or not SHA1.fullmatch(args.source_base):
        fail("source commit/base must be immutable 40-hex SHAs")
    if not SHA1.fullmatch(args.source_blob) or not SHA1.fullmatch(args.base_blob):
        fail("source/base blob must be immutable 40-hex Git blob SHAs")
    manifest = convert(args)
    print(
        "7D_TITLELESS_OCCURRENCES_SKIPPED "
        f"current={manifest['skippedTitlelessOccurrenceCount']} "
        f"base={manifest['baseSkippedTitlelessOccurrenceCount']} "
        f"emptyVideosCurrent={manifest['skippedEmptyVideoCount']} "
        f"emptyVideosBase={manifest['baseSkippedEmptyVideoCount']}"
    )
    print(json.dumps({"status": "ok", **manifest}, ensure_ascii=False, sort_keys=True))
    print("7D_AUTHORITATIVE_PATCH_COMPLETE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
