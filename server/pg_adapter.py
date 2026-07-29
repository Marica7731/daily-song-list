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
        """,
        params,
    )
    video_ids = [_text(row.get("video_id")) for row in video_rows if _text(row.get("video_id"))]
    if not video_ids:
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
        """,
        [revision_id, video_ids],
    )
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
    if overlay_revision_ids:
        candidate_records = _overlay_channel_records(
            connection, _overlay_candidate_rows(connection, overlay_revision_ids), metadata,
        )
        if candidate_records:
            candidate_video_ids = {_text(record["video"].get("videoId")) for record in candidate_records}
            records = [record for record in records if _text(record["video"].get("videoId")) not in candidate_video_ids]
            records.extend(candidate_records)
    records = _apply_record_overlay(records, _runtime_tombstones(connection, overlay_revision_ids or ()))
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


def _overlay_candidate_rows(connection, revision_ids: Sequence[str]) -> list[dict[str, Any]]:
    """Read only the candidate rows; never resolve the parent occurrence table."""

    rows = _rows(
        connection,
        """
        SELECT o.revision_id, o.video_id, o.occurrence_id, o.position, o.range_id,
               o.song_key, o.seconds, o.title, o.artist, o.source_id,
               o.raw_hash, o.source_system,
               o.payload_json AS occurrence_payload_json,
               v.title AS video_title, v.channel_name, v.channel_id,
               v.channel_handle, v.channel_url, v.published_at,
               v.payload_json AS video_payload_json,
               v.tombstone AS video_tombstone
        FROM migration_occurrence_rows AS o
        LEFT JOIN migration_video_rows AS v
          ON v.revision_id = o.revision_id AND v.video_id = o.video_id
        WHERE o.revision_id = ANY(%s)
        ORDER BY o.video_id, o.position, o.occurrence_key
        """,
        [list(revision_ids)],
    )
    priority = {revision_id: index for index, revision_id in enumerate(revision_ids)}
    rows.sort(key=lambda row: (priority.get(_text(row.get("revision_id")), len(priority)), _text(row.get("video_id")), int(row.get("position") or 0)))
    selected_revision: dict[str, str] = {}
    resolved: list[dict[str, Any]] = []
    for row in rows:
        video_id = _text(row.get("video_id"))
        revision_id = _text(row.get("revision_id"))
        if video_id not in selected_revision:
            selected_revision[video_id] = revision_id
        if selected_revision[video_id] == revision_id:
            resolved.append(row)
    return resolved


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
    revision_ids = sorted({revision_id for revision_id, _ in selected_pairs})
    video_ids = sorted({video_id for _, video_id in selected_pairs})
    video_payloads = {
        (_text(row.get("revision_id")), _text(row.get("video_id"))): _json_object(row.get("payload_json"))
        for row in _rows(
            connection,
            "SELECT revision_id, video_id, payload_json FROM migration_video_rows WHERE revision_id = ANY(%s) AND video_id = ANY(%s)",
            [revision_ids, video_ids],
        )
        if (_text(row.get("revision_id")), _text(row.get("video_id"))) in selected_pairs
    }
    occurrence_payloads = {
        (_text(row.get("revision_id")), _text(row.get("video_id")), _text(row.get("occurrence_id")), int(row.get("position") or 0)): _json_object(row.get("payload_json"))
        for row in _rows(
            connection,
            "SELECT revision_id, video_id, occurrence_id, position, payload_json FROM migration_occurrence_rows WHERE revision_id = ANY(%s) AND video_id = ANY(%s)",
            [revision_ids, video_ids],
        )
        if (_text(row.get("revision_id")), _text(row.get("video_id"))) in selected_pairs
    }
    records: dict[str, dict[str, Any]] = {}
    for row in selected_rows:
        video_id = _text(row.get("video_id"))
        revision_id = _text(row.get("revision_id"))
        record = records.get(video_id)
        if record is None:
            video = video_payloads.get((revision_id, video_id), {})
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
        song = occurrence_payloads.get((revision_id, video_id, _text(row.get("occurrence_id")), int(row.get("position") or 0)), {})
        if isinstance(song.get("payload"), Mapping):
            song = dict(song["payload"])
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
    return _rows(
        connection,
        """
        SELECT revision_id, entity_type, entity_key, source_system, range_id,
               source_id, occurrence_id, tombstone, payload_json
        FROM migration_runtime_rows
        WHERE revision_id = ANY(%s)
        ORDER BY revision_id, entity_type, entity_key
        """,
        [list(revision_ids)],
    )


def _overlay_payload(row: Mapping[str, Any]) -> dict[str, Any]:
    payload = _json_object(row.get("payload_json"))
    if isinstance(payload.get("payload"), Mapping):
        payload = dict(payload["payload"])
    return payload


def _runtime_tombstones(connection, revision_ids: Sequence[str]) -> list[dict[str, Any]]:
    """Return conservative occurrence/video tombstones from overlay rows."""

    changes_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for row in _overlay_runtime_rows(connection, revision_ids):
        if not row.get("tombstone"):
            continue
        entity_type = _text(row.get("entity_type"))
        if entity_type not in {"occurrences", "runtime_occurrences", "videos", "runtime_videos"}:
            continue
        payload = _overlay_payload(row)
        payload.setdefault("occurrenceId", row.get("occurrence_id"))
        payload.setdefault("sourceId", row.get("source_id"))
        payload.setdefault("sourceSystem", row.get("source_system"))
        payload.setdefault("rangeId", row.get("range_id"))
        payload.setdefault("entityKey", row.get("entity_key"))
        payload["entityType"] = entity_type
        identity = _text(payload.get("occurrenceId") or payload.get("entityKey") or payload.get("videoId"))
        if identity:
            changes_by_key[(_text(payload.get("entityType")), identity)] = payload
    return list(changes_by_key.values())


def _source_overlay_match(item: Mapping[str, Any], change: Mapping[str, Any]) -> bool:
    target_video = _text(change.get("videoId") or change.get("video_id"))
    item_video = _text(item.get("youtubeVideoId") or item.get("videoId") or item.get("externalVideoId"))
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
            result.pop(matches[0])
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
    for change in changes:
        if _text(change.get("entityType")) not in {"occurrences", "runtime_occurrences"}:
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
                matched = bool(target_title and target_artist and row_title == target_title and row_artist == target_artist)
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
            if row["row_count"] == 0:
                groups.pop(key, None)
                continue
            payload = _json_object(row.get("payload_json"))
            payload.update({"count": row["row_count"], "timestampCount": row["timestamp_count"]})
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


def _overlay_candidate_groups(rows: Iterable[Mapping[str, Any]], view: str) -> dict[str, dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row.get("video_tombstone"):
            continue
        occurrence = _json_object(row.get("occurrence_payload_json"))
        video = _json_object(row.get("video_payload_json"))
        title = _text(row.get("title")) or _text(occurrence.get("title"))
        artist = _text(row.get("artist")) or _text(occurrence.get("artist"))
        video_id = _text(row.get("video_id"))
        video.update({
            "videoId": video.get("videoId") or video_id,
            "title": video.get("title") or row.get("video_title"),
            "channelName": video.get("channelName") or row.get("channel_name"),
            "channelId": video.get("channelId") or row.get("channel_id"),
            "channelHandle": video.get("channelHandle") or row.get("channel_handle"),
            "channelUrl": video.get("channelUrl") or row.get("channel_url"),
            "publishedAt": video.get("publishedAt") or row.get("published_at"),
        })
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
            "occurrences": [], "videoIds": set(), "songKeys": set(),
            "search": "",
        })
        group["occurrences"].append({
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
        })
        group["videoIds"].add(video_id)
        group["songKeys"].add(_text(occurrence.get("songKey")) or key)
        group["search"] = f"{group['search']} {_overlay_candidate_search_text(row)}".strip()
    return groups


def _overlay_rank_value(row: Mapping[str, Any], metric: str) -> int:
    if metric == "videos":
        return int(row.get("video_count") or 0)
    if metric == "songs":
        return int(row.get("song_count") or 0)
    return int(row.get("row_count") or 0)


def _generic_overlay_rankings_payload(connection, revision_id: str, revision: Mapping[str, Any], query: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Return bounded candidate rankings from parent aggregates plus delta rows."""

    parent = _generic_parent_runtime_revision(connection, revision_id, revision)
    if not parent:
        raise PostgresAdapterError("incremental candidate has no full runtime parent")
    options = _query_options(query)
    db_metric = "count" if options["metric"] in {"count", "occurrences"} else options["metric"]
    search_select = "search_text, channel_search_text" if options["q"] or options["view"] == "vtubers" else "'' AS search_text, '' AS channel_search_text"
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
    overlay_ids = _overlay_revision_ids(connection, revision_id, parent[0])
    candidate_rows = _overlay_candidate_rows(connection, overlay_ids)
    if options["searchTokens"]:
        candidate_rows = [
            row for row in candidate_rows
            if _matches_search_tokens(_overlay_candidate_search_text(row), options["searchTokens"])
        ]
    delta = _overlay_candidate_groups(candidate_rows, options["view"])
    for key, item in delta.items():
        row = groups.get(key)
        if row is None:
            count = len(item["occurrences"])
            video_count = len(item["videoIds"])
            song_count = len(item["songKeys"])
            payload = {
                "type": "video" if options["view"] == "videos" else "artist" if options["view"] == "artists" else "vtuber" if options["view"] == "vtubers" else "song",
                "key": key, "title": item["title"], "displayArtist": item["artist"],
                "name": item["name"], "count": count, "videoCount": video_count,
                "songCount": song_count, "timestampCount": count,
                "occurrences": item["occurrences"][:20],
            }
            row = {"detail_key": key, "title": item["title"], "artist": item["artist"], "name": item["name"], "row_count": count, "song_count": song_count, "video_count": video_count, "timestamp_count": count, "payload_json": payload, "search_text": item["search"], "channel_search_text": item["search"]}
            groups[key] = row
        else:
            row["row_count"] = int(row.get("row_count") or 0) + len(item["occurrences"])
            row["song_count"] = int(row.get("song_count") or 0) + len(item["songKeys"])
            row["video_count"] = int(row.get("video_count") or 0) + len(item["videoIds"])
            row["timestamp_count"] = int(row.get("timestamp_count") or 0) + len(item["occurrences"])
            payload = _json_object(row.get("payload_json"))
            if payload:
                payload.update({"count": row["row_count"], "songCount": row["song_count"], "videoCount": row["video_count"], "timestampCount": row["timestamp_count"]})
                if isinstance(payload.get("occurrences"), list):
                    payload["occurrences"] = (payload["occurrences"] + item["occurrences"])[:20]
                row["payload_json"] = payload
            row["search_text"] = f"{row.get('search_text', '')} {item['search']}"
    runtime_changes = _runtime_tombstones(connection, overlay_ids)
    video_ids = {
        _text(change.get("videoId") or change.get("video_id"))
        for change in runtime_changes
        if _text(change.get("videoId") or change.get("video_id"))
    }
    if video_ids:
        video_rows = _rows(
            connection,
            "SELECT video_id, channel_name, channel_id, channel_handle FROM runtime_videos WHERE revision_id = %s AND video_id = ANY(%s)",
            [parent[0], list(video_ids)],
        )
        video_by_id = {_text(row.get("video_id")): row for row in video_rows}
        for change in runtime_changes:
            video = video_by_id.get(_text(change.get("videoId") or change.get("video_id")))
            if video:
                for name in ("channel_name", "channel_id", "channel_handle"):
                    change.setdefault(name, video.get(name))
    _apply_runtime_tombstone_groups(groups, runtime_changes, options["view"])
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
        if range_id == "all" or song_range in {range_id, ""}:
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
        source_key = _stable_key("source-video", range_id, group["key"])
        payload = {
            **video, "type": "video", "key": group["key"], "videoId": group["key"],
            "count": count, "songCount": len(songs), "timestampCount": count,
            "songs": [dict(row["song"]) for row in occurrences], "occurrences": occurrences,
            "sourceDetailKey": source_key,
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
        """,
        [revision_id, key, range_id],
    )
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
        record["count"] = len(occurrences)
        record["occurrenceCount"] = len(occurrences)
        record["timestampCount"] = len(occurrences)
        record["videoCount"] = len(video_keys)
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
                record["count"] = len(occurrences)
                record["occurrenceCount"] = len(occurrences)
                record["timestampCount"] = len(occurrences)
                record["videoCount"] = len(video_keys - {""})
                record["occurrencePreviewLimited"] = len(previews) < len(occurrences)
    if overlay_changes and isinstance(record.get("occurrences"), list):
        record = dict(record)
        record["occurrences"] = _apply_source_overlay(record["occurrences"], overlay_changes)
        record["count"] = len(record["occurrences"])
        record["occurrenceCount"] = len(record["occurrences"])
        record["timestampCount"] = len(record["occurrences"])
    return {"schemaVersion": 1, "found": True, "sourceKey": key, "record": record}


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
                return persisted
            resolved_key = _runtime_source_key_for_channel_alias(connection, parent[0], key)
            if resolved_key:
                persisted = _runtime_source_payload(connection, parent[0], resolved_key, query, allow_derived=False, overlay_revision_ids=overlay_ids)
                if persisted.get("found"):
                    persisted_record = persisted.get("record") if isinstance(persisted.get("record"), Mapping) else {}
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
                    return persisted
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
        delta_rows = _overlay_candidate_rows(connection, overlay_ids)
        if delta_rows:
            counts["videos"] = counts.get("videos", 0) + len({_text(row.get("video_id")) for row in delta_rows})
            counts["occurrences"] = counts.get("occurrences", 0) + len(delta_rows)
            candidate_song_keys = {_text(row.get("song_key")) for row in delta_rows if _text(row.get("song_key"))}
            if candidate_song_keys:
                existing_song_rows = _rows(
                    connection,
                    "SELECT song_key FROM runtime_songs WHERE revision_id = %s AND song_key = ANY(%s)",
                    [parent_id, list(candidate_song_keys)],
                )
                existing_song_keys = {_text(row.get("song_key")) for row in existing_song_rows}
                counts["songs"] = counts.get("songs", 0) + len(candidate_song_keys - existing_song_keys)
        runtime_changes = _runtime_tombstones(connection, overlay_ids)
        occurrence_ids = [
            _text(change.get("occurrenceId") or change.get("occurrence_id"))
            for change in runtime_changes
            if _text(change.get("entityType")) in {"occurrences", "runtime_occurrences"}
            and _text(change.get("occurrenceId") or change.get("occurrence_id"))
        ]
        if occurrence_ids:
            base_occurrence_rows = _rows(
                connection,
                "SELECT occurrence_id, song_key, video_id, seconds FROM runtime_occurrences WHERE revision_id = %s AND occurrence_id = ANY(%s)",
                [parent_id, occurrence_ids],
            )
            base_by_id = {_text(row.get("occurrence_id")): row for row in base_occurrence_rows}
            for change in runtime_changes:
                occurrence_id = _text(change.get("occurrenceId") or change.get("occurrence_id"))
                base_row = base_by_id.get(occurrence_id)
                if not base_row:
                    continue
                counts["occurrences"] = max(0, counts.get("occurrences", 0) - 1)
                song_key = _text(base_row.get("song_key"))
                if song_key:
                    song_count = _rows(
                        connection,
                        "SELECT count(*) AS count FROM runtime_occurrences WHERE revision_id = %s AND song_key = %s",
                        [parent_id, song_key],
                    )
                    if song_count and int(song_count[0].get("count") or 0) == 1:
                        counts["songs"] = max(0, counts.get("songs", 0) - 1)
                # source_occurrences is a denormalized, multi-source index;
                # never scan it from health/meta.  Its materialized baseline
                # remains authoritative until a source-detail rebuild.
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
