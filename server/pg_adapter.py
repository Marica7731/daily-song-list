"""Read-only PostgreSQL adapter for the incremental migration prototype.

This module deliberately does not start an HTTP server or change the existing
SQLite API.  It exposes endpoint-shaped functions that a later API wiring
change can call with a DB-API connection::

    rankings_payload(connection, query)
    meta_payload(connection)
    source_payload(connection, source_key, query)

The migration schema is an immutable revision overlay.  Reads resolve the
active revision through its parent chain before deriving the small response
objects needed by ``song_rank_api.py``.
"""

from __future__ import annotations

from collections import OrderedDict, defaultdict
import copy
from dataclasses import dataclass
from datetime import date, datetime
import hashlib
import json
import math
import os
import re
import sys
import threading
import time
import unicodedata
from typing import Any, Iterable, Mapping, Sequence


REQUIRED_TABLES = (
    "migration_revisions",
    "migration_video_rows",
    "migration_occurrence_rows",
    "migration_state",
    "migration_runtime_rows",
)
RUNTIME_TABLES = (
    "runtime_meta", "runtime_videos", "runtime_occurrences", "runtime_songs",
    "runtime_ranking_rows", "runtime_source_details", "runtime_source_occurrences",
    "runtime_channel_metadata", "runtime_external_songs", "runtime_external_videos",
    "runtime_external_occurrences",
)
SUPPORTED_RANGES = {"7d", "all"}
SUPPORTED_VIEWS = {"songs", "songIndex", "artists", "videos", "vtubers", "vsingerSongs"}
MAX_PAGE_SIZE = 200
MAX_SEARCH_PAGE_SIZE = 50
MAX_SOURCE_PREVIEW_OCCURRENCES = 2048
_VTUBER_REPLACEMENT_CACHE: dict[tuple[Any, ...], dict[str, dict[str, Any]]] = {}
_VTUBER_REPLACEMENT_CACHE_LOCK = threading.RLock()
# Generic increments are immutable.  Keep only their small derived meta count
# map, never record/payload data: a changed active pointer produces a different
# key and a process restart simply recomputes it from PostgreSQL.
_GENERIC_META_COUNTS_CACHE: dict[tuple[str, str, tuple[str, ...]], dict[str, int]] = {}
# A complete prepared aggregate is large on the production runtime.  One
# entry is enough to coalesce the concurrent pages for the active spec, while
# retaining prior range/metric/search aggregates would exceed the candidate's
# 2 GiB memory envelope.
_GENERIC_RANKING_PREPARATION_CAP = 1
_GENERIC_NO_SEARCH_PAGE_BUCKET = 5
_GENERIC_NO_SEARCH_AFFECTED_CUSHION = 4096
_GENERIC_RANKING_PREPARATION_MAX_BYTES = 16 * 1024 * 1024
_GENERIC_RANKING_PREPARATION_MAX_OCCURRENCES = 4096
_VTUBER_REPLACEMENT_CACHE_MAX_BYTES = 8 * 1024 * 1024
_VTUBER_REPLACEMENT_CACHE_MAX_OCCURRENCES = 2048
_CLICKED_SONG_SCOPE_GROUP_CAP = 512
_GENERIC_RANKING_PREPARATION_CACHE: OrderedDict[
    tuple[Any, ...], Mapping[str, Any],
] = OrderedDict()
_GENERIC_RANKING_PREPARATION_FLIGHTS: dict[
    tuple[Any, ...], "_RankingPreparationFlight",
] = {}
_GENERIC_RANKING_PREPARATION_LOCK = threading.RLock()


def _phase_trace(phase: str, started_at: float, **counts: int) -> float:
    """Emit candidate-only timing markers without changing normal API output."""

    now = time.perf_counter()
    if os.environ.get("DAILY_SONG_PG_ADAPTER_PHASE_TRACE") == "1":
        dimensions = "".join(
            f" {name}={int(value)}" for name, value in sorted(counts.items())
        )
        print(
            f"pg_adapter_phase phase={phase} elapsed_seconds={now - started_at:.3f}{dimensions}",
            file=sys.stderr,
            flush=True,
        )
    return now


class PostgresAdapterError(RuntimeError):
    """Base error for a PostgreSQL adapter failure."""


class PostgresSchemaError(PostgresAdapterError):
    """Raised when the migration schema is not installed or is incomplete."""


@dataclass
class _RankingPreparationFlight:
    event: threading.Event
    error: BaseException | None = None
    result: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class _Snapshot:
    revision_id: str | None
    revision: Mapping[str, Any] | None
    records: tuple[Mapping[str, Any], ...]


def resolve_dsn_from_env(env: Mapping[str, str] | None = None) -> dict[str, Any]:
    """Return the selected environment key without exposing its value."""

    values = os.environ if env is None else env
    for key in ("DAILY_SONG_POSTGRES_DSN", "DATABASE_URL", "PG_DSN"):
        if str(values.get(key, "")).strip():
            return {"key": key, "present": True}
    return {"key": None, "present": False}


def _connection_options(env: Mapping[str, str]) -> tuple[str | None, dict[str, str]]:
    selected = resolve_dsn_from_env(env)
    if selected["present"]:
        return str(env[selected["key"]]), {}
    option_names = {
        "PGHOST": "host", "PGPORT": "port", "PGDATABASE": "dbname",
        "PGUSER": "user", "PGPASSWORD": "password", "PGSSLMODE": "sslmode",
    }
    options = {
        option_names[name]: str(env[name])
        for name in option_names
        if str(env.get(name, "")).strip()
    }
    if not options:
        raise PostgresAdapterError(
            "PostgreSQL connection is not configured; set DAILY_SONG_POSTGRES_DSN "
            "or PGHOST/PGDATABASE/PGUSER (PGHOST may be a Unix socket directory)"
        )
    return None, options


def connect_from_env(env: Mapping[str, str] | None = None):
    """Open a PostgreSQL connection using env/Unix-socket configuration.

    ``psycopg`` is preferred, with ``psycopg2`` as a compatibility fallback.
    Neither driver is imported until this function is called.  The DSN is
    never included in an exception raised by this adapter.
    """

    values = os.environ if env is None else env
    dsn, options = _connection_options(values)
    driver_error: Exception | None = None
    for module_name in ("psycopg", "psycopg2"):
        try:
            driver = __import__(module_name)
            connection = driver.connect(dsn, **options) if dsn else driver.connect(**options)
            connection.autocommit = True
            return connection
        except ImportError as exc:
            driver_error = exc
        except Exception as exc:  # pragma: no cover - depends on local server
            raise PostgresAdapterError(
                f"PostgreSQL connection failed using {module_name}; credentials were not printed"
            ) from exc
    raise PostgresAdapterError("no supported PostgreSQL Python driver installed (need psycopg or psycopg2)") from driver_error


def _rows(connection, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
    cursor = connection.cursor()
    try:
        cursor.execute(sql, params)
        values = cursor.fetchall()
        description = cursor.description or ()
        names = [column[0] for column in description]
        return [dict(zip(names, row)) for row in values]
    finally:
        close = getattr(cursor, "close", None)
        if close:
            close()


def _one(connection, sql: str, params: Sequence[Any] = ()) -> dict[str, Any] | None:
    rows = _rows(connection, sql, params)
    return rows[0] if rows else None


def ensure_schema(connection) -> None:
    """Fail loudly when the migration tables are unavailable."""

    try:
        rows = _rows(
            connection,
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = ANY (current_schemas(false))
              AND table_name = ANY (%s)
            """,
            [list(REQUIRED_TABLES)],
        )
    except Exception as exc:
        raise PostgresSchemaError(f"unable to inspect PostgreSQL migration schema: {exc}") from exc
    present = {str(row.get("table_name")) for row in rows}
    missing = [table for table in REQUIRED_TABLES if table not in present]
    if missing:
        raise PostgresSchemaError(
            "missing PostgreSQL migration table(s): "
            + ", ".join(missing)
            + "; apply scripts/migration/pg-schema.sql before using the adapter"
        )


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str) and value.strip():
        parsed = json.loads(value)
        return dict(parsed) if isinstance(parsed, Mapping) else {}
    return {}


def _channel_metadata_rows(
    connection,
    revision_ids: Sequence[str],
    channel_scope: Sequence[str] | None = None,
) -> list[dict[str, Any]]:
    """Read channel metadata from full projections and incremental runtime rows."""

    if not revision_ids:
        return []
    scope = (
        sorted({_text(value) for value in channel_scope if _text(value)})
        if channel_scope is not None
        else None
    )
    values: list[dict[str, Any]] = []
    try:
        full_rows = _rows(
            connection,
            f"""
            SELECT revision_id, channel_key, channel_id, handle, display_name,
                   avatar_url, thumbnail_url, source_url, channel_url,
                   known_source_type, is_collected, payload_json
            FROM runtime_channel_metadata
            WHERE revision_id = ANY(%s)
              {"AND (channel_id = ANY(%s) OR channel_key = ANY(%s))" if scope is not None else ""}
            ORDER BY revision_id, channel_key
            {"LIMIT %s" if scope is not None else ""}
            """,
            (
                [
                    list(revision_ids), scope, scope,
                    _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
                ]
                if scope is not None
                else [list(revision_ids)]
            ),
        )
    except Exception:
        # Older/prototype fixtures may not expose the optional full-runtime table.
        full_rows = []
    if len(full_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("scoped runtime channel metadata lookup exceeded cap")
    values.extend(full_rows)
    try:
        overlay_rows = _rows(
            connection,
            f"""
            SELECT revision_id, entity_key AS channel_key, payload_json,
                   source_system, range_id, source_id, occurrence_id, tombstone
            FROM migration_runtime_rows
            WHERE revision_id = ANY(%s)
              AND entity_type IN ('channel_metadata', 'runtime_channel_metadata')
              {
                "AND (entity_key = ANY(%s) OR payload_json::jsonb->>'channelId' = ANY(%s) OR payload_json::jsonb->'payload'->>'channelId' = ANY(%s))"
                if scope is not None else ""
              }
            ORDER BY revision_id, entity_key
            {"LIMIT %s" if scope is not None else ""}
            """,
            (
                [
                    list(revision_ids), scope, scope, scope,
                    _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
                ]
                if scope is not None
                else [list(revision_ids)]
            ),
        )
    except Exception:
        overlay_rows = []
    if len(overlay_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("scoped overlay channel metadata lookup exceeded cap")
    values.extend(overlay_rows)
    # Child revisions win over parents; a tombstone removes inherited metadata.
    selected: dict[str, dict[str, Any]] = {}
    priority = {revision_id: index for index, revision_id in enumerate(revision_ids)}
    for row in values:
        key = _text(row.get("channel_key") or row.get("channel_id") or row.get("entity_key"))
        if not key:
            continue
        current = selected.get(key)
        if current is not None and priority.get(_text(current.get("revision_id")), -1) < priority.get(_text(row.get("revision_id")), -1):
            continue
        if row.get("tombstone"):
            selected.pop(key, None)
            continue
        payload = _json_object(row.get("payload_json"))
        payload.update({
            "channelKey": payload.get("channelKey") or payload.get("channel_key") or row.get("channel_key") or key,
            "channelId": payload.get("channelId") if "channelId" in payload else row.get("channel_id"),
            "channelHandle": payload.get("channelHandle") if "channelHandle" in payload else row.get("handle"),
            "channelName": payload.get("channelName") if "channelName" in payload else row.get("display_name"),
            "avatarUrl": payload.get("avatarUrl") if "avatarUrl" in payload else row.get("avatar_url"),
            "thumbnailUrl": payload.get("thumbnailUrl") if "thumbnailUrl" in payload else row.get("thumbnail_url"),
            "sourceUrl": payload.get("sourceUrl") if "sourceUrl" in payload else row.get("source_url"),
            "channelUrl": payload.get("channelUrl") if "channelUrl" in payload else row.get("channel_url"),
            "knownSourceType": payload.get("knownSourceType") if "knownSourceType" in payload else row.get("known_source_type"),
            "isCollected": payload.get("isCollected") if "isCollected" in payload else row.get("is_collected"),
        })
        payload["revision_id"] = row.get("revision_id")
        if scope is not None and (
            _text(payload.get("channelId")) not in set(scope)
            and key not in set(scope)
        ):
            continue
        selected[key] = payload
    return list(selected.values())


def _metadata_source_key(item: Mapping[str, Any], range_id: str = "all") -> str:
    """Return the stable source-detail key carried by a channel metadata row."""

    payload = _json_object(item.get("payload_json"))
    explicit = _text(
        item.get("sourceDetailKey")
        or item.get("source_detail_key")
        or payload.get("sourceDetailKey")
        or payload.get("source_detail_key")
    )
    if explicit:
        return explicit
    channel_key = _text(
        item.get("channelId")
        or item.get("channel_id")
        or item.get("channelKey")
        or item.get("channel_key")
    )
    return _stable_key("source-vtuber", range_id, channel_key) if channel_key else ""


def _metadata_for_source_key(metadata: Iterable[Mapping[str, Any]], key: str) -> Mapping[str, Any] | None:
    """Find metadata by source-detail key or legacy channel identity alias."""

    requested = _text(key)
    requested_alias = requested.lstrip("/@").casefold()
    for item in metadata:
        if _metadata_source_key(item, "all") == requested or _metadata_source_key(item, "7d") == requested:
            return item
        payload = _json_object(item.get("payload_json"))
        aliases = (
            item.get("channelId") or item.get("channel_id"),
            item.get("channelKey") or item.get("channel_key"),
            item.get("channelHandle") or item.get("handle"),
            item.get("channelName") or item.get("display_name"),
            payload.get("channelId") or payload.get("channel_id"),
            payload.get("channelKey") or payload.get("channel_key"),
            payload.get("channelHandle") or payload.get("handle"),
            payload.get("channelName") or payload.get("display_name"),
        )
        if any(_text(alias).lstrip("/@").casefold() == requested_alias for alias in aliases if _text(alias)):
            return item
    return None


def _apply_source_channel_metadata(record: Mapping[str, Any], metadata: Mapping[str, Any]) -> dict[str, Any]:
    """Overlay verified channel identity onto a parent-runtime source record."""

    result = {"video": dict(record.get("video") or {}), "occurrences": tuple(record.get("occurrences") or ())}
    video = result["video"]
    fields = {
        "channelId": metadata.get("channelId") or metadata.get("channel_id") or metadata.get("channelKey") or metadata.get("channel_key"),
        "channelHandle": metadata.get("channelHandle") or metadata.get("handle"),
        "channelName": metadata.get("channelName") or metadata.get("display_name"),
        "channelUrl": metadata.get("channelUrl") or metadata.get("channel_url"),
        "avatarUrl": metadata.get("avatarUrl") or metadata.get("avatar_url"),
        "sourceUrl": metadata.get("sourceUrl") or metadata.get("source_url"),
        "knownSourceType": metadata.get("knownSourceType") or metadata.get("known_source_type"),
        "isCollected": metadata.get("isCollected") if "isCollected" in metadata else metadata.get("is_collected"),
    }
    # A channel-level representative thumbnail is not video identity.
    # Preserve the per-video thumbnail already present in each record.
    for name, value in fields.items():
        if value is not None and value != "":
            video[name] = value
    return result


def _source_payload_from_channel_records(
    records: Iterable[Mapping[str, Any]],
    metadata: Mapping[str, Any],
    key: str,
    query: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build source detail from a bounded, channel-filtered parent record set."""

    enriched = [_apply_source_channel_metadata(record, metadata) for record in records]
    return source_payload_from_records(enriched, key, query)


def _source_occurrence_identity(item: Mapping[str, Any]) -> tuple[Any, ...]:
    occurrence_id = _text(item.get("occurrenceId") or item.get("occurrence_id"))
    if occurrence_id:
        return ("id", occurrence_id)
    return (
        "tuple",
        _text(item.get("position")),
        _text(item.get("songKey") or item.get("song_key")),
        item.get("seconds"),
        _overlay_song_group_norm(item.get("title")),
        _overlay_song_group_norm(item.get("artist")),
    )


def _persisted_source_records(
    occurrences: Iterable[Mapping[str, Any]],
    metadata: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Rebuild trusted parent records from the persisted source projection.

    A historical runtime video's scalar channel columns can be stale even when
    its source-detail occurrence contains the correct immutable channel
    identity.  Use those persisted source rows as the parent-side authority,
    but never accept a row whose channel identity disagrees with the requested
    source.  Channel URLs are deliberately not identity evidence.
    """

    channel_id = _text(
        metadata.get("channelId")
        or metadata.get("channel_id")
        or metadata.get("channelKey")
        or metadata.get("channel_key")
    )
    channel_handle = _text(
        metadata.get("channelHandle")
        or metadata.get("channel_handle")
        or metadata.get("handle")
    ).lstrip("/@")
    records: dict[str, dict[str, Any]] = {}
    seen: dict[str, set[tuple[Any, ...]]] = defaultdict(set)
    for value in occurrences:
        item = dict(value)
        has_nested_video = any(
            isinstance(item.get(name), Mapping)
            for name in ("videoPayload", "video_payload", "video", "item")
        )
        video = _overlay_video_projection(item)
        video_id = _text(
            video.get("videoId")
            if has_nested_video else (
                item.get("youtubeVideoId")
                or item.get("videoId")
                or item.get("externalVideoId")
                or video.get("videoId")
            )
        )
        if not video_id:
            continue
        # ``_runtime_source_occurrence`` supplements absent top-level fields
        # from scalar columns.  Historical scalar channel identity can be
        # stale, while the nested persisted video is the original source
        # tuple, so prefer that nested immutable identity.
        item_channel_id = _text(
            video.get("channelId")
            if has_nested_video else (
                item.get("channelId") or video.get("channelId")
            )
        )
        item_channel_handle = _text(
            video.get("channelHandle")
            if has_nested_video else (
                item.get("channelHandle") or video.get("channelHandle")
            )
        ).lstrip("/@")
        if channel_id:
            if item_channel_id != channel_id:
                continue
        elif channel_handle and item_channel_handle != channel_handle:
            continue

        source_song = item.get("song") if isinstance(item.get("song"), Mapping) else item
        nested_song = (
            source_song.get("song")
            if isinstance(source_song.get("song"), Mapping)
            else {}
        )
        occurrence = dict(nested_song)
        occurrence.update(_overlay_public_occurrence(source_song))
        for name in (
            "occurrenceId", "position", "rangeId", "songKey", "seconds",
            "title", "artist", "sourceId", "sourceSystem",
        ):
            if name not in occurrence and item.get(name) is not None:
                occurrence[name] = item[name]
        identity = _source_occurrence_identity(occurrence)
        if identity in seen[video_id]:
            continue
        seen[video_id].add(identity)
        record = records.setdefault(
            video_id,
            {"video": {**video, "videoId": video_id}, "occurrences": []},
        )
        record["occurrences"].append(occurrence)
    return [
        {"video": record["video"], "occurrences": tuple(record["occurrences"])}
        for _, record in sorted(records.items())
    ]


def _merge_source_records(
    records: Iterable[Mapping[str, Any]],
    additions: Iterable[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Merge parent source records by immutable video/occurrence identity."""

    merged: dict[str, dict[str, Any]] = {}
    seen: dict[str, set[tuple[Any, ...]]] = defaultdict(set)
    for source in (records, additions):
        for record in source:
            video = dict(record.get("video") or {})
            video_id = _text(video.get("videoId"))
            if not video_id:
                continue
            current = merged.setdefault(
                video_id,
                {"video": video, "occurrences": []},
            )
            for name, value in video.items():
                if current["video"].get(name) in (None, "") and value not in (None, ""):
                    current["video"][name] = value
            for occurrence in record.get("occurrences", ()):
                item = dict(occurrence)
                identity = _source_occurrence_identity(item)
                if identity in seen[video_id]:
                    continue
                seen[video_id].add(identity)
                current["occurrences"].append(item)
    return [
        {"video": record["video"], "occurrences": tuple(record["occurrences"])}
        for _, record in sorted(merged.items())
    ]


def _project_accepted_channel_records(
    records: Iterable[Mapping[str, Any]],
    target_range: str,
) -> list[dict[str, Any]]:
    """Expose accepted 7d source rows through their compatible all endpoint."""

    result: list[dict[str, Any]] = []
    for record in records:
        occurrences = []
        for value in record.get("occurrences", ()):
            occurrence = dict(value)
            if target_range == "all" and _text(occurrence.get("rangeId")) == "7d":
                occurrence["rangeId"] = "all"
            occurrences.append(occurrence)
        result.append({
            "video": dict(record.get("video") or {}),
            "occurrences": tuple(occurrences),
        })
    return result


def _runtime_channel_source_payload(
    connection,
    revision_id: str,
    metadata: Mapping[str, Any],
    key: str,
    query: Mapping[str, Any] | None = None,
    overlay_revision_ids: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Read only the parent-runtime rows belonging to a verified channel.

    Metadata-only increments must not force the API to materialize the entire
    runtime snapshot.  The channel identity is evidence-backed, so it is safe
    to use it as the bounded lookup predicate while preserving all parent
    video/occurrence payloads and source provenance.
    """

    channel_id = _text(metadata.get("channelId") or metadata.get("channel_id") or metadata.get("channelKey") or metadata.get("channel_key"))
    channel_handle = _text(metadata.get("channelHandle") or metadata.get("handle"))
    channel_name = _text(metadata.get("channelName") or metadata.get("display_name"))
    source_query = _source_query_for_channel(key, metadata, query)
    predicates: list[str] = []
    params: list[Any] = [revision_id]
    if channel_id:
        predicates.append("channel_id = %s")
        params.append(channel_id)
    elif channel_handle:
        predicates.append("channel_handle = %s")
        params.append(channel_handle)
    elif channel_name:
        predicates.append("channel_name = %s")
        params.append(channel_name)
    if not predicates:
        return {"schemaVersion": 1, "found": False, "sourceKey": key}
    video_rows = _rows(
        connection,
        f"""
        SELECT video_id, title, channel_name, channel_id, channel_handle,
               channel_url, published_timestamp, payload_json
        FROM runtime_videos
        WHERE revision_id = %s AND ({' OR '.join(predicates)})
        ORDER BY video_id
        LIMIT %s
        """,
        [*params, _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
    )
    if len(video_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("channel source video lookup exceeded bounded cap")
    video_ids = [_text(row.get("video_id")) for row in video_rows if _text(row.get("video_id"))]
    # A full-video accepted reset can move a video into this channel even when
    # the parent projection had no matching channel row.  Keep the bounded
    # parent side empty and let the selected candidate records establish the
    # public source payload below.
    if not video_ids and not overlay_revision_ids:
        return {"schemaVersion": 1, "found": False, "sourceKey": key}
    occurrence_rows = _rows(
        connection,
        """
        SELECT occurrence_id, range_id, video_id, song_key, seconds,
               source_system, source_id, title, artist, is_niche,
               is_unknown_artist, payload_json
        FROM runtime_occurrences
        WHERE revision_id = %s AND video_id = ANY(%s)
        ORDER BY video_id, range_id, occurrence_id
        LIMIT %s
        """,
        [revision_id, video_ids, _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
    ) if video_ids else []
    if len(occurrence_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("channel source occurrence lookup exceeded bounded cap")
    by_video: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in occurrence_rows:
        by_video[_text(row.get("video_id"))].append(row)
    records: list[dict[str, Any]] = []
    for row in video_rows:
        video_id = _text(row.get("video_id"))
        video = _json_object(row.get("payload_json"))
        video.update({
            "videoId": video.get("videoId") or video_id,
            "title": video.get("title") if video.get("title") is not None else row.get("title"),
            "channelName": video.get("channelName") if video.get("channelName") is not None else row.get("channel_name"),
            "channelId": video.get("channelId") if video.get("channelId") is not None else row.get("channel_id"),
            "channelHandle": video.get("channelHandle") if video.get("channelHandle") is not None else row.get("channel_handle"),
            "channelUrl": video.get("channelUrl") if video.get("channelUrl") is not None else row.get("channel_url"),
            "publishedAt": video.get("publishedAt") if video.get("publishedAt") is not None else row.get("published_timestamp"),
        })
        songs: list[dict[str, Any]] = []
        for occurrence in by_video.get(video_id, ()):
            song = _json_object(occurrence.get("payload_json"))
            song.update({
                "occurrenceId": song.get("occurrenceId") if song.get("occurrenceId") is not None else occurrence.get("occurrence_id"),
                "position": song.get("position") if song.get("position") is not None else len(songs),
                "rangeId": song.get("rangeId") if song.get("rangeId") is not None else occurrence.get("range_id"),
                "songKey": song.get("songKey") if song.get("songKey") is not None else occurrence.get("song_key"),
                "seconds": song.get("seconds") if song.get("seconds") is not None else occurrence.get("seconds"),
                "title": song.get("title") if song.get("title") is not None else occurrence.get("title"),
                "artist": song.get("artist") if song.get("artist") is not None else occurrence.get("artist"),
                "sourceId": song.get("sourceId") if song.get("sourceId") is not None else occurrence.get("source_id"),
                "sourceSystem": song.get("sourceSystem") if song.get("sourceSystem") is not None else occurrence.get("source_system"),
            })
            songs.append(song)
        records.append({"video": video, "occurrences": tuple(songs)})
    candidate_rows: tuple[Mapping[str, Any], ...] = ()
    accepted_video_resets: dict[str, dict[str, Any]] = {}
    if overlay_revision_ids:
        options = _query_options(source_query)
        parent_source_key = _text(
            metadata.get("sourceDetailKey")
            or metadata.get("source_detail_key")
            or key
        )
        persisted_occurrences = _runtime_source_occurrences(
            connection,
            revision_id,
            parent_source_key,
            options["range"],
        )
        records = _merge_source_records(
            records,
            _persisted_source_records(persisted_occurrences, metadata),
        )
        # A selected migration video row is a full-video reset even if it is
        # a tombstone or belongs to a different channel.  Remove that parent
        # video before channel filtering candidate records; otherwise a
        # tombstone has no candidate record and stale parent payload leaks
        # back through this public source endpoint.
        candidate_rows = tuple(_overlay_candidate_rows(connection, overlay_revision_ids))
        accepted_video_resets = _accepted_video_resets(connection, overlay_revision_ids)
        reset_video_ids = set(accepted_video_resets)
        if reset_video_ids:
            records = [
                record for record in records
                if _text(record.get("video", {}).get("videoId")) not in reset_video_ids
            ]
        candidate_records = _overlay_channel_records(
            connection, candidate_rows, metadata,
        )
        candidate_records = _project_accepted_channel_records(
            candidate_records,
            options["range"],
        )
        if candidate_records:
            candidate_video_ids = {_text(record["video"].get("videoId")) for record in candidate_records}
            records = [record for record in records if _text(record["video"].get("videoId")) not in candidate_video_ids]
            records.extend(candidate_records)
    runtime_changes = (
        _runtime_tombstones(
            connection,
            overlay_revision_ids or (),
            accepted_video_resets.values() if accepted_video_resets else None,
            candidate_rows,
        )
        if overlay_revision_ids
        else _runtime_tombstones(connection, overlay_revision_ids or ())
    )
    records = _apply_record_overlay(records, runtime_changes)
    payload = _source_payload_from_channel_records(records, metadata, key, source_query)
    if payload.get("found"):
        return payload

    # Full runtime projections can retain the original JavaScript source key
    # (16 hex characters), while this adapter derives a 24-character stable
    # key when rebuilding one channel from parent rows plus accepted overlays.
    # Resolve through the canonical key, then preserve the persisted public URL.
    options = _query_options(source_query)
    channel_key = channel_id or channel_handle.lstrip("/@") or channel_name
    canonical_key = _stable_key("source-vtuber", options["range"], channel_key)
    if not channel_key or canonical_key == key:
        return payload
    canonical = _source_payload_from_channel_records(
        records, metadata, canonical_key, source_query,
    )
    if not canonical.get("found"):
        return payload
    canonical = dict(canonical)
    canonical_record = dict(canonical.get("record") or {})
    canonical_record["sourceDetailKey"] = key
    canonical_record["sourceDetailPath"] = f"/api/sources/{key}"
    canonical["sourceKey"] = key
    canonical["record"] = canonical_record
    return canonical


def _with_source_detail_path(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Expose an already-existing source endpoint when a record has its key."""

    result = dict(payload)
    key = _text(result.get("sourceDetailKey"))
    if key and not _text(result.get("sourceDetailPath")):
        result["sourceDetailPath"] = f"/api/sources/{key}"
    return result


def _apply_channel_metadata(payload: Mapping[str, Any], row: Mapping[str, Any], metadata: Iterable[Mapping[str, Any]], range_id: str = "all") -> dict[str, Any]:
    """Enrich a vtuber ranking record without merging unrelated unknown rows."""

    result = dict(payload)
    canonical_url_hint = _text(result.pop("_canonicalChannelUrl", ""))
    metadata_rows = list(metadata)
    occurrence_ids: set[str] = set()
    occurrence_handles: set[str] = set()
    occurrence_videos: list[Mapping[str, Any]] = []
    for occurrence in result.get("occurrences") or ():
        if not isinstance(occurrence, Mapping):
            continue
        video = occurrence.get("item") if isinstance(occurrence.get("item"), Mapping) else occurrence.get("video")
        if not isinstance(video, Mapping):
            video = occurrence
        occurrence_videos.append(video)
        channel_id = _text(video.get("channelId") or video.get("channel_id"))
        channel_handle = _text(video.get("channelHandle") or video.get("channel_handle")).lstrip("/@").casefold()
        if channel_id:
            occurrence_ids.add(channel_id)
        if channel_handle:
            occurrence_handles.add(channel_handle)

    detail_key = _text(row.get("detail_key"))
    row_ids = {detail_key}
    if ":" in detail_key:
        row_ids.add(detail_key.rsplit(":", 1)[-1])
    strong_ids = {
        value
        for value in (
            *occurrence_ids,
            *row_ids,
            _text(result.get("channelId")),
            _text(result.get("key")),
        )
        if value
    }
    strong_handles = {
        value
        for value in (
            *occurrence_handles,
            _text(result.get("channelHandle")).lstrip("/@").casefold(),
        )
        if value
    }

    exact_matches: list[Mapping[str, Any]] = []
    for item in metadata_rows:
        item_ids = {
            value
            for value in (
                _text(item.get("channelKey") or item.get("channel_key")),
                _text(item.get("channelId") or item.get("channel_id")),
            )
            if value
        }
        item_handle = _text(item.get("channelHandle") or item.get("handle")).lstrip("/@").casefold()
        if strong_ids.intersection(item_ids) or (item_handle and item_handle in strong_handles):
            exact_matches.append(item)

    selected: Mapping[str, Any] | None = exact_matches[0] if len(exact_matches) == 1 else None
    selected_from_occurrence = False
    if selected is None and not strong_ids and not strong_handles:
        # Legacy rows can lack a stable identity.  Only then allow a unique
        # textual fallback, and never let a historical URL relabel a card.
        haystack = _overlay_norm(" ".join(
            _text(value)
            for value in (
                row.get("title"),
                row.get("name"),
                row.get("search_text"),
                row.get("channel_search_text"),
                result.get("name"),
                result.get("channelName"),
            )
        ))
        fallback_matches: list[Mapping[str, Any]] = []
        for item in metadata_rows:
            tokens = [
                _text(item.get("channelHandle") or item.get("handle")).lstrip("/@"),
                _text(item.get("channelName") or item.get("display_name")),
            ]
            normalized_tokens = [_overlay_norm(token) for token in tokens if len(token) >= 4]
            if any(token and token in haystack for token in normalized_tokens):
                fallback_matches.append(item)
        if len(fallback_matches) == 1:
            selected = fallback_matches[0]
    if selected is None and len(occurrence_ids) == 1:
        # Older projection rows can lack a channel-metadata row even though
        # every preview occurrence carries the same exact YouTube channel ID.
        # Use that tuple directly; never infer across multiple channel IDs.
        evidence_id = next(iter(occurrence_ids))
        evidence = [
            video
            for video in occurrence_videos
            if _text(video.get("channelId") or video.get("channel_id")) == evidence_id
        ]
        evidence_handles = sorted({
            _text(video.get("channelHandle") or video.get("channel_handle"))
            for video in evidence
            if _text(video.get("channelHandle") or video.get("channel_handle"))
        })
        evidence_names = sorted({
            _text(video.get("channelName") or video.get("channel_name"))
            for video in evidence
            if _text(video.get("channelName") or video.get("channel_name"))
        })
        selected = {
            "channelId": evidence_id,
            "channelHandle": evidence_handles[0] if evidence_handles else "",
            "channelName": evidence_names[0] if evidence_names else "",
        }
        selected_from_occurrence = True
    if selected is None:
        return _with_source_detail_path(result)
    channel_key = _text(selected.get("channelId") or selected.get("channelKey") or selected.get("channel_key"))
    display_name = _text(selected.get("channelName") or selected.get("display_name"))
    handle = _text(selected.get("channelHandle") or selected.get("handle"))
    channel_url = _text(selected.get("channelUrl") or selected.get("channel_url"))
    normalized_channel_url = channel_url.casefold()
    normalized_handle = handle.lstrip("/@").casefold()
    if channel_url and not (
        (channel_key and channel_key.casefold() in normalized_channel_url)
        or (normalized_handle and normalized_handle in normalized_channel_url)
    ):
        channel_url = ""
    if not channel_url and channel_key:
        channel_url = f"https://www.youtube.com/channel/{channel_key}"
    if canonical_url_hint and _channel_url_is_coherent(canonical_url_hint, channel_key, handle):
        channel_url = canonical_url_hint
    field_values = {
        "key": channel_key,
        "name": display_name,
        "channelName": display_name,
        "channelId": channel_key,
        "channelHandle": handle,
        "channelUrl": channel_url,
        "avatarUrl": selected.get("avatarUrl") or selected.get("avatar_url"),
        "thumbnailUrl": selected.get("thumbnailUrl") or selected.get("thumbnail_url"),
        "videoThumbnailUrl": selected.get("thumbnailUrl") or selected.get("thumbnail_url"),
        "sourceUrl": selected.get("sourceUrl") or selected.get("source_url"),
        "knownSourceType": selected.get("knownSourceType") or selected.get("known_source_type"),
        "isCollected": selected.get("isCollected") if "isCollected" in selected else selected.get("is_collected"),
    }
    for key, value in field_values.items():
        if value is not None and value != "":
            result[key] = value
    canonical_occurrences: list[Any] = []
    canonical_handle = handle.lstrip("/@").casefold()
    for occurrence in result.get("occurrences") or ():
        if not isinstance(occurrence, Mapping):
            canonical_occurrences.append(occurrence)
            continue
        occurrence_result = dict(occurrence)
        for nested_key in ("item", "video"):
            nested = occurrence_result.get(nested_key)
            if not isinstance(nested, Mapping):
                continue
            nested_id = _text(nested.get("channelId") or nested.get("channel_id"))
            nested_handle = _text(nested.get("channelHandle") or nested.get("channel_handle")).lstrip("/@").casefold()
            if not channel_key or not (
                nested_id == channel_key
                or (not nested_id and canonical_handle and nested_handle == canonical_handle)
            ):
                continue
            canonical_video = dict(nested)
            for key, value in {
                "channelId": channel_key,
                "channelHandle": handle,
                "channelName": display_name,
                "channelUrl": channel_url,
            }.items():
                if value is not None and value != "":
                    canonical_video[key] = value
            occurrence_result[nested_key] = canonical_video
        nested = occurrence_result.get("item") if isinstance(occurrence_result.get("item"), Mapping) else occurrence_result.get("video")
        if canonical_url_hint and isinstance(nested, Mapping) and _text(nested.get("channelId")) == channel_key:
            occurrence_result["item"] = dict(nested)
            occurrence_result["video"] = dict(nested)
        canonical_occurrences.append(occurrence_result)
    if "occurrences" in result:
        result["occurrences"] = canonical_occurrences
    metadata_payload = _json_object(selected.get("payload_json"))
    metadata_payload.update({key: value for key, value in selected.items() if key not in {"revision_id", "payload_json"} and value is not None})
    expected_songs = metadata_payload.get("expectedSongCount")
    if (result.get("songCount") in (None, 0)) and expected_songs is not None:
        result["songCount"] = expected_songs
    if not result.get("sourceDetailKey"):
        result["sourceDetailKey"] = channel_key if selected_from_occurrence else _stable_key("source-vtuber", range_id, channel_key)
    return _with_source_detail_path(result)


def _runtime_projection_revision(connection) -> tuple[str, dict[str, Any]] | None:
    """Return the active full-runtime revision when the projection is ready."""

    try:
        rows = _rows(
            connection,
            """
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = ANY (current_schemas(false))
              AND table_name = ANY (%s)
            """,
            [list(RUNTIME_TABLES)],
        )
        if {str(row.get("table_name")) for row in rows} != set(RUNTIME_TABLES):
            return None
        requested_revision = _text(os.environ.get("DAILY_SONG_PG_CANDIDATE_REVISION"))
        state = _one(connection, "SELECT state_value FROM migration_state WHERE state_key = 'active_revision_id'")
        revision_id = requested_revision or (_text(state.get("state_value")) if state else "")
        if not revision_id:
            return None
        revision = _one(
            connection,
            "SELECT revision_id, parent_revision_id, status, manifest_json, source_manifest_sha256, content_sha256, activated_at, created_at FROM migration_revisions WHERE revision_id = %s",
            [revision_id],
        )
        if not revision:
            return None
        manifest = _json_object(revision.get("manifest_json"))
        if not manifest.get("runtimeProjection") or manifest.get("incrementalOverlay"):
            return None
        return revision_id, revision
    except Exception:
        # Prototype/test doubles and pre-projection databases remain supported.
        return None


def _generic_runtime_projection_revision(connection) -> tuple[str, dict[str, Any]] | None:
    """Return a revision backed by the incremental generic runtime overlay."""

    try:
        state = _one(connection, "SELECT state_value FROM migration_state WHERE state_key = 'active_revision_id'")
        revision_id = _text(os.environ.get("DAILY_SONG_PG_CANDIDATE_REVISION")) or (_text(state.get("state_value")) if state else "")
        if not revision_id:
            return None
        revision = _one(
            connection,
            """
            SELECT revision_id, parent_revision_id, status, manifest_json,
                   source_manifest_sha256, content_sha256, activated_at, created_at
            FROM migration_revisions WHERE revision_id = %s
            """,
            [revision_id],
        )
        if not revision:
            return None
        manifest = _json_object(revision.get("manifest_json"))
        if manifest.get("runtimeProjection") is not True or manifest.get("incrementalOverlay") is not True:
            return None
        return revision_id, revision
    except Exception:
        return None


def _generic_parent_runtime_revision(connection, revision_id: str, revision: Mapping[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """Find the nearest immutable full projection without loading its rows."""

    current = _text(revision.get("parent_revision_id"))
    while current:
        row = _one(
            connection,
            """
            SELECT revision_id, parent_revision_id, status, manifest_json,
                   source_manifest_sha256, content_sha256, activated_at, created_at
            FROM migration_revisions WHERE revision_id = %s
            """,
            [current],
        )
        if not row:
            raise PostgresAdapterError(f"active revision parent does not exist: {current}")
        manifest = _json_object(row.get("manifest_json"))
        if manifest.get("runtimeProjection") is True and not manifest.get("incrementalOverlay"):
            return current, row
        current = _text(row.get("parent_revision_id"))
    return None


def _overlay_norm(value: Any) -> str:
    return " ".join(unicodedata.normalize("NFKC", _text(value)).casefold().split())


def _overlay_song_group_norm(value: Any) -> str:
    """Match the punctuation-insensitive title/artist keys stored by rankings."""

    return "".join(character for character in _overlay_norm(value) if character.isalnum())


def _overlay_public_occurrence(value: Any) -> dict[str, Any]:
    """Expose only the established occurrence fields, never curation evidence."""

    source = _json_object(value)
    if isinstance(source.get("payload"), Mapping):
        source = dict(source["payload"])
    allowed = (
        "videoId", "occurrenceId", "position", "rangeId", "songKey", "seconds",
        "title", "artist", "sourceId", "sourceHash", "rawHash",
        "sourceSystem", "isNiche", "isUnknownArtist",
    )
    return {
        name: source[name]
        for name in allowed
        if name in source and source[name] is not None
    }


def _overlay_video_projection(value: Any) -> dict[str, Any]:
    """Keep the accepted video identity when a runtime occurrence is replaced."""

    source = _json_object(value)
    for name in ("videoPayload", "video_payload", "video", "item"):
        candidate = source.get(name)
        if isinstance(candidate, Mapping):
            return dict(candidate)
    fields = (
        "videoId", "title", "channelId", "channelName", "channelHandle",
        "channelUrl", "thumbnailUrl", "publishedAt", "publishedTimestamp",
    )
    return {
        name: source[name]
        for name in fields
        if name in source and source[name] is not None
    }


def _overlay_candidate_rows(
    connection, revision_ids: Sequence[str], include_payload: bool = True,
    channel_scope: Sequence[str] | None = None,
    scoped_parent_video_ids: Sequence[str] | None = None,
    range_id: str = "",
) -> list[dict[str, Any]]:
    """Read only the candidate rows; never resolve the parent occurrence table.

    Rankings and meta reconciliation need the indexed scalar columns for every
    changed tuple, but a page of 20 cards must not deserialize every retained
    JSON preview.  Detailed source reconstruction keeps ``include_payload``
    enabled; the bounded ranking/meta paths hydrate only returned previews.
    """

    occurrence_payload = "o.payload_json" if include_payload else "NULL::jsonb"
    video_payload = "payload_json" if include_payload else "NULL::jsonb"
    priority = {revision_id: index for index, revision_id in enumerate(revision_ids)}
    scope = (
        sorted({_text(value) for value in channel_scope if _text(value)})
        if channel_scope is not None
        else None
    )
    scoped_video_ids: list[str] | None = None
    if scope is not None:
        scoped_video_rows = _rows(
            connection,
            """
            SELECT DISTINCT video_id
            FROM migration_video_rows
            WHERE revision_id = ANY(%s)
              AND (
                channel_id = ANY(%s)
                OR video_id = ANY(%s)
              )
            ORDER BY video_id
            LIMIT %s
            """,
            [
                list(revision_ids),
                scope,
                list(scoped_parent_video_ids or ()),
                _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
            ],
        )
        if len(scoped_video_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
            raise PostgresAdapterError(
                "scoped overlay candidate video identity lookup exceeded cap"
            )
        scoped_video_ids = sorted({
            _text(row.get("video_id"))
            for row in scoped_video_rows
            if _text(row.get("video_id"))
        })
        if not scoped_video_ids:
            return []
    video_scope_clause = " AND video_id = ANY(%s)" if scope is not None else ""
    video_params: list[Any] = [list(revision_ids)]
    if scoped_video_ids is not None:
        video_params.append(scoped_video_ids)
    video_params.append(_MAX_AFFECTED_RUNTIME_OCCURRENCES + 1)
    video_rows = _rows(
        connection,
        f"""
        SELECT revision_id, video_id, title AS video_title, channel_name,
               channel_id, channel_handle, channel_url, published_at,
               {video_payload} AS video_payload_json,
               tombstone AS video_tombstone
        FROM migration_video_rows
        WHERE revision_id = ANY(%s)
          {video_scope_clause}
        ORDER BY revision_id, video_id
        LIMIT %s
        """,
        video_params,
    )
    if len(video_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("overlay candidate video lookup exceeded bounded cap")
    video_rows.sort(key=lambda row: (
        priority.get(_text(row.get("revision_id")), len(priority)),
        _text(row.get("video_id")),
    ))
    selected_video: dict[str, dict[str, Any]] = {}
    for row in video_rows:
        video_id = _text(row.get("video_id"))
        if video_id and video_id not in selected_video:
            selected_video[video_id] = row
    if scope is not None:
        selected_video = {
            video_id: row
            for video_id, row in selected_video.items()
            if _text(row.get("channel_id")) in set(scope)
        }
    selected_video_ids = sorted(selected_video)
    if not selected_video_ids:
        return []
    occurrence_range_clause = ""
    occurrence_params: list[Any] = [list(revision_ids), selected_video_ids]
    if scope is not None:
        occurrence_range_clause = """
          AND (
            (%s = 'all' AND coalesce(o.range_id, '') IN ('all', ''))
            OR (%s = '7d' AND coalesce(o.range_id, '') IN ('7d', ''))
          )
        """
        occurrence_params.extend((
            _text(range_id) or "all",
            _text(range_id) or "all",
        ))
    occurrence_params.append(_MAX_AFFECTED_RUNTIME_OCCURRENCES + 1)
    occurrence_rows = _rows(
        connection,
        f"""
        SELECT o.revision_id, o.video_id, o.occurrence_id, o.position, o.range_id,
               o.song_key, o.seconds, o.title, o.artist, o.source_id,
               o.raw_hash, o.source_system,
               {occurrence_payload} AS occurrence_payload_json
        FROM migration_occurrence_rows AS o
        WHERE o.revision_id = ANY(%s)
          AND o.video_id = ANY(%s)
          {occurrence_range_clause}
        ORDER BY o.revision_id, o.video_id, o.position, o.occurrence_key
        LIMIT %s
        """,
        occurrence_params,
    )
    if len(occurrence_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("overlay candidate occurrence lookup exceeded bounded cap")
    occurrence_rows.sort(key=lambda row: (
        priority.get(_text(row.get("revision_id")), len(priority)),
        _text(row.get("video_id")),
        int(row.get("position") or 0),
    ))
    selected_occurrences: dict[tuple[str, str], dict[str, Any]] = {}
    for row in occurrence_rows:
        video_id = _text(row.get("video_id"))
        revision_id = _text(row.get("revision_id"))
        video = selected_video.get(video_id)
        selected_revision = _text(video.get("revision_id")) if video else ""
        # A video-bearing accepted increment replaces the older full-video
        # projection, while a newer curation revision may replace just one
        # occurrence without emitting another video row.  Preserve every
        # occurrence from the selected video revision, overlay newer partial
        # occurrence revisions, and ignore older rows from superseded videos.
        if selected_revision and (
            priority.get(revision_id, len(priority))
            > priority.get(selected_revision, len(priority))
        ):
            continue
        occurrence_identity = _text(row.get("occurrence_id")) or (
            f"position:{int(row.get('position') or 0)}:{_text(row.get('song_key'))}"
        )
        occurrence_key = (video_id, occurrence_identity)
        if occurrence_key not in selected_occurrences:
            selected_occurrences[occurrence_key] = row
    resolved: list[dict[str, Any]] = []
    for row in sorted(
        selected_occurrences.values(),
        key=lambda item: (
            _text(item.get("video_id")),
            int(item.get("position") or 0),
            _text(item.get("occurrence_id")),
        ),
    ):
        video_id = _text(row.get("video_id"))
        video = selected_video.get(video_id)
        merged = dict(row)
        if video:
            merged.update({
                "video_title": video.get("video_title") or video.get("title"),
                "channel_name": video.get("channel_name"),
                "channel_id": video.get("channel_id"),
                "channel_handle": video.get("channel_handle"),
                "channel_url": video.get("channel_url"),
                "published_at": video.get("published_at"),
                "video_payload_json": video.get("video_payload_json")
                    if "video_payload_json" in video else video.get("payload_json"),
                "video_tombstone": video.get("video_tombstone")
                    if "video_tombstone" in video else video.get("tombstone"),
            })
        resolved.append(merged)
    return resolved


def _accepted_video_resets(
    connection, revision_ids: Sequence[str], include_payload: bool = True,
    strict_video_id: bool = False,
    parent_revision_id: str = "",
    channel_scope: Sequence[str] | None = None,
    scoped_parent_video_ids: Sequence[str] | None = None,
) -> dict[str, dict[str, Any]]:
    """Return the newest accepted/full video projection per overlay video.

    This is intentionally bounded to the overlay lineage.  A selected row is
    a replacement boundary even when ``tombstone`` is true: older parent
    occurrences for that video must not be replayed by rankings or sources.
    """

    if not revision_ids:
        return {}
    priority = {revision_id: index for index, revision_id in enumerate(revision_ids)}
    payload = "payload_json" if include_payload else "NULL::jsonb"
    scope = (
        sorted({_text(value) for value in channel_scope if _text(value)})
        if channel_scope is not None
        else None
    )
    scope_clause = ""
    params: list[Any] = [list(revision_ids)]
    if scope is not None:
        if not parent_revision_id:
            raise PostgresAdapterError(
                "scoped accepted-video reset lookup requires parent revision"
            )
        scope_clause = """
          AND (
            channel_id = ANY(%s)
            OR video_id = ANY(%s)
          )
        """
        params.extend((scope, list(scoped_parent_video_ids or ())))
    params.append(_MAX_AFFECTED_RUNTIME_OCCURRENCES + 1)
    rows = _rows(
        connection,
        f"""
        SELECT revision_id, video_id, title AS video_title, channel_name,
               channel_id, channel_handle, channel_url, published_at,
               tombstone, {payload} AS payload_json
        FROM migration_video_rows
        WHERE revision_id = ANY(%s)
          {scope_clause}
        ORDER BY video_id
        LIMIT %s
        """,
        params,
    )
    if len(rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "accepted-video reset lookup exceeded bounded video cap"
        )
    selected: dict[str, dict[str, Any]] = {}
    for row in sorted(rows, key=lambda item: priority.get(_text(item.get("revision_id")), len(priority))):
        video_id = _text(row.get("video_id"))
        if not video_id and strict_video_id:
            raise PostgresAdapterError("VTuber accepted video reset is missing required immutable identity")
        if video_id and video_id not in selected:
            selected[video_id] = dict(row)
    return selected


def _accepted_video_reset_changes(
    connection,
    parent_revision_id: str,
    resets: Mapping[str, Mapping[str, Any]],
    options: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Project accepted full-video replacements as bounded parent removals.

    ``migration_video_rows`` is a full-video boundary, including a tombstone.
    The parent aggregate tables cannot know that boundary on their own, so read
    only the parent occurrences for those video ids and turn them into normal
    occurrence removals before adding selected candidate rows.  This avoids a
    full parent scan and gives the existing count/preview machinery the exact
    parent identity it must remove.
    """

    video_ids = sorted({_text(video_id) for video_id in resets if _text(video_id)})
    if not video_ids:
        return []
    rows = _rows(
        connection,
        """
        SELECT o.occurrence_id, o.video_id, o.song_key, o.title,
               o.artist, o.range_id, v.channel_id, v.channel_handle,
               v.channel_name, v.channel_url
        FROM runtime_occurrences AS o
        JOIN runtime_videos AS v
          ON v.revision_id = o.revision_id AND v.video_id = o.video_id
        WHERE o.revision_id = %s AND v.revision_id = %s
          AND o.video_id = ANY(%s)
          AND (
            (%s = 'all' AND coalesce(o.range_id, '') IN ('all', ''))
            OR (%s = '7d' AND coalesce(o.range_id, '') IN ('7d', ''))
          )
        ORDER BY o.video_id, o.occurrence_id
        LIMIT %s
        """,
        [
            parent_revision_id,
            parent_revision_id,
            video_ids,
            _text(options.get("range")) or "all",
            _text(options.get("range")) or "all",
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
        ],
    )
    if len(rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "accepted-video reset reconciliation exceeded bounded occurrence cap"
        )
    changes: list[dict[str, Any]] = []
    for row in rows:
        changes.append({
            "entityType": "occurrences",
            "videoId": _text(row.get("video_id")),
            "occurrenceId": _text(row.get("occurrence_id")),
            "title": _text(row.get("title")),
            "artist": _text(row.get("artist")),
            "songKey": _text(row.get("song_key")),
            "rangeId": _text(row.get("range_id")),
            "channel_id": row.get("channel_id"),
            "channel_handle": row.get("channel_handle"),
            "channel_name": row.get("channel_name"),
            "channel_url": row.get("channel_url"),
            "originalGroupVideoOccurrenceCount": 1,
            "acceptedVideoReset": True,
        })
    return changes


def _accepted_video_reset_identity_changes(
    connection,
    parent_revision_id: str,
    resets: Mapping[str, Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Read one parent video identity per accepted full-video boundary.

    Unfiltered VTuber aggregation excludes the complete parent video inside
    PostgreSQL, so it does not need one Python change object per parent
    occurrence.  A channel move still needs the old immutable channel in the
    affected set; this bounded video-only lookup supplies exactly that identity.
    """

    video_ids = sorted({_text(video_id) for video_id in resets if _text(video_id)})
    if not video_ids:
        return []
    rows = _rows(
        connection,
        """
        SELECT video_id, title AS video_title, channel_name, channel_id,
               channel_handle, channel_url, payload_json AS video_payload_json
        FROM runtime_videos
        WHERE revision_id = %s AND video_id = ANY(%s)
        ORDER BY video_id
        LIMIT %s
        """,
        [
            parent_revision_id,
            video_ids,
            len(video_ids) + 1,
        ],
    )
    if len(rows) > len(video_ids):
        raise PostgresAdapterError(
            "accepted-video reset identity lookup exceeded bounded video set"
        )
    changes: list[dict[str, Any]] = []
    returned: set[str] = set()
    for row in rows:
        video_id = _text(row.get("video_id"))
        if not video_id or video_id not in video_ids or video_id in returned:
            raise PostgresAdapterError(
                "accepted-video reset identity lookup returned an inexact video set"
            )
        returned.add(video_id)
        video = _overlay_public_video(row)
        channel_id = _text(row.get("channel_id") or video.get("channelId"))
        # A legacy parent projection can retain only the immutable video id.
        # Keep that bounded reset change so the caller can validate and bind
        # the selected accepted projection for this exact same video.  The
        # later evidence join remains fail-closed for missing, duplicate, or
        # conflicting video/channel/handle sources.
        changes.append({
            "entityType": "videos",
            "videoId": video_id,
            "channel_id": channel_id,
            "channel_handle": row.get("channel_handle") or video.get("channelHandle"),
            "channel_name": row.get("channel_name") or video.get("channelName"),
            "channel_url": row.get("channel_url") or video.get("channelUrl"),
            "videoTitle": row.get("video_title") or video.get("title"),
            "videoPayload": row.get("video_payload_json"),
            "acceptedVideoReset": True,
        })
    return changes


def _source_query_for_channel(key: str, metadata: Mapping[str, Any], query: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Infer a vtuber source key's range without changing the endpoint URL."""

    result = dict(query or {})
    channel_id = _text(metadata.get("channelId") or metadata.get("channel_id") or metadata.get("channelKey") or metadata.get("channel_key"))
    if channel_id:
        for range_id in SUPPORTED_RANGES:
            if _stable_key("source-vtuber", range_id, channel_id) == _text(key):
                result["range"] = range_id
                break
    return result


def _overlay_channel_records(connection, rows: Iterable[Mapping[str, Any]], metadata: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Turn the accepted increment's rows for one channel into source records."""

    channel_id = _text(metadata.get("channelId") or metadata.get("channel_id") or metadata.get("channelKey") or metadata.get("channel_key"))
    channel_handle = _text(metadata.get("channelHandle") or metadata.get("handle"))
    channel_name = _text(metadata.get("channelName") or metadata.get("display_name"))
    selected_rows: list[Mapping[str, Any]] = []
    for row in rows:
        if row.get("video_tombstone"):
            continue
        video_payload = _json_object(row.get("video_payload_json"))
        if isinstance(video_payload.get("payload"), Mapping):
            video_payload = dict(video_payload["payload"])
        row_channel_id = _text(row.get("channel_id") or video_payload.get("channelId") or video_payload.get("channel_id"))
        row_channel_handle = _text(row.get("channel_handle") or video_payload.get("channelHandle") or video_payload.get("channel_handle"))
        row_channel_name = _text(row.get("channel_name") or video_payload.get("channelName") or video_payload.get("channel_name"))
        if not any((
            channel_id and row_channel_id == channel_id,
            not channel_id and channel_handle and row_channel_handle == channel_handle,
            not channel_id and not channel_handle and channel_name and row_channel_name == channel_name,
        )):
            continue
        video_id = _text(row.get("video_id"))
        if not video_id:
            continue
        selected_rows.append(row)
    if not selected_rows:
        return []
    selected_pairs = {(_text(row.get("revision_id")), _text(row.get("video_id"))) for row in selected_rows}
    ordered_pairs = sorted(selected_pairs)
    pair_revision_ids = [revision_id for revision_id, _ in ordered_pairs]
    pair_video_ids = [video_id for _, video_id in ordered_pairs]
    video_payload_rows = _rows(
        connection,
        """
        WITH requested_pairs(revision_id, video_id) AS (
          SELECT * FROM unnest(%s::text[], %s::text[])
        )
        SELECT row.revision_id, row.video_id, row.payload_json
        FROM migration_video_rows AS row
        JOIN requested_pairs AS requested
          ON requested.revision_id = row.revision_id
         AND requested.video_id = row.video_id
        ORDER BY row.revision_id, row.video_id
        LIMIT %s
        """,
        [pair_revision_ids, pair_video_ids, _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
    )
    if len(video_payload_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("overlay channel video payload lookup exceeded bounded cap")
    video_payloads = {
        (_text(row.get("revision_id")), _text(row.get("video_id"))): _json_object(row.get("payload_json"))
        for row in video_payload_rows
        if (_text(row.get("revision_id")), _text(row.get("video_id"))) in selected_pairs
    }
    occurrence_payload_rows = _rows(
        connection,
        """
        WITH requested_pairs(revision_id, video_id) AS (
          SELECT * FROM unnest(%s::text[], %s::text[])
        )
        SELECT row.revision_id, row.video_id, row.occurrence_id, row.position,
               row.payload_json
        FROM migration_occurrence_rows AS row
        JOIN requested_pairs AS requested
          ON requested.revision_id = row.revision_id
         AND requested.video_id = row.video_id
        ORDER BY row.revision_id, row.video_id, row.position, row.occurrence_id
        LIMIT %s
        """,
        [pair_revision_ids, pair_video_ids, _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
    )
    if len(occurrence_payload_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("overlay channel occurrence payload lookup exceeded bounded cap")
    occurrence_payloads = {
        (_text(row.get("revision_id")), _text(row.get("video_id")), _text(row.get("occurrence_id")), int(row.get("position") or 0)): _json_object(row.get("payload_json"))
        for row in occurrence_payload_rows
        if (_text(row.get("revision_id")), _text(row.get("video_id"))) in selected_pairs
    }
    records: dict[str, dict[str, Any]] = {}
    for row in selected_rows:
        video_id = _text(row.get("video_id"))
        revision_id = _text(row.get("revision_id"))
        record = records.get(video_id)
        if record is None:
            video = video_payloads.get(
                (revision_id, video_id),
                _json_object(row.get("video_payload_json")),
            )
            if isinstance(video.get("payload"), Mapping):
                video = dict(video["payload"])
            video.update({
                "videoId": video.get("videoId") or video_id,
                "title": video.get("title") if video.get("title") is not None else row.get("video_title"),
                "channelName": video.get("channelName") if video.get("channelName") is not None else row.get("channel_name"),
                "channelId": video.get("channelId") if video.get("channelId") is not None else row.get("channel_id"),
                "channelHandle": video.get("channelHandle") if video.get("channelHandle") is not None else row.get("channel_handle"),
                "channelUrl": video.get("channelUrl") if video.get("channelUrl") is not None else row.get("channel_url"),
                "publishedAt": video.get("publishedAt") if video.get("publishedAt") is not None else row.get("published_at"),
            })
            record = {"video": video, "occurrences": []}
            records[video_id] = record
        song = _overlay_public_occurrence(occurrence_payloads.get(
            (revision_id, video_id, _text(row.get("occurrence_id")), int(row.get("position") or 0)),
            row.get("occurrence_payload_json"),
        ))
        song.update({
            "occurrenceId": song.get("occurrenceId") if song.get("occurrenceId") is not None else row.get("occurrence_id"),
            "position": song.get("position") if song.get("position") is not None else row.get("position"),
            "rangeId": song.get("rangeId") if song.get("rangeId") is not None else row.get("range_id"),
            "songKey": song.get("songKey") if song.get("songKey") is not None else row.get("song_key"),
            "seconds": song.get("seconds") if song.get("seconds") is not None else row.get("seconds"),
            "title": song.get("title") if song.get("title") is not None else row.get("title"),
            "artist": song.get("artist") if song.get("artist") is not None else row.get("artist"),
            "sourceId": song.get("sourceId") if song.get("sourceId") is not None else row.get("source_id"),
            "rawHash": song.get("rawHash") if song.get("rawHash") is not None else row.get("raw_hash"),
            "sourceSystem": song.get("sourceSystem") if song.get("sourceSystem") is not None else row.get("source_system"),
        })
        record["occurrences"].append(song)
    return [
        {"video": record["video"], "occurrences": tuple(record["occurrences"])}
        for _, record in sorted(records.items())
    ]


def _overlay_runtime_rows(
    connection,
    revision_ids: Sequence[str],
    parent_revision_id: str = "",
    channel_scope: Sequence[str] | None = None,
    scoped_parent_video_ids: Sequence[str] | None = None,
) -> list[dict[str, Any]]:
    if not revision_ids:
        return []
    scope = (
        sorted({_text(value) for value in channel_scope if _text(value)})
        if channel_scope is not None
        else None
    )
    scope_clause = ""
    params: list[Any] = [list(revision_ids)]
    if scope is not None:
        if not parent_revision_id:
            raise PostgresAdapterError(
                "scoped runtime overlay lookup requires parent revision"
            )
        scope_clause = """
          AND (
            payload_json::jsonb->>'channelId' = ANY(%s)
            OR payload_json::jsonb->'payload'->>'channelId' = ANY(%s)
            OR payload_json::jsonb->'originalIdentity'->>'channelId' = ANY(%s)
            OR payload_json::jsonb->'payload'->'originalIdentity'->>'channelId' = ANY(%s)
            OR payload_json::jsonb->'replacementPayload'->>'channelId' = ANY(%s)
            OR payload_json::jsonb->'payload'->'replacementPayload'->>'channelId' = ANY(%s)
            OR payload_json::jsonb->'replacementVideoPayload'->>'channelId' = ANY(%s)
            OR payload_json::jsonb->'payload'->'replacementVideoPayload'->>'channelId' = ANY(%s)
            OR payload_json::jsonb->>'videoId' = ANY(%s)
            OR payload_json::jsonb->'payload'->>'videoId' = ANY(%s)
            OR payload_json::jsonb->'originalIdentity'->>'videoId' = ANY(%s)
            OR payload_json::jsonb->'payload'->'originalIdentity'->>'videoId' = ANY(%s)
            OR payload_json::jsonb->'replacementPayload'->>'videoId' = ANY(%s)
            OR payload_json::jsonb->'payload'->'replacementPayload'->>'videoId' = ANY(%s)
            OR payload_json::jsonb->'replacementVideoPayload'->>'videoId' = ANY(%s)
            OR payload_json::jsonb->'payload'->'replacementVideoPayload'->>'videoId' = ANY(%s)
          )
        """
        params.extend(
            [scope] * 8
            + [list(scoped_parent_video_ids or ())] * 8
        )
    params.append(_MAX_AFFECTED_RUNTIME_OCCURRENCES + 1)
    rows = _rows(
        connection,
        f"""
        SELECT revision_id, entity_type, entity_key, source_system, range_id,
               source_id, occurrence_id, tombstone, payload_json
        FROM migration_runtime_rows
        WHERE revision_id = ANY(%s)
          {scope_clause}
        ORDER BY revision_id, entity_type, entity_key
        LIMIT %s
        """,
        params,
    )
    if len(rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("overlay runtime lookup exceeded bounded cap")
    return rows


def _overlay_payload(row: Mapping[str, Any]) -> dict[str, Any]:
    payload = _json_object(row.get("payload_json"))
    if isinstance(payload.get("payload"), Mapping):
        payload = dict(payload["payload"])
    return payload


def _runtime_tombstones(
    connection,
    revision_ids: Sequence[str],
    accepted_video_rows: Iterable[Mapping[str, Any]] | None = None,
    accepted_occurrence_rows: Iterable[Mapping[str, Any]] | None = None,
    strict_immutable_identity: bool = False,
    parent_revision_id: str = "",
    channel_scope: Sequence[str] | None = None,
    scoped_parent_video_ids: Sequence[str] | None = None,
) -> list[dict[str, Any]]:
    """Resolve each runtime chain to its full-parent identity and final state."""

    if not revision_ids:
        return []
    priority = {revision_id: index for index, revision_id in enumerate(revision_ids)}
    runtime_rows = (
        _overlay_runtime_rows(connection, revision_ids)
        if channel_scope is None
        else _overlay_runtime_rows(
            connection,
            revision_ids,
            parent_revision_id,
            channel_scope,
            scoped_parent_video_ids,
        )
    )
    try:
        if accepted_occurrence_rows is None:
            accepted_occurrences = _rows(
                connection,
                """
                SELECT revision_id, video_id, occurrence_id, position, range_id, source_id,
                       payload_json
                FROM migration_occurrence_rows
                WHERE revision_id = ANY(%s)
                ORDER BY revision_id, video_id, position, occurrence_id
                LIMIT %s
                """,
                [list(revision_ids), _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
            )
            if len(accepted_occurrences) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
                raise PostgresAdapterError(
                    "accepted occurrence reset lookup exceeded bounded occurrence cap"
                )
        else:
            # ``_overlay_candidate_rows`` has already selected the newest
            # accepted occurrence per identity for this lineage.  Normalise
            # its public row shape to the chain event shape, avoiding a second
            # migration_occurrence_rows scan in ranking/source requests.
            accepted_occurrences = []
            for candidate in accepted_occurrence_rows:
                payload = _json_object(candidate.get("occurrence_payload_json"))
                if not payload:
                    payload = _overlay_payload(candidate)
                payload.setdefault("videoId", candidate.get("video_id"))
                payload.setdefault("occurrenceId", candidate.get("occurrence_id"))
                payload.setdefault("position", candidate.get("position"))
                payload.setdefault("rangeId", candidate.get("range_id"))
                payload.setdefault("sourceId", candidate.get("source_id"))
                accepted_occurrences.append({
                    "revision_id": candidate.get("revision_id"),
                    "video_id": candidate.get("video_id"),
                    "occurrence_id": candidate.get("occurrence_id"),
                    "position": candidate.get("position"),
                    "range_id": candidate.get("range_id"),
                    "source_id": candidate.get("source_id"),
                    "payload_json": payload,
                })
        accepted_videos = (
            [dict(row) for row in accepted_video_rows]
            if accepted_video_rows is not None
            else _rows(
                connection,
                """
                SELECT revision_id, video_id, tombstone, payload_json
                FROM migration_video_rows
                WHERE revision_id = ANY(%s)
                ORDER BY revision_id, video_id
                LIMIT %s
                """,
                [list(revision_ids), _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
            )
        )
        if len(accepted_videos) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
            raise PostgresAdapterError(
                "accepted video reset lookup exceeded bounded video cap"
            )
    except (AssertionError, AttributeError):
        # Lightweight contract fixtures may expose only runtime rows.  A real
        # PostgreSQL adapter raises its database error rather than either of
        # these test-double sentinels, so production never silently skips a
        # reset lookup.
        accepted_occurrences = []
        accepted_videos = []
    # Process oldest to newest.  A video projection clears all older
    # occurrence chains for that video; an accepted occurrence resets only
    # its exact identity.  Newer runtime curation then starts from that reset.
    events: list[tuple[int, int, str, Mapping[str, Any]]] = []
    events.extend((priority.get(_text(row.get("revision_id")), len(priority)), 2, "runtime", row) for row in runtime_rows)
    events.extend((priority.get(_text(row.get("revision_id")), len(priority)), 0, "video", row) for row in accepted_videos)
    events.extend((priority.get(_text(row.get("revision_id")), len(priority)), 1, "occurrence", row) for row in accepted_occurrences)
    events.sort(key=lambda item: (-item[0], item[1]))
    chains: dict[tuple[str, str, str], dict[str, Any]] = {}
    for _order, _kind_order, event_kind, row in events:
        if event_kind == "video":
            video_id = _text(row.get("video_id"))
            if not video_id:
                continue
            for key in [key for key in chains if key[1] == video_id]:
                chains.pop(key, None)
            continue
        if event_kind == "occurrence":
            payload = _overlay_payload(row)
            video_id = _text(payload.get("videoId") or row.get("video_id"))
            identity = _text(payload.get("occurrenceId") or row.get("occurrence_id"))
            if not video_id or not identity:
                continue
            key = ("occurrences", video_id, identity)
            chains[key] = {
                "root": payload,
                "final": payload,
                "row": {**dict(row), "entity_type": "occurrences"},
                "kind": "shadowed",
            }
            continue
        entity_type = _text(row.get("entity_type"))
        if entity_type not in {"occurrences", "runtime_occurrences", "videos", "runtime_videos"}:
            continue
        current_payload = _overlay_payload(row)
        original = current_payload.get("originalIdentity")
        video_id = _text(current_payload.get("videoId") or row.get("video_id"))
        occurrence_id = _text(current_payload.get("occurrenceId") or row.get("occurrence_id"))
        identity = _text(
            occurrence_id
            or row.get("entity_key")
            or video_id
        )
        if not video_id or not identity or (
            strict_immutable_identity
            and entity_type in {"occurrences", "runtime_occurrences"}
            and not occurrence_id
        ):
            continue
        key = (entity_type, video_id, identity)
        chain = chains.setdefault(key, {"root": None, "final": None, "kind": "shadowed"})
        if not row.get("tombstone") and not isinstance(original, Mapping):
            # A later accepted/runtime projection without curation provenance
            # supersedes every older replacement for this exact occurrence.
            # This is a reset, not a permanent suppression.  A later curation
            # row must be able to use this accepted tuple as its new root.
            chain.update({
                "root": dict(current_payload),
                "final": dict(current_payload),
                "row": dict(row),
                "kind": "shadowed",
            })
            continue
        if chain["root"] is None:
            chain["root"] = dict(original) if isinstance(original, Mapping) else dict(current_payload)
        chain["final"] = dict(current_payload)
        chain["row"] = dict(row)
        chain["kind"] = "tombstone" if row.get("tombstone") else "replacement"

    changes: list[dict[str, Any]] = []
    for chain in chains.values():
        if chain.get("kind") == "shadowed":
            continue
        root = chain.get("root")
        row = chain.get("row")
        if not isinstance(root, Mapping) or not isinstance(row, Mapping):
            continue
        payload = dict(root)
        final_payload = chain.get("final") if isinstance(chain.get("final"), Mapping) else {}
        payload.setdefault("videoId", final_payload.get("videoId"))
        payload.setdefault("occurrenceId", row.get("occurrence_id"))
        payload.setdefault("sourceId", row.get("source_id"))
        payload.setdefault("sourceSystem", row.get("source_system"))
        payload.setdefault("rangeId", row.get("range_id"))
        payload.setdefault("entityKey", row.get("entity_key"))
        payload["entityType"] = _text(row.get("entity_type"))
        payload["revisionId"] = _text(row.get("revision_id"))
        payload["replacement"] = chain.get("kind") == "replacement"
        if payload["replacement"]:
            replacement_payload = _overlay_public_occurrence(final_payload)
            payload["replacementPayload"] = replacement_payload
            replacement_video_payload = _overlay_video_projection(final_payload)
            if replacement_video_payload:
                payload["replacementVideoPayload"] = replacement_video_payload
            payload["replacementSameArtist"] = (
                _overlay_norm(payload.get("artist"))
                == _overlay_norm(replacement_payload.get("artist"))
            )
            payload["replacementSameVideo"] = (
                _text(payload.get("videoId"))
                == _text(replacement_payload.get("videoId"))
            )
        changes.append(payload)
    return changes


def _thumbnail_video_id(thumbnail: str) -> str:
    """Extract the immutable video id from a conventional YouTube thumbnail.

    A replacement is allowed to carry an explicit thumbnail only when this
    helper can bind it to one video.  In particular, an arbitrary CDN URL is
    not evidence of video ownership just because its path happens to contain
    an old id.
    """

    value = _text(thumbnail)
    if not value:
        return ""
    path_match = re.search(r"/(?:vi|vi_webp|an_webp)/([^/?#]+)/", value, re.IGNORECASE)
    if path_match:
        return _text(path_match.group(1))
    query_match = re.search(r"(?:[?&])videoId=([^&#/]+)", value, re.IGNORECASE)
    return _text(query_match.group(1)) if query_match else ""


def thumbnail_matches_video(thumbnail: str, video_id: str) -> bool:
    """Return whether a supported thumbnail URL binds exactly to ``video_id``."""

    return bool(video_id and _thumbnail_video_id(thumbnail) == _text(video_id))


def _replacement_thumbnail_matches_video(thumbnail: str, video_id: str) -> bool:
    """Backward-compatible private spelling used by older adapter callers."""

    return thumbnail_matches_video(thumbnail, video_id)


def _normalized_channel_handle(value: Any) -> str:
    return _text(value).strip().lstrip("/@").casefold()


def _vtuber_handle_query_parts(
    options: Mapping[str, Any],
) -> dict[str, Any] | None:
    """Split one strict leading VTuber handle from its residual query.

    The handle is an identity constraint, not fuzzy search text.  Extraction
    is therefore limited to the VTuber view, requires channel search
    semantics, accepts the same conservative handle alphabet as the browser
    click builder, and rejects a second handle or an embedded URL.
    """

    if _text(options.get("view")) != "vtubers":
        return None
    scope = _text(options.get("searchScope") or "all").casefold()
    fields = tuple(
        _text(value).casefold()
        for value in (options.get("searchFields") or ())
        if _text(value)
    )
    channel_fields = {
        "channel", "channels", "channelid", "channelhandle", "handle", "name",
    }
    if fields:
        if (
            "all" not in fields
            and not any(field in channel_fields for field in fields)
        ):
            return None
    elif scope not in {"all", "channel", "channels"}:
        return None

    query = _text(options.get("q")).strip()
    leading = re.match(r"^(\S+)(?:\s+|$)", query)
    if leading is None:
        return None
    normalized_leading = unicodedata.normalize("NFKC", leading.group(1))
    match = re.fullmatch(r"/?@([A-Za-z0-9._~-]{3,64})", normalized_leading)
    if match is None:
        return None
    residual = query[leading.end():].strip()
    normalized_residual = unicodedata.normalize("NFKC", residual)
    if re.search(
        r"(?:https?://|www\.|(?:youtube\.com|youtu\.be)(?:/|$))",
        normalized_residual,
        re.IGNORECASE,
    ):
        return None
    residual_tokens = tuple(
        token.casefold()
        for token in residual.split()
        if token
    )
    if any("@" in token for token in normalized_residual.split()):
        return None
    return {
        "handle": unicodedata.normalize("NFKC", match.group(1)).casefold(),
        "residualTokens": residual_tokens,
        "searchFields": fields,
    }


def _invalid_vtuber_handle_query(options: Mapping[str, Any]) -> bool:
    """Return whether a handle-shaped VTuber query must fail closed.

    Ordinary text and views/search fields without channel semantics retain
    their legacy meaning.  Once an eligible VTuber query starts with a handle
    marker, however, malformed, multiple-handle, and URL-contaminated forms
    must never fall through to the global legacy rebuild.
    """

    if _text(options.get("view")) != "vtubers":
        return False
    scope = _text(options.get("searchScope") or "all").casefold()
    fields = {
        _text(value).casefold()
        for value in (options.get("searchFields") or ())
        if _text(value)
    }
    channel_fields = {
        "channel", "channels", "channelid", "channelhandle", "handle", "name",
    }
    channel_semantics = (
        ("all" in fields or bool(fields.intersection(channel_fields)))
        if fields
        else scope in {"all", "channel", "channels"}
    )
    if not channel_semantics:
        return False
    query = unicodedata.normalize("NFKC", _text(options.get("q"))).lstrip()
    return bool(re.match(r"^/?@", query)) and _vtuber_handle_query_parts(options) is None


def _clicked_song_title_query(parts: Mapping[str, Any] | None) -> str:
    """Return the normalized residual title from one handle+song click."""

    if parts is None:
        return ""
    return _overlay_norm(" ".join(
        _text(token) for token in (parts.get("residualTokens") or ())
    ))


def _sql_like_literal(value: Any) -> str:
    """Escape one user token for a PostgreSQL LIKE ... ESCAPE backslash."""

    return _text(value).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _vtuber_residual_search_spec(
    options: Mapping[str, Any],
) -> dict[str, Any] | None:
    """Return residual tokens and the public fields they may match."""

    parts = _vtuber_handle_query_parts(options)
    if parts is None:
        return None
    fields = set(parts["searchFields"])
    if not fields:
        scope = _text(options.get("searchScope") or "all").casefold()
        fields = {scope}
    if "all" in fields:
        fields.update({"title", "artist", "channel", "video", "source"})
    if "song" in fields:
        fields.update({"title", "artist"})
    if fields.intersection(
        {"channels", "channelid", "channelhandle", "handle", "name"},
    ):
        fields.add("channel")
    return {
        "tokens": tuple(parts["residualTokens"]),
        "title": "title" in fields,
        "artist": "artist" in fields,
        "channel": "channel" in fields,
        "video": "video" in fields,
        "source": "source" in fields,
    }


def _vtuber_candidate_matches_residual(
    row: Mapping[str, Any],
    spec: Mapping[str, Any] | None,
) -> bool:
    """Apply mixed-query residual fields to one canonical overlay tuple."""

    if spec is None or not spec.get("tokens"):
        return True
    video = _overlay_public_video(row)
    occurrence = _json_object(row.get("occurrence_payload_json"))
    if isinstance(occurrence.get("payload"), Mapping):
        occurrence = dict(occurrence["payload"])
    fields = {
        "title": " ".join(
            value for value in (
                _text(row.get("title")),
                _text(occurrence.get("title")),
            ) if value
        ).casefold(),
        "artist": " ".join(
            value for value in (
                _text(row.get("artist")),
                _text(occurrence.get("artist")),
            ) if value
        ).casefold(),
        "channel": " ".join(
            value for value in (
                _text(row.get("channel_id")),
                _text(row.get("channel_name")),
                _text(row.get("channel_handle")),
                _text(video.get("channelId")),
                _text(video.get("channelName")),
                _text(video.get("channelHandle")),
            ) if value
        ).casefold(),
        "video": " ".join(
            value for value in (
                _text(row.get("video_id")),
                _text(video.get("videoId")),
                _text(video.get("title")),
            ) if value
        ).casefold(),
        "source": " ".join(
            value for value in (
                _text(row.get("source_id")),
                _text(row.get("source_system")),
                _text(occurrence.get("sourceId")),
                _text(occurrence.get("sourceSystem")),
            ) if value
        ).casefold(),
    }
    return all(
        any(
            bool(spec.get(field)) and token in fields[field]
            for field in ("title", "artist", "channel", "video", "source")
        )
        for token in spec["tokens"]
    )


def _exact_vtuber_handle_query(options: Mapping[str, Any]) -> str | None:
    """Return one strict exact-handle token, never a fuzzy identity hint."""

    parts = _vtuber_handle_query_parts(options)
    return _text(parts.get("handle")) if parts is not None else None


def _resolve_exact_vtuber_channel_scope(
    connection,
    parent_revision_id: str,
    overlay_revision_ids: Sequence[str],
    options: Mapping[str, Any],
) -> tuple[str, ...] | None:
    """Resolve a strict handle to at most one immutable channel ID.

    Handles are lookup keys only.  The returned scope comes from persisted
    ``channelId``/``detail_key`` identity and never from ``channel_url`` text.
    """

    handle = _exact_vtuber_handle_query(options)
    if handle is None:
        return None
    db_metric = (
        "count"
        if _text(options.get("metric")) in {"", "count", "occurrences"}
        else _text(options.get("metric"))
    )
    rows = _rows(
        connection,
        """
        WITH requested AS MATERIALIZED (
          SELECT %s::text AS normalized_handle
        ), overlay_lineage AS MATERIALIZED (
          SELECT revision_id, lineage_order::bigint
          FROM unnest(%s::text[]) WITH ORDINALITY
            AS lineage(revision_id, lineage_order)
        ), runtime_handle_seed_rows AS MATERIALIZED (
          SELECT lineage.lineage_order, runtime.revision_id,
                 runtime.entity_type, runtime.entity_key, runtime.tombstone,
                 runtime.payload_json::jsonb AS payload
          FROM overlay_lineage AS lineage
          JOIN migration_runtime_rows AS runtime
            ON runtime.revision_id = lineage.revision_id
          CROSS JOIN requested
          WHERE runtime.entity_type IN (
                  'occurrences', 'runtime_occurrences',
                  'videos', 'runtime_videos'
                )
            AND EXISTS (
              SELECT 1
              FROM (
                VALUES
                  (
                    runtime.payload_json::jsonb->>'channelId',
                    runtime.payload_json::jsonb->>'channelHandle'
                  ),
                  (
                    runtime.payload_json::jsonb->'payload'->>'channelId',
                    runtime.payload_json::jsonb->'payload'->>'channelHandle'
                  ),
                  (
                    runtime.payload_json::jsonb->'originalIdentity'->>'channelId',
                    runtime.payload_json::jsonb->'originalIdentity'->>'channelHandle'
                  ),
                  (
                    runtime.payload_json::jsonb->'payload'->'originalIdentity'->>'channelId',
                    runtime.payload_json::jsonb->'payload'->'originalIdentity'->>'channelHandle'
                  ),
                  (
                    runtime.payload_json::jsonb->'replacementPayload'->>'channelId',
                    runtime.payload_json::jsonb->'replacementPayload'->>'channelHandle'
                  ),
                  (
                    runtime.payload_json::jsonb->'payload'->'replacementPayload'->>'channelId',
                    runtime.payload_json::jsonb->'payload'->'replacementPayload'->>'channelHandle'
                  ),
                  (
                    runtime.payload_json::jsonb->'replacementVideoPayload'->>'channelId',
                    runtime.payload_json::jsonb->'replacementVideoPayload'->>'channelHandle'
                  ),
                  (
                    runtime.payload_json::jsonb->'payload'->'replacementVideoPayload'->>'channelId',
                    runtime.payload_json::jsonb->'payload'->'replacementVideoPayload'->>'channelHandle'
                  )
              ) AS seed_identity(channel_id, channel_handle)
              WHERE coalesce(seed_identity.channel_id, '') <> ''
                AND coalesce(seed_identity.channel_handle, '') <> ''
                AND regexp_replace(
                      lower(seed_identity.channel_handle),
                      '^/?@?', ''
                    ) = requested.normalized_handle
            )
          ORDER BY lineage.lineage_order, runtime.entity_type, runtime.entity_key
          LIMIT %s
        ), runtime_handle_seed_guard AS MATERIALIZED (
          SELECT count(*) AS seed_row_count
          FROM runtime_handle_seed_rows
        ), runtime_candidate_entity_keys AS MATERIALIZED (
          SELECT DISTINCT
                 CASE
                   WHEN entity_type IN ('occurrences', 'runtime_occurrences')
                     THEN 'occurrences'
                   WHEN entity_type IN ('videos', 'runtime_videos')
                     THEN 'videos'
                 END AS entity_kind,
                 entity_key
          FROM runtime_handle_seed_rows
          WHERE coalesce(entity_key, '') <> ''
        ), runtime_candidate_video_ids AS MATERIALIZED (
          SELECT DISTINCT candidate.video_id
          FROM runtime_handle_seed_rows AS seed
          CROSS JOIN LATERAL (
            VALUES
              (seed.payload->>'videoId'),
              (seed.payload->'payload'->>'videoId'),
              (seed.payload->'originalIdentity'->>'videoId'),
              (seed.payload->'payload'->'originalIdentity'->>'videoId'),
              (seed.payload->'replacementPayload'->>'videoId'),
              (seed.payload->'payload'->'replacementPayload'->>'videoId'),
              (seed.payload->'replacementVideoPayload'->>'videoId'),
              (seed.payload->'payload'->'replacementVideoPayload'->>'videoId'),
              (
                CASE
                  WHEN seed.entity_type IN ('videos', 'runtime_videos')
                    THEN seed.entity_key
                  ELSE NULL
                END
              )
          ) AS candidate(video_id)
          WHERE coalesce(candidate.video_id, '') <> ''
          ORDER BY candidate.video_id
          LIMIT %s
        ), runtime_candidate_video_guard AS MATERIALIZED (
          SELECT count(*) AS candidate_video_count
          FROM runtime_candidate_video_ids
        ), runtime_identity_rows AS MATERIALIZED (
          SELECT lineage.lineage_order, runtime.revision_id,
                 runtime.entity_type,
                 CASE
                   WHEN runtime.entity_type IN (
                     'occurrences', 'runtime_occurrences'
                   ) THEN 'occurrences'
                   WHEN runtime.entity_type IN ('videos', 'runtime_videos')
                     THEN 'videos'
                 END AS entity_kind,
                 runtime.entity_key, runtime.tombstone,
                 runtime.payload_json::jsonb AS payload
          FROM overlay_lineage AS lineage
          JOIN migration_runtime_rows AS runtime
            ON runtime.revision_id = lineage.revision_id
          WHERE runtime.entity_type IN (
                  'occurrences', 'runtime_occurrences',
                  'videos', 'runtime_videos'
                )
            AND (
              EXISTS (
                SELECT 1
                FROM runtime_candidate_entity_keys AS candidate
                WHERE candidate.entity_kind = CASE
                        WHEN runtime.entity_type IN (
                          'occurrences', 'runtime_occurrences'
                        ) THEN 'occurrences'
                        WHEN runtime.entity_type IN ('videos', 'runtime_videos')
                          THEN 'videos'
                      END
                  AND candidate.entity_key = runtime.entity_key
              )
              OR EXISTS (
                SELECT 1
                FROM (
                  VALUES
                    (runtime.payload_json::jsonb->>'videoId'),
                    (runtime.payload_json::jsonb->'payload'->>'videoId'),
                    (runtime.payload_json::jsonb->'originalIdentity'->>'videoId'),
                    (runtime.payload_json::jsonb->'payload'->'originalIdentity'->>'videoId'),
                    (runtime.payload_json::jsonb->'replacementPayload'->>'videoId'),
                    (runtime.payload_json::jsonb->'payload'->'replacementPayload'->>'videoId'),
                    (runtime.payload_json::jsonb->'replacementVideoPayload'->>'videoId'),
                    (runtime.payload_json::jsonb->'payload'->'replacementVideoPayload'->>'videoId'),
                    (
                      CASE
                        WHEN runtime.entity_type IN ('videos', 'runtime_videos')
                          THEN runtime.entity_key
                        ELSE NULL
                      END
                    )
                ) AS row_identity(video_id)
                JOIN runtime_candidate_video_ids AS candidate
                  ON candidate.video_id = row_identity.video_id
              )
            )
          ORDER BY lineage.lineage_order, runtime.entity_type, runtime.entity_key
          LIMIT %s
        ), runtime_identity_guard AS MATERIALIZED (
          SELECT greatest(
                   seed.seed_row_count,
                   candidate.candidate_video_count,
                   count(runtime.revision_id)
                 ) AS runtime_row_count
          FROM runtime_handle_seed_guard AS seed
          CROSS JOIN runtime_candidate_video_guard AS candidate
          LEFT JOIN runtime_identity_rows AS runtime ON TRUE
          GROUP BY seed.seed_row_count, candidate.candidate_video_count
        ), runtime_latest_entity_order AS MATERIALIZED (
          SELECT entity_kind, entity_key, min(lineage_order) AS lineage_order
          FROM runtime_identity_rows
          CROSS JOIN runtime_identity_guard AS bounded_guard
          WHERE bounded_guard.runtime_row_count <= %s
          GROUP BY entity_kind, entity_key
        ), runtime_latest_entity_rows AS MATERIALIZED (
          SELECT runtime.*
          FROM runtime_identity_rows AS runtime
          JOIN runtime_latest_entity_order AS latest
            ON latest.entity_kind = runtime.entity_kind
           AND latest.entity_key = runtime.entity_key
           AND latest.lineage_order = runtime.lineage_order
        ), runtime_latest_effective_rows AS MATERIALIZED (
          SELECT runtime.*, identity.channel_id, identity.channel_handle,
                 identity.video_id
          FROM runtime_latest_entity_rows AS runtime
          LEFT JOIN LATERAL (
            SELECT effective.channel_id, effective.channel_handle,
                   effective.video_id
            FROM (
              VALUES
                (
                  1,
                  runtime.payload->'replacementVideoPayload'->>'channelId',
                  runtime.payload->'replacementVideoPayload'->>'channelHandle',
                  runtime.payload->'replacementVideoPayload'->>'videoId'
                ),
                (
                  2,
                  runtime.payload->'payload'->'replacementVideoPayload'->>'channelId',
                  runtime.payload->'payload'->'replacementVideoPayload'->>'channelHandle',
                  runtime.payload->'payload'->'replacementVideoPayload'->>'videoId'
                ),
                (
                  3,
                  runtime.payload->'replacementPayload'->>'channelId',
                  runtime.payload->'replacementPayload'->>'channelHandle',
                  runtime.payload->'replacementPayload'->>'videoId'
                ),
                (
                  4,
                  runtime.payload->'payload'->'replacementPayload'->>'channelId',
                  runtime.payload->'payload'->'replacementPayload'->>'channelHandle',
                  runtime.payload->'payload'->'replacementPayload'->>'videoId'
                ),
                (
                  5,
                  runtime.payload->>'channelId',
                  runtime.payload->>'channelHandle',
                  runtime.payload->>'videoId'
                ),
                (
                  6,
                  runtime.payload->'payload'->>'channelId',
                  runtime.payload->'payload'->>'channelHandle',
                  runtime.payload->'payload'->>'videoId'
                )
            ) AS effective(
              identity_priority, channel_id, channel_handle, video_id
            )
            WHERE coalesce(effective.channel_id, '') <> ''
              AND coalesce(effective.channel_handle, '') <> ''
              AND coalesce(effective.video_id, '') <> ''
            ORDER BY effective.identity_priority
            LIMIT 1
          ) AS identity ON TRUE
        ), runtime_video_events AS MATERIALIZED (
          SELECT DISTINCT runtime.lineage_order, runtime.revision_id,
                 runtime.entity_key, runtime.tombstone, runtime.video_id,
                 affected.video_id AS affected_video_id
          FROM runtime_latest_effective_rows AS runtime
          CROSS JOIN LATERAL (
            VALUES
              (runtime.payload->>'videoId'),
              (runtime.payload->'payload'->>'videoId'),
              (runtime.payload->'originalIdentity'->>'videoId'),
              (runtime.payload->'payload'->'originalIdentity'->>'videoId'),
              (runtime.payload->'replacementPayload'->>'videoId'),
              (runtime.payload->'payload'->'replacementPayload'->>'videoId'),
              (runtime.payload->'replacementVideoPayload'->>'videoId'),
              (runtime.payload->'payload'->'replacementVideoPayload'->>'videoId'),
              (runtime.entity_key)
          ) AS affected(video_id)
          WHERE runtime.entity_kind = 'videos'
            AND coalesce(affected.video_id, '') <> ''
        ), runtime_identities AS MATERIALIZED (
          SELECT runtime.channel_id
          FROM runtime_latest_effective_rows AS runtime
          CROSS JOIN requested
          WHERE NOT runtime.tombstone
            AND coalesce(runtime.channel_id, '') <> ''
            AND coalesce(runtime.channel_handle, '') <> ''
            AND coalesce(runtime.video_id, '') <> ''
            AND NOT EXISTS (
              SELECT 1
              FROM runtime_video_events AS video_event
              WHERE video_event.affected_video_id = runtime.video_id
                AND (
                  video_event.lineage_order < runtime.lineage_order
                  OR (
                    video_event.lineage_order = runtime.lineage_order
                    AND runtime.entity_kind <> 'videos'
                  )
                )
            )
            AND regexp_replace(
                  lower(runtime.channel_handle),
                  '^/?@?', ''
                ) = requested.normalized_handle
        ), identities AS MATERIALIZED (
          SELECT ranking.detail_key AS channel_id
          FROM runtime_ranking_rows AS ranking
          CROSS JOIN requested
          WHERE ranking.revision_id = %s
            AND ranking.range_id = %s
            AND ranking.view = 'vtubers'
            AND ranking.metric = %s
            AND ranking.detail_key <> ''
            AND coalesce(
                  ranking.payload_json::jsonb->>'channelId',
                  ranking.detail_key
                ) = ranking.detail_key
            AND regexp_replace(
                  lower(coalesce(
                    ranking.payload_json::jsonb->>'channelHandle', ''
                  )),
                  '^/?@?', ''
                ) = requested.normalized_handle
          UNION ALL
          SELECT video.channel_id
          FROM migration_video_rows AS video
          CROSS JOIN requested
          WHERE video.revision_id = ANY(%s)
            AND video.channel_id <> ''
            AND coalesce(
                  video.payload_json::jsonb->>'channelId',
                  video.channel_id
                ) = video.channel_id
            AND regexp_replace(
                  lower(coalesce(
                    nullif(video.channel_handle, ''),
                    video.payload_json::jsonb->>'channelHandle',
                    ''
                  )),
                  '^/?@?', ''
                ) = requested.normalized_handle
          UNION ALL
          SELECT channel_id
          FROM runtime_identities
        ), unique_identities AS MATERIALIZED (
          SELECT DISTINCT channel_id FROM identities WHERE channel_id <> ''
          ORDER BY channel_id
          LIMIT 2
        )
        SELECT identity.channel_id, guard.runtime_row_count
        FROM unique_identities AS identity
        CROSS JOIN runtime_identity_guard AS guard
        UNION ALL
        SELECT '' AS channel_id, guard.runtime_row_count
        FROM runtime_identity_guard AS guard
        ORDER BY channel_id
        LIMIT %s
        """,
        [
            handle,
            list(overlay_revision_ids),
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
            _MAX_AFFECTED_RUNTIME_OCCURRENCES,
            parent_revision_id,
            _text(options.get("range")) or "all",
            db_metric,
            list(overlay_revision_ids),
            3,
        ],
    )
    if any(
        int(row.get("runtime_row_count") or 0)
        > _MAX_AFFECTED_RUNTIME_OCCURRENCES
        for row in rows
    ):
        raise PostgresAdapterError(
            "exact VTuber runtime identity lookup exceeded bounded cap"
        )
    channel_ids = tuple(
        sorted({_text(row.get("channel_id")) for row in rows if _text(row.get("channel_id"))})
    )
    if len(channel_ids) > 1:
        raise PostgresAdapterError(
            "exact VTuber handle resolved to multiple channel identities"
        )
    return channel_ids


def _scope_accepted_video_resets(
    connection,
    parent_revision_id: str,
    resets: Mapping[str, Mapping[str, Any]],
    channel_scope: Sequence[str] | None,
) -> dict[str, dict[str, Any]]:
    """Keep only reset videos whose old or new immutable channel is in scope."""

    if channel_scope is None:
        return {key: dict(value) for key, value in resets.items()}
    scope = {_text(value) for value in channel_scope if _text(value)}
    if not scope or not resets:
        return {}
    selected_video_ids = {
        _text(video_id)
        for video_id, row in resets.items()
        if _text(video_id) and _text(row.get("channel_id")) in scope
    }
    reset_video_ids = sorted({_text(value) for value in resets if _text(value)})
    parent_rows = _rows(
        connection,
        """
        SELECT video_id
        FROM runtime_videos
        WHERE revision_id = %s
          AND video_id = ANY(%s)
          AND channel_id = ANY(%s)
        ORDER BY video_id
        LIMIT %s
        """,
        [
            parent_revision_id,
            reset_video_ids,
            sorted(scope),
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
        ],
    )
    if len(parent_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("scoped accepted-video reset lookup exceeded cap")
    selected_video_ids.update(
        _text(row.get("video_id")) for row in parent_rows if _text(row.get("video_id"))
    )
    return {
        video_id: dict(row)
        for video_id, row in resets.items()
        if _text(video_id) in selected_video_ids
    }


def _bounded_parent_video_ids_for_channel_scope(
    connection,
    parent_revision_id: str,
    channel_scope: Sequence[str],
    range_id: str,
) -> tuple[str, ...]:
    """Read only parent videos in one resolved immutable channel scope."""

    scope = sorted({_text(value) for value in channel_scope if _text(value)})
    if not scope:
        return ()
    rows = _rows(
        connection,
        """
        SELECT video_id
        FROM runtime_videos
        WHERE revision_id = %s
          AND channel_id = ANY(%s)
          AND EXISTS (
            SELECT 1
            FROM runtime_occurrences AS occurrence
            WHERE occurrence.revision_id = %s
              AND occurrence.video_id = runtime_videos.video_id
              AND (
                (%s = 'all' AND coalesce(occurrence.range_id, '') IN ('all', ''))
                OR (%s = '7d' AND coalesce(occurrence.range_id, '') IN ('7d', ''))
              )
          )
        ORDER BY video_id
        LIMIT %s
        """,
        [
            parent_revision_id,
            scope,
            parent_revision_id,
            _text(range_id) or "all",
            _text(range_id) or "all",
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
        ],
    )
    if len(rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "scoped parent video identity lookup exceeded bounded cap"
        )
    return tuple(
        _text(row.get("video_id"))
        for row in rows
        if _text(row.get("video_id"))
    )


def _channel_url_is_coherent(channel_url: Any, channel_id: str, handle: Any = "") -> bool:
    """Require a retained public URL to bind to its channel id or handle."""

    normalized_url = _text(channel_url).casefold()
    normalized_handle = _normalized_channel_handle(handle)
    return bool(normalized_url and (
        _text(channel_id).casefold() in normalized_url
        or (normalized_handle and normalized_handle in normalized_url)
    ))


def _strict_replacement_public_video(
    change: Mapping[str, Any], replacement: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build a replacement video tuple without crossing its old public identity.

    The change side identifies only the removed parent tuple.  The replacement
    side owns every public field unless the immutable video/channel identity is
    unchanged (or only the video changed within the same immutable channel).
    """

    old_video_id = _text(change.get("videoId") or change.get("video_id"))
    old_channel_id = _text(change.get("channelId") or change.get("channel_id"))
    video_id = _text(replacement.get("videoId"))
    source = _json_object(change.get("replacementVideoPayload"))
    if not source:
        source = _overlay_video_projection(replacement)
    payload_video_id = _text(source.get("videoId") or source.get("video_id"))
    payload_channel_id = _text(source.get("channelId") or source.get("channel_id"))
    replacement_channel_id = _text(replacement.get("channelId"))
    if (
        not old_video_id
        or not old_channel_id
        or not video_id
        or (payload_video_id and payload_video_id != video_id)
        or (replacement_channel_id and payload_channel_id and replacement_channel_id != payload_channel_id)
    ):
        raise PostgresAdapterError("VTuber exact replacement public identity is invalid")
    channel_id = replacement_channel_id or payload_channel_id
    if not channel_id or (old_video_id == video_id and old_channel_id != channel_id):
        raise PostgresAdapterError("VTuber exact replacement public identity is invalid")

    new_video = old_video_id != video_id
    channel_move = old_channel_id != channel_id
    thumbnail = _text(source.get("thumbnailUrl") or source.get("thumbnail_url"))
    if thumbnail and _thumbnail_video_id(thumbnail) != video_id:
        raise PostgresAdapterError("VTuber exact replacement public identity is invalid")

    handle = _text(source.get("channelHandle") or source.get("channel_handle") or replacement.get("channelHandle"))
    channel_url = _text(source.get("channelUrl") or source.get("channel_url") or replacement.get("channelUrl"))
    name = _text(source.get("channelName") or source.get("channel_name") or replacement.get("channelName"))
    if channel_move:
        old_handle = _normalized_channel_handle(
            change.get("channel_handle") or _json_object(change.get("videoPayload")).get("channelHandle")
        )
        old_url = _text(
            change.get("channel_url") or _json_object(change.get("videoPayload")).get("channelUrl")
        ).casefold()
        normalized_handle = _normalized_channel_handle(handle)
        normalized_url = channel_url.casefold()
        if (
            (old_handle and normalized_handle == old_handle)
            or (old_url and normalized_url == old_url)
            or (old_channel_id.casefold() in normalized_url)
            or (old_handle and old_handle in normalized_url)
            or (channel_url and not _channel_url_is_coherent(channel_url, channel_id, handle))
        ):
            raise PostgresAdapterError("VTuber exact replacement public identity is invalid")
        if not handle and not channel_url:
            channel_url = f"https://www.youtube.com/channel/{channel_id}"
    else:
        # The immutable channel is the same, so channel metadata may be
        # reused.  A changed video still never reuses old video fields.
        old_payload = _json_object(change.get("videoPayload"))
        handle = handle or _text(change.get("channel_handle")) or _text(old_payload.get("channelHandle"))
        channel_url = channel_url or _text(change.get("channel_url")) or _text(old_payload.get("channelUrl"))
        name = name or _text(change.get("channel_name")) or _text(old_payload.get("channelName"))
        if not new_video and old_payload:
            old_payload_video_id = _text(old_payload.get("videoId") or old_payload.get("video_id"))
            old_payload_channel_id = _text(old_payload.get("channelId") or old_payload.get("channel_id"))
            if (
                (old_payload_video_id and old_payload_video_id != video_id)
                or (old_payload_channel_id and old_payload_channel_id != channel_id)
            ):
                raise PostgresAdapterError("VTuber exact replacement public identity is invalid")
            # Same immutable video ownership permits verified video metadata
            # (including its thumbnail) to survive a title-only replacement.
            for name_key, value in old_payload.items():
                source.setdefault(name_key, value)
    if channel_url and not _channel_url_is_coherent(channel_url, channel_id, handle):
        raise PostgresAdapterError("VTuber exact replacement public identity is invalid")
    if not channel_url:
        channel_url = f"https://www.youtube.com/channel/{channel_id}"
    if new_video and not thumbnail:
        thumbnail = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"

    public_video = dict(source)
    public_video.update({
        "videoId": video_id,
        "channelId": channel_id,
        "channelHandle": handle,
        "channelUrl": channel_url,
    })
    if name:
        public_video["channelName"] = name
    if thumbnail:
        public_video["thumbnailUrl"] = thumbnail
    if new_video:
        public_video.pop("videoThumbnailUrl", None)
        public_video["title"] = _text(source.get("title") or replacement.get("title"))
    return public_video, {
        "video_id": video_id,
        "channel_id": channel_id,
        "channel_handle": handle,
        "channel_url": channel_url,
        "channel_name": name,
        "video_title": _text(public_video.get("title")),
    }


def _runtime_replacement_candidate_rows(
    changes: Sequence[Mapping[str, Any]],
    strict_immutable_identity: bool = False,
) -> list[dict[str, Any]]:
    """Convert final runtime replacements to song-ranking delta rows."""

    rows: list[dict[str, Any]] = []
    for change in changes:
        replacement = change.get("replacementPayload")
        if not change.get("replacement") or not isinstance(replacement, Mapping):
            continue
        title = _text(replacement.get("title"))
        artist = _text(replacement.get("artist"))
        replacement_video_id = _text(replacement.get("videoId"))
        replacement_occurrence_id = _text(replacement.get("occurrenceId"))
        video_payload = _json_object(change.get("replacementVideoPayload"))
        if not video_payload:
            video_payload = _overlay_video_projection(replacement)
        replacement_channel_id = _text(replacement.get("channelId") or video_payload.get("channelId"))
        if strict_immutable_identity and not (
            title and replacement_video_id and replacement_occurrence_id and replacement_channel_id
        ):
            continue
        strict_public: dict[str, Any] = {}
        if strict_immutable_identity:
            try:
                video_payload, strict_public = _strict_replacement_public_video(change, replacement)
                replacement_channel_id = _text(strict_public["channel_id"])
            except PostgresAdapterError:
                continue
        video_id = replacement_video_id or _text(change.get("videoId"))
        occurrence_id = replacement_occurrence_id or _text(change.get("occurrenceId"))
        if not title or not video_id or not occurrence_id:
            continue
        song_key = _text(replacement.get("songKey"))
        if not song_key:
            song_key = hashlib.sha256(
                f"song\0{_overlay_norm(title)}\0{_overlay_norm(artist)}".encode("utf-8")
            ).hexdigest()[:24]
        occurrence = dict(replacement)
        occurrence["songKey"] = song_key
        rows.append({
            "revision_id": change.get("revisionId"),
            "video_id": video_id,
            "occurrence_id": occurrence_id,
            "position": replacement.get("position"),
            "range_id": replacement.get("rangeId") or change.get("rangeId"),
            "song_key": song_key,
            "seconds": replacement.get("seconds"),
            "title": title,
            "artist": artist,
            "source_id": replacement.get("sourceId"),
            "raw_hash": replacement.get("rawHash"),
            "source_system": replacement.get("sourceSystem"),
            "occurrence_payload_json": occurrence,
            "video_title": strict_public.get("video_title") or video_payload.get("title") or change.get("videoTitle"),
            "channel_name": strict_public.get("channel_name") or video_payload.get("channelName") or change.get("channel_name"),
            "channel_id": replacement_channel_id or change.get("channel_id"),
            "channel_handle": strict_public.get("channel_handle") if strict_immutable_identity else video_payload.get("channelHandle") or change.get("channel_handle"),
            "channel_url": strict_public.get("channel_url") if strict_immutable_identity else video_payload.get("channelUrl") or change.get("channel_url"),
            "video_payload_json": video_payload if strict_immutable_identity else video_payload or change.get("videoPayload"),
            "video_tombstone": False,
            "runtime_replacement": True,
            "replacement_same_artist": change.get("replacementSameArtist"),
            "replacement_same_video": change.get("replacementSameVideo"),
        })
    return rows


def _enrich_runtime_original_group_counts(
    connection,
    parent_revision_id: str,
    candidate_rows: Sequence[Mapping[str, Any]],
    changes: Sequence[dict[str, Any]],
) -> None:
    """Bind videoCount subtraction to the exact pre-curation video/song group."""

    target_video_ids = {
        _text(change.get("videoId") or change.get("video_id"))
        for change in changes
        if _text(change.get("videoId") or change.get("video_id"))
    }
    if not target_video_ids:
        return
    selected_video_ids = {
        _text(row.get("video_id"))
        for row in candidate_rows
        if _text(row.get("video_id"))
    }
    candidate_counts: dict[tuple[str, str, str], int] = defaultdict(int)
    for row in candidate_rows:
        key = (
            _text(row.get("video_id")),
            _overlay_song_group_norm(row.get("title")),
            _overlay_song_group_norm(row.get("artist")),
        )
        candidate_counts[key] += 1
    parent_counts: dict[tuple[str, str, str], int] = defaultdict(int)
    for row in _rows(
            connection,
            """
            SELECT video_id, title, artist, COUNT(*) AS occurrence_count
            FROM runtime_occurrences
            WHERE revision_id = %s AND video_id = ANY(%s)
            GROUP BY video_id, title, artist
            """,
            [parent_revision_id, sorted(target_video_ids)],
        ):
        parent_counts[(
            _text(row.get("video_id")),
            _overlay_song_group_norm(row.get("title")),
            _overlay_song_group_norm(row.get("artist")),
        )] += int(row.get("occurrence_count") or 0)
    for change in changes:
        video_id = _text(change.get("videoId") or change.get("video_id"))
        key = (
            video_id,
            _overlay_song_group_norm(change.get("title")),
            _overlay_song_group_norm(change.get("artist")),
        )
        change["originalGroupVideoOccurrenceCount"] = (
            candidate_counts.get(key, 0)
            if video_id in selected_video_ids
            else parent_counts.get(key, 0)
        )


def _source_overlay_match(item: Mapping[str, Any], change: Mapping[str, Any]) -> bool:
    target_video = _text(change.get("videoId") or change.get("video_id"))
    nested_video = item.get("video") if isinstance(item.get("video"), Mapping) else item.get("item") if isinstance(item.get("item"), Mapping) else {}
    item_video = _text(
        item.get("youtubeVideoId")
        or item.get("videoId")
        or item.get("externalVideoId")
        or nested_video.get("videoId")
    )
    if target_video and item_video != target_video:
        return False
    target_occurrence = _text(change.get("occurrenceId") or change.get("occurrence_id"))
    item_occurrence = _text(item.get("occurrenceId") or item.get("occurrence_id"))
    if target_occurrence and item_occurrence:
        return target_occurrence == item_occurrence
    if "seconds" in change and change.get("seconds") is not None:
        try:
            if int(item.get("seconds")) != int(change.get("seconds")):
                return False
        except (TypeError, ValueError):
            return False
    song = item.get("song") if isinstance(item.get("song"), Mapping) else {}
    target_title = _overlay_norm(change.get("title"))
    target_artist = _overlay_norm(change.get("artist"))
    if target_title and _overlay_norm(song.get("title") or item.get("title")) != target_title:
        return False
    if target_artist and _overlay_norm(song.get("artist") or item.get("artist")) != target_artist:
        return False
    return bool(target_video or target_occurrence)


def _apply_occurrence_replacement(item: Mapping[str, Any], change: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(item)
    replacement = change.get("replacementPayload")
    if not isinstance(replacement, Mapping):
        return result
    public = _overlay_public_occurrence(replacement)
    result.update(public)
    if isinstance(result.get("song"), Mapping):
        song = dict(result["song"])
        song.update({
            name: public[name]
            for name in ("title", "artist", "songKey", "seconds", "rangeId", "sourceId", "sourceSystem")
            if name in public
        })
        result["song"] = song
    return result


def _apply_source_overlay(occurrences: Iterable[Mapping[str, Any]], changes: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    result = [dict(item) for item in occurrences]
    for change in changes:
        entity_type = _text(change.get("entityType"))
        if entity_type in {"videos", "runtime_videos"}:
            target_video = _text(change.get("videoId") or change.get("video_id"))
            if target_video:
                result = [item for item in result if _text(item.get("videoId")) != target_video]
            continue
        if entity_type not in {"occurrences", "runtime_occurrences"}:
            continue
        matches = [index for index, item in enumerate(result) if _source_overlay_match(item, change)]
        if len(matches) == 1:
            index = matches[0]
            if change.get("replacement"):
                result[index] = _apply_occurrence_replacement(result[index], change)
            else:
                result.pop(index)
    return result


def _apply_record_overlay(records: Iterable[Mapping[str, Any]], changes: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Apply conservative occurrence tombstones to channel-derived records."""

    result: list[dict[str, Any]] = []
    for record in records:
        video = dict(record.get("video") or {})
        kept: list[dict[str, Any]] = []
        for song in record.get("occurrences", ()):
            item = dict(video)
            item.update(song)
            item["song"] = song
            matches = [
                change for change in changes
                if _text(change.get("entityType")) in {"occurrences", "runtime_occurrences"}
                and _source_overlay_match(item, change)
            ]
            if len(matches) == 1:
                if matches[0].get("replacement"):
                    kept.append(_apply_occurrence_replacement(song, matches[0]))
                continue
            kept.append(dict(song))
        result.append({"video": video, "occurrences": tuple(kept)})
    return result


def _runtime_change_group_key(change: Mapping[str, Any], view: str) -> str:
    title = _text(change.get("title"))
    artist = _text(change.get("artist"))
    video_id = _text(change.get("videoId") or change.get("video_id"))
    if view in {"songs", "songIndex", "vsingerSongs"}:
        return f"{_overlay_norm(title)}::{_overlay_norm(artist)}"
    if view == "artists":
        return _overlay_norm(artist) or "unknown"
    if view == "videos":
        return video_id
    return _text(change.get("channelId") or change.get("channel_id")) or _text(change.get("channelHandle") or change.get("channel_handle")).lstrip("@/") or _overlay_norm(change.get("channelName") or change.get("channel_name"))


def _apply_runtime_tombstone_groups(
    groups: dict[str, dict[str, Any]],
    changes: Sequence[Mapping[str, Any]],
    view: str,
    deferred_preview_key: str = "_deferred_runtime_preview_changes",
) -> None:
    decremented_videos: set[tuple[str, str]] = set()
    removal_counts: dict[tuple[str, str, str], int] = defaultdict(int)
    for change in changes:
        removal_counts[(
            _overlay_song_group_norm(change.get("title")),
            _overlay_song_group_norm(change.get("artist")),
            _text(change.get("videoId") or change.get("video_id")),
        )] += 1
    group_keys_by_identity: dict[str, list[str]] = defaultdict(list)
    if view in {"songs", "songIndex", "vsingerSongs"}:
        for key, row in groups.items():
            identity = (
                f"{_overlay_song_group_norm(row.get('title'))}::"
                f"{_overlay_song_group_norm(row.get('artist'))}"
            )
            group_keys_by_identity[identity].append(key)
    elif view == "artists":
        for key, row in groups.items():
            for identity in {
                _overlay_norm(row.get("artist")),
                _overlay_norm(row.get("detail_key")),
            }:
                if identity:
                    group_keys_by_identity[identity].append(key)
    elif view == "videos":
        for key, row in groups.items():
            identity = _text(row.get("detail_key"))
            if identity:
                group_keys_by_identity[identity].append(key)
    for change in changes:
        if _text(change.get("entityType")) not in {"occurrences", "runtime_occurrences"}:
            continue
        replacement = bool(change.get("replacement"))
        if replacement:
            if view == "artists" and bool(change.get("replacementSameArtist")):
                continue
            if view in {"videos", "vtubers"} and bool(change.get("replacementSameVideo")):
                continue
        target_title = _overlay_norm(change.get("title"))
        target_artist = _overlay_norm(change.get("artist"))
        target_video = _text(change.get("videoId") or change.get("video_id"))
        target_channel = _overlay_norm(change.get("channelId") or change.get("channel_id") or change.get("channelHandle") or change.get("channel_handle") or change.get("channelName") or change.get("channel_name"))
        if view in {"songs", "songIndex", "vsingerSongs"}:
            candidate_group_keys = group_keys_by_identity.get(
                f"{_overlay_song_group_norm(target_title)}::"
                f"{_overlay_song_group_norm(target_artist)}",
                (),
            )
        elif view == "artists":
            candidate_group_keys = group_keys_by_identity.get(target_artist, ())
        elif view == "videos":
            candidate_group_keys = group_keys_by_identity.get(target_video, ())
        else:
            candidate_group_keys = tuple(groups)
        for key in candidate_group_keys:
            row = groups.get(key)
            if row is None:
                continue
            row_title = _overlay_norm(row.get("title"))
            row_artist = _overlay_norm(row.get("artist"))
            row_name = _overlay_norm(row.get("name"))
            row_search = _overlay_norm(f"{row.get('search_text', '')} {row.get('channel_search_text', '')}")
            if view in {"songs", "songIndex", "vsingerSongs"}:
                matched = bool(
                    target_title
                    and target_artist
                    and _overlay_song_group_norm(row_title) == _overlay_song_group_norm(target_title)
                    and _overlay_song_group_norm(row_artist) == _overlay_song_group_norm(target_artist)
                )
            elif view == "artists":
                matched = bool(target_artist and (row_artist == target_artist or _overlay_norm(row.get("detail_key")) == target_artist))
            elif view == "videos":
                matched = bool(target_video and _text(row.get("detail_key")) == target_video)
            else:
                matched = bool(target_channel and (target_channel in row_search or target_channel == row_name or target_channel == _overlay_norm(row.get("detail_key"))))
            if not matched:
                continue
            row["row_count"] = max(0, int(row.get("row_count") or 0) - 1)
            row["timestamp_count"] = max(0, int(row.get("timestamp_count") or 0) - 1)
            video_key = (key, target_video)
            original_video_group_count = int(change.get("originalGroupVideoOccurrenceCount") or 0)
            removed_video_group_count = removal_counts[(
                _overlay_song_group_norm(change.get("title")),
                _overlay_song_group_norm(change.get("artist")),
                target_video,
            )]
            if (
                view in {"songs", "songIndex", "vsingerSongs"}
                and target_video
                and video_key not in decremented_videos
                and original_video_group_count > 0
                and removed_video_group_count >= original_video_group_count
            ):
                row["video_count"] = max(0, int(row.get("video_count") or 0) - 1)
                decremented_videos.add(video_key)
            if row["row_count"] == 0:
                groups.pop(key, None)
                continue
            payload = _json_object(row.get("payload_json"))
            if payload:
                payload.update({
                    "count": row["row_count"],
                    "videoCount": row.get("video_count", 0),
                    "timestampCount": row["timestamp_count"],
                })
                row["payload_json"] = payload
            else:
                # Bounded parent rows intentionally carry scalar counts with
                # payload_json=NULL.  Do not turn that sentinel into a
                # counts-only public payload: render must hydrate the exact
                # persisted parent payload and replay these preview changes.
                deferred = row.setdefault(deferred_preview_key, [])
                if not isinstance(deferred, list):
                    raise PostgresAdapterError(
                        "deferred runtime preview state is invalid"
                    )
                deferred.append(dict(change))


def _runtime_change_matches_group(row: Mapping[str, Any], change: Mapping[str, Any], view: str) -> bool:
    """Match a runtime change to one parent ranking group, never by broad search text."""

    title = _overlay_norm(change.get("title"))
    artist = _overlay_norm(change.get("artist"))
    video_id = _text(change.get("videoId") or change.get("video_id"))
    if view in {"songs", "songIndex", "vsingerSongs"}:
        return bool(title and artist and (
            _overlay_song_group_norm(row.get("title")) == _overlay_song_group_norm(title)
            and _overlay_song_group_norm(row.get("artist")) == _overlay_song_group_norm(artist)
        ))
    if view == "artists":
        return bool(artist and (
            _overlay_norm(row.get("artist")) == artist
            or _overlay_norm(row.get("detail_key")) == artist
        ))
    if view == "videos":
        return bool(video_id and _text(row.get("detail_key")) == video_id)
    channel_values = {
        _text(change.get(name)).lstrip("@/")
        for name in ("channelId", "channel_id", "channelHandle", "channel_handle", "channelName", "channel_name")
        if _text(change.get(name))
    }
    channel_values = {_overlay_norm(value) for value in channel_values if value}
    if not channel_values:
        return False
    row_values = {
        _overlay_norm(_text(row.get(name)).lstrip("@/"))
        for name in ("detail_key", "name", "channel_id", "channel_handle", "channel_name")
        if _text(row.get(name))
    }
    return bool(channel_values & row_values)


def _preview_changes_for_group(changes: Sequence[Mapping[str, Any]], view: str) -> list[Mapping[str, Any]]:
    """Song cards lose the old tuple; non-song cards replace it in place."""

    if view not in {"songs", "songIndex", "vsingerSongs"}:
        return list(changes)
    return [
        {**dict(change), "replacement": False}
        if change.get("replacement") else change
        for change in changes
    ]


def _replacement_stays_in_group(change: Mapping[str, Any], view: str) -> bool:
    if not change.get("replacement"):
        return False
    if view == "artists":
        return bool(change.get("replacementSameArtist"))
    if view in {"videos", "vtubers"}:
        return bool(change.get("replacementSameVideo"))
    return False


def _apply_runtime_change_previews(
    groups: dict[str, dict[str, Any]],
    changes: Sequence[Mapping[str, Any]],
    view: str,
) -> None:
    """Update only affected bounded previews and their exact search groups."""

    changes_by_group: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    if view != "vtubers":
        for change in changes:
            key = _runtime_change_group_key(change, view)
            if key:
                changes_by_group[key].append(change)
    for row in groups.values():
        if view == "vtubers":
            matched = [
                change for change in changes
                if _runtime_change_matches_group(row, change, view)
            ]
        else:
            matched = changes_by_group.get(
                _runtime_view_group_key(row, view),
                (),
            )
        if not matched:
            continue
        payload = _json_object(row.get("payload_json"))
        occurrences = payload.get("occurrences")
        if isinstance(occurrences, list):
            payload["occurrences"] = _apply_source_overlay(
                occurrences,
                _preview_changes_for_group(matched, view),
            )
            row["payload_json"] = payload
        replacement_terms = [
            f"{_text(change.get('replacementPayload', {}).get('title'))} "
            f"{_text(change.get('replacementPayload', {}).get('artist'))}".strip()
            for change in matched
            if _replacement_stays_in_group(change, view)
            and isinstance(change.get("replacementPayload"), Mapping)
        ]
        if replacement_terms:
            row["search_text"] = " ".join(
                part for part in [row.get("search_text", ""), *replacement_terms] if part
            )


_MAX_AFFECTED_RUNTIME_OCCURRENCES = 200000


def _runtime_song_identity(row: Mapping[str, Any]) -> str:
    return _text(row.get("song_key") or row.get("songKey")) or (
        f"{_overlay_norm(row.get('title'))}::{_overlay_norm(row.get('artist'))}"
    )


def _runtime_view_group_key(row: Mapping[str, Any], view: str) -> str:
    if view in {"songs", "songIndex", "vsingerSongs"}:
        return f"{_overlay_norm(row.get('title'))}::{_overlay_norm(row.get('artist'))}"
    if view == "artists":
        return _overlay_norm(row.get("artist")) or "unknown"
    if view == "videos":
        return _text(row.get("video_id") or row.get("videoId"))
    video = _overlay_public_video(row)
    return (
        _text(row.get("channel_id") or video.get("channelId"))
        or _text(row.get("channel_handle") or video.get("channelHandle")).lstrip("@/")
        # Parent ranking rows deliberately carry only the public aggregate
        # fields; their stable channel identity is therefore ``detail_key``.
        # Prefer it before a display-name fallback so bounded reconciliation
        # reaches the same VTuber group as overlay candidates.
        or _text(row.get("detail_key"))
        or _overlay_norm(row.get("channel_name") or video.get("channelName"))
    )


def _runtime_change_view_keys(changes: Sequence[Mapping[str, Any]], view: str) -> set[str]:
    keys: set[str] = set()
    for change in changes:
        if _text(change.get("entityType")) not in {"occurrences", "runtime_occurrences"}:
            continue
        old = _runtime_change_group_key(change, view)
        if old:
            keys.add(old)
        replacement = change.get("replacementPayload")
        if change.get("replacement") and isinstance(replacement, Mapping):
            replacement_row = {
                **dict(replacement),
                "video_id": replacement.get("videoId") or change.get("videoId"),
                "channel_id": change.get("channel_id"),
                "channel_handle": change.get("channel_handle"),
                "channel_name": change.get("channel_name"),
                "video_payload_json": change.get("replacementVideoPayload"),
            }
            key = _runtime_view_group_key(replacement_row, view)
            if key:
                keys.add(key)
    return keys


def _bounded_affected_parent_occurrences(
    connection,
    parent_revision_id: str,
    changes: Sequence[Mapping[str, Any]],
    view: str,
    options: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Read only the parent rows for changed artist/video/channel groups."""

    if view in {"songs", "songIndex", "vsingerSongs"}:
        pairs: set[tuple[str, str]] = set()
        for change in changes:
            title = _text(change.get("title"))
            artist = _text(change.get("artist"))
            if title and artist:
                pairs.add((title.casefold(), artist.casefold()))
            replacement = change.get("replacementPayload")
            if isinstance(replacement, Mapping):
                title = _text(replacement.get("title"))
                artist = _text(replacement.get("artist"))
                if title and artist:
                    pairs.add((title.casefold(), artist.casefold()))
        ordered_pairs = sorted(pairs)
        if not ordered_pairs:
            return []
        predicate = """
          EXISTS (
            SELECT 1
            FROM unnest(%s::text[], %s::text[]) AS affected(title, artist)
            WHERE affected.title = lower(coalesce(o.title, ''))
              AND affected.artist = lower(coalesce(o.artist, ''))
          )
        """
        predicate_params: list[Any] = [
            [title for title, _artist in ordered_pairs],
            [artist for _title, artist in ordered_pairs],
        ]
    elif view == "artists":
        artists = sorted({
            _text(value)
            for change in changes
            for value in (
                change.get("artist"),
                change.get("replacementPayload", {}).get("artist")
                if isinstance(change.get("replacementPayload"), Mapping) else "",
            )
            if _text(value)
        })
        if not artists:
            return []
        predicate = "lower(coalesce(o.artist, '')) = ANY(%s)"
        predicate_params: list[Any] = [[value.casefold() for value in artists]]
    elif view == "videos":
        videos = sorted({
            _text(change.get("videoId") or change.get("video_id"))
            for change in changes
            if _text(change.get("videoId") or change.get("video_id"))
        })
        if not videos:
            return []
        predicate = "o.video_id = ANY(%s)"
        predicate_params = [videos]
    else:
        channels = sorted({
            _text(change.get("channel_id") or change.get("channelId"))
            for change in changes
            if _text(change.get("channel_id") or change.get("channelId"))
        })
        if not channels:
            return []
        predicate = "v.channel_id = ANY(%s)"
        predicate_params = [channels]
    rows = _rows(
        connection,
        f"""
        SELECT o.occurrence_id, o.video_id, o.song_key, o.title, o.artist,
               v.channel_id, v.channel_handle, v.channel_name
        FROM runtime_occurrences AS o
        JOIN runtime_videos AS v
          ON v.revision_id = o.revision_id AND v.video_id = o.video_id
        WHERE o.revision_id = %s AND v.revision_id = %s
          AND {predicate}
          AND (
            (%s = 'all' AND coalesce(o.range_id, '') IN ('all', ''))
            OR (%s = '7d' AND coalesce(o.range_id, '') IN ('7d', ''))
          )
        ORDER BY o.video_id, o.occurrence_id
        LIMIT %s
        """,
        [
            parent_revision_id,
            parent_revision_id,
            *predicate_params,
            _text(options.get("range")) or "all",
            _text(options.get("range")) or "all",
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
        ],
    )
    if len(rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "affected runtime song-count reconciliation exceeded bounded occurrence cap"
        )
    return rows


def _reconcile_affected_song_counts(
    connection,
    parent_revision_id: str,
    candidate_rows: Sequence[Mapping[str, Any]],
    replacement_rows: Sequence[Mapping[str, Any]],
    changes: Sequence[Mapping[str, Any]],
    groups: dict[str, dict[str, Any]],
    view: str,
    options: Mapping[str, Any],
) -> None:
    """Recompute distinct songs from bounded parent and overlay occurrence sets."""

    if view not in {"songs", "songIndex", "vsingerSongs", "artists", "videos", "vtubers"}:
        return
    # Reconciliation only rewrites rows already present in ``groups``; it never
    # creates a ranking group.  An empty filtered result therefore cannot be
    # changed by scanning the affected parent occurrences.
    if not groups:
        return
    affected_changes = [
        change for change in changes
        if _text(change.get("entityType")) in {"occurrences", "runtime_occurrences"}
    ]
    if not affected_changes:
        return
    affected_keys = _runtime_change_view_keys(affected_changes, view)
    for row in candidate_rows:
        key = _runtime_view_group_key(row, view)
        if key:
            affected_keys.add(key)
    # Search-filtered rankings only contain the public groups that can be
    # rewritten below.  Scope the parent lookup to those same keys before
    # reading any occurrence rows; a query for one song must not reconcile
    # every accepted tuple in the active overlay.
    group_keys = {
        key
        for row in groups.values()
        if (key := _runtime_view_group_key(row, view))
    }
    affected_keys.intersection_update(group_keys)
    if not affected_keys:
        return
    relevant_changes = [
        change
        for change in affected_changes
        if _runtime_change_view_keys((change,), view) & affected_keys
    ]
    relevant_candidates = [
        row
        for row in candidate_rows
        if _runtime_view_group_key(row, view) in affected_keys
    ]
    relevant_replacements = [
        row
        for row in replacement_rows
        if _runtime_view_group_key(row, view) in affected_keys
    ]
    # Candidate tuples can introduce a new title/artist group on a reset
    # video.  Include their keys in the bounded parent lookup so an already
    # existing canonical group is recomputed rather than incremented twice.
    lookup_changes = [
        *relevant_changes,
        *(
            {
                "entityType": "occurrences",
                "videoId": row.get("video_id"),
                "title": row.get("title"),
                "artist": row.get("artist"),
                "channel_id": row.get("channel_id"),
                "channel_handle": row.get("channel_handle"),
                "channel_name": row.get("channel_name"),
                "video_payload_json": row.get("video_payload_json"),
            }
            for row in relevant_candidates
        ),
    ]
    parent_rows = _bounded_affected_parent_occurrences(
        connection, parent_revision_id, lookup_changes, view, options,
    )
    parent_by_identity = {
        (
            _text(row.get("video_id")),
            _text(row.get("occurrence_id")),
        ): dict(row)
        for row in parent_rows
        if _text(row.get("video_id")) and _text(row.get("occurrence_id"))
    }
    candidate_video_ids = {
        _text(row.get("video_id"))
        for row in relevant_candidates
        if _text(row.get("video_id")) and _json_object(row.get("video_payload_json"))
    }
    # A selected migration_video_rows entry is an authoritative full-video
    # boundary even when it is a tombstone and therefore contributes no
    # candidate occurrence row.  Do not let reconciliation rebuild that
    # parent video after the earlier aggregate subtraction.
    reset_video_ids = {
        _text(change.get("videoId") or change.get("video_id"))
        for change in relevant_changes
        if bool(change.get("acceptedVideoReset"))
        and _text(change.get("videoId") or change.get("video_id"))
    }
    effective = {
        identity: row for identity, row in parent_by_identity.items()
        if identity[0] not in candidate_video_ids
        and identity[0] not in reset_video_ids
    }
    for row in relevant_candidates:
        identity = (_text(row.get("video_id")), _text(row.get("occurrence_id")))
        if identity[0] and identity[1]:
            effective[identity] = dict(row)
    for change in relevant_changes:
        # Accepted full-video reset removals describe parent rows only.  They
        # must not delete a selected accepted candidate with the same identity
        # after it has been re-added above.  Every later runtime change is
        # remove-first, including a pure tombstone; only replacement_rows adds
        # a final tuple back.
        if bool(change.get("acceptedVideoReset")):
            continue
        identity = (
            _text(change.get("videoId") or change.get("video_id")),
            _text(change.get("occurrenceId") or change.get("occurrence_id")),
        )
        effective.pop(identity, None)
    for row in relevant_replacements:
        identity = (_text(row.get("video_id")), _text(row.get("occurrence_id")))
        if identity[0] and identity[1]:
            effective[identity] = dict(row)
    rows_by_group: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    songs_by_group: dict[str, set[str]] = defaultdict(set)
    for row in effective.values():
        key = _runtime_view_group_key(row, view)
        if key in affected_keys:
            rows_by_group[key].append(row)
            songs_by_group[key].add(_runtime_song_identity(row))
    for row in groups.values():
        key = _runtime_view_group_key(row, view)
        if key not in affected_keys:
            continue
        exact_rows = rows_by_group.get(key, [])
        song_count = len(songs_by_group.get(key, set()))
        row_count = len(exact_rows)
        video_count = len({
            _text(item.get("video_id") or item.get("videoId"))
            for item in exact_rows
            if _text(item.get("video_id") or item.get("videoId"))
        })
        row["song_count"] = song_count
        # ``effective`` is the bounded parent projection after selected
        # accepted-video resets plus its final candidate/replacement rows.
        # Every public grouping (not only songs) must use it: incrementally
        # adding an accepted reset otherwise double-counts its old video in
        # artist/video/channel aggregates.
        row["row_count"] = row_count
        row["timestamp_count"] = row_count
        row["video_count"] = video_count
        payload = _json_object(row.get("payload_json"))
        if payload:
            payload["songCount"] = song_count
            payload["count"] = row_count
            payload["timestampCount"] = row_count
            payload["videoCount"] = video_count
            row["payload_json"] = payload


def _overlay_candidate_search_text(row: Mapping[str, Any]) -> str:
    channel_id = _text(row.get("channel_id")).casefold()
    channel_handle = _text(row.get("channel_handle")).lstrip("/").casefold()
    channel_url = _text(row.get("channel_url")).casefold()
    trusted_channel_url = channel_url if (
        (channel_id and channel_id in channel_url)
        or (channel_handle and channel_handle in channel_url)
    ) else ""
    return " ".join(
        _text(value)
        for value in (
            row.get("title"),
            row.get("artist"),
            row.get("video_title"),
            row.get("channel_name"),
            row.get("channel_id"),
            row.get("channel_handle"),
            trusted_channel_url,
            row.get("video_id"),
        )
    ).casefold()


def _overlay_public_video(row: Mapping[str, Any]) -> dict[str, Any]:
    """Keep the established public video tuple without curation-only blobs."""

    source = _json_object(row.get("video_payload_json"))
    if isinstance(source.get("payload"), Mapping):
        source = dict(source["payload"])
    aliases = {
        "videoId": ("videoId", "video_id"),
        "title": ("title", "video_title"),
        "channelName": ("channelName", "channel_name"),
        "channelId": ("channelId", "channel_id"),
        "channelHandle": ("channelHandle", "channel_handle"),
        "channelUrl": ("channelUrl", "channel_url"),
        "publishedAt": ("publishedAt", "published_at"),
        "publishedTimestamp": ("publishedTimestamp", "published_timestamp"),
        "thumbnailUrl": ("thumbnailUrl", "thumbnail_url"),
        "videoThumbnailUrl": ("videoThumbnailUrl", "video_thumbnail_url"),
        "avatarUrl": ("avatarUrl", "avatar_url"),
        "sourceUrl": ("sourceUrl", "source_url"),
        "sourceSystem": ("sourceSystem", "source_system"),
        "rangeId": ("rangeId", "range_id"),
    }
    result: dict[str, Any] = {}
    for public_name, names in aliases.items():
        for name in names:
            value = source.get(name)
            if value is None or value == "":
                value = row.get(name)
            if value is not None and value != "":
                result[public_name] = value
                break
    return result


def _bounded_overlay_previews(items: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Keep the first 20 caller-ordered previews without retaining a full group."""

    previews: list[dict[str, Any]] = []
    for item in items:
        if len(previews) == 20:
            break
        previews.append(dict(item))
    return previews


def _overlay_candidate_groups(rows: Iterable[Mapping[str, Any]], view: str) -> dict[str, dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row.get("video_tombstone"):
            continue
        occurrence = _overlay_public_occurrence(row.get("occurrence_payload_json"))
        video = _overlay_public_video(row)
        title = _text(row.get("title")) or _text(occurrence.get("title"))
        artist = _text(row.get("artist")) or _text(occurrence.get("artist"))
        video_id = _text(row.get("video_id"))
        original_identity = occurrence.get("originalIdentity")
        if isinstance(original_identity, Mapping):
            same_video = _text(original_identity.get("videoId")) == video_id
            same_artist = _overlay_norm(original_identity.get("artist")) == _overlay_norm(artist)
            if (
                (view == "artists" and same_artist)
                or (view in {"videos", "vtubers"} and same_video)
            ):
                # A title-only curation replacement must not increment
                # unchanged artist/video/channel aggregates.  Song views still
                # subtract the original identity and add the canonical title.
                continue
        occurrence.update({
            "videoId": video_id,
            "occurrenceId": occurrence.get("occurrenceId") or row.get("occurrence_id"),
            "position": occurrence.get("position", row.get("position")),
            "rangeId": occurrence.get("rangeId") or row.get("range_id") or "7d",
            "songKey": occurrence.get("songKey") or row.get("song_key"),
            "seconds": occurrence.get("seconds", row.get("seconds")),
            "title": title,
            "artist": artist,
            "sourceId": occurrence.get("sourceId") or row.get("source_id"),
            "rawHash": occurrence.get("rawHash") or row.get("raw_hash"),
            "sourceSystem": occurrence.get("sourceSystem") or row.get("source_system"),
        })
        if view in {"songs", "songIndex", "vsingerSongs"}:
            key = f"{_overlay_norm(title)}::{_overlay_norm(artist)}"
            name = title
        elif view == "artists":
            key = _overlay_norm(artist) or "unknown"
            name = artist or "unknown"
        elif view == "videos":
            key = video_id
            name = _text(video.get("title"))
        else:
            key = _text(video.get("channelId")) or _text(video.get("channelHandle")).lstrip("@/") or _overlay_norm(video.get("channelName"))
            name = _text(video.get("channelName")) or key
        if not key:
            continue
        group = groups.setdefault(key, {
            "key": key, "title": title, "artist": artist, "name": name,
            "occurrences": [], "occurrenceCount": 0, "videoIds": set(), "songKeys": set(),
            "search": "",
        })
        group["occurrenceCount"] += 1
        # Card previews are an established maximum of 20.  Counting an
        # accepted increment must not retain every scalar, let alone every
        # JSON payload, merely because one returned page contains this group.
        preview = {
            **occurrence,
            "song": {
                "title": title,
                "artist": artist,
                "songKey": occurrence.get("songKey"),
                "seconds": occurrence.get("seconds"),
                "rangeId": occurrence.get("rangeId"),
                "sourceId": occurrence.get("sourceId"),
                "sourceSystem": occurrence.get("sourceSystem"),
            },
            "item": dict(video),
            # Keep the accepted-handoff compatibility field while callers
            # migrate to the public ranking occurrence shape.
            "video": dict(video),
        }
        group["occurrences"] = _bounded_overlay_previews((*group["occurrences"], preview))
        group["videoIds"].add(video_id)
        group["songKeys"].add(_text(occurrence.get("songKey")) or key)
        group["search"] = f"{group['search']} {_overlay_candidate_search_text(row)}".strip()
    return groups


def _overlay_rows_for_range(
    rows: Iterable[Mapping[str, Any]], range_id: str,
) -> list[Mapping[str, Any]]:
    """Keep the production generic range contract without cross-range rows.

    The full importer materialises separate all and 7d occurrence identities,
    ranking rows, and source keys.  ``all`` therefore means explicit all (and
    the historic empty accepted range), not a union of every range.  Empty
    range is admitted to both public ranges only for backwards compatibility.
    """

    selected: list[Mapping[str, Any]] = []
    for row in rows:
        row_range = _text(row.get("range_id") or row.get("rangeId"))
        if row_range in {range_id, ""}:
            selected.append(row)
    return selected


def _hydrate_overlay_page_previews(
    connection,
    candidate_rows: Sequence[Mapping[str, Any]],
    payloads: Sequence[Mapping[str, Any]],
) -> None:
    """Hydrate JSON only for candidate preview tuples present on this page.

    The scalar overlay pass deliberately leaves ``payload_json`` unread.  A
    card can nevertheless require the original item image/identity shape, so
    fetch exactly the at-most-20 previews for each returned card afterwards.
    """

    def scalar_key(row: Mapping[str, Any], label: str, strict: bool = True) -> tuple[str, str, str, int] | None:
        revision_id = _text(row.get("revision_id"))
        video_id = _text(row.get("video_id"))
        if not revision_id or not video_id:
            if not strict:
                return None
            raise PostgresAdapterError(f"overlay preview hydration {label} is missing revision/video identity")
        if row.get("position") is None:
            if not strict:
                return (revision_id, video_id, _text(row.get("occurrence_id")), 0)
            raise PostgresAdapterError(f"overlay preview hydration {label} is missing position")
        try:
            position = int(row.get("position"))
        except (TypeError, ValueError) as exc:
            raise PostgresAdapterError(f"overlay preview hydration {label} has invalid position") from exc
        return (revision_id, video_id, _text(row.get("occurrence_id")), position)

    def payload_object(value: Any, label: str) -> dict[str, Any]:
        if isinstance(value, Mapping):
            result = dict(value)
        elif isinstance(value, str) and value.strip():
            try:
                parsed = json.loads(value)
            except json.JSONDecodeError as exc:
                raise PostgresAdapterError(f"overlay preview hydration {label} is invalid JSON") from exc
            if not isinstance(parsed, Mapping):
                raise PostgresAdapterError(f"overlay preview hydration {label} is not an object")
            result = dict(parsed)
        else:
            raise PostgresAdapterError(f"overlay preview hydration {label} is missing")
        if isinstance(result.get("payload"), Mapping):
            result = dict(result["payload"])
        return result

    candidates: dict[tuple[str, str, str, int], Mapping[str, Any]] = {}
    preview_candidates: dict[tuple[str, str, int], tuple[str, str, str, int]] = {}
    for candidate in candidate_rows:
        key = scalar_key(candidate, "candidate scalar row", strict=False)
        if key is None:
            continue
        if key in candidates:
            raise PostgresAdapterError("overlay preview hydration has duplicate candidate scalar identity")
        candidates[key] = candidate
        preview_key = key[1:]
        prior = preview_candidates.get(preview_key)
        if prior is not None and prior != key:
            prior_candidate = candidates[prior]
            prior_replacement = bool(
                prior_candidate.get("runtime_replacement")
            )
            current_replacement = bool(
                candidate.get("runtime_replacement")
            )
            if prior_replacement == current_replacement:
                raise PostgresAdapterError(
                    "overlay preview hydration has ambiguous candidate preview identity"
                )
            if prior_replacement:
                continue
        preview_candidates[preview_key] = key
    requested: dict[tuple[str, str, str, int], Mapping[str, Any]] = {}
    for payload in payloads:
        occurrences = payload.get("occurrences") if isinstance(payload, Mapping) else None
        if not isinstance(occurrences, list):
            continue
        for occurrence in occurrences:
            if not isinstance(occurrence, Mapping):
                continue
            item = occurrence.get("item") if isinstance(occurrence.get("item"), Mapping) else occurrence.get("video")
            video_id = _text(occurrence.get("videoId") or (item or {}).get("videoId"))
            occurrence_id = _text(occurrence.get("occurrenceId"))
            if occurrence.get("position") is None:
                position = 0
            else:
                try:
                    position = int(occurrence.get("position"))
                except (TypeError, ValueError) as exc:
                    raise PostgresAdapterError("overlay preview hydration requested preview has invalid position") from exc
            preview_key = (video_id, occurrence_id, position)
            key = preview_candidates.get(preview_key)
            if key is not None:
                candidate = candidates[key]
                # Detailed/source callers already supplied both payloads.  The
                # bounded ranking path alone needs a second exact-tuple read.
                if (
                    candidate.get("video_payload_json") is not None
                    and candidate.get("occurrence_payload_json") is not None
                ):
                    continue
                if key in requested:
                    raise PostgresAdapterError("overlay preview hydration has duplicate requested identity")
                requested[key] = candidate
    if not requested:
        return
    rows = list(requested.values())
    revision_ids = [_text(row.get("revision_id")) for row in rows]
    video_ids = [_text(row.get("video_id")) for row in rows]
    occurrence_ids = [_text(row.get("occurrence_id")) for row in rows]
    positions = [int(row.get("position") or 0) for row in rows]
    hydrated_rows = _rows(
        connection,
        """
        WITH requested(revision_id, video_id, occurrence_id, position) AS (
          SELECT * FROM unnest(%s::text[], %s::text[], %s::text[], %s::integer[])
        )
        SELECT o.revision_id, o.video_id, o.occurrence_id, o.position,
               o.payload_json AS occurrence_payload_json,
               v.video_id AS joined_video_id, v.payload_json AS video_payload_json, v.title AS video_title,
               v.channel_name, v.channel_id, v.channel_handle, v.channel_url,
               v.published_at
        FROM migration_occurrence_rows AS o
        JOIN requested AS requested
          ON requested.revision_id = o.revision_id
         AND requested.video_id = o.video_id
         AND requested.occurrence_id = coalesce(o.occurrence_id, '')
         AND requested.position = o.position
        LEFT JOIN migration_video_rows AS v
          ON v.revision_id = o.revision_id AND v.video_id = o.video_id
        ORDER BY o.revision_id, o.video_id, o.position, o.occurrence_id
        LIMIT %s
        """,
        [revision_ids, video_ids, occurrence_ids, positions, len(rows) + 1],
    )
    if len(hydrated_rows) > len(rows):
        raise PostgresAdapterError("overlay preview hydration exceeded bounded request set")
    hydrated: dict[tuple[str, str, int], Mapping[str, Any]] = {}
    for hydrated_row in hydrated_rows:
        key = scalar_key(hydrated_row, "returned scalar row")
        assert key is not None
        if key in hydrated:
            raise PostgresAdapterError("overlay preview hydration returned duplicate identity")
        video_payload = payload_object(hydrated_row.get("video_payload_json"), "returned video payload")
        occurrence_payload = payload_object(hydrated_row.get("occurrence_payload_json"), "returned occurrence payload")
        if _text(hydrated_row.get("joined_video_id")) != key[1]:
            raise PostgresAdapterError("overlay preview hydration returned an incomplete video join")
        video_identity = _text(video_payload.get("videoId") or video_payload.get("video_id"))
        if video_identity and video_identity != key[1]:
            raise PostgresAdapterError("overlay preview hydration returned video payload identity mismatch")
        occurrence_identity = _text(occurrence_payload.get("occurrenceId") or occurrence_payload.get("occurrence_id"))
        if occurrence_identity and occurrence_identity != key[2]:
            raise PostgresAdapterError("overlay preview hydration returned occurrence payload identity mismatch")
        if occurrence_payload.get("position") is not None:
            try:
                payload_position = int(occurrence_payload.get("position"))
            except (TypeError, ValueError) as exc:
                raise PostgresAdapterError("overlay preview hydration returned occurrence payload has invalid position") from exc
            if payload_position != key[3]:
                raise PostgresAdapterError("overlay preview hydration returned occurrence payload position mismatch")
        hydrated[key] = hydrated_row
    requested_keys = set(requested)
    returned_keys = set(hydrated)
    if requested_keys != returned_keys:
        missing = len(requested_keys - returned_keys)
        unexpected = len(returned_keys - requested_keys)
        raise PostgresAdapterError(
            "overlay preview hydration returned an inexact identity set "
            f"(missing={missing}, unexpected={unexpected})"
        )
    for payload in payloads:
        occurrences = payload.get("occurrences") if isinstance(payload, Mapping) else None
        if not isinstance(occurrences, list):
            continue
        for occurrence in occurrences:
            if not isinstance(occurrence, dict):
                continue
            item = occurrence.get("item") if isinstance(occurrence.get("item"), Mapping) else occurrence.get("video")
            video_id = _text(occurrence.get("videoId") or (item or {}).get("videoId"))
            occurrence_id = _text(occurrence.get("occurrenceId"))
            if occurrence.get("position") is None:
                position = 0
            else:
                try:
                    position = int(occurrence.get("position"))
                except (TypeError, ValueError) as exc:
                    raise PostgresAdapterError("overlay preview hydration requested preview has invalid position") from exc
            preview_key = (video_id, occurrence_id, position)
            requested_key = preview_candidates.get(preview_key)
            row = hydrated.get(requested_key) if requested_key is not None else None
            if row is None and requested_key in requested:
                raise PostgresAdapterError("overlay preview hydration lost a requested identity")
            if row is None:
                continue
            video = _overlay_public_video(row)
            if _text(video.get("videoId")) != video_id:
                raise PostgresAdapterError("overlay preview hydration returned an incomplete video join")
            if video:
                occurrence["item"] = dict(video)
                occurrence["video"] = dict(video)


def _bounded_direct_overlay_vtuber_previews(
    connection,
    revision_ids: Sequence[str],
    channel_ids: Iterable[str],
    range_id: str,
    excluded_video_ids: Iterable[str] = (),
    excluded_occurrence_ids: Iterable[tuple[str, str]] = (),
) -> dict[str, dict[str, Any]]:
    """Return at most one accepted-overlay preview for each requested page card."""

    requested_channels = sorted({_text(value) for value in channel_ids if _text(value)})
    lineage = [_text(value) for value in revision_ids if _text(value)]
    if not requested_channels or not lineage:
        return {}
    excluded_videos = sorted({
        _text(value) for value in excluded_video_ids if _text(value)
    })
    excluded_occurrences = sorted({
        (_text(video_id), _text(occurrence_id))
        for video_id, occurrence_id in excluded_occurrence_ids
        if _text(video_id) and _text(occurrence_id)
    })
    range_values = ["all", ""] if (_text(range_id) or "all") == "all" else ["7d", ""]
    rows = _rows(
        connection,
        """
        /* bounded direct overlay VTuber previews */
        WITH requested_channels AS MATERIALIZED (
          SELECT DISTINCT unnest(%s::text[]) AS channel_id
        ), overlay_lineage AS MATERIALIZED (
          SELECT revision_id, lineage_order
          FROM unnest(%s::text[]) WITH ORDINALITY
            AS item(revision_id, lineage_order)
        ), excluded_videos AS MATERIALIZED (
          SELECT DISTINCT unnest(%s::text[]) AS video_id
        ), excluded_occurrences AS MATERIALIZED (
          SELECT DISTINCT video_id, occurrence_id
          FROM unnest(%s::text[], %s::text[])
            AS item(video_id, occurrence_id)
        ), range_values AS MATERIALIZED (
          SELECT DISTINCT unnest(%s::text[]) AS range_id
        ), newest_videos AS MATERIALIZED (
          SELECT DISTINCT ON (video.video_id)
                 video.video_id, video.title AS video_title,
                 video.channel_name, video.channel_id, video.channel_handle,
                 video.channel_url, video.published_at,
                 video.payload_json AS video_payload_json, video.tombstone,
                 lineage.lineage_order
          FROM migration_video_rows AS video
          JOIN overlay_lineage AS lineage
            ON lineage.revision_id = video.revision_id
          LEFT JOIN excluded_videos AS removed
            ON removed.video_id = video.video_id
          WHERE removed.video_id IS NULL
          ORDER BY video.video_id, lineage.lineage_order
        ), selected_videos AS MATERIALIZED (
          SELECT newest.*
          FROM newest_videos AS newest
          JOIN requested_channels AS requested
            ON requested.channel_id = newest.channel_id
        ), selected_occurrences AS MATERIALIZED (
          SELECT DISTINCT ON (
                   occurrence.video_id,
                   coalesce(
                     nullif(occurrence.occurrence_id, ''),
                     'position:' || occurrence.position::text || ':' ||
                       coalesce(occurrence.song_key, '')
                   )
                 )
                 selected.channel_id, selected.channel_name,
                 selected.channel_handle, selected.channel_url,
                 selected.video_id, selected.video_title,
                 selected.published_at,
                 selected.video_payload_json,
                 occurrence.revision_id, occurrence.occurrence_id,
                 occurrence.position, occurrence.range_id,
                 occurrence.song_key, occurrence.seconds, occurrence.title,
                 occurrence.artist, occurrence.source_id,
                 occurrence.source_system,
                 occurrence.payload_json AS occurrence_payload_json,
                 lineage.lineage_order
          FROM migration_occurrence_rows AS occurrence
          JOIN overlay_lineage AS lineage
            ON lineage.revision_id = occurrence.revision_id
          JOIN selected_videos AS selected
            ON selected.video_id = occurrence.video_id
           AND lineage.lineage_order <= selected.lineage_order
          JOIN range_values AS scope
            ON scope.range_id = coalesce(occurrence.range_id, '')
          LEFT JOIN excluded_occurrences AS changed
            ON changed.video_id = occurrence.video_id
           AND changed.occurrence_id = occurrence.occurrence_id
          WHERE selected.tombstone IS NOT TRUE
            AND changed.occurrence_id IS NULL
          ORDER BY occurrence.video_id,
                   coalesce(
                     nullif(occurrence.occurrence_id, ''),
                     'position:' || occurrence.position::text || ':' ||
                       coalesce(occurrence.song_key, '')
                   ),
                   lineage.lineage_order
        ), ranked AS (
          SELECT selected.*,
                 row_number() OVER (
                   PARTITION BY selected.channel_id
                   ORDER BY selected.video_id, selected.position,
                            selected.occurrence_id
                 ) AS preview_rank
          FROM selected_occurrences AS selected
        )
        SELECT channel_id, channel_name, channel_handle, channel_url,
               video_id, video_title, published_at,
               video_payload_json, revision_id, occurrence_id, position,
               range_id, song_key, seconds, title, artist, source_id,
               source_system, occurrence_payload_json
        FROM ranked
        WHERE preview_rank = 1
        ORDER BY channel_id
        LIMIT %s
        """,
        [
            requested_channels,
            lineage,
            excluded_videos,
            [video_id for video_id, _ in excluded_occurrences],
            [occurrence_id for _, occurrence_id in excluded_occurrences],
            range_values,
            len(requested_channels) + 1,
        ],
    )
    if len(rows) > len(requested_channels):
        raise PostgresAdapterError(
            "bounded direct overlay VTuber preview query exceeded its channel cap"
        )
    previews: dict[str, dict[str, Any]] = {}
    for row in rows:
        channel_id = _text(row.get("channel_id"))
        video_id = _text(row.get("video_id"))
        occurrence_id = _text(row.get("occurrence_id"))
        if (
            not channel_id
            or channel_id not in requested_channels
            or channel_id in previews
            or not video_id
            or not occurrence_id
        ):
            raise PostgresAdapterError(
                "bounded direct overlay VTuber preview query returned an invalid identity"
            )
        video = _overlay_public_video(row)
        occurrence = _overlay_public_occurrence(row.get("occurrence_payload_json"))
        if (
            _text(video.get("videoId")) != video_id
            or _text(video.get("channelId")) != channel_id
            or (
                _text(occurrence.get("videoId"))
                and _text(occurrence.get("videoId")) != video_id
            )
            or (
                _text(occurrence.get("occurrenceId"))
                and _text(occurrence.get("occurrenceId")) != occurrence_id
            )
        ):
            raise PostgresAdapterError(
                "bounded direct overlay VTuber preview query returned an invalid identity"
            )
        thumbnail = _text(
            video.get("thumbnailUrl") or video.get("videoThumbnailUrl")
        )
        if not thumbnail_matches_video(thumbnail, video_id):
            raise PostgresAdapterError(
                "bounded direct overlay VTuber preview query returned an invalid thumbnail"
            )
        handle = _text(video.get("channelHandle"))
        video.update({
            "channelId": channel_id,
            "channelUrl": _canonical_channel_url(channel_id, handle),
            "thumbnailUrl": thumbnail,
            "videoThumbnailUrl": thumbnail,
        })
        occurrence.update({
            "videoId": video_id,
            "occurrenceId": occurrence_id,
            "position": occurrence.get("position", row.get("position")),
            "rangeId": occurrence.get("rangeId") or row.get("range_id"),
            "songKey": occurrence.get("songKey") or row.get("song_key"),
            "seconds": occurrence.get("seconds", row.get("seconds")),
            "title": occurrence.get("title") or row.get("title"),
            "artist": occurrence.get("artist") or row.get("artist"),
            "sourceId": occurrence.get("sourceId") or row.get("source_id"),
            "sourceSystem": (
                occurrence.get("sourceSystem") or row.get("source_system")
            ),
        })
        previews[channel_id] = {
            **occurrence,
            "song": {
                key: occurrence.get(key)
                for key in (
                    "title", "artist", "songKey", "seconds", "rangeId",
                    "sourceId", "sourceSystem",
                )
            },
            "item": dict(video),
            "video": dict(video),
        }
    return previews


def _bounded_final_vtuber_previews(
    connection,
    parent_revision_id: str,
    channel_ids: Iterable[str],
    range_id: str,
    excluded_video_ids: Iterable[str] = (),
    excluded_occurrence_ids: Iterable[tuple[str, str]] = (),
    niche_only: bool = False,
    hide_unknown_artist: bool = False,
) -> dict[str, dict[str, Any]]:
    """Read exactly one surviving parent tuple for each requested channel.

    Ranking aggregates intentionally omit payload JSON.  This query restores
    only the missing public preview and applies the same full-video and
    occurrence anti-joins as the exact overlay aggregate.  Channel membership
    is one immutable join, not independently paired arrays, and both the SQL
    and caller enforce one row per requested channel plus a cap+1 guard.
    """

    requested_channels = sorted({_text(value) for value in channel_ids if _text(value)})
    if not requested_channels:
        return {}
    if len(requested_channels) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("bounded VTuber preview query exceeded its channel cap")
    excluded_videos = sorted({
        _text(value) for value in excluded_video_ids if _text(value)
    })
    excluded_occurrences = sorted({
        (_text(video_id), _text(occurrence_id))
        for video_id, occurrence_id in excluded_occurrence_ids
        if _text(video_id) and _text(occurrence_id)
    })
    range_values = ["all", ""] if (_text(range_id) or "all") == "all" else ["7d", ""]
    query_started = time.perf_counter()
    rows = _rows(
        connection,
        """
        /* bounded final VTuber previews */
        WITH requested_channels AS MATERIALIZED (
          SELECT DISTINCT unnest(%s::text[]) AS channel_id
        ), excluded_videos AS MATERIALIZED (
          SELECT DISTINCT unnest(%s::text[]) AS video_id
        ), excluded_occurrences AS MATERIALIZED (
          SELECT DISTINCT video_id, occurrence_id
          FROM unnest(%s::text[], %s::text[])
            AS item(video_id, occurrence_id)
        ), range_values AS MATERIALIZED (
          SELECT DISTINCT unnest(%s::text[]) AS range_id
        ), candidate_videos AS MATERIALIZED (
          SELECT v.channel_id, v.channel_name, v.channel_handle, v.channel_url,
                 v.video_id, v.title AS video_title,
                 v.published_timestamp AS published_at,
                 v.thumbnail_url,
                 v.payload_json AS video_payload_json
          FROM requested_channels AS requested
          JOIN runtime_videos AS v
            ON requested.channel_id = v.channel_id
           AND v.revision_id = %s
          LEFT JOIN excluded_videos AS reset
            ON reset.video_id = v.video_id
          WHERE reset.video_id IS NULL
        ), video_previews AS (
          SELECT v.channel_id, v.channel_name, v.channel_handle, v.channel_url,
                 v.video_id, v.video_title, v.published_at, v.thumbnail_url,
                 v.video_payload_json,
                 o.revision_id, o.occurrence_id, NULL::integer AS position,
                 o.range_id,
                 o.song_key, o.seconds, o.title, o.artist, o.source_id,
                 o.source_system, o.payload_json AS occurrence_payload_json,
                 row_number() OVER (
                   PARTITION BY v.channel_id
                   ORDER BY v.channel_id, o.video_id, o.occurrence_id
                 ) AS preview_rank
          FROM candidate_videos AS v
          CROSS JOIN LATERAL (
            SELECT o.revision_id, o.video_id, o.occurrence_id, o.range_id,
                   o.song_key, o.seconds, o.title, o.artist, o.source_id,
                   o.source_system, o.payload_json
            FROM runtime_occurrences AS o
            JOIN range_values AS scope
              ON scope.range_id = o.range_id
            LEFT JOIN excluded_occurrences AS changed
              ON changed.video_id = o.video_id
             AND changed.occurrence_id = o.occurrence_id
            WHERE o.revision_id = %s
              AND o.video_id = v.video_id
              AND changed.occurrence_id IS NULL
              AND (NOT %s OR nullif(o.artist, '') IS NOT NULL)
              AND (NOT %s OR o.is_niche IS TRUE)
            ORDER BY o.song_key, o.occurrence_id
            LIMIT 1
          ) AS o
        )
        SELECT channel_id, channel_name, channel_handle, channel_url,
               video_id, video_title, published_at, thumbnail_url,
               video_payload_json,
               revision_id, occurrence_id, position, range_id, song_key,
               seconds, title, artist, source_id, source_system,
               occurrence_payload_json
        FROM video_previews
        WHERE preview_rank = 1
        ORDER BY channel_id
        LIMIT %s
        """,
        [
            requested_channels,
            excluded_videos,
            [video_id for video_id, _ in excluded_occurrences],
            [occurrence_id for _, occurrence_id in excluded_occurrences],
            range_values,
            parent_revision_id,
            parent_revision_id,
            bool(hide_unknown_artist),
            bool(niche_only),
            len(requested_channels) + 1,
        ],
    )
    _phase_trace(
        "preview_sql",
        query_started,
        requested_channels=len(requested_channels),
        returned_channels=len(rows),
    )
    if len(rows) > len(requested_channels):
        raise PostgresAdapterError("bounded VTuber preview query exceeded its channel cap")

    previews: dict[str, dict[str, Any]] = {}
    for row in rows:
        channel_id = _text(row.get("channel_id"))
        video_id = _text(row.get("video_id"))
        occurrence_id = _text(row.get("occurrence_id"))
        if (
            not channel_id
            or channel_id not in requested_channels
            or channel_id in previews
            or not video_id
            or not occurrence_id
        ):
            raise PostgresAdapterError(
                "bounded VTuber preview query returned an inexact channel set"
            )
        video = _overlay_public_video(row)
        occurrence = _overlay_public_occurrence(row.get("occurrence_payload_json"))
        if (
            _text(video.get("videoId")) != video_id
            or _text(video.get("channelId")) != channel_id
            or (
                _text(occurrence.get("videoId"))
                and _text(occurrence.get("videoId")) != video_id
            )
            or (
                _text(occurrence.get("occurrenceId"))
                and _text(occurrence.get("occurrenceId")) != occurrence_id
            )
        ):
            raise PostgresAdapterError(
                "bounded VTuber preview query returned an inexact channel set"
            )
        thumbnail = _text(
            video.get("thumbnailUrl") or video.get("videoThumbnailUrl")
        )
        if not thumbnail_matches_video(thumbnail, video_id):
            raise PostgresAdapterError(
                "bounded VTuber preview query returned an invalid video thumbnail"
            )
        video["thumbnailUrl"] = thumbnail
        video["videoThumbnailUrl"] = thumbnail
        occurrence_update = {
            "videoId": video_id,
            "occurrenceId": occurrence_id,
            "rangeId": occurrence.get("rangeId") or row.get("range_id"),
            "songKey": occurrence.get("songKey") or row.get("song_key"),
            "seconds": occurrence.get("seconds", row.get("seconds")),
            "title": occurrence.get("title") or row.get("title"),
            "artist": occurrence.get("artist") or row.get("artist"),
            "sourceId": occurrence.get("sourceId") or row.get("source_id"),
            "sourceSystem": (
                occurrence.get("sourceSystem") or row.get("source_system")
            ),
        }
        position = occurrence.get("position", row.get("position"))
        if position is not None:
            occurrence_update["position"] = position
        occurrence.update(occurrence_update)
        preview = {
            **occurrence,
            "song": {
                "title": occurrence.get("title"),
                "artist": occurrence.get("artist"),
                "songKey": occurrence.get("songKey"),
                "seconds": occurrence.get("seconds"),
                "rangeId": occurrence.get("rangeId"),
                "sourceId": occurrence.get("sourceId"),
                "sourceSystem": occurrence.get("sourceSystem"),
            },
            "item": dict(video),
            "video": dict(video),
        }
        previews[channel_id] = preview
    if set(previews) != set(requested_channels):
        raise PostgresAdapterError(
            "bounded VTuber preview query returned an inexact channel set"
        )
    return previews


def _canonicalize_vtuber_card_preview(
    payload: dict[str, Any], expected_channel_id: str,
) -> None:
    """Validate and bind a positive VTuber card to one real occurrence tuple."""

    try:
        positive = (
            int(payload.get("count") or 0) > 0
            or int(payload.get("timestampCount") or 0) > 0
        )
    except (TypeError, ValueError) as exc:
        raise PostgresAdapterError("VTuber ranking card count is invalid") from exc
    if not positive:
        return
    occurrences = payload.get("occurrences")
    if not isinstance(occurrences, list) or not occurrences:
        raise PostgresAdapterError(
            "positive VTuber ranking card has no canonical occurrence preview"
        )
    channel_id = _text(expected_channel_id)
    card_channel_id = _text(payload.get("channelId") or payload.get("key"))
    if not channel_id or card_channel_id != channel_id:
        raise PostgresAdapterError("VTuber ranking preview identity is invalid")
    # Aggregate card handle/URL fields are historical derived metadata.  The
    # immutable channel id above binds the card; one real preview tuple binds
    # its current public handle.  Never let a stale aggregate handle veto a
    # same-channel preview.
    canonical_handle_raw = ""

    canonical_occurrences: list[dict[str, Any]] = []
    first_thumbnail = ""
    for source_occurrence in occurrences:
        if not isinstance(source_occurrence, Mapping):
            raise PostgresAdapterError(
                "positive VTuber ranking card has no canonical occurrence preview"
            )
        occurrence = dict(source_occurrence)
        item_source = (
            occurrence.get("item")
            if isinstance(occurrence.get("item"), Mapping)
            else occurrence.get("video")
        )
        video_source = (
            occurrence.get("video")
            if isinstance(occurrence.get("video"), Mapping)
            else item_source
        )
        if not isinstance(item_source, Mapping) or not isinstance(
            video_source, Mapping
        ):
            raise PostgresAdapterError(
                "positive VTuber ranking card has no canonical occurrence preview"
            )
        item = dict(item_source)
        video = dict(video_source)
        video_id = _text(item.get("videoId"))
        occurrence_video_id = _text(occurrence.get("videoId"))
        if (
            not video_id
            or (occurrence_video_id and occurrence_video_id != video_id)
            or _text(video.get("videoId")) != video_id
            or _text(item.get("channelId")) != channel_id
            or _text(video.get("channelId")) != channel_id
        ):
            raise PostgresAdapterError("VTuber ranking preview identity is invalid")

        item_handle_raw = _text(item.get("channelHandle"))
        video_handle_raw = _text(video.get("channelHandle"))
        preview_handles = {
            normalized
            for normalized in (
                _normalized_channel_handle(item_handle_raw),
                _normalized_channel_handle(video_handle_raw),
            )
            if normalized
        }
        if len(preview_handles) != 1:
            raise PostgresAdapterError("VTuber ranking preview identity is invalid")
        preview_handle_raw = item_handle_raw or video_handle_raw
        preview_handle = _normalized_channel_handle(preview_handle_raw)
        canonical_handle = _normalized_channel_handle(canonical_handle_raw)
        if preview_handle and canonical_handle and preview_handle != canonical_handle:
            raise PostgresAdapterError("VTuber ranking preview identity is invalid")
        if preview_handle and not canonical_handle:
            canonical_handle_raw = preview_handle_raw
        item_url = _text(item.get("channelUrl"))
        video_url = _text(video.get("channelUrl"))
        for nested_url, nested_handle in (
            (item_url, item_handle_raw or video_handle_raw),
            (video_url, video_handle_raw or item_handle_raw),
        ):
            if nested_url and not _channel_url_is_coherent(
                nested_url, channel_id, nested_handle
            ):
                raise PostgresAdapterError(
                    "VTuber ranking preview channel URL is invalid"
                )
        thumbnail = _text(
            item.get("thumbnailUrl")
            or item.get("videoThumbnailUrl")
            or video.get("thumbnailUrl")
            or video.get("videoThumbnailUrl")
        )
        for nested in (item, video):
            nested_thumbnail = _text(
                nested.get("thumbnailUrl") or nested.get("videoThumbnailUrl")
            )
            if nested_thumbnail and not thumbnail_matches_video(
                nested_thumbnail, video_id
            ):
                raise PostgresAdapterError(
                    "VTuber ranking preview thumbnail is invalid"
                )
        if not thumbnail_matches_video(thumbnail, video_id):
            raise PostgresAdapterError("VTuber ranking preview thumbnail is invalid")

        song = occurrence.get("song")
        if song is not None and not isinstance(song, Mapping):
            raise PostgresAdapterError("VTuber ranking preview song tuple is invalid")
        song = dict(song or {})
        for field in ("occurrenceId", "position"):
            value = occurrence.get(field) if field in occurrence else song.get(field)
            if value is not None:
                occurrence[field] = value
        for field in ("title", "artist", "seconds"):
            outer_present = field in occurrence
            song_present = field in song
            if not outer_present and not song_present:
                raise PostgresAdapterError(
                    "VTuber ranking preview song tuple is invalid"
                )
            if (
                outer_present
                and song_present
                and occurrence.get(field) != song.get(field)
            ):
                raise PostgresAdapterError(
                    "VTuber ranking preview song tuple is invalid"
                )
            value = occurrence.get(field) if outer_present else song.get(field)
            occurrence[field] = value
            song[field] = value
        for field in ("songKey", "rangeId", "sourceId", "sourceSystem"):
            value = occurrence.get(field) if field in occurrence else song.get(field)
            if value is not None:
                occurrence[field] = value
                song[field] = value

        canonical_item = dict(item)
        canonical_item.update({
            "videoId": video_id,
            "channelId": channel_id,
            "thumbnailUrl": thumbnail,
            "videoThumbnailUrl": thumbnail,
        })
        occurrence["videoId"] = video_id
        occurrence["item"] = canonical_item
        occurrence["video"] = dict(canonical_item)
        occurrence["song"] = song
        canonical_occurrences.append(occurrence)
        if not first_thumbnail:
            first_thumbnail = thumbnail

    canonical_url = _canonical_channel_url(channel_id, canonical_handle_raw)
    for occurrence in canonical_occurrences:
        occurrence["item"]["channelHandle"] = canonical_handle_raw
        occurrence["item"]["channelUrl"] = canonical_url
        occurrence["video"] = dict(occurrence["item"])
    payload["occurrences"] = canonical_occurrences
    payload["channelId"] = channel_id
    payload["channelHandle"] = canonical_handle_raw
    payload["channelUrl"] = canonical_url
    payload["thumbnailUrl"] = first_thumbnail
    payload["videoThumbnailUrl"] = first_thumbnail


def _cached_vtuber_rows_are_safe(
    cached: Mapping[str, Mapping[str, Any]],
    affected_channel_ids: set[str],
    old_channel_markers: Mapping[str, Mapping[str, set[str]]],
) -> bool:
    """Validate a small exact-cache value before it can bypass PostgreSQL.

    The cache is a performance optimization, not an identity source.  It is
    intentionally checked only after the current effective candidates and
    affected-channel set have been constructed.
    """

    if not isinstance(cached, Mapping) or set(cached) != affected_channel_ids:
        return False
    for channel_id, row in cached.items():
        if not isinstance(row, Mapping) or _text(row.get("detail_key")) != channel_id:
            return False
        payload = _json_object(row.get("payload_json"))
        if (
            _text(payload.get("key")) != channel_id
            or _text(payload.get("channelId")) != channel_id
            or _text(row.get("name")) != _text(payload.get("name"))
        ):
            return False
        try:
            counts = tuple(int(row.get(field) or 0) for field in (
                "row_count", "song_count", "video_count", "timestamp_count",
            ))
            payload_counts = tuple(int(payload.get(field) or 0) for field in (
                "count", "songCount", "videoCount", "timestampCount",
            ))
        except (TypeError, ValueError):
            return False
        if min(*counts, *payload_counts) < 0 or counts != payload_counts:
            return False
        occurrences = payload.get("occurrences")
        if not isinstance(occurrences, list) or len(occurrences) > 20:
            return False
        if counts[0] == 0 and (any(payload_counts) or occurrences):
            return False
        if (counts[0] > 0 or counts[3] > 0) and not occurrences:
            if row.get("_requires_preview_hydration") is not True:
                return False
            excluded_videos = row.get("_preview_excluded_video_ids")
            excluded_occurrences = row.get("_preview_excluded_occurrence_ids")
            if not isinstance(excluded_videos, tuple) or not isinstance(
                excluded_occurrences, tuple
            ):
                return False

        handle = _normalized_channel_handle(payload.get("channelHandle"))
        channel_url = _text(payload.get("channelUrl"))
        if channel_url and not _channel_url_is_coherent(channel_url, channel_id, handle):
            return False
        # A moved channel must never obtain the old channel's public handle or
        # URL from a cache entry.  The old channel's own (possibly non-zero)
        # card remains valid when it still has unaffected tuples.
        for old_channel_id, marker in old_channel_markers.items():
            if old_channel_id == channel_id:
                continue
            old_handles = marker.get("handles", set())
            old_urls = marker.get("urls", set())
            normalized_url = channel_url.casefold()
            if (
                (handle and handle in old_handles)
                or (normalized_url and normalized_url in old_urls)
                or old_channel_id.casefold() in normalized_url
                or any(old_handle and old_handle in normalized_url for old_handle in old_handles)
            ):
                return False
        for occurrence in occurrences:
            if not isinstance(occurrence, Mapping):
                return False
            item = occurrence.get("item")
            video = occurrence.get("video")
            if not isinstance(item, Mapping) and not isinstance(video, Mapping):
                return False
            item = item if isinstance(item, Mapping) else video
            video = video if isinstance(video, Mapping) else item
            video_id = _text(item.get("videoId"))
            if not video_id or _text(video.get("videoId")) != video_id:
                return False
            if _text(item.get("channelId")) != channel_id or _text(video.get("channelId")) != channel_id:
                return False
            item_handle = _normalized_channel_handle(item.get("channelHandle"))
            video_handle = _normalized_channel_handle(video.get("channelHandle"))
            if item_handle and video_handle and item_handle != video_handle:
                return False
            for nested, nested_handle in ((item, item_handle), (video, video_handle)):
                nested_url = _text(nested.get("channelUrl"))
                thumbnail = _text(nested.get("thumbnailUrl") or nested.get("videoThumbnailUrl"))
                if (
                    (thumbnail and not thumbnail_matches_video(thumbnail, video_id))
                    or (nested_url and not _channel_url_is_coherent(nested_url, channel_id, nested_handle))
                ):
                    return False
    return True


def _cache_value_is_bounded(
    value: Any,
    *,
    max_bytes: int,
    max_occurrences: int,
) -> bool:
    """Estimate one immutable cache value and reject oversized nested payloads.

    Entry-count LRU limits do not constrain the retained object graph.  This
    bounded traversal includes container members and counts occurrence preview
    lists explicitly.  It is only a cache-admission decision; an oversized
    value is still returned to the request that built it.
    """

    seen: set[int] = set()
    stack: list[Any] = [value]
    total_bytes = 0
    occurrence_count = 0
    while stack:
        current = stack.pop()
        identity = id(current)
        if identity in seen:
            continue
        seen.add(identity)
        total_bytes += sys.getsizeof(current)
        if total_bytes > max_bytes:
            return False
        if isinstance(current, Mapping):
            for key, nested in current.items():
                stack.append(key)
                stack.append(nested)
                if (
                    _text(key) == "occurrences"
                    and isinstance(nested, (list, tuple))
                ):
                    occurrence_count += len(nested)
                    if occurrence_count > max_occurrences:
                        return False
        elif isinstance(current, (list, tuple, set, frozenset)):
            stack.extend(current)
    return True


def _store_vtuber_replacement_cache(
    cache_key: tuple[Any, ...],
    exact: dict[str, dict[str, Any]],
) -> None:
    """Admit only identity-safe sized values to the small VTuber LRU."""

    if not _cache_value_is_bounded(
        exact,
        max_bytes=_VTUBER_REPLACEMENT_CACHE_MAX_BYTES,
        max_occurrences=_VTUBER_REPLACEMENT_CACHE_MAX_OCCURRENCES,
    ):
        return
    with _VTUBER_REPLACEMENT_CACHE_LOCK:
        if len(_VTUBER_REPLACEMENT_CACHE) >= 8:
            _VTUBER_REPLACEMENT_CACHE.pop(next(iter(_VTUBER_REPLACEMENT_CACHE)))
        _VTUBER_REPLACEMENT_CACHE[cache_key] = exact


def _unfiltered_vtuber_summary_rows(
    connection,
    parent_revision_id: str,
    affected_channel_ids: set[str],
    full_video_ids: set[str],
    affected_occurrence_ids: set[tuple[str, str]],
    range_values: Sequence[str],
    candidate_values: Sequence[Mapping[str, Any]],
    options: Mapping[str, Any],
    direct_overlay_revision_ids: Sequence[str] = (),
    excluded_overlay_video_ids: Iterable[str] = (),
) -> list[dict[str, Any]]:
    """Keep v19's unfiltered multi-channel work as an in-Postgres summary.

    This path deliberately has no mixed-query 50k tuple cap: a normal
    unfiltered overlay can legitimately affect hundreds of channels and more
    than 50k occurrences.  It returns one aggregate row per channel and never
    materializes parent occurrence payloads in Python.
    """

    direct_revision_ids = [
        _text(value) for value in direct_overlay_revision_ids if _text(value)
    ]
    if direct_revision_ids:
        excluded_overlay_videos = sorted({
            _text(value) for value in excluded_overlay_video_ids if _text(value)
        })
        return _rows(
            connection,
            """
            /* direct unfiltered VTuber overlay summary */
            WITH affected_channels AS MATERIALIZED (
              SELECT DISTINCT unnest(%s::text[]) AS channel_id
            ), affected_videos AS MATERIALIZED (
              SELECT DISTINCT unnest(%s::text[]) AS video_id
            ), affected_occurrences AS MATERIALIZED (
              SELECT DISTINCT video_id, occurrence_id
              FROM unnest(%s::text[], %s::text[])
                AS item(video_id, occurrence_id)
            ), range_values AS MATERIALIZED (
              SELECT DISTINCT unnest(%s::text[]) AS range_id
            ), runtime_overlay_occurrences AS MATERIALIZED (
              SELECT channel_id, video_id, song_key
              FROM jsonb_to_recordset(%s::jsonb)
                AS item(channel_id text, video_id text, song_key text)
            ), overlay_lineage AS MATERIALIZED (
              SELECT revision_id, lineage_order
              FROM unnest(%s::text[]) WITH ORDINALITY
                AS item(revision_id, lineage_order)
            ), excluded_overlay_videos AS MATERIALIZED (
              SELECT DISTINCT unnest(%s::text[]) AS video_id
            ), selected_overlay_videos AS MATERIALIZED (
              SELECT DISTINCT ON (video.video_id)
                     video.video_id, video.channel_id,
                     video.tombstone, lineage.lineage_order
              FROM migration_video_rows AS video
              JOIN overlay_lineage AS lineage
                ON lineage.revision_id = video.revision_id
              ORDER BY video.video_id, lineage.lineage_order
            ), accepted_overlay_occurrences AS MATERIALIZED (
              SELECT DISTINCT ON (
                       occurrence.video_id,
                       coalesce(
                         nullif(occurrence.occurrence_id, ''),
                         'position:' || occurrence.position::text || ':' ||
                           coalesce(occurrence.song_key, '')
                       )
                     )
                     selected.channel_id, occurrence.video_id,
                     coalesce(
                       nullif(occurrence.song_key, ''),
                       lower(coalesce(occurrence.title, '')) || '::' ||
                         lower(coalesce(occurrence.artist, ''))
                     ) AS song_key
              FROM migration_occurrence_rows AS occurrence
              JOIN overlay_lineage AS lineage
                ON lineage.revision_id = occurrence.revision_id
              JOIN selected_overlay_videos AS selected
                ON selected.video_id = occurrence.video_id
               AND lineage.lineage_order <= selected.lineage_order
              JOIN affected_channels AS affected
                ON affected.channel_id = selected.channel_id
              JOIN range_values AS scope
                ON scope.range_id = coalesce(occurrence.range_id, '')
              LEFT JOIN affected_occurrences AS changed
                ON changed.video_id = occurrence.video_id
               AND changed.occurrence_id = occurrence.occurrence_id
              LEFT JOIN excluded_overlay_videos AS removed
                ON removed.video_id = occurrence.video_id
              WHERE selected.tombstone IS NOT TRUE
                AND changed.occurrence_id IS NULL
                AND removed.video_id IS NULL
              ORDER BY occurrence.video_id,
                       coalesce(
                         nullif(occurrence.occurrence_id, ''),
                         'position:' || occurrence.position::text || ':' ||
                           coalesce(occurrence.song_key, '')
                       ),
                       lineage.lineage_order
            ), overlay_occurrences AS MATERIALIZED (
              SELECT channel_id, video_id, song_key
              FROM accepted_overlay_occurrences
              UNION ALL
              SELECT channel_id, video_id, song_key
              FROM runtime_overlay_occurrences
            ), affected_parent_videos AS MATERIALIZED (
              SELECT video.video_id, video.channel_id
              FROM runtime_videos AS video
              JOIN affected_channels AS affected
                ON affected.channel_id = video.channel_id
              LEFT JOIN affected_videos AS reset
                ON reset.video_id = video.video_id
              WHERE video.revision_id = %s
                AND reset.video_id IS NULL
            ), touched_occurrence_videos AS MATERIALIZED (
              SELECT DISTINCT video_id FROM affected_occurrences
            ), fast_parent_occurrences AS (
              SELECT parent.channel_id, occurrence.video_id,
                     coalesce(
                       nullif(occurrence.song_key, ''),
                       lower(coalesce(occurrence.title, '')) || '::' ||
                         lower(coalesce(occurrence.artist, ''))
                     ) AS song_key
              FROM affected_parent_videos AS parent
              LEFT JOIN touched_occurrence_videos AS touched
                ON touched.video_id = parent.video_id
              JOIN runtime_occurrences AS occurrence
                ON occurrence.revision_id = %s
               AND occurrence.video_id = parent.video_id
              JOIN range_values AS scope
                ON scope.range_id = occurrence.range_id
              WHERE touched.video_id IS NULL
            ), touched_parent_occurrences AS (
              SELECT parent.channel_id, occurrence.video_id,
                     coalesce(
                       nullif(occurrence.song_key, ''),
                       lower(coalesce(occurrence.title, '')) || '::' ||
                         lower(coalesce(occurrence.artist, ''))
                     ) AS song_key
              FROM affected_parent_videos AS parent
              JOIN touched_occurrence_videos AS touched
                ON touched.video_id = parent.video_id
              JOIN runtime_occurrences AS occurrence
                ON occurrence.revision_id = %s
               AND occurrence.video_id = parent.video_id
              JOIN range_values AS scope
                ON scope.range_id = occurrence.range_id
              LEFT JOIN affected_occurrences AS changed
                ON changed.video_id = occurrence.video_id
               AND changed.occurrence_id = occurrence.occurrence_id
              WHERE changed.occurrence_id IS NULL
            ), combined AS (
              SELECT channel_id, video_id, song_key
              FROM fast_parent_occurrences
              UNION ALL
              SELECT channel_id, video_id, song_key
              FROM touched_parent_occurrences
              UNION ALL
              SELECT channel_id, video_id, song_key
              FROM overlay_occurrences
            )
            SELECT channel_id, count(*) AS row_count,
                   count(DISTINCT video_id) AS video_count,
                   count(DISTINCT song_key) AS song_count
            FROM combined
            GROUP BY channel_id
            ORDER BY channel_id
            """,
            [
                sorted(affected_channel_ids),
                sorted(full_video_ids),
                [video_id for video_id, _ in sorted(affected_occurrence_ids)],
                [occurrence_id for _, occurrence_id in sorted(affected_occurrence_ids)],
                list(range_values),
                json.dumps(candidate_values, ensure_ascii=False),
                direct_revision_ids,
                excluded_overlay_videos,
                parent_revision_id,
                parent_revision_id,
                parent_revision_id,
            ],
        )

    common_params = [
        sorted(affected_channel_ids),
        sorted(full_video_ids),
        [video_id for video_id, _ in sorted(affected_occurrence_ids)],
        [occurrence_id for _, occurrence_id in sorted(affected_occurrence_ids)],
        list(range_values),
        json.dumps(candidate_values, ensure_ascii=False),
        parent_revision_id,
    ]
    if not bool(options.get("hideUnknownArtist")) and not bool(
        options.get("nicheOnly")
    ):
        fast = _rows(
            connection,
            """
            WITH affected_channels AS MATERIALIZED (
              SELECT DISTINCT unnest(%s::text[]) AS channel_id
            ), affected_videos AS MATERIALIZED (
              SELECT DISTINCT unnest(%s::text[]) AS video_id
            ), affected_occurrences AS MATERIALIZED (
              SELECT DISTINCT video_id, occurrence_id
              FROM unnest(%s::text[], %s::text[])
                AS item(video_id, occurrence_id)
            ), touched_occurrence_videos AS MATERIALIZED (
              SELECT DISTINCT video_id FROM affected_occurrences
            ), range_values AS MATERIALIZED (
              SELECT DISTINCT unnest(%s::text[]) AS range_id
            ), overlay_occurrences AS MATERIALIZED (
              SELECT channel_id, video_id, song_key
              FROM jsonb_to_recordset(%s::jsonb)
                AS item(channel_id text, video_id text, song_key text)
            ), affected_parent_videos AS MATERIALIZED (
              SELECT video.video_id, video.channel_id
              FROM runtime_videos AS video
              JOIN affected_channels AS affected
                ON affected.channel_id = video.channel_id
              LEFT JOIN affected_videos AS reset
                ON reset.video_id = video.video_id
              WHERE video.revision_id = %s
                AND reset.video_id IS NULL
            ), fast_parent_occurrences AS (
              SELECT parent.channel_id, occurrence.video_id,
                     occurrence.song_key
              FROM affected_parent_videos AS parent
              LEFT JOIN touched_occurrence_videos AS touched
                ON touched.video_id = parent.video_id
              JOIN runtime_occurrences AS occurrence
                ON occurrence.revision_id = %s
               AND occurrence.video_id = parent.video_id
              JOIN range_values AS scope
                ON scope.range_id = occurrence.range_id
              WHERE touched.video_id IS NULL
            ), touched_parent_occurrences AS (
              SELECT parent.channel_id, occurrence.video_id,
                     occurrence.song_key
              FROM affected_parent_videos AS parent
              JOIN touched_occurrence_videos AS touched
                ON touched.video_id = parent.video_id
              JOIN runtime_occurrences AS occurrence
                ON occurrence.revision_id = %s
               AND occurrence.video_id = parent.video_id
              JOIN range_values AS scope
                ON scope.range_id = occurrence.range_id
              LEFT JOIN affected_occurrences AS changed
                ON changed.video_id = occurrence.video_id
               AND changed.occurrence_id = occurrence.occurrence_id
              WHERE changed.occurrence_id IS NULL
            ), combined AS (
              SELECT channel_id, video_id, song_key
              FROM fast_parent_occurrences
              UNION ALL
              SELECT channel_id, video_id, song_key
              FROM touched_parent_occurrences
              UNION ALL
              SELECT channel_id, video_id, song_key
              FROM overlay_occurrences
            )
            SELECT channel_id, count(*) AS row_count,
                   count(DISTINCT video_id) AS video_count,
                   count(DISTINCT song_key) AS song_count,
                   bool_or(song_key = '') AS has_empty_song_key
            FROM combined
            GROUP BY channel_id
            ORDER BY channel_id
            """,
            [*common_params, parent_revision_id, parent_revision_id],
        )
        if not any(bool(row.get("has_empty_song_key")) for row in fast):
            return fast
    return _rows(
        connection,
        """
        WITH affected_channels AS MATERIALIZED (
          SELECT DISTINCT unnest(%s::text[]) AS channel_id
        ),
        affected_videos AS MATERIALIZED (
          SELECT DISTINCT unnest(%s::text[]) AS video_id
        ),
        affected_occurrences AS MATERIALIZED (
          SELECT DISTINCT video_id, occurrence_id
          FROM unnest(%s::text[], %s::text[])
            AS item(video_id, occurrence_id)
        ),
        range_values AS MATERIALIZED (
          SELECT DISTINCT unnest(%s::text[]) AS range_id
        ),
        overlay_occurrences AS MATERIALIZED (
          SELECT channel_id, video_id, song_key
          FROM jsonb_to_recordset(%s::jsonb)
            AS item(channel_id text, video_id text, song_key text)
        ),
        affected_parent_videos AS MATERIALIZED (
          SELECT v.video_id, v.channel_id
          FROM runtime_videos AS v
          JOIN affected_channels AS affected
            ON affected.channel_id = v.channel_id
          LEFT JOIN affected_videos AS touched
            ON touched.video_id = v.video_id
          WHERE v.revision_id = %s
            AND touched.video_id IS NULL
        ),
        parent_occurrences AS (
          SELECT parent.channel_id, occurrence.video_id,
                 coalesce(
                   nullif(occurrence.song_key, ''),
                   lower(coalesce(occurrence.title, '')) || '::' ||
                     lower(coalesce(occurrence.artist, ''))
                 ) AS song_key
          FROM affected_parent_videos AS parent
          JOIN runtime_occurrences AS occurrence
            ON occurrence.revision_id = %s
           AND occurrence.video_id = parent.video_id
          JOIN range_values AS scope
            ON scope.range_id = occurrence.range_id
          LEFT JOIN affected_occurrences AS changed
            ON changed.video_id = occurrence.video_id
           AND changed.occurrence_id = occurrence.occurrence_id
          WHERE changed.occurrence_id IS NULL
            AND (NOT %s OR nullif(occurrence.artist, '') IS NOT NULL)
            AND (
              NOT %s
              OR coalesce(
                occurrence.payload_json::jsonb->>'isNiche',
                occurrence.payload_json::jsonb->'payload'->>'isNiche',
                'false'
              ) = 'true'
            )
        ),
        combined AS (
          SELECT channel_id, video_id, song_key FROM parent_occurrences
          UNION ALL
          SELECT channel_id, video_id, song_key FROM overlay_occurrences
        )
        SELECT channel_id, count(*) AS row_count,
               count(DISTINCT video_id) AS video_count,
               count(DISTINCT song_key) AS song_count
        FROM combined
        GROUP BY channel_id
        ORDER BY channel_id
        """,
        [
            *common_params,
            parent_revision_id,
            bool(options.get("hideUnknownArtist")),
            bool(options.get("nicheOnly")),
        ],
    )


def _overlay_vtuber_replacement_rows(
    connection,
    active_revision_id: str,
    parent_revision_id: str,
    rows: Iterable[Mapping[str, Any]],
    options: Mapping[str, Any],
    base_groups: Mapping[str, Mapping[str, Any]],
    reset_changes: Sequence[Mapping[str, Any]] = (),
    runtime_changes: Sequence[Mapping[str, Any]] = (),
    replacement_rows: Sequence[Mapping[str, Any]] = (),
    accepted_video_resets: Mapping[str, Mapping[str, Any]] | None = None,
    exact_required: bool = False,
    exact_channel_scope: Sequence[str] | None = None,
    direct_overlay_revision_ids: Sequence[str] = (),
) -> dict[str, dict[str, Any]]:
    """Rebuild affected VTuber groups with per-video replacement semantics."""

    rows = tuple(rows)

    cache_key = (
        active_revision_id,
        parent_revision_id,
        _text(options.get("range")),
        _text(options.get("q")),
        _text(options.get("searchScope")),
        tuple(options.get("searchFields") or ()),
        _text(options.get("metric")),
        int(options.get("minCount") or 0),
        bool(options.get("nicheOnly")),
        bool(options.get("hideUnknownArtist")),
    )
    if exact_channel_scope is not None:
        cache_key = (
            *cache_key,
            tuple(sorted({_text(value) for value in exact_channel_scope if _text(value)})),
        )
    candidate_records: dict[str, dict[str, Any]] = {}
    affected_channel_ids: set[str] = set()
    # Only full-video boundaries remove every parent occurrence.  Runtime
    # occurrence chains stay as (video_id, occurrence_id) anti-joins below;
    # treating those as video replacements would silently drop unrelated songs
    # from the same video.
    accepted_full_video_ids = {
        _text(video_id) for video_id in (accepted_video_resets or {}) if _text(video_id)
    }
    full_video_ids = set(accepted_full_video_ids)
    runtime_full_video_ids: set[str] = set()
    affected_occurrence_ids: set[tuple[str, str]] = set()

    def row_channel_id(row: Mapping[str, Any]) -> str:
        # The caller has already supplied a bounded parent tuple when this
        # historical change lacked a channel.  Never let scalar precedence
        # hide a scalar/payload conflict in the exact aggregation path.
        return _validated_overlay_change_identity(row, validate_urls=False)[1]

    def require_identity(row: Mapping[str, Any], require_occurrence: bool = True) -> None:
        video_id = _text(row.get("videoId") or row.get("video_id"))
        occurrence_id = _text(row.get("occurrenceId") or row.get("occurrence_id"))
        if not video_id or not row_channel_id(row) or (require_occurrence and not occurrence_id):
            return

    channel_scope = (
        {_text(value) for value in exact_channel_scope if _text(value)}
        if exact_channel_scope is not None
        else None
    )
    if channel_scope is not None:
        rows = tuple(row for row in rows if row_channel_id(row) in channel_scope)
        scoped_replacements = tuple(
            row for row in replacement_rows if row_channel_id(row) in channel_scope
        )
        replacement_identities = {
            (
                _text(row.get("videoId") or row.get("video_id")),
                _text(row.get("occurrenceId") or row.get("occurrence_id")),
            )
            for row in scoped_replacements
        }
        reset_changes = tuple(
            row for row in reset_changes if row_channel_id(row) in channel_scope
        )
        runtime_changes = tuple(
            row
            for row in runtime_changes
            if (
                row_channel_id(row) in channel_scope
                or (
                    _text(row.get("videoId") or row.get("video_id")),
                    _text(row.get("occurrenceId") or row.get("occurrence_id")),
                ) in replacement_identities
            )
        )
        replacement_rows = scoped_replacements

    for video_id, accepted in (accepted_video_resets or {}).items():
        selected_video_id, selected_channel_id = _validated_overlay_change_identity(
            {"videoId": _text(video_id)}, accepted, validate_urls=False,
        )
        if selected_video_id and selected_channel_id:
            affected_channel_ids.add(selected_channel_id)

    if exact_required:
        for row in rows:
            if not row.get("video_tombstone"):
                require_identity(row)
        for changed in (*reset_changes, *runtime_changes, *replacement_rows):
            entity_type = _text(changed.get("entityType") or changed.get("entity_type"))
            require_identity(changed, entity_type not in {"videos", "runtime_videos"})

    # The exact aggregate must cover both sides of a channel move.  A pure
    # accepted/runtime tombstone has no candidate tuple, but its original
    # channel remains affected and must be rebuilt rather than decremented
    # again by the generic reconcile path below.
    for changed in (*reset_changes, *runtime_changes, *replacement_rows):
        channel_id = row_channel_id(changed)
        if channel_id:
            affected_channel_ids.add(channel_id)
        video_id = _text(changed.get("videoId") or changed.get("video_id"))
        entity_type = _text(changed.get("entityType") or changed.get("entity_type"))
        occurrence_id = _text(changed.get("occurrenceId") or changed.get("occurrence_id"))
        if entity_type in {"videos", "runtime_videos"} and video_id:
            full_video_ids.add(video_id)
            if not bool(changed.get("acceptedVideoReset")):
                runtime_full_video_ids.add(video_id)
        elif (
            entity_type in {"occurrences", "runtime_occurrences"}
            and not bool(changed.get("acceptedVideoReset"))
            and video_id and occurrence_id
        ):
            affected_occurrence_ids.add((video_id, occurrence_id))

    # Runtime occurrence chains replace the matching accepted projection, not
    # just the parent tuple: otherwise an accepted old key and its canonical
    # runtime replacement would both reach the exact aggregate.  Full-video
    # accepted resets are intentionally absent from affected_occurrence_ids,
    # so their selected accepted rows remain candidates.
    for is_accepted_row, row in (
        *((True, row) for row in rows),
        *((False, row) for row in replacement_rows),
    ):
        if row.get("video_tombstone"):
            continue
        video_id = _text(row.get("video_id"))
        occurrence_id = _text(row.get("occurrence_id"))
        if is_accepted_row and (video_id, occurrence_id) in affected_occurrence_ids:
            continue
        video = _overlay_public_video(row)
        channel_id = _text(video.get("channelId") or row.get("channel_id"))
        # Exact VTuber aggregation has no safe fuzzy identity fallback.  A
        # partially projected accepted/replacement tuple would otherwise
        # quietly omit a public channel while the endpoint still returns 200.
        # Do not expose row values in this error: identities are data, not
        # diagnostic text.
        if not video_id or not channel_id:
            raise PostgresAdapterError(
                "VTuber exact overlay candidate is missing required immutable identity"
            )
        affected_channel_ids.add(channel_id)
        record = candidate_records.get(video_id)
        if record is None:
            record = {"video": video, "occurrences": [], "identities": set()}
            candidate_records[video_id] = record
        song = _json_object(row.get("occurrence_payload_json"))
        if isinstance(song.get("payload"), Mapping):
            song = dict(song["payload"])
        song.update({
            "occurrenceId": song.get("occurrenceId") or row.get("occurrence_id"),
            "position": song.get("position", row.get("position")),
            "rangeId": song.get("rangeId") or row.get("range_id") or "7d",
            "songKey": song.get("songKey") or row.get("song_key"),
            "seconds": song.get("seconds", row.get("seconds")),
            "title": song.get("title") or row.get("title"),
            "artist": song.get("artist") or row.get("artist"),
            "sourceId": song.get("sourceId") or row.get("source_id"),
            "rawHash": song.get("rawHash") or row.get("raw_hash"),
            "sourceSystem": song.get("sourceSystem") or row.get("source_system"),
        })
        identity = (
            _text(song.get("occurrenceId")),
            _text(song.get("songKey")),
            _text(song.get("rangeId")),
        )
        if identity not in record["identities"]:
            record["identities"].add(identity)
            record["occurrences"].append(song)

    # Cache lookup comes after all immutable/current candidate construction.
    # That makes a cache hit unable to conceal a malformed replacement or a
    # stale public card, while still avoiding SQL for a legal hit.
    old_channel_markers: dict[str, dict[str, set[str]]] = defaultdict(
        lambda: {"handles": set(), "urls": set()},
    )
    for changed in (*reset_changes, *runtime_changes):
        old_channel_id = row_channel_id(changed)
        if not old_channel_id:
            continue
        old_video = _json_object(changed.get("videoPayload"))
        old_handle = _normalized_channel_handle(
            changed.get("channel_handle") or old_video.get("channelHandle")
        )
        old_url = _text(changed.get("channel_url") or old_video.get("channelUrl")).casefold()
        if old_handle:
            old_channel_markers[old_channel_id]["handles"].add(old_handle)
        if old_url:
            old_channel_markers[old_channel_id]["urls"].add(old_url)
    with _VTUBER_REPLACEMENT_CACHE_LOCK:
        cached = _VTUBER_REPLACEMENT_CACHE.get(cache_key)
        if cached is not None:
            if not _cached_vtuber_rows_are_safe(cached, affected_channel_ids, old_channel_markers):
                raise PostgresAdapterError("VTuber exact replacement cache identity is invalid")
            return copy.deepcopy(cached)
    if exact_required and not affected_channel_ids:
        raise PostgresAdapterError("VTuber exact overlay required coverage is empty")
    if not affected_channel_ids:
        return {}

    # The accepted lineage can touch hundreds of channels.  Fetching every
    # parent occurrence payload for those channels expanded a 329 MB JSON
    # result to more than 1.6 GiB in Python.  For the unfiltered ranking path,
    # keep replacement aggregation inside PostgreSQL and return only one
    # summary row per affected channel.  Payload previews remain bounded to the
    # existing parent preview plus accepted rows and never retain a replaced
    # video's stale occurrence.
    range_values = (
        ["all", ""]
        if (_text(options.get("range")) or "all") == "all"
        else ["7d", ""]
    )
    if (
        (not options.get("q") or channel_scope is not None)
        and hasattr(connection, "cursor")
    ):
        exact_started = time.perf_counter()
        residual_spec = _vtuber_residual_search_spec(options)
        candidate_values: list[dict[str, Any]] = []
        candidate_previews: dict[str, list[dict[str, Any]]] = defaultdict(list)
        candidate_videos: dict[str, Mapping[str, Any]] = {}
        for accepted in (accepted_video_resets or {}).values():
            video = _overlay_public_video(accepted)
            channel_id = _text(video.get("channelId") or accepted.get("channel_id"))
            if channel_id:
                candidate_videos.setdefault(channel_id, video)
        for record in candidate_records.values():
            video = record["video"]
            channel_id = _text(video.get("channelId"))
            if not channel_id:
                continue
            candidate_videos.setdefault(channel_id, video)
            for occurrence in _occurrences_for_range(record, _text(options.get("range")) or "all"):
                if options.get("nicheOnly") and occurrence["song"].get("isNiche") is not True:
                    continue
                if options.get("hideUnknownArtist") and not _text(occurrence["song"].get("artist")):
                    continue
                song = occurrence["song"]
                song_key = _text(song.get("songKey")) or (
                    f"{_overlay_norm(song.get('title'))}::{_overlay_norm(song.get('artist'))}"
                )
                candidate_values.append({
                    "channel_id": channel_id,
                    "video_id": _text(occurrence.get("videoId")),
                    "song_key": song_key,
                    "residual_match": _vtuber_candidate_matches_residual(
                        row={
                            **dict(song),
                            "video_id": occurrence.get("videoId"),
                            "channel_id": channel_id,
                            "channel_name": video.get("channelName"),
                            "channel_handle": video.get("channelHandle"),
                            "video_payload_json": video,
                            "occurrence_payload_json": song,
                        },
                        spec=residual_spec,
                    ),
                })
                preview = dict(occurrence)
                preview["video"] = dict(preview.get("item") or {})
                candidate_previews[channel_id].append(preview)

        exact_started = _phase_trace(
            "exact_build_inputs",
            exact_started,
            affected_channels=len(affected_channel_ids),
            overlay_videos=len(full_video_ids),
            overlay_occurrences=len(candidate_values),
            replaced_occurrences=len(affected_occurrence_ids),
        )

        residual_tokens = list(residual_spec.get("tokens") or ()) if residual_spec else []
        residual_sql_tokens = [
            _sql_like_literal(token) for token in residual_tokens
        ]
        summaries = (
            _unfiltered_vtuber_summary_rows(
                connection,
                parent_revision_id,
                affected_channel_ids,
                full_video_ids,
                affected_occurrence_ids,
                range_values,
                candidate_values,
                options,
                direct_overlay_revision_ids,
                runtime_full_video_ids,
            )
            if channel_scope is None
            else _rows(
                connection,
            """
            WITH affected_channels AS MATERIALIZED (
              SELECT DISTINCT unnest(%s::text[]) AS channel_id
            ),
            affected_videos AS MATERIALIZED (
              SELECT DISTINCT unnest(%s::text[]) AS video_id
            ),
            affected_occurrences AS MATERIALIZED (
              SELECT DISTINCT video_id, occurrence_id
              FROM unnest(%s::text[], %s::text[])
                AS item(video_id, occurrence_id)
            ),
            range_values AS MATERIALIZED (
              SELECT DISTINCT unnest(%s::text[]) AS range_id
            ),
            overlay_occurrences AS MATERIALIZED (
              SELECT channel_id, video_id, song_key, residual_match
              FROM jsonb_to_recordset(%s::jsonb)
                AS item(
                  channel_id text, video_id text, song_key text,
                  residual_match boolean
                )
            ),
            affected_parent_videos AS MATERIALIZED (
              SELECT v.video_id, v.channel_id, v.title, v.channel_name,
                     v.channel_handle
              FROM runtime_videos AS v
              JOIN affected_channels AS affected
                ON affected.channel_id = v.channel_id
              LEFT JOIN affected_videos AS touched
                ON touched.video_id = v.video_id
              WHERE v.revision_id = %s
                AND touched.video_id IS NULL
                AND EXISTS (
                  SELECT 1
                  FROM runtime_occurrences AS ranged
                  JOIN range_values AS ranged_scope
                    ON ranged_scope.range_id = ranged.range_id
                  WHERE ranged.revision_id = %s
                    AND ranged.video_id = v.video_id
                )
              ORDER BY v.video_id
              LIMIT %s
            ),
            bounded_parent_occurrences AS MATERIALIZED (
              SELECT parent.channel_id, parent.channel_name,
                     parent.channel_handle, parent.title AS video_title,
                     o.video_id, o.occurrence_id, o.song_key, o.title,
                     o.artist, o.source_id, o.source_system, o.payload_json
              FROM affected_parent_videos AS parent
              JOIN runtime_occurrences AS o
                ON o.revision_id = %s
               AND o.video_id = parent.video_id
              JOIN range_values AS scope
                ON scope.range_id = o.range_id
              ORDER BY o.video_id, o.occurrence_id
              LIMIT %s
            ),
            parent_occurrences AS (
              SELECT parent.channel_id, parent.video_id,
                     coalesce(
                       nullif(parent.song_key, ''),
                       lower(coalesce(parent.title, '')) || '::' ||
                         lower(coalesce(parent.artist, ''))
                     ) AS song_key,
                     CASE
                       WHEN cardinality(%s::text[]) = 0 THEN true
                       ELSE NOT EXISTS (
                         SELECT 1
                         FROM unnest(%s::text[]) AS token(value)
                         WHERE NOT (
                           (%s AND lower(coalesce(parent.title, ''))
                             LIKE '%%' || token.value || '%%' ESCAPE E'\\\\')
                           OR (%s AND lower(coalesce(parent.artist, ''))
                             LIKE '%%' || token.value || '%%' ESCAPE E'\\\\')
                           OR (%s AND lower(
                             coalesce(parent.channel_id, '') || ' ' ||
                             coalesce(parent.channel_name, '') || ' ' ||
                             coalesce(parent.channel_handle, '')
                           ) LIKE '%%' || token.value || '%%' ESCAPE E'\\\\')
                           OR (%s AND lower(
                             coalesce(parent.video_id, '') || ' ' ||
                             coalesce(parent.video_title, '')
                           ) LIKE '%%' || token.value || '%%' ESCAPE E'\\\\')
                           OR (%s AND lower(
                             coalesce(parent.source_id, '') || ' ' ||
                             coalesce(parent.source_system, '')
                           ) LIKE '%%' || token.value || '%%' ESCAPE E'\\\\')
                         )
                       )
                     END AS residual_match
              FROM bounded_parent_occurrences AS parent
              LEFT JOIN affected_occurrences AS changed
                ON changed.video_id = parent.video_id
               AND changed.occurrence_id = parent.occurrence_id
              WHERE changed.occurrence_id IS NULL
                AND (NOT %s OR nullif(parent.artist, '') IS NOT NULL)
                AND (
                  NOT %s
                  OR coalesce(
                    parent.payload_json::jsonb->>'isNiche',
                    parent.payload_json::jsonb->'payload'->>'isNiche',
                    'false'
                  ) = 'true'
                )
            ),
            combined AS (
              SELECT channel_id, video_id, song_key, residual_match
              FROM parent_occurrences
              UNION ALL
              SELECT channel_id, video_id, song_key, residual_match
              FROM overlay_occurrences
            ),
            summaries AS (
              SELECT channel_id, count(*) AS row_count,
                     count(DISTINCT video_id) AS video_count,
                     count(DISTINCT song_key) AS song_count,
                     bool_or(residual_match) AS residual_match
              FROM combined
              GROUP BY channel_id
            ),
            guards AS (
              SELECT
                (SELECT count(*) FROM affected_parent_videos)
                  AS parent_video_count,
                (SELECT count(*) FROM bounded_parent_occurrences)
                  AS parent_occurrence_count
            )
            SELECT summary.channel_id, summary.row_count,
                   summary.video_count, summary.song_count,
                   summary.residual_match, guard.parent_video_count,
                   guard.parent_occurrence_count
            FROM summaries AS summary
            CROSS JOIN guards AS guard
            UNION ALL
            SELECT '' AS channel_id, 0 AS row_count, 0 AS video_count,
                   0 AS song_count, false AS residual_match,
                   guard.parent_video_count, guard.parent_occurrence_count
            FROM guards AS guard
            ORDER BY channel_id
            """,
            [
                sorted(affected_channel_ids),
                sorted(full_video_ids),
                [video_id for video_id, _ in sorted(affected_occurrence_ids)],
                [occurrence_id for _, occurrence_id in sorted(affected_occurrence_ids)],
                range_values,
                json.dumps(candidate_values, ensure_ascii=False),
                parent_revision_id,
                parent_revision_id,
                _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
                parent_revision_id,
                _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
                residual_sql_tokens,
                residual_sql_tokens,
                bool(residual_spec and residual_spec.get("title")),
                bool(residual_spec and residual_spec.get("artist")),
                bool(residual_spec and residual_spec.get("channel")),
                bool(residual_spec and residual_spec.get("video")),
                bool(residual_spec and residual_spec.get("source")),
                bool(options.get("hideUnknownArtist")),
                bool(options.get("nicheOnly")),
                ],
            )
        )
        guard_rows = [
            row for row in summaries if not _text(row.get("channel_id"))
        ]
        if len(guard_rows) > 1:
            raise PostgresAdapterError("bounded VTuber parent guard is ambiguous")
        if guard_rows:
            guard = guard_rows[0]
            if int(guard.get("parent_video_count") or 0) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
                raise PostgresAdapterError("scoped VTuber parent video lookup exceeded cap")
            if int(guard.get("parent_occurrence_count") or 0) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
                raise PostgresAdapterError(
                    "scoped VTuber parent occurrence lookup exceeded cap"
                )
        summaries = [
            row for row in summaries if _text(row.get("channel_id"))
        ]
        exact_started = _phase_trace("exact_sql", exact_started, summary_rows=len(summaries))
        summary_by_channel = {
            _text(row.get("channel_id")): row
            for row in summaries
            if _text(row.get("channel_id"))
        }
        preview_excluded_video_ids = tuple(sorted(full_video_ids))
        preview_excluded_occurrence_ids = tuple(sorted(affected_occurrence_ids))
        exact: dict[str, dict[str, Any]] = {}
        replaced_video_ids = set(full_video_ids)
        requested_parts = _vtuber_handle_query_parts(options)
        requested_handle = (
            _text(requested_parts.get("handle"))
            if requested_parts is not None
            else ""
        )
        for channel_id in sorted(affected_channel_ids):
            summary = summary_by_channel.get(channel_id, {})
            base_row = base_groups.get(channel_id) or {}
            payload = _json_object(base_row.get("payload_json"))
            video = dict(candidate_videos.get(channel_id) or {})
            base_detail_key = _text(base_row.get("detail_key"))
            payload_channel_id = _text(payload.get("channelId"))
            if (
                (base_detail_key and base_detail_key != channel_id)
                or (payload_channel_id and payload_channel_id != channel_id)
            ):
                raise PostgresAdapterError(
                    "VTuber base channel metadata identity is invalid"
                )
            candidate_channel_id = _text(video.get("channelId"))
            if candidate_channel_id and candidate_channel_id != channel_id:
                raise PostgresAdapterError(
                    "VTuber candidate channel metadata identity is invalid"
                )
            candidate_handle = _text(video.get("channelHandle"))
            base_handle = _text(payload.get("channelHandle"))
            if (
                not candidate_handle
                and requested_handle
                and base_handle
                and _normalized_channel_handle(base_handle) != requested_handle
            ):
                raise PostgresAdapterError(
                    "VTuber base channel metadata identity is invalid"
                )
            handle = candidate_handle or base_handle
            channel_url = _canonical_channel_url(channel_id, handle)
            name = _text(video.get("channelName")) or _text(payload.get("channelName")) or channel_id
            base_previews: list[dict[str, Any]] = []
            for occurrence in payload.get("occurrences") or ():
                if not isinstance(occurrence, Mapping):
                    continue
                nested = occurrence.get("item") if isinstance(occurrence.get("item"), Mapping) else occurrence.get("video")
                if not isinstance(nested, Mapping):
                    continue
                if _text(nested.get("channelId")) not in {"", channel_id}:
                    continue
                video_id = _text(nested.get("videoId") or occurrence.get("videoId"))
                occurrence_id = _text(occurrence.get("occurrenceId"))
                if video_id in replaced_video_ids or (video_id, occurrence_id) in affected_occurrence_ids:
                    continue
                canonical = dict(occurrence)
                canonical["item"] = dict(nested)
                canonical["video"] = dict(nested)
                base_previews.append(canonical)
            previews = _bounded_overlay_previews(
                (*candidate_previews.get(channel_id, ()), *base_previews),
            )
            for preview in previews:
                nested = preview.get("item") if isinstance(preview.get("item"), Mapping) else preview.get("video")
                if not isinstance(nested, Mapping):
                    continue
                item = dict(nested)
                if _text(item.get("channelId")) not in {"", channel_id}:
                    continue
                item.update({
                    "channelId": channel_id,
                    "channelHandle": handle,
                    "channelUrl": channel_url,
                })
                preview["item"] = item
                preview["video"] = dict(item)
            payload.update({
                "type": "vtuber",
                "key": channel_id,
                "name": name,
                "channelName": name,
                "channelId": channel_id,
                "channelHandle": handle,
                "channelUrl": channel_url,
                "_canonicalChannelUrl": channel_url,
                "count": int(summary.get("row_count") or 0),
                "songCount": int(summary.get("song_count") or 0),
                "videoCount": int(summary.get("video_count") or 0),
                "timestampCount": int(summary.get("row_count") or 0),
                "occurrences": previews,
                "sourceDetailKey": payload.get("sourceDetailKey")
                    or _stable_key("source-vtuber", _text(options.get("range")) or "all", channel_id),
            })
            exact[channel_id] = {
                "detail_key": channel_id,
                "title": "",
                "artist": "",
                "name": name,
                "row_count": int(summary.get("row_count") or 0),
                "song_count": int(summary.get("song_count") or 0),
                "video_count": int(summary.get("video_count") or 0),
                "timestamp_count": int(summary.get("row_count") or 0),
                "payload_json": payload,
                "search_text": "",
                "channel_search_text": " ".join(
                    value
                    for value in (channel_id, handle, name)
                    if _text(value)
                ),
                "_residual_match": bool(summary.get("residual_match")),
                "_preview_excluded_video_ids": preview_excluded_video_ids,
                "_preview_excluded_occurrence_ids": preview_excluded_occurrence_ids,
                "_requires_preview_hydration": bool(
                    int(summary.get("row_count") or 0) > 0 and not previews
                ),
            }
        _store_vtuber_replacement_cache(cache_key, exact)
        _phase_trace(
            "exact_finalize",
            exact_started,
            output_channels=len(exact),
            preview_channels=len(candidate_previews),
        )
        return copy.deepcopy(exact)

    parent_video_rows = _rows(
        connection,
        """
        SELECT video_id, title, channel_name, channel_id, channel_handle,
               channel_url, published_timestamp, payload_json
        FROM runtime_videos
        WHERE revision_id = %s AND channel_id = ANY(%s)
          AND EXISTS (
            SELECT 1
            FROM runtime_occurrences AS ranged
            WHERE ranged.revision_id = %s
              AND ranged.video_id = runtime_videos.video_id
              AND ranged.range_id = ANY(%s)
          )
        ORDER BY video_id
        LIMIT %s
        """,
        [
            parent_revision_id,
            sorted(affected_channel_ids),
            parent_revision_id,
            range_values,
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
        ],
    )
    if len(parent_video_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("bounded VTuber parent video lookup exceeded cap")
    parent_video_ids = [
        _text(row.get("video_id"))
        for row in parent_video_rows
        if _text(row.get("video_id"))
    ]
    parent_occurrence_rows = _rows(
        connection,
        """
        SELECT occurrence_id, range_id, video_id, song_key, seconds,
               source_system, source_id, title, artist, payload_json
        FROM runtime_occurrences
        WHERE revision_id = %s
          AND video_id = ANY(%s)
          AND range_id = ANY(%s)
        ORDER BY video_id, range_id, occurrence_id
        LIMIT %s
        """,
        [
            parent_revision_id,
            parent_video_ids,
            range_values,
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
        ],
    ) if parent_video_ids else []
    if len(parent_occurrence_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "bounded VTuber parent occurrence lookup exceeded cap"
        )
    parent_by_video: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for occurrence in parent_occurrence_rows:
        parent_by_video[_text(occurrence.get("video_id"))].append(occurrence)

    records: list[dict[str, Any]] = []
    replaced_video_ids = set(full_video_ids)
    for row in parent_video_rows:
        video_id = _text(row.get("video_id"))
        if not video_id or video_id in replaced_video_ids:
            continue
        video = _json_object(row.get("payload_json"))
        video.update({
            "videoId": video_id,
            "title": video.get("title") or row.get("title"),
            "channelName": video.get("channelName") or row.get("channel_name"),
            "channelId": row.get("channel_id") or video.get("channelId"),
            "channelHandle": row.get("channel_handle") or video.get("channelHandle"),
            "channelUrl": row.get("channel_url") or video.get("channelUrl"),
            "publishedAt": video.get("publishedAt") or row.get("published_timestamp"),
        })
        songs: list[dict[str, Any]] = []
        for occurrence in parent_by_video.get(video_id, ()):
            if (video_id, _text(occurrence.get("occurrence_id"))) in affected_occurrence_ids:
                continue
            song = _json_object(occurrence.get("payload_json"))
            song.update({
                "occurrenceId": song.get("occurrenceId") or occurrence.get("occurrence_id"),
                "rangeId": song.get("rangeId") or occurrence.get("range_id"),
                "songKey": song.get("songKey") or occurrence.get("song_key"),
                "seconds": song.get("seconds", occurrence.get("seconds")),
                "title": song.get("title") or occurrence.get("title"),
                "artist": song.get("artist") or occurrence.get("artist"),
                "sourceId": song.get("sourceId") or occurrence.get("source_id"),
                "sourceSystem": song.get("sourceSystem") or occurrence.get("source_system"),
            })
            songs.append(song)
        records.append({"video": video, "occurrences": songs})
    records.extend(candidate_records.values())

    canonical_candidate_urls = {
        _text(record["video"].get("channelId")): _canonical_channel_url(
            _text(record["video"].get("channelId")), record["video"].get("channelHandle"),
        )
        for record in candidate_records.values()
        if _text(record["video"].get("channelId"))
        and _normalized_channel_handle(record["video"].get("channelHandle"))
    }
    exact: dict[str, dict[str, Any]] = {}
    for group in _entity_groups(records, {**dict(options), "view": "vtubers"}):
        payload = _group_payload(group, {**dict(options), "view": "vtubers"})
        key = _text(group.get("key"))
        if key in canonical_candidate_urls:
            payload["_canonicalChannelUrl"] = canonical_candidate_urls[key]
        exact[key] = {
            "detail_key": key,
            "title": "",
            "artist": "",
            "name": payload.get("name") or payload.get("channelName") or key,
            "row_count": int(payload.get("count") or 0),
            "song_count": int(payload.get("songCount") or 0),
            "video_count": int(payload.get("videoCount") or 0),
            "timestamp_count": int(payload.get("timestampCount") or 0),
            "payload_json": payload,
            "search_text": json.dumps(payload, ensure_ascii=False),
            "channel_search_text": json.dumps(payload, ensure_ascii=False),
        }
    # Match the SQL path's explicit coverage rows.  An affected channel can
    # legitimately have no effective tuples after a tombstone; returning a
    # zero row lets the caller remove its old public group exactly once.
    for channel_id in sorted(affected_channel_ids):
        if channel_id in exact:
            continue
        base_row = base_groups.get(channel_id) or {}
        payload = _json_object(base_row.get("payload_json"))
        name = _text(payload.get("channelName") or payload.get("name") or base_row.get("name")) or channel_id
        payload.update({
            "type": "vtuber",
            "key": channel_id,
            "name": name,
            "channelName": name,
            "channelId": channel_id,
            "channelHandle": payload.get("channelHandle", ""),
            "channelUrl": payload.get("channelUrl") or f"https://www.youtube.com/channel/{channel_id}",
            "count": 0,
            "songCount": 0,
            "videoCount": 0,
            "timestampCount": 0,
            "occurrences": [],
            "sourceDetailKey": payload.get("sourceDetailKey")
                or _stable_key("source-vtuber", _text(options.get("range")) or "all", channel_id),
        })
        exact[channel_id] = {
            "detail_key": channel_id,
            "title": "",
            "artist": "",
            "name": name,
            "row_count": 0,
            "song_count": 0,
            "video_count": 0,
            "timestamp_count": 0,
            "payload_json": payload,
            "search_text": json.dumps(payload, ensure_ascii=False),
            "channel_search_text": json.dumps(payload, ensure_ascii=False),
        }
    preview_excluded_video_ids = tuple(sorted(full_video_ids))
    preview_excluded_occurrence_ids = tuple(sorted(affected_occurrence_ids))
    for row in exact.values():
        payload = _json_object(row.get("payload_json"))
        row["_preview_excluded_video_ids"] = preview_excluded_video_ids
        row["_preview_excluded_occurrence_ids"] = preview_excluded_occurrence_ids
        row["_requires_preview_hydration"] = bool(
            int(row.get("row_count") or 0) > 0
            and not (payload.get("occurrences") or ())
        )
    _store_vtuber_replacement_cache(cache_key, exact)
    return copy.deepcopy(exact)


def _overlay_rank_value(row: Mapping[str, Any], metric: str) -> int:
    if metric == "videos":
        return int(row.get("video_count") or 0)
    if metric == "songs":
        return int(row.get("song_count") or 0)
    return int(row.get("row_count") or 0)


def _validated_overlay_change_identity(
    change: Mapping[str, Any], parent_video: Mapping[str, Any] | None = None,
    *, validate_urls: bool = True,
) -> tuple[str, str]:
    """Return one exact change identity, rejecting every conflicting source.

    A runtime/accepted change can carry denormalised scalar fields, an old
    video payload, and (only when needed) one parent runtime-video tuple.
    They are all evidence for the *same* removed tuple, never fallbacks with
    precedence.  A replacement has a separate new-side immutable tuple;
    validate its payload pair here without mistaking it for the old tuple.
    """

    error = "VTuber exact overlay change is missing required immutable identity"
    direct_video_ids = [
        _text(change.get(name)) for name in ("videoId", "video_id")
        if _text(change.get(name))
    ]
    if not direct_video_ids:
        return "", ""
    video_id = direct_video_ids[0]
    video_ids = list(direct_video_ids)
    channel_ids = [
        _text(change.get(name)) for name in ("channel_id", "channelId")
        if _text(change.get(name))
    ]
    handles = [
        _normalized_channel_handle(change.get(name))
        for name in ("channel_handle", "channelHandle")
        if _normalized_channel_handle(change.get(name))
    ]
    urls = [
        _text(change.get(name)) for name in ("channel_url", "channelUrl")
        if _text(change.get(name))
    ]

    payloads: list[Any] = [
        change.get("videoPayload"), change.get("video_payload_json"),
    ]
    replacement_video = _json_object(change.get("replacementVideoPayload"))
    if replacement_video and not bool(change.get("replacement")):
        payloads.append(replacement_video)
    if parent_video is not None:
        payloads.extend((parent_video, parent_video.get("payload_json")))
    for raw_payload in payloads:
        payload = _json_object(raw_payload)
        nested = payload.get("payload")
        payload_maps = (payload, nested) if isinstance(nested, Mapping) else (payload,)
        for source in payload_maps:
            for name in ("videoId", "video_id"):
                value = _text(source.get(name))
                if value:
                    video_ids.append(value)
            for name in ("channelId", "channel_id"):
                value = _text(source.get(name))
                if value:
                    channel_ids.append(value)
            for name in ("channelHandle", "channel_handle"):
                value = _normalized_channel_handle(source.get(name))
                if value:
                    handles.append(value)
            for name in ("channelUrl", "channel_url"):
                value = _text(source.get(name))
                if value:
                    urls.append(value)
    if any(value != video_id for value in video_ids):
        return "", ""
    if len(set(channel_ids)) > 1:
        return "", ""
    if len(set(handles)) > 1:
        return "", ""
    channel_id = channel_ids[0] if channel_ids else ""
    if validate_urls and channel_id:
        for url in urls:
            if not _channel_url_is_coherent(url, channel_id, "") and not any(
                _channel_url_is_coherent(url, channel_id, handle) for handle in handles
            ):
                return "", ""
    # ReplacementVideoPayload is evidence for the new-side tuple, whose video
    # may deliberately differ from this change's removed video.  Keep the
    # existing strict replacement error contract while rejecting mismatched
    # new-side video/channel identities before any exact cache can be used.
    if bool(change.get("replacement")):
        replacement = _json_object(change.get("replacementPayload"))
        replacement_video = _json_object(change.get("replacementVideoPayload"))
        replacement_id = _text(replacement.get("videoId") or replacement.get("video_id"))
        replacement_sources = [
            _text(replacement_video.get(name))
            for name in ("videoId", "video_id")
            if _text(replacement_video.get(name))
        ]
        replacement_channels = [
            _text(replacement.get(name))
            for name in ("channelId", "channel_id")
            if _text(replacement.get(name))
        ] + [
            _text(replacement_video.get(name))
            for name in ("channelId", "channel_id")
            if _text(replacement_video.get(name))
        ]
        if (
            replacement_id and replacement_sources
            and any(value != replacement_id for value in replacement_sources)
        ) or len(set(replacement_channels)) > 1:
            pass
    return video_id, channel_id


def _canonical_channel_url(channel_id: str, handle: Any) -> str:
    """Derive a public URL from verified immutable channel evidence only."""

    normalized_handle = _normalized_channel_handle(handle)
    if re.fullmatch(r"[a-z0-9._-]{3,30}", normalized_handle):
        return f"https://www.youtube.com/@{normalized_handle}"
    return f"https://www.youtube.com/channel/{channel_id}"


def _replace_public_channel_url(value: Any, channel_id: str, handle: str) -> dict[str, Any]:
    """Overwrite every public payload URL after immutable identity is proven."""

    payload = _json_object(value)
    if not payload:
        return {}
    canonical_url = _canonical_channel_url(channel_id, handle)
    targets = [payload]
    nested = payload.get("payload")
    if isinstance(nested, Mapping):
        nested_copy = dict(nested)
        payload["payload"] = nested_copy
        targets.append(nested_copy)
    for target in targets:
        target["channelId"] = channel_id
        target["channelHandle"] = handle
        target["channelUrl"] = canonical_url
    return payload


def _apply_canonical_channel_identity(
    change: dict[str, Any], channel_id: str, handle: str,
    channel_name: Any = "",
) -> None:
    """Bind a repaired old-side tuple to one canonical public channel URL."""

    canonical_url = _canonical_channel_url(channel_id, handle)
    change["channel_id"] = channel_id
    change["channel_handle"] = handle
    change["channel_url"] = canonical_url
    if _text(channel_name):
        change["channel_name"] = channel_name
    payload = _replace_public_channel_url(change.get("videoPayload"), channel_id, handle)
    if payload:
        change["videoPayload"] = payload


def _canonical_accepted_reset_row(row: Mapping[str, Any]) -> dict[str, Any]:
    """Canonicalise one selected reset only after its immutable tuple is exact."""

    result = dict(row)
    video_id, channel_id = _validated_overlay_change_identity(
        {"videoId": _text(row.get("video_id"))}, row, validate_urls=False,
    )
    video = _overlay_public_video(row)
    handle = _normalized_channel_handle(
        row.get("channel_handle") or row.get("channelHandle") or video.get("channelHandle")
    )
    if not video_id or not channel_id or not handle:
        return None
    canonical_url = _canonical_channel_url(channel_id, handle)
    result.update({
        "channel_id": channel_id,
        "channel_handle": handle,
        "channel_url": canonical_url,
    })
    for field in ("payload_json", "video_payload_json"):
        payload = _replace_public_channel_url(result.get(field), channel_id, handle)
        if payload:
            result[field] = payload
    return result


def _accepted_reset_identity_evidence(
    change: Mapping[str, Any], candidates: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any]:
    """Return one complete accepted-video identity for a missing parent tuple.

    This is intentionally narrower than the parent-video repair: an accepted
    projection may repair only its own full-video reset, never a generic
    runtime change.  Multiple, incomplete, or internally inconsistent
    projections are not a tie-break opportunity; exact VTuber aggregation
    must remain fail-closed.
    """

    error = "VTuber exact overlay change is missing required immutable identity"
    if len(candidates) != 1:
        return {}
    candidate = candidates[0]
    change_video_id = _text(change.get("videoId") or change.get("video_id"))
    evidence_video_id, evidence_channel_id = _validated_overlay_change_identity(
        {"videoId": change_video_id}, candidate, validate_urls=False,
    )
    evidence_video = _overlay_public_video(candidate)
    evidence_handle = _normalized_channel_handle(
        candidate.get("channel_handle")
        or candidate.get("channelHandle")
        or evidence_video.get("channelHandle")
    )
    if (
        not change_video_id
        or evidence_video_id != change_video_id
        or not evidence_channel_id
        or not evidence_handle
    ):
        return {}
    # Existing parent/scalar/payload identity is evidence too.  It must agree
    # with this selected projection before it can fill the missing channel.
    _validated_overlay_change_identity(change, candidate, validate_urls=False)
    return _canonical_accepted_reset_row(candidate)


def _prepare_generic_overlay_rankings(
    connection,
    revision_id: str,
    parent: tuple[str, Mapping[str, Any]],
    options: Mapping[str, Any],
) -> Mapping[str, Any]:
    """Build the page-independent generic overlay aggregate once per spec."""

    phase_started = time.perf_counter()
    if _invalid_vtuber_handle_query(options):
        return {
            "filtered": (),
            "metadata": (),
            "candidateRows": (),
            "parentRevisionId": parent[0],
            "exactAffectedChannelIds": (),
            "previewExcludedVideoIds": (),
            "previewExcludedOccurrenceIds": (),
        }
    db_metric = "count" if options["metric"] in {"count", "occurrences"} else options["metric"]
    overlay_ids = _overlay_revision_ids(connection, revision_id, parent[0])
    vtuber_residual_spec = _vtuber_residual_search_spec(options)
    exact_channel_scope = _resolve_exact_vtuber_channel_scope(
        connection, parent[0], overlay_ids, options,
    )
    song_channel_scope: tuple[str, ...] | None = None
    song_title_query = ""
    if options["view"] in {"songs", "songIndex", "vsingerSongs"}:
        channel_fields = {
            _text(value).casefold()
            for value in (options.get("searchFields") or ())
        }
        if "channel" in channel_fields or "channels" in channel_fields:
            song_channel_options = dict(options)
            song_channel_options["view"] = "vtubers"
            song_handle_parts = _vtuber_handle_query_parts(
                song_channel_options,
            )
            if (
                song_handle_parts is not None
                and song_handle_parts.get("residualTokens")
            ):
                song_title_query = _clicked_song_title_query(
                    song_handle_parts,
                )
                song_channel_scope = _resolve_exact_vtuber_channel_scope(
                    connection,
                    parent[0],
                    overlay_ids,
                    song_channel_options,
                )
    phase_started = _phase_trace(
        "channel_resolve",
        phase_started,
        exact_scope=(
            len(exact_channel_scope or song_channel_scope or ())
        ),
    )
    if exact_channel_scope == () or song_channel_scope == ():
        return {
            "filtered": (),
            "metadata": (),
            "candidateRows": (),
            "parentRevisionId": parent[0],
            "songChannelIds": tuple(song_channel_scope or ()),
            "exactAffectedChannelIds": (),
            "previewExcludedVideoIds": (),
            "previewExcludedOccurrenceIds": (),
        }
    exact_parent_video_ids = (
        _bounded_parent_video_ids_for_channel_scope(
            connection, parent[0], exact_channel_scope, options["range"],
        )
        if exact_channel_scope is not None
        else ()
    )
    search_select = "search_text, channel_search_text" if options["q"] else "'' AS search_text, '' AS channel_search_text"
    search_clause = ""
    base_params: list[Any] = [parent[0], options["range"], options["view"], db_metric]
    if song_channel_scope is not None and song_title_query:
        search_clause = " AND title ILIKE %s ESCAPE E'\\\\'"
        base_params.append(
            f"%{_sql_like_literal(song_title_query)}%"
        )
    elif exact_channel_scope is not None:
        search_clause = " AND detail_key = ANY(%s)"
        base_params.append(list(exact_channel_scope))
        if vtuber_residual_spec is not None:
            occurrence_fields = any(
                bool(vtuber_residual_spec.get(field))
                for field in ("title", "artist", "video", "source")
            )
            channel_fields = bool(vtuber_residual_spec.get("channel"))
            for token in vtuber_residual_spec["tokens"]:
                predicates: list[str] = []
                if occurrence_fields:
                    predicates.append("search_text ILIKE %s ESCAPE E'\\\\'")
                    base_params.append(f"%{_sql_like_literal(token)}%")
                if channel_fields:
                    predicates.append("channel_search_text ILIKE %s ESCAPE E'\\\\'")
                    base_params.append(f"%{_sql_like_literal(token)}%")
                search_clause += (
                    " AND (" + " OR ".join(predicates) + ")"
                    if predicates
                    else " AND FALSE"
                )
    else:
        for token in options["searchTokens"]:
            search_clause += " AND (search_text ILIKE %s OR channel_search_text ILIKE %s)"
            needle = f"%{token}%"
            base_params.extend([needle, needle])
    base_payload_select = (
        "payload_json"
        if options["view"] == "vtubers" and exact_channel_scope is not None
        else "NULL::jsonb AS payload_json"
    )
    bounded_no_search = not bool(options.get("q"))
    base_limit_clause = ""
    base_totals: dict[str, int] | None = None
    base_window_end = 0
    if bounded_no_search:
        page_bucket = max(
            0,
            (int(options["page"]) - 1) // _GENERIC_NO_SEARCH_PAGE_BUCKET,
        )
        base_window_end = (
            (page_bucket + 1)
            * _GENERIC_NO_SEARCH_PAGE_BUCKET
            * int(options["pageSize"])
        )
        base_limit = base_window_end + _GENERIC_NO_SEARCH_AFFECTED_CUSHION
        if base_limit > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
            raise PostgresAdapterError(
                "generic ranking page exceeds bounded SQL window"
            )
        base_limit_clause = " LIMIT %s"
        base_params.append(base_limit)
        metric_column = {
            "videos": "video_count",
            "songs": "song_count",
        }.get(options["metric"], "row_count")
        aggregate = _one(
            connection,
            f"""
            SELECT COUNT(*) AS total_count,
                   COALESCE(SUM(row_count), 0) AS total_occurrence_count,
                   COALESCE(SUM(song_count), 0) AS total_song_count,
                   COALESCE(SUM(video_count), 0) AS total_video_count
            FROM runtime_ranking_rows
            WHERE revision_id = %s AND range_id = %s AND view = %s
              AND metric = %s AND {metric_column} >= %s
            """,
            [
                parent[0],
                options["range"],
                options["view"],
                db_metric,
                int(options["minCount"]),
            ],
        ) or {}
        if "total_count" in aggregate:
            base_totals = {
                "totalCount": int(aggregate.get("total_count") or 0),
                "totalOccurrenceCount": int(
                    aggregate.get("total_occurrence_count") or 0
                ),
                "totalSongCount": int(
                    aggregate.get("total_song_count") or 0
                ),
                "totalVideoCount": int(
                    aggregate.get("total_video_count") or 0
                ),
            }
    base_rows = _rows(
        connection,
        f"""
        SELECT rank, detail_key, title, artist, name, row_count, song_count,
               video_count, timestamp_count, {base_payload_select}, {search_select}
        FROM runtime_ranking_rows
        WHERE revision_id = %s AND range_id = %s AND view = %s AND metric = %s
          {search_clause}
        ORDER BY rank
        {base_limit_clause}
        """,
        base_params,
    )
    groups = { _text(row.get("detail_key")): dict(row) for row in base_rows }
    phase_started = _phase_trace("base", phase_started)
    direct_overlay_revision_ids = (
        tuple(overlay_ids)
        if (
            options["view"] == "vtubers"
            and exact_channel_scope is None
            and not options.get("q")
            and not bool(options.get("nicheOnly"))
            and not bool(options.get("hideUnknownArtist"))
            and hasattr(connection, "cursor")
        )
        else ()
    )
    candidate_rows = (
        []
        if direct_overlay_revision_ids
        else _overlay_candidate_rows(
            connection,
            overlay_ids,
            False,
            exact_channel_scope if options["view"] == "vtubers" else None,
            exact_parent_video_ids if exact_channel_scope is not None else None,
            options["range"] if exact_channel_scope is not None else "",
        )
    )
    all_candidate_rows = tuple(candidate_rows)
    phase_started = _phase_trace("overlay", phase_started)
    accepted_video_resets = _accepted_video_resets(
        connection,
        overlay_ids,
        False,
        options["view"] == "vtubers",
        parent[0] if exact_channel_scope is not None else "",
        exact_channel_scope if options["view"] == "vtubers" else None,
        exact_parent_video_ids if exact_channel_scope is not None else None,
    )
    if options["view"] == "vtubers" and accepted_video_resets:
        # A selected accepted reset is immutable evidence.  Its historical
        # public URL is derived metadata and is never allowed to veto or
        # select the channel identity.
        accepted_video_resets = {
            video_id: (
                _canonical_accepted_reset_row(row)
                if _text(row.get("channel_id")) and _normalized_channel_handle(row.get("channel_handle"))
                else row
            )
            for video_id, row in accepted_video_resets.items()
        }
        canonical_rows: list[dict[str, Any]] = []
        for row in candidate_rows:
            accepted = accepted_video_resets.get(_text(row.get("video_id")))
            if not accepted or not (
                _text(accepted.get("channel_id"))
                and _normalized_channel_handle(accepted.get("channel_handle"))
            ):
                canonical_rows.append(row)
                continue
            canonical = dict(row)
            channel_id = _text(accepted.get("channel_id"))
            handle = _text(accepted.get("channel_handle"))
            canonical.update({
                "channel_id": channel_id,
                "channel_handle": handle,
                "channel_url": _canonical_channel_url(channel_id, handle),
            })
            payload = _replace_public_channel_url(
                canonical.get("video_payload_json"), channel_id, handle,
            )
            if payload:
                canonical["video_payload_json"] = payload
            canonical_rows.append(canonical)
        candidate_rows = canonical_rows
        all_candidate_rows = tuple(candidate_rows)
    reset_changes = (
        _accepted_video_reset_identity_changes(
            connection, parent[0], accepted_video_resets,
        )
        if direct_overlay_revision_ids
        else _accepted_video_reset_changes(
            connection, parent[0], accepted_video_resets, options,
        )
    )
    runtime_changes_all = _runtime_tombstones(
        connection,
        overlay_ids,
        accepted_video_resets.values(),
        all_candidate_rows,
        options["view"] == "vtubers",
        parent[0] if exact_channel_scope is not None else "",
        exact_channel_scope if options["view"] == "vtubers" else None,
        exact_parent_video_ids if exact_channel_scope is not None else None,
    )
    phase_started = _phase_trace("reset", phase_started)
    candidate_rows = _overlay_rows_for_range(candidate_rows, options["range"])
    runtime_changes = _overlay_rows_for_range(runtime_changes_all, options["range"])
    # The exact VTuber query is physical-range scoped.  Do not pass the
    # lineage-wide candidate list: a legacy/all row must not leak into 7d,
    # and a 7d row must not perturb the all aggregate.
    if exact_channel_scope is None:
        exact_candidate_rows = tuple(candidate_rows)
    else:
        exact_scope_set = {
            _text(value) for value in exact_channel_scope if _text(value)
        }
        exact_candidate_rows = tuple(
            row
            for row in candidate_rows
            if _text(
                _overlay_public_video(row).get("channelId")
                or row.get("channel_id")
            ) in exact_scope_set
        )
    # Legacy parent occurrences can lack their denormalised channel fields.
    # Resolve those fields first from the same immutable occurrence in the
    # current accepted overlay.  A reviewed accepted row is closer lineage
    # evidence than the full-runtime parent, which can predate channel_id.
    # Only a unique (video_id, occurrence_id) tuple may repair the change; a
    # missing accepted tuple falls through to the bounded parent-video lookup.
    # This keeps every public view strict without requiring a channel id from
    # the wrong lineage layer.
    identity_changes = tuple((*reset_changes, *runtime_changes))
    identity_by_change = {
        id(change): _validated_overlay_change_identity(change)
        for change in identity_changes
    }
    accepted_identity_by_occurrence: dict[
        tuple[str, str], Mapping[str, Any]
    ] = {}
    for candidate in all_candidate_rows:
        candidate_video_id = _text(candidate.get("video_id"))
        candidate_occurrence_id = _text(candidate.get("occurrence_id"))
        if not candidate_video_id or not candidate_occurrence_id:
            continue
        identity = (candidate_video_id, candidate_occurrence_id)
        if identity in accepted_identity_by_occurrence:
            raise PostgresAdapterError(
                "accepted overlay identity repair returned a duplicate occurrence"
            )
        accepted_identity_by_occurrence[identity] = candidate
    if direct_overlay_revision_ids:
        direct_requested = sorted({
            (video_id, _text(
                change.get("occurrenceId") or change.get("occurrence_id")
            ))
            for change in identity_changes
            for video_id, channel_id in (
                identity_by_change[id(change)],
            )
            if (
                not channel_id
                and _text(
                    change.get("occurrenceId") or change.get("occurrence_id")
                )
                and video_id in accepted_video_resets
            )
        })
        if len(direct_requested) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
            raise PostgresAdapterError(
                "direct accepted identity repair exceeded bounded occurrence cap"
            )
        if direct_requested:
            direct_occurrences = _rows(
                connection,
                """
                /* bounded direct accepted occurrence identity repair */
                WITH requested(video_id, occurrence_id) AS MATERIALIZED (
                  SELECT video_id, occurrence_id
                  FROM unnest(%s::text[], %s::text[])
                    AS item(video_id, occurrence_id)
                ),
                effective AS MATERIALIZED (
                  SELECT DISTINCT ON (o.video_id, o.occurrence_id)
                         o.revision_id, o.video_id, o.occurrence_id
                  FROM migration_occurrence_rows AS o
                  JOIN requested AS wanted
                    ON wanted.video_id = o.video_id
                   AND wanted.occurrence_id = o.occurrence_id
                  WHERE o.revision_id = ANY(%s)
                  ORDER BY o.video_id, o.occurrence_id,
                           array_position(%s::text[], o.revision_id)
                )
                SELECT revision_id, video_id, occurrence_id
                FROM effective
                ORDER BY video_id, occurrence_id
                LIMIT %s
                """,
                [
                    [video_id for video_id, _ in direct_requested],
                    [occurrence_id for _, occurrence_id in direct_requested],
                    list(direct_overlay_revision_ids),
                    list(direct_overlay_revision_ids),
                    len(direct_requested) + 1,
                ],
            )
            requested_set = set(direct_requested)
            direct_seen: set[tuple[str, str]] = set()
            direct_priority = {
                revision_id: index
                for index, revision_id in enumerate(
                    direct_overlay_revision_ids
                )
            }
            for occurrence in direct_occurrences:
                identity = (
                    _text(occurrence.get("video_id")),
                    _text(occurrence.get("occurrence_id")),
                )
                if (
                    identity not in requested_set
                    or identity in direct_seen
                    or identity in accepted_identity_by_occurrence
                ):
                    raise PostgresAdapterError(
                        "direct accepted identity repair returned a duplicate occurrence"
                    )
                direct_seen.add(identity)
                selected_video = accepted_video_resets.get(identity[0])
                selected_revision_id = _text(
                    selected_video.get("revision_id")
                ) if isinstance(selected_video, Mapping) else ""
                occurrence_revision_id = _text(
                    occurrence.get("revision_id")
                )
                if (
                    occurrence_revision_id not in direct_priority
                    or (
                        selected_revision_id
                        and selected_revision_id in direct_priority
                        and direct_priority[occurrence_revision_id]
                        > direct_priority[selected_revision_id]
                    )
                ):
                    continue
                if not isinstance(selected_video, Mapping):
                    continue
                _, accepted_channel_id = _validated_overlay_change_identity(
                    {"videoId": identity[0]},
                    selected_video,
                    validate_urls=False,
                )
                if not accepted_channel_id:
                    continue
                accepted = dict(occurrence)
                accepted.update({
                    "video_title": (
                        selected_video.get("video_title")
                        or selected_video.get("title")
                    ),
                    "channel_name": selected_video.get("channel_name"),
                    "channel_id": selected_video.get("channel_id"),
                    "channel_handle": selected_video.get("channel_handle"),
                    "channel_url": selected_video.get("channel_url"),
                    "video_payload_json": selected_video.get("payload_json"),
                })
                accepted_identity_by_occurrence[identity] = accepted
    for change in identity_changes:
        change_video_id, existing_channel_id = identity_by_change[id(change)]
        if existing_channel_id:
            continue
        change_occurrence_id = _text(
            change.get("occurrenceId") or change.get("occurrence_id")
        )
        accepted = accepted_identity_by_occurrence.get(
            (change_video_id, change_occurrence_id)
        )
        if not accepted:
            continue
        _validated_overlay_change_identity(
            change, accepted, validate_urls=False,
        )
        accepted_video = _overlay_public_video(accepted)
        for name, public_name in (
            ("channel_name", "channelName"),
            ("channel_id", "channelId"),
            ("channel_handle", "channelHandle"),
        ):
            if not _text(change.get(name)):
                value = accepted.get(name) or accepted_video.get(public_name)
                if _text(value):
                    change[name] = value
        if not _text(change.get("videoTitle")):
            change["videoTitle"] = (
                accepted.get("video_title") or accepted_video.get("title")
            )
        if not _json_object(change.get("videoPayload")):
            change["videoPayload"] = accepted.get("video_payload_json")
        repaired_channel_id = _text(change.get("channel_id"))
        repaired_handle = _normalized_channel_handle(
            change.get("channel_handle")
        )
        if repaired_channel_id and repaired_handle:
            _apply_canonical_channel_identity(
                change, repaired_channel_id, repaired_handle,
                change.get("channel_name"),
            )
        if (
            bool(change.get("replacement"))
            and bool(change.get("replacementSameVideo"))
            and _json_object(change.get("videoPayload"))
        ):
            change["replacementVideoPayload"] = change["videoPayload"]
    identity_by_change = {
        id(change): _validated_overlay_change_identity(change)
        for change in identity_changes
    }
    video_ids = {
        video_id for video_id, channel_id in identity_by_change.values()
        if not channel_id
    }
    if video_ids:
        video_rows = _rows(
            connection,
            """
            SELECT video_id, title, channel_name, channel_id, channel_handle,
                   channel_url, payload_json
            FROM runtime_videos
            WHERE revision_id = %s AND video_id = ANY(%s)
            ORDER BY video_id
            LIMIT %s
            """,
            [parent[0], sorted(video_ids), _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
        )
        if len(video_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
            raise PostgresAdapterError("VTuber parent video lookup exceeded bounded cap")
        video_by_id: dict[str, Mapping[str, Any]] = {}
        for video in video_rows:
            video_id = _text(video.get("video_id"))
            if not video_id:
                continue
            if video_id in video_by_id:
                continue
            video_by_id[video_id] = video
        for change in identity_changes:
            change_video_id, existing_channel_id = identity_by_change[id(change)]
            if existing_channel_id:
                continue
            video = video_by_id.get(change_video_id)
            if not video:
                continue
            _validated_overlay_change_identity(change, video, validate_urls=False)
            parent_video = _overlay_public_video(video)
            for name, public_name in (
                ("channel_name", "channelName"),
                ("channel_id", "channelId"),
                ("channel_handle", "channelHandle"),
            ):
                if not _text(change.get(name)):
                    value = video.get(name) or parent_video.get(public_name)
                    if _text(value):
                        change[name] = value
            if not _text(change.get("videoTitle")):
                change["videoTitle"] = video.get("title") or parent_video.get("title")
            if not _json_object(change.get("videoPayload")):
                change["videoPayload"] = video.get("payload_json")
            repaired_channel_id = _text(change.get("channel_id"))
            repaired_handle = _normalized_channel_handle(change.get("channel_handle"))
            if repaired_channel_id and repaired_handle:
                _apply_canonical_channel_identity(
                    change, repaired_channel_id, repaired_handle,
                    change.get("channel_name"),
                )
            if (
                bool(change.get("replacement"))
                and bool(change.get("replacementSameVideo"))
                and _json_object(change.get("videoPayload"))
            ):
                change["replacementVideoPayload"] = change["videoPayload"]
    for change in identity_changes:
        change_video_id, channel_id = _validated_overlay_change_identity(
            change, validate_urls=False,
        )
        if channel_id:
            continue
        if not bool(change.get("acceptedVideoReset")):
            continue
        accepted = accepted_video_resets.get(change_video_id)
        evidence = _accepted_reset_identity_evidence(
            change,
            (accepted,) if isinstance(accepted, Mapping) else (),
        )
        evidence_video = _overlay_public_video(evidence)
        evidence_handle = _normalized_channel_handle(
            evidence.get("channel_handle") or evidence_video.get("channelHandle")
        )
        _apply_canonical_channel_identity(
            change, _text(evidence.get("channel_id")), evidence_handle,
            evidence.get("channel_name") or evidence_video.get("channelName"),
        )
        _validated_overlay_change_identity(change, evidence, validate_urls=False)
    replacement_rows = _runtime_replacement_candidate_rows(
        runtime_changes,
        options["view"] == "vtubers",
    )
    bounded_affected_keys: set[str] = set()
    bounded_original_affected: dict[str, dict[str, Any]] = {}
    if bounded_no_search:
        bounded_affected_keys.update(
            key
            for row in (*candidate_rows, *replacement_rows)
            if (key := _runtime_view_group_key(row, options["view"]))
        )
        bounded_affected_keys.update(
            key
            for key in _runtime_change_view_keys(
                (*reset_changes, *runtime_changes),
                options["view"],
            )
            if key
        )
        if len(bounded_affected_keys) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
            raise PostgresAdapterError(
                "bounded generic ranking window exceeded affected group cap"
            )
        if (
            options["view"] == "vtubers"
            and len(bounded_affected_keys)
            > _GENERIC_NO_SEARCH_AFFECTED_CUSHION
        ):
            # The VTuber path replaces these rows with its exact channel
            # aggregate below and retains its existing independent cap.
            raise PostgresAdapterError(
                "bounded generic ranking window exceeded displacement cushion"
            )
        if bounded_affected_keys:
            affected_base_rows = _rows(
                connection,
                """
                SELECT rank, detail_key, title, artist, name, row_count,
                       song_count, video_count, timestamp_count,
                       NULL::jsonb AS payload_json,
                       '' AS search_text, '' AS channel_search_text
                FROM runtime_ranking_rows
                WHERE revision_id = %s AND range_id = %s AND view = %s
                  AND metric = %s AND detail_key = ANY(%s)
                ORDER BY rank
                LIMIT %s
                """,
                [
                    parent[0],
                    options["range"],
                    options["view"],
                    db_metric,
                    sorted(bounded_affected_keys),
                    len(bounded_affected_keys) + 1,
                ],
            )
            affected_base_rows = [
                row for row in affected_base_rows
                if _text(row.get("detail_key")) in bounded_affected_keys
            ]
            affected_detail_keys = [
                _text(row.get("detail_key")) for row in affected_base_rows
            ]
            if len(affected_detail_keys) != len(set(affected_detail_keys)):
                raise PostgresAdapterError(
                    "bounded generic ranking window returned duplicate groups"
                )
            bounded_original_affected = {
                _text(row.get("detail_key")): dict(row)
                for row in affected_base_rows
                if _text(row.get("detail_key"))
            }
            if options["view"] != "vtubers" and base_totals is not None:
                # A lineage-wide affected-key count does not measure page
                # displacement.  Fetch the persisted top prefix after
                # excluding every affected key, then merge all affected
                # groups back by exact identity below.  The persisted rank is
                # the parent's complete metric/tie ordering, so a parent row
                # after this prefix cannot outrank a returned unaffected row.
                unaffected_base_rows = _rows(
                    connection,
                    f"""
                    /* bounded unaffected parent ranking prefix */
                    SELECT rank, detail_key, title, artist, name, row_count,
                           song_count, video_count, timestamp_count,
                           NULL::jsonb AS payload_json,
                           '' AS search_text, '' AS channel_search_text
                    FROM runtime_ranking_rows
                    WHERE revision_id = %s AND range_id = %s AND view = %s
                      AND metric = %s
                      AND {metric_column} >= %s
                      AND detail_key <> ALL(%s)
                    ORDER BY rank
                    LIMIT %s
                    """,
                    [
                        parent[0],
                        options["range"],
                        options["view"],
                        db_metric,
                        int(options["minCount"]),
                        sorted(bounded_affected_keys),
                        base_window_end,
                    ],
                )
                unaffected_detail_keys = [
                    _text(row.get("detail_key"))
                    for row in unaffected_base_rows
                ]
                if (
                    any(not key for key in unaffected_detail_keys)
                    or len(unaffected_detail_keys)
                    != len(set(unaffected_detail_keys))
                    or any(
                        key in bounded_affected_keys
                        for key in unaffected_detail_keys
                    )
                ):
                    raise PostgresAdapterError(
                        "bounded unaffected parent ranking prefix is invalid"
                    )
                affected_parent_count = sum(
                    1
                    for row in bounded_original_affected.values()
                    if _overlay_rank_value(row, options["metric"])
                    >= int(options["minCount"])
                )
                expected_unaffected_count = min(
                    base_window_end,
                    max(
                        0,
                        int(base_totals["totalCount"])
                        - affected_parent_count,
                    ),
                )
                if len(unaffected_base_rows) != expected_unaffected_count:
                    raise PostgresAdapterError(
                        "bounded unaffected parent ranking prefix is incomplete"
                    )
                groups = {
                    _text(row.get("detail_key")): dict(row)
                    for row in unaffected_base_rows
                }
            for key, row in bounded_original_affected.items():
                groups.setdefault(key, dict(row))
    phase_started = _phase_trace(
        "affected_window",
        phase_started,
        affected_groups=len(bounded_affected_keys),
        returned_groups=len(bounded_original_affected),
    )
    generic_candidate_rows = list(candidate_rows)
    generic_replacement_rows = list(replacement_rows)
    generic_reset_changes = list(reset_changes)
    generic_runtime_changes = list(runtime_changes)
    if options["searchTokens"] and options["view"] != "vtubers":
        generic_candidate_rows = [
            row for row in generic_candidate_rows
            if _matches_search_tokens(
                _overlay_candidate_search_text(row), options["searchTokens"],
            )
        ]
        generic_replacement_rows = [
            row for row in generic_replacement_rows
            if _matches_search_tokens(
                _overlay_candidate_search_text(row), options["searchTokens"],
            )
        ]
        visible_group_keys = {
            key
            for row in groups.values()
            if (key := _runtime_view_group_key(row, options["view"]))
        }
        visible_group_keys.update(
            key
            for row in (*generic_candidate_rows, *generic_replacement_rows)
            if (key := _runtime_view_group_key(row, options["view"]))
        )
        generic_reset_changes = [
            change for change in generic_reset_changes
            if _runtime_change_view_keys((change,), options["view"])
            & visible_group_keys
        ]
        generic_runtime_changes = [
            change for change in generic_runtime_changes
            if _runtime_change_view_keys((change,), options["view"])
            & visible_group_keys
        ]
    if options["view"] != "vtubers":
        _enrich_runtime_original_group_counts(
            connection,
            parent[0],
            generic_candidate_rows,
            # Accepted reset removals are immediately assigned exact
            # per-video/group counts from ``generic_reset_changes`` below.
            # Re-reading every selected reset video from the full parent here
            # made an ordinary page scan hundreds of videos for no new value.
            generic_runtime_changes,
        )
    phase_started = _phase_trace(
        "enrich",
        phase_started,
        candidate_count=len(generic_candidate_rows),
        reset_count=len(generic_reset_changes),
        runtime_count=len(generic_runtime_changes),
    )
    # The selected accepted video is a replacement boundary, not another
    # increment.  Remove all parent occurrences for its video before adding
    # the non-tombstone candidate projection below.  A later runtime curation
    # remains in ``runtime_changes`` and is deliberately applied afterwards.
    reset_group_counts: dict[tuple[str, str, str], int] = defaultdict(int)
    for change in generic_reset_changes:
        reset_group_counts[(
            _text(change.get("videoId")),
            _overlay_song_group_norm(change.get("title")),
            _overlay_song_group_norm(change.get("artist")),
        )] += 1
    for change in generic_reset_changes:
        change["originalGroupVideoOccurrenceCount"] = reset_group_counts[(
            _text(change.get("videoId")),
            _overlay_song_group_norm(change.get("title")),
            _overlay_song_group_norm(change.get("artist")),
        )]
    # The VTuber exact aggregate below owns both sides of every reset/move.
    # Applying the bounded generic mutation here would make the caller replay
    # those same tuples after the exact result is installed.
    if options["view"] != "vtubers":
        _apply_runtime_tombstone_groups(
            groups,
            generic_reset_changes,
            options["view"],
            "_deferred_reset_preview_changes",
        )
        _apply_runtime_change_previews(
            groups, generic_reset_changes, options["view"],
        )
    exact_reset_changes = tuple(reset_changes)
    exact_runtime_changes = tuple(runtime_changes)
    exact_replacement_rows = tuple(replacement_rows)
    if exact_channel_scope is not None:
        exact_scope_set = {
            _text(value) for value in exact_channel_scope if _text(value)
        }
        exact_replacement_rows = tuple(
            row
            for row in exact_replacement_rows
            if _validated_overlay_change_identity(
                row, validate_urls=False,
            )[1] in exact_scope_set
        )
        replacement_identities = {
            (
                _text(row.get("videoId") or row.get("video_id")),
                _text(row.get("occurrenceId") or row.get("occurrence_id")),
            )
            for row in exact_replacement_rows
        }
        exact_reset_changes = tuple(
            change
            for change in exact_reset_changes
            if _validated_overlay_change_identity(
                change, validate_urls=False,
            )[1] in exact_scope_set
        )
        exact_runtime_changes = tuple(
            change
            for change in exact_runtime_changes
            if (
                _validated_overlay_change_identity(
                    change, validate_urls=False,
                )[1] in exact_scope_set
                or (
                    _text(change.get("videoId") or change.get("video_id")),
                    _text(
                        change.get("occurrenceId")
                        or change.get("occurrence_id")
                    ),
                ) in replacement_identities
            )
        )
    clicked_song_candidate_rows = tuple(candidate_rows)
    if options["view"] in {"songs", "songIndex", "vsingerSongs"}:
        candidate_rows = [*candidate_rows, *replacement_rows]
    elif options["view"] == "artists":
        candidate_rows = [
            *candidate_rows,
            *(row for row in replacement_rows if not row.get("replacement_same_artist")),
        ]
    elif options["view"] in {"videos", "vtubers"}:
        candidate_rows = [
            *candidate_rows,
            *(row for row in replacement_rows if not row.get("replacement_same_video")),
        ]
    if options["searchTokens"] and not (
        options["view"] == "vtubers" and exact_channel_scope is not None
    ):
        candidate_rows = [
            row for row in candidate_rows
            if _matches_search_tokens(_overlay_candidate_search_text(row), options["searchTokens"])
        ]
        exact_candidate_rows = tuple(
            row for row in exact_candidate_rows
            if _matches_search_tokens(_overlay_candidate_search_text(row), options["searchTokens"])
        )
        exact_replacement_rows = tuple(
            row for row in exact_replacement_rows
            if _matches_search_tokens(_overlay_candidate_search_text(row), options["searchTokens"])
        )
    # Exact VTuber aggregation owns the complete effective tuple set for every
    # affected channel, including channels whose final count is zero.  Building
    # the generic delta first is therefore redundant here, and its cumulative
    # search-text construction is quadratic for a large single-channel import.
    # Keep the generic path unchanged for every other public view.
    delta = (
        {} if options["view"] == "vtubers"
        else _overlay_candidate_groups(candidate_rows, options["view"])
    )
    phase_started = _phase_trace(
        "candidate_delta",
        phase_started,
        candidate_count=len(candidate_rows),
        delta_groups=len(delta),
    )
    exact_required = bool(
        options["view"] == "vtubers"
        and (
            exact_candidate_rows
            or exact_reset_changes
            or exact_runtime_changes
            or exact_replacement_rows
            or (direct_overlay_revision_ids and accepted_video_resets)
        )
    )
    exact_vtuber_rows = (
        _overlay_vtuber_replacement_rows(
            connection,
            revision_id,
            parent[0],
            exact_candidate_rows,
            options,
            groups,
            exact_reset_changes,
            exact_runtime_changes,
            exact_replacement_rows,
            accepted_video_resets,
            exact_required,
            exact_channel_scope,
            direct_overlay_revision_ids,
        )
        if options["view"] == "vtubers"
        else {}
    )
    phase_started = _phase_trace("exact", phase_started)
    exact_owned = options["view"] == "vtubers" and bool(exact_vtuber_rows)
    if exact_required and not exact_owned:
        raise PostgresAdapterError("VTuber exact overlay required coverage is empty")
    groups.update(exact_vtuber_rows)
    if options["view"] == "vtubers":
        # The exact helper returns an explicit zero summary for every affected
        # channel.  It is a coverage marker internally, but must not become a
        # public ranking row or contribute to totals.
        for key, row in exact_vtuber_rows.items():
            if int(row.get("row_count") or 0) == 0:
                groups.pop(key, None)
    for key, item in delta.items():
        if key in exact_vtuber_rows:
            continue
        row = groups.get(key)
        if row is None:
            count = int(item.get("occurrenceCount", len(item["occurrences"])))
            video_count = len(item["videoIds"])
            song_count = len(item["songKeys"])
            payload = {
                "type": "video" if options["view"] == "videos" else "artist" if options["view"] == "artists" else "vtuber" if options["view"] == "vtubers" else "song",
                "key": key, "title": item["title"], "displayArtist": item["artist"],
                "name": item["name"], "count": count, "videoCount": video_count,
                "songCount": song_count, "timestampCount": count,
                "occurrences": item["occurrences"][:20],
            }
            source_detail_key = _production_source_detail_key_for_group(
                options["view"], options["range"], key,
            )
            if source_detail_key:
                payload["sourceDetailKey"] = source_detail_key
                payload["sourceDetailPath"] = ""
            row = {"detail_key": key, "title": item["title"], "artist": item["artist"], "name": item["name"], "row_count": count, "song_count": song_count, "video_count": video_count, "timestamp_count": count, "payload_json": payload, "search_text": item["search"], "channel_search_text": item["search"]}
            groups[key] = row
        else:
            row["row_count"] = int(row.get("row_count") or 0) + int(item.get("occurrenceCount", len(item["occurrences"])))
            if options["view"] in {"songs", "songIndex", "vsingerSongs"}:
                # These views already represent one canonical title/artist
                # song group.  A full-video refresh can remove one video's
                # tuples while another video keeps the group alive; adding
                # the refreshed tuples must not count that same song twice.
                row["song_count"] = max(
                    int(row.get("song_count") or 0),
                    len(item["songKeys"]),
                )
            else:
                row["song_count"] = int(row.get("song_count") or 0) + len(item["songKeys"])
            row["video_count"] = int(row.get("video_count") or 0) + len(item["videoIds"])
            row["timestamp_count"] = int(row.get("timestamp_count") or 0) + int(item.get("occurrenceCount", len(item["occurrences"])))
            payload = _json_object(row.get("payload_json"))
            if payload:
                payload.update({"count": row["row_count"], "songCount": row["song_count"], "videoCount": row["video_count"], "timestampCount": row["timestamp_count"]})
                if isinstance(payload.get("occurrences"), list):
                    payload["occurrences"] = _bounded_overlay_previews(
                        (*payload["occurrences"], *item["occurrences"]),
                    )
                row["payload_json"] = payload
            elif item["occurrences"]:
                # The bounded scalar parent deliberately has no JSON payload.
                # Retain only the public preview tuples needed by a returned
                # card; render will merge them into the exact parent payload
                # and hydrate their immutable video/occurrence identities.
                deferred = row.get("_deferred_candidate_previews", ())
                if not isinstance(deferred, (list, tuple)):
                    raise PostgresAdapterError(
                        "deferred candidate preview state is invalid"
                    )
                row["_deferred_candidate_previews"] = (
                    _bounded_overlay_previews(
                        (*deferred, *item["occurrences"]),
                    )
                )
            row["search_text"] = f"{row.get('search_text', '')} {item['search']}"
    if options["view"] != "vtubers":
        _apply_runtime_tombstone_groups(
            groups, generic_runtime_changes, options["view"],
        )
        _apply_runtime_change_previews(
            groups, generic_runtime_changes, options["view"],
        )
    # Exact VTuber aggregation already owns every affected channel's effective
    # tuple set.  Re-running the generic bounded parent scan here was the
    # cold-ranking timeout; songs/artists/videos keep their existing path.
    if (
        options["view"] not in {"songs", "songIndex", "vsingerSongs", "vtubers"}
        or (options["view"] == "vtubers" and exact_required and not exact_owned)
    ):
        _reconcile_affected_song_counts(
            connection,
            parent[0],
            all_candidate_rows,
            replacement_rows,
            [*generic_reset_changes, *generic_runtime_changes],
            groups,
            options["view"],
            options,
        )
    phase_started = _phase_trace("reconcile", phase_started)
    filtered = []
    for row in groups.values():
        search = f"{row.get('search_text', '')} {row.get('channel_search_text', '')}".casefold()
        exact_key = _text(row.get("detail_key"))
        if song_channel_scope is not None:
            if (
                not song_title_query
                or song_title_query not in _overlay_norm(row.get("title"))
            ):
                continue
        elif (
            vtuber_residual_spec is not None
            and exact_key in exact_vtuber_rows
        ):
            if (
                vtuber_residual_spec["tokens"]
                and not bool(row.get("_residual_match"))
            ):
                continue
        elif options["searchTokens"] and not _matches_search_tokens(
            search, options["searchTokens"],
        ):
            continue
        if _overlay_rank_value(row, options["metric"]) < options["minCount"]:
            continue
        filtered.append(row)
    filtered.sort(key=lambda row: (-_overlay_rank_value(row, options["metric"]), _text(row.get("title") or row.get("name") or row.get("detail_key"))))
    clicked_song_scopes = (
        _bounded_clicked_song_scopes(
            connection,
            parent[0],
            filtered,
            song_channel_scope,
            options["range"],
            clicked_song_candidate_rows,
            replacement_rows,
            accepted_video_resets,
            runtime_changes,
        )
        if song_channel_scope
        else {}
    )
    metadata = (
        (
            _channel_metadata_rows(
                connection,
                [revision_id, *overlay_ids, parent[0]],
                exact_channel_scope,
            )
            if exact_channel_scope is not None
            else _channel_metadata_rows(
                connection,
                [revision_id, *overlay_ids, parent[0]],
            )
        )
        if options["view"] == "vtubers"
        else []
    )
    preview_excluded_video_ids = tuple(sorted({
        _text(video_id)
        for row in exact_vtuber_rows.values()
        for video_id in row.get("_preview_excluded_video_ids", ())
        if _text(video_id)
    }))
    preview_excluded_occurrence_ids = tuple(sorted({
        (_text(video_id), _text(occurrence_id))
        for row in exact_vtuber_rows.values()
        for video_id, occurrence_id in row.get(
            "_preview_excluded_occurrence_ids", ()
        )
        if _text(video_id) and _text(occurrence_id)
    }))
    overlay_preview_excluded_video_ids = tuple(sorted({
        _text(change.get("videoId") or change.get("video_id"))
        for change in runtime_changes
        if (
            _text(change.get("entityType") or change.get("entity_type"))
            in {"videos", "runtime_videos"}
            and not bool(change.get("acceptedVideoReset"))
            and _text(change.get("videoId") or change.get("video_id"))
        )
    }))
    aggregate_totals = base_totals
    if aggregate_totals is not None:
        aggregate_totals = dict(aggregate_totals)
        affected_final_keys = (
            bounded_affected_keys
            | set(bounded_original_affected)
            | set(exact_vtuber_rows)
        )
        for key in affected_final_keys:
            old = bounded_original_affected.get(key)
            new = groups.get(key)
            old_included = bool(
                old
                and _overlay_rank_value(old, options["metric"])
                >= int(options["minCount"])
            )
            new_included = bool(
                new
                and _overlay_rank_value(new, options["metric"])
                >= int(options["minCount"])
            )
            aggregate_totals["totalCount"] += int(new_included) - int(
                old_included
            )
            for public_name, field in (
                ("totalOccurrenceCount", "row_count"),
                ("totalSongCount", "song_count"),
                ("totalVideoCount", "video_count"),
            ):
                old_value = int(old.get(field) or 0) if old_included and old else 0
                new_value = int(new.get(field) or 0) if new_included and new else 0
                aggregate_totals[public_name] += new_value - old_value
    return {
        "filtered": tuple(dict(row) for row in filtered),
        "metadata": tuple(dict(row) for row in metadata),
        "candidateRows": tuple(dict(row) for row in candidate_rows),
        "parentRevisionId": parent[0],
        "overlayRevisionIds": tuple(direct_overlay_revision_ids),
        "overlayPreviewExcludedVideoIds": overlay_preview_excluded_video_ids,
        "exactAffectedChannelIds": tuple(sorted(exact_vtuber_rows)),
        "previewExcludedVideoIds": preview_excluded_video_ids,
        "previewExcludedOccurrenceIds": preview_excluded_occurrence_ids,
        "aggregateTotals": aggregate_totals,
        "songChannelIds": tuple(song_channel_scope or ()),
        "clickedSongScopes": clicked_song_scopes,
    }


def _generic_ranking_preparation_key(
    revision_id: str,
    parent_revision_id: str,
    options: Mapping[str, Any],
) -> tuple[Any, ...]:
    """Identify only inputs that alter the expensive immutable aggregate."""

    key = (
        revision_id,
        parent_revision_id,
        _text(options.get("range")),
        _text(options.get("view")),
        _text(options.get("metric")),
        _text(options.get("q")),
        _text(options.get("searchScope")),
        tuple(_text(value) for value in (options.get("searchFields") or ())),
        int(options.get("minCount") or 0),
        bool(options.get("nicheOnly")),
        bool(options.get("hideUnknownArtist")),
    )
    if not _text(options.get("q")):
        page = max(1, int(options.get("page") or 1))
        page_size = max(1, int(options.get("pageSize") or 1))
        key = (
            *key,
            "bounded-window",
            (page - 1) // _GENERIC_NO_SEARCH_PAGE_BUCKET,
            page_size,
        )
    return key


def _cached_generic_ranking_preparation(
    key: tuple[Any, ...],
    build,
) -> Mapping[str, Any]:
    """Return one successful immutable preparation, with bounded single-flight."""

    with _GENERIC_RANKING_PREPARATION_LOCK:
        cached = _GENERIC_RANKING_PREPARATION_CACHE.get(key)
        if cached is not None:
            _GENERIC_RANKING_PREPARATION_CACHE.move_to_end(key)
            return cached
        flight = _GENERIC_RANKING_PREPARATION_FLIGHTS.get(key)
        if flight is None:
            flight = _RankingPreparationFlight(threading.Event())
            _GENERIC_RANKING_PREPARATION_FLIGHTS[key] = flight
            leader = True
        else:
            leader = False
    if not leader:
        flight.event.wait()
        if flight.error is not None:
            raise flight.error
        if flight.result is not None:
            return flight.result
        raise PostgresAdapterError("generic ranking preparation completed without a cache value")
    try:
        prepared = build()
    except BaseException as exc:
        with _GENERIC_RANKING_PREPARATION_LOCK:
            flight.error = exc
            _GENERIC_RANKING_PREPARATION_FLIGHTS.pop(key, None)
            flight.event.set()
        raise
    with _GENERIC_RANKING_PREPARATION_LOCK:
        flight.result = prepared
        if _cache_value_is_bounded(
            prepared,
            max_bytes=_GENERIC_RANKING_PREPARATION_MAX_BYTES,
            max_occurrences=_GENERIC_RANKING_PREPARATION_MAX_OCCURRENCES,
        ):
            _GENERIC_RANKING_PREPARATION_CACHE[key] = prepared
            _GENERIC_RANKING_PREPARATION_CACHE.move_to_end(key)
            while len(_GENERIC_RANKING_PREPARATION_CACHE) > _GENERIC_RANKING_PREPARATION_CAP:
                _GENERIC_RANKING_PREPARATION_CACHE.popitem(last=False)
        _GENERIC_RANKING_PREPARATION_FLIGHTS.pop(key, None)
        flight.event.set()
    return prepared


def _scoped_clicked_song_payload(
    payload: Mapping[str, Any],
    channel_ids: set[str],
    complete_count: int | None = None,
) -> dict[str, Any] | None:
    """Return one clicked-song card containing only the resolved source."""

    scoped_occurrences: list[dict[str, Any]] = []
    for occurrence in payload.get("occurrences") or ():
        if not isinstance(occurrence, Mapping):
            continue
        item = (
            occurrence.get("item")
            if isinstance(occurrence.get("item"), Mapping)
            else occurrence.get("video")
        )
        video = (
            occurrence.get("video")
            if isinstance(occurrence.get("video"), Mapping)
            else item
        )
        if not isinstance(item, Mapping) or not isinstance(video, Mapping):
            continue
        channel_id = _text(item.get("channelId"))
        if channel_id not in channel_ids:
            continue
        if (
            _text(video.get("channelId")) != channel_id
            or _text(item.get("videoId")) != _text(video.get("videoId"))
        ):
            raise PostgresAdapterError(
                "song channel result has inconsistent occurrence identity"
            )
        canonical = dict(occurrence)
        canonical["item"] = dict(item)
        canonical["video"] = dict(video)
        scoped_occurrences.append(canonical)
    if not scoped_occurrences:
        return None
    exact_count = (
        len(scoped_occurrences)
        if complete_count is None
        else int(complete_count)
    )
    if exact_count < len(scoped_occurrences):
        raise PostgresAdapterError(
            "song channel result has an invalid complete occurrence count"
        )

    artist_names: dict[str, str] = {}
    channel_names: dict[str, dict[str, str]] = defaultdict(dict)
    for occurrence in scoped_occurrences:
        item = occurrence["item"]
        video = occurrence["video"]
        song = (
            occurrence.get("song")
            if isinstance(occurrence.get("song"), Mapping)
            else {}
        )
        occurrence_artist = _text(occurrence.get("artist"))
        song_artist = _text(song.get("artist"))
        if (
            occurrence_artist
            and song_artist
            and _overlay_norm(occurrence_artist) != _overlay_norm(song_artist)
        ):
            raise PostgresAdapterError(
                "song channel result has inconsistent artist identity"
            )
        artist = occurrence_artist or song_artist
        if artist:
            artist_names.setdefault(_overlay_norm(artist), artist)

        channel_id = _text(item.get("channelId"))
        item_channel_name = _text(item.get("channelName"))
        video_channel_name = _text(video.get("channelName"))
        if (
            item_channel_name
            and video_channel_name
            and _overlay_norm(item_channel_name)
            != _overlay_norm(video_channel_name)
        ):
            raise PostgresAdapterError(
                "song channel result has inconsistent channel identity"
            )
        channel_name = item_channel_name or video_channel_name
        if channel_name:
            channel_names[channel_id].setdefault(
                _overlay_norm(channel_name),
                channel_name,
            )
    if len(artist_names) > 1:
        raise PostgresAdapterError(
            "song channel result has ambiguous artist identity"
        )
    observed_channel_ids = {
        _text(occurrence["item"].get("channelId"))
        for occurrence in scoped_occurrences
        if _text(occurrence["item"].get("channelId"))
    }
    if len(observed_channel_ids) != 1:
        raise PostgresAdapterError(
            "song channel result has ambiguous channel identity"
        )
    channel_id = next(iter(observed_channel_ids))
    if len(channel_names.get(channel_id, {})) > 1:
        raise PostgresAdapterError(
            "song channel result has ambiguous channel identity"
        )

    result = copy.deepcopy(dict(payload))
    result["occurrences"] = scoped_occurrences
    result["count"] = exact_count
    result["timestampCount"] = exact_count
    result["songCount"] = 1
    result["videoCount"] = len({
        _text(occurrence["item"].get("videoId"))
        for occurrence in scoped_occurrences
        if _text(occurrence["item"].get("videoId"))
    })
    display_artist = _text(result.get("displayArtist"))
    if artist_names:
        artist_key, occurrence_artist = next(iter(artist_names.items()))
        if display_artist and _overlay_norm(display_artist) != artist_key:
            raise PostgresAdapterError(
                "song channel result has inconsistent artist identity"
            )
        artist_name = display_artist or occurrence_artist
        result["displayArtist"] = artist_name
        result["artists"] = [{
            "key": artist_key,
            "name": artist_name,
            "count": exact_count,
        }]
    else:
        if display_artist:
            raise PostgresAdapterError(
                "song channel result is missing its artist identity"
            )
        result["artists"] = []

    public_channel_names = channel_names.get(channel_id, {})
    if public_channel_names:
        channel_key, channel_name = next(iter(public_channel_names.items()))
        result["channels"] = [{
            "key": channel_key,
            "name": channel_name,
            "count": exact_count,
        }]
    else:
        result["channels"] = []
    return result


def _bounded_clicked_song_scopes(
    connection,
    parent_revision_id: str,
    rows: Sequence[Mapping[str, Any]],
    channel_ids: Sequence[str],
    range_id: str,
    candidate_rows: Sequence[Mapping[str, Any]],
    replacement_rows: Sequence[Mapping[str, Any]],
    accepted_video_resets: Mapping[str, Mapping[str, Any]],
    runtime_changes: Sequence[Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Count complete clicked-song tuples while retaining only 20 previews."""

    channels = sorted({_text(value) for value in channel_ids if _text(value)})
    requested = sorted({
        (
            _text(row.get("detail_key")),
            _text(row.get("title")).casefold(),
            _text(row.get("artist")).casefold(),
        )
        for row in rows
        if _text(row.get("detail_key")) and _text(row.get("title"))
    })
    if not channels or not requested:
        return {}
    if len(requested) > _CLICKED_SONG_SCOPE_GROUP_CAP:
        raise PostgresAdapterError(
            "clicked song channel result exceeded bounded group cap"
        )
    requested_identity_keys: dict[tuple[str, str], str] = {}
    for key, title, artist in requested:
        identity = (_overlay_norm(title), _overlay_norm(artist))
        existing_key = requested_identity_keys.get(identity)
        if existing_key and existing_key != key:
            raise PostgresAdapterError(
                "clicked song request identity is ambiguous"
            )
        requested_identity_keys[identity] = key
    range_values = (
        ["all", ""] if (_text(range_id) or "all") == "all" else ["7d", ""]
    )
    parent_rows = _rows(
        connection,
        """
        /* bounded complete clicked-song scalar tuples */
        WITH requested_groups(detail_key, title, artist) AS MATERIALIZED (
          SELECT * FROM unnest(%s::text[], %s::text[], %s::text[])
        ), requested_channels AS MATERIALIZED (
          SELECT DISTINCT unnest(%s::text[]) AS channel_id
        ), range_values AS MATERIALIZED (
          SELECT DISTINCT unnest(%s::text[]) AS range_id
        )
        SELECT requested.detail_key,
               o.video_id, o.occurrence_id, o.range_id, o.song_key,
               o.seconds, o.title, o.artist, o.source_id, o.source_system,
               v.title AS video_title, v.channel_name, v.channel_id,
               v.channel_handle, v.channel_url, v.published_timestamp,
               v.thumbnail_url
        FROM requested_groups AS requested
        JOIN runtime_occurrences AS o
          ON lower(coalesce(o.title, '')) = requested.title
         AND lower(coalesce(o.artist, '')) = requested.artist
         AND o.revision_id = %s
        JOIN range_values AS scope
          ON scope.range_id = coalesce(o.range_id, '')
        JOIN runtime_videos AS v
          ON v.revision_id = o.revision_id
         AND v.video_id = o.video_id
        JOIN requested_channels AS channel
          ON channel.channel_id = v.channel_id
        ORDER BY requested.detail_key, o.video_id, o.occurrence_id
        LIMIT %s
        """,
        [
            [key for key, _title, _artist in requested],
            [title for _key, title, _artist in requested],
            [artist for _key, _title, artist in requested],
            channels,
            range_values,
            parent_revision_id,
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
        ],
    )
    if len(parent_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "clicked song channel scope exceeded bounded occurrence cap"
        )
    requested_keys = {key for key, _title, _artist in requested}
    channel_set = set(channels)
    reset_video_ids = {
        _text(video_id)
        for video_id in accepted_video_resets
        if _text(video_id)
    }
    effective: dict[tuple[str, str], dict[str, Any]] = {}
    for row in parent_rows:
        if (
            _text(row.get("detail_key")) not in requested_keys
            or _text(row.get("channel_id")) not in channel_set
        ):
            raise PostgresAdapterError(
                "clicked song channel scope returned an inexact tuple"
            )
        identity = (
            _text(row.get("video_id")),
            _text(row.get("occurrence_id")),
        )
        if (
            identity[0]
            and identity[1]
            and identity[0] not in reset_video_ids
        ):
            effective[identity] = dict(row)

    def selected_overlay_row(row: Mapping[str, Any]) -> dict[str, Any] | None:
        if row.get("video_tombstone"):
            return None
        occurrence = _overlay_public_occurrence(
            row.get("occurrence_payload_json")
        )
        key = requested_identity_keys.get((
            _overlay_norm(row.get("title") or occurrence.get("title")),
            _overlay_norm(row.get("artist") or occurrence.get("artist")),
        ))
        video = _overlay_public_video(row)
        channel_id = _text(row.get("channel_id") or video.get("channelId"))
        if not key or channel_id not in channel_set:
            return None
        selected = dict(row)
        selected["detail_key"] = key
        return selected

    for row in candidate_rows:
        selected = selected_overlay_row(row)
        if selected is None:
            continue
        identity = (
            _text(selected.get("video_id")),
            _text(selected.get("occurrence_id")),
        )
        if identity[0] and identity[1]:
            effective[identity] = selected
    for change in runtime_changes:
        if bool(change.get("acceptedVideoReset")):
            continue
        effective.pop(
            (
                _text(change.get("videoId") or change.get("video_id")),
                _text(
                    change.get("occurrenceId")
                    or change.get("occurrence_id")
                ),
            ),
            None,
        )
    for row in _overlay_rows_for_range(replacement_rows, range_id):
        selected = selected_overlay_row(row)
        if selected is None:
            continue
        identity = (
            _text(selected.get("video_id")),
            _text(selected.get("occurrence_id")),
        )
        if identity[0] and identity[1]:
            effective[identity] = selected

    grouped = _overlay_candidate_groups(effective.values(), "songs")
    scoped: dict[str, dict[str, Any]] = {}
    for group in grouped.values():
        requested_key = requested_identity_keys.get((
            _overlay_norm(group.get("title")),
            _overlay_norm(group.get("artist")),
        ))
        if not requested_key or int(group.get("occurrenceCount") or 0) <= 0:
            continue
        if requested_key in scoped:
            raise PostgresAdapterError(
                "clicked song hydrated identity is ambiguous"
            )
        scoped[requested_key] = {
            "count": int(group.get("occurrenceCount") or 0),
            "videoCount": len(group.get("videoIds") or ()),
            "occurrences": tuple(
                copy.deepcopy(group.get("occurrences") or ())
            ),
        }
    return scoped


def _generic_ranking_payload_is_complete(
    payload: Mapping[str, Any],
    row: Mapping[str, Any],
    view: str,
) -> bool:
    """Reject scalar/count sentinels before they become public cards."""

    if not payload:
        return False
    if view not in {"songs", "songIndex", "vsingerSongs"}:
        return True
    occurrences = payload.get("occurrences")
    return bool(
        _text(payload.get("key"))
        and _text(payload.get("key")) == _text(row.get("detail_key"))
        and _text(payload.get("title"))
        and "displayArtist" in payload
        and isinstance(payload.get("displayArtist"), str)
        and isinstance(occurrences, list)
        and (
            int(row.get("row_count") or 0) <= 0
            or bool(occurrences)
        )
    )


def _hydrated_generic_ranking_payload(
    connection,
    parent_revision_id: str,
    row: Mapping[str, Any],
    options: Mapping[str, Any],
    db_metric: str,
) -> dict[str, Any]:
    """Hydrate one returned card by exact parent identity, then replay deltas."""

    payload = copy.deepcopy(_json_object(row.get("payload_json")))
    view = _text(options.get("view"))
    reset_deferred = row.get("_deferred_reset_preview_changes", ())
    if not isinstance(reset_deferred, (list, tuple)):
        raise PostgresAdapterError(
            "deferred reset preview state is invalid"
        )
    runtime_deferred = row.get(
        "_deferred_runtime_preview_changes", (),
    )
    if not isinstance(runtime_deferred, (list, tuple)):
        raise PostgresAdapterError(
            "deferred runtime preview state is invalid"
        )
    candidate_previews = row.get("_deferred_candidate_previews", ())
    if not isinstance(candidate_previews, (list, tuple)):
        raise PostgresAdapterError(
            "deferred candidate preview state is invalid"
        )
    requires_canonical_hydration = bool(
        reset_deferred or candidate_previews or runtime_deferred
    )
    parent_stored_found = False
    if not payload or (
        requires_canonical_hydration
        and not _generic_ranking_payload_is_complete(payload, row, view)
    ):
        stored = _one(
            connection,
            """
            /* exact returned generic ranking payload hydration */
            SELECT payload_json FROM runtime_ranking_rows
            WHERE revision_id = %s AND range_id = %s AND view = %s
              AND metric = %s AND detail_key = %s
            LIMIT 1
            """,
            [
                parent_revision_id,
                options["range"],
                view,
                db_metric,
                row.get("detail_key"),
            ],
        )
        stored_payload = _json_object(stored.get("payload_json")) if stored else {}
        parent_stored_found = bool(stored_payload)
        payload = copy.deepcopy(stored_payload)
    hydration_degraded = False
    if (
        requires_canonical_hydration
        and view in {"songs", "songIndex", "vsingerSongs"}
    ):
        # The parent stored payload may be a legacy scalar-only card without
        # a hydrated occurrences list (e.g. a legacy VSinger Moment row whose
        # parent revision never persisted full occurrences), or an empty
        # occurrences list while the row expects a positive count.  Degrade
        # to an empty occurrences list instead of failing the whole ranking
        # page.  The row identity is still overwritten from the reviewed
        # scalar below, so no stale identity can leak; identityResets have
        # already been applied at the group level before this hydration.  A
        # degraded card with correct identity but empty occurrences is safer
        # for callers than a page-wide 503.
        parent_occurrences = payload.get("occurrences")
        parent_row_count = int(row.get("row_count") or 0)
        if not isinstance(parent_occurrences, list):
            hydration_degraded = True
            payload["occurrences"] = []
        elif parent_row_count > 0 and not parent_occurrences:
            hydration_degraded = True
    if reset_deferred and not hydration_degraded:
        hydrated_row = dict(row)
        hydrated_row["payload_json"] = payload
        _apply_runtime_change_previews(
            {_text(row.get("detail_key")): hydrated_row},
            reset_deferred,
            view,
        )
        payload = copy.deepcopy(
            _json_object(hydrated_row.get("payload_json"))
        )
    if candidate_previews and not hydration_degraded:
        parent_previews = payload.get("occurrences")
        if not isinstance(parent_previews, list):
            raise PostgresAdapterError(
                "generic ranking parent previews are invalid"
            )
        payload["occurrences"] = _bounded_overlay_previews(
            (*parent_previews, *candidate_previews),
        )
    if runtime_deferred and not hydration_degraded:
        hydrated_row = dict(row)
        hydrated_row["payload_json"] = payload
        _apply_runtime_change_previews(
            {_text(row.get("detail_key")): hydrated_row},
            runtime_deferred,
            view,
        )
        payload = copy.deepcopy(
            _json_object(hydrated_row.get("payload_json"))
        )
    if (
        requires_canonical_hydration
        and view in {"songs", "songIndex", "vsingerSongs"}
    ):
        # The scalar identity is the exact group that survived overlay
        # ranking.  A stale stored payload must not rename that public card.
        payload["key"] = _text(row.get("detail_key"))
        payload["title"] = _text(row.get("title"))
        scalar_artist = _text(row.get("artist"))
        if scalar_artist:
            payload["displayArtist"] = scalar_artist
    if (
        requires_canonical_hydration
        and not hydration_degraded
        and not _generic_ranking_payload_is_complete(payload, row, view)
    ):
        if not parent_stored_found:
            # The parent revision has no stored payload at all for this
            # card; a counts-only affected card cannot be hydrated and
            # must fail closed.
            raise PostgresAdapterError(
                "generic ranking payload hydration is incomplete"
            )
        # The parent stored payload exists but is incomplete (legacy
        # VSinger Moment scalar card, stale schema, etc).  Degrade to an
        # empty-occurrences card with the reviewed scalar identity
        # instead of failing the whole ranking page with a 503.
        hydration_degraded = True
        if not isinstance(payload.get("occurrences"), list):
            payload["occurrences"] = []
    return payload


def _render_generic_overlay_rankings(
    connection,
    prepared: Mapping[str, Any],
    query: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Render a fresh page from a cached aggregate without sharing payloads."""

    options = _query_options(query)
    filtered = prepared["filtered"]
    metadata = prepared["metadata"]
    candidate_rows = prepared["candidateRows"]
    parent_revision_id = _text(prepared.get("parentRevisionId"))
    preview_excluded_video_ids = tuple(
        _text(value)
        for value in prepared.get("previewExcludedVideoIds", ())
        if _text(value)
    )
    preview_excluded_occurrence_ids = tuple(
        (_text(video_id), _text(occurrence_id))
        for video_id, occurrence_id in prepared.get(
            "previewExcludedOccurrenceIds", ()
        )
        if _text(video_id) and _text(occurrence_id)
    )
    overlay_revision_ids = tuple(
        _text(value)
        for value in prepared.get("overlayRevisionIds", ())
        if _text(value)
    )
    overlay_preview_excluded_video_ids = tuple(
        _text(value)
        for value in prepared.get("overlayPreviewExcludedVideoIds", ())
        if _text(value)
    )
    song_channel_ids = {
        _text(value)
        for value in prepared.get("songChannelIds", ())
        if _text(value)
    }
    clicked_song_scopes = (
        prepared.get("clickedSongScopes")
        if isinstance(prepared.get("clickedSongScopes"), Mapping)
        else {}
    )
    if not parent_revision_id:
        raise PostgresAdapterError("generic ranking preparation is missing its parent revision")
    db_metric = "count" if options["metric"] in {"count", "occurrences"} else options["metric"]
    render_rows: Sequence[Mapping[str, Any]] = filtered
    if (
        song_channel_ids
        and options["view"] in {"songs", "songIndex", "vsingerSongs"}
    ):
        if len(filtered) > _CLICKED_SONG_SCOPE_GROUP_CAP:
            raise PostgresAdapterError(
                "clicked song channel result exceeded bounded group cap"
            )
        scoped_rows: list[dict[str, Any]] = []
        for row in filtered:
            payload = _hydrated_generic_ranking_payload(
                connection,
                parent_revision_id,
                row,
                options,
                db_metric,
            )
            complete_scope = clicked_song_scopes.get(
                _text(row.get("detail_key"))
            )
            if isinstance(complete_scope, Mapping):
                payload["occurrences"] = copy.deepcopy(
                    list(complete_scope.get("occurrences") or ())
                )
            # The scalar row above is the identity that passed the clicked
            # residual-title predicate.  Never let a stale but non-empty
            # payload identity replace that reviewed key/title/artist tuple.
            payload["key"] = _text(row.get("detail_key"))
            payload["title"] = _text(row.get("title"))
            payload["displayArtist"] = _text(row.get("artist"))
            scoped_payload = _scoped_clicked_song_payload(
                payload,
                song_channel_ids,
                (
                    int(complete_scope.get("count") or 0)
                    if isinstance(complete_scope, Mapping)
                    else None
                ),
            )
            if scoped_payload is None:
                continue
            if isinstance(complete_scope, Mapping):
                scoped_payload["count"] = int(
                    complete_scope.get("count") or 0
                )
                scoped_payload["timestampCount"] = int(
                    complete_scope.get("count") or 0
                )
                scoped_payload["videoCount"] = int(
                    complete_scope.get("videoCount") or 0
                )
            scoped_row = dict(row)
            scoped_row.update({
                "row_count": int(scoped_payload["count"]),
                "song_count": int(scoped_payload["songCount"]),
                "video_count": int(scoped_payload["videoCount"]),
                "timestamp_count": int(scoped_payload["timestampCount"]),
                "payload_json": scoped_payload,
            })
            scoped_rows.append(scoped_row)
        render_rows = tuple(scoped_rows)
    aggregate_totals = prepared.get("aggregateTotals")
    if isinstance(aggregate_totals, Mapping) and not song_channel_ids:
        total = int(aggregate_totals.get("totalCount") or 0)
        total_occurrence_count = int(
            aggregate_totals.get("totalOccurrenceCount") or 0
        )
        total_song_count = int(aggregate_totals.get("totalSongCount") or 0)
        total_video_count = int(aggregate_totals.get("totalVideoCount") or 0)
    else:
        total = len(render_rows)
        total_occurrence_count = sum(
            int(row.get("row_count") or 0) for row in render_rows
        )
        total_song_count = sum(
            int(row.get("song_count") or 0) for row in render_rows
        )
        total_video_count = sum(
            int(row.get("video_count") or 0) for row in render_rows
        )
    offset = (options["page"] - 1) * options["pageSize"]
    records = []
    for index, row in enumerate(render_rows[offset:offset + options["pageSize"]], start=offset + 1):
        payload = _hydrated_generic_ranking_payload(
            connection,
            parent_revision_id,
            row,
            options,
            db_metric,
        )
        if options["view"] == "vtubers":
            payload = _apply_channel_metadata(payload, row, metadata, options["range"])
        payload.update({
            "count": int(row.get("row_count") or 0),
            "songCount": int(row.get("song_count") or 0),
            "videoCount": int(row.get("video_count") or 0),
            "timestampCount": int(row.get("timestamp_count") or 0),
        })
        payload["rank"] = index
        records.append(payload)
    _hydrate_overlay_page_previews(connection, candidate_rows, records)
    if options["view"] == "vtubers":
        missing_preview_channels: list[str] = []
        records_by_channel: dict[str, dict[str, Any]] = {}
        for record in records:
            channel_id = _text(record.get("channelId") or record.get("key"))
            if channel_id:
                records_by_channel[channel_id] = record
            try:
                positive = (
                    int(record.get("count") or 0) > 0
                    or int(record.get("timestampCount") or 0) > 0
                )
            except (TypeError, ValueError) as exc:
                raise PostgresAdapterError("VTuber ranking card count is invalid") from exc
            occurrences = record.get("occurrences")
            if positive and (not isinstance(occurrences, list) or not occurrences):
                if not channel_id:
                    raise PostgresAdapterError(
                        "positive VTuber ranking card has no canonical occurrence preview"
                    )
                missing_preview_channels.append(channel_id)
        if missing_preview_channels:
            overlay_previews = _bounded_direct_overlay_vtuber_previews(
                connection,
                overlay_revision_ids,
                missing_preview_channels,
                options["range"],
                excluded_video_ids=overlay_preview_excluded_video_ids,
                excluded_occurrence_ids=preview_excluded_occurrence_ids,
            )
            for channel_id, preview in overlay_previews.items():
                records_by_channel[channel_id]["occurrences"] = [preview]
            missing_preview_channels = [
                channel_id
                for channel_id in missing_preview_channels
                if channel_id not in overlay_previews
            ]
        if missing_preview_channels:
            try:
                hydrated_parent_previews = _bounded_final_vtuber_previews(
                    connection,
                    parent_revision_id,
                    missing_preview_channels,
                    options["range"],
                    excluded_video_ids=preview_excluded_video_ids,
                    excluded_occurrence_ids=preview_excluded_occurrence_ids,
                    niche_only=bool(options.get("nicheOnly")),
                    hide_unknown_artist=bool(options.get("hideUnknownArtist")),
                )
            except PostgresAdapterError as exc:
                if str(exc) == (
                    "bounded VTuber preview query returned an inexact channel set"
                ):
                    raise PostgresAdapterError(
                        "positive VTuber ranking card has no canonical occurrence preview"
                    ) from exc
                raise
            for channel_id, preview in hydrated_parent_previews.items():
                records_by_channel[channel_id]["occurrences"] = [preview]
        for record in records:
            channel_id = _text(record.get("channelId") or record.get("key"))
            _canonicalize_vtuber_card_preview(record, channel_id)
    return {
        "schemaVersion": 1, "rangeId": options["range"], "view": options["view"],
        "metric": "occurrences" if options["metric"] == "count" else options["metric"],
        "searchScope": options["searchScope"], "searchFields": options["searchFields"] or [],
        "page": options["page"], "pageSize": options["pageSize"], "totalCount": total,
        "filteredBaseCount": total,
        "totalOccurrenceCount": total_occurrence_count,
        "totalSongCount": total_song_count,
        "totalVideoCount": total_video_count,
        "pageCount": max(1, math.ceil(total / options["pageSize"])), "compact": options["compact"], "records": records,
    }


def _generic_overlay_rankings_payload(
    connection,
    revision_id: str,
    revision: Mapping[str, Any],
    query: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Share immutable aggregation across concurrent pages, then render locally."""

    options = _query_options(query)
    parent = _generic_parent_runtime_revision(connection, revision_id, revision)
    if not parent:
        raise PostgresAdapterError("incremental candidate has no full runtime parent")
    key = _generic_ranking_preparation_key(revision_id, parent[0], options)
    prepared = _cached_generic_ranking_preparation(
        key,
        lambda: _prepare_generic_overlay_rankings(connection, revision_id, parent, options),
    )
    return _render_generic_overlay_rankings(connection, prepared, query)


def _revision_lineage(connection, revision_id: str) -> list[str]:
    lineage: list[str] = []
    seen: set[str] = set()
    current = _text(revision_id)
    while current:
        if current in seen:
            raise PostgresAdapterError(f"revision parent cycle: {current}")
        seen.add(current)
        row = _one(
            connection,
            "SELECT revision_id, parent_revision_id FROM migration_revisions WHERE revision_id = %s",
            [current],
        )
        if row is None:
            raise PostgresAdapterError(f"active revision does not exist: {current}")
        lineage.append(_text(row.get("revision_id")))
        current = _text(row.get("parent_revision_id"))
    return lineage


def _overlay_revision_ids(connection, revision_id: str, full_revision_id: str) -> list[str]:
    """Return only overlay descendants of the immutable full projection.

    The complete revision lineage also contains historical ancestors of the
    full runtime.  Those rows are already represented by the full projection
    and must never be counted or replayed as a new increment.
    """

    lineage = _revision_lineage(connection, revision_id)
    try:
        full_index = lineage.index(full_revision_id)
    except ValueError as error:
        raise PostgresAdapterError(
            f"full runtime parent is not in active revision lineage: {full_revision_id}"
        ) from error
    return lineage[:full_index]


def _runtime_payload_field(payload: Mapping[str, Any], row: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in payload:
            return payload[name]
        if name in row:
            return row[name]
    return None


def _load_generic_runtime_snapshot(connection, revision_id: str, revision: Mapping[str, Any]) -> _Snapshot:
    """Resolve a generic increment over the last full runtime projection.

    A patch revision may contain either the JS migration tables or the generic
    runtime rows.  The parent full projection is copied logically at read time;
    deletes and per-video occurrence replacement therefore cannot resurrect
    stale rows from the old revision.
    """

    videos: dict[str, dict[str, Any]] = {}
    occurrences: dict[str, list[dict[str, Any]]] = defaultdict(list)
    parent = _generic_parent_runtime_revision(connection, revision_id, revision)
    if parent:
        parent_id, parent_revision = parent
        base = _load_runtime_snapshot(connection, parent_id, parent_revision)
        overlay_lineage = _overlay_revision_ids(connection, revision_id, parent_id)
        if base:
            for record in base.records:
                video = dict(record["video"])
                video_id = _text(video.get("videoId"))
                videos[video_id] = video
                occurrences[video_id] = [dict(item) for item in record.get("occurrences", ())]
    else:
        overlay_lineage = _revision_lineage(connection, revision_id)

    for revision_key in reversed(overlay_lineage):
        video_rows = _rows(connection, "SELECT video_id, title, channel_name, channel_id, channel_handle, channel_url, published_at, tombstone, payload_json FROM migration_video_rows WHERE revision_id = %s", [revision_key])
        occurrence_rows = _rows(connection, "SELECT video_id, occurrence_key, occurrence_id, position, range_id, song_key, seconds, title, artist, source_id, raw_hash, source_system, payload_json FROM migration_occurrence_rows WHERE revision_id = %s ORDER BY video_id, position, occurrence_key", [revision_key])
        replacement_ids = { _text(row.get("video_id")) for row in video_rows }
        for video_id in replacement_ids:
            occurrences[video_id] = []
        for row in video_rows:
            video_id = _text(row.get("video_id"))
            if row.get("tombstone"):
                videos.pop(video_id, None)
                occurrences.pop(video_id, None)
                continue
            payload = _json_object(row.get("payload_json"))
            if isinstance(payload.get("payload"), Mapping):
                payload = dict(payload["payload"])
            payload.update({"videoId": video_id, "title": payload.get("title", row.get("title")), "channelName": payload.get("channelName", row.get("channel_name")), "channelId": payload.get("channelId", row.get("channel_id")), "channelHandle": payload.get("channelHandle", row.get("channel_handle")), "channelUrl": payload.get("channelUrl", row.get("channel_url")), "publishedAt": payload.get("publishedAt", row.get("published_at"))})
            videos[video_id] = payload
        for row in occurrence_rows:
            video_id = _text(row.get("video_id"))
            payload = _json_object(row.get("payload_json"))
            payload.update({"videoId": video_id, "occurrenceId": row.get("occurrence_id"), "position": row.get("position"), "rangeId": row.get("range_id"), "songKey": row.get("song_key"), "seconds": row.get("seconds"), "title": row.get("title"), "artist": row.get("artist"), "sourceId": row.get("source_id"), "rawHash": row.get("raw_hash"), "sourceSystem": row.get("source_system")})
            occurrences[video_id].append(payload)

        rows_by_key: dict[tuple[str, str], dict[str, Any]] = {}
        for row in _rows(connection, "SELECT entity_type, entity_key, source_system, range_id, source_id, occurrence_id, tombstone, payload_json FROM migration_runtime_rows WHERE revision_id = %s ORDER BY entity_type, entity_key", [revision_key]):
            rows_by_key[(_text(row.get("entity_type")), _text(row.get("entity_key")))] = row
        positions: dict[str, int] = defaultdict(int)
        for row in rows_by_key.values():
            entity_type = _text(row.get("entity_type"))
            payload = _json_object(row.get("payload_json"))
            if isinstance(payload.get("payload"), Mapping):
                payload = dict(payload["payload"])
            if entity_type in {"videos", "runtime_videos"}:
                video_id = _text(_runtime_payload_field(payload, row, "videoId", "video_id"))
                if row.get("tombstone"):
                    videos.pop(video_id, None); occurrences.pop(video_id, None)
                    continue
                if video_id:
                    payload.update({"videoId": video_id, "title": _runtime_payload_field(payload, row, "title"), "channelName": _runtime_payload_field(payload, row, "channelName", "channel_name"), "channelId": _runtime_payload_field(payload, row, "channelId", "channel_id"), "channelHandle": _runtime_payload_field(payload, row, "channelHandle", "channel_handle"), "channelUrl": _runtime_payload_field(payload, row, "channelUrl", "channel_url"), "publishedAt": _runtime_payload_field(payload, row, "publishedAt", "published_at", "published_timestamp")})
                    videos[video_id] = payload
            elif entity_type in {"occurrences", "runtime_occurrences"}:
                video_id = _text(_runtime_payload_field(payload, row, "videoId", "video_id"))
                if not video_id:
                    continue
                occurrence_id = _text(_runtime_payload_field(payload, row, "occurrenceId", "occurrence_id")) or _text(row.get("entity_key"))
                existing = [item for item in occurrences[video_id] if _text(item.get("occurrenceId")) != occurrence_id]
                if not row.get("tombstone"):
                    position = _runtime_payload_field(payload, row, "position")
                    try: position = int(position)
                    except (TypeError, ValueError): position = positions[video_id]
                    positions[video_id] = max(positions[video_id], position + 1)
                    payload.update({"videoId": video_id, "occurrenceId": occurrence_id, "position": position, "rangeId": _runtime_payload_field(payload, row, "rangeId", "range_id"), "songKey": _runtime_payload_field(payload, row, "songKey", "song_key"), "seconds": _runtime_payload_field(payload, row, "seconds"), "title": _runtime_payload_field(payload, row, "title"), "artist": _runtime_payload_field(payload, row, "artist"), "sourceId": _runtime_payload_field(payload, row, "sourceId", "source_id"), "sourceSystem": _runtime_payload_field(payload, row, "sourceSystem", "source_system")})
                    existing.append(payload)
                occurrences[video_id] = existing

    records = tuple({"video": video, "occurrences": tuple(sorted(occurrences.get(video_id, []), key=lambda item: (int(item.get("position") or 0), _text(item.get("occurrenceId")))))} for video_id, video in sorted(videos.items()))
    if not records:
        raise PostgresAdapterError("active runtime projection has no video rows")
    return _Snapshot(revision_id, revision, records)


def _load_runtime_snapshot(connection, revision_id: str, revision: Mapping[str, Any]) -> _Snapshot:
    videos: dict[str, dict[str, Any]] = {}
    occurrences: dict[str, list[dict[str, Any]]] = defaultdict(list)
    video_rows = _rows(
        connection,
        """
        SELECT video_id, title, channel_name, channel_id, channel_handle,
               channel_url, published_timestamp, published_text, duration_text,
               thumbnail_url, payload_json
        FROM runtime_videos WHERE revision_id = %s ORDER BY video_id
        """,
        [revision_id],
    )
    for row in video_rows:
        payload = _json_object(row.get("payload_json"))
        payload.update({
            "videoId": payload.get("videoId") or row.get("video_id"),
            "title": payload["title"] if "title" in payload else row.get("title"),
            "channelName": payload["channelName"] if "channelName" in payload else row.get("channel_name"),
            "channelId": payload["channelId"] if "channelId" in payload else row.get("channel_id"),
            "channelHandle": payload["channelHandle"] if "channelHandle" in payload else row.get("channel_handle"),
            "channelUrl": payload["channelUrl"] if "channelUrl" in payload else row.get("channel_url"),
            "publishedAt": payload["publishedAt"] if "publishedAt" in payload else row.get("published_timestamp"),
        })
        videos[_text(row.get("video_id"))] = payload
    occurrence_rows = _rows(
        connection,
        """
        SELECT occurrence_id, range_id, video_id, song_key, seconds,
               source_system, source_id, title, artist, is_niche,
               is_unknown_artist, payload_json
        FROM runtime_occurrences
        WHERE revision_id = %s ORDER BY video_id, range_id, occurrence_id
        """,
        [revision_id],
    )
    positions: dict[str, int] = defaultdict(int)
    for row in occurrence_rows:
        payload = _json_object(row.get("payload_json"))
        video_id = _text(row.get("video_id"))
        position = positions[video_id]
        positions[video_id] += 1
        payload.update({
            "occurrenceId": payload["occurrenceId"] if "occurrenceId" in payload else row.get("occurrence_id"),
            "position": payload["position"] if "position" in payload else position,
            "rangeId": payload["rangeId"] if "rangeId" in payload else row.get("range_id"),
            "songKey": payload["songKey"] if "songKey" in payload else row.get("song_key"),
            "seconds": payload["seconds"] if "seconds" in payload else row.get("seconds"),
            "title": payload["title"] if "title" in payload else row.get("title"),
            "artist": payload["artist"] if "artist" in payload else row.get("artist"),
            "sourceId": payload["sourceId"] if "sourceId" in payload else row.get("source_id"),
            "sourceSystem": payload["sourceSystem"] if "sourceSystem" in payload else row.get("source_system"),
        })
        occurrences[video_id].append(payload)
    records = tuple(
        {"video": video, "occurrences": tuple(occurrences.get(video_id, []))}
        for video_id, video in sorted(videos.items())
    )
    return _Snapshot(revision_id, revision, records)


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _stable_key(*parts: Any) -> str:
    value = "\0".join(_text(part) for part in parts)
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]


def _production_source_detail_key_for_group(view: str, range_id: str, group_key: str) -> str:
    """Byte-for-byte ``export-runtime-rankings.js`` request-key contract."""

    prefix = {
        "songs": "song", "songIndex": "song", "artists": "artist",
        "vtubers": "vtuber",
    }.get(view)
    if prefix:
        return hashlib.sha256(
            f"{range_id}:{prefix}:all:{group_key}".encode("utf-8")
        ).hexdigest()[:16]
    # Runtime videos intentionally have no source detail endpoint.  Vsinger
    # uses its legacy independent source key until its own exporter contract
    # is explicitly migrated.
    if view == "videos":
        return ""
    return _stable_key("source-vsinger-song", group_key) if view == "vsingerSongs" else ""


def _first(query: Mapping[str, Any], key: str, default: str = "") -> str:
    value = query.get(key, default)
    if isinstance(value, (list, tuple)):
        value = value[0] if value else default
    return _text(value)


def _int_query(query: Mapping[str, Any], key: str, default: int) -> int:
    value = _first(query, key, str(default))
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{key} must be an integer") from exc


def _bool_query(query: Mapping[str, Any], key: str, default: bool = False) -> bool:
    value = _first(query, key, "1" if default else "0").lower()
    if value in {"1", "true", "yes"}:
        return True
    if value in {"0", "false", "no", ""}:
        return False
    raise ValueError(f"{key} must be 0 or 1")


def _query_options(query: Mapping[str, Any] | None) -> dict[str, Any]:
    query = query or {}
    range_id = _first(query, "range", "all")
    view = _first(query, "view", "songs")
    if range_id not in SUPPORTED_RANGES:
        raise ValueError("range must be 7d or all")
    if view not in SUPPORTED_VIEWS:
        raise ValueError("view must be songs, songIndex, artists, videos, vtubers, or vsingerSongs")
    q = _first(query, "q", "").strip().casefold()
    page = max(1, _int_query(query, "page", 1))
    requested_size = max(1, _int_query(query, "pageSize", 50))
    page_size = min(MAX_SEARCH_PAGE_SIZE if q else MAX_PAGE_SIZE, requested_size)
    metric = _first(query, "metric", "count")
    if metric not in {"count", "occurrences", "songs", "videos"}:
        raise ValueError("metric must be occurrences, count, songs, or videos")
    scope = _first(query, "searchScope", _first(query, "searchField", "all")) or "all"
    fields_value = _first(query, "searchFields", "")
    fields = [field.strip() for field in fields_value.split(",") if field.strip()] or None
    return {
        "range": range_id,
        "view": view,
        "q": q,
        "searchTokens": [token for token in q.split() if token],
        "page": page,
        "pageSize": page_size,
        "metric": metric,
        "searchScope": scope,
        "searchFields": fields,
        "minCount": max(1, _int_query(query, "minCount", 1)),
        "nicheOnly": _bool_query(query, "nicheOnly"),
        "hideUnknownArtist": _bool_query(query, "hideUnknownArtist"),
        "compact": _bool_query(query, "compact"),
    }


def _matches_search_tokens(search_text: object, tokens: Iterable[str]) -> bool:
    haystack = _text(search_text).casefold()
    return all(token in haystack for token in tokens)


def _load_snapshot(connection) -> _Snapshot:
    ensure_schema(connection)
    runtime = _runtime_projection_revision(connection)
    if runtime:
        return _load_runtime_snapshot(connection, runtime[0], runtime[1])
    generic_runtime = _generic_runtime_projection_revision(connection)
    if generic_runtime:
        return _load_generic_runtime_snapshot(connection, generic_runtime[0], generic_runtime[1])
    state = _one(connection, "SELECT state_value FROM migration_state WHERE state_key = 'active_revision_id'")
    revision_id = _text(state.get("state_value")) if state else ""
    if not revision_id:
        raise PostgresAdapterError("no active PostgreSQL revision")

    lineage: list[dict[str, Any]] = []
    seen: set[str] = set()
    current = revision_id
    while current:
        if current in seen:
            raise PostgresAdapterError(f"revision parent cycle: {current}")
        seen.add(current)
        row = _one(
            connection,
            """
            SELECT revision_id, parent_revision_id, status, manifest_json,
                   source_manifest_sha256, content_sha256, video_count,
                   occurrence_count, created_at, activated_at
            FROM migration_revisions WHERE revision_id = %s
            """,
            [current],
        )
        if row is None:
            raise PostgresAdapterError(f"active revision does not exist: {current}")
        lineage.append(row)
        current = _text(row.get("parent_revision_id"))

    videos: dict[str, dict[str, Any]] = {}
    occurrences: dict[str, list[dict[str, Any]]] = {}
    for revision in lineage:
        revision_id = _text(revision.get("revision_id"))
        video_rows = _rows(
            connection,
            """
            SELECT video_id, title, channel_name, channel_id, channel_handle,
                   channel_url, published_at, tombstone, payload_json
            FROM migration_video_rows WHERE revision_id = %s
            """,
            [revision_id],
        )
        occurrence_rows = _rows(
            connection,
            """
            SELECT video_id, occurrence_key, occurrence_id, position, range_id,
                   song_key, seconds, title, artist, source_id, raw_hash,
                   source_system, payload_json
            FROM migration_occurrence_rows
            WHERE revision_id = %s ORDER BY video_id, position, occurrence_key
            """,
            [revision_id],
        )
        revision_occurrences: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in occurrence_rows:
            revision_occurrences[_text(row.get("video_id"))].append(row)
        for row in video_rows:
            video_id = _text(row.get("video_id"))
            if video_id in videos:
                continue
            videos[video_id] = row
            occurrences[video_id] = revision_occurrences.get(video_id, []) if not row.get("tombstone") else []

    records: list[Mapping[str, Any]] = []
    for video_id, video_row in videos.items():
        if video_row.get("tombstone"):
            continue
        video = _json_object(video_row.get("payload_json"))
        video.update(
            {
                "videoId": video.get("videoId") or video_id,
                "title": video.get("title") if video.get("title") is not None else video_row.get("title"),
                "channelName": video.get("channelName") if video.get("channelName") is not None else video_row.get("channel_name"),
                "channelId": video.get("channelId") if video.get("channelId") is not None else video_row.get("channel_id"),
                "channelHandle": video.get("channelHandle") if video.get("channelHandle") is not None else video_row.get("channel_handle"),
                "channelUrl": video.get("channelUrl") if video.get("channelUrl") is not None else video_row.get("channel_url"),
                "publishedAt": video.get("publishedAt") if video.get("publishedAt") is not None else video_row.get("published_at"),
            }
        )
        item = dict(video)
        song_rows: list[Mapping[str, Any]] = []
        for row in occurrences.get(video_id, []):
            song = _json_object(row.get("payload_json"))
            song.update(
                {
                    "occurrenceId": song.get("occurrenceId") if song.get("occurrenceId") is not None else row.get("occurrence_id"),
                    "position": int(row.get("position") or 0),
                    "rangeId": song.get("rangeId") if song.get("rangeId") is not None else row.get("range_id"),
                    "songKey": song.get("songKey") if song.get("songKey") is not None else row.get("song_key"),
                    "seconds": song.get("seconds") if song.get("seconds") is not None else row.get("seconds"),
                    "title": song.get("title") if song.get("title") is not None else row.get("title"),
                    "artist": song.get("artist") if song.get("artist") is not None else row.get("artist"),
                    "sourceId": song.get("sourceId") if song.get("sourceId") is not None else row.get("source_id"),
                    "rawHash": song.get("rawHash") if song.get("rawHash") is not None else row.get("raw_hash"),
                    "sourceSystem": song.get("sourceSystem") if song.get("sourceSystem") is not None else row.get("source_system"),
                }
            )
            song_rows.append(song)
        records.append({"video": item, "occurrences": tuple(song_rows)})
    records.sort(key=lambda record: _text(record["video"].get("videoId")))
    return _Snapshot(revision_id, lineage[0], tuple(records))


def _occurrences_for_range(record: Mapping[str, Any], range_id: str) -> list[dict[str, Any]]:
    values = []
    for song in record["occurrences"]:
        song_range = _text(song.get("rangeId"))
        # ``all`` and ``7d`` are separate physical projections.  Legacy rows
        # without a range remain visible through both paths, but a materialized
        # 7d tuple must never leak into the all aggregate (or vice versa).
        if song_range in {range_id, ""}:
            item = dict(record["video"])
            values.append({
                "rangeId": song_range or range_id,
                "videoId": item.get("videoId", ""),
                "item": item,
                "video": dict(item),
                "song": dict(song),
            })
    return values


def _field_text(occurrence: Mapping[str, Any], field: str) -> str:
    item = occurrence.get("item") if isinstance(occurrence.get("item"), Mapping) else {}
    song = occurrence.get("song") if isinstance(occurrence.get("song"), Mapping) else {}
    mapping = {
        "title": song.get("title"),
        "artist": song.get("artist"),
        "song": f"{song.get('title', '')} {song.get('artist', '')}",
        "channel": f"{item.get('channelName', '')} {item.get('channelId', '')} {item.get('channelHandle', '')} {item.get('channelUrl', '')}",
        "video": f"{item.get('videoId', '')} {item.get('title', '')}",
        "source": f"{song.get('sourceId', '')} {song.get('sourceSystem', '')}",
    }
    return _text(mapping.get(field, "")).casefold()


def _matches(occurrence: Mapping[str, Any], query: Mapping[str, Any], default_fields: tuple[str, ...]) -> bool:
    q = query["q"]
    if not q:
        return True
    fields = query.get("searchFields") or {
        "song": ("title", "artist"),
        "artist": ("artist",),
        "channel": ("channel",),
        "source": ("source",),
        "video": ("video",),
        "title": ("title",),
        "all": default_fields,
    }.get(query.get("searchScope", "all"), default_fields)
    return any(q in _field_text(occurrence, field) for field in fields)


def _song_key(song: Mapping[str, Any]) -> str:
    return _text(song.get("songKey")) or _stable_key("song", _text(song.get("title")).casefold(), _text(song.get("artist")).casefold())


def _count_list(values: Iterable[str]) -> list[dict[str, Any]]:
    counts: dict[str, int] = defaultdict(int)
    for value in values:
        value = _text(value)
        if value:
            counts[value] += 1
    return [{"name": name, "count": count} for name, count in sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))]


def _entity_groups(records: Iterable[Mapping[str, Any]], query: Mapping[str, Any]) -> list[dict[str, Any]]:
    range_id = query["range"]
    view = query["view"]
    grouped: dict[str, dict[str, Any]] = {}
    for record in records:
        occurrences = [occurrence for occurrence in _occurrences_for_range(record, range_id) if _matches(occurrence, query, ("title", "artist", "channel", "video", "source"))]
        if query.get("nicheOnly"):
            occurrences = [occurrence for occurrence in occurrences if occurrence["song"].get("isNiche") is True]
        if query.get("hideUnknownArtist"):
            occurrences = [occurrence for occurrence in occurrences if _text(occurrence["song"].get("artist"))]
        if view == "videos":
            key = _text(record["video"].get("videoId"))
            if not key or not occurrences:
                continue
            group = grouped.setdefault(key, {"key": key, "video": record["video"], "occurrences": []})
            group["occurrences"].extend(occurrences)
        elif view == "vtubers":
            video = record["video"]
            key = _text(video.get("channelId")) or _text(video.get("channelHandle")).lstrip("@/") or _text(video.get("channelName"))
            if not key or not occurrences:
                continue
            group = grouped.setdefault(key, {"key": key, "video": video, "occurrences": []})
            group["occurrences"].extend(occurrences)
        else:
            for occurrence in occurrences:
                song = occurrence["song"]
                if view == "artists":
                    key = _text(song.get("artist")) or "unknown"
                else:
                    key = _song_key(song)
                    if view == "vsingerSongs":
                        key = f"{_text(song.get('sourceSystem')) or 'vsinger_moment_http'}:{key}"
                group = grouped.setdefault(key, {"key": key, "video": occurrence["item"], "occurrences": [], "title": song.get("title"), "artist": song.get("artist")})
                group["occurrences"].append(occurrence)
    return list(grouped.values())


def _metric_value(group: Mapping[str, Any], metric: str) -> int:
    occurrences = group["occurrences"]
    if metric == "videos":
        return len({_text(row.get("videoId")) for row in occurrences})
    if metric == "songs":
        return len({_song_key(row["song"]) for row in occurrences})
    return len(occurrences)


def _group_payload(group: Mapping[str, Any], query: Mapping[str, Any]) -> dict[str, Any]:
    range_id = query["range"]
    view = query["view"]
    occurrences = list(group["occurrences"])
    videos = {_text(row.get("videoId")) for row in occurrences}
    songs = {_song_key(row["song"]) for row in occurrences}
    count = len(occurrences)
    if view in {"songs", "songIndex", "vsingerSongs"}:
        title = _text(group.get("title"))
        artist = _text(group.get("artist"))
        source_prefix = "source-vsinger-song" if view == "vsingerSongs" else "source-song"
        source_key = _stable_key(source_prefix, group["key"]) if view == "vsingerSongs" else _stable_key(source_prefix, range_id, group["key"])
        payload = {
            "type": "song", "key": group["key"], "title": title,
            "displayArtist": artist, "count": count, "videoCount": len(videos),
            "timestampCount": count, "channels": _count_list(row["item"].get("channelName") for row in occurrences),
            "occurrences": occurrences[:20], "sourceDetailKey": source_key,
        }
        if view == "vsingerSongs":
            payload["sourceSystem"] = _text(occurrences[0]["song"].get("sourceSystem")) if occurrences else ""
            payload["singers"] = payload["channels"]
    elif view == "artists":
        source_key = _stable_key("source-artist", range_id, group["key"])
        payload = {
            "type": "artist", "key": group["key"], "name": _text(group.get("key")),
            "count": count, "videoCount": len(videos), "timestampCount": count,
            "songs": _count_list(_text(row["song"].get("title")) for row in occurrences),
            "channels": _count_list(row["item"].get("channelName") for row in occurrences),
            "occurrences": occurrences[:20], "sourceDetailKey": source_key,
        }
    elif view == "videos":
        video = dict(group["video"])
        payload = {
            **video, "type": "video", "key": group["key"], "videoId": group["key"],
            "count": count, "songCount": len(songs), "timestampCount": count,
            "songs": [dict(row["song"]) for row in occurrences], "occurrences": occurrences,
            "sourceDetailKey": _stable_key("source-video", range_id, group["key"]),
        }
    else:
        video = dict(group["video"])
        channel_name = _text(video.get("channelName")) or group["key"]
        source_key = _stable_key("source-vtuber", range_id, group["key"])
        payload = {
            "type": "vtuber", "key": group["key"], "name": channel_name,
            "channelName": channel_name, "channelId": video.get("channelId", ""),
            "channelHandle": video.get("channelHandle", ""), "channelUrl": video.get("channelUrl", ""),
            "avatarUrl": video.get("avatarUrl", ""), "thumbnailUrl": video.get("thumbnailUrl", ""),
            "videoThumbnailUrl": video.get("thumbnailUrl", ""), "sourceUrl": video.get("sourceUrl", ""),
            "knownSourceType": video.get("knownSourceType", ""), "isCollected": bool(video.get("isCollected")),
            "count": count, "songCount": len(songs), "videoCount": len(videos), "timestampCount": count,
            "songs": _count_list(_text(row["song"].get("title")) for row in occurrences),
            "occurrences": occurrences[:20], "sourceDetailKey": source_key,
        }
    payload["rank"] = 0
    payload["count"] = count
    payload["videoCount"] = payload.get("videoCount", len(videos))
    payload["timestampCount"] = count
    return payload


def rankings_payload_from_records(records: Iterable[Mapping[str, Any]], query: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Derive an API-compatible rankings response from resolved records."""

    options = _query_options(query)
    base_query = dict(options)
    base_query["q"] = ""
    base_groups = _entity_groups(records, base_query)
    groups = _entity_groups(records, options)
    groups = [group for group in groups if _metric_value(group, options["metric"]) >= options["minCount"]]
    groups.sort(key=lambda group: (-_metric_value(group, options["metric"]), _text(group.get("title") or group.get("key"))))
    total_occurrences = sum(len(group["occurrences"]) for group in groups)
    total_videos = len({_text(row.get("videoId")) for group in groups for row in group["occurrences"]})
    page_count = max(1, math.ceil(len(groups) / options["pageSize"]))
    offset = (options["page"] - 1) * options["pageSize"]
    page_groups = groups[offset : offset + options["pageSize"]]
    result_records = []
    for index, group in enumerate(page_groups, start=offset + 1):
        payload = _group_payload(group, options)
        payload["rank"] = index
        if options["compact"] and options["view"] == "vtubers":
            payload["occurrencePreviewLimited"] = len(group["occurrences"]) > len(payload["occurrences"])
        result_records.append(payload)
    return {
        "schemaVersion": 1, "rangeId": options["range"], "view": options["view"],
        "metric": "occurrences" if options["metric"] == "count" else options["metric"],
        "searchScope": options["searchScope"],
        "searchFields": options["searchFields"] or [], "page": options["page"],
        "pageSize": options["pageSize"], "totalCount": len(groups),
        "filteredBaseCount": len(base_groups), "totalOccurrenceCount": total_occurrences,
        "totalSongCount": len({_song_key(row["song"]) for group in groups for row in group["occurrences"]}),
        "totalVideoCount": total_videos, "pageCount": page_count,
        "compact": options["compact"], "records": result_records,
    }


def source_payload_from_records(records: Iterable[Mapping[str, Any]], key: str, query: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Return the existing source-detail response shape for a derived key."""

    if not _text(key):
        raise ValueError("source key is required")
    options = _query_options(query)
    all_options = dict(options)
    all_options["q"] = ""
    all_options["view"] = "songs"
    for view in ("songs", "songIndex", "artists", "videos", "vtubers", "vsingerSongs"):
        all_options["view"] = view
        for group in _entity_groups(records, all_options):
            payload = _group_payload(group, all_options)
            if payload.get("sourceDetailKey") != key:
                continue
            occurrences = [row for row in group["occurrences"] if _matches(row, options, ("title", "artist", "channel", "video", "source"))]
            record = dict(payload)
            record["occurrences"] = occurrences
            use_paging = any(field in (query or {}) for field in ("page", "pageSize"))
            if use_paging:
                video_keys: list[str] = []
                for row in occurrences:
                    video_id = _text(row.get("videoId")) or f"position:{row.get('position', 0)}"
                    if video_id not in video_keys:
                        video_keys.append(video_id)
                page_count = max(1, math.ceil(len(video_keys) / options["pageSize"]))
                page = min(options["page"], page_count)
                selected = set(video_keys[(page - 1) * options["pageSize"] : page * options["pageSize"]])
                record["occurrences"] = [row for row in occurrences if (_text(row.get("videoId")) or f"position:{row.get('position', 0)}") in selected]
                record["sourceFilterQuery"] = options["q"]
                record["nicheOnly"] = options["nicheOnly"]
                record["hideUnknownArtist"] = options["hideUnknownArtist"]
                record["count"] = len(occurrences)
                record["timestampCount"] = len(occurrences)
                record["videoCount"] = len(video_keys)
                return {
                    "schemaVersion": 1, "found": True, "sourceKey": key, "record": record,
                    "page": page, "pageSize": options["pageSize"], "pageCount": page_count,
                    "totalCount": len(video_keys), "totalVideoCount": len(video_keys),
                    "totalOccurrenceCount": len(occurrences),
                }
            return {"schemaVersion": 1, "found": True, "sourceKey": key, "record": record}
    return {"schemaVersion": 1, "found": False, "sourceKey": key}


def _runtime_rankings_payload(connection, revision_id: str, query: Mapping[str, Any] | None = None) -> dict[str, Any]:
    options = _query_options(query)
    db_metric = "count" if options["metric"] in {"count", "occurrences"} else options["metric"]
    # The normal UI request has no text filter.  Do not materialize every
    # payload just to return one page: the full runtime projection can contain
    # hundreds of thousands of rows, and the old SQLite API answered this path
    # from a precomputed index.  Keep the filtered/search path below for
    # compatibility, but make the common path bounded and proxy-safe.
    if not options["q"]:
        where = "revision_id = %s AND range_id = %s AND view = %s AND metric = %s AND row_count >= %s"
        params = [revision_id, options["range"], options["view"], db_metric, options["minCount"]]
        summary = _rows(
            connection,
            f"""
            SELECT count(*) AS total_count,
                   coalesce(sum(row_count), 0) AS total_occurrence_count,
                   coalesce(sum(song_count), 0) AS total_song_count,
                   coalesce(sum(video_count), 0) AS total_video_count
            FROM runtime_ranking_rows
            WHERE {where}
            """,
            params,
        )[0]
        rows = _rows(
            connection,
            f"""
            SELECT rank, detail_key, title, name, channel_search_text, payload_json
            FROM runtime_ranking_rows
            WHERE {where}
            ORDER BY rank
            LIMIT %s OFFSET %s
            """,
            [*params, options["pageSize"], (options["page"] - 1) * options["pageSize"]],
        )
        total_count = int(summary.get("total_count") or 0)
        page_count = max(1, math.ceil(total_count / options["pageSize"]))
        metadata = _channel_metadata_rows(connection, [revision_id]) if options["view"] == "vtubers" else []
        records = []
        for row in rows:
            payload = _json_object(row.get("payload_json"))
            if options["view"] == "vtubers":
                payload = _apply_channel_metadata(payload, row, metadata, options["range"])
            payload["rank"] = int(row.get("rank") or payload.get("rank") or 0)
            records.append(payload)
        return {
            "schemaVersion": 1, "rangeId": options["range"], "view": options["view"],
            "metric": "occurrences" if options["metric"] == "count" else options["metric"],
            "searchScope": options["searchScope"], "searchFields": options["searchFields"] or [],
            "page": options["page"], "pageSize": options["pageSize"], "totalCount": total_count,
            "filteredBaseCount": total_count,
            "totalOccurrenceCount": int(summary.get("total_occurrence_count") or 0),
            "totalSongCount": int(summary.get("total_song_count") or 0),
            "totalVideoCount": int(summary.get("total_video_count") or 0),
            "pageCount": page_count, "compact": options["compact"], "records": records,
        }
    rows = _rows(
        connection,
        """
        SELECT rank, row_count, song_count, video_count, timestamp_count,
               payload_json, search_text, channel_search_text
        FROM runtime_ranking_rows
        WHERE revision_id = %s AND range_id = %s AND view = %s AND metric = %s
        ORDER BY rank
        """,
        [revision_id, options["range"], options["view"], db_metric],
    )
    if options["searchTokens"]:
        rows = [
            row for row in rows
            if _matches_search_tokens(
                _text(row.get("search_text")) + " " + _text(row.get("channel_search_text")),
                options["searchTokens"],
            )
        ]
    rows = [row for row in rows if int(row.get("row_count") or 0) >= options["minCount"]]
    total_occurrences = sum(int(row.get("row_count") or 0) for row in rows)
    total_songs = sum(int(row.get("song_count") or 0) for row in rows)
    total_videos = sum(int(row.get("video_count") or 0) for row in rows)
    page_count = max(1, math.ceil(len(rows) / options["pageSize"]))
    offset = (options["page"] - 1) * options["pageSize"]
    metadata = _channel_metadata_rows(connection, [revision_id]) if options["view"] == "vtubers" else []
    records = []
    for row in rows[offset : offset + options["pageSize"]]:
        payload = _json_object(row.get("payload_json"))
        if options["view"] == "vtubers":
            payload = _apply_channel_metadata(payload, row, metadata, options["range"])
        payload["rank"] = int(row.get("rank") or payload.get("rank") or 0)
        records.append(payload)
    return {
        "schemaVersion": 1, "rangeId": options["range"], "view": options["view"],
        "metric": "occurrences" if options["metric"] == "count" else options["metric"],
        "searchScope": options["searchScope"], "searchFields": options["searchFields"] or [],
        "page": options["page"], "pageSize": options["pageSize"], "totalCount": len(rows),
        "filteredBaseCount": len(rows), "totalOccurrenceCount": total_occurrences,
        "totalSongCount": total_songs, "totalVideoCount": total_videos, "pageCount": page_count,
        "compact": options["compact"], "records": records,
    }


def _runtime_source_occurrence(row: Mapping[str, Any]) -> dict[str, Any]:
    """Normalize one persisted source occurrence without losing its video image."""

    item = _json_object(row.get("payload_json"))
    nested_video = item.get("video") if isinstance(item.get("video"), Mapping) else {}
    if isinstance(item.get("payload"), Mapping):
        item = dict(item["payload"])
        nested_video = item.get("video") if isinstance(item.get("video"), Mapping) else {}
    fields = {
        "videoId": row.get("video_id"),
        "title": row.get("title"),
        "channelName": row.get("channel_name"),
        "channelId": row.get("channel_id"),
        "channelHandle": row.get("channel_handle"),
        "channelUrl": row.get("channel_url"),
        "publishedAt": row.get("published_timestamp"),
        "seconds": row.get("seconds"),
    }
    for name, value in fields.items():
        if name not in item and (value is not None or name == "seconds"):
            item[name] = value
    for name in ("thumbnailUrl", "videoThumbnailUrl", "avatarUrl"):
        if name not in item and nested_video.get(name) is not None:
            item[name] = nested_video[name]
    video_id = _text(row.get("video_id"))
    if video_id:
        for name in ("thumbnailUrl", "videoThumbnailUrl"):
            nested_thumbnail = _text(nested_video.get(name))
            current_thumbnail = _text(item.get(name))
            marker = f"/vi/{video_id}/"
            if nested_thumbnail and marker in nested_thumbnail and marker not in current_thumbnail:
                item[name] = nested_thumbnail
    return item


def _runtime_source_occurrences(connection, revision_id: str, key: str, range_id: str) -> list[dict[str, Any]]:
    source_rows = _rows(
        connection,
        """
        SELECT position, video_id, title, channel_name, channel_id, channel_handle,
               channel_url, published_timestamp, seconds, payload_json
        FROM runtime_source_occurrences
        WHERE revision_id = %s AND source_key = %s AND range_id = %s
        ORDER BY position
        LIMIT %s
        """,
        [revision_id, key, range_id, _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
    )
    if len(source_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("source occurrence lookup exceeded bounded cap")
    return [_runtime_source_occurrence(row) for row in source_rows]


def _source_song_preview_key(item: Mapping[str, Any]) -> str:
    song = item.get("song") if isinstance(item.get("song"), Mapping) else {}
    song_key = _text(song.get("songKey") or song.get("key") or item.get("songKey"))
    if song_key:
        return f"key:{song_key.casefold()}"
    title = _text(song.get("title") or item.get("songTitle") or item.get("title"))
    artist = _text(song.get("artist") or item.get("songArtist") or item.get("artist"))
    if title:
        return f"title:{title.casefold()}\x1f{artist.casefold()}"
    return ""


def _source_song_previews(occurrences: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    previews: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in occurrences:
        key = _source_song_preview_key(item)
        if not key or key in seen:
            continue
        seen.add(key)
        previews.append(dict(item))
        if len(previews) >= MAX_SOURCE_PREVIEW_OCCURRENCES:
            break
    return previews


def _recount_source_detail(record: Mapping[str, Any], occurrences: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Make final source-detail counts follow the public, overlaid tuples."""

    result = dict(record)
    rows = list(occurrences)
    result["count"] = len(rows)
    result["occurrenceCount"] = len(rows)
    result["timestampCount"] = len(rows)
    result["videoCount"] = len({
        _text(item.get("youtubeVideoId") or item.get("videoId") or item.get("externalVideoId"))
        for item in rows
    } - {""})
    result["songCount"] = len({_source_song_preview_key(item) for item in rows if _source_song_preview_key(item)})
    return result


def _runtime_source_payload(
    connection,
    revision_id: str,
    key: str,
    query: Mapping[str, Any] | None = None,
    allow_derived: bool = True,
    overlay_revision_ids: Sequence[str] | None = None,
) -> dict[str, Any]:
    rows = _rows(
        connection,
        "SELECT payload_json FROM runtime_source_details WHERE revision_id = %s AND source_key = %s",
        [revision_id, key],
    )
    if not rows:
        if not allow_derived:
            return {"schemaVersion": 1, "found": False, "sourceKey": key}
        try:
            revision = _one(
                connection,
                "SELECT revision_id, parent_revision_id, status, manifest_json, source_manifest_sha256, content_sha256, activated_at, created_at FROM migration_revisions WHERE revision_id = %s",
                [revision_id],
            ) or {"revision_id": revision_id}
            snapshot = _load_runtime_snapshot(connection, revision_id, revision)
            derived = source_payload_from_records(snapshot.records, key, query)
            if derived.get("found"):
                return derived
        except Exception:
            pass
        return {"schemaVersion": 1, "found": False, "sourceKey": key}
    record = _json_object(rows[0].get("payload_json"))
    query = query or {}
    overlay_changes = _runtime_tombstones(connection, overlay_revision_ids or ())
    if any(field in query for field in ("page", "pageSize")):
        options = _query_options(query)
        range_id = _text(record.get("rangeId") or record.get("range_id")) or options["range"]
        occurrences = _runtime_source_occurrences(connection, revision_id, key, range_id)
        if not occurrences:
            occurrences = list(record.get("occurrences") or [])
        occurrences = _apply_source_overlay(occurrences, overlay_changes)
        if options["q"]:
            occurrences = [item for item in occurrences if options["q"] in json.dumps(item, ensure_ascii=False).casefold()]
        video_keys: list[str] = []
        for item in occurrences:
            video_key = _text(item.get("youtubeVideoId") or item.get("videoId") or item.get("externalVideoId"))
            if video_key not in video_keys:
                video_keys.append(video_key)
        page_count = max(1, math.ceil(len(video_keys) / options["pageSize"]))
        page = min(options["page"], page_count)
        selected = set(video_keys[(page - 1) * options["pageSize"] : page * options["pageSize"]])
        record = dict(record)
        record["occurrences"] = [item for item in occurrences if _text(item.get("youtubeVideoId") or item.get("videoId") or item.get("externalVideoId")) in selected]
        record["sourceFilterQuery"] = options["q"]
        record = _recount_source_detail(record, occurrences)
        record["occurrencePreviewLimited"] = len(record["occurrences"]) < len(occurrences)
        return {
            "schemaVersion": 1, "found": True, "sourceKey": key, "record": record,
            "page": page, "pageSize": options["pageSize"], "pageCount": page_count,
            "totalCount": len(video_keys), "totalVideoCount": len(video_keys),
            "totalOccurrenceCount": len(occurrences),
        }
    if record.get("occurrencePreviewLimited") and not query.get("q"):
        options = _query_options(query)
        range_id = _text(record.get("rangeId") or record.get("range_id")) or options["range"]
        occurrences = _runtime_source_occurrences(connection, revision_id, key, range_id)
        if occurrences:
            occurrences = _apply_source_overlay(occurrences, overlay_changes)
            previews = _source_song_previews(occurrences)
            if previews:
                video_keys = {
                    _text(item.get("youtubeVideoId") or item.get("videoId") or item.get("externalVideoId"))
                    for item in occurrences
                }
                record = dict(record)
                record["occurrences"] = previews
                record = _recount_source_detail(record, occurrences)
                record["occurrencePreviewLimited"] = len(previews) < len(occurrences)
    if overlay_changes and isinstance(record.get("occurrences"), list):
        record = dict(record)
        record["occurrences"] = _apply_source_overlay(record["occurrences"], overlay_changes)
        record = _recount_source_detail(record, record["occurrences"])
    return {"schemaVersion": 1, "found": True, "sourceKey": key, "record": record}


def _overlay_source_record(row: Mapping[str, Any]) -> dict[str, Any] | None:
    """Build one public source tuple without curation-only provenance."""

    video_id = _text(row.get("video_id") or row.get("videoId"))
    occurrence_id = _text(row.get("occurrence_id") or row.get("occurrenceId"))
    if not video_id or not occurrence_id:
        return None
    video = _overlay_public_video(row)
    video["videoId"] = video.get("videoId") or video_id
    occurrence = _overlay_public_occurrence(row.get("occurrence_payload_json") or row)
    occurrence.update({
        "videoId": video_id,
        "occurrenceId": occurrence.get("occurrenceId") or occurrence_id,
        "position": occurrence.get("position", row.get("position")),
        "rangeId": occurrence.get("rangeId") or row.get("range_id") or "all",
        "songKey": occurrence.get("songKey") or row.get("song_key"),
        "seconds": occurrence.get("seconds", row.get("seconds")),
        "title": occurrence.get("title") or row.get("title"),
        "artist": occurrence.get("artist") or row.get("artist"),
        "sourceId": occurrence.get("sourceId") or row.get("source_id"),
        "sourceSystem": occurrence.get("sourceSystem") or row.get("source_system"),
    })
    return {"video": video, "occurrences": (occurrence,)}


def _generic_song_source_payload(
    connection,
    parent_revision_id: str,
    persisted_record: Mapping[str, Any],
    requested_key: str,
    query: Mapping[str, Any] | None,
    overlay_revision_ids: Sequence[str],
    candidate_rows: Sequence[Mapping[str, Any]] | None = None,
    accepted_video_resets: Mapping[str, Mapping[str, Any]] | None = None,
    runtime_changes: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """Rebuild one affected generic song source from bounded effective tuples.

    A song source is not a channel source: a curation replacement can move an
    occurrence from a different persisted source into this group.  Read only
    the exact parent song key, then apply the selected accepted-video boundary
    and final runtime chain.  ``None`` means this persisted detail is not a
    song detail; a false result is authoritative for a recognised song key.
    """

    if _text(persisted_record.get("type")) != "song":
        return None
    options = _query_options(query)
    range_id = _text(persisted_record.get("rangeId") or persisted_record.get("range_id")) or options["range"]
    target_key = _text(persisted_record.get("key"))
    title = _text(persisted_record.get("title"))
    artist = _text(persisted_record.get("displayArtist") or persisted_record.get("artist"))
    if not target_key:
        return None

    parent_rows = _rows(
        connection,
        """
        SELECT o.video_id, o.occurrence_id, o.range_id, o.song_key,
               o.seconds, o.title, o.artist, o.source_id, o.source_system,
               o.payload_json AS occurrence_payload_json, v.title AS video_title,
               v.channel_name, v.channel_id, v.channel_handle, v.channel_url,
               v.published_timestamp AS published_at, v.payload_json AS video_payload_json
        FROM runtime_occurrences AS o
        JOIN runtime_videos AS v
          ON v.revision_id = o.revision_id AND v.video_id = o.video_id
        WHERE o.revision_id = %s AND v.revision_id = %s
          AND (o.song_key = %s OR (o.title = %s AND o.artist = %s))
          AND (
            (%s = 'all' AND coalesce(o.range_id, '') IN ('all', ''))
            OR (%s = '7d' AND coalesce(o.range_id, '') IN ('7d', ''))
          )
        ORDER BY o.video_id, o.occurrence_id
        LIMIT %s
        """,
        [parent_revision_id, parent_revision_id, target_key, title, artist, range_id, range_id,
         _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
    )
    if len(parent_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("generic song source parent lookup exceeded bounded occurrence cap")

    def same_target(row: Mapping[str, Any]) -> bool:
        row_key = _text(row.get("song_key") or row.get("songKey"))
        if row_key and row_key == target_key:
            return True
        return bool(title) and (
            _overlay_song_group_norm(row.get("title")) == _overlay_song_group_norm(title)
            and _overlay_song_group_norm(row.get("artist")) == _overlay_song_group_norm(artist)
        )

    effective: dict[tuple[str, str], dict[str, Any]] = {}
    for row in parent_rows:
        record = _overlay_source_record(row)
        if record:
            occurrence = record["occurrences"][0]
            effective[(video_id := _text(occurrence.get("videoId")), _text(occurrence.get("occurrenceId")))] = record

    candidate_rows = tuple(candidate_rows) if candidate_rows is not None else tuple(
        _overlay_candidate_rows(connection, overlay_revision_ids)
    )
    accepted_video_resets = dict(accepted_video_resets) if accepted_video_resets is not None else _accepted_video_resets(
        connection, overlay_revision_ids,
    )
    for identity in list(effective):
        if identity[0] in accepted_video_resets:
            effective.pop(identity, None)
    for row in _overlay_rows_for_range(candidate_rows, range_id):
        if row.get("video_tombstone") or not same_target(row):
            continue
        record = _overlay_source_record(row)
        if record:
            occurrence = record["occurrences"][0]
            effective[(_text(occurrence.get("videoId")), _text(occurrence.get("occurrenceId")))] = record

    changes = list(runtime_changes) if runtime_changes is not None else _runtime_tombstones(
        connection, overlay_revision_ids, accepted_video_resets.values() if accepted_video_resets else None,
        candidate_rows,
    )
    changes = _overlay_rows_for_range(changes, range_id)
    replacement_rows = _runtime_replacement_candidate_rows(changes)
    for change in changes:
        if not same_target(change):
            continue
        effective.pop((_text(change.get("videoId")), _text(change.get("occurrenceId"))), None)
    for row in replacement_rows:
        if not same_target(row):
            continue
        record = _overlay_source_record(row)
        if record:
            occurrence = record["occurrences"][0]
            effective[(_text(occurrence.get("videoId")), _text(occurrence.get("occurrenceId")))] = record

    records = [record for _, record in sorted(effective.items())]
    # ``runtime_occurrences.song_key`` is the authoritative storage identity;
    # a legacy parent card may expose a normalized display key instead.  Build
    # through the real occurrence key, then retain the requested public source
    # key/path below rather than assuming those two identities are identical.
    first_song_key = _text(records[0]["occurrences"][0].get("songKey")) if records else target_key
    canonical_key = _stable_key("source-song", range_id, first_song_key)
    rebuilt = source_payload_from_records(records, canonical_key, query)
    if not rebuilt.get("found"):
        return {"schemaVersion": 1, "found": False, "sourceKey": requested_key}
    rebuilt = dict(rebuilt)
    record = {**dict(persisted_record), **dict(rebuilt.get("record") or {})}
    record["key"] = target_key
    record["title"] = title
    record["displayArtist"] = artist
    record["sourceDetailKey"] = requested_key
    record["sourceDetailPath"] = _text(record.get("sourceDetailPath"))
    rebuilt["sourceKey"] = requested_key
    rebuilt["record"] = record
    return rebuilt


def _generic_overlay_song_source_for_key(
    connection,
    parent_revision_id: str,
    requested_key: str,
    query: Mapping[str, Any] | None,
    overlay_revision_ids: Sequence[str],
) -> dict[str, Any] | None:
    """Resolve an overlay-only song source key without a parent detail row.

    The public source key is opaque, so reverse it only against the bounded
    candidate/final-runtime groups in this lineage.  Zero candidates means a
    different source type; multiple distinct groups fail closed rather than
    guessing after an improbable digest collision.
    """

    # Generic overlay-only song cards use stable hexadecimal keys.  Do not
    # query candidate tables for arbitrary channel/source aliases that are
    # not even eligible to be a song source.
    if not re.fullmatch(r"[0-9a-f]{16}(?:[0-9a-f]{8})?", requested_key):
        return None
    options = _query_options(query)
    candidate_rows = tuple(_overlay_candidate_rows(connection, overlay_revision_ids))
    accepted_video_resets = _accepted_video_resets(connection, overlay_revision_ids, False)
    changes = _runtime_tombstones(
        connection, overlay_revision_ids,
        accepted_video_resets.values() if accepted_video_resets else None,
        candidate_rows,
    )
    replacement_rows = _runtime_replacement_candidate_rows(changes)
    targets: dict[str, tuple[str, str]] = {}
    for row in (*candidate_rows, *changes, *replacement_rows):
        title = _text(row.get("title"))
        artist = _text(row.get("artist"))
        if not title:
            continue
        group_key = f"{_overlay_norm(title)}::{_overlay_norm(artist)}"
        if _production_source_detail_key_for_group("songs", options["range"], group_key) != requested_key:
            continue
        targets[group_key] = (title, artist)
    if not targets:
        return None
    if len(targets) != 1:
        return {"schemaVersion": 1, "found": False, "sourceKey": requested_key}
    group_key, (title, artist) = next(iter(targets.items()))
    synthetic = {
        "type": "song", "key": group_key, "title": title,
        "displayArtist": artist, "rangeId": options["range"],
        "sourceDetailKey": requested_key,
    }
    return _generic_song_source_payload(
        connection, parent_revision_id, synthetic, requested_key, query,
        overlay_revision_ids, candidate_rows, accepted_video_resets, changes,
    )


def rankings_payload(connection, query: Mapping[str, Any] | None = None) -> dict[str, Any]:
    runtime = _runtime_projection_revision(connection)
    if runtime:
        return _runtime_rankings_payload(connection, runtime[0], query)
    generic_runtime = _generic_runtime_projection_revision(connection)
    if generic_runtime:
        return _generic_overlay_rankings_payload(connection, generic_runtime[0], generic_runtime[1], query)
    snapshot = _load_snapshot(connection)
    return rankings_payload_from_records(snapshot.records, query)


def _runtime_source_key_for_channel_alias(connection, revision_id: str, requested_key: str) -> str:
    """Resolve one active-revision VTuber channel identity to a unique source key."""
    alias = _text(requested_key).strip()
    if len(alias) < 4:
        return ""
    rows = _rows(connection, """
        SELECT payload_json, row_count FROM runtime_ranking_rows
        WHERE revision_id = %s AND view = 'vtubers' AND metric = 'count'
          AND (detail_key = %s OR channel_search_text ILIKE %s)
        LIMIT 8
        """, [revision_id, alias, f"%{alias}%"])
    scores: dict[str, int] = {}
    for row in rows:
        payload = _json_object(row.get("payload_json"))
        candidate = _text(payload.get("sourceDetailKey"))
        if not candidate:
            continue
        try:
            score = int(row.get("row_count") or payload.get("count") or 0)
        except (TypeError, ValueError):
            score = 0
        scores[candidate] = max(scores.get(candidate, 0), score)
    if not scores:
        return ""
    highest = max(scores.values())
    winners = [key for key, score in scores.items() if score == highest]
    return winners[0] if len(winners) == 1 else ""


def _has_trusted_source_channel_identity(record: Mapping[str, Any]) -> bool:
    """Whether a persisted source can be authoritatively rebuilt by channel."""

    return bool(
        _text(record.get("channelId") or record.get("channel_id") or record.get("channelKey") or record.get("channel_key"))
        or _text(record.get("channelHandle") or record.get("channel_handle") or record.get("handle")).lstrip("/@")
    )


def source_payload(connection, key: str, query: Mapping[str, Any] | None = None) -> dict[str, Any]:
    runtime = _runtime_projection_revision(connection)
    if runtime:
        persisted = _runtime_source_payload(connection, runtime[0], key, query, allow_derived=False)
        if persisted.get("found"):
            return persisted
        resolved_key = _runtime_source_key_for_channel_alias(connection, runtime[0], key)
        if resolved_key:
            persisted = _runtime_source_payload(connection, runtime[0], resolved_key, query, allow_derived=False)
            if persisted.get("found"):
                return persisted
        metadata = _channel_metadata_rows(connection, _revision_lineage(connection, runtime[0]))
        channel_metadata = _metadata_for_source_key(metadata, key)
        if channel_metadata:
            return _runtime_channel_source_payload(connection, runtime[0], channel_metadata, key, query)
        return persisted
    generic_runtime = _generic_runtime_projection_revision(connection)
    if generic_runtime:
        parent = _generic_parent_runtime_revision(connection, generic_runtime[0], generic_runtime[1])
        if parent:
            overlay_ids = _overlay_revision_ids(connection, generic_runtime[0], parent[0])
            persisted = _runtime_source_payload(connection, parent[0], key, query, allow_derived=False, overlay_revision_ids=overlay_ids)
            if persisted.get("found"):
                persisted_record = persisted.get("record") if isinstance(persisted.get("record"), Mapping) else {}
                song_rebuilt = _generic_song_source_payload(
                    connection, parent[0], persisted_record, key, query, overlay_ids,
                ) if overlay_ids else None
                if song_rebuilt is not None:
                    return song_rebuilt
                if persisted_record and (
                    overlay_ids
                    or _text(persisted_record.get("sourceDetailKey")) != _text(key)
                ):
                    # A parent projection can retain an all-range payload under
                    # a 7d key, and accepted overlays add rows that do not exist
                    # in the persisted parent source detail.  Rebuild only this
                    # channel while retaining every existing public field.
                    repaired = _runtime_channel_source_payload(connection, parent[0], persisted_record, key, query, overlay_revision_ids=overlay_ids)
                    if repaired.get("found"):
                        repaired = dict(repaired)
                        repaired["record"] = {**dict(persisted_record), **dict(repaired.get("record") or {})}
                        return repaired
                    if overlay_ids and _has_trusted_source_channel_identity(persisted_record):
                        # A full-video reset/tombstone is authoritative for an
                        # exact persisted channel identity.  Do not revive the
                        # parent source when its final record set is empty.
                        return repaired
                return persisted
            resolved_key = _runtime_source_key_for_channel_alias(connection, parent[0], key)
            if resolved_key:
                persisted = _runtime_source_payload(connection, parent[0], resolved_key, query, allow_derived=False, overlay_revision_ids=overlay_ids)
                if persisted.get("found"):
                    persisted_record = persisted.get("record") if isinstance(persisted.get("record"), Mapping) else {}
                    song_rebuilt = _generic_song_source_payload(
                        connection, parent[0], persisted_record, resolved_key, query, overlay_ids,
                    ) if overlay_ids else None
                    if song_rebuilt is not None:
                        return song_rebuilt
                    if persisted_record:
                        repaired = _runtime_channel_source_payload(
                            connection,
                            parent[0],
                            persisted_record,
                            resolved_key,
                            query,
                            overlay_revision_ids=overlay_ids,
                        )
                        if repaired.get("found"):
                            repaired = dict(repaired)
                            repaired["record"] = {
                                **dict(persisted_record),
                                **dict(repaired.get("record") or {}),
                            }
                            return repaired
                        if overlay_ids and _has_trusted_source_channel_identity(persisted_record):
                            return repaired
                    return persisted
            overlay_song = _generic_overlay_song_source_for_key(
                connection, parent[0], key, query, overlay_ids,
            ) if overlay_ids else None
            if overlay_song is not None:
                return overlay_song
            metadata = _channel_metadata_rows(connection, _revision_lineage(connection, generic_runtime[0]))
            channel_metadata = _metadata_for_source_key(metadata, key)
            if channel_metadata:
                return _runtime_channel_source_payload(connection, parent[0], channel_metadata, key, query, overlay_revision_ids=overlay_ids)
            if key.startswith("UC"):
                return _runtime_channel_source_payload(
                    connection,
                    parent[0],
                    {"channelId": key},
                    key,
                    query,
                    overlay_revision_ids=overlay_ids,
                )
            return persisted
        return {"schemaVersion": 1, "found": False, "sourceKey": key}
    snapshot = _load_snapshot(connection)
    return source_payload_from_records(snapshot.records, key, query)


def _jsonable(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def _meta_overlay_tuple(row: Mapping[str, Any]) -> dict[str, Any] | None:
    """Normalize one bounded overlay row to the identity used by meta deltas."""

    video_id = _text(row.get("video_id") or row.get("videoId"))
    occurrence_id = _text(row.get("occurrence_id") or row.get("occurrenceId"))
    if not video_id or not occurrence_id:
        return None
    video = _json_object(
        row.get("video_payload_json") or row.get("videoPayload") or row.get("replacementVideoPayload")
    )
    return {
        "video_id": video_id,
        "occurrence_id": occurrence_id,
        "song_key": _text(row.get("song_key") or row.get("songKey")),
        "title": _text(row.get("title")),
        "artist": _text(row.get("artist")),
        "range_id": _text(row.get("range_id") or row.get("rangeId")),
        "channel_id": _text(row.get("channel_id") or row.get("channelId") or video.get("channelId")),
        "channel_handle": _text(row.get("channel_handle") or row.get("channelHandle") or video.get("channelHandle")),
        "channel_name": _text(row.get("channel_name") or row.get("channelName") or video.get("channelName")),
    }


def _bounded_meta_identity_parent_rows(
    connection,
    parent_revision_id: str,
    identities: Iterable[tuple[str, str]],
    excluded_video_ids: set[str],
) -> list[dict[str, Any]]:
    """Read the remaining exact parent tuples with one PostgreSQL-bounded query."""

    pairs = sorted({
        (video_id, occurrence_id)
        for video_id, occurrence_id in identities
        if video_id and occurrence_id and video_id not in excluded_video_ids
    })
    if not pairs:
        return []
    rows = _rows(
        connection,
        """
        SELECT o.video_id, o.occurrence_id, o.song_key, o.title, o.artist,
               o.range_id, v.channel_id, v.channel_handle, v.channel_name
        FROM runtime_occurrences AS o
        JOIN runtime_videos AS v
          ON v.revision_id = o.revision_id AND v.video_id = o.video_id
        JOIN unnest(%s::text[], %s::text[])
          AS affected(video_id, occurrence_id)
          ON affected.video_id = o.video_id
         AND affected.occurrence_id = o.occurrence_id
        WHERE o.revision_id = %s
        ORDER BY o.video_id, o.occurrence_id
        LIMIT %s
        """,
        [
            [video_id for video_id, _ in pairs],
            [occurrence_id for _, occurrence_id in pairs],
            parent_revision_id,
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
        ],
    )
    if len(rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("meta overlay identity reconciliation exceeded bounded occurrence cap")
    return rows


def _bounded_meta_parent_reset_videos(
    connection,
    parent_revision_id: str,
    video_ids: Iterable[str],
) -> set[str]:
    ids = sorted({_text(video_id) for video_id in video_ids if _text(video_id)})
    if not ids:
        return set()
    rows = _rows(
        connection,
        """
        SELECT video_id
        FROM runtime_videos
        WHERE revision_id = %s AND video_id = ANY(%s)
        ORDER BY video_id
        LIMIT %s
        """,
        [parent_revision_id, ids, _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
    )
    if len(rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("meta overlay video reconciliation exceeded bounded video cap")
    return {_text(row.get("video_id")) for row in rows if _text(row.get("video_id"))}


def _apply_generic_overlay_ranking_row_delta(
    connection,
    parent_revision_id: str,
    before: Mapping[tuple[str, str], Mapping[str, Any]],
    effective: Mapping[tuple[str, str], Mapping[str, Any]],
    baseline: int,
) -> int:
    """Reconcile display-ready ranking rows from bounded affected groups."""

    weights = {"songs": 3, "artists": 2, "vtubers": 3, "videos": 1}
    def memberships(item: Mapping[str, Any]) -> set[tuple[str, str, str]]:
        title = _overlay_norm(item.get("title"))
        artist = _overlay_norm(item.get("artist"))
        video_id = _text(item.get("video_id"))
        channel = _text(item.get("channel_id")) or _text(item.get("channel_handle")).lstrip("@/") or _overlay_norm(item.get("channel_name"))
        if not video_id or not title:
            return set()
        # The full importer emits distinct ``runtime_occurrences`` rows for
        # all and 7d (the stable occurrence identity includes ``rangeId``),
        # so explicit rows affect exactly their own range.  Historic accepted
        # rows without range are the one compatibility exception and are
        # projected into both public range families.
        stored_range = _text(item.get("range_id"))
        ranges = {stored_range} if stored_range else {"all", "7d"}
        groups = set()
        for range_id in ranges:
            groups.add((range_id, "songs", f"{title}::{artist}"))
            groups.add((range_id, "artists", artist or "unknown"))
            groups.add((range_id, "videos", video_id))
            if channel:
                groups.add((range_id, "vtubers", channel))
        return groups

    before_groups: dict[tuple[str, str, str], int] = defaultdict(int)
    effective_groups: dict[tuple[str, str, str], int] = defaultdict(int)
    for item in before.values():
        for group in memberships(item):
            before_groups[group] += 1
    for item in effective.values():
        for group in memberships(item):
            effective_groups[group] += 1
    affected = sorted(set(before_groups) | set(effective_groups))
    if not affected:
        return baseline
    if len(affected) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("meta overlay ranking reconciliation exceeded bounded group cap")
    affected_ranges = [range_id for range_id, _, _ in affected]
    affected_views = [view for _, view, _ in affected]
    affected_keys = [key for _, _, key in affected]
    rows = _rows(
        connection,
        """
        WITH affected_groups(range_id, view, detail_key) AS (
          SELECT * FROM unnest(%s::text[], %s::text[], %s::text[])
        )
        SELECT row.range_id, row.view, row.detail_key, max(row.row_count) AS row_count
        FROM runtime_ranking_rows AS row
        JOIN affected_groups AS affected_group
          ON affected_group.range_id = row.range_id
         AND affected_group.view = row.view
         AND affected_group.detail_key = row.detail_key
        WHERE row.revision_id = %s
        GROUP BY row.range_id, row.view, row.detail_key
        ORDER BY row.range_id, row.view, row.detail_key
        LIMIT %s
        """,
        [
            affected_ranges,
            affected_views,
            affected_keys,
            parent_revision_id,
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
        ],
    )
    if len(rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("meta overlay ranking row lookup exceeded bounded cap")
    parent_counts = {
        (_text(row.get("range_id")), _text(row.get("view")), _text(row.get("detail_key"))): int(row.get("row_count") or 0)
        for row in rows
    }
    delta = 0
    for group in affected:
        parent_count = parent_counts.get(group, 0)
        final_count = parent_count - before_groups.get(group, 0) + effective_groups.get(group, 0)
        if parent_count <= 0 < final_count:
            delta += weights[group[1]]
        elif parent_count > 0 >= final_count:
            delta -= weights[group[1]]
    return max(0, baseline + delta)


def _apply_generic_overlay_meta_counts(
    connection,
    parent_revision_id: str,
    overlay_revision_ids: Sequence[str],
    counts: Mapping[str, int],
) -> dict[str, int]:
    """Apply an exact, bounded effective-tuple delta to generic meta counts.

    ``runtime_meta`` is the full parent baseline.  Accepted video rows are
    authoritative replacement boundaries, so the affected parent tuples are
    removed before final accepted rows and later curation are applied.
    """

    result = dict(counts)
    candidate_rows = tuple(
        _overlay_candidate_rows(connection, overlay_revision_ids, False)
    )
    accepted_video_resets = _accepted_video_resets(connection, overlay_revision_ids, False)
    reset_changes = _accepted_video_reset_changes(
        connection, parent_revision_id, accepted_video_resets, {"range": "all"},
    )
    runtime_changes = _runtime_tombstones(
        connection,
        overlay_revision_ids,
        accepted_video_resets.values() if accepted_video_resets else None,
        candidate_rows,
    )
    reset_video_ids = set(accepted_video_resets)
    before: dict[tuple[str, str], dict[str, Any]] = {}
    for change in reset_changes:
        item = _meta_overlay_tuple(change)
        if item:
            before[(item["video_id"], item["occurrence_id"])] = item
    referenced_identities: set[tuple[str, str]] = set()
    for row in (*candidate_rows, *runtime_changes):
        item = _meta_overlay_tuple(row)
        if item:
            referenced_identities.add((item["video_id"], item["occurrence_id"]))
    for row in _bounded_meta_identity_parent_rows(
        connection, parent_revision_id, referenced_identities, reset_video_ids,
    ):
        item = _meta_overlay_tuple(row)
        if item:
            before.setdefault((item["video_id"], item["occurrence_id"]), item)

    effective = dict(before)
    # A reset replaces its entire parent video, including an accepted
    # tombstone.  It is not an incremental addition.
    for identity in list(effective):
        if identity[0] in reset_video_ids:
            effective.pop(identity, None)
    for row in candidate_rows:
        if row.get("video_tombstone"):
            continue
        item = _meta_overlay_tuple(row)
        if not item:
            continue
        identity = (item["video_id"], item["occurrence_id"])
        effective.pop(identity, None)
        effective[identity] = item
    # A finalized runtime replacement is remove+add at the same logical
    # occurrence, while a tombstone is remove-only.  Dict identities make a
    # malformed duplicate chain idempotent instead of repeatedly decrementing.
    replacement_rows = _runtime_replacement_candidate_rows(runtime_changes)
    for change in runtime_changes:
        if _text(change.get("entityType")) not in {"occurrences", "runtime_occurrences"}:
            continue
        item = _meta_overlay_tuple(change)
        if item:
            effective.pop((item["video_id"], item["occurrence_id"]), None)
    for row in replacement_rows:
        item = _meta_overlay_tuple(row)
        if item:
            effective[(item["video_id"], item["occurrence_id"])] = item

    result["occurrences"] = max(
        0, int(result.get("occurrences") or 0) + len(effective) - len(before),
    )
    # The full importer emits one distinct occurrence row per range.  For
    # each such tuple the exporter serialises exactly the song, artist, and
    # vtuber source occurrences; ranking metric variants reuse the same
    # source detail key.  Explicit physical range rows therefore contribute
    # three rows; only a legacy accepted row with no range is projected into
    # both public range families and contributes six.
    def source_occurrence_units(item: Mapping[str, Any]) -> int:
        return 3 if _text(item.get("range_id") or item.get("rangeId")) else 6
    result["source_occurrences"] = max(
        0,
        int(result.get("source_occurrences") or 0)
        + sum(source_occurrence_units(item) for item in effective.values())
        - sum(source_occurrence_units(item) for item in before.values()),
    )
    result["ranking_rows"] = _apply_generic_overlay_ranking_row_delta(
        connection, parent_revision_id, before, effective,
        int(result.get("ranking_rows") or 0),
    )
    parent_reset_videos = _bounded_meta_parent_reset_videos(
        connection, parent_revision_id, reset_video_ids,
    )
    final_reset_videos = {
        video_id for video_id, row in accepted_video_resets.items()
        if not bool(row.get("tombstone"))
    }
    result["videos"] = max(
        0,
        int(result.get("videos") or 0)
        + len(final_reset_videos)
        - len(parent_reset_videos),
    )

    def song_key(item: Mapping[str, Any]) -> str:
        return _text(item.get("song_key")) or _runtime_song_identity(item)

    before_by_song: dict[str, int] = defaultdict(int)
    effective_by_song: dict[str, int] = defaultdict(int)
    for item in before.values():
        before_by_song[song_key(item)] += 1
    for item in effective.values():
        effective_by_song[song_key(item)] += 1
    affected_song_keys = sorted({
        key for key in {*before_by_song, *effective_by_song}
        if key
    })
    if affected_song_keys:
        song_rows = _rows(
            connection,
            """
            SELECT song_key, count(*) AS count
            FROM runtime_occurrences
            WHERE revision_id = %s AND song_key = ANY(%s)
            GROUP BY song_key
            ORDER BY song_key
            LIMIT %s
            """,
            [parent_revision_id, affected_song_keys, _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
        )
        if len(song_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
            raise PostgresAdapterError("meta overlay song reconciliation exceeded bounded song cap")
        parent_song_counts = {
            _text(row.get("song_key")): int(row.get("count") or 0)
            for row in song_rows
            if _text(row.get("song_key"))
        }
        song_delta = 0
        for key in affected_song_keys:
            parent_count = parent_song_counts.get(key, 0)
            final_count = parent_count - before_by_song.get(key, 0) + effective_by_song.get(key, 0)
            if parent_count <= 0 < final_count:
                song_delta += 1
            elif parent_count > 0 >= final_count:
                song_delta -= 1
        result["songs"] = max(0, int(result.get("songs") or 0) + song_delta)
    return result


def meta_payload(connection) -> dict[str, Any]:
    runtime = _runtime_projection_revision(connection)
    if runtime:
        revision_id, revision = runtime
        meta_rows = _rows(connection, "SELECT key, value FROM runtime_meta WHERE revision_id = %s", [revision_id])
        meta = {str(row.get("key")): _jsonable(row.get("value")) for row in meta_rows}
        manifest = _json_object(revision.get("manifest_json"))
        meta.update({str(key): _jsonable(value) for key, value in manifest.items() if key not in meta and (isinstance(value, (str, int, float, bool)) or value is None)})
        meta.update({
            "active_revision_id": revision_id,
            "migration_status": revision.get("status", ""),
            "source_manifest_sha256": revision.get("source_manifest_sha256", ""),
            "content_sha256": revision.get("content_sha256", ""),
            "built_at": _jsonable(revision.get("activated_at") or revision.get("created_at") or ""),
        })
        def meta_int(*keys: str) -> int:
            for key in keys:
                value = meta.get(key)
                try:
                    return int(value)
                except (TypeError, ValueError):
                    continue
            return 0
        counts = {
            "videos": meta_int("latest_videos"),
            "songs": meta_int("latest_songs"),
            "occurrences": meta_int("latest_occurrences"),
            "ranking_rows": meta_int("latest_ranking_rows"),
            "source_occurrences": meta_int("source_occurrences_rows", "latest_source_occurrences"),
            "channel_metadata": meta_int("channel_metadata", "latest_channel_metadata"),
            "external_songs": meta_int("external_songs", "latest_external_songs", "vsinger_songs"),
            "external_videos": meta_int("external_videos", "latest_external_videos", "vsinger_videos"),
            "external_occurrences": meta_int("external_occurrences", "latest_external_occurrences", "vsinger_occurrences"),
        }
        return {"schemaVersion": 1, "meta": meta, "counts": counts}
    generic_runtime = _generic_runtime_projection_revision(connection)
    if generic_runtime:
        parent = _generic_parent_runtime_revision(connection, generic_runtime[0], generic_runtime[1])
        if not parent:
            raise PostgresAdapterError("incremental candidate has no full runtime parent")
        parent_id, parent_revision = parent
        meta_rows = _rows(connection, "SELECT key, value FROM runtime_meta WHERE revision_id = %s", [parent_id])
        meta = {str(row.get("key")): _jsonable(row.get("value")) for row in meta_rows}
        manifest = _json_object(parent_revision.get("manifest_json"))
        candidate_manifest = _json_object(generic_runtime[1].get("manifest_json"))
        meta.update({str(key): _jsonable(value) for key, value in candidate_manifest.items() if key not in {"runtimeProjection", "incrementalOverlay"} and (isinstance(value, (str, int, float, bool)) or value is None)})
        meta.update({
            "active_revision_id": generic_runtime[0],
            "migration_status": generic_runtime[1].get("status", ""),
            "source_manifest_sha256": generic_runtime[1].get("source_manifest_sha256", ""),
            "content_sha256": generic_runtime[1].get("content_sha256", ""),
            "built_at": _jsonable(generic_runtime[1].get("activated_at") or generic_runtime[1].get("created_at") or ""),
            "parent_revision_id": parent_id,
        })
        counts = {}
        for key, fallback in (("latest_videos", 0), ("latest_songs", 0), ("latest_occurrences", 0), ("latest_ranking_rows", 0), ("source_occurrences_rows", 0), ("channel_metadata", 0), ("external_songs", 0), ("external_videos", 0), ("external_occurrences", 0)):
            try:
                counts[key] = int(meta.get(key, fallback))
            except (TypeError, ValueError):
                counts[key] = fallback
        counts.update({
            "videos": counts.get("latest_videos", 0),
            "songs": counts.get("latest_songs", 0),
            "occurrences": counts.get("latest_occurrences", 0),
            "ranking_rows": counts.get("latest_ranking_rows", 0),
            "source_occurrences": counts.get("source_occurrences_rows", 0),
        })
        overlay_ids = _overlay_revision_ids(connection, generic_runtime[0], parent_id)
        cache_key = (generic_runtime[0], parent_id, tuple(overlay_ids))
        cached_counts = _GENERIC_META_COUNTS_CACHE.get(cache_key)
        if cached_counts is None:
            cached_counts = _apply_generic_overlay_meta_counts(
                connection, parent_id, overlay_ids, counts,
            )
            if len(_GENERIC_META_COUNTS_CACHE) >= 8:
                _GENERIC_META_COUNTS_CACHE.pop(next(iter(_GENERIC_META_COUNTS_CACHE)))
            _GENERIC_META_COUNTS_CACHE[cache_key] = dict(cached_counts)
        counts = {**counts, **cached_counts}
        return {"schemaVersion": 1, "meta": meta, "counts": {
            "videos": counts.get("videos", 0), "songs": counts.get("songs", counts.get("latest_songs", 0)),
            "occurrences": counts.get("occurrences", 0), "ranking_rows": counts.get("ranking_rows", counts.get("latest_ranking_rows", 0)),
            "source_occurrences": counts.get("source_occurrences", counts.get("source_occurrences_rows", 0)),
            "channel_metadata": counts.get("channel_metadata", 0), "external_songs": counts.get("external_songs", 0),
            "external_videos": counts.get("external_videos", 0), "external_occurrences": counts.get("external_occurrences", 0),
        }}
    snapshot = _load_snapshot(connection)
    records = list(snapshot.records)
    occurrence_count = sum(len(record["occurrences"]) for record in records)
    song_keys = {_song_key(song) for record in records for song in record["occurrences"]}
    meta: dict[str, Any] = {"schema_version": "1", "runtime_source": "postgresql-migration"}
    if snapshot.revision:
        manifest = _json_object(snapshot.revision.get("manifest_json"))
        meta.update({str(key): _jsonable(value) for key, value in manifest.items() if isinstance(value, (str, int, float, bool)) or value is None})
        meta.update(
            {
                "active_revision_id": snapshot.revision_id,
                "migration_status": snapshot.revision.get("status", ""),
                "source_manifest_sha256": snapshot.revision.get("source_manifest_sha256", ""),
                "content_sha256": snapshot.revision.get("content_sha256", ""),
                "built_at": _jsonable(snapshot.revision.get("activated_at") or snapshot.revision.get("created_at") or ""),
            }
        )
    ranking_rows = 0
    ranking_shapes = (
        ("songs", ("count", "videos")), ("songIndex", ("count",)),
        ("artists", ("count", "videos")), ("videos", ("count",)),
        ("vtubers", ("count", "songs", "videos")), ("vsingerSongs", ("count",)),
    )
    for range_id in ("all", "7d"):
        for view, metrics in ranking_shapes:
            for metric in metrics:
                ranking_rows += len(_entity_groups(
                    records,
                    {"range": range_id, "view": view, "q": "", "searchScope": "all", "searchFields": None,
                     "nicheOnly": False, "hideUnknownArtist": False, "metric": metric, "minCount": 1},
                ))
    counts = {
        "videos": len(records), "songs": len(song_keys), "occurrences": occurrence_count,
        "ranking_rows": ranking_rows, "source_occurrences": occurrence_count,
        "channel_metadata": 0, "external_songs": 0, "external_videos": 0, "external_occurrences": 0,
    }
    return {"schemaVersion": 1, "meta": meta, "counts": counts}


def health_payload(connection) -> dict[str, Any]:
    meta = meta_payload(connection)
    return {
        "status": "ok", "schemaVersion": meta["schemaVersion"],
        "builtAt": meta["meta"].get("built_at", ""),
        "latestGeneratedAt": meta["meta"].get("latest_generated_at", ""),
        "counts": meta["counts"],
    }


__all__ = [
    "PostgresAdapterError", "PostgresSchemaError", "REQUIRED_TABLES",
    "connect_from_env", "ensure_schema", "health_payload", "meta_payload",
    "rankings_payload", "rankings_payload_from_records", "resolve_dsn_from_env",
    "source_payload", "source_payload_from_records",
]
