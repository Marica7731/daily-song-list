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
        state = _one(connection, "SELECT state_value FROM migration_state WHERE state_key = 'active_revision_id'")
        revision_id = _text(state.get("state_value")) if state else ""
        if not revision_id:
            return None
        revision = _one(
            connection,
            "SELECT revision_id, parent_revision_id, status, manifest_json, source_manifest_sha256, content_sha256, activated_at, created_at FROM migration_revisions WHERE revision_id = %s",
            [revision_id],
        )
        if not revision or not _json_object(revision.get("manifest_json")).get("runtimeProjection"):
            return None
        return revision_id, revision
    except Exception:
        # Prototype/test doubles and pre-projection databases remain supported.
        return None


def _generic_runtime_projection_revision(connection) -> tuple[str, dict[str, Any]] | None:
    """Return a revision backed by the incremental generic runtime overlay."""

    try:
        state = _one(connection, "SELECT state_value FROM migration_state WHERE state_key = 'active_revision_id'")
        revision_id = _text(state.get("state_value")) if state else ""
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
        if manifest.get("runtimeProjection") is not True:
            return None
        return revision_id, revision
    except Exception:
        return None


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


def _runtime_payload_field(payload: Mapping[str, Any], row: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in payload:
            return payload[name]
        if name in row:
            return row[name]
    return None


def _load_generic_runtime_snapshot(connection, revision_id: str, revision: Mapping[str, Any]) -> _Snapshot:
    """Resolve video/occurrence rows from the incremental runtime overlay."""

    rows_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for revision_key in _revision_lineage(connection, revision_id):
        rows = _rows(
            connection,
            """
            SELECT entity_type, entity_key, source_system, range_id, source_id,
                   occurrence_id, tombstone, payload_json
            FROM migration_runtime_rows
            WHERE revision_id = %s ORDER BY entity_type, entity_key
            """,
            [revision_key],
        )
        for row in rows:
            key = (_text(row.get("entity_type")), _text(row.get("entity_key")))
            if key not in rows_by_key:
                rows_by_key[key] = row

    videos: dict[str, dict[str, Any]] = {}
    occurrences: dict[str, list[dict[str, Any]]] = defaultdict(list)
    positions: dict[str, int] = defaultdict(int)
    for row in rows_by_key.values():
        if row.get("tombstone"):
            continue
        entity_type = _text(row.get("entity_type"))
        payload = _json_object(row.get("payload_json"))
        if isinstance(payload.get("payload"), Mapping):
            payload = dict(payload["payload"])
        if entity_type in {"videos", "runtime_videos"}:
            video_id = _text(_runtime_payload_field(payload, row, "videoId", "video_id"))
            if not video_id:
                continue
            payload.update({
                "videoId": video_id,
                "title": _runtime_payload_field(payload, row, "title"),
                "channelName": _runtime_payload_field(payload, row, "channelName", "channel_name"),
                "channelId": _runtime_payload_field(payload, row, "channelId", "channel_id"),
                "channelHandle": _runtime_payload_field(payload, row, "channelHandle", "channel_handle"),
                "channelUrl": _runtime_payload_field(payload, row, "channelUrl", "channel_url"),
                "publishedAt": _runtime_payload_field(payload, row, "publishedAt", "published_at", "published_timestamp"),
            })
            videos[video_id] = payload
        elif entity_type in {"occurrences", "runtime_occurrences"}:
            video_id = _text(_runtime_payload_field(payload, row, "videoId", "video_id"))
            if not video_id:
                continue
            position = _runtime_payload_field(payload, row, "position")
            try:
                position = int(position)
            except (TypeError, ValueError):
                position = positions[video_id]
            positions[video_id] = max(positions[video_id], position + 1)
            payload.update({
                "occurrenceId": _runtime_payload_field(payload, row, "occurrenceId", "occurrence_id"),
                "position": position,
                "rangeId": _runtime_payload_field(payload, row, "rangeId", "range_id"),
                "songKey": _runtime_payload_field(payload, row, "songKey", "song_key"),
                "seconds": _runtime_payload_field(payload, row, "seconds"),
                "title": _runtime_payload_field(payload, row, "title"),
                "artist": _runtime_payload_field(payload, row, "artist"),
                "sourceId": _runtime_payload_field(payload, row, "sourceId", "source_id"),
                "sourceSystem": _runtime_payload_field(payload, row, "sourceSystem", "source_system"),
            })
            occurrences[video_id].append(payload)

    records = tuple(
        {"video": video, "occurrences": tuple(sorted(occurrences.get(video_id, []), key=lambda item: (int(item.get("position") or 0), _text(item.get("occurrenceId")))))}
        for video_id, video in sorted(videos.items())
    )
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
    if options["q"]:
        needle = options["q"]
        rows = [row for row in rows if needle in (_text(row.get("search_text")) + " " + _text(row.get("channel_search_text"))).casefold()]
    rows = [row for row in rows if int(row.get("row_count") or 0) >= options["minCount"]]
    total_occurrences = sum(int(row.get("row_count") or 0) for row in rows)
    total_songs = sum(int(row.get("song_count") or 0) for row in rows)
    total_videos = sum(int(row.get("video_count") or 0) for row in rows)
    page_count = max(1, math.ceil(len(rows) / options["pageSize"]))
    offset = (options["page"] - 1) * options["pageSize"]
    records = []
    for row in rows[offset : offset + options["pageSize"]]:
        payload = _json_object(row.get("payload_json"))
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


def _runtime_source_payload(connection, revision_id: str, key: str, query: Mapping[str, Any] | None = None) -> dict[str, Any]:
    rows = _rows(
        connection,
        "SELECT payload_json FROM runtime_source_details WHERE revision_id = %s AND source_key = %s",
        [revision_id, key],
    )
    if not rows:
        return {"schemaVersion": 1, "found": False, "sourceKey": key}
    record = _json_object(rows[0].get("payload_json"))
    query = query or {}
    if any(field in query for field in ("page", "pageSize")) and isinstance(record.get("occurrences"), list):
        options = _query_options(query)
        occurrences = list(record["occurrences"])
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
        record["timestampCount"] = len(occurrences)
        record["videoCount"] = len(video_keys)
        return {
            "schemaVersion": 1, "found": True, "sourceKey": key, "record": record,
            "page": page, "pageSize": options["pageSize"], "pageCount": page_count,
            "totalCount": len(video_keys), "totalVideoCount": len(video_keys),
            "totalOccurrenceCount": len(occurrences),
        }
    return {"schemaVersion": 1, "found": True, "sourceKey": key, "record": record}


def rankings_payload(connection, query: Mapping[str, Any] | None = None) -> dict[str, Any]:
    runtime = _runtime_projection_revision(connection)
    if runtime:
        return _runtime_rankings_payload(connection, runtime[0], query)
    snapshot = _load_snapshot(connection)
    return rankings_payload_from_records(snapshot.records, query)


def source_payload(connection, key: str, query: Mapping[str, Any] | None = None) -> dict[str, Any]:
    runtime = _runtime_projection_revision(connection)
    if runtime:
        return _runtime_source_payload(connection, runtime[0], key, query)
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
        meta.update({str(key): _jsonable(value) for key, value in manifest.items() if key not in meta and isinstance(value, (str, int, float, bool)) or value is None})
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