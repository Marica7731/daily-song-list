#!/usr/bin/env python3
"""Export, capture, and attest a bounded active-PG curation snapshot.

The ``export`` command runs beside PostgreSQL and writes only NDJSON to stdout.
It resolves the active full projection plus incremental overlays through the
production PG adapter and never writes a snapshot on the database host.

The ``capture`` command runs on the Mac producer.  It enforces byte/row caps,
hashes the exact stream, and writes an atomic progress/final checkpoint.

The ``finalize`` command binds the converter output to the active revision and
the independently verified stream without requiring a consumer workflow change.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import itertools
import json
import os
from pathlib import Path
import sys
from typing import Any, Iterable, Iterator, Mapping, Sequence


EXPORT_OK_PREFIX = "PG_ACTIVE_CURATION_EXPORT_OK "
CAPTURE_OK_PREFIX = "PG_ACTIVE_CURATION_CAPTURE_OK "
FINALIZE_OK_PREFIX = "PG_ACTIVE_CURATION_FINALIZE_OK "
STREAM_BATCH_SIZE = 1000
MAX_OVERLAY_VIDEOS = 10000
MAX_OVERLAY_ROWS = 100000
REQUIRED_SNAPSHOT_FIELDS = (
    "videoId",
    "occurrenceId",
    "position",
    "seconds",
    "title",
    "artist",
    "sourceId",
    "sourceHash",
    "rawHash",
    "rangeId",
    "sourceSystem",
    "channelHandle",
)
PROTECTION_TUPLE_FIELDS = (
    "videoId",
    "occurrenceId",
    "position",
    "seconds",
    "sourceId",
    "sourceHash",
    "rawHash",
    "rangeId",
)
PROTECTION_TUPLE_STRING_FIELDS = tuple(
    field for field in PROTECTION_TUPLE_FIELDS if field not in {"position", "seconds"}
)


class GateError(RuntimeError):
    """A bounded producer gate failed and should return exit status 78."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_bytes(value: Mapping[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise GateError(f"JSON root must be an object: {path}")
    return value


def atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def load_adapter(path: Path):
    spec = importlib.util.spec_from_file_location("curation_pg_adapter", path)
    if spec is None or spec.loader is None:
        raise GateError(f"cannot load PG adapter: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(spec.name, None)
        raise
    for name in ("connect_from_env", "_one", "_load_snapshot"):
        if not hasattr(module, name):
            raise GateError(f"PG adapter missing required function: {name}")
    return module


def json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str) and value.strip():
        parsed = json.loads(value)
        return dict(parsed) if isinstance(parsed, Mapping) else {}
    return {}


def cursor_names(cursor: Any) -> list[str]:
    return [str(column[0]) for column in (cursor.description or ())]


def iter_query_rows(
    connection: Any,
    sql: str,
    params: Sequence[Any] = (),
    *,
    batch_size: int = STREAM_BATCH_SIZE,
    cursor_tag: str,
) -> Iterator[dict[str, Any]]:
    name = f"curation_export_{os.getpid()}_{cursor_tag}"
    try:
        cursor = connection.cursor(name=name)
    except TypeError:
        cursor = connection.cursor(name)
    try:
        if hasattr(cursor, "itersize"):
            cursor.itersize = batch_size
        cursor.execute(sql, params)
        names = cursor_names(cursor)
        while True:
            values = cursor.fetchmany(batch_size)
            if not values:
                break
            for row in values:
                yield dict(zip(names, row))
    finally:
        close = getattr(cursor, "close", None)
        if close:
            close()


def revision_row(adapter: Any, connection: Any, revision_id: str) -> dict[str, Any]:
    row = adapter._one(
        connection,
        """
        SELECT revision_id, parent_revision_id, status, manifest_json
        FROM migration_revisions WHERE revision_id = %s
        """,
        [revision_id],
    )
    if not row:
        raise GateError(f"active revision lineage is missing: {revision_id}")
    return row


def runtime_plan(
    adapter: Any,
    connection: Any,
    active_revision: str,
) -> tuple[str, list[str]]:
    overlays: list[str] = []
    seen: set[str] = set()
    current = active_revision
    while current:
        if current in seen:
            raise GateError(f"active revision parent cycle: {current}")
        seen.add(current)
        row = revision_row(adapter, connection, current)
        manifest = json_object(row.get("manifest_json"))
        if manifest.get("runtimeProjection") is True and not manifest.get("incrementalOverlay"):
            return current, list(reversed(overlays))
        overlays.append(current)
        current = text(row.get("parent_revision_id"))
    raise GateError(f"active revision has no immutable full runtime parent: {active_revision}")


def overlay_rows(
    connection: Any,
    overlay_revision_ids: Sequence[str],
) -> tuple[list[dict[str, Any]], set[str]]:
    revisions: list[dict[str, Any]] = []
    affected_video_ids: set[str] = set()
    total_rows = 0
    for index, revision_id in enumerate(overlay_revision_ids):
        def collect(sql: str, cursor_tag: str) -> list[dict[str, Any]]:
            nonlocal total_rows
            rows: list[dict[str, Any]] = []
            for row in iter_query_rows(
                connection,
                sql,
                [revision_id],
                cursor_tag=cursor_tag,
            ):
                total_rows += 1
                if total_rows > MAX_OVERLAY_ROWS:
                    raise GateError(
                        f"active overlay row cap exceeded rows={total_rows} "
                        f"cap={MAX_OVERLAY_ROWS}"
                    )
                rows.append(row)
            return rows

        videos = collect(
            """
                SELECT video_id, title, channel_name, channel_id, channel_handle,
                       channel_url, published_at, tombstone, payload_json
                FROM migration_video_rows
                WHERE revision_id = %s ORDER BY video_id
            """,
            f"overlay_videos_{index}",
        )
        occurrences = collect(
            """
                SELECT video_id, occurrence_key, occurrence_id, position, range_id,
                       song_key, seconds, title, artist, source_id, raw_hash,
                       source_system, payload_json
                FROM migration_occurrence_rows
                WHERE revision_id = %s
                ORDER BY video_id, position, occurrence_key
            """,
            f"overlay_occurrences_{index}",
        )
        runtime = collect(
            """
                SELECT entity_type, entity_key, source_system, range_id, source_id,
                       occurrence_id, tombstone, payload_json
                FROM migration_runtime_rows
                WHERE revision_id = %s ORDER BY entity_type, entity_key
            """,
            f"overlay_runtime_{index}",
        )
        affected_video_ids.update(text(row.get("video_id")) for row in videos)
        affected_video_ids.update(text(row.get("video_id")) for row in occurrences)
        for row in runtime:
            payload = json_object(row.get("payload_json"))
            entity_type = text(row.get("entity_type"))
            if entity_type in {"videos", "runtime_videos"}:
                affected_video_ids.add(text(payload.get("videoId") or row.get("entity_key")))
            elif entity_type in {"occurrences", "runtime_occurrences"}:
                affected_video_ids.add(text(payload.get("videoId") or payload.get("video_id")))
        affected_video_ids.discard("")
        if len(affected_video_ids) > MAX_OVERLAY_VIDEOS:
            raise GateError(
                f"active overlay video cap exceeded videos={len(affected_video_ids)} "
                f"cap={MAX_OVERLAY_VIDEOS}"
            )
        revisions.append(
            {
                "revisionId": revision_id,
                "videos": videos,
                "occurrences": occurrences,
                "runtime": runtime,
            }
        )
    return revisions, affected_video_ids


def base_video(row: Mapping[str, Any]) -> dict[str, Any]:
    payload = json_object(row.get("video_payload_json", row.get("payload_json")))
    payload.update(
        {
            "videoId": payload.get("videoId") or row.get("video_id"),
            "title": payload["title"] if "title" in payload else row.get("video_title", row.get("title")),
            "channelName": payload["channelName"] if "channelName" in payload else row.get("channel_name"),
            "channelId": payload["channelId"] if "channelId" in payload else row.get("channel_id"),
            "channelHandle": payload["channelHandle"] if "channelHandle" in payload else row.get("channel_handle"),
            "channelUrl": payload["channelUrl"] if "channelUrl" in payload else row.get("channel_url"),
            "publishedAt": payload["publishedAt"] if "publishedAt" in payload else row.get("published_timestamp"),
        }
    )
    return payload


def base_occurrence(row: Mapping[str, Any], position: int) -> dict[str, Any]:
    payload = json_object(row.get("occurrence_payload_json", row.get("payload_json")))
    payload.update(
        {
            "occurrenceId": payload["occurrenceId"] if "occurrenceId" in payload else row.get("occurrence_id"),
            "position": payload["position"] if "position" in payload else position,
            "rangeId": payload["rangeId"] if "rangeId" in payload else row.get("range_id"),
            "songKey": payload["songKey"] if "songKey" in payload else row.get("song_key"),
            "seconds": payload["seconds"] if "seconds" in payload else row.get("seconds"),
            "title": payload["title"] if "title" in payload else row.get("occurrence_title", row.get("title")),
            "artist": payload["artist"] if "artist" in payload else row.get("artist"),
            "sourceId": payload["sourceId"] if "sourceId" in payload else row.get("source_id"),
            "sourceSystem": payload["sourceSystem"] if "sourceSystem" in payload else row.get("source_system"),
        }
    )
    return payload


BASE_VIDEO_SQL = """
SELECT video_id, title AS video_title, channel_name, channel_id, channel_handle,
       channel_url, published_timestamp, payload_json AS video_payload_json
FROM runtime_videos
WHERE revision_id = %s AND video_id = ANY(%s)
ORDER BY video_id
"""

BASE_OCCURRENCE_SQL = """
SELECT occurrence_id, range_id, video_id, song_key, seconds, source_system,
       source_id, title AS occurrence_title, artist,
       payload_json AS occurrence_payload_json
FROM runtime_occurrences
WHERE revision_id = %s AND video_id = ANY(%s)
ORDER BY video_id, range_id, occurrence_id
"""

BASE_STREAM_SQL = """
SELECT o.occurrence_id, o.range_id, o.video_id, o.song_key, o.seconds,
       o.source_system, o.source_id, o.title AS occurrence_title, o.artist,
       o.payload_json AS occurrence_payload_json,
       v.title AS video_title, v.channel_name, v.channel_id, v.channel_handle,
       v.channel_url, v.published_timestamp, v.payload_json AS video_payload_json
FROM runtime_occurrences AS o
JOIN runtime_videos AS v
  ON v.revision_id = o.revision_id AND v.video_id = o.video_id
WHERE o.revision_id = %s
ORDER BY o.video_id, o.range_id, o.occurrence_id
"""


def affected_base_records(
    connection: Any,
    full_revision_id: str,
    affected_video_ids: set[str],
) -> tuple[dict[str, dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    videos: dict[str, dict[str, Any]] = {}
    occurrences: dict[str, list[dict[str, Any]]] = {}
    if not affected_video_ids:
        return videos, occurrences
    selected = sorted(affected_video_ids)
    for row in iter_query_rows(
        connection,
        BASE_VIDEO_SQL,
        [full_revision_id, selected],
        cursor_tag="affected_videos",
    ):
        video_id = text(row.get("video_id"))
        videos[video_id] = base_video(row)
        occurrences[video_id] = []
    positions: dict[str, int] = {}
    affected_rows = 0
    for row in iter_query_rows(
        connection,
        BASE_OCCURRENCE_SQL,
        [full_revision_id, selected],
        cursor_tag="affected_occurrences",
    ):
        video_id = text(row.get("video_id"))
        position = positions.get(video_id, 0)
        positions[video_id] = position + 1
        occurrences.setdefault(video_id, []).append(base_occurrence(row, position))
        affected_rows += 1
        if affected_rows > MAX_OVERLAY_ROWS:
            raise GateError(
                f"affected parent occurrence cap exceeded rows={affected_rows} "
                f"cap={MAX_OVERLAY_ROWS}"
            )
    return videos, occurrences


def apply_overlay_rows(
    videos: dict[str, dict[str, Any]],
    occurrences: dict[str, list[dict[str, Any]]],
    revisions: Sequence[Mapping[str, Any]],
) -> None:
    positions: dict[str, int] = {}
    for revision in revisions:
        video_rows = revision["videos"]
        for video_id in {text(row.get("video_id")) for row in video_rows}:
            occurrences[video_id] = []
        for row in video_rows:
            video_id = text(row.get("video_id"))
            if row.get("tombstone"):
                videos.pop(video_id, None)
                occurrences.pop(video_id, None)
                continue
            payload = json_object(row.get("payload_json"))
            if isinstance(payload.get("payload"), Mapping):
                payload = dict(payload["payload"])
            payload.update(
                {
                    "videoId": video_id,
                    "title": payload.get("title", row.get("title")),
                    "channelName": payload.get("channelName", row.get("channel_name")),
                    "channelId": payload.get("channelId", row.get("channel_id")),
                    "channelHandle": payload.get("channelHandle", row.get("channel_handle")),
                    "channelUrl": payload.get("channelUrl", row.get("channel_url")),
                    "publishedAt": payload.get("publishedAt", row.get("published_at")),
                }
            )
            videos[video_id] = payload
        for row in revision["occurrences"]:
            video_id = text(row.get("video_id"))
            payload = json_object(row.get("payload_json"))
            payload.update(
                {
                    "videoId": video_id,
                    "occurrenceId": row.get("occurrence_id"),
                    "position": row.get("position"),
                    "rangeId": row.get("range_id"),
                    "songKey": row.get("song_key"),
                    "seconds": row.get("seconds"),
                    "title": row.get("title"),
                    "artist": row.get("artist"),
                    "sourceId": row.get("source_id"),
                    "rawHash": row.get("raw_hash"),
                    "sourceSystem": row.get("source_system"),
                }
            )
            occurrences.setdefault(video_id, []).append(payload)
        for row in revision["runtime"]:
            entity_type = text(row.get("entity_type"))
            payload = json_object(row.get("payload_json"))
            if isinstance(payload.get("payload"), Mapping):
                payload = dict(payload["payload"])
            if entity_type in {"videos", "runtime_videos"}:
                video_id = text(payload.get("videoId") or payload.get("video_id") or row.get("entity_key"))
                if row.get("tombstone"):
                    videos.pop(video_id, None)
                    occurrences.pop(video_id, None)
                    continue
                if video_id:
                    payload.update(
                        {
                            "videoId": video_id,
                            "title": payload.get("title"),
                            "channelName": payload.get("channelName", payload.get("channel_name")),
                            "channelId": payload.get("channelId", payload.get("channel_id")),
                            "channelHandle": payload.get("channelHandle", payload.get("channel_handle")),
                            "channelUrl": payload.get("channelUrl", payload.get("channel_url")),
                            "publishedAt": payload.get(
                                "publishedAt",
                                payload.get("published_at", payload.get("published_timestamp")),
                            ),
                        }
                    )
                    videos[video_id] = payload
            elif entity_type in {"occurrences", "runtime_occurrences"}:
                video_id = text(payload.get("videoId") or payload.get("video_id"))
                if not video_id:
                    continue
                occurrence_id = text(
                    payload.get("occurrenceId")
                    or payload.get("occurrence_id")
                    or row.get("occurrence_id")
                    or row.get("entity_key")
                )
                existing = [
                    item
                    for item in occurrences.setdefault(video_id, [])
                    if text(item.get("occurrenceId")) != occurrence_id
                ]
                if not row.get("tombstone"):
                    position = payload.get("position")
                    try:
                        position = int(position)
                    except (TypeError, ValueError):
                        position = positions.get(video_id, 0)
                    positions[video_id] = max(positions.get(video_id, 0), position + 1)
                    payload.update(
                        {
                            "videoId": video_id,
                            "occurrenceId": occurrence_id,
                            "position": position,
                            "rangeId": payload.get("rangeId", payload.get("range_id", row.get("range_id"))),
                            "songKey": payload.get("songKey", payload.get("song_key")),
                            "seconds": payload.get("seconds"),
                            "title": payload.get("title"),
                            "artist": payload.get("artist"),
                            "sourceId": payload.get("sourceId", payload.get("source_id", row.get("source_id"))),
                            "sourceSystem": payload.get(
                                "sourceSystem",
                                payload.get("source_system", row.get("source_system")),
                            ),
                        }
                    )
                    existing.append(payload)
                occurrences[video_id] = existing


def iter_base_records(connection: Any, full_revision_id: str) -> Iterator[dict[str, Any]]:
    current_video_id = ""
    current_video: dict[str, Any] | None = None
    current_occurrences: list[dict[str, Any]] = []
    position = 0
    for row in iter_query_rows(
        connection,
        BASE_STREAM_SQL,
        [full_revision_id],
        cursor_tag="full_runtime",
    ):
        video_id = text(row.get("video_id"))
        if current_video_id and video_id != current_video_id:
            yield {"video": current_video, "occurrences": tuple(current_occurrences)}
            current_occurrences = []
            position = 0
        if video_id != current_video_id:
            current_video_id = video_id
            current_video = base_video(row)
        current_occurrences.append(base_occurrence(row, position))
        position += 1
    if current_video_id:
        yield {"video": current_video, "occurrences": tuple(current_occurrences)}


def iter_active_records(adapter: Any, connection: Any, active_revision: str) -> Iterator[dict[str, Any]]:
    full_revision_id, overlay_revision_ids = runtime_plan(adapter, connection, active_revision)
    revisions, affected_video_ids = overlay_rows(connection, overlay_revision_ids)
    videos, occurrences = affected_base_records(connection, full_revision_id, affected_video_ids)
    apply_overlay_rows(videos, occurrences, revisions)
    affected_records = {
        video_id: {
            "video": video,
            "occurrences": tuple(
                sorted(
                    occurrences.get(video_id, []),
                    key=lambda item: (int(item.get("position") or 0), text(item.get("occurrenceId"))),
                )
            ),
        }
        for video_id, video in videos.items()
        if video_id in affected_video_ids
    }
    affected_ids = iter(sorted(affected_records))
    affected_id = next(affected_ids, None)
    for record in iter_base_records(connection, full_revision_id):
        video_id = text(record["video"].get("videoId"))
        while affected_id is not None and affected_id < video_id:
            yield affected_records[affected_id]
            affected_id = next(affected_ids, None)
        if video_id in affected_video_ids:
            if affected_id == video_id:
                yield affected_records[affected_id]
                affected_id = next(affected_ids, None)
            continue
        yield record
    while affected_id is not None:
        yield affected_records[affected_id]
        affected_id = next(affected_ids, None)


def snapshot_rows(snapshot: Any) -> Iterable[dict[str, Any]]:
    records = snapshot if isinstance(snapshot, Iterable) else getattr(snapshot, "records", None)
    if records is None:
        raise GateError("PG adapter snapshot has no records")
    for record in records:
        if not isinstance(record, Mapping):
            raise GateError("PG adapter snapshot record is not an object")
        video = record.get("video")
        occurrences = record.get("occurrences")
        if not isinstance(video, Mapping) or not isinstance(occurrences, Iterable):
            raise GateError("PG adapter snapshot record is missing video/occurrences")
        video_id = text(video.get("videoId"))
        channel_handle = text(video.get("channelHandle"))
        if not video_id:
            raise GateError("resolved PG video is missing videoId")
        ordered = sorted(
            occurrences,
            key=lambda item: (
                int(item.get("position") or 0) if isinstance(item, Mapping) else 0,
                text(item.get("occurrenceId")) if isinstance(item, Mapping) else "",
            ),
        )
        for occurrence in ordered:
            if not isinstance(occurrence, Mapping):
                raise GateError(f"resolved PG occurrence is not an object: {video_id}")
            occurrence_id = text(occurrence.get("occurrenceId"))
            if not occurrence_id:
                raise GateError(f"resolved PG occurrence is missing occurrenceId: {video_id}")
            yield {
                "videoId": video_id,
                "occurrenceId": occurrence_id,
                "position": occurrence.get("position"),
                "seconds": occurrence.get("seconds"),
                "title": occurrence.get("title"),
                "artist": occurrence.get("artist"),
                "sourceId": occurrence.get("sourceId"),
                "sourceHash": occurrence.get("sourceHash"),
                "rawHash": occurrence.get("rawHash"),
                "rangeId": occurrence.get("rangeId"),
                "sourceSystem": occurrence.get("sourceSystem"),
                "channelHandle": occurrence.get("channelHandle", channel_handle),
            }


def export_snapshot(args: argparse.Namespace) -> int:
    adapter = load_adapter(args.adapter)
    os.environ.pop("DAILY_SONG_PG_CANDIDATE_REVISION", None)
    connection = adapter.connect_from_env()
    digest = hashlib.sha256()
    byte_count = 0
    row_count = 0
    try:
        with connection.cursor() as cursor:
            cursor.execute("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            cursor.execute("SET LOCAL statement_timeout = '20min'")
            cursor.execute("SET LOCAL idle_in_transaction_session_timeout = '25min'")
            cursor.execute(
                "SELECT pg_try_advisory_xact_lock_shared(hashtext('daily-song-list/active'))"
            )
            lock_row = cursor.fetchone()
            if not lock_row or lock_row[0] is not True:
                raise GateError("PostgreSQL active release lock is busy")
        state = adapter._one(
            connection,
            "SELECT state_value FROM migration_state WHERE state_key = 'active_revision_id'",
        )
        active_revision = text(state.get("state_value")) if state else ""
        if not active_revision:
            raise GateError("PostgreSQL has no active revision")
        if args.expected_active_revision and active_revision != args.expected_active_revision:
            raise GateError(
                f"active revision mismatch expected={args.expected_active_revision} actual={active_revision}"
            )
        records = iter_active_records(adapter, connection, active_revision)
        for row in snapshot_rows(records):
            encoded = json_bytes(row)
            sys.stdout.buffer.write(encoded)
            digest.update(encoded)
            byte_count += len(encoded)
            row_count += 1
            if row_count % args.progress_every == 0:
                sys.stdout.buffer.flush()
                print(
                    f"PG_ACTIVE_CURATION_EXPORT_PROGRESS rows={row_count} bytes={byte_count}",
                    file=sys.stderr,
                    flush=True,
                )
        if row_count == 0:
            raise GateError("active snapshot stream is empty")
        sys.stdout.buffer.flush()
        summary = {
            "status": "ok",
            "activeRevisionId": active_revision,
            "rows": row_count,
            "bytes": byte_count,
            "sha256": digest.hexdigest(),
            "completedAt": utc_now(),
        }
        print(EXPORT_OK_PREFIX + json.dumps(summary, separators=(",", ":")), file=sys.stderr, flush=True)
        connection.rollback()
        return 0
    finally:
        try:
            connection.rollback()
        except Exception:
            pass
        connection.close()


def validate_snapshot_row(value: Any, row_number: int) -> None:
    if not isinstance(value, dict):
        raise GateError(f"snapshot row {row_number} is not an object")
    missing = [field for field in REQUIRED_SNAPSHOT_FIELDS if field not in value]
    if missing:
        raise GateError(f"snapshot row {row_number} missing fields: {','.join(missing)}")
    if not text(value.get("videoId")) or not text(value.get("occurrenceId")):
        raise GateError(f"snapshot row {row_number} has empty identity")


def capture_checkpoint(
    path: Path,
    output: Path,
    row_count: int,
    byte_count: int,
    digest: hashlib._Hash,
    complete: bool,
) -> None:
    atomic_json(
        path,
        {
            "schemaVersion": 1,
            "kind": "pg-active-curation-snapshot-checkpoint",
            "complete": complete,
            "resumable": False,
            "snapshotPath": output.name,
            "rows": row_count,
            "bytes": byte_count,
            "sha256": digest.hexdigest(),
            "updatedAt": utc_now(),
        },
    )


def capture_snapshot(args: argparse.Namespace) -> int:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    byte_count = 0
    row_count = 0
    try:
        with args.output.open("wb") as output:
            for raw in sys.stdin.buffer:
                if not raw.strip():
                    raise GateError(f"blank snapshot line at row {row_count + 1}")
                next_bytes = byte_count + len(raw)
                next_rows = row_count + 1
                if next_bytes > args.max_bytes:
                    raise GateError(
                        f"snapshot byte cap exceeded bytes={next_bytes} cap={args.max_bytes}"
                    )
                if next_rows > args.max_rows:
                    raise GateError(
                        f"snapshot row cap exceeded rows={next_rows} cap={args.max_rows}"
                    )
                try:
                    value = json.loads(raw)
                except json.JSONDecodeError as error:
                    raise GateError(f"invalid snapshot JSON at row {next_rows}: {error}") from error
                validate_snapshot_row(value, next_rows)
                output.write(raw)
                digest.update(raw)
                byte_count = next_bytes
                row_count = next_rows
                if row_count % args.progress_every == 0:
                    output.flush()
                    os.fsync(output.fileno())
                    capture_checkpoint(
                        args.checkpoint_output,
                        args.output,
                        row_count,
                        byte_count,
                        digest,
                        False,
                    )
            output.flush()
            os.fsync(output.fileno())
        if row_count == 0:
            raise GateError("active snapshot stream is empty")
        capture_checkpoint(
            args.checkpoint_output,
            args.output,
            row_count,
            byte_count,
            digest,
            True,
        )
        summary = {
            "status": "ok",
            "rows": row_count,
            "bytes": byte_count,
            "sha256": digest.hexdigest(),
        }
        print(CAPTURE_OK_PREFIX + json.dumps(summary, separators=(",", ":")))
        return 0
    except Exception:
        args.output.unlink(missing_ok=True)
        capture_checkpoint(
            args.checkpoint_output,
            args.output,
            row_count,
            byte_count,
            digest,
            False,
        )
        raise


def remote_export_summary(path: Path) -> dict[str, Any]:
    matches: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith(EXPORT_OK_PREFIX):
            value = json.loads(line[len(EXPORT_OK_PREFIX):])
            if isinstance(value, dict):
                matches.append(value)
    if len(matches) != 1:
        raise GateError(f"expected one remote export summary, found {len(matches)}")
    return matches[0]


def assert_int(value: Any, expected: int, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value != expected:
        raise GateError(f"{label} mismatch expected={expected} actual={value}")


def assert_int_at_most(value: Any, maximum: int, label: str) -> None:
    """Like assert_int but allows value <= maximum (some records may be already_applied)."""
    if isinstance(value, bool) or not isinstance(value, int) or value > maximum:
        raise GateError(f"{label} mismatch expected<={maximum} actual={value}")


def observe_business(
    observations: list[dict[str, Any]],
    code: str,
    passed: bool,
    observed: Any,
    expected: Any,
) -> None:
    observations.append({
        "code": code,
        "passed": passed,
        "observed": observed,
        "expected": expected,
    })


def observe_int(
    observations: list[dict[str, Any]],
    value: Any,
    expected: int,
    label: str,
    *,
    at_most: bool = False,
) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise GateError(f"{label} is not an integer: {value}")
    passed = value <= expected if at_most else value == expected
    observe_business(
        observations,
        label,
        passed,
        value,
        {"maximum": expected} if at_most else expected,
    )


def protection_tuple_digest(tuples: Iterable[dict[str, Any]]) -> str:
    canonical = [{field: item[field] for field in PROTECTION_TUPLE_FIELDS} for item in tuples]
    canonical.sort(
        key=lambda item: json.dumps(
            item, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        )
    )
    return hashlib.sha256(
        json.dumps(
            canonical, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode("utf-8")
    ).hexdigest()


def validated_known_tuples(assertion: dict[str, Any]) -> list[dict[str, Any]]:
    assertion_id = text(assertion.get("assertionId"))
    value = assertion.get("knownTuplePresence")
    # Large-scope assertions may omit knownTuplePresence (only expectedScopeCount/
    # minScopeCount protect them).  Return an empty list in that case.
    if value is None or value == []:
        return []
    if not assertion_id or not isinstance(value, list) or not value:
        raise GateError(f"safety known tuple contract is invalid: {assertion_id or 'unnamed'}")
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        if not isinstance(item, dict) or set(item) != set(PROTECTION_TUPLE_FIELDS):
            raise GateError(f"safety known tuple schema is invalid: {assertion_id} index={index}")
        if any(
            not isinstance(item[field], str) or not item[field].strip()
            for field in PROTECTION_TUPLE_STRING_FIELDS
        ):
            raise GateError(f"safety known tuple string field is invalid: {assertion_id} index={index}")
        if any(
            isinstance(item[field], bool)
            or not isinstance(item[field], int)
            or item[field] < 0
            for field in ("position", "seconds")
        ):
            raise GateError(f"safety known tuple numeric field is invalid: {assertion_id} index={index}")
        normalized = {field: item[field] for field in PROTECTION_TUPLE_FIELDS}
        canonical = json.dumps(
            normalized, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        )
        if canonical in seen:
            raise GateError(f"safety known tuple duplicate: {assertion_id}")
        seen.add(canonical)
        result.append(normalized)
    return result


def optional_nonnegative_count(
    mapping: Mapping[str, Any], field: str, assertion_id: str
) -> int | None:
    if field not in mapping:
        return None
    value = mapping.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise GateError(f"safety {field} is invalid: {assertion_id}")
    return value


def producer_expectations(
    rules: dict[str, Any],
    observations: list[dict[str, Any]],
) -> tuple[int, int, int, dict[str, str], dict[str, Any]]:
    rules_ready = text(rules.get("status")) == "ready" and rules.get("ready") is True
    observe_business(
        observations,
        "rules_manifest_ready",
        rules_ready,
        {"status": rules.get("status"), "ready": rules.get("ready")},
        {"status": "ready", "ready": True},
    )
    selector = rules.get("expectedSelectorMutationCount")
    alias = rules.get("expectedAliasMutationCount")
    video = rules.get("expectedVideoMutationCount", 0)
    if any(
        isinstance(value, bool) or not isinstance(value, int) or value < 0
        for value in (selector, alias, video)
    ):
        raise GateError("rules manifest mutation expectations are invalid")
    records = rules.get("records")
    if not isinstance(records, list):
        raise GateError("rules manifest records are missing")
    total_record_selector = 0
    total_record_video = 0
    for record in records:
        if not isinstance(record, dict):
            raise GateError("rules manifest record is not an object")
        state = text(record.get("expectedCurrentState"))
        if state not in {"present", "absent"}:
            raise GateError(f"record expectedCurrentState is invalid: ruleId={record.get('ruleId')}")
        if text(record.get("action")) == "drop_video":
            scope_count = record.get("expectedVideoScopeCount")
            scope_sha = text(record.get("expectedVideoScopeSha256"))
            scope = record.get("expectedVideoScope")
            if (
                isinstance(scope_count, bool)
                or not isinstance(scope_count, int)
                or scope_count < 0
                or not isinstance(scope, list)
                or len(scope) != scope_count
                or len(scope_sha) != 64
                or any(character not in "0123456789abcdef" for character in scope_sha)
                or protection_tuple_digest(scope) != scope_sha
            ):
                raise GateError(f"record video scope contract is invalid: ruleId={record.get('ruleId')}")
            total_record_video += 1 if state == "present" else 0
            continue
        rule_selector = record.get("expectedSelectorMutationCount")
        if isinstance(rule_selector, bool) or not isinstance(rule_selector, int) or rule_selector < 0:
            raise GateError(f"record selector contract is invalid: ruleId={record.get('ruleId')}")
        if state == "present" and rule_selector <= 0:
            raise GateError(f"record present state requires positive selector: ruleId={record.get('ruleId')}")
        if state == "absent" and rule_selector != 0:
            raise GateError(f"record absent state requires zero selector: ruleId={record.get('ruleId')}")
        total_record_selector += rule_selector
    observe_business(observations, "rules_selector_total", selector == total_record_selector, selector, total_record_selector)
    observe_business(observations, "rules_video_total", video == total_record_video, video, total_record_video)

    assertions = rules.get("safetyAssertions")
    if not isinstance(assertions, list) or not assertions:
        raise GateError("rules manifest safety assertions are missing")
    expected_digests: dict[str, str] = {}
    for assertion in assertions:
        if not isinstance(assertion, dict):
            raise GateError("rules safety assertion is not an object")
        assertion_id = text(assertion.get("assertionId"))
        if not assertion_id or assertion_id in expected_digests:
            raise GateError("rules safety assertion id is invalid")
        expected_mutations = optional_nonnegative_count(
            assertion, "expectedMutationCount", assertion_id
        )
        exact = optional_nonnegative_count(assertion, "expectedScopeCount", assertion_id)
        minimum = optional_nonnegative_count(assertion, "minScopeCount", assertion_id)
        observe_business(observations, f"safety_zero_mutation:{assertion_id}", expected_mutations == 0, expected_mutations, 0)
        if exact is None and minimum is None:
            raise GateError(f"safety scope contract is missing: {assertion_id}")
        expected_digests[assertion_id] = protection_tuple_digest(
            validated_known_tuples(assertion)
        )

    binding = rules.get("currentActiveEvidence")
    if not isinstance(binding, dict):
        raise GateError("rules current-active evidence binding is missing")
    for field in (
        "activeRevisionId",
        "snapshotSha256",
        "templateRulesManifestSha256",
    ):
        if not text(binding.get(field)):
            raise GateError(f"rules current-active evidence field is missing: {field}")
    if any(
        len(text(binding.get(field))) != 64
        or any(char not in "0123456789abcdef" for char in text(binding.get(field)))
        for field in ("snapshotSha256", "templateRulesManifestSha256")
    ):
        raise GateError("rules current-active evidence SHA is invalid")
    return selector, video, alias, expected_digests, binding


def protection_contract_sha256(expected_digests: Mapping[str, str]) -> str:
    return hashlib.sha256(
        json.dumps(
            dict(sorted(expected_digests.items())), separators=(",", ":"), sort_keys=True
        ).encode("utf-8")
    ).hexdigest()


def finalize_artifact(args: argparse.Namespace) -> int:
    business_observations: list[dict[str, Any]] = []
    converter_manifest = read_json(args.converter_manifest)
    review = read_json(args.review)
    capture = read_json(args.snapshot_checkpoint)
    rules = read_json(args.rules_manifest)
    remote = remote_export_summary(args.remote_log)
    expected_selector_mutations, expected_video_mutations, expected_alias_mutations, expected_digests, binding = (
        producer_expectations(rules, business_observations)
    )

    if converter_manifest.get("kind") != "curation-accepted-increment":
        raise GateError("converter manifest kind is not curation-accepted-increment")
    observe_business(
        business_observations,
        "converter_manifest_ready",
        converter_manifest.get("status") == "ready",
        converter_manifest.get("status"),
        "ready",
    )
    if capture.get("complete") is not True or capture.get("resumable") is not False:
        raise GateError("snapshot checkpoint is not complete/non-resumable")
    for field in ("rows", "bytes", "sha256"):
        if capture.get(field) != remote.get(field):
            raise GateError(
                f"remote/Mac snapshot {field} mismatch remote={remote.get(field)} mac={capture.get(field)}"
            )
    if converter_manifest.get("snapshotSha256") != capture.get("sha256"):
        raise GateError("converter snapshot SHA does not match capture checkpoint")

    observe_int(
        business_observations,
        converter_manifest.get("selectorMutationCount"),
        expected_selector_mutations,
        "selectorMutationCount",
        at_most=True,
    )
    observe_int(
        business_observations,
        converter_manifest.get("videoMutationCount", 0),
        expected_video_mutations,
        "videoMutationCount",
        at_most=True,
    )
    observe_int(
        business_observations,
        converter_manifest.get("aliasMutationCount"),
        expected_alias_mutations,
        "aliasMutationCount",
    )
    observe_int(
        business_observations,
        converter_manifest.get("curationMutationCount"),
        expected_selector_mutations + expected_video_mutations + expected_alias_mutations,
        "curationMutationCount",
        at_most=True,
    )
    candidate_rows = sum(1 for line in args.candidate.read_bytes().splitlines() if line.strip())
    observe_int(
        business_observations,
        candidate_rows,
        expected_selector_mutations + expected_video_mutations + expected_alias_mutations,
        "candidate row count",
        at_most=True,
    )
    failures = {
        "unmatched",
        "ambiguous",
        "count_mismatch",
        "alias_count_mismatch",
        "safety_violation",
        "scope_count_mismatch",
        "scope_count_below_minimum",
        "known_tuple_missing",
        "known_tuple_ambiguous",
    }
    summary = review.get("summary")
    results = review.get("results")
    if not isinstance(summary, dict) or not isinstance(results, list):
        raise GateError("review audit is missing summary/results")
    observed_failures = {status: int(summary.get(status) or 0) for status in sorted(failures)}
    observe_business(
        business_observations,
        "review_failure_statuses",
        not any(observed_failures.values()),
        observed_failures,
        {status: 0 for status in sorted(failures)},
    )

    safety_results = {
        text(item.get("assertionId")): item
        for item in results
        if isinstance(item, dict) and item.get("kind") == "safety_assertion"
    }
    assertions = rules["safetyAssertions"]
    for assertion in assertions:
        if not isinstance(assertion, dict):
            raise GateError("rules safety assertion is not an object")
        assertion_id = text(assertion.get("assertionId"))
        result = safety_results.get(assertion_id)
        accepted = bool(result) and result.get("status") == "accepted"
        observe_business(
            business_observations,
            f"safety_accepted:{assertion_id}",
            accepted,
            result.get("status") if result else None,
            "accepted",
        )
        if not result:
            continue
        expected = assertion["expectedMutationCount"]
        observe_business(business_observations, f"safety_mutation:{assertion_id}", result.get("mutationCount") == expected, result.get("mutationCount"), expected)
        if "expectedScopeCount" in assertion:
            expected_scope = assertion["expectedScopeCount"]
            observe_business(business_observations, f"safety_scope:{assertion_id}", result.get("scopeRowCount") == expected_scope, result.get("scopeRowCount"), expected_scope)
        if "minScopeCount" in assertion:
            minimum_scope = assertion["minScopeCount"]
            scope_count = result.get("scopeRowCount")
            if isinstance(scope_count, bool) or not isinstance(scope_count, int):
                raise GateError(f"safety scope count is not an integer: {assertion_id}")
            observe_business(business_observations, f"safety_minimum:{assertion_id}", scope_count >= minimum_scope, scope_count, {"minimum": minimum_scope})
        expected_known = validated_known_tuples(assertion)
        expected_digest = expected_digests[assertion_id]
        observe_business(business_observations, f"safety_tuple_count:{assertion_id}", result.get("knownTupleCount") == len(expected_known), result.get("knownTupleCount"), len(expected_known))
        digest_matches = result.get("expectedKnownTupleDigest") == expected_digest and result.get("observedKnownTupleDigest") == expected_digest
        observe_business(business_observations, f"safety_tuple_digest:{assertion_id}", digest_matches, {"expected": result.get("expectedKnownTupleDigest"), "observed": result.get("observedKnownTupleDigest")}, expected_digest)
        statuses = result.get("knownTupleStatuses")
        statuses_match = (
            not isinstance(statuses, list)
            or len(statuses) != len(expected_known)
            or any(
                not isinstance(item, dict)
                or item.get("index") != index
                or item.get("status") != "present"
                for index, item in enumerate(statuses)
            )
        ) is False
        observe_business(business_observations, f"safety_tuple_status:{assertion_id}", statuses_match, statuses, "all present in declaration order")

    rules_sha = sha256_file(args.rules_manifest)
    if converter_manifest.get("rulesManifestSha256") != rules_sha:
        raise GateError("converter rules manifest SHA mismatch")
    expected_protection_sha = protection_contract_sha256(expected_digests)
    observe_business(
        business_observations,
        "protection_contract_sha256",
        converter_manifest.get("protectionContractSha256") == expected_protection_sha,
        converter_manifest.get("protectionContractSha256"),
        expected_protection_sha,
    )
    if text(remote.get("activeRevisionId")) != args.expected_active_revision:
        raise GateError(
            f"final active revision mismatch expected={args.expected_active_revision} actual={remote.get('activeRevisionId')}"
        )
    if text(binding.get("activeRevisionId")) != args.expected_active_revision:
        raise GateError("bound rules active revision does not match final active revision")
    if text(binding.get("snapshotSha256")) != text(capture.get("sha256")):
        raise GateError("bound rules snapshot SHA does not match captured snapshot")

    candidate_sha = sha256_file(args.candidate)
    candidate_bytes = args.candidate.stat().st_size
    finalized = dict(converter_manifest)
    finalized.update(
        {
            "activeSnapshotRevisionId": remote["activeRevisionId"],
            "snapshotSha256": capture["sha256"],
            "snapshotBytes": capture["bytes"],
            "snapshotRowCount": capture["rows"],
            "snapshotArtifactIncluded": False,
            "snapshotCheckpointComplete": True,
            "snapshotCheckpointResumable": False,
            "rulesManifestSha256": rules_sha,
            "templateRulesManifestSha256": binding["templateRulesManifestSha256"],
            "producerCommitSha": args.producer_commit,
            "producerRunId": args.producer_run_id,
            "producerRunAttempt": args.producer_run_attempt,
            "producerFinalizedAt": utc_now(),
            "patch_sha256": candidate_sha,
            "patch_bytes": candidate_bytes,
            "businessValidationStatus": "observed_clean" if all(item["passed"] for item in business_observations) else "observed_mismatches",
            "businessValidationObservations": business_observations,
        }
    )
    atomic_json(args.output_manifest, finalized)

    outputs = {}
    for name, path in (
        ("candidate", args.candidate),
        ("manifest", args.output_manifest),
        ("review", args.review),
    ):
        outputs[name] = {
            "file": path.name,
            "bytes": path.stat().st_size,
            "sha256": candidate_sha if name == "candidate" else sha256_file(path),
        }
    checkpoint = {
        "schemaVersion": 1,
        "kind": "curation-pg-producer-checkpoint",
        "complete": True,
        "resumable": False,
        "producerCommitSha": args.producer_commit,
        "producerRunId": args.producer_run_id,
        "producerRunAttempt": args.producer_run_attempt,
        "activeSnapshotRevisionId": remote["activeRevisionId"],
        "rulesManifestSha256": rules_sha,
        "templateRulesManifestSha256": binding["templateRulesManifestSha256"],
        "snapshot": {
            "rows": capture["rows"],
            "bytes": capture["bytes"],
            "sha256": capture["sha256"],
            "artifactIncluded": False,
        },
        "outputs": outputs,
        "completedAt": utc_now(),
    }
    atomic_json(args.output_checkpoint, checkpoint)
    print(
        FINALIZE_OK_PREFIX
        + json.dumps(
            {
                "status": "ok",
                "activeRevisionId": remote["activeRevisionId"],
                "mutations": finalized["curationMutationCount"],
                "snapshotBytes": capture["bytes"],
            },
            separators=(",", ":"),
        )
    )
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)

    export = commands.add_parser("export")
    export.add_argument("--adapter", type=Path, required=True)
    export.add_argument("--expected-active-revision", required=True)
    export.add_argument("--progress-every", type=int, default=10000)
    export.set_defaults(handler=export_snapshot)

    capture = commands.add_parser("capture")
    capture.add_argument("--output", type=Path, required=True)
    capture.add_argument("--checkpoint-output", type=Path, required=True)
    capture.add_argument("--max-bytes", type=int, required=True)
    capture.add_argument("--max-rows", type=int, default=1000000)
    capture.add_argument("--progress-every", type=int, default=10000)
    capture.set_defaults(handler=capture_snapshot)

    finalize = commands.add_parser("finalize")
    finalize.add_argument("--converter-manifest", type=Path, required=True)
    finalize.add_argument("--review", type=Path, required=True)
    finalize.add_argument("--candidate", type=Path, required=True)
    finalize.add_argument("--snapshot-checkpoint", type=Path, required=True)
    finalize.add_argument("--remote-log", type=Path, required=True)
    finalize.add_argument("--rules-manifest", type=Path, required=True)
    finalize.add_argument("--output-manifest", type=Path, required=True)
    finalize.add_argument("--output-checkpoint", type=Path, required=True)
    finalize.add_argument("--expected-active-revision", required=True)
    finalize.add_argument("--producer-commit", required=True)
    finalize.add_argument("--producer-run-id", required=True)
    finalize.add_argument("--producer-run-attempt", required=True)
    finalize.set_defaults(handler=finalize_artifact)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        return args.handler(args)
    except GateError as error:
        print(f"PG_ACTIVE_CURATION_BLOCKED {error}", file=sys.stderr)
        return 78
    except Exception as error:
        print(
            f"PG_ACTIVE_CURATION_ERROR {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
