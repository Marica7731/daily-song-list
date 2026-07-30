#!/usr/bin/env python3
"""Produce and verify complete legacy VTuber identity reset contracts.

The exporter is deliberately strict:

* the active revision is compared with an explicit CAS value;
* the nearest immutable full-runtime parent is selected through the revision
  lineage;
* a legacy ranking group is joined to its source-detail rows by the exact
  ``runtime_source_details.entity_key`` and ``source_key`` relationship;
* every parent video and occurrence is streamed through a named server-side
  cursor and committed to canonical SHA-256 digests;
* final accepted rows are emitted only when a human-reviewed ledger covers
  the parent video set exactly.

This module never activates a revision.  ``verify-db`` is intended to run
immediately before candidate import and repeats the active/parent/set CAS.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from typing import Any, Iterable, Iterator, Mapping, Sequence


SCHEMA_VERSION = 1
CONTRACT_KIND = "legacy-vtuber-full-identity-reset"
SOURCE_KIND = "legacy-vtuber-identity-reset-parent"
ACCEPTED_KIND = "youtube-channel-discovery-increment"
FETCH_SIZE = 256
TASK_CAP_BYTES = 2 * 1024 * 1024 * 1024
MAX_GROUPS = 16
MAX_VIDEOS = 4096
MAX_OCCURRENCES = 50_000
EXPECTED_GROUPS = 4
EXPECTED_VIDEO_TOTAL = 415
EXPECTED_OCCURRENCE_TOTAL = 5_613
CHANNEL_ID_RE = re.compile(r"^UC[A-Za-z0-9_-]{22}$")
HANDLE_RE = re.compile(r"^@[A-Za-z0-9._-]{3,30}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
ALLOWED_REVIEW_STATUSES = {
    "channel-page-reviewed",
    "unavailable-reviewed-reconciliation",
}


class ContractError(RuntimeError):
    """Fail-closed contract violation."""


def text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def has_legacy_identity_reset_marker(value: Any) -> bool:
    """Recognize accepted rows that require the complete reset manifest."""

    if not isinstance(value, Mapping):
        return False
    return (
        text(value.get("reason")) == CONTRACT_KIND
        or text(value.get("curationReason")) == CONTRACT_KIND
        or "identityResetEvidence" in value
        or "identityReset" in value
    )


def validate_identity_reset_manifest_presence(
    accepted_payload: Mapping[str, Any],
) -> list[Any]:
    """Reject legacy-marked rows when their top-level reset contract is absent."""

    videos = accepted_payload.get("videos")
    if not isinstance(videos, list):
        raise ContractError("accepted payload videos are missing")
    resets = accepted_payload.get("identityResets")
    if any(has_legacy_identity_reset_marker(video) for video in videos):
        if not isinstance(resets, list) or not resets:
            raise ContractError(
                "legacy-marked accepted videos require non-empty identityResets",
            )
    if resets is None:
        return []
    if not isinstance(resets, list):
        raise ContractError("identityResets must be an array")
    return resets


def json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str) and value.strip():
        parsed = json.loads(value)
        return dict(parsed) if isinstance(parsed, Mapping) else {}
    return {}


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_handle(value: Any) -> str:
    handle = text(value)
    if handle.startswith("/"):
        handle = handle[1:]
    if not handle.startswith("@"):
        handle = f"@{handle}" if handle else ""
    if not HANDLE_RE.fullmatch(handle):
        raise ContractError(f"invalid target channel handle: {value!r}")
    return f"@{handle[1:].casefold()}"


def canonical_channel_url(channel_id: str, handle: str) -> str:
    if not CHANNEL_ID_RE.fullmatch(channel_id):
        raise ContractError(f"invalid target channel ID: {channel_id!r}")
    handle = canonical_handle(handle)
    return f"https://www.youtube.com/{handle}"


def validate_target(raw: Mapping[str, Any]) -> dict[str, Any]:
    detail_key = text(raw.get("legacyDetailKey"))
    channel_id = text(raw.get("targetChannelId"))
    handle = canonical_handle(raw.get("targetChannelHandle"))
    if not detail_key:
        raise ContractError("target requires exact legacyDetailKey")
    if not CHANNEL_ID_RE.fullmatch(channel_id):
        raise ContractError(f"target {detail_key} has invalid channel ID")
    result = {
        "legacyDetailKey": detail_key,
        "targetChannelId": channel_id,
        "targetChannelHandle": handle,
        "targetChannelUrl": canonical_channel_url(channel_id, handle),
    }
    expected_count = raw.get("expectedParentVideoCount")
    if expected_count is not None:
        result["expectedParentVideoCount"] = positive_int(
            expected_count, "expectedParentVideoCount",
        )
    expected_occurrence_count = raw.get("expectedParentOccurrenceCount")
    if expected_occurrence_count is not None:
        result["expectedParentOccurrenceCount"] = positive_int(
            expected_occurrence_count, "expectedParentOccurrenceCount",
        )
    return result


def positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise ContractError(f"{field} must be a positive integer")
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ContractError(f"{field} must be a positive integer") from exc
    if number <= 0:
        raise ContractError(f"{field} must be a positive integer")
    return number


def load_targets(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    values = payload.get("targets") if isinstance(payload, Mapping) else None
    if not isinstance(values, list) or not values or len(values) > MAX_GROUPS:
        raise ContractError("target config requires a bounded non-empty targets list")
    targets = [validate_target(item) for item in values if isinstance(item, Mapping)]
    if len(targets) != len(values):
        raise ContractError("target config contains a non-object target")
    keys = [item["legacyDetailKey"] for item in targets]
    ids = [item["targetChannelId"] for item in targets]
    if len(keys) != len(set(keys)) or len(ids) != len(set(ids)):
        raise ContractError("target config repeats a legacy key or target channel")
    if (
        len(targets) != EXPECTED_GROUPS
        or any("expectedParentVideoCount" not in item for item in targets)
        or any("expectedParentOccurrenceCount" not in item for item in targets)
        or sum(item["expectedParentVideoCount"] for item in targets)
        != EXPECTED_VIDEO_TOTAL
        or sum(item["expectedParentOccurrenceCount"] for item in targets)
        != EXPECTED_OCCURRENCE_TOTAL
    ):
        raise ContractError(
            "target config must bind exactly 4 groups / 415 videos / "
            "5613 occurrences",
        )
    return targets


def row_mapping(row: Any, description: Sequence[Any] | None = None) -> dict[str, Any]:
    if isinstance(row, Mapping):
        return dict(row)
    if description:
        names = [text(getattr(item, "name", item[0] if item else "")) for item in description]
        return dict(zip(names, row, strict=False))
    raise ContractError("database row is not mapping-shaped")


def one(cur: Any, sql: str, params: Sequence[Any]) -> dict[str, Any] | None:
    cur.execute(sql, params)
    rows = cur.fetchmany(2)
    if len(rows) > 1:
        raise ContractError("database lookup returned a non-unique row")
    return row_mapping(rows[0], cur.description) if rows else None


def active_revision(cur: Any) -> str:
    row = one(
        cur,
        "SELECT state_value FROM migration_state WHERE state_key='active_revision_id'",
        (),
    )
    return text(row.get("state_value")) if row else ""


def runtime_parent(cur: Any, active: str) -> str:
    current = active
    seen: set[str] = set()
    while current:
        if current in seen:
            raise ContractError("revision lineage contains a cycle")
        seen.add(current)
        row = one(
            cur,
            """
            SELECT revision_id, parent_revision_id, manifest_json
            FROM migration_revisions WHERE revision_id=%s
            """,
            (current,),
        )
        if not row:
            raise ContractError(f"revision lineage row is missing: {current}")
        manifest = json_object(row.get("manifest_json"))
        if (
            manifest.get("runtimeProjection") is True
            and manifest.get("incrementalOverlay") is not True
        ):
            return current
        current = text(row.get("parent_revision_id"))
    raise ContractError("active lineage has no immutable full-runtime parent")


def occurrence_public_payload(value: Any) -> dict[str, Any]:
    payload = json_object(value)
    item = payload.get("item")
    if isinstance(item, Mapping):
        merged = dict(item)
        song = payload.get("song")
        if isinstance(song, Mapping):
            merged.update(song)
        merged.update({
            key: payload[key]
            for key in (
                "occurrenceId", "position", "rangeId", "songKey", "seconds",
                "title", "artist", "sourceId", "sourceHash", "rawHash",
                "sourceSystem", "isNiche", "isUnknownArtist",
            )
            if key in payload
        })
        return merged
    if isinstance(payload.get("song"), Mapping):
        merged = dict(payload["song"])
        merged.update({
            key: payload[key]
            for key in payload
            if key not in {"song", "item", "video"}
        })
        return merged
    return payload


def canonical_occurrence(
    row: Mapping[str, Any],
    source_key: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    position = int(row.get("position"))
    video_id = text(row.get("video_id"))
    if not VIDEO_ID_RE.fullmatch(video_id):
        raise ContractError(f"invalid parent video ID at source position {position}")
    public = occurrence_public_payload(row.get("occurrence_payload_json"))
    occurrence_id = text(
        public.get("occurrenceId") or public.get("occurrence_id")
    ) or f"source:{source_key}:{position}"
    seconds = public.get("seconds")
    if seconds is None:
        seconds = row.get("seconds")
    song = {
        **public,
        "videoId": video_id,
        "occurrenceId": occurrence_id,
        "sourcePosition": position,
        "position": int(public.get("position", position)),
        "rangeId": text(public.get("rangeId") or "all"),
        "seconds": seconds,
        "title": text(public.get("title") or row.get("source_title")),
        "artist": text(public.get("artist")),
    }
    identity = {
        "sourcePosition": position,
        "videoId": video_id,
        "occurrenceId": occurrence_id,
        "seconds": seconds,
        "title": song["title"],
        "artist": song["artist"],
    }
    return song, identity


def named_rows(
    connection: Any,
    name: str,
    sql: str,
    params: Sequence[Any],
    fetch_size: int = FETCH_SIZE,
) -> Iterator[dict[str, Any]]:
    try:
        cursor = connection.cursor(name=name)
    except TypeError:
        cursor = connection.cursor()
    with cursor:
        if hasattr(cursor, "itersize"):
            cursor.itersize = fetch_size
        cursor.execute(sql, params)
        while True:
            batch = cursor.fetchmany(fetch_size)
            if not batch:
                break
            for row in batch:
                yield row_mapping(row, cursor.description)


def snapshot_group(
    connection: Any,
    parent_runtime_revision_id: str,
    target: Mapping[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    detail_key = text(target.get("legacyDetailKey"))
    with connection.cursor() as cur:
        ranking = one(
            cur,
            """
            SELECT detail_key, name, row_count, video_count, payload_json
            FROM runtime_ranking_rows
            WHERE revision_id=%s AND range_id='all' AND view='vtubers'
              AND metric='videos' AND detail_key=%s
            """,
            (parent_runtime_revision_id, detail_key),
        )
        if not ranking or text(ranking.get("detail_key")) != detail_key:
            raise ContractError(f"legacy ranking row is missing: {detail_key}")
        source_rows = []
        cur.execute(
            """
            SELECT source_key, entity_key, payload_json
            FROM runtime_source_details
            WHERE revision_id=%s AND range_id='all' AND entity_type='vtuber'
              AND entity_key=%s
            ORDER BY source_key
            """,
            (parent_runtime_revision_id, detail_key),
        )
        for row in cur.fetchmany(3):
            source_rows.append(row_mapping(row, cur.description))
        if len(source_rows) != 1:
            raise ContractError(
                f"legacy detail key does not bind one exact source: {detail_key}",
            )
        source_key = text(source_rows[0].get("source_key"))
        if not source_key:
            raise ContractError(f"legacy source key is empty: {detail_key}")

    videos: dict[str, dict[str, Any]] = {}
    occurrence_identities: list[dict[str, Any]] = []
    seen_source_positions: set[int] = set()
    sql = """
        SELECT s.position, s.video_id, s.title AS source_title, s.seconds,
               s.payload_json AS occurrence_payload_json,
               v.title AS video_title, v.channel_name, v.channel_id,
               v.channel_handle, v.channel_url, v.published_timestamp,
               v.thumbnail_url, v.payload_json AS video_payload_json
        FROM runtime_source_occurrences AS s
        JOIN runtime_videos AS v
          ON v.revision_id=s.revision_id AND v.video_id=s.video_id
        WHERE s.revision_id=%s AND s.source_key=%s AND s.range_id='all'
        ORDER BY s.position
    """
    cursor_name = f"legacy_reset_{hashlib.sha256(detail_key.encode()).hexdigest()[:12]}"
    for row in named_rows(
        connection,
        cursor_name,
        sql,
        (parent_runtime_revision_id, source_key),
    ):
        position = int(row.get("position"))
        if position in seen_source_positions:
            raise ContractError(f"duplicate source position for {detail_key}")
        seen_source_positions.add(position)
        song, occurrence_identity = canonical_occurrence(row, source_key)
        occurrence_identities.append(occurrence_identity)
        if len(occurrence_identities) > MAX_OCCURRENCES:
            raise ContractError("legacy reset occurrence cap exceeded")
        video_id = song["videoId"]
        video = videos.get(video_id)
        if video is None:
            video_payload = json_object(row.get("video_payload_json"))
            video = {
                **video_payload,
                "videoId": video_id,
                "title": text(row.get("video_title") or video_payload.get("title")),
                "channelName": text(
                    row.get("channel_name") or video_payload.get("channelName")
                ),
                "channelId": text(
                    row.get("channel_id") or video_payload.get("channelId")
                ),
                "channelHandle": text(
                    row.get("channel_handle") or video_payload.get("channelHandle")
                ),
                "channelUrl": text(
                    row.get("channel_url") or video_payload.get("channelUrl")
                ),
                "publishedTimestamp": row.get("published_timestamp"),
                "thumbnailUrl": text(
                    row.get("thumbnail_url") or video_payload.get("thumbnailUrl")
                ),
                "songs": [],
            }
            videos[video_id] = video
        video["songs"].append(song)
        if len(videos) > MAX_VIDEOS:
            raise ContractError("legacy reset video cap exceeded")

    parent_video_ids = sorted(videos)
    occurrence_identities.sort(
        key=lambda item: (
            int(item["sourcePosition"]),
            item["videoId"],
            item["occurrenceId"],
        ),
    )
    video_count = positive_int(ranking.get("video_count"), "parent video_count")
    occurrence_count = positive_int(ranking.get("row_count"), "parent row_count")
    if len(parent_video_ids) != video_count:
        raise ContractError(
            f"parent video set/count mismatch key={detail_key} "
            f"set={len(parent_video_ids)} ranking={video_count}",
        )
    if len(occurrence_identities) != occurrence_count:
        raise ContractError(
            f"parent occurrence set/count mismatch key={detail_key} "
            f"set={len(occurrence_identities)} ranking={occurrence_count}",
        )
    expected_count = target.get("expectedParentVideoCount")
    if expected_count is not None and int(expected_count) != video_count:
        raise ContractError(
            f"reviewed expected video count drift key={detail_key}",
        )
    expected_occurrence_count = target.get("expectedParentOccurrenceCount")
    if (
        expected_occurrence_count is not None
        and int(expected_occurrence_count) != occurrence_count
    ):
        raise ContractError(
            f"reviewed expected occurrence count drift key={detail_key}",
        )
    group = {
        "schemaVersion": SCHEMA_VERSION,
        "kind": CONTRACT_KIND,
        "rangeId": "all",
        "parentRuntimeRevisionId": parent_runtime_revision_id,
        "legacyDetailKey": detail_key,
        "legacyDisplayName": text(ranking.get("name")),
        "sourceKey": source_key,
        "parentVideoCount": video_count,
        "parentOccurrenceCount": occurrence_count,
        "parentVideoIds": parent_video_ids,
        "parentVideoIdsSha256": canonical_sha256(parent_video_ids),
        "parentOccurrenceIdentitiesSha256": canonical_sha256(
            occurrence_identities,
        ),
        "targetChannelId": target["targetChannelId"],
        "targetChannelHandle": target["targetChannelHandle"],
        "targetChannelUrl": target["targetChannelUrl"],
        "sourceReachedEnd": False,
        "complete": False,
        "unresolvedParentVideoIds": list(parent_video_ids),
        "identityEvidenceSha256": "",
    }
    return group, [videos[video_id] for video_id in parent_video_ids]


def task_bytes(path: Path) -> int:
    total = 0
    for item in path.rglob("*"):
        if item.is_file() and not item.is_symlink():
            total += item.stat().st_size
    return total


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".next")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def write_ndjson(path: Path, rows: Iterable[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".next")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
            stream.write("\n")
    temporary.replace(path)


@contextmanager
def read_snapshot(connection: Any) -> Iterator[Any]:
    with connection.transaction():
        with connection.cursor() as cur:
            cur.execute(
                "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
            )
        yield connection


def export_parent(
    connection: Any,
    expected_active: str,
    targets: Sequence[Mapping[str, Any]],
    output_root: Path,
) -> dict[str, Any]:
    if not expected_active:
        raise ContractError("--expected-active is required")
    output_root.mkdir(parents=True, exist_ok=True)
    if output_root.is_symlink():
        raise ContractError("output root must not be a symlink")
    checkpoint_path = output_root / "checkpoint.json"
    groups: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
    before_bytes = task_bytes(output_root)
    peak_bytes = before_bytes
    with read_snapshot(connection):
        with connection.cursor() as cur:
            actual_active = active_revision(cur)
            if actual_active != expected_active:
                raise ContractError(
                    f"active revision CAS mismatch expected={expected_active} "
                    f"actual={actual_active}",
                )
            parent_runtime = runtime_parent(cur, actual_active)
        for target in targets:
            group, videos = snapshot_group(connection, parent_runtime, target)
            group["parentRevisionId"] = actual_active
            slug = hashlib.sha256(
                group["legacyDetailKey"].encode("utf-8"),
            ).hexdigest()[:16]
            video_path = output_root / f"parent-videos-{slug}.ndjson"
            write_ndjson(video_path, videos)
            group["parentVideosPath"] = video_path.name
            group["parentVideosSha256"] = file_sha256(video_path)
            groups.append(group)
            files.append({
                "path": video_path.name,
                "bytes": video_path.stat().st_size,
                "sha256": group["parentVideosSha256"],
            })
            current_bytes = task_bytes(output_root)
            peak_bytes = max(peak_bytes, current_bytes)
            if peak_bytes > TASK_CAP_BYTES:
                raise ContractError("producer task root exceeded 2 GiB cap")
            atomic_json(checkpoint_path, {
                "schemaVersion": SCHEMA_VERSION,
                "kind": f"{SOURCE_KIND}-checkpoint",
                "complete": False,
                "expectedActiveRevisionId": expected_active,
                "parentRuntimeRevisionId": parent_runtime,
                "completedLegacyDetailKeys": [
                    item["legacyDetailKey"] for item in groups
                ],
                "beforeBytes": before_bytes,
                "peakBytes": peak_bytes,
                "afterBytes": current_bytes,
            })
    if (
        len(groups) != EXPECTED_GROUPS
        or sum(int(group["parentVideoCount"]) for group in groups)
        != EXPECTED_VIDEO_TOTAL
        or sum(int(group["parentOccurrenceCount"]) for group in groups)
        != EXPECTED_OCCURRENCE_TOTAL
    ):
        raise ContractError(
            "parent snapshot must equal 4 groups / 415 videos / "
            "5613 occurrences",
        )
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "kind": SOURCE_KIND,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "expectedActiveRevisionId": expected_active,
        "parentRuntimeRevisionId": groups[0]["parentRuntimeRevisionId"],
        "sourceReachedEnd": False,
        "complete": False,
        "groups": groups,
        "files": files,
        "expectedTotals": {
            "groups": EXPECTED_GROUPS,
            "videos": EXPECTED_VIDEO_TOTAL,
            "occurrences": EXPECTED_OCCURRENCE_TOTAL,
        },
        "resourceUsage": {
            "taskCapBytes": TASK_CAP_BYTES,
            "beforeBytes": before_bytes,
            "peakBytes": peak_bytes,
            "afterBytes": task_bytes(output_root),
            "cleanupExpectedAfterBytes": 0,
        },
    }
    atomic_json(output_root / "parent-manifest.json", manifest)
    atomic_json(checkpoint_path, {
        **json.loads(checkpoint_path.read_text(encoding="utf-8")),
        "complete": True,
        "manifestSha256": file_sha256(output_root / "parent-manifest.json"),
    })
    return manifest


def ledger_groups(payload: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    values = payload.get("groups")
    if not isinstance(values, list):
        raise ContractError("review ledger requires groups")
    result: dict[str, Mapping[str, Any]] = {}
    for raw in values:
        if not isinstance(raw, Mapping):
            raise ContractError("review ledger group must be an object")
        key = text(raw.get("legacyDetailKey"))
        if not key or key in result:
            raise ContractError("review ledger repeats or omits legacyDetailKey")
        result[key] = raw
    return result


def validate_review_evidence(
    entry: Mapping[str, Any],
    group: Mapping[str, Any],
) -> dict[str, Any]:
    video_id = text(entry.get("videoId"))
    status = text(entry.get("status"))
    evidence = entry.get("evidence")
    if status not in ALLOWED_REVIEW_STATUSES or not isinstance(evidence, Mapping):
        raise ContractError(f"video {video_id} lacks reviewed identity evidence")
    reviewed_by = text(entry.get("reviewedBy"))
    reviewed_at = text(entry.get("reviewedAt"))
    evidence_sha = text(entry.get("evidenceSha256"))
    if (
        not VIDEO_ID_RE.fullmatch(video_id)
        or not reviewed_by
        or not reviewed_at
        or not SHA256_RE.fullmatch(evidence_sha)
    ):
        raise ContractError(f"video {video_id} review audit is incomplete")
    try:
        parsed_reviewed_at = datetime.fromisoformat(
            reviewed_at.replace("Z", "+00:00"),
        )
    except ValueError as exc:
        raise ContractError(
            f"video {video_id} reviewedAt is invalid",
        ) from exc
    if parsed_reviewed_at.tzinfo is None:
        raise ContractError(f"video {video_id} reviewedAt requires a timezone")
    reviewed_at = parsed_reviewed_at.astimezone(timezone.utc).isoformat()
    if text(evidence.get("videoId")) != video_id:
        raise ContractError(f"video {video_id} evidence video ID mismatch")
    if text(evidence.get("status")) != status:
        raise ContractError(f"video {video_id} evidence status mismatch")
    source_url = text(evidence.get("sourceUrl"))
    if not source_url.startswith("https://"):
        raise ContractError(f"video {video_id} evidence source URL is invalid")
    if text(evidence.get("channelId")) != group["targetChannelId"]:
        raise ContractError(f"video {video_id} evidence channel ID mismatch")
    if canonical_handle(evidence.get("channelHandle")) != group["targetChannelHandle"]:
        raise ContractError(f"video {video_id} evidence handle mismatch")
    if status == "channel-page-reviewed":
        if not SHA256_RE.fullmatch(text(evidence.get("rawSha256"))):
            raise ContractError(f"video {video_id} raw page hash is missing")
    else:
        if (
            entry.get("preserveParentOccurrences") is not True
            or not text(entry.get("reason"))
            or not SHA256_RE.fullmatch(text(evidence.get("reconciliationSha256")))
        ):
            raise ContractError(
                f"unavailable video {video_id} reconciliation is incomplete",
            )
    calculated = canonical_sha256(evidence)
    if calculated != evidence_sha:
        raise ContractError(f"video {video_id} evidence hash mismatch")
    return {
        "videoId": video_id,
        "status": status,
        "reviewedBy": reviewed_by,
        "reviewedAt": reviewed_at,
        "reason": text(entry.get("reason")),
        "preserveParentOccurrences": (
            entry.get("preserveParentOccurrences") is True
        ),
        "evidence": dict(evidence),
        "evidenceSha256": evidence_sha,
    }


def canonical_accepted_occurrence(
    video: Mapping[str, Any],
    item: Mapping[str, Any],
) -> dict[str, Any]:
    video_id = text(video.get("videoId") or video.get("video_id"))
    if not VIDEO_ID_RE.fullmatch(video_id):
        raise ContractError("identity reset accepted occurrence has invalid video ID")
    source_position = item.get("sourcePosition")
    if isinstance(source_position, bool):
        raise ContractError(
            f"identity reset occurrence misses sourcePosition video={video_id}",
        )
    try:
        source_position = int(source_position)
    except (TypeError, ValueError) as exc:
        raise ContractError(
            f"identity reset occurrence misses sourcePosition video={video_id}",
        ) from exc
    if source_position < 0:
        raise ContractError(
            f"identity reset occurrence has invalid sourcePosition video={video_id}",
        )
    occurrence_id = text(
        item.get("occurrenceId") or item.get("occurrence_id")
    )
    if not occurrence_id:
        raise ContractError(
            f"identity reset occurrence misses occurrenceId video={video_id}",
        )
    return {
        "sourcePosition": source_position,
        "videoId": video_id,
        "occurrenceId": occurrence_id,
        "seconds": item.get("seconds"),
        "title": text(item.get("title")),
        "artist": text(item.get("artist")),
    }


def validate_accepted_identity_resets(
    resets: Sequence[Mapping[str, Any]],
    videos: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Bind accepted songs and evidence to every complete parent reset."""

    if not resets:
        raise ContractError("identity reset accepted contract is empty")
    video_by_id: dict[str, Mapping[str, Any]] = {}
    for video in videos:
        if not isinstance(video, Mapping):
            raise ContractError("identity reset accepted video is not an object")
        video_id = text(video.get("videoId") or video.get("video_id"))
        if not VIDEO_ID_RE.fullmatch(video_id) or video_id in video_by_id:
            raise ContractError(
                "identity reset accepted video ID is invalid or duplicate",
            )
        video_by_id[video_id] = video

    selected_video_ids: set[str] = set()
    total_occurrences = 0
    for reset in resets:
        if not isinstance(reset, Mapping):
            raise ContractError("identity reset manifest is not an object")
        target = validate_target(reset)
        parent_ids = reset.get("parentVideoIds")
        if (
            not isinstance(parent_ids, list)
            or not parent_ids
            or parent_ids != sorted(parent_ids)
            or len(parent_ids) != len(set(parent_ids))
            or len(parent_ids) != int(reset.get("parentVideoCount") or 0)
            or canonical_sha256(parent_ids)
            != text(reset.get("parentVideoIdsSha256"))
        ):
            raise ContractError("identity reset accepted parent video set mismatch")

        evidence_manifest: list[dict[str, Any]] = []
        occurrence_identities: list[dict[str, Any]] = []
        seen_source_positions: set[int] = set()
        for video_id in parent_ids:
            if video_id in selected_video_ids:
                raise ContractError(
                    "identity reset accepted video belongs to multiple groups",
                )
            selected_video_ids.add(video_id)
            video = video_by_id.get(video_id)
            if not isinstance(video, Mapping):
                raise ContractError(
                    f"identity reset accepted video is missing: {video_id}",
                )
            if (
                text(video.get("channelId") or video.get("channel_id"))
                != target["targetChannelId"]
                or canonical_handle(
                    video.get("channelHandle") or video.get("channel_handle")
                )
                != target["targetChannelHandle"]
                or text(video.get("channelUrl") or video.get("channel_url"))
                != target["targetChannelUrl"]
                or text(video.get("reason"))
                != "legacy-vtuber-full-identity-reset"
            ):
                raise ContractError(
                    f"identity reset accepted channel/reason mismatch: {video_id}",
                )
            evidence = video.get("identityResetEvidence")
            if not isinstance(evidence, Mapping):
                raise ContractError(
                    f"identity reset accepted evidence is missing: {video_id}",
                )
            if text(evidence.get("videoId")) != video_id:
                raise ContractError(
                    f"identity reset accepted evidence video ID mismatch: "
                    f"{video_id}",
                )
            evidence_manifest.append(validate_review_evidence(evidence, reset))
            songs = video.get("songs")
            if not isinstance(songs, list) or not songs:
                raise ContractError(
                    f"identity reset accepted songs are missing: {video_id}",
                )
            for item in songs:
                if not isinstance(item, Mapping):
                    raise ContractError(
                        f"identity reset accepted song is invalid: {video_id}",
                    )
                identity = canonical_accepted_occurrence(video, item)
                source_position = int(identity["sourcePosition"])
                if source_position in seen_source_positions:
                    raise ContractError(
                        "identity reset accepted occurrence sourcePosition "
                        "is duplicate",
                    )
                seen_source_positions.add(source_position)
                occurrence_identities.append(identity)

        occurrence_identities.sort(
            key=lambda item: (
                int(item["sourcePosition"]),
                item["videoId"],
                item["occurrenceId"],
            ),
        )
        if (
            len(occurrence_identities)
            != int(reset.get("parentOccurrenceCount") or 0)
            or canonical_sha256(occurrence_identities)
            != text(reset.get("parentOccurrenceIdentitiesSha256"))
        ):
            raise ContractError(
                "identity reset accepted occurrence count or digest mismatch",
            )
        if (
            canonical_sha256(evidence_manifest)
            != text(reset.get("identityEvidenceSha256"))
        ):
            raise ContractError(
                "identity reset accepted evidence ledger digest mismatch",
            )
        total_occurrences += len(occurrence_identities)

    if selected_video_ids != set(video_by_id):
        raise ContractError(
            "identity reset accepted videos are partial or contain extras",
        )
    return {
        "videoCount": len(video_by_id),
        "occurrenceCount": total_occurrences,
        "identityResetCount": len(resets),
    }


def read_ndjson(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, Mapping):
                raise ContractError(f"{path}:{line_number} is not an object")
            rows.append(dict(value))
    return rows


def finalize_accepted(
    parent_manifest_path: Path,
    review_ledger_path: Path,
    output_path: Path,
) -> dict[str, Any]:
    parent_root = parent_manifest_path.parent
    parent = json.loads(parent_manifest_path.read_text(encoding="utf-8"))
    ledger = json.loads(review_ledger_path.read_text(encoding="utf-8"))
    if (
        parent.get("kind") != SOURCE_KIND
        or parent.get("complete") is not False
        or parent.get("sourceReachedEnd") is not False
    ):
        raise ContractError("parent snapshot has invalid pre-review state")
    by_key = ledger_groups(ledger)
    accepted_videos: list[dict[str, Any]] = []
    resets: list[dict[str, Any]] = []
    global_video_ids: set[str] = set()
    for group in parent.get("groups") or []:
        key = text(group.get("legacyDetailKey"))
        review = by_key.get(key)
        if not review:
            raise ContractError(f"review ledger misses group: {key}")
        parent_video_path = parent_root / text(group.get("parentVideosPath"))
        if (
            not parent_video_path.is_file()
            or file_sha256(parent_video_path) != group.get("parentVideosSha256")
        ):
            raise ContractError(f"parent video artifact hash mismatch: {key}")
        videos = read_ndjson(parent_video_path)
        video_by_id = {
            text(video.get("videoId")): video
            for video in videos
            if VIDEO_ID_RE.fullmatch(text(video.get("videoId")))
        }
        if len(video_by_id) != len(videos):
            raise ContractError(f"parent videos are missing or duplicate: {key}")
        expected_ids = list(group.get("parentVideoIds") or [])
        if (
            expected_ids != sorted(expected_ids)
            or len(expected_ids) != len(set(expected_ids))
            or sorted(video_by_id) != expected_ids
            or canonical_sha256(expected_ids) != group.get("parentVideoIdsSha256")
            or len(expected_ids) != int(group.get("parentVideoCount") or 0)
        ):
            raise ContractError(f"parent video set contract mismatch: {key}")
        review_entries = review.get("videos")
        if not isinstance(review_entries, list):
            raise ContractError(f"review ledger videos are missing: {key}")
        evidence_by_video: dict[str, dict[str, Any]] = {}
        for entry in review_entries:
            if not isinstance(entry, Mapping):
                raise ContractError(f"review entry is not an object: {key}")
            video_id = text(entry.get("videoId"))
            if video_id in evidence_by_video:
                raise ContractError(f"review ledger repeats video: {video_id}")
            evidence_by_video[video_id] = validate_review_evidence(entry, group)
        if sorted(evidence_by_video) != expected_ids:
            raise ContractError(f"review ledger is partial or contains extras: {key}")
        evidence_manifest = [
            evidence_by_video[video_id] for video_id in expected_ids
        ]
        evidence_digest = canonical_sha256(evidence_manifest)
        for video_id in expected_ids:
            if video_id in global_video_ids:
                raise ContractError(f"video belongs to multiple reset groups: {video_id}")
            global_video_ids.add(video_id)
            source = dict(video_by_id[video_id])
            evidence = evidence_by_video[video_id]
            source.update({
                "channelId": group["targetChannelId"],
                "channelHandle": group["targetChannelHandle"],
                "channelUrl": group["targetChannelUrl"],
                "reviewedBy": evidence["reviewedBy"],
                "reviewedAt": evidence["reviewedAt"],
                "reason": "legacy-vtuber-full-identity-reset",
                "identityResetEvidence": evidence,
            })
            accepted_videos.append(source)
        reset = {
            name: group[name]
            for name in (
                "schemaVersion", "kind", "rangeId", "parentRevisionId",
                "parentRuntimeRevisionId", "legacyDetailKey",
                "legacyDisplayName", "sourceKey", "parentVideoCount",
                "parentOccurrenceCount", "parentVideoIds",
                "parentVideoIdsSha256",
                "parentOccurrenceIdentitiesSha256",
                "targetChannelId", "targetChannelHandle", "targetChannelUrl",
            )
        }
        reset.update({
            "sourceReachedEnd": True,
            "complete": True,
            "unresolvedParentVideoIds": [],
            "unexpectedResetVideoIds": [],
            "identityEvidenceSha256": evidence_digest,
        })
        resets.append(reset)
    if set(by_key) != {
        text(group.get("legacyDetailKey"))
        for group in parent.get("groups") or []
    }:
        raise ContractError("review ledger contains an unexpected group")
    accepted_videos.sort(key=lambda item: text(item.get("videoId")))
    payload = {
        "schemaVersion": 1,
        "sourceSystem": "youtube_channel_discovery",
        "kind": ACCEPTED_KIND,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "inputs": [
            parent_manifest_path.as_posix(),
            review_ledger_path.as_posix(),
        ],
        "readStats": {
            "inputDirs": 1,
            "videoDetails": len(accepted_videos),
            "usableVideos": len(accepted_videos),
            "duplicateVideoIds": 0,
            "suspiciousSongs": 0,
            "unresolvedParentVideos": 0,
        },
        "videoCount": len(accepted_videos),
        "occurrenceCount": sum(
            len(video.get("songs") or []) for video in accepted_videos
        ),
        "identityResets": resets,
        "videos": accepted_videos,
    }
    validate_accepted_identity_resets(resets, accepted_videos)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(output_path, payload)
    return payload


def verify_contract_against_db(
    connection: Any,
    accepted_payload: Mapping[str, Any],
    expected_active: str,
) -> dict[str, Any]:
    resets = validate_identity_reset_manifest_presence(accepted_payload)
    if not resets:
        raise ContractError("accepted payload has no identityResets")
    videos = accepted_payload.get("videos")
    assert isinstance(videos, list)
    validate_accepted_identity_resets(resets, videos)
    verified_contract = verify_reset_manifests_against_db(
        connection, resets, expected_active,
    )
    with read_snapshot(connection):
        accepted_by_id: dict[str, Mapping[str, Any]] = {}
        for video in videos:
            if not isinstance(video, Mapping):
                raise ContractError("accepted video is not an object")
            video_id = text(video.get("videoId"))
            if not video_id or video_id in accepted_by_id:
                raise ContractError("accepted video ID is missing or duplicate")
            accepted_by_id[video_id] = video
        for reset in resets:
            if not isinstance(reset, Mapping):
                raise ContractError("identity reset is not an object")
            target = validate_target(reset)
            ids = list(reset.get("parentVideoIds") or [])
            selected = [accepted_by_id.get(video_id) for video_id in ids]
            if any(video is None for video in selected):
                raise ContractError("identity reset accepted video set is partial")
            for video in selected:
                assert isinstance(video, Mapping)
                if (
                    text(video.get("channelId")) != target["targetChannelId"]
                    or canonical_handle(video.get("channelHandle"))
                    != target["targetChannelHandle"]
                    or text(video.get("channelUrl")) != target["targetChannelUrl"]
                ):
                    raise ContractError("identity reset video channel identity mismatch")
    return {
        "status": "ok",
        "activeRevisionId": expected_active,
        "parentRuntimeRevisionId": verified_contract["parentRuntimeRevisionId"],
        "verifiedLegacyDetailKeys": (
            verified_contract["verifiedLegacyDetailKeys"]
        ),
    }


def verify_reset_manifests_against_db(
    connection: Any,
    resets: Sequence[Mapping[str, Any]],
    expected_active: str,
) -> dict[str, Any]:
    """Recompute the parent CAS without trusting accepted video payloads."""

    if not resets:
        return {
            "status": "ok",
            "activeRevisionId": expected_active,
            "parentRuntimeRevisionId": "",
            "verifiedLegacyDetailKeys": [],
            "expectedVideos": {},
        }
    expected_videos: dict[str, dict[str, str]] = {}
    verified: list[str] = []
    with read_snapshot(connection):
        with connection.cursor() as cur:
            actual_active = active_revision(cur)
            if actual_active != expected_active:
                raise ContractError(
                    f"active revision CAS mismatch expected={expected_active} "
                    f"actual={actual_active}",
                )
            parent_runtime = runtime_parent(cur, actual_active)
        for reset in resets:
            if not isinstance(reset, Mapping):
                raise ContractError("identity reset is not an object")
            if text(reset.get("parentRevisionId")) != actual_active:
                raise ContractError("identity reset parent revision CAS mismatch")
            if text(reset.get("parentRuntimeRevisionId")) != parent_runtime:
                raise ContractError("identity reset full-runtime parent mismatch")
            if (
                reset.get("sourceReachedEnd") is not True
                or reset.get("complete") is not True
                or reset.get("unresolvedParentVideoIds") != []
                or reset.get("unexpectedResetVideoIds") != []
            ):
                raise ContractError("identity reset is not complete")
            target = validate_target(reset)
            snapshot, _ = snapshot_group(connection, parent_runtime, target)
            for name in (
                "legacyDetailKey", "parentVideoCount", "parentOccurrenceCount",
                "parentVideoIds", "parentVideoIdsSha256",
                "parentOccurrenceIdentitiesSha256", "sourceKey",
                "targetChannelId", "targetChannelHandle", "targetChannelUrl",
            ):
                if snapshot.get(name) != reset.get(name):
                    raise ContractError(
                        f"identity reset database contract mismatch: {name}",
                    )
            for video_id in reset.get("parentVideoIds") or []:
                if video_id in expected_videos:
                    raise ContractError(
                        "identity reset video belongs to multiple groups",
                    )
                expected_videos[video_id] = {
                    "legacyDetailKey": target["legacyDetailKey"],
                    "channelId": target["targetChannelId"],
                    "channelHandle": target["targetChannelHandle"],
                    "channelUrl": target["targetChannelUrl"],
                }
            verified.append(target["legacyDetailKey"])
    return {
        "status": "ok",
        "activeRevisionId": expected_active,
        "parentRuntimeRevisionId": parent_runtime,
        "verifiedLegacyDetailKeys": verified,
        "expectedVideos": expected_videos,
    }


def connect_database() -> Any:
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as exc:
        raise ContractError("psycopg is required for database modes") from exc
    dsn = (
        os.environ.get("DAILY_SONG_POSTGRES_DSN")
        or os.environ.get("DATABASE_URL")
        or "dbname=song_rank"
    )
    return psycopg.connect(dsn, row_factory=dict_row)


def command_export(args: argparse.Namespace) -> dict[str, Any]:
    targets = load_targets(args.targets)
    connection = connect_database()
    try:
        return export_parent(
            connection,
            args.expected_active,
            targets,
            args.output_root,
        )
    finally:
        connection.close()


def command_finalize(args: argparse.Namespace) -> dict[str, Any]:
    return finalize_accepted(args.parent_manifest, args.review_ledger, args.output)


def command_verify(args: argparse.Namespace) -> dict[str, Any]:
    payload = json.loads(args.accepted.read_text(encoding="utf-8"))
    connection = connect_database()
    try:
        return verify_contract_against_db(
            connection,
            payload,
            args.expected_active,
        )
    finally:
        connection.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    export = subparsers.add_parser("export-parent")
    export.add_argument("--expected-active", required=True)
    export.add_argument("--targets", type=Path, required=True)
    export.add_argument("--output-root", type=Path, required=True)
    export.set_defaults(function=command_export)
    finalize = subparsers.add_parser("finalize")
    finalize.add_argument("--parent-manifest", type=Path, required=True)
    finalize.add_argument("--review-ledger", type=Path, required=True)
    finalize.add_argument("--output", type=Path, required=True)
    finalize.set_defaults(function=command_finalize)
    verify = subparsers.add_parser("verify-db")
    verify.add_argument("--expected-active", required=True)
    verify.add_argument("--accepted", type=Path, required=True)
    verify.set_defaults(function=command_verify)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = args.function(args)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        print("LEGACY_VTUBER_IDENTITY_RESET_COMPLETE")
        return 0
    except Exception as exc:
        print(
            f"LEGACY_VTUBER_IDENTITY_RESET_ERROR "
            f"{type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return 78


if __name__ == "__main__":
    raise SystemExit(main())
