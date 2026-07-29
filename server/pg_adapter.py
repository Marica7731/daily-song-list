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

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime
import hashlib
import json
import math
import os
import re
import sys
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
# Generic increments are immutable.  Keep only their small derived meta count
# map, never record/payload data: a changed active pointer produces a different
# key and a process restart simply recomputes it from PostgreSQL.
_GENERIC_META_COUNTS_CACHE: dict[tuple[str, str, tuple[str, ...]], dict[str, int]] = {}


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


def _channel_metadata_rows(connection, revision_ids: Sequence[str]) -> list[dict[str, Any]]:
    """Read channel metadata from full projections and incremental runtime rows."""

    if not revision_ids:
        return []
    values: list[dict[str, Any]] = []
    try:
        values.extend(_rows(
            connection,
            """
            SELECT revision_id, channel_key, channel_id, handle, display_name,
                   avatar_url, thumbnail_url, source_url, channel_url,
                   known_source_type, is_collected, payload_json
            FROM runtime_channel_metadata WHERE revision_id = ANY(%s)
            ORDER BY revision_id, channel_key
            """,
            [list(revision_ids)],
        ))
    except Exception:
        # Older/prototype fixtures may not expose the optional full-runtime table.
        pass
    try:
        values.extend(_rows(
            connection,
            """
            SELECT revision_id, entity_key AS channel_key, payload_json,
                   source_system, range_id, source_id, occurrence_id, tombstone
            FROM migration_runtime_rows
            WHERE revision_id = ANY(%s)
              AND entity_type IN ('channel_metadata', 'runtime_channel_metadata')
            ORDER BY revision_id, entity_key
            """,
            [list(revision_ids)],
        ))
    except Exception:
        pass
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
    source_query = _source_query_for_channel(key, metadata, query)
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
) -> list[dict[str, Any]]:
    """Read only the candidate rows; never resolve the parent occurrence table.

    Rankings and meta reconciliation need the indexed scalar columns for every
    changed tuple, but a page of 20 cards must not deserialize every retained
    JSON preview.  Detailed source reconstruction keeps ``include_payload``
    enabled; the bounded ranking/meta paths hydrate only returned previews.
    """

    occurrence_payload = "o.payload_json" if include_payload else "NULL::jsonb"
    video_payload = "payload_json" if include_payload else "NULL::jsonb"

    occurrence_rows = _rows(
        connection,
        f"""
        SELECT o.revision_id, o.video_id, o.occurrence_id, o.position, o.range_id,
               o.song_key, o.seconds, o.title, o.artist, o.source_id,
               o.raw_hash, o.source_system,
               {occurrence_payload} AS occurrence_payload_json
        FROM migration_occurrence_rows AS o
        WHERE o.revision_id = ANY(%s)
        ORDER BY o.revision_id, o.video_id, o.position, o.occurrence_key
        LIMIT %s
        """,
        [list(revision_ids), _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
    )
    if len(occurrence_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("overlay candidate occurrence lookup exceeded bounded cap")
    priority = {revision_id: index for index, revision_id in enumerate(revision_ids)}
    video_rows = _rows(
        connection,
        f"""
        SELECT revision_id, video_id, title AS video_title, channel_name,
               channel_id, channel_handle, channel_url, published_at,
               {video_payload} AS video_payload_json,
               tombstone AS video_tombstone
        FROM migration_video_rows
        WHERE revision_id = ANY(%s)
        ORDER BY revision_id, video_id
        LIMIT %s
        """,
        [list(revision_ids), _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
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
    rows = _rows(
        connection,
        f"""
        SELECT revision_id, video_id, title AS video_title, channel_name,
               channel_id, channel_handle, channel_url, published_at,
               tombstone, {payload} AS payload_json
        FROM migration_video_rows
        WHERE revision_id = ANY(%s)
        ORDER BY video_id
        LIMIT %s
        """,
        [list(revision_ids), _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
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
        SELECT o.occurrence_id, o.video_id, o.song_key, o.seconds, o.title,
               o.artist, o.range_id, o.source_id, o.source_system,
               o.payload_json, v.channel_id, v.channel_handle, v.channel_name,
               v.channel_url, v.title AS video_title,
               v.payload_json AS video_payload_json
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
        video = _overlay_public_video(row)
        changes.append({
            "entityType": "occurrences",
            "videoId": _text(row.get("video_id")),
            "occurrenceId": _text(row.get("occurrence_id")),
            "title": _text(row.get("title")),
            "artist": _text(row.get("artist")),
            "songKey": _text(row.get("song_key")),
            "rangeId": _text(row.get("range_id")),
            "channel_id": row.get("channel_id") or video.get("channelId"),
            "channel_handle": row.get("channel_handle") or video.get("channelHandle"),
            "channel_name": row.get("channel_name") or video.get("channelName"),
            "channel_url": row.get("channel_url") or video.get("channelUrl"),
            "videoPayload": row.get("video_payload_json"),
            "originalGroupVideoOccurrenceCount": 1,
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


def _overlay_runtime_rows(connection, revision_ids: Sequence[str]) -> list[dict[str, Any]]:
    if not revision_ids:
        return []
    rows = _rows(
        connection,
        """
        SELECT revision_id, entity_type, entity_key, source_system, range_id,
               source_id, occurrence_id, tombstone, payload_json
        FROM migration_runtime_rows
        WHERE revision_id = ANY(%s)
        ORDER BY revision_id, entity_type, entity_key
        LIMIT %s
        """,
        [list(revision_ids), _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
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
) -> list[dict[str, Any]]:
    """Resolve each runtime chain to its full-parent identity and final state."""

    if not revision_ids:
        return []
    priority = {revision_id: index for index, revision_id in enumerate(revision_ids)}
    runtime_rows = _overlay_runtime_rows(connection, revision_ids)
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
                if strict_immutable_identity:
                    raise PostgresAdapterError(
                        "VTuber exact overlay change is missing required immutable identity"
                    )
                continue
            for key in [key for key in chains if key[1] == video_id]:
                chains.pop(key, None)
            continue
        if event_kind == "occurrence":
            payload = _overlay_payload(row)
            video_id = _text(payload.get("videoId") or row.get("video_id"))
            identity = _text(payload.get("occurrenceId") or row.get("occurrence_id"))
            if not video_id or not identity:
                if strict_immutable_identity:
                    raise PostgresAdapterError(
                        "VTuber exact overlay change is missing required immutable identity"
                    )
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
            if strict_immutable_identity:
                raise PostgresAdapterError(
                    "VTuber exact overlay change is missing required immutable identity"
                )
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
            raise PostgresAdapterError(
                "VTuber exact replacement is missing required immutable identity"
            )
        strict_public: dict[str, Any] = {}
        if strict_immutable_identity:
            video_payload, strict_public = _strict_replacement_public_video(change, replacement)
            replacement_channel_id = _text(strict_public["channel_id"])
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


def _apply_runtime_tombstone_groups(groups: dict[str, dict[str, Any]], changes: Sequence[Mapping[str, Any]], view: str) -> None:
    decremented_videos: set[tuple[str, str]] = set()
    removal_counts: dict[tuple[str, str, str], int] = defaultdict(int)
    for change in changes:
        removal_counts[(
            _overlay_song_group_norm(change.get("title")),
            _overlay_song_group_norm(change.get("artist")),
            _text(change.get("videoId") or change.get("video_id")),
        )] += 1
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
        for key, row in list(groups.items()):
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
            payload.update({
                "count": row["row_count"],
                "videoCount": row.get("video_count", 0),
                "timestampCount": row["timestamp_count"],
            })
            row["payload_json"] = payload


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

    for row in groups.values():
        matched = [
            change for change in changes
            if _runtime_change_matches_group(row, change, view)
        ]
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


_MAX_AFFECTED_RUNTIME_OCCURRENCES = 50000


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
        titles = sorted({_text(value) for change in changes for value in (
            change.get("title"),
            change.get("replacementPayload", {}).get("title") if isinstance(change.get("replacementPayload"), Mapping) else "",
        ) if _text(value)})
        artists = sorted({_text(value) for change in changes for value in (
            change.get("artist"),
            change.get("replacementPayload", {}).get("artist") if isinstance(change.get("replacementPayload"), Mapping) else "",
        ) if _text(value)})
        if not titles or not artists:
            return []
        predicate = "lower(coalesce(o.title, '')) = ANY(%s) AND lower(coalesce(o.artist, '')) = ANY(%s)"
        predicate_params: list[Any] = [[value.casefold() for value in titles], [value.casefold() for value in artists]]
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
        SELECT o.occurrence_id, o.video_id, o.song_key, o.seconds, o.title, o.artist,
               o.range_id, o.source_id, o.source_system, o.payload_json,
               v.channel_id, v.channel_handle, v.channel_name, v.channel_url,
               v.title AS video_title, v.payload_json AS video_payload_json
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
    if not affected_keys:
        return
    # Candidate tuples can introduce a new title/artist group on a reset
    # video.  Include their keys in the bounded parent lookup so an already
    # existing canonical group is recomputed rather than incremented twice.
    lookup_changes = [
        *affected_changes,
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
            for row in candidate_rows
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
        for row in candidate_rows
        if _text(row.get("video_id")) and _json_object(row.get("video_payload_json"))
    }
    # A selected migration_video_rows entry is an authoritative full-video
    # boundary even when it is a tombstone and therefore contributes no
    # candidate occurrence row.  Do not let reconciliation rebuild that
    # parent video after the earlier aggregate subtraction.
    reset_video_ids = {
        _text(change.get("videoId") or change.get("video_id"))
        for change in affected_changes
        if bool(change.get("acceptedVideoReset"))
        and _text(change.get("videoId") or change.get("video_id"))
    }
    effective = {
        identity: row for identity, row in parent_by_identity.items()
        if identity[0] not in candidate_video_ids
        and identity[0] not in reset_video_ids
    }
    for row in candidate_rows:
        identity = (_text(row.get("video_id")), _text(row.get("occurrence_id")))
        if identity[0] and identity[1]:
            effective[identity] = dict(row)
    for change in affected_changes:
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
    for row in replacement_rows:
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
            raise PostgresAdapterError("overlay preview hydration has ambiguous candidate preview identity")
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

    if not isinstance(cached, Mapping) or len(cached) > 8 or set(cached) != affected_channel_ids:
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
    candidate_records: dict[str, dict[str, Any]] = {}
    affected_channel_ids: set[str] = set()
    # Only full-video boundaries remove every parent occurrence.  Runtime
    # occurrence chains stay as (video_id, occurrence_id) anti-joins below;
    # treating those as video replacements would silently drop unrelated songs
    # from the same video.
    full_video_ids = {
        _text(video_id) for video_id in (accepted_video_resets or {}) if _text(video_id)
    }
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
            raise PostgresAdapterError(
                "VTuber exact overlay change is missing required immutable identity"
            )

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
    cached = _VTUBER_REPLACEMENT_CACHE.get(cache_key)
    if cached is not None:
        if not _cached_vtuber_rows_are_safe(cached, affected_channel_ids, old_channel_markers):
            raise PostgresAdapterError("VTuber exact replacement cache identity is invalid")
        return {
            key: {**row, "payload_json": dict(row.get("payload_json") or {})}
            for key, row in cached.items()
        }
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
    if not options.get("q") and hasattr(connection, "cursor"):
        exact_started = time.perf_counter()
        candidate_values: list[dict[str, str]] = []
        candidate_previews: dict[str, list[dict[str, Any]]] = defaultdict(list)
        candidate_videos: dict[str, Mapping[str, Any]] = {}
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

        range_values = ["all", ""] if (_text(options.get("range")) or "all") == "all" else ["7d", ""]
        fast_default = not bool(options.get("nicheOnly")) and not bool(options.get("hideUnknownArtist"))

        if fast_default:
            summaries = _rows(
                connection,
                """
                WITH affected_channels AS MATERIALIZED (
                  SELECT DISTINCT unnest(%s::text[]) AS channel_id
                ), affected_videos AS MATERIALIZED (
                  SELECT DISTINCT unnest(%s::text[]) AS video_id
                ), affected_occurrences AS MATERIALIZED (
                  SELECT DISTINCT video_id, occurrence_id
                  FROM unnest(%s::text[], %s::text[]) AS item(video_id, occurrence_id)
                ), touched_occurrence_videos AS MATERIALIZED (
                  SELECT DISTINCT video_id FROM affected_occurrences
                ), range_values AS MATERIALIZED (
                  SELECT DISTINCT unnest(%s::text[]) AS range_id
                ), overlay_occurrences AS MATERIALIZED (
                  SELECT channel_id, video_id, song_key FROM jsonb_to_recordset(%s::jsonb)
                    AS item(channel_id text, video_id text, song_key text)
                ), affected_parent_videos AS MATERIALIZED (
                  SELECT v.video_id, v.channel_id FROM runtime_videos AS v
                  JOIN affected_channels AS affected ON affected.channel_id = v.channel_id
                  LEFT JOIN affected_videos AS reset ON reset.video_id = v.video_id
                  WHERE v.revision_id = %s AND reset.video_id IS NULL
                ), fast_parent_occurrences AS (
                  SELECT parent.channel_id, o.video_id, o.song_key
                  FROM affected_parent_videos AS parent
                  LEFT JOIN touched_occurrence_videos AS touched ON touched.video_id = parent.video_id
                  JOIN runtime_occurrences AS o ON o.revision_id = %s AND o.video_id = parent.video_id
                  JOIN range_values AS scope ON scope.range_id = o.range_id
                  WHERE touched.video_id IS NULL
                ), touched_parent_occurrences AS (
                  SELECT parent.channel_id, o.video_id, o.song_key
                  FROM affected_parent_videos AS parent
                  JOIN touched_occurrence_videos AS touched ON touched.video_id = parent.video_id
                  JOIN runtime_occurrences AS o ON o.revision_id = %s AND o.video_id = parent.video_id
                  JOIN range_values AS scope ON scope.range_id = o.range_id
                  LEFT JOIN affected_occurrences AS changed
                    ON changed.video_id = o.video_id AND changed.occurrence_id = o.occurrence_id
                  WHERE changed.occurrence_id IS NULL
                ), combined AS (
                  SELECT channel_id, video_id, song_key FROM fast_parent_occurrences
                  UNION ALL SELECT channel_id, video_id, song_key FROM touched_parent_occurrences
                  UNION ALL SELECT channel_id, video_id, song_key FROM overlay_occurrences
                )
                SELECT channel_id, count(*) AS row_count, count(DISTINCT video_id) AS video_count,
                       count(DISTINCT song_key) AS song_count,
                       bool_or(song_key = '') AS has_empty_song_key
                FROM combined GROUP BY channel_id
                """,
                [sorted(affected_channel_ids), sorted(full_video_ids),
                 [video_id for video_id, _ in sorted(affected_occurrence_ids)],
                 [occurrence_id for _, occurrence_id in sorted(affected_occurrence_ids)],
                 range_values, json.dumps(candidate_values, ensure_ascii=False),
                 parent_revision_id, parent_revision_id, parent_revision_id],
            )
            # The current producer invariant is nonempty song_key.  If it
            # regresses, discard this index-only result and retain the legacy
            # title/artist fallback instead of silently merging an empty key.
            fast_default = not any(bool(row.get("has_empty_song_key")) for row in summaries)
        exact_started = _phase_trace(
            "exact_fast_preflight", exact_started,
            fast_path=int(fast_default), empty_song_keys=int(not fast_default),
        )

        if not fast_default: summaries = _rows(
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
              SELECT parent.channel_id, o.video_id,
                     coalesce(
                       nullif(o.song_key, ''),
                       lower(coalesce(o.title, '')) || '::' ||
                         lower(coalesce(o.artist, ''))
                     ) AS song_key
              FROM affected_parent_videos AS parent
              JOIN runtime_occurrences AS o
                ON o.revision_id = %s
               AND o.video_id = parent.video_id
              JOIN range_values AS scope
                ON scope.range_id = o.range_id
              LEFT JOIN affected_occurrences AS changed
                ON changed.video_id = o.video_id
               AND changed.occurrence_id = o.occurrence_id
              WHERE changed.occurrence_id IS NULL
                AND (NOT %s OR nullif(o.artist, '') IS NOT NULL)
                AND (
                  NOT %s
                  OR coalesce(
                    o.payload_json::jsonb->>'isNiche',
                    o.payload_json::jsonb->'payload'->>'isNiche',
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
                bool(options.get("hideUnknownArtist")),
                bool(options.get("nicheOnly")),
            ],
        )
        exact_started = _phase_trace("exact_sql", exact_started, summary_rows=len(summaries))
        summary_by_channel = {
            _text(row.get("channel_id")): row
            for row in summaries
            if _text(row.get("channel_id"))
        }
        exact: dict[str, dict[str, Any]] = {}
        replaced_video_ids = set(full_video_ids)
        for channel_id in sorted(affected_channel_ids):
            summary = summary_by_channel.get(channel_id, {})
            base_row = base_groups.get(channel_id) or {}
            payload = _json_object(base_row.get("payload_json"))
            video = dict(candidate_videos.get(channel_id) or {})
            handle = _text(video.get("channelHandle"))
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
                "channelHandle": handle or payload.get("channelHandle", ""),
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
                "channel_search_text": "",
            }
        if len(_VTUBER_REPLACEMENT_CACHE) >= 8:
            _VTUBER_REPLACEMENT_CACHE.pop(next(iter(_VTUBER_REPLACEMENT_CACHE)))
        _VTUBER_REPLACEMENT_CACHE[cache_key] = exact
        _phase_trace(
            "exact_finalize",
            exact_started,
            output_channels=len(exact),
            preview_channels=len(candidate_previews),
        )
        return {
            key: {**row, "payload_json": dict(row.get("payload_json") or {})}
            for key, row in exact.items()
        }

    parent_video_rows = _rows(
        connection,
        """
        SELECT video_id, title, channel_name, channel_id, channel_handle,
               channel_url, published_timestamp, payload_json
        FROM runtime_videos
        WHERE revision_id = %s AND channel_id = ANY(%s)
        ORDER BY video_id
        """,
        [parent_revision_id, sorted(affected_channel_ids)],
    )
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
        WHERE revision_id = %s AND video_id = ANY(%s)
        ORDER BY video_id, range_id, occurrence_id
        """,
        [parent_revision_id, parent_video_ids],
    ) if parent_video_ids else []
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
    if len(_VTUBER_REPLACEMENT_CACHE) >= 8:
        _VTUBER_REPLACEMENT_CACHE.pop(next(iter(_VTUBER_REPLACEMENT_CACHE)))
    _VTUBER_REPLACEMENT_CACHE[cache_key] = exact
    return {
        key: {**row, "payload_json": dict(row.get("payload_json") or {})}
        for key, row in exact.items()
    }


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
        raise PostgresAdapterError(error)
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
        raise PostgresAdapterError(error)
    if len(set(channel_ids)) > 1:
        raise PostgresAdapterError(error)
    if len(set(handles)) > 1:
        raise PostgresAdapterError(error)
    channel_id = channel_ids[0] if channel_ids else ""
    if validate_urls and channel_id:
        for url in urls:
            if not _channel_url_is_coherent(url, channel_id, "") and not any(
                _channel_url_is_coherent(url, channel_id, handle) for handle in handles
            ):
                raise PostgresAdapterError(error)
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
            raise PostgresAdapterError("VTuber exact replacement public identity is invalid")
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
        raise PostgresAdapterError("VTuber exact overlay change is missing required immutable identity")
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
        raise PostgresAdapterError(error)
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
        raise PostgresAdapterError(error)
    # Existing parent/scalar/payload identity is evidence too.  It must agree
    # with this selected projection before it can fill the missing channel.
    _validated_overlay_change_identity(change, candidate, validate_urls=False)
    return _canonical_accepted_reset_row(candidate)


def _generic_overlay_rankings_payload(connection, revision_id: str, revision: Mapping[str, Any], query: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Return bounded candidate rankings from parent aggregates plus delta rows."""

    phase_started = time.perf_counter()
    parent = _generic_parent_runtime_revision(connection, revision_id, revision)
    if not parent:
        raise PostgresAdapterError("incremental candidate has no full runtime parent")
    options = _query_options(query)
    db_metric = "count" if options["metric"] in {"count", "occurrences"} else options["metric"]
    search_select = "search_text, channel_search_text" if options["q"] else "'' AS search_text, '' AS channel_search_text"
    search_clause = ""
    base_params: list[Any] = [parent[0], options["range"], options["view"], db_metric]
    for token in options["searchTokens"]:
        search_clause += " AND (search_text ILIKE %s OR channel_search_text ILIKE %s)"
        needle = f"%{token}%"
        base_params.extend([needle, needle])
    base_rows = _rows(
        connection,
        f"""
        SELECT rank, detail_key, title, artist, name, row_count, song_count,
               video_count, timestamp_count, {search_select}
        FROM runtime_ranking_rows
        WHERE revision_id = %s AND range_id = %s AND view = %s AND metric = %s
          {search_clause}
        ORDER BY rank
        """,
        base_params,
    )
    groups = { _text(row.get("detail_key")): dict(row) for row in base_rows }
    phase_started = _phase_trace("base", phase_started)
    overlay_ids = _overlay_revision_ids(connection, revision_id, parent[0])
    candidate_rows = _overlay_candidate_rows(connection, overlay_ids, False)
    all_candidate_rows = tuple(candidate_rows)
    phase_started = _phase_trace("overlay", phase_started)
    accepted_video_resets = _accepted_video_resets(
        connection, overlay_ids, False, options["view"] == "vtubers",
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
    reset_changes = _accepted_video_reset_changes(
        connection, parent[0], accepted_video_resets, options,
    )
    runtime_changes_all = _runtime_tombstones(
        connection,
        overlay_ids,
        accepted_video_resets.values() if accepted_video_resets else None,
        all_candidate_rows,
        options["view"] == "vtubers",
    )
    phase_started = _phase_trace("reset", phase_started)
    candidate_rows = _overlay_rows_for_range(candidate_rows, options["range"])
    runtime_changes = _overlay_rows_for_range(runtime_changes_all, options["range"])
    # The exact VTuber query is physical-range scoped.  Do not pass the
    # lineage-wide candidate list: a legacy/all row must not leak into 7d,
    # and a 7d row must not perturb the all aggregate.
    exact_candidate_rows = tuple(candidate_rows)
    # Legacy parent occurrences can lack their denormalised channel fields.
    # Resolve those fields only through the parent runtime-video tuple for the
    # same immutable video.  Accepted resets need the same bounded repair as
    # runtime curation; otherwise exact VTuber coverage rejects a legal
    # historical reset before it can reach the SQL aggregate.
    identity_changes = tuple((*reset_changes, *runtime_changes))
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
                raise PostgresAdapterError("VTuber exact overlay change is missing required immutable identity")
            video_by_id[video_id] = video
        for change in identity_changes:
            change_video_id, existing_channel_id = identity_by_change[id(change)]
            if existing_channel_id:
                continue
            video = video_by_id.get(change_video_id)
            if not video:
                raise PostgresAdapterError("VTuber exact overlay change is missing required immutable identity")
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
    for change in identity_changes:
        change_video_id, channel_id = _validated_overlay_change_identity(
            change, validate_urls=False,
        )
        if channel_id:
            continue
        if not bool(change.get("acceptedVideoReset")):
            raise PostgresAdapterError("VTuber exact overlay change is missing required immutable identity")
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
    _enrich_runtime_original_group_counts(
        connection,
        parent[0],
        candidate_rows,
        [*reset_changes, *runtime_changes],
    )
    # The selected accepted video is a replacement boundary, not another
    # increment.  Remove all parent occurrences for its video before adding
    # the non-tombstone candidate projection below.  A later runtime curation
    # remains in ``runtime_changes`` and is deliberately applied afterwards.
    reset_group_counts: dict[tuple[str, str, str], int] = defaultdict(int)
    for change in reset_changes:
        reset_group_counts[(
            _text(change.get("videoId")),
            _overlay_song_group_norm(change.get("title")),
            _overlay_song_group_norm(change.get("artist")),
        )] += 1
    for change in reset_changes:
        change["originalGroupVideoOccurrenceCount"] = reset_group_counts[(
            _text(change.get("videoId")),
            _overlay_song_group_norm(change.get("title")),
            _overlay_song_group_norm(change.get("artist")),
        )]
    # The VTuber exact aggregate below owns both sides of every reset/move.
    # Applying the bounded generic mutation here would make the caller replay
    # those same tuples after the exact result is installed.
    if options["view"] != "vtubers":
        _apply_runtime_tombstone_groups(groups, reset_changes, options["view"])
        _apply_runtime_change_previews(groups, reset_changes, options["view"])
    replacement_rows = _runtime_replacement_candidate_rows(
        runtime_changes,
        options["view"] == "vtubers",
    )
    exact_replacement_rows = tuple(replacement_rows)
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
    if options["searchTokens"]:
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
        and (exact_candidate_rows or reset_changes or runtime_changes or exact_replacement_rows)
    )
    exact_vtuber_rows = (
        _overlay_vtuber_replacement_rows(
            connection,
            revision_id,
            parent[0],
            exact_candidate_rows,
            options,
            groups,
            reset_changes,
            runtime_changes,
            exact_replacement_rows,
            accepted_video_resets,
            exact_required,
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
            row["search_text"] = f"{row.get('search_text', '')} {item['search']}"
    if options["view"] != "vtubers":
        _apply_runtime_tombstone_groups(groups, runtime_changes, options["view"])
        _apply_runtime_change_previews(groups, runtime_changes, options["view"])
    # Exact VTuber aggregation already owns every affected channel's effective
    # tuple set.  Re-running the generic bounded parent scan here was the
    # cold-ranking timeout; songs/artists/videos keep their existing path.
    if options["view"] != "vtubers" or (exact_required and not exact_owned):
        _reconcile_affected_song_counts(
            connection,
            parent[0],
            all_candidate_rows,
            replacement_rows,
            [*reset_changes, *runtime_changes],
            groups,
            options["view"],
            options,
        )
    phase_started = _phase_trace("reconcile", phase_started)
    filtered = []
    for row in groups.values():
        search = f"{row.get('search_text', '')} {row.get('channel_search_text', '')}".casefold()
        if options["searchTokens"] and not _matches_search_tokens(search, options["searchTokens"]):
            continue
        if _overlay_rank_value(row, options["metric"]) < options["minCount"]:
            continue
        filtered.append(row)
    filtered.sort(key=lambda row: (-_overlay_rank_value(row, options["metric"]), _text(row.get("title") or row.get("name") or row.get("detail_key"))))
    total = len(filtered)
    offset = (options["page"] - 1) * options["pageSize"]
    metadata = _channel_metadata_rows(connection, [revision_id, *overlay_ids, parent[0]]) if options["view"] == "vtubers" else []
    records = []
    for index, row in enumerate(filtered[offset:offset + options["pageSize"]], start=offset + 1):
        payload = _json_object(row.get("payload_json"))
        if not payload:
            stored = _one(
                connection,
                """
                SELECT payload_json FROM runtime_ranking_rows
                WHERE revision_id = %s AND range_id = %s AND view = %s
                  AND metric = %s AND detail_key = %s
                LIMIT 1
                """,
                [parent[0], options["range"], options["view"], db_metric, row.get("detail_key")],
            )
            payload = _json_object(stored.get("payload_json")) if stored else {}
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
    _phase_trace("hydrate", phase_started)
    return {
        "schemaVersion": 1, "rangeId": options["range"], "view": options["view"],
        "metric": "occurrences" if options["metric"] == "count" else options["metric"],
        "searchScope": options["searchScope"], "searchFields": options["searchFields"] or [],
        "page": options["page"], "pageSize": options["pageSize"], "totalCount": total,
        "filteredBaseCount": total, "totalOccurrenceCount": sum(int(row.get("row_count") or 0) for row in filtered),
        "totalSongCount": sum(int(row.get("song_count") or 0) for row in filtered),
        "totalVideoCount": sum(int(row.get("video_count") or 0) for row in filtered),
        "pageCount": max(1, math.ceil(total / options["pageSize"])), "compact": options["compact"], "records": records,
    }


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
            values.append({"rangeId": song_range or range_id, "videoId": item.get("videoId", ""), "item": item, "song": dict(song)})
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
        SELECT o.video_id, o.occurrence_id, o.position, o.range_id, o.song_key,
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
        ORDER BY o.video_id, o.position, o.occurrence_id
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
