#!/usr/bin/env python3
"""Build and verify deterministic source identity probes for accepted patches."""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any, TextIO


class IdentityEvidenceError(ValueError):
    """Raised when an accepted patch cannot produce fail-closed evidence."""


def _nonempty_text(value: Any, field: str, *, line_number: int) -> str:
    if not isinstance(value, str) or not value:
        raise IdentityEvidenceError(
            f"line {line_number}: {field} must be a non-empty string"
        )
    return value


def _optional_text(value: Any, field: str, *, line_number: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise IdentityEvidenceError(f"line {line_number}: {field} must be a string")
    return value


def _patch_stream(path: Path) -> TextIO:
    with path.open("rb") as stream:
        is_gzip = stream.read(2) == b"\x1f\x8b"
    if is_gzip:
        return gzip.open(path, "rt", encoding="utf-8")
    return path.open("r", encoding="utf-8")


def _record_probes(record: Any, *, line_number: int) -> list[dict[str, Any]]:
    if not isinstance(record, dict):
        raise IdentityEvidenceError(f"line {line_number}: record must be an object")
    video_id = _nonempty_text(
        record.get("videoId"), "videoId", line_number=line_number
    )
    channel_id = _optional_text(
        record.get("channelId"), "channelId", line_number=line_number
    )
    channel_handle = _optional_text(
        record.get("channelHandle"), "channelHandle", line_number=line_number
    )
    source_detail_key = channel_id or channel_handle
    if not source_detail_key:
        raise IdentityEvidenceError(
            f"line {line_number}: channelId or channelHandle is required"
        )

    songs = record.get("songs")
    if not isinstance(songs, list) or not songs:
        raise IdentityEvidenceError(f"line {line_number}: songs must be non-empty")
    probes: list[dict[str, Any]] = []
    for song_index, song in enumerate(songs):
        if not isinstance(song, dict):
            raise IdentityEvidenceError(
                f"line {line_number}: songs[{song_index}] must be an object"
            )
        occurrence_id = _nonempty_text(
            song.get("occurrenceId"),
            f"songs[{song_index}].occurrenceId",
            line_number=line_number,
        )
        title = song.get("title")
        if not isinstance(title, str):
            raise IdentityEvidenceError(
                f"line {line_number}: songs[{song_index}].title must be a string"
            )
        artist = song.get("artist")
        if artist is not None and not isinstance(artist, str):
            raise IdentityEvidenceError(
                f"line {line_number}: songs[{song_index}].artist must be a string or null"
            )
        seconds = song.get("seconds")
        if seconds is not None and (
            isinstance(seconds, bool) or not isinstance(seconds, (int, float))
        ):
            raise IdentityEvidenceError(
                f"line {line_number}: songs[{song_index}].seconds must be a number or null"
            )
        probes.append(
            {
                "sourceDetailKey": source_detail_key,
                "channelId": channel_id,
                "channelHandle": channel_handle,
                "videoId": video_id,
                "occurrenceId": occurrence_id,
                "title": title,
                "artist": artist,
                "seconds": seconds,
            }
        )
    return probes


def _api_tuple(probe: dict[str, Any]) -> tuple[str, str, str, str, str]:
    return (
        probe["sourceDetailKey"],
        probe["videoId"],
        probe["title"],
        json.dumps(probe["artist"], ensure_ascii=False, sort_keys=True),
        json.dumps(probe["seconds"], ensure_ascii=False, sort_keys=True),
    )


def _overlay_norm(value: Any) -> str:
    text = "" if value is None else str(value)
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def build_identity_evidence(path: Path) -> dict[str, Any]:
    probes: list[dict[str, Any]] = []
    with _patch_stream(path) as stream:
        for line_number, raw_line in enumerate(stream, start=1):
            if not raw_line.strip():
                continue
            try:
                record = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                raise IdentityEvidenceError(
                    f"line {line_number}: invalid JSON: {exc.msg}"
                ) from exc
            probes.extend(_record_probes(record, line_number=line_number))
    if not probes:
        raise IdentityEvidenceError("patch contains no accepted records")

    tuple_counts = Counter(_api_tuple(probe) for probe in probes)
    unique_probes = [
        probe for probe in probes if tuple_counts[_api_tuple(probe)] == 1
    ]
    unique_probes.sort(
        key=lambda probe: (
            probe["sourceDetailKey"],
            probe["videoId"],
            probe["occurrenceId"],
            probe["title"],
            json.dumps(probe["artist"], ensure_ascii=False, sort_keys=True),
            json.dumps(probe["seconds"], ensure_ascii=False, sort_keys=True),
        )
    )
    by_source: dict[str, dict[str, Any]] = {}
    for probe in unique_probes:
        by_source.setdefault(probe["sourceDetailKey"], probe)
    source_keys = sorted({probe["sourceDetailKey"] for probe in probes})
    missing = [key for key in source_keys if key not in by_source]
    if missing:
        raise IdentityEvidenceError(
            "no API-visible unique tuple for sources: " + ",".join(missing)
        )
    source_occurrence_counts = Counter(
        probe["sourceDetailKey"] for probe in probes
    )
    source_video_ids: dict[str, set[str]] = {
        key: set() for key in source_keys
    }
    source_song_groups: dict[str, set[tuple[str, str]]] = {
        key: set() for key in source_keys
    }
    for probe in probes:
        source_key = probe["sourceDetailKey"]
        source_video_ids[source_key].add(probe["videoId"])
        source_song_groups[source_key].add(
            (_overlay_norm(probe["title"]), _overlay_norm(probe["artist"]))
        )
    evidence = [
        {
            **by_source[key],
            "acceptedVideoCount": len(source_video_ids[key]),
            "acceptedOccurrenceCount": source_occurrence_counts[key],
            "acceptedSongGroupCount": len(source_song_groups[key]),
        }
        for key in source_keys
    ]
    return {
        "sourceIdentityCount": len(evidence),
        "sourceIdentityEvidence": evidence,
        "identityEvidence": evidence[0],
    }


def verify_manifest(manifest_path: Path, expected: dict[str, Any]) -> None:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise IdentityEvidenceError(f"manifest is unreadable: {exc}") from exc
    if not isinstance(manifest, dict):
        raise IdentityEvidenceError("manifest must be an object")
    if manifest.get("handoffKind") != "github-accepted-paths":
        raise IdentityEvidenceError(
            "manifest handoffKind must be github-accepted-paths"
        )
    for field in (
        "sourceIdentityCount",
        "sourceIdentityEvidence",
        "identityEvidence",
    ):
        if manifest.get(field) != expected[field]:
            raise IdentityEvidenceError(
                f"manifest {field} does not match deterministic patch evidence"
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--patch", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--verify-manifest", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        evidence = build_identity_evidence(args.patch)
        if args.verify_manifest:
            verify_manifest(args.verify_manifest, evidence)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(
                evidence,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
    except (IdentityEvidenceError, OSError) as exc:
        print(f"accepted-source-identities: {exc}", file=sys.stderr)
        return 78
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
