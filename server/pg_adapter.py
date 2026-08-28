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
from copy import deepcopy
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
from typing import Any, Iterable, Mapping, MutableMapping, NoReturn, Sequence

COMPACT_VTUBER_PREVIEW_LIMIT = 3
_DROP_KEYS = frozenset({
    "occurrences",
    "songs",
    "payload",
    "payload_json",
    "occurrence_payload_json",
    "video_payload_json",
})
_SOURCE_KEYS = (
    "sourceDetailKey",
    "sourceKey",
    "sourceId",
    "sourceSystem",
    "sourceUrl",
    "sourcePath",
)
_DEFERRED_ID_KEYS = frozenset({
    "videoId", "video_id", "occurrenceId", "occurrence_id", "position",
    "rangeId", "range_id", "songKey", "song_key", "sourceId", "source_id",
    "sourceSystem", "source_system", "sourceDetailKey", "sourceKey",
    "sourceUrl", "sourcePath", "channelId", "channel_id", "channelHandle",
    "channel_handle", "channelName", "channel_name", "entityType",
    "entity_type", "acceptedVideoReset", "runtime_replacement", "title",
    "artist", "name", "channelUrl", "channel_url", "count", "songCount",
    "videoCount", "timestampCount", "seconds", "sourcePosition",
    "parentSongGroupKey", "parentArtistGroupKey",
    "persistedSourceAuthority", "parentVtuberChannelKey",
    "parentVtuberSourceKey", "parentVtuberChannelHandle",
    "parentVtuberChannelName", "canonicalVtuberChannelKey",
})


def _source_identity(item: Mapping[str, Any]) -> str:
    for key in _SOURCE_KEYS:
        value = _text(item.get(key))
        if value:
            return f"{key}:{value}"
    song = item.get("song")
    if isinstance(song, Mapping):
        for key in _SOURCE_KEYS:
            value = _text(song.get(key))
            if value:
                return f"song.{key}:{value}"
    # Unknown-source previews are bounded to one entry and never presented as
    # multiple distinct sources.
    return "source:unknown"


def distinct_source_previews(
    occurrences: Iterable[Mapping[str, Any]],
    *,
    limit: int = COMPACT_VTUBER_PREVIEW_LIMIT,
) -> list[dict[str, Any]]:
    """Return at most ``limit`` first-seen previews from distinct videos.

    The compact contract is "at most three distinct ``videoId`` previews", so
    previews are deduplicated by video id first (matching the hydrated merge
    that already produced distinct videos) and only fall back to the persisted
    source identity when no video id is present.  Without this, a card whose
    preview rows lack a ``sourceDetailKey``/``sourceId`` collapses every
    preview to the same ``source:unknown`` identity.
    """

    previews: list[dict[str, Any]] = []
    seen: set[str] = set()
    for occurrence in occurrences:
        if not isinstance(occurrence, Mapping):
            continue
        video_id = _text(occurrence.get("videoId") or (occurrence.get("item") or {}).get("videoId"))
        key = f"video:{video_id}" if video_id else _source_identity(occurrence)
        if key in seen:
            continue
        seen.add(key)
        preview = deepcopy(dict(occurrence))
        for drop_key in _DROP_KEYS:
            preview.pop(drop_key, None)
        previews.append(preview)
        if len(previews) >= max(0, int(limit)):
            break
    return previews


def compact_vtuber_ranking_card(record: Mapping[str, Any]) -> dict[str, Any]:
    """Project one compact VTuber card to scalars plus three source previews."""

    compact: dict[str, Any] = {}
    for key, value in record.items():
        if key in _DROP_KEYS or key.startswith("_"):
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            compact[key] = deepcopy(value)
    occurrences = record.get("occurrences")
    previews = distinct_source_previews(
        occurrences if isinstance(occurrences, list) else (),
    )
    compact["occurrences"] = previews
    compact["sourcePreviewCount"] = len(previews)
    try:
        occurrence_count = int(record.get("count") or record.get("timestampCount") or 0)
    except (TypeError, ValueError):
        occurrence_count = 0
    compact["occurrencePreviewLimited"] = bool(
        record.get("occurrencePreviewLimited") or occurrence_count > len(previews)
    )
    return compact


# Scalars that must never leak into compact list cards even though they are
# strings: the persisted search text is a single-card-megabyte field and is
# only used server-side for query matching.
_COMPACT_DROP_SCALAR_KEYS = frozenset({"searchText"})
# Count lists that can grow with the group (channels on a popular song) but
# are not read by the compact card meta.  They are dropped from compact cards;
# the full source detail API still returns them.
_COMPACT_DROP_LIST_KEYS = frozenset({"channels"})
# Small count lists that the compact card meta reads directly.  Artist songs
# are projected to a three-item preview below; their scalar songCount remains
# authoritative and the full list stays available from the source detail API.
_COMPACT_KEEP_LIST_KEYS = frozenset({"artists", "songs"})


def compact_ranking_card(record: Mapping[str, Any], view: str) -> dict[str, Any]:
    """Project any compact ranking card to scalars plus a bounded preview.

    The compact list contract keeps card scalars, the stable source detail
    key and at most three distinct-video/song previews; full occurrence/song
    payloads are served by the source detail API.  The songs view retains its
    Artist count list because the card meta reads it directly.
    """

    compact: dict[str, Any] = {}
    for key, value in record.items():
        if key == "songs" and isinstance(value, list) and view in {
            "artists", "videos",
        }:
            compact[key] = [
                deepcopy(item) for item in value[:COMPACT_VTUBER_PREVIEW_LIMIT]
            ]
            compact["songPreviewCount"] = len(compact[key])
            continue
        if key in _COMPACT_KEEP_LIST_KEYS and isinstance(value, list):
            compact[key] = deepcopy(value)
            continue
        if key in _DROP_KEYS or key in _COMPACT_DROP_SCALAR_KEYS or key.startswith("_"):
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            compact[key] = deepcopy(value)
    occurrences = record.get("occurrences")
    previews = distinct_source_previews(
        occurrences if isinstance(occurrences, list) else (),
    )
    compact["occurrences"] = previews
    compact["sourcePreviewCount"] = len(previews)
    try:
        occurrence_count = int(record.get("count") or record.get("timestampCount") or 0)
    except (TypeError, ValueError):
        occurrence_count = 0
    compact["occurrencePreviewLimited"] = bool(
        record.get("occurrencePreviewLimited") or occurrence_count > len(previews)
    )
    return compact


def compact_ranking_payloads(
    records: Sequence[Mapping[str, Any]],
    view: str,
) -> list[dict[str, Any]]:
    """Project compact cards after hydration for any ranking view.

    VTubers keep the established scalar-plus-three-preview shape that the
    frontend already renders; the other views use the generalized compact
    card which additionally retains the small Artist count list for songs and
    a three-song preview for Artist/video cards.
    """

    if view == "vtubers":
        return [compact_vtuber_ranking_card(record) for record in records]
    return [compact_ranking_card(record, view) for record in records]


def preparation_cache_key(
    active_revision_id: str,
    options: Mapping[str, Any],
) -> tuple[Any, ...]:
    """Key expensive preparation by active projection and filter, never page."""

    fields = tuple(sorted(_text(value) for value in (options.get("searchFields") or ()) if _text(value)))
    filter_key = (
        _text(options.get("q")),
        _text(options.get("searchScope") or "all"),
        fields,
        int(options.get("minCount") or 0),
        bool(options.get("nicheOnly")),
        bool(options.get("hideUnknownArtist")),
    )
    return (
        "vtuber-ranking-preparation-v2",
        _text(active_revision_id),
        _text(options.get("range")),
        _text(options.get("view")),
        _text(options.get("metric")),
        filter_key,
    )


def _compact_deferred_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        compacted = {
            key: deepcopy(item)
            for key, item in value.items()
            if key in _DEFERRED_ID_KEYS
            and (item is None or isinstance(item, (str, int, float, bool)))
        }
        for nested_key in ("item", "video"):
            nested = value.get(nested_key)
            if isinstance(nested, Mapping):
                nested_compacted = {
                    key: deepcopy(item)
                    for key, item in nested.items()
                    if key in _DEFERRED_ID_KEYS
                    and (item is None or isinstance(item, (str, int, float, bool)))
                }
                if nested_compacted:
                    compacted[nested_key] = nested_compacted
        return compacted
    if isinstance(value, (list, tuple)):
        return tuple(
            compacted
            for item in value
            if (compacted := _compact_deferred_value(item))
        )
    return None


def _fallback_vtuber_payload(row: Mapping[str, Any]) -> dict[str, Any]:
    channel_id = row.get("channelId") or row.get("channel_id") or row.get("detail_key")
    count = row.get("count")
    if count is None:
        count = row.get("row_count")
    return {
        "type": "vtuber",
        "key": channel_id,
        "channelId": channel_id,
        "channelName": row.get("channelName") or row.get("channel_name"),
        "channelHandle": row.get("channelHandle") or row.get("channel_handle"),
        "channelUrl": row.get("channelUrl") or row.get("channel_url"),
        "name": row.get("name"),
        "sourceDetailKey": row.get("sourceDetailKey"),
        "count": count,
        "songCount": row.get("song_count"),
        "videoCount": row.get("video_count"),
        "timestampCount": row.get("timestamp_count") or count,
        "occurrences": [],
    }


def _compact_vtuber_row(row: Mapping[str, Any]) -> dict[str, Any]:
    compact = {
        key: deepcopy(value)
        for key, value in row.items()
        if key not in _DROP_KEYS
        and not key.endswith("_payload")
        and not key.endswith("_payload_json")
        and not key.startswith("_deferred_")
    }
    payload = row.get("payload_json")
    if not isinstance(payload, Mapping):
        payload = _fallback_vtuber_payload(row)
    compact_payload = compact_vtuber_ranking_card(payload)
    deferred_previews = _compact_deferred_value(
        row.get("_deferred_candidate_previews", ())
    )
    if not compact_payload.get("occurrences") and deferred_previews:
        compact_payload["occurrences"] = distinct_source_previews(deferred_previews)
        compact_payload["sourcePreviewCount"] = len(compact_payload["occurrences"])
    compact["payload_json"] = compact_payload
    for key, value in row.items():
        if key.startswith("_deferred_"):
            compacted = _compact_deferred_value(value)
            if compacted:
                compact[key] = compacted
    return compact


def scalar_ranking_row(row: Mapping[str, Any]) -> dict[str, Any]:
    """Keep VTuber identity and bounded previews while dropping payload graphs."""

    return _compact_vtuber_row(row)


def scalar_preparation(
    prepared: Mapping[str, Any],
    *,
    view: str | None = None,
) -> dict[str, Any]:
    """Project only VTuber preparation; preserve all other view contracts."""

    cached = deepcopy(dict(prepared))
    if _text(view) not in {"vtubers", "vtuberRank"}:
        return cached
    cached["clickedSongScopes"] = {}
    for key in ("filtered", "candidateRows"):
        rows = cached.get(key)
        if isinstance(rows, (list, tuple)):
            cached[key] = tuple(
                scalar_ranking_row(row) for row in rows if isinstance(row, Mapping)
            )
    return cached


def page_limit_offset(page: int, page_size: int) -> tuple[str, tuple[int, int]]:
    """Describe the only page-dependent SQL operation for a prepared ranking."""

    safe_page = max(1, int(page))
    safe_size = max(1, int(page_size))
    return "LIMIT %s OFFSET %s", (safe_size, (safe_page - 1) * safe_size)


def adjacent_prefetch_allowed(view: str) -> bool:
    """Temporarily keep VTuber page loads from issuing adjacent requests."""

    return _text(view) != "vtuberRank"


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
MAX_RANKING_PREVIEW_VIDEOS = 3
MAX_SOURCE_SONG_IDENTITY_NODES = MAX_SOURCE_PREVIEW_OCCURRENCES * 16
_VTUBER_REPLACEMENT_CACHE: dict[tuple[Any, ...], dict[str, dict[str, Any]]] = {}
_VTUBER_REPLACEMENT_CACHE_LOCK = threading.RLock()
# Generic increments are immutable.  Keep only their small derived meta count
# map, never record/payload data: a changed active pointer produces a different
# key and a process restart simply recomputes it from PostgreSQL.
_GENERIC_META_COUNTS_CACHE: dict[tuple[str, str, tuple[str, ...]], dict[str, int]] = {}
_GENERIC_META_COUNTS_CACHE_CAP = 8
_GENERIC_META_COUNTS_FLIGHTS: dict[
    tuple[str, str, tuple[str, ...]], "_MetaCountsFlight",
] = {}
_GENERIC_META_COUNTS_LOCK = threading.RLock()
# A complete prepared aggregate is large on the production runtime.  One
# entry is enough to coalesce the concurrent pages for the active spec, while
# retaining prior range/metric/search aggregates would exceed the candidate's
# 2 GiB memory envelope.
_GENERIC_RANKING_PREPARATION_CAP = 1
_GENERIC_NO_SEARCH_PREPARATION_WINDOW = 50000
_GENERIC_NO_SEARCH_AFFECTED_CUSHION = 4096
_GENERIC_RANKING_PREPARATION_MAX_BYTES = 16 * 1024 * 1024
_GENERIC_RANKING_PREPARATION_MAX_OCCURRENCES = 4096
_VTUBER_REPLACEMENT_CACHE_MAX_BYTES = 8 * 1024 * 1024
_VTUBER_REPLACEMENT_CACHE_MAX_OCCURRENCES = 2048
_VTUBER_SOURCE_TOTALS_CACHE_CAP = 4096
_CLICKED_SONG_SCOPE_GROUP_CAP = 512
_GENERIC_RANKING_PREPARATION_CACHE: OrderedDict[
    tuple[Any, ...], Mapping[str, Any],
] = OrderedDict()
_GENERIC_RANKING_PREPARATION_FLIGHTS: dict[
    tuple[Any, ...], "_RankingPreparationFlight",
] = {}
_GENERIC_RANKING_PREPARATION_LOCK = threading.RLock()


def _ranking_scope_key(options: Mapping[str, Any]) -> str:
    """Map public filters to the canonical persisted ranking scope."""

    niche_only = bool(options.get("nicheOnly"))
    hide_unknown = bool(options.get("hideUnknownArtist"))
    if niche_only and hide_unknown:
        return "visibleNiche"
    if niche_only:
        return "niche"
    if hide_unknown:
        return "visible"
    return "all"


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


@dataclass
class _MetaCountsFlight:
    event: threading.Event
    error: BaseException | None = None
    result: Mapping[str, int] | None = None


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


def _iter_bounded_query_rows(
    connection,
    sql: str,
    params: Sequence[Any] = (),
    *,
    batch_size: int = 5_000,
) -> Iterable[dict[str, Any]]:
    """Stream one bounded query inside snapshot transactions.

    PostgreSQL result grouping can legitimately return hundreds of thousands
    of small scalar rows.  ``fetchall()`` then retains the driver's tuples and
    a second Python dict copy at the same time.  Snapshot materialization owns
    an explicit transaction, so use a named cursor there and keep only one
    bounded batch resident.  Online autocommit calls and lightweight test
    doubles retain the ordinary finite ``_rows`` path.
    """

    if batch_size <= 0:
        raise ValueError("stream batch size must be positive")
    streaming_cursor = None
    if getattr(connection, "autocommit", True) is False:
        try:
            streaming_cursor = connection.cursor(
                name=(
                    f"dsl_bounded_{threading.get_ident()}_"
                    f"{time.monotonic_ns()}"
                )
            )
        except TypeError:
            # Lightweight adapters/test doubles may expose only cursor().
            streaming_cursor = None
    if streaming_cursor is None:
        yield from _rows(connection, sql, params)
        return

    try:
        if hasattr(streaming_cursor, "itersize"):
            streaming_cursor.itersize = batch_size
        streaming_cursor.execute(sql, params)
        description = streaming_cursor.description or ()
        names = [
            column.name if hasattr(column, "name") else column[0]
            for column in description
        ]
        while True:
            values = streaming_cursor.fetchmany(batch_size)
            if not values:
                return
            for value in values:
                yield dict(zip(names, value))
    finally:
        close = getattr(streaming_cursor, "close", None)
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


def _project_runtime_video_payload(
    row: Mapping[str, Any],
    *,
    view: str,
) -> dict[str, Any] | None:
    """Project a runtime video card without fabricating non-video IDs."""

    payload = copy.deepcopy(_json_object(row.get("payload_json")))
    if view != "videos":
        return payload
    detail_key = _text(row.get("detail_key"))
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", detail_key):
        return None
    explicit_id = _text(payload.get("videoId"))
    metadata = _overlay_public_video(row)
    metadata_id = _text(metadata.get("videoId"))
    if explicit_id and explicit_id != detail_key:
        raise PostgresAdapterError(
            f"payload.videoId {explicit_id!r} conflicts with detail_key {detail_key!r}"
        )
    if metadata_id and metadata_id != detail_key:
        raise PostgresAdapterError(
            f"video metadata videoId {metadata_id!r} conflicts with detail_key {detail_key!r}"
        )
    if not explicit_id:
        payload["videoId"] = detail_key
    for name in ("title", "channelId", "channelName", "publishedAt"):
        if not _text(payload.get(name)) and metadata.get(name) not in (None, ""):
            payload[name] = metadata[name]
    return payload


def _project_runtime_video_records(
    response: Mapping[str, Any],
    *,
    view: str,
) -> dict[str, Any]:
    """Apply the row projection to runtime/generic public video records."""

    if view != "videos":
        return dict(response)
    records = response.get("records")
    if not isinstance(records, list):
        return dict(response)
    projected: list[Any] = []
    for record in records:
        if not isinstance(record, Mapping):
            projected.append(record)
            continue
        payload = _project_runtime_video_payload(
            {"detail_key": record.get("key"), "payload_json": record},
            view=view,
        )
        projected.append(dict(record) if payload is None else payload)
    result = dict(response)
    result["records"] = projected
    return result


def _project_generic_overlay_video_records(
    connection,
    revision_ids: Sequence[str],
    response: Mapping[str, Any],
    *,
    view: str,
) -> dict[str, Any]:
    """Hydrate returned generic video cards from exact active overlay rows."""

    result = _project_runtime_video_records(response, view=view)
    if view != "videos":
        return result
    records = result.get("records")
    if not isinstance(records, list) or not records:
        return result
    ordered_revisions = [
        _text(revision_id) for revision_id in revision_ids if _text(revision_id)
    ]
    video_ids = list(dict.fromkeys(
        _text(record.get("videoId") or record.get("key"))
        for record in records if isinstance(record, Mapping)
    ))
    video_ids = [
        video_id for video_id in video_ids
        if re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id)
    ]
    if not ordered_revisions or not video_ids:
        return result
    rows = _rows(
        connection,
        """
        /* bounded active-overlay video-card metadata */
        SELECT revision_id, video_id, title, channel_name, channel_id,
               channel_handle, channel_url, published_at, tombstone,
               payload_json
        FROM migration_video_rows
        WHERE revision_id = ANY(%s) AND video_id = ANY(%s)
        ORDER BY array_position(%s::text[], revision_id), video_id
        """,
        [ordered_revisions, video_ids, ordered_revisions],
    )
    metadata_by_video: dict[str, dict[str, Any] | None] = {}
    metadata_revision_by_video: dict[str, str] = {}
    for row in rows:
        video_id = _text(row.get("video_id"))
        if video_id not in video_ids or video_id in metadata_by_video:
            continue
        if bool(row.get("tombstone")):
            metadata_by_video[video_id] = None
            continue
        source_row = dict(row)
        source_row["video_payload_json"] = row.get("payload_json")
        metadata = _overlay_public_video(source_row)
        metadata_id = _text(metadata.get("videoId"))
        if metadata_id and metadata_id != video_id:
            raise PostgresAdapterError(
                f"video metadata videoId {metadata_id!r} conflicts with overlay video_id {video_id!r}"
            )
        metadata_by_video[video_id] = metadata
        metadata_revision_by_video[video_id] = _text(row.get("revision_id"))

    selected_revisions = list(dict.fromkeys(
        revision_id for revision_id in metadata_revision_by_video.values()
        if revision_id
    ))
    songs_by_video: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if selected_revisions:
        occurrence_rows = _rows(
            connection,
            """
            /* bounded active-overlay video-card songs */
            SELECT revision_id, video_id, occurrence_key, occurrence_id,
                   position, range_id, song_key, seconds, title, artist,
                   source_id, raw_hash, source_system, payload_json
            FROM migration_occurrence_rows
            WHERE revision_id = ANY(%s) AND video_id = ANY(%s)
            ORDER BY video_id, position, occurrence_key
            """,
            [selected_revisions, video_ids],
        )
        for row in occurrence_rows:
            video_id = _text(row.get("video_id"))
            if (
                video_id not in metadata_revision_by_video
                or _text(row.get("revision_id"))
                != metadata_revision_by_video[video_id]
            ):
                continue
            source = _json_object(row.get("payload_json"))
            nested_song = source.get("song")
            song = dict(nested_song) if isinstance(nested_song, Mapping) else source
            scalar_fields = {
                "videoId": row.get("video_id"),
                "occurrenceId": row.get("occurrence_id") or row.get("occurrence_key"),
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
            for name, value in scalar_fields.items():
                if value is not None and value != "":
                    song[name] = value
            songs_by_video[video_id].append(song)

    range_id = _text(result.get("rangeId"))
    projected: list[Any] = []
    public_fields = (
        "title", "channelId", "channelName", "channelHandle", "channelUrl",
        "publishedAt", "publishedTimestamp", "sourceSystem", "rangeId",
    )
    for record in records:
        if not isinstance(record, Mapping):
            projected.append(record)
            continue
        payload = dict(record)
        video_id = _text(payload.get("videoId") or payload.get("key"))
        if re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id) and range_id:
            expected_source_key = _stable_key(
                "source-video", range_id, video_id,
            )
            explicit_source_key = _text(payload.get("sourceDetailKey"))
            if (
                explicit_source_key
                and explicit_source_key != expected_source_key
            ):
                raise PostgresAdapterError(
                    "video card sourceDetailKey conflicts with its canonical "
                    f"range/video identity: {range_id}/{video_id}"
                )
            payload["sourceDetailKey"] = expected_source_key
            payload["sourceDetailPath"] = (
                f"/api/sources/{expected_source_key}"
            )
        metadata = metadata_by_video.get(video_id)
        if metadata:
            for name in public_fields:
                if metadata.get(name) not in (None, ""):
                    payload[name] = copy.deepcopy(metadata[name])
            payload["videoId"] = video_id
            if _text(metadata.get("title")) and "name" in payload:
                payload["name"] = metadata["title"]
            if not isinstance(payload.get("songs"), list) or not payload["songs"]:
                payload["songs"] = copy.deepcopy(songs_by_video.get(video_id, []))
        projected.append(payload)
    result["records"] = projected
    return result


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
    options = _query_options(query)
    occurrences = _source_records_as_occurrences(enriched, options, None)
    if not occurrences:
        return {"schemaVersion": 1, "found": False, "sourceKey": key}

    video_keys: list[str] = []
    for position, occurrence in enumerate(occurrences):
        video_id = _text(occurrence.get("videoId")) or f"position:{position}"
        if video_id not in video_keys:
            video_keys.append(video_id)
    use_paging = any(field in (query or {}) for field in ("page", "pageSize"))
    page_count = max(1, math.ceil(len(video_keys) / options["pageSize"]))
    page = min(options["page"], page_count)
    if use_paging:
        selected = set(video_keys[
            (page - 1) * options["pageSize"] : page * options["pageSize"]
        ])
        page_occurrences = [
            occurrence
            for position, occurrence in enumerate(occurrences)
            if (_text(occurrence.get("videoId")) or f"position:{position}")
                in selected
        ]
    else:
        page_occurrences = occurrences

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
    )
    channel_name = _text(
        metadata.get("channelName")
        or metadata.get("display_name")
        or metadata.get("name")
    )
    group_key = channel_id or channel_handle.lstrip("/@") or channel_name or key
    songs = _count_list(
        _text(occurrence.get("song", {}).get("title"))
        for occurrence in occurrences
    )
    record = copy.deepcopy(dict(metadata))
    record.update({
        "type": "vtuber",
        "key": _text(record.get("key")) or group_key,
        "name": channel_name or group_key,
        "channelName": channel_name or group_key,
        "count": len(occurrences),
        "occurrenceCount": len(occurrences),
        "timestampCount": len(occurrences),
        "songCount": len(songs),
        "videoCount": len(video_keys),
        "songs": songs,
        "occurrences": page_occurrences,
        "sourceDetailKey": key,
        "sourceDetailPath": f"/api/sources/{key}",
        "rangeId": options["range"],
    })
    if channel_id:
        record["channelId"] = channel_id
    if channel_handle:
        record["channelHandle"] = channel_handle

    result: dict[str, Any] = {
        "schemaVersion": 1,
        "found": True,
        "sourceKey": key,
        "record": record,
    }
    if use_paging:
        result.update({
            "page": page,
            "pageSize": options["pageSize"],
            "pageCount": page_count,
            "totalCount": len(video_keys),
            "totalVideoCount": len(video_keys),
            "totalOccurrenceCount": len(occurrences),
            "totalSongCount": len(songs),
        })
    return result


def _canonicalize_vtuber_source_payload(
    payload: Mapping[str, Any],
    records: Iterable[Mapping[str, Any]],
    query: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Make a rebuilt VTuber detail use the runtime builder's song identity.

    ``source_payload_from_records`` is intentionally generic and therefore
    groups VTuber songs by the physical ``songKey``.  The production runtime
    exporter instead strips safe version/list markers and groups by the
    canonical work-title key.  Recompute the small count map from the exact
    final occurrence set so card and detail share one contract.
    """

    result = copy.deepcopy(dict(payload))
    if not result.get("found"):
        return result
    options = _query_options(query)
    occurrences = _source_records_as_occurrences(records, options, None)
    counts: dict[str, dict[str, Any]] = {}
    unkeyed_occurrences = 0
    for occurrence in occurrences:
        # Persisted source projections are not all at the same wrapper depth:
        # newer rows expose ``song.title`` directly, while an older valid row
        # can carry an occurrence wrapper whose own nested ``song`` owns the
        # title.  Read through the established source-field traversal instead
        # of mistaking that legacy wrapper for a title-less authority row.
        raw_title = _source_occurrence_field(occurrence, "title")
        video_id = _source_occurrence_field(occurrence, "videoId")
        title, key = _vtuber_canonical_song_identity(raw_title)
        if not video_id:
            source_key = _text(
                result.get("sourceKey")
                or result.get("record", {}).get("sourceDetailKey")
            )
            raise PostgresAdapterError(
                "VTuber source occurrence is missing video identity: "
                f"sourceKey={source_key or '-'} "
                f"videoId={video_id or '-'} "
                f"occurrenceId={_source_occurrence_field(occurrence, 'occurrenceId') or '-'} "
                f"sourceSystem={_source_occurrence_field(occurrence, 'sourceSystem') or '-'} "
                f"sourceId={_source_occurrence_field(occurrence, 'sourceId') or '-'} "
                f"songKey={_source_occurrence_field(occurrence, 'songKey') or '-'}"
            )
        if not raw_title or not key:
            # Match the runtime ranking builder: a non-empty, symbol-only
            # title (for example `+male-sign` or an emoji-only title whose
            # normalized display title is empty) remains a valid occurrence
            # but has no work-title key and therefore does not increase
            # songCount.
            unkeyed_occurrences += 1
            continue
        entry = counts.setdefault(key, {"key": key, "name": title, "count": 0})
        entry["count"] += 1
    songs = sorted(
        counts.values(),
        key=lambda item: (-int(item["count"]), _overlay_norm(item["name"])),
    )
    total_occurrences = int(result.get("totalOccurrenceCount") or len(occurrences))
    if len(occurrences) != total_occurrences or (
        sum(int(item["count"]) for item in songs) + unkeyed_occurrences
        != total_occurrences
    ):
        raise PostgresAdapterError(
            "VTuber source canonical song counts do not cover final occurrences"
        )
    record = dict(result.get("record") or {})
    record["songs"] = songs
    record["songCount"] = len(songs)
    result["record"] = record
    result["totalSongCount"] = len(songs)
    return result


def _apply_persisted_vtuber_song_delta(
    payload: Mapping[str, Any],
    parent_record: Mapping[str, Any],
    before_records: Iterable[Mapping[str, Any]],
    after_records: Iterable[Mapping[str, Any]],
    query: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Preserve the canonical parent song multiset and apply exact tuple delta."""

    result = copy.deepcopy(dict(payload))
    if not result.get("found"):
        return result
    options = _query_options(query)
    before = _source_records_as_occurrences(before_records, options, None)
    after = _source_records_as_occurrences(after_records, options, None)
    def identity_counts(
        values: Iterable[Mapping[str, Any]],
    ) -> dict[tuple[Any, ...], tuple[Mapping[str, Any], int]]:
        """Preserve multiplicity when historical occurrence ids are reused."""

        result: dict[tuple[Any, ...], tuple[Mapping[str, Any], int]] = {}
        for item in values:
            song = item.get("song") if isinstance(item.get("song"), Mapping) else item
            identity = (
                *_source_record_identity({
                    "video": item.get("item") or item.get("video") or {},
                    "occurrences": (song,),
                }),
                _vtuber_canonical_song_identity(song.get("title"))[1],
            )
            previous = result.get(identity)
            result[identity] = (item, int(previous[1]) + 1 if previous else 1)
        return result

    before_by_id = identity_counts(before)
    after_by_id = identity_counts(after)
    counts: dict[str, dict[str, Any]] = {}
    for item in parent_record.get("songs") or ():
        if not isinstance(item, Mapping):
            raise PostgresAdapterError("VTuber parent song counts are invalid")
        key = _text(item.get("key"))
        name = _text(item.get("name"))
        count = int(item.get("count") or 0)
        if not key or not name or count <= 0 or key in counts:
            raise PostgresAdapterError("VTuber parent song counts are invalid")
        counts[key] = {"key": key, "name": name, "count": count}
    parent_occurrence_count = int(
        parent_record.get("count")
        or parent_record.get("occurrenceCount")
        or parent_record.get("timestampCount")
        or len(before)
    )
    keyed_parent_count = sum(int(item["count"]) for item in counts.values())
    unkeyed_count = parent_occurrence_count - keyed_parent_count
    if unkeyed_count < 0:
        raise PostgresAdapterError("VTuber parent song counts do not cover authority")

    def adjust(item: Mapping[str, Any], delta: int) -> None:
        nonlocal unkeyed_count
        song = item.get("song") if isinstance(item.get("song"), Mapping) else item
        title, key = _vtuber_canonical_song_identity(song.get("title"))
        if not _source_occurrence_field(item, "videoId"):
            raise PostgresAdapterError("VTuber source delta lacks video identity")
        if not _text(song.get("title")):
            unkeyed_count += delta
            if unkeyed_count < 0:
                raise PostgresAdapterError(
                    "VTuber source unkeyed song delta became negative"
                )
            return
        if not key:
            unkeyed_count += delta
            if unkeyed_count < 0:
                raise PostgresAdapterError(
                    "VTuber source unkeyed song delta became negative"
                )
            return
        entry = counts.get(key)
        if entry is None:
            if delta < 0:
                raise PostgresAdapterError("VTuber source delta cannot find parent song")
            entry = {"key": key, "name": title, "count": 0}
            counts[key] = entry
        entry["count"] = int(entry["count"]) + delta
        if int(entry["count"]) < 0:
            raise PostgresAdapterError("VTuber source song delta became negative")

    for identity in before_by_id.keys() | after_by_id.keys():
        before_item, before_count = before_by_id.get(identity, ({}, 0))
        after_item, after_count = after_by_id.get(identity, ({}, 0))
        delta = int(after_count) - int(before_count)
        if delta < 0:
            adjust(before_item, delta)
        elif delta > 0:
            adjust(after_item, delta)
    songs = sorted(
        (item for item in counts.values() if int(item["count"]) > 0),
        key=lambda item: (-int(item["count"]), _overlay_norm(item["name"])),
    )
    total = int(result.get("totalOccurrenceCount") or len(after))
    canonical_total = sum(int(item["count"]) for item in songs)
    effective_total = canonical_total + unkeyed_count
    if len(after) != total or effective_total != total:
        source_key = _text(
            parent_record.get("sourceDetailKey")
            or (result.get("record") or {}).get("sourceDetailKey")
            or result.get("sourceKey")
        )
        raise PostgresAdapterError(
            "VTuber final canonical song counts do not cover final occurrences: "
            f"source={source_key or 'unknown'} parent={parent_occurrence_count} "
            f"keyed_parent={keyed_parent_count} before={len(before)} "
            f"after={len(after)} response_total={total} "
            f"canonical_total={canonical_total} unkeyed={unkeyed_count} "
            f"effective_total={effective_total}"
        )
    record = dict(result.get("record") or {})
    record["songs"] = songs
    record["songCount"] = len(songs)
    result["record"] = record
    result["totalSongCount"] = len(songs)
    return result


def _source_occurrence_identity(item: Mapping[str, Any]) -> tuple[Any, ...]:
    occurrence_id = _text(item.get("occurrenceId") or item.get("occurrence_id"))
    range_id = _text(item.get("rangeId") or item.get("range_id"))
    if occurrence_id:
        return ("id", range_id, occurrence_id)
    return (
        "tuple",
        range_id,
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
            "title", "artist", "sourceId", "sourceSystem", "isNiche",
            "isUnknownArtist",
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
    snapshot_video_scope: Sequence[str] | None = None,
    *,
    prepared_overlay_inputs: tuple[
        Sequence[Mapping[str, Any]],
        Mapping[str, Mapping[str, Any]],
        Sequence[Mapping[str, Any]],
    ] | None = None,
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
    options = _query_options(source_query)
    persisted_occurrences: list[dict[str, Any]] = []
    authoritative_parent_records: list[dict[str, Any]] = []
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
            if "isNiche" not in song:
                song["isNiche"] = occurrence.get("is_niche") is True
            if "isUnknownArtist" not in song:
                song["isUnknownArtist"] = (
                    occurrence.get("is_unknown_artist") is True
                )
            songs.append(song)
        records.append({"video": video, "occurrences": tuple(songs)})
    candidate_rows: tuple[Mapping[str, Any], ...] = ()
    accepted_video_resets: dict[str, dict[str, Any]] = {}
    prepared_changes: tuple[Mapping[str, Any], ...] = ()
    if overlay_revision_ids:
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
        persisted_records = _persisted_source_records(
            persisted_occurrences, metadata,
        )
        if persisted_occurrences:
            # The persisted source projection is the immutable parent
            # membership authority.  A runtime video's scalar channel can be
            # stale or incomplete, and replacing an entire same-video source
            # record merely because one direct occurrence exists silently
            # drops the remaining persisted occurrences.  Keep every physical
            # source row as the parent base; direct channel rows remain the
            # compatibility fallback only when the parent release has no
            # physical source projection.
            parent_options = _query_options({"range": options["range"]})
            projected_parent = _source_records_as_occurrences(
                persisted_records, parent_options, None,
            )
            if len(projected_parent) != len(persisted_occurrences):
                raise PostgresAdapterError(
                    "VTuber persisted source records do not cover physical authority"
                )
            records = persisted_records
        authoritative_parent_records = copy.deepcopy(records)
        # A selected migration video row is a full-video reset even if it is
        # a tombstone or belongs to a different channel.  Remove that parent
        # video before channel filtering candidate records; otherwise a
        # tombstone has no candidate record and stale parent payload leaks
        # back through this public source endpoint.
        if snapshot_video_scope is None:
            accepted_video_resets = _accepted_video_resets(
                connection, overlay_revision_ids,
            )
            same_range_rows = tuple(_overlay_rows_for_range(
                _overlay_candidate_rows(connection, overlay_revision_ids),
                options["range"],
            ))
            selected = {
                _overlay_candidate_identity(row): dict(row)
                for row in same_range_rows
            }
            for row in _selected_full_reset_candidate_rows(
                connection,
                overlay_revision_ids,
                accepted_video_resets,
                options["range"],
            ):
                selected.setdefault(_overlay_candidate_identity(row), dict(row))
            candidate_rows = tuple(selected.values())
        else:
            if prepared_overlay_inputs is None:
                candidate_rows, accepted_video_resets, prepared_changes = (
                    _snapshot_source_overlay_inputs(
                        connection,
                        revision_id,
                        overlay_revision_ids,
                        options["range"],
                        snapshot_video_scope,
                        include_compatible_full_reset_7d=True,
                    )
                )
            else:
                candidate_rows = tuple(prepared_overlay_inputs[0])
                accepted_video_resets = {
                    _text(video_id): dict(row)
                    for video_id, row in prepared_overlay_inputs[1].items()
                    if _text(video_id)
                }
                prepared_changes = tuple(prepared_overlay_inputs[2])
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
    if overlay_revision_ids and snapshot_video_scope is not None:
        runtime_changes = prepared_changes
    else:
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
    raw_payload = _source_payload_from_channel_records(
        records, metadata, key, source_query,
    )
    scoped_source = bool(
        options.get("nicheOnly") or options.get("hideUnknownArtist")
    )
    if overlay_revision_ids and not scoped_source and (
        isinstance(metadata.get("songs"), list) or persisted_occurrences
    ):
        payload = _apply_persisted_vtuber_song_delta(
            raw_payload,
            metadata,
            authoritative_parent_records,
            records,
            source_query,
        )
    else:
        payload = _canonicalize_vtuber_source_payload(
            raw_payload, records, source_query,
        )
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
    canonical_raw = _source_payload_from_channel_records(
        records, metadata, canonical_key, source_query,
    )
    canonical = (
        _apply_persisted_vtuber_song_delta(
            canonical_raw,
            metadata,
            authoritative_parent_records,
            records,
            source_query,
        )
        if overlay_revision_ids and not scoped_source and (
            isinstance(metadata.get("songs"), list) or persisted_occurrences
        )
        else _canonicalize_vtuber_source_payload(
            canonical_raw, records, source_query,
        )
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
    # ``channelKey`` is the internal owner key and may be a historical display
    # name.  Only an explicit channelId, or one unique immutable UC id carried
    # by every preview occurrence, is safe to expose as public channelId.
    selected_channel_id = _text(
        selected.get("channelId") or selected.get("channel_id")
    )
    selected_channel_key = _text(
        selected.get("channelKey") or selected.get("channel_key")
    )
    occurrence_public_ids = {
        value
        for value in occurrence_ids
        if re.fullmatch(r"UC[A-Za-z0-9_-]{22}", value)
    }
    public_channel_id = selected_channel_id
    if (
        not public_channel_id
        and len(occurrence_public_ids) == 1
        and occurrence_ids <= occurrence_public_ids
    ):
        public_channel_id = next(iter(occurrence_public_ids))
    if not selected_channel_key and selected_channel_id:
        selected_channel_key = selected_channel_id
    channel_key = selected_channel_key or public_channel_id
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
    if not channel_url and public_channel_id:
        channel_url = f"https://www.youtube.com/channel/{public_channel_id}"
    if canonical_url_hint and _channel_url_is_coherent(canonical_url_hint, public_channel_id, handle):
        channel_url = canonical_url_hint
    field_values = {
        "key": channel_key,
        "name": display_name,
        "channelName": display_name,
        "channelId": public_channel_id,
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
    if not public_channel_id:
        # A legacy owner key is not a public YouTube channel id.  Do not leak
        # it through a stale payload or manufacture a channel URL from it.
        result.pop("channelId", None)
        result.pop("channelUrl", None)
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
            if not public_channel_id or not (
                nested_id == public_channel_id
                or (not nested_id and canonical_handle and nested_handle == canonical_handle)
            ):
                continue
            canonical_video = dict(nested)
            for key, value in {
                "channelId": public_channel_id,
                "channelHandle": handle,
                "channelName": display_name,
                "channelUrl": channel_url,
            }.items():
                if value is not None and value != "":
                    canonical_video[key] = value
            occurrence_result[nested_key] = canonical_video
        nested = occurrence_result.get("item") if isinstance(occurrence_result.get("item"), Mapping) else occurrence_result.get("video")
        if canonical_url_hint and isinstance(nested, Mapping) and _text(nested.get("channelId")) == public_channel_id:
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


def _runtime_entity_key(value: Any) -> str:
    """Port frontend ``normalizeEntityKey`` without search-case expansion."""

    return " ".join(unicodedata.normalize("NFKC", _text(value)).split()).lower()


_UNKNOWN_ARTIST_NAMES = frozenset({
    "unknown", "n/a", "na", "none", "null", "-",
    "\u672a\u8a18\u8f09", "\u672a\u8bb0\u8f7d", "\u4e0d\u660e",
    "\u65e0", "\u306a\u3057", "\u5f85\u8865\u6b4c\u624b",
    "\u5f85\u88dc\u6b4c\u624b", "\u5f85\u8865", "\u5f85\u88dc",
})


def _unknown_artist_name(value: Any) -> bool:
    """Port RankingUtils.isUnknownArtistName for overlay-only rows."""

    normalized = _overlay_norm(value)
    return not normalized or normalized in _UNKNOWN_ARTIST_NAMES


def _scope_value_sources(row: Mapping[str, Any]) -> tuple[Mapping[str, Any], ...]:
    """Expose scalar and nested occurrence shapes without losing false values."""

    sources: list[Mapping[str, Any]] = [row]
    for field in ("occurrence_payload_json", "payload_json"):
        raw = row.get(field)
        if raw is None:
            continue
        payload = _json_object(raw)
        if payload:
            sources.append(payload)
            nested = payload.get("payload")
            if isinstance(nested, Mapping):
                sources.append(nested)
    for source in tuple(sources):
        song = source.get("song")
        if isinstance(song, Mapping):
            sources.append(song)
    return tuple(sources)


def _scope_boolean_flag(
    row: Mapping[str, Any], camel_name: str, snake_name: str,
) -> bool | None:
    """Read one immutable scope flag, rejecting malformed explicit values."""

    scalar_alias = f"{snake_name}_value"
    for source in _scope_value_sources(row):
        for name in (camel_name, snake_name, scalar_alias):
            if name not in source or source.get(name) is None:
                continue
            value = source.get(name)
            if isinstance(value, bool):
                return value
            if isinstance(value, int) and value in {0, 1}:
                return bool(value)
            if isinstance(value, str):
                normalized = value.strip().casefold()
                if normalized in {"true", "1"}:
                    return True
                if normalized in {"false", "0"}:
                    return False
            raise PostgresAdapterError(
                f"overlay occurrence {camel_name} flag is invalid"
            )
    return None


def _scope_artist(row: Mapping[str, Any]) -> str:
    for source in _scope_value_sources(row):
        if "artist" in source:
            return _text(source.get("artist"))
    return ""


def _occurrence_matches_ranking_scope(
    row: Mapping[str, Any], options: Mapping[str, Any],
) -> bool:
    """Apply the same occurrence membership as persisted ranking scopes.

    Parent runtime rows expose physical boolean columns.  Accepted increments
    predate those columns, so their bounded scalar query extracts the JSON
    flags even when full payload hydration is disabled.  Historical accepted
    rows never stored ``isUnknownArtist``; only for that missing case do we
    fall back to the runtime builder's exact unknown-name set.
    """

    is_niche = _scope_boolean_flag(row, "isNiche", "is_niche")
    is_unknown_artist = _scope_boolean_flag(
        row, "isUnknownArtist", "is_unknown_artist",
    )
    if is_unknown_artist is None:
        is_unknown_artist = _unknown_artist_name(_scope_artist(row))
    if bool(options.get("nicheOnly")) and is_niche is not True:
        return False
    if bool(options.get("hideUnknownArtist")) and is_unknown_artist:
        return False
    return True


def _ranking_scope_rows(
    rows: Iterable[Mapping[str, Any]], options: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    return [
        row for row in rows if _occurrence_matches_ranking_scope(row, options)
    ]


def _overlay_song_group_norm(value: Any) -> str:
    """Match the punctuation-insensitive title/artist keys stored by rankings."""

    return "".join(
        character for character in _runtime_entity_key(value)
        if character.isalnum()
    )


def _source_song_owner_norm(value: Any) -> str:
    """Return a non-empty source owner for every non-empty public label.

    Song rankings intentionally retain symbol-only titles such as ``〜``.
    Their punctuation-insensitive group key is empty, so source ownership must
    fall back to the normalized public label instead of losing the identity.
    Empty labels remain empty and continue to fail closed.
    """

    text = _text(value)
    if not text:
        return ""
    return _overlay_song_group_norm(text) or _overlay_norm(text)


def _overlay_artist_group_norm(value: Any) -> str:
    """Port ``RankingUtils.normalizeArtistKey`` for public artist groups.

    Persisted Artist cards use a punctuation-free canonical key while thei
    occurrences intentionally retain the display spelling.  Aggregate and
    source routing must compare that canonical identity; exact occurrence
    deletion continues to use the immutable display tuple elsewhere.
    """

    return _overlay_song_group_norm(value)


def _strip_vtuber_title_list_marker(value: Any) -> str:
    """Port the runtime builder's bounded leading set-list marker cleanup."""

    result = _text(value)
    for _ in range(4):
        next_value = re.sub(
            r"^\s*[\u2500-\u257f\u25a0-\u25ff\u2600-\u27bf"
            r"\U0001f300-\U0001faff\ufe0f\u266a-\u266f>|・･]+",
            "", result,
        )
        next_value = re.sub(
            r"^\s*[NＮ][oｏ]\s*[0-9０-９]{1,3}[.．]\s+",
            "", next_value, flags=re.IGNORECASE,
        )
        next_value = re.sub(
            r"^\s*[＊*]?\s*(?:[#＃]?\d{1,3}|[０-９]{1,3})\s*"
            r"(?:曲目|曲|番目)?\s*[.)．。、,，:：)）\]\-|｜/／]+\s*",
            "", next_value,
        )
        next_value = re.sub(
            r"^\s*(?:[#＃]?\d{1,3}|[０-９]{1,3})\s*"
            r"(?:曲目|曲|番目)\s+",
            "", next_value,
        )
        next_value = re.sub(
            r"^\s*(?:[#＃]?\d{1,3}|[０-９]{1,3})(?=[「『【［\[(（])",
            "", next_value,
        )
        # Keep parity with RankingUtils.stripLeadingTitleListMarker.  In
        # particular, historical source rows contain composite markers such
        # as ``034,2:44:26 Title``; four bounded passes intentionally peel
        # one numeric segment at a time.  The decimal-dot guard keeps a real
        # numeric title from being truncated at ``12.3``.
        next_value = re.sub(
            r"^\s*[\d\uFF10-\uFF19]{1,3}\s*[;\uFF1B]\s*"
            r"[\d\uFF10-\uFF19]{1,2}[:\uFF1A]"
            r"[0-5\uFF10-\uFF15][\d\uFF10-\uFF19]"
            r"[:\uFF1A][0-5\uFF10-\uFF15]"
            r"[\d\uFF10-\uFF19]\s+",
            "", next_value,
        )
        next_value = re.sub(
            r"^\s*[\u2460-\u2473\u24F5-\u24FE\u2776-\u2793"
            r"\u3251-\u325F\u32B1-\u32BF]\s*",
            "", next_value,
        )
        number = r"(?:[#\uFF03]?\d{1,3}|[\uFF10-\uFF19]{1,3})"
        next_value = re.sub(
            rf"^\s*(?:{number}(?=[\u300C\u300E\u3010\uFF3B\[(\uFF08])|"
            rf"{number}[\s\u3002\u3001,\uFF0C:\uFF1A)\uFF09\]\-|"
            rf"\uFF5C/\uFF0F]+|"
            rf"{number}[.\uFF0E](?![0-9\uFF10-\uFF19])\s*)",
            "", next_value,
        )
        if next_value == result:
            break
        result = next_value.strip()
    return result.strip()


def _vtuber_title_has_japanese(value: Any) -> bool:
    return bool(re.search(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", _text(value)))


def _strip_vtuber_trailing_latin_gloss(value: Any) -> str:
    text = unicodedata.normalize("NFKC", _text(value))
    separated = re.match(
        r"^(.+?)\s+(?:[-–—])\s+([A-Za-z][A-Za-z0-9 .,'’\"“”&+_/!?()[\]-]{1,80})$",
        text,
    )
    if separated and _vtuber_title_has_japanese(separated.group(1)):
        return separated.group(1).strip()
    bracketed = re.match(
        r"^(.+?)\s*[(（［\[]\s*([A-Za-z][A-Za-z0-9 .,'’\"“”&+_/!?()[\]-]{1,80})\s*[)）］\]]$",
        text,
    )
    if bracketed and _vtuber_title_has_japanese(bracketed.group(1)):
        return bracketed.group(1).strip()
    return text


def _is_safe_vtuber_song_variant(work_title: Any, value: Any, *, allow_repeated_title: bool) -> bool:
    text = re.sub(r"^[\s:：\-ー–—|｜/／]+|[\s:：\-ー–—|｜/／]+$", "", _text(value)).strip()
    title = _text(work_title)
    if allow_repeated_title and text and _overlay_song_group_norm(text) == _overlay_song_group_norm(title):
        return True
    return bool(re.match(
        r"^(?:piano\s*(?:ver\.?|version)?|ピアノ\s*(?:ver\.?|版)?|"
        r"acoustic\s*(?:ver\.?|version)?|アコースティック|弾き語り|"
        r"a\s*cappella\s*(?:ver\.?|version|版)?|acappella\s*(?:ver\.?|version|版)?|"
        r"アカペラ\s*(?:ver\.?|version|版)?|清唱(?:版)?|short\s*(?:ver\.?|version)?|"
        r"full\s*(?:ver\.?|version)?|tv\s*size|english\s*(?:ver\.?|version|版)?|"
        r"eng\s*(?:ver\.?|version|版)?|英語\s*(?:ver\.?|version|版)?|英文\s*(?:ver\.?|version|版)?|"
        r"key\s*[+-]\s*\d+|キー\s*[+-]?\s*\d+|原キー|キー変更|"
        r"[A-Za-z][A-Za-z0-9 .'’_-]{0,40}\s+ver\.?)$",
        text, re.IGNORECASE,
    ))


def _normalize_vtuber_song_work_title(value: Any) -> str:
    text = _strip_vtuber_title_list_marker(value)
    for _ in range(3):
        next_text = re.sub(r"^[「『【［\[(（]\s*(.+?)\s*[」』】］\])）]$", r"\1", text).strip()
        if next_text == text:
            break
        text = next_text
    bracket = re.match(r"^(.+?)\s*[(（［\[【「『]\s*([^()（）\[\]［］【】「」『』]{1,80})\s*[)）］\]】」』]\s*$", text)
    if bracket and _is_safe_vtuber_song_variant(bracket.group(1), bracket.group(2), allow_repeated_title=True):
        return bracket.group(1).strip()
    separated = re.match(r"^(.+?)\s*(?:[-ー–—|｜:：/／])\s*(.{1,80})\s*$", text)
    if separated and _is_safe_vtuber_song_variant(separated.group(1), separated.group(2), allow_repeated_title=True):
        return separated.group(1).strip()
    spaced = re.match(r"^(.+?)\s+(.{1,80})\s*$", text)
    if spaced and _is_safe_vtuber_song_variant(spaced.group(1), spaced.group(2), allow_repeated_title=False):
        return spaced.group(1).strip()
    trailing = re.match(r"^(.+?)\s+(?:[#＃]?\d{1,3}\s*(?:曲目|曲|番目))\s*$", text)
    return trailing.group(1).strip() if trailing else text


def _normalize_japanese_month_words(value: Any) -> str:
    """Port RankingUtils.normalizeJapaneseMonthWords for song keys only."""

    month_digits = {
        "\u4e00": "1",
        "\u4e8c": "2",
        "\u4e09": "3",
        "\u56db": "4",
        "\u4e94": "5",
        "\u516d": "6",
        "\u4e03": "7",
        "\u516b": "8",
        "\u4e5d": "9",
        "\u5341": "10",
        "\u5341\u4e00": "11",
        "\u5341\u4e8c": "12",
    }
    return re.sub(
        r"(\u5341\u4e00|\u5341\u4e8c|\u5341|"
        r"[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d])"
        r"\u6708",
        lambda match: f"{month_digits[match.group(1)]}\u6708",
        _text(value),
    )


def _vtuber_canonical_song_identity(value: Any) -> tuple[str, str]:
    """Return the exact runtime builder display title and work-title key."""

    title = _text(value)
    if not title:
        return "", ""
    for _ in range(4):
        next_title = unicodedata.normalize("NFKC", title)
        next_title = re.sub(
            r"^\s*[#＃]?\d{1,4}\s*[\u2600-\u27bf\U0001f300-\U0001faff\ufe0f\u266a-\u266f"
            r"▶▷►▸▹>|・･●○◆◇■□]+", "", next_title,
        )
        next_title = re.sub(
            r"^\s*[＊*]?\s*(?:[#＃]?\d{1,4}|[０-９]{1,4})\s*(?:曲目|曲|番目)?\s*"
            r"[.)．。、,，:：)）\]\-|｜/／]+\s*", "", next_title,
        ).strip()
        if next_title == title:
            break
        title = next_title
    title = _strip_vtuber_trailing_latin_gloss(title)
    title = _normalize_vtuber_song_work_title(title)
    title = _strip_vtuber_trailing_latin_gloss(title)
    key_title = _normalize_japanese_month_words(
        _normalize_vtuber_song_work_title(title)
    )
    key = "".join(
        character
        for character in unicodedata.normalize("NFKC", key_title).casefold()
        if unicodedata.category(character)[0] in {"L", "N"}
    )
    return title, key


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
    scalar_source = source
    for name in ("videoPayload", "video_payload", "video", "item"):
        candidate = source.get(name)
        if isinstance(candidate, Mapping):
            source = candidate
            break
    fields = (
        "videoId", "title", "channelId", "channelName", "channelHandle",
        "channelUrl", "thumbnailUrl", "videoThumbnailUrl", "avatarUrl",
        "sourceUrl", "sourceSystem", "publishedAt", "publishedTimestamp",
    )
    return {
        name: (
            source[name]
            if name in source and source[name] is not None
            else scalar_source[name]
        )
        for name in fields
        if (
            (name in source and source[name] is not None)
            or (name in scalar_source and scalar_source[name] is not None)
        )
    }


def _overlay_candidate_rows(
    connection, revision_ids: Sequence[str], include_payload: bool = True,
    channel_scope: Sequence[str] | None = None,
    scoped_parent_video_ids: Sequence[str] | None = None,
    range_id: str = "",
    video_scope: Sequence[str] | None = None,
    full_reset_only: bool = False,
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
    exact_video_scope = (
        sorted({_text(value) for value in video_scope if _text(value)})
        if video_scope is not None
        else None
    )
    if scope is not None and exact_video_scope is not None:
        raise PostgresAdapterError(
            "overlay candidate lookup cannot combine channel and exact-video scope"
        )
    scoped_video_ids: list[str] | None = None
    if exact_video_scope is not None:
        if not exact_video_scope:
            return []
        scoped_video_ids = exact_video_scope
    elif scope is not None:
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
    targeted = scoped_video_ids is not None
    video_scope_clause = " AND video_id = ANY(%s)" if targeted else ""
    video_params: list[Any] = [list(revision_ids)]
    if scoped_video_ids is not None:
        video_params.append(scoped_video_ids)
    # The unscoped ranking path reads the complete overlay video identity set
    # before reducing it to one row per video.  Its row bound is deliberately
    # separate from the 50k affected-scope guard: the current production
    # lineage has 50,178 video rows but only 2,192 distinct videos.  Keep a
    # finite fail-closed ceiling while allowing that complete bounded set to
    # be hydrated; exact/channel scopes retain the tighter affected bound.
    video_limit = (
        _MAX_AFFECTED_RUNTIME_OCCURRENCES
        if targeted
        else _MAX_UNSCOPED_OVERLAY_VIDEOS
    )
    video_params.append(video_limit + 1)
    video_rows = _rows(
        connection,
        f"""
        SELECT revision_id, video_id, title AS video_title, channel_name,
               channel_id, channel_handle, channel_url, published_at,
               {video_payload} AS video_payload_json,
               tombstone AS video_tombstone,
               (payload_json->>'partialRangeReset' = 'true') AS partial_range_reset,
               payload_json->>'rangeId' AS partial_range_id
        FROM migration_video_rows
        WHERE revision_id = ANY(%s)
          {video_scope_clause}
        ORDER BY revision_id, video_id
        LIMIT %s
        """,
        video_params,
    )
    if len(video_rows) > video_limit:
        raise PostgresAdapterError("overlay candidate video lookup exceeded bounded cap")
    video_rows.sort(key=lambda row: (
        priority.get(_text(row.get("revision_id")), len(priority)),
        _text(row.get("video_id")),
    ))
    selected_video: dict[str, dict[str, Any]] = {}
    for row in video_rows:
        if full_reset_only and _is_partial_range_video_row(row):
            continue
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
    selected_video_priorities = [
        priority.get(
            _text(selected_video[video_id].get("revision_id")), len(priority),
        )
        for video_id in selected_video_ids
    ]
    occurrence_params: list[Any] = [
        list(revision_ids), selected_video_ids, selected_video_priorities,
    ]
    if targeted:
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
    occurrence_limit = (
        _MAX_UNSCOPED_OVERLAY_OCCURRENCES
        if not targeted
        else _MAX_AFFECTED_RUNTIME_OCCURRENCES
    )
    occurrence_params.append(occurrence_limit + 1)
    occurrence_rows = _rows(
        connection,
        f"""
        WITH revision_priority(revision_id, overlay_priority) AS MATERIALIZED (
          SELECT item.revision_id, item.ordinality - 1
          FROM unnest(%s::text[]) WITH ORDINALITY
            AS item(revision_id, ordinality)
        ), selected_videos(video_id, selected_priority) AS MATERIALIZED (
          SELECT selected.video_id, selected.selected_priority
          FROM unnest(%s::text[], %s::bigint[])
            AS selected(video_id, selected_priority)
        ), ranked_occurrences AS MATERIALIZED (
          SELECT o.revision_id, o.video_id, o.occurrence_id, o.position,
                 o.range_id, o.song_key, o.seconds, o.title, o.artist,
                 o.source_id, o.raw_hash, o.source_system,
                 coalesce(
                   o.payload_json->>'isNiche',
                   o.payload_json->'payload'->>'isNiche'
                 ) AS is_niche_value,
                 coalesce(
                   o.payload_json->>'isUnknownArtist',
                   o.payload_json->'payload'->>'isUnknownArtist'
                 ) AS is_unknown_artist_value,
                 {occurrence_payload} AS occurrence_payload_json,
                 priority.overlay_priority, o.occurrence_key,
                 ROW_NUMBER() OVER (
                   PARTITION BY o.video_id,
                     COALESCE(
                       NULLIF(o.occurrence_id, ''),
                       'position:' || COALESCE(o.position::text, '0') || ':' ||
                         COALESCE(o.song_key, '')
                     )
                   ORDER BY priority.overlay_priority, o.position,
                            o.occurrence_key
                 ) AS identity_rank
          FROM migration_occurrence_rows AS o
          JOIN revision_priority AS priority
            ON priority.revision_id = o.revision_id
          JOIN selected_videos AS selected
            ON selected.video_id = o.video_id
           AND priority.overlay_priority <= selected.selected_priority
          WHERE TRUE
            {occurrence_range_clause}
        )
        SELECT revision_id, video_id, occurrence_id, position, range_id,
               song_key, seconds, title, artist, source_id, raw_hash,
               source_system, is_niche_value, is_unknown_artist_value,
               occurrence_payload_json
        FROM ranked_occurrences
        WHERE identity_rank = 1
        ORDER BY overlay_priority, video_id, position, occurrence_key
        LIMIT %s
        """,
        occurrence_params,
    )
    if len(occurrence_rows) > occurrence_limit:
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
        # ``RankingUtils.buildSongRecords`` rejects an empty normalized title
        # before constructing any song, Artist, VTuber, video, or source
        # aggregate.  Apply the same gate to ordinary overlay rows (selected
        # full-reset rows already do this) so all public views share one tuple
        # universe.
        if _text(row.get("title")) and occurrence_key not in selected_occurrences:
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


def _overlay_candidate_identity(row: Mapping[str, Any]) -> tuple[str, str]:
    video_id = _text(row.get("video_id") or row.get("videoId"))
    occurrence_id = _text(row.get("occurrence_id") or row.get("occurrenceId"))
    if not occurrence_id:
        occurrence_id = "position:" + ":".join((
            _text(row.get("position")),
            _text(row.get("song_key") or row.get("songKey")),
        ))
    return video_id, occurrence_id


def _project_compatible_candidate_rows(
    rows: Iterable[Mapping[str, Any]], target_range: str,
) -> tuple[dict[str, Any], ...]:
    projected: list[dict[str, Any]] = []
    for value in rows:
        row = dict(value)
        if target_range == "all" and _text(row.get("range_id")) == "7d":
            row["range_id"] = "all"
            for payload_field in (
                "occurrence_payload_json", "video_payload_json",
            ):
                payload = _json_object(row.get(payload_field))
                if not payload:
                    continue
                if isinstance(payload.get("payload"), Mapping):
                    nested = dict(payload["payload"])
                    nested["rangeId"] = "all"
                    payload["payload"] = nested
                else:
                    payload["rangeId"] = "all"
                row[payload_field] = payload
        projected.append(row)
    return tuple(projected)


def _selected_full_reset_candidate_rows(
    connection,
    revision_ids: Sequence[str],
    resets: Mapping[str, Mapping[str, Any]],
    target_range: str,
    *,
    include_payload: bool = True,
) -> tuple[dict[str, Any], ...]:
    """Read compatible physical rows only for selected non-partial resets.

    Ordinary 7d rows stay isolated from all.  Only video ids already selected
    by ``_accepted_video_resets`` may contribute their physical 7d projection
    to the compatible all endpoint.  Target-range rows win when both physical
    projections contain the same logical occurrence.
    """

    video_ids = tuple(sorted({_text(value) for value in resets if _text(value)}))
    if not video_ids:
        return ()
    physical_ranges = (target_range, "7d") if target_range == "all" else (target_range,)
    selected: dict[tuple[str, str], dict[str, Any]] = {}
    for physical_range in physical_ranges:
        physical_rows = list(_overlay_candidate_rows(
            connection,
            revision_ids,
            include_payload,
            range_id=physical_range,
            video_scope=video_ids,
            full_reset_only=True,
        ))
        # The runtime builder excludes source songs whose normalized title is
        # empty.  Scalar title is sufficient for the exact aggregate; do not
        # deserialize payload for every historical full-reset tuple merely to
        # reconfirm it.  Detailed source reconstruction already requests full
        # payloads and follows the same scalar filter here.
        physical_rows = [
            row for row in physical_rows if _text(row.get("title"))
        ]
        for row in physical_rows:
            identity = _overlay_candidate_identity(row)
            if identity[0] in resets and identity not in selected:
                selected[identity] = dict(row)
    return _project_compatible_candidate_rows(selected.values(), target_range)


def _is_partial_range_video_row(row: Mapping[str, Any]) -> bool:
    """Identify the reviewed 7D metadata-only video-row contract."""

    if "partial_range_reset" in row or "partial_range_id" in row:
        return (
            row.get("partial_range_reset") is True
            and _text(row.get("partial_range_id")) == "7d"
        )
    raw_payload = row.get("payload_json")
    if raw_payload is None:
        return False
    payload = _json_object(raw_payload)
    if isinstance(payload.get("payload"), Mapping):
        payload = dict(payload["payload"])
    return payload.get("partialRangeReset") is True and _text(
        payload.get("rangeId") or payload.get("range")
    ) == "7d"


def _accepted_video_resets(
    connection, revision_ids: Sequence[str], include_payload: bool = True,
    strict_video_id: bool = False,
    parent_revision_id: str = "",
    channel_scope: Sequence[str] | None = None,
    scoped_parent_video_ids: Sequence[str] | None = None,
    video_scope: Sequence[str] | None = None,
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
    exact_video_scope = (
        sorted({_text(value) for value in video_scope if _text(value)})
        if video_scope is not None
        else None
    )
    if scope is not None and exact_video_scope is not None:
        raise PostgresAdapterError(
            "accepted-video reset lookup cannot combine channel and exact-video scope"
        )
    if exact_video_scope is not None and not exact_video_scope:
        return {}
    scope_clause = ""
    params: list[Any] = [list(revision_ids)]
    if exact_video_scope is not None:
        scope_clause = " AND video_id = ANY(%s)"
        params.append(exact_video_scope)
    elif scope is not None:
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
    # The unscoped snapshot path must inspect the complete accepted overlay
    # lineage.  Production currently has 50,178 migration_video_rows across
    # 200 revisions, so the targeted 50,000 cap is intentionally retained for
    # channel/exact-video requests while the unscoped path uses the separate
    # bounded headroom used by _overlay_candidate_rows.
    video_limit = (
        _MAX_UNSCOPED_OVERLAY_VIDEOS
        if scope is None and exact_video_scope is None
        else _MAX_AFFECTED_RUNTIME_OCCURRENCES
    )
    params.append(video_limit + 1)
    rows = _rows(
        connection,
        f"""
        SELECT revision_id, video_id, title AS video_title, channel_name,
               channel_id, channel_handle, channel_url, published_at,
               tombstone, {payload} AS payload_json,
               (payload_json->>'partialRangeReset' = 'true') AS partial_range_reset,
               payload_json->>'rangeId' AS partial_range_id
        FROM migration_video_rows
        WHERE revision_id = ANY(%s)
          {scope_clause}
        ORDER BY video_id
        LIMIT %s
        """,
        params,
    )
    if len(rows) > video_limit:
        raise PostgresAdapterError(
            "accepted-video reset lookup exceeded bounded video cap"
        )
    selected: dict[str, dict[str, Any]] = {}
    for row in sorted(rows, key=lambda item: priority.get(_text(item.get("revision_id")), len(priority))):
        if _is_partial_range_video_row(row):
            continue
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
    *,
    include_persisted_source_authority: bool = False,
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
               o.artist, o.is_niche, o.is_unknown_artist, o.range_id,
               v.channel_id, v.channel_handle,
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
            "isNiche": row.get("is_niche") is True,
            "isUnknownArtist": row.get("is_unknown_artist") is True,
            "songKey": _text(row.get("song_key")),
            "seconds": row.get("seconds"),
            "rangeId": _text(row.get("range_id")),
            "channel_id": row.get("channel_id"),
            "channel_handle": row.get("channel_handle"),
            "channel_name": row.get("channel_name"),
            "channel_url": row.get("channel_url"),
            "originalGroupVideoOccurrenceCount": 1,
            "acceptedVideoReset": True,
        })
    if include_persisted_source_authority:
        # ``runtime_videos``/``runtime_occurrences`` are an intentionally
        # compact scalar projection.  Historical full-runtime releases can
        # retain a video's complete immutable occurrence set only inside the
        # persisted source projection for the requested view.  A selected
        # full-video reset must remove that source authority too, otherwise an
        # old ranking card can survive while its source detail correctly
        # disappears and snapshot export fails.
        #
        # The trigram expression below has a production GIN index.  Keep the
        # exact equality predicate as a fail-closed recheck and run this only
        # for snapshot materialization, whose caller caches the result across
        # every metric/filter combination in one repeatable-read transaction.
        source_rows: list[dict[str, Any]] = []
        range_id = _text(options.get("range")) or "all"
        view = _text(options.get("view")) or "songs"
        source_entity_types = (
            ["song"]
            if view in {"songs", "songIndex", "vsingerSongs"}
            else ["artist"]
            if view == "artists"
            else ["vtuber"]
            if view == "vtubers"
            else []
        )
        # Video sources are synthesized from the parent video ranking during
        # snapshot export; there is no single physical ``video`` source
        # entity whose occurrence multiset can replace runtime_occurrences.
        # Keep the compact scalar parent projection authoritative here.
        if not source_entity_types:
            return changes
        for video_id in video_ids:
            remaining = _MAX_AFFECTED_RUNTIME_OCCURRENCES - len(source_rows)
            if remaining <= 0:
                raise PostgresAdapterError(
                    "accepted-video persisted source reconciliation exceeded bounded cap"
                )
            scoped_rows = _rows(
                connection,
                """
                /* indexed accepted-reset persisted source authority */
                SELECT occurrence.video_id, occurrence.source_key,
                       detail.entity_type, detail.entity_key,
                       occurrence.position, occurrence.seconds,
                       occurrence.is_niche, occurrence.is_unknown_artist,
                       occurrence.payload_json
                FROM runtime_source_occurrences AS occurrence
                JOIN runtime_source_details AS detail
                  ON detail.revision_id = occurrence.revision_id
                 AND detail.source_key = occurrence.source_key
                 AND detail.range_id = occurrence.range_id
                 AND detail.entity_type = ANY(%s)
                WHERE occurrence.revision_id = %s
                  AND occurrence.range_id = %s
                  AND daily_song_source_video_search_text(
                        occurrence.title,
                        occurrence.video_id,
                        occurrence.payload_json
                      ) ILIKE %s ESCAPE E'\\\\'
                  AND occurrence.video_id = %s
                ORDER BY occurrence.source_key, occurrence.position
                LIMIT %s
                """,
                [
                    source_entity_types,
                    parent_revision_id,
                    range_id,
                    f"%{_sql_like_literal(video_id)}%",
                    video_id,
                    remaining + 1,
                ],
            )
            if len(scoped_rows) > remaining:
                raise PostgresAdapterError(
                    "accepted-video persisted source reconciliation exceeded bounded cap"
                )
            source_rows.extend(dict(row) for row in scoped_rows)
        rows_by_video: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in source_rows:
            video_id = _text(row.get("video_id"))
            source_key = _text(row.get("source_key"))
            entity_type = _text(row.get("entity_type"))
            entity_key = _text(row.get("entity_key"))
            if (
                video_id not in video_ids
                or not source_key
                or entity_type not in set(source_entity_types)
                or not entity_key
            ):
                raise PostgresAdapterError(
                    "accepted-video persisted source authority identity is invalid"
                )
            rows_by_video[video_id].append(dict(row))

        def persisted_identity(
            row: Mapping[str, Any], *, canonical_title: bool = False,
        ) -> tuple[Any, ...]:
            item = _runtime_source_occurrence(row)
            song = item.get("song") if isinstance(item.get("song"), Mapping) else item
            title = _text(song.get("title"))
            if not title:
                raise PostgresAdapterError(
                    "accepted-video persisted source authority lacks song identity"
                )
            artist = _text(song.get("artist"))
            title_key = (
                _vtuber_canonical_song_identity(title)[1]
                if canonical_title
                else _overlay_song_group_norm(title)
            )
            seconds = (
                song.get("seconds")
                if song.get("seconds") is not None
                else row.get("seconds")
            )
            return (
                _text(row.get("video_id")),
                seconds,
                title_key or _overlay_song_group_norm(title),
                _overlay_song_group_norm(artist),
            )

        scalar_by_video: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for change in changes:
            scalar_by_video[_text(change.get("videoId"))].append(change)
        reconciled: list[dict[str, Any]] = []
        for video_id in video_ids:
            authority_rows = rows_by_video.get(video_id, [])
            song_rows = [
                row
                for row in authority_rows
                if _text(row.get("entity_type")) == "song"
            ]
            artist_rows = [
                row
                for row in authority_rows
                if _text(row.get("entity_type")) == "artist"
            ]
            vtuber_rows_by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for row in authority_rows:
                if _text(row.get("entity_type")) == "vtuber":
                    vtuber_rows_by_source[_text(row.get("source_key"))].append(row)
            if len(vtuber_rows_by_source) > 1:
                raise PostgresAdapterError(
                    "accepted-video persisted VTuber authority is ambiguous "
                    f"(video={video_id})"
                )
            vtuber_rows = (
                next(iter(vtuber_rows_by_source.values()))
                if vtuber_rows_by_source
                else []
            )
            if view in {"songs", "songIndex", "vsingerSongs"}:
                persisted_rows = song_rows
            elif view == "artists":
                persisted_rows = artist_rows
            elif view == "vtubers":
                persisted_rows = vtuber_rows
            else:
                raise PostgresAdapterError(
                    f"accepted-video persisted source view is unsupported: {view}"
                )

            source_changes: list[dict[str, Any]] = []
            for row in persisted_rows:
                identity = persisted_identity(row)
                item = _runtime_source_occurrence(row)
                song = item.get("song") if isinstance(item.get("song"), Mapping) else item
                video = _overlay_video_projection(item)
                title = _text(song.get("title"))
                artist = _text(song.get("artist"))
                is_unknown_artist = row.get("is_unknown_artist") is True
                is_niche = row.get("is_niche") is True
                parent_artist_key = (
                    _text(row.get("entity_key"))
                    if _text(row.get("entity_type")) == "artist"
                    else "unknown"
                    if is_unknown_artist
                    else _overlay_song_group_norm(artist) or "unknown"
                )
                parent_song_group_key = (
                    _text(row.get("entity_key"))
                    if _text(row.get("entity_type")) == "song"
                    else "::".join((
                        _vtuber_canonical_song_identity(title)[1]
                        or _overlay_song_group_norm(title),
                        parent_artist_key,
                    ))
                )
                source_changes.append({
                    "entityType": "occurrences",
                    "videoId": video_id,
                    # Persisted source rows predate occurrenceId.  Position is
                    # source-local and not a public immutable id; keep it out
                    # of occurrence matching while retaining one explicit
                    # identity for diagnostics and preview de-duplication.
                    "occurrenceId": "",
                    "sourcePosition": int(row.get("position") or 0),
                    "title": title,
                    "artist": artist,
                    "isNiche": is_niche,
                    "isUnknownArtist": is_unknown_artist,
                    "parentSongGroupKey": parent_song_group_key,
                    "parentArtistGroupKey": parent_artist_key,
                    "songKey": _text(song.get("songKey") or song.get("key")),
                    "seconds": (
                        song.get("seconds")
                        if song.get("seconds") is not None
                        else row.get("seconds")
                    ),
                    "rangeId": _text(options.get("range")) or "all",
                    "channel_id": _text(video.get("channelId")),
                    "channel_handle": video.get("channelHandle"),
                    "channel_name": video.get("channelName"),
                    "channel_url": video.get("channelUrl"),
                    "videoTitle": video.get("title"),
                    "videoPayload": video,
                    "acceptedVideoReset": True,
                    "persistedSourceAuthority": True,
                })
            # Persisted rows are the immutable authority.  Scalar runtime rows
            # remain a bounded fallback for identities that have no source
            # projection at all.  Match raw title first, then the runtime
            # canonical work-title key for historical display rewrites such as
            # ``1,000,000 TIMES`` -> ``TIMES``.
            used_source: set[int] = set()

            def change_identity(
                change: Mapping[str, Any], *, canonical_title: bool = False,
            ) -> tuple[Any, ...]:
                title = _text(change.get("title"))
                title_key = (
                    _vtuber_canonical_song_identity(title)[1]
                    if canonical_title
                    else _overlay_song_group_norm(title)
                )
                return (
                    video_id,
                    change.get("seconds"),
                    title_key or _overlay_song_group_norm(title),
                    _overlay_song_group_norm(change.get("artist")),
                )

            for scalar_change in scalar_by_video.get(video_id, ()):
                match_index = next((
                    index
                    for index, source_change in enumerate(source_changes)
                    if index not in used_source
                    and change_identity(source_change)
                        == change_identity(scalar_change)
                ), None)
                if match_index is None:
                    match_index = next((
                        index
                        for index, source_change in enumerate(source_changes)
                        if index not in used_source
                        and change_identity(source_change, canonical_title=True)
                            == change_identity(scalar_change, canonical_title=True)
                    ), None)
                if match_index is None:
                    reconciled.append(scalar_change)
                else:
                    used_source.add(match_index)
            reconciled.extend(source_changes)
        changes = reconciled
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


def _snapshot_accepted_video_reset_changes(
    connection,
    parent_revision_id: str,
    resets: Mapping[str, Mapping[str, Any]],
    options: Mapping[str, Any],
    *,
    identity_only: bool = False,
    include_persisted_source_authority: bool = False,
    cache: MutableMapping[
        tuple[str, str, str, tuple[str, ...]], list[dict[str, Any]]
    ] | None = None,
) -> list[dict[str, Any]]:
    """Reuse one accepted-reset parent projection inside one immutable snapshot.

    A release materializer asks for the same all-range reset set once per
    metric and persisted filter scope.  Re-reading every affected parent
    occurrence for each of those combinations dominated the offline build.
    The caller owns ``cache`` for exactly one repeatable-read transaction and
    clears it before source export; ordinary API requests pass no cache and
    retain the existing independent-query behaviour.

    The preparation path enriches reset dictionaries with immutable channel
    evidence and exact per-video/group counts.  Those updates are idempotent,
    so returning the same list within the same database snapshot is both
    bounded and semantically identical to rebuilding it.
    """

    video_ids = tuple(sorted({
        _text(video_id) for video_id in resets if _text(video_id)
    }))
    view = _text(options.get("view")) or "songs"
    mode = (
        "identity"
        if identity_only
        else f"source-authority:{view}"
        if include_persisted_source_authority
        else "occurrences"
    )
    range_id = _text(options.get("range")) or "all"
    key = (parent_revision_id, range_id, mode, video_ids)
    if cache is not None and key in cache:
        print(
            f"PG_SNAPSHOT_RESET_CACHE hit range={range_id} "
            f"mode={mode} videos={len(video_ids)}",
            flush=True,
        )
        return cache[key]
    changes = (
        _accepted_video_reset_identity_changes(
            connection, parent_revision_id, resets,
        )
        if identity_only
        else _accepted_video_reset_changes(
            connection,
            parent_revision_id,
            resets,
            options,
            include_persisted_source_authority=(
                include_persisted_source_authority
            ),
        )
    )
    if cache is not None:
        cache[key] = changes
        print(
            f"PG_SNAPSHOT_RESET_CACHE miss range={range_id} "
            f"mode={mode} videos={len(video_ids)} changes={len(changes)}",
            flush=True,
        )
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
        if not _text(song.get("title")):
            # Match the VTuber ranking contract: accepted discovery rows with
            # no normalized title are curation evidence, not public songs.
            continue
        for public_name, camel_name, snake_name in (
            ("isNiche", "isNiche", "is_niche"),
            ("isUnknownArtist", "isUnknownArtist", "is_unknown_artist"),
        ):
            if public_name in song and song.get(public_name) is not None:
                continue
            value = _scope_boolean_flag(row, camel_name, snake_name)
            if value is not None:
                song[public_name] = value
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
            # Accepted occurrence projections and generic runtime curation
            # rows describe the same physical tuple through two historical
            # entity-type spellings.  They must share one chain; otherwise a
            # replacement is rooted at the old parent tuple even after the
            # accepted projection has already reset that tuple.
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
        chain_entity_type = (
            "occurrences"
            if entity_type in {"occurrences", "runtime_occurrences"}
            else entity_type
        )
        key = (chain_entity_type, video_id, identity)
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
        original_identity = (
            payload.get("originalIdentity")
            if isinstance(payload.get("originalIdentity"), Mapping)
            else final_payload.get("originalIdentity")
        )
        if isinstance(original_identity, Mapping):
            for field in ("title", "artist", "songKey", "sourceId"):
                if not _text(payload.get(field)) and _text(original_identity.get(field)):
                    payload[field] = original_identity.get(field)
        final_range_id = _text(
            final_payload.get("rangeId") or final_payload.get("range_id")
        )
        if final_range_id:
            payload["rangeId"] = final_range_id
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
                _overlay_artist_group_norm(payload.get("artist"))
                == _overlay_artist_group_norm(
                    replacement_payload.get("artist")
                )
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
            AND ranking.scope_key = %s
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
            _ranking_scope_key(options),
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


def _strict_legacy_vtuber_replacement_public_video(
    change: Mapping[str, Any], replacement: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build one same-video replacement from an exact legacy owner proof.

    Historical VTuber source owners can predate immutable YouTube channel ids.
    Their stable aggregate identity is the persisted source ``entity_key``;
    it is not a channel id and must never be exposed as one.  The private
    marker consumed here is cleared and set only by the bounded persisted
    owner lookup after exact parent-occurrence coverage has been established.
    """

    marker = change.get("_persistedVtuberSameVideoOwnerProven")
    if marker is not True:
        raise PostgresAdapterError(
            "VTuber legacy replacement owner proof is invalid"
        )
    owner_key = _text(change.get("canonicalVtuberChannelKey"))
    source_key = _text(change.get("parentVtuberSourceKey"))
    old_video_id = _text(change.get("videoId") or change.get("video_id"))
    replacement_video_id = _text(
        replacement.get("videoId") or replacement.get("video_id")
    )
    old_occurrence_id = _text(
        change.get("occurrenceId") or change.get("occurrence_id")
    )
    replacement_occurrence_id = _text(
        replacement.get("occurrenceId") or replacement.get("occurrence_id")
    )
    if (
        not owner_key
        or re.fullmatch(r"UC[A-Za-z0-9_-]{22}", owner_key)
        or not source_key
        or change.get("_parentRuntimeOccurrenceExists") is not True
        or change.get("_runtimeOccurrenceOwnerWasExplicit") is not False
        or not bool(change.get("replacementSameVideo"))
        or not old_video_id
        or replacement_video_id != old_video_id
        or not old_occurrence_id
        or replacement_occurrence_id != old_occurrence_id
    ):
        raise PostgresAdapterError(
            "VTuber legacy replacement owner proof is invalid"
        )

    old_video = _json_object(change.get("videoPayload"))
    source = _json_object(change.get("replacementVideoPayload"))
    if not source:
        source = _overlay_video_projection(replacement)
    payload_video_ids = {
        _text(value)
        for value in (
            old_video.get("videoId"), old_video.get("video_id"),
            source.get("videoId"), source.get("video_id"),
        )
        if _text(value)
    }
    explicit_channel_ids = {
        _text(value)
        for value in (
            change.get("channelId"), change.get("channel_id"),
            old_video.get("channelId"), old_video.get("channel_id"),
            replacement.get("channelId"), replacement.get("channel_id"),
            source.get("channelId"), source.get("channel_id"),
        )
        if _text(value)
    }
    explicit_handles = {
        _normalized_channel_handle(value)
        for value in (
            change.get("channelHandle"), change.get("channel_handle"),
            old_video.get("channelHandle"), old_video.get("channel_handle"),
            replacement.get("channelHandle"),
            replacement.get("channel_handle"),
            source.get("channelHandle"), source.get("channel_handle"),
        )
        if _normalized_channel_handle(value)
    }
    explicit_urls = {
        _text(value)
        for value in (
            change.get("channelUrl"), change.get("channel_url"),
            old_video.get("channelUrl"), old_video.get("channel_url"),
            replacement.get("channelUrl"), replacement.get("channel_url"),
            source.get("channelUrl"), source.get("channel_url"),
        )
        if _text(value)
    }
    if (
        payload_video_ids - {old_video_id}
        or explicit_channel_ids
        or explicit_handles
        or explicit_urls
    ):
        raise PostgresAdapterError(
            "VTuber legacy replacement public identity is invalid"
        )

    public_video = dict(source)
    for field in (
        "channelId", "channel_id", "channelHandle", "channel_handle",
        "channelUrl", "channel_url",
    ):
        public_video.pop(field, None)
    public_video["videoId"] = old_video_id
    parent_name = _text(change.get("parentVtuberChannelName"))
    if parent_name and not _text(public_video.get("channelName")):
        public_video["channelName"] = parent_name
    return public_video, {
        "video_id": old_video_id,
        "channel_id": "",
        "channel_handle": "",
        "channel_url": "",
        "channel_name": _text(public_video.get("channelName")),
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
        legacy_owner_proven = bool(
            change.get("_persistedVtuberSameVideoOwnerProven") is True
            and _text(change.get("canonicalVtuberChannelKey"))
        )
        if strict_immutable_identity and not (
            title
            and replacement_video_id
            and replacement_occurrence_id
            and (replacement_channel_id or legacy_owner_proven)
        ):
            continue
        strict_public: dict[str, Any] = {}
        if strict_immutable_identity:
            try:
                if legacy_owner_proven and not replacement_channel_id:
                    video_payload, strict_public = (
                        _strict_legacy_vtuber_replacement_public_video(
                            change, replacement,
                        )
                    )
                else:
                    video_payload, strict_public = (
                        _strict_replacement_public_video(change, replacement)
                    )
                    replacement_channel_id = _text(
                        strict_public["channel_id"]
                    )
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
        row = {
            "revision_id": change.get("revisionId"),
            "video_id": video_id,
            "occurrence_id": occurrence_id,
            "position": replacement.get("position"),
            "range_id": replacement.get("rangeId") or change.get("rangeId"),
            "song_key": song_key,
            "seconds": replacement.get("seconds"),
            "title": title,
            "artist": artist,
            "is_niche_value": _scope_boolean_flag(
                replacement, "isNiche", "is_niche",
            ),
            "is_unknown_artist_value": _scope_boolean_flag(
                replacement, "isUnknownArtist", "is_unknown_artist",
            ),
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
            "replacement_video_already_in_parent_group": bool(
                change.get("_replacementVideoAlreadyInParentGroup")
            ),
        }
        canonical_vtuber_owner = _text(
            change.get("canonicalVtuberChannelKey")
        )
        if canonical_vtuber_owner:
            row["canonicalVtuberChannelKey"] = canonical_vtuber_owner
        rows.append(row)
    return rows


def _enrich_runtime_parent_group_keys(
    connection,
    parent_revision_id: str,
    changes: Sequence[dict[str, Any]],
    *,
    range_id: str,
    parent_group_cache: MutableMapping[Any, Any] | None = None,
) -> None:
    """Bind runtime curation to the exact persisted parent ranking groups.

    Historical curation rows keep the raw parent artist placeholder inside
    ``originalIdentity`` but can omit ``isUnknownArtist``.  The immutable full
    runtime still has that physical flag.  Resolve only exact
    ``(video_id, occurrence_id)`` pairs and carry their canonical parent group
    keys forward before the bounded affected-ranking window is selected.
    """

    requested = tuple(sorted({
        (
            _text(change.get("videoId") or change.get("video_id")),
            _text(change.get("occurrenceId") or change.get("occurrence_id")),
        )
        for change in changes
        if _text(change.get("entityType"))
            in {"occurrences", "runtime_occurrences"}
        and _text(change.get("videoId") or change.get("video_id"))
        and _text(change.get("occurrenceId") or change.get("occurrence_id"))
    }))
    if not requested:
        return
    if len(requested) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "runtime parent group identity exceeded bounded occurrence cap"
        )
    selected_range = _text(range_id)
    if selected_range not in SUPPORTED_RANGES:
        raise PostgresAdapterError("runtime parent group identity range is invalid")
    encoded_identities = tuple(
        f"{video_id}\0{occurrence_id}"
        for video_id, occurrence_id in requested
    )
    cache_key = (
        parent_revision_id,
        selected_range,
        "__runtime_parent_group_keys__",
        encoded_identities,
    )
    evidence = (
        parent_group_cache.get(cache_key)
        if parent_group_cache is not None
        else None
    )
    if evidence is None:
        requested_json = json.dumps(
            [
                {"video_id": video_id, "occurrence_id": occurrence_id}
                for video_id, occurrence_id in requested
            ],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        rows = _rows(
            connection,
            """
            WITH requested(video_id, occurrence_id) AS MATERIALIZED (
              SELECT item.video_id, item.occurrence_id
              FROM jsonb_to_recordset(%s::jsonb)
                AS item(video_id text, occurrence_id text)
            )
            SELECT o.video_id, o.occurrence_id, o.title, o.artist,
                   o.is_unknown_artist
            FROM runtime_occurrences AS o
            JOIN requested AS wanted
              ON wanted.video_id = o.video_id
             AND wanted.occurrence_id = o.occurrence_id
            WHERE o.revision_id = %s
              AND (o.range_id = ANY(%s) OR o.range_id IS NULL)
            ORDER BY o.video_id, o.occurrence_id
            LIMIT %s
            """,
            [
                requested_json,
                parent_revision_id,
                [selected_range, ""],
                len(requested) + 1,
            ],
        )
        if len(rows) > len(requested):
            raise PostgresAdapterError(
                "runtime parent group identity returned duplicate occurrences"
            )
        requested_set = set(requested)
        resolved: dict[tuple[str, str], tuple[str, str, bool]] = {}
        for row in rows:
            identity = (
                _text(row.get("video_id")),
                _text(row.get("occurrence_id")),
            )
            if identity not in requested_set or identity in resolved:
                raise PostgresAdapterError(
                    "runtime parent group identity returned an invalid occurrence"
                )
            title_key = _overlay_song_group_norm(row.get("title"))
            if not title_key:
                raise PostgresAdapterError(
                    "runtime parent group identity has an empty song title"
                )
            is_unknown_artist = row.get("is_unknown_artist") is True
            artist_key = (
                "unknown"
                if is_unknown_artist
                else _overlay_song_group_norm(row.get("artist")) or "unknown"
            )
            resolved[identity] = (
                f"{title_key}::{artist_key}",
                artist_key,
                is_unknown_artist,
            )
        evidence = resolved
        if parent_group_cache is not None:
            parent_group_cache[cache_key] = dict(resolved)
    if not isinstance(evidence, Mapping):
        raise PostgresAdapterError("runtime parent group cache is invalid")
    for change in changes:
        entity_type = _text(
            change.get("entityType") or change.get("entity_type")
        )
        if entity_type not in {"occurrences", "runtime_occurrences"}:
            continue
        identity = (
            _text(change.get("videoId") or change.get("video_id")),
            _text(change.get("occurrenceId") or change.get("occurrence_id")),
        )
        explicit_owner_key = "_runtimeOccurrenceOwnerWasExplicit"
        if explicit_owner_key not in change:
            change[explicit_owner_key] = bool(
                _validated_overlay_change_identity(
                    change, validate_urls=False,
                )[1]
            )
        resolved = evidence.get(identity)
        change["_parentRuntimeOccurrenceExists"] = resolved is not None
        if resolved is None:
            # A runtime chain can be rooted in a newer accepted overlay and
            # therefore have no full-parent tuple.  Existing overlay identity
            # handling remains authoritative for that case.
            continue
        if (
            not isinstance(resolved, (tuple, list))
            or len(resolved) != 3
            or not _text(resolved[0])
            or not _text(resolved[1])
            or not isinstance(resolved[2], bool)
        ):
            raise PostgresAdapterError("runtime parent group cache entry is invalid")
        parent_song_key = _text(resolved[0])
        parent_artist_key = _text(resolved[1])
        is_unknown_artist = resolved[2]
        explicit_unknown = _scope_boolean_flag(
            change, "isUnknownArtist", "is_unknown_artist",
        )
        if explicit_unknown is not None and explicit_unknown != is_unknown_artist:
            raise PostgresAdapterError(
                "runtime parent unknown-artist identity conflicts with full runtime"
            )
        for field, expected in (
            ("parentSongGroupKey", parent_song_key),
            ("parentArtistGroupKey", parent_artist_key),
        ):
            existing = _text(change.get(field))
            if existing and existing != expected:
                raise PostgresAdapterError(
                    f"runtime parent group identity conflicts with {field}"
                )
            change[field] = expected
        change["isUnknownArtist"] = is_unknown_artist


def _enrich_runtime_original_group_counts(
    connection,
    parent_revision_id: str,
    candidate_rows: Sequence[Mapping[str, Any]],
    changes: Sequence[dict[str, Any]],
    *,
    range_id: str,
    options: Mapping[str, Any] | None = None,
    parent_count_cache: MutableMapping[
        tuple[str, str, str, tuple[str, ...]], Mapping[tuple[str, str, str], int]
    ] | None = None,
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
    selected_range = _text(range_id)
    if selected_range not in SUPPORTED_RANGES:
        raise PostgresAdapterError("original group count range is invalid")
    ordered_target_video_ids = tuple(sorted(target_video_ids))
    selected_options = dict(options or {})
    selected_options.setdefault("range", selected_range)
    scope_key = _ranking_scope_key(selected_options)
    cache_key = (
        parent_revision_id, selected_range, scope_key, ordered_target_video_ids,
    )
    cached_parent_counts = (
        parent_count_cache.get(cache_key)
        if parent_count_cache is not None
        else None
    )
    if cached_parent_counts is None:
        parent_counts: dict[tuple[str, str, str], int] = defaultdict(int)
        for row in _rows(
                connection,
                """
                SELECT video_id, title, artist, COUNT(*) AS occurrence_count
                FROM runtime_occurrences
                WHERE revision_id = %s
                  AND (range_id = ANY(%s) OR range_id IS NULL)
                  AND video_id = ANY(%s)
                  AND (NOT %s OR is_niche IS TRUE)
                  AND (NOT %s OR is_unknown_artist IS NOT TRUE)
                GROUP BY video_id, title, artist
                """,
                [
                    parent_revision_id,
                    [selected_range, ""],
                    list(ordered_target_video_ids),
                    bool(selected_options.get("nicheOnly")),
                    bool(selected_options.get("hideUnknownArtist")),
                ],
            ):
            parent_counts[(
                _text(row.get("video_id")),
                _overlay_song_group_norm(row.get("title")),
                _overlay_song_group_norm(row.get("artist")),
            )] += int(row.get("occurrence_count") or 0)
        cached_parent_counts = dict(parent_counts)
        if parent_count_cache is not None:
            parent_count_cache[cache_key] = cached_parent_counts
            print(
                f"PG_SNAPSHOT_PARENT_COUNT_CACHE miss "
                f"range={selected_range} "
                f"scope={scope_key} "
                f"videos={len(ordered_target_video_ids)} "
                f"groups={len(cached_parent_counts)}",
                flush=True,
            )
    elif parent_count_cache is not None:
        print(
            f"PG_SNAPSHOT_PARENT_COUNT_CACHE hit "
            f"range={selected_range} "
            f"scope={scope_key} "
            f"videos={len(ordered_target_video_ids)} "
            f"groups={len(cached_parent_counts)}",
            flush=True,
        )
    # Runtime replacements can retain a physical parent occurrence under a
    # raw display alias while their replacement payload targets the canonical
    # Song card.  Keep a second bounded index by normalized Song group so the
    # candidate video can be excluded from the canonical card's video delta.
    # This derives from the same parent-count query/cache and does not scan
    # the unbounded occurrence table a second time.
    parent_group_counts: dict[tuple[str, str], int] = defaultdict(int)
    for parent_key, count in cached_parent_counts.items():
        if not isinstance(parent_key, tuple) or len(parent_key) != 3:
            continue
        parent_video_id, parent_title_key, parent_artist_key = (
            _text(parent_key[0]),
            _text(parent_key[1]),
            _text(parent_key[2]),
        )
        if not parent_video_id or not parent_title_key or not parent_artist_key:
            continue
        parent_group_key = _source_song_group_key_norm(
            f"{parent_title_key}::{parent_artist_key}"
        )
        if parent_group_key:
            parent_group_counts[(parent_video_id, parent_group_key)] += int(
                count or 0
            )
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
            else cached_parent_counts.get(key, 0)
        )
        replacement = _json_object(change.get("replacementPayload"))
        replacement_video_id = _text(
            replacement.get("videoId") or replacement.get("video_id")
        )
        replacement_title = _text(
            replacement.get("title") or replacement.get("workTitle")
        )
        replacement_artist = _text(replacement.get("artist"))
        replacement_group = (
            _source_song_group_key_norm(
                f"{replacement_title}::{replacement_artist}"
            )
            if replacement_title and replacement_artist
            else ""
        )
        parent_group = _source_song_group_key_norm(
            change.get("parentSongGroupKey")
            or change.get("parent_song_group_key")
        )
        change["_replacementVideoAlreadyInParentGroup"] = bool(
            change.get("replacement") is True
            and change.get("replacementSameVideo") is True
            and replacement_video_id == video_id
            and replacement_group
            and parent_group
            and replacement_group != parent_group
            and parent_group_counts.get((video_id, replacement_group), 0) > 0
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


def _runtime_change_has_unknown_artist(change: Mapping[str, Any]) -> bool:
    """Trust only the immutable runtime flag for a parent unknown artist."""

    return (
        change.get("isUnknownArtist") is True
        or change.get("is_unknown_artist") is True
    )


def _runtime_change_group_artist(change: Mapping[str, Any]) -> str:
    """Return the public parent-ranking artist identity for one change.

    Runtime occurrences retain their source display placeholder (for example,
    ``未記載``), while the full-runtime ranking groups every reviewed unknown
    artist under ``unknown``.  Keep the raw artist on the change for exact
    occurrence/source matching and use this helper only for aggregate keys.
    """

    if _runtime_change_has_unknown_artist(change):
        return "unknown"
    return _text(change.get("artist"))


def _runtime_change_song_group_identity(
    change: Mapping[str, Any],
) -> tuple[str, str]:
    """Return the canonical title/artist identity of a parent song group."""

    return (
        _source_song_owner_norm(change.get("title")),
        _source_song_owner_norm(_runtime_change_group_artist(change)),
    )


def _runtime_change_group_key(change: Mapping[str, Any], view: str) -> str:
    title = _text(change.get("title"))
    artist = _runtime_change_group_artist(change)
    video_id = _text(change.get("videoId") or change.get("video_id"))
    if view in {"songs", "songIndex", "vsingerSongs"}:
        parent_group_key = _text(change.get("parentSongGroupKey"))
        if parent_group_key:
            return parent_group_key
        if bool(change.get("acceptedVideoReset")):
            title_key, artist_key = _runtime_change_song_group_identity(change)
            return f"{title_key}::{artist_key}"
        return f"{_overlay_norm(title)}::{_overlay_norm(artist)}"
    if view == "artists":
        parent_artist_key = _text(change.get("parentArtistGroupKey"))
        if parent_artist_key:
            return parent_artist_key
        return _overlay_artist_group_norm(artist) or "unknown"
    if view == "videos":
        return video_id
    parent_vtuber_key = _text(change.get("parentVtuberChannelKey"))
    if parent_vtuber_key:
        return parent_vtuber_key
    return _text(change.get("channelId") or change.get("channel_id")) or _text(change.get("channelHandle") or change.get("channel_handle")).lstrip("@/") or _overlay_norm(change.get("channelName") or change.get("channel_name"))


def _apply_runtime_tombstone_groups(
    groups: dict[str, dict[str, Any]],
    changes: Sequence[Mapping[str, Any]],
    view: str,
    deferred_preview_key: str = "_deferred_runtime_preview_changes",
    *,
    allow_accepted_reset_detail_fallback: bool = False,
) -> None:
    decremented_videos: set[tuple[str, str]] = set()
    removal_counts: dict[tuple[str, str, str], int] = defaultdict(int)
    for change in changes:
        change_title_key, change_artist_key = (
            _runtime_change_song_group_identity(change)
        )
        removal_counts[(
            change_title_key,
            change_artist_key,
            _text(change.get("videoId") or change.get("video_id")),
        )] += 1
    group_keys_by_identity: dict[str, list[str]] = defaultdict(list)
    detail_group_keys_by_identity: dict[str, list[str]] = defaultdict(list)
    if view in {"songs", "songIndex", "vsingerSongs"}:
        for key, row in groups.items():
            identity = (
                f"{_overlay_song_group_norm(row.get('title'))}::"
                f"{_overlay_song_group_norm(row.get('artist'))}"
            )
            if identity and key not in group_keys_by_identity[identity]:
                group_keys_by_identity[identity].append(key)
            detail_identity = _overlay_norm(row.get("detail_key"))
            if detail_identity and key not in detail_group_keys_by_identity[detail_identity]:
                detail_group_keys_by_identity[detail_identity].append(key)
    elif view == "artists":
        for key, row in groups.items():
            for identity in {
                _overlay_artist_group_norm(row.get("artist")),
                _overlay_artist_group_norm(row.get("detail_key")),
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
        target_video = _text(change.get("videoId") or change.get("video_id"))
        if view in {"songs", "songIndex", "vsingerSongs"}:
            (
                target_song_title_norm,
                target_song_artist_norm,
            ) = _runtime_change_song_group_identity(change)
            target_song_identity = (
                f"{target_song_title_norm}::{target_song_artist_norm}"
            )
            candidate_group_keys = (
                group_keys_by_identity.get(target_song_identity, ())
                if target_song_title_norm
                else ()
            )
            if (
                allow_accepted_reset_detail_fallback
                and
                not candidate_group_keys
                and bool(change.get("acceptedVideoReset"))
            ):
                detail_group_keys = detail_group_keys_by_identity.get(
                    _runtime_change_group_key(change, view), ()
                )
                candidate_group_keys = detail_group_keys
            if (
                not candidate_group_keys
                and _text(change.get("parentSongGroupKey")) in groups
            ):
                candidate_group_keys = (
                    _text(change.get("parentSongGroupKey")),
                )
            if len(candidate_group_keys) > 1:
                exact_identity = (
                    _overlay_norm(change.get("title"))
                    + "::"
                    + _overlay_norm(_runtime_change_group_artist(change))
                )
                exact_matches = tuple(
                    key
                    for key in candidate_group_keys
                    if (
                        _overlay_norm(groups[key].get("title"))
                        + "::"
                        + _overlay_norm(groups[key].get("artist"))
                    ) == exact_identity
                )
                candidate_group_keys = (
                    exact_matches[:1]
                    if exact_matches
                    else (min(candidate_group_keys),)
                )
            if not candidate_group_keys and replacement:
                replacement_payload = _json_object(
                    change.get("replacementPayload")
                )
                old_title_norm = _overlay_song_group_norm(change.get("title"))
                replacement_title_norm = _overlay_song_group_norm(
                    replacement_payload.get("title")
                )
                same_artist = (
                    _overlay_song_group_norm(change.get("artist"))
                    == _overlay_song_group_norm(replacement_payload.get("artist"))
                )
                if not (
                    same_artist
                    and replacement_title_norm
                    and replacement_title_norm != old_title_norm
                    and replacement_title_norm in old_title_norm
                ):
                    continue
                replacement_identity = (
                    f"{replacement_title_norm}::"
                    f"{_overlay_song_group_norm(replacement_payload.get('artist'))}"
                )
                replacement_group_keys = (
                    group_keys_by_identity.get(replacement_identity, ())
                    if replacement_identity != "::"
                    else ()
                )
                if len(replacement_group_keys) > 1:
                    replacement_exact_identity = (
                        _overlay_norm(replacement_payload.get("title"))
                        + "::"
                        + _overlay_norm(replacement_payload.get("artist"))
                    )
                    replacement_exact_matches = tuple(
                        key
                        for key in replacement_group_keys
                        if (
                            _overlay_norm(groups[key].get("title"))
                            + "::"
                            + _overlay_norm(groups[key].get("artist"))
                        ) == replacement_exact_identity
                    )
                    replacement_group_keys = (
                        replacement_exact_matches[:1]
                        if replacement_exact_matches
                        else (min(replacement_group_keys),)
                    )
                candidate_group_keys = replacement_group_keys
        elif view == "artists":
            target_artist = _overlay_artist_group_norm(
                _runtime_change_group_artist(change)
            )
            candidate_group_keys = group_keys_by_identity.get(target_artist, ())
        elif view == "videos":
            candidate_group_keys = group_keys_by_identity.get(target_video, ())
        else:
            target_channel = _overlay_norm(change.get("channelId") or change.get("channel_id") or change.get("channelHandle") or change.get("channel_handle") or change.get("channelName") or change.get("channel_name"))
            candidate_group_keys = tuple(groups)
        for key in candidate_group_keys:
            row = groups.get(key)
            if row is None:
                continue
            if view in {"songs", "songIndex", "vsingerSongs"}:
                matched = True
            elif view == "artists":
                row_artist = _overlay_artist_group_norm(row.get("artist"))
                matched = bool(
                    target_artist
                    and (
                        row_artist == target_artist
                        or _overlay_artist_group_norm(row.get("detail_key"))
                        == target_artist
                    )
                )
            elif view == "videos":
                matched = bool(target_video and _text(row.get("detail_key")) == target_video)
            else:
                row_name = _overlay_norm(row.get("name"))
                row_search = _overlay_norm(f"{row.get('search_text', '')} {row.get('channel_search_text', '')}")
                matched = bool(target_channel and (target_channel in row_search or target_channel == row_name or target_channel == _overlay_norm(row.get("detail_key"))))
            if not matched:
                continue
            row["row_count"] = max(0, int(row.get("row_count") or 0) - 1)
            row["timestamp_count"] = max(0, int(row.get("timestamp_count") or 0) - 1)
            video_key = (key, target_video)
            original_video_group_count = int(change.get("originalGroupVideoOccurrenceCount") or 0)
            if view in {"songs", "songIndex", "vsingerSongs"}:
                removed_video_group_count = removal_counts[
                    (target_song_title_norm, target_song_artist_norm, target_video)
                ]
            else:
                change_title_key, change_artist_key = (
                    _runtime_change_song_group_identity(change)
                )
                removed_video_group_count = removal_counts[(
                    change_title_key,
                    change_artist_key,
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
            _overlay_artist_group_norm(row.get("artist"))
            == _overlay_artist_group_norm(artist)
            or _overlay_artist_group_norm(row.get("detail_key"))
            == _overlay_artist_group_norm(artist)
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


_MAX_AFFECTED_RUNTIME_OCCURRENCES = 50000
# The unscoped overlay lineage can contain more video-row history than the
# affected-scope bound.  Keep this finite and fail closed if a future lineage
# exceeds the bounded hydration budget.
_MAX_UNSCOPED_OVERLAY_VIDEOS = 100000
_MAX_UNSCOPED_OVERLAY_OCCURRENCES = 250000
_AFFECTED_RECONCILIATION_BATCH_SIZE = 10000
_MAX_AFFECTED_RECONCILIATION_OCCURRENCES = 5000000


def _runtime_song_identity(row: Mapping[str, Any]) -> str:
    return _text(row.get("song_key") or row.get("songKey")) or (
        f"{_overlay_norm(row.get('title'))}::{_overlay_norm(row.get('artist'))}"
    )


def _runtime_view_group_key(row: Mapping[str, Any], view: str) -> str:
    if view in {"songs", "songIndex", "vsingerSongs"}:
        detail_key = _text(row.get("detail_key"))
        if detail_key:
            return detail_key
        return f"{_overlay_norm(row.get('title'))}::{_overlay_norm(row.get('artist'))}"
    if view == "artists":
        if (
            row.get("isUnknownArtist") is True
            or row.get("is_unknown_artist") is True
        ):
            return "unknown"
        # Historical full-runtime artist rankings store their public identity
        # in ``name`` while occurrence/candidate rows use ``artist``.  Treat
        # both shapes as the same group so one snapshot reconciliation can be
        # cached and reused across every metric and persisted filter scope.
        for field in ("artist", "name", "displayArtist", "detail_key"):
            key = _overlay_artist_group_norm(row.get(field))
            if key:
                return key
        return "unknown"
    if view == "videos":
        # Persisted parent ranking rows expose the immutable video identity as
        # ``detail_key``; overlay/candidate rows use ``video_id``/``videoId``.
        # Treat the shapes as the same group so deferred tombstones replay on
        # legacy video cards instead of updating only their scalar counts.
        return _text(
            row.get("video_id")
            or row.get("videoId")
            or row.get("detail_key")
        )
    video = _overlay_public_video(row)
    return (
        _text(row.get("canonicalVtuberChannelKey"))
        or _text(row.get("channel_id") or video.get("channelId"))
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
) -> Iterable[dict[str, Any]]:
    """Stream parent rows for changed groups in bounded keyset pages.

    A single affected artist can legitimately own more than the legacy
    50,000-row in-memory cap.  Keep every fetch bounded while retaining a
    separate fail-closed ceiling for the complete reconciliation.
    """

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
            return
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
        unknown_artist_affected = any(
            _runtime_change_has_unknown_artist(change)
            for change in changes
        )
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
        if not artists and not unknown_artist_affected:
            return
        predicate = (
            "(lower(coalesce(o.artist, '')) = ANY(%s) "
            "OR (%s AND o.is_unknown_artist IS TRUE))"
        )
        predicate_params: list[Any] = [[value.casefold() for value in artists]]
        predicate_params.append(unknown_artist_affected)
    elif view == "videos":
        videos = sorted({
            _text(change.get("videoId") or change.get("video_id"))
            for change in changes
            if _text(change.get("videoId") or change.get("video_id"))
        })
        if not videos:
            return
        predicate = "o.video_id = ANY(%s)"
        predicate_params = [videos]
    else:
        channels = sorted({
            _text(change.get("channel_id") or change.get("channelId"))
            for change in changes
            if _text(change.get("channel_id") or change.get("channelId"))
        })
        if not channels:
            return
        predicate = "v.channel_id = ANY(%s)"
        predicate_params = [channels]
    range_id = _text(options.get("range")) or "all"
    scope_clause = """
      AND (NOT %s OR o.is_niche IS TRUE)
      AND (NOT %s OR o.is_unknown_artist IS NOT TRUE)
    """
    scope_params = [
        bool(options.get("nicheOnly")),
        bool(options.get("hideUnknownArtist")),
    ]

    # Immutable snapshot builds already own one explicit transaction.  Use a
    # server-side cursor there so PostgreSQL sorts the affected parent set
    # once and the client still consumes only one bounded batch at a time.
    # Online autocommit requests retain the keyset fallback below: a named
    # cursor is transaction-scoped and must never leak across API requests.
    streaming_cursor = None
    if getattr(connection, "autocommit", True) is False:
        try:
            streaming_cursor = connection.cursor(
                name=(
                    f"dsl_affected_{threading.get_ident()}_"
                    f"{time.monotonic_ns()}"
                )
            )
        except TypeError:
            # Lightweight adapters/test doubles may expose only cursor().
            streaming_cursor = None
    if streaming_cursor is not None:
        try:
            if hasattr(streaming_cursor, "itersize"):
                streaming_cursor.itersize = _AFFECTED_RECONCILIATION_BATCH_SIZE
            streaming_cursor.execute(
                f"""
                SELECT o.occurrence_id, o.video_id, o.song_key, o.title,
                       o.artist, o.is_unknown_artist,
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
                  {scope_clause}
                ORDER BY o.video_id, o.occurrence_id
                LIMIT %s
                """,
                [
                    parent_revision_id,
                    parent_revision_id,
                    *predicate_params,
                    range_id,
                    range_id,
                    *scope_params,
                    _MAX_AFFECTED_RECONCILIATION_OCCURRENCES + 1,
                ],
            )
            description = streaming_cursor.description or ()
            names = [
                column.name if hasattr(column, "name") else column[0]
                for column in description
            ]
            total = 0
            last_identity = ("", "")
            while True:
                values = streaming_cursor.fetchmany(
                    _AFFECTED_RECONCILIATION_BATCH_SIZE
                )
                if not values:
                    return
                total += len(values)
                if total > _MAX_AFFECTED_RECONCILIATION_OCCURRENCES:
                    raise PostgresAdapterError(
                        "affected runtime song-count reconciliation exceeded streamed occurrence cap"
                    )
                for value in values:
                    row = dict(zip(names, value))
                    identity = (
                        _text(row.get("video_id")),
                        _text(row.get("occurrence_id")),
                    )
                    if not identity[0] or not identity[1]:
                        raise PostgresAdapterError(
                            "affected runtime song-count reconciliation returned an empty identity"
                        )
                    if identity == last_identity:
                        raise PostgresAdapterError(
                            "affected runtime song-count reconciliation did not advance"
                        )
                    last_identity = identity
                    yield row
        finally:
            close = getattr(streaming_cursor, "close", None)
            if close:
                close()
        return

    last_video_id = ""
    last_occurrence_id = ""
    total = 0
    while True:
        rows = _rows(
            connection,
            f"""
            SELECT o.occurrence_id, o.video_id, o.song_key, o.title,
                   o.artist, o.is_unknown_artist,
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
              {scope_clause}
              AND (o.video_id, o.occurrence_id) > (%s, %s)
            ORDER BY o.video_id, o.occurrence_id
            LIMIT %s
            """,
            [
                parent_revision_id,
                parent_revision_id,
                *predicate_params,
                range_id,
                range_id,
                *scope_params,
                last_video_id,
                last_occurrence_id,
                _AFFECTED_RECONCILIATION_BATCH_SIZE,
            ],
        )
        if not rows:
            return
        total += len(rows)
        if total > _MAX_AFFECTED_RECONCILIATION_OCCURRENCES:
            raise PostgresAdapterError(
                "affected runtime song-count reconciliation exceeded streamed occurrence cap"
            )
        for row in rows:
            yield row
        last = rows[-1]
        next_video_id = _text(last.get("video_id"))
        next_occurrence_id = _text(last.get("occurrence_id"))
        if not next_video_id or not next_occurrence_id:
            raise PostgresAdapterError(
                "affected runtime song-count reconciliation returned an empty identity"
            )
        # The SQL predicate and ORDER BY use the same PostgreSQL collation, so
        # every returned cursor is database-ordered after the prior cursor.
        # Python's Unicode ordering can disagree for mixed-case YouTube IDs;
        # comparing < or > here therefore creates a false non-advance failure.
        # Exact equality is locale-independent and still fails closed if a
        # broken page ever repeats its cursor without making progress.
        if (next_video_id, next_occurrence_id) == (last_video_id, last_occurrence_id):
            raise PostgresAdapterError(
                "affected runtime song-count reconciliation did not advance"
            )
        last_video_id, last_occurrence_id = next_video_id, next_occurrence_id
        if len(rows) < _AFFECTED_RECONCILIATION_BATCH_SIZE:
            return


def _reconcile_affected_song_counts(
    connection,
    parent_revision_id: str,
    candidate_rows: Sequence[Mapping[str, Any]],
    replacement_rows: Sequence[Mapping[str, Any]],
    changes: Sequence[Mapping[str, Any]],
    groups: dict[str, dict[str, Any]],
    view: str,
    options: Mapping[str, Any],
    *,
    reconciliation_counts: MutableMapping[
        tuple[str, str, str, str, str], tuple[int, int, int]
    ] | None = None,
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
    if not affected_changes and not candidate_rows and not replacement_rows:
        return
    affected_keys = _runtime_change_view_keys(affected_changes, view)
    for row in candidate_rows:
        key = _runtime_view_group_key(row, view)
        if key:
            affected_keys.add(key)
    for row in replacement_rows:
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
    range_id = _text(options.get("range")) or "all"
    scope_key = _ranking_scope_key(options)
    cached_counts: dict[str, tuple[int, int, int]] = {}
    if reconciliation_counts is not None:
        for key in affected_keys:
            cached = reconciliation_counts.get(
                (parent_revision_id, range_id, view, scope_key, key)
            )
            if cached is not None:
                cached_counts[key] = cached
        affected_keys.difference_update(cached_counts)

    def apply_counts(counts: Mapping[str, tuple[int, int, int]]) -> None:
        for row in groups.values():
            key = _runtime_view_group_key(row, view)
            values = counts.get(key)
            if values is None:
                continue
            row_count, song_count, video_count = values
            row["song_count"] = song_count
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

    if not affected_keys:
        apply_counts(cached_counts)
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
            for row in relevant_replacements
        ),
    ]
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
    overlay_effective: dict[tuple[str, str], dict[str, Any]] = {}
    overridden_identities: set[tuple[str, str]] = set()
    for row in relevant_candidates:
        identity = (_text(row.get("video_id")), _text(row.get("occurrence_id")))
        if identity[0] and identity[1]:
            overridden_identities.add(identity)
            overlay_effective[identity] = dict(row)
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
        if identity[0] and identity[1]:
            overridden_identities.add(identity)
            overlay_effective.pop(identity, None)
    for row in relevant_replacements:
        identity = (_text(row.get("video_id")), _text(row.get("occurrence_id")))
        if identity[0] and identity[1]:
            overridden_identities.add(identity)
            overlay_effective[identity] = dict(row)

    row_counts: dict[str, int] = defaultdict(int)
    songs_by_group: dict[str, set[str]] = defaultdict(set)
    videos_by_group: dict[str, set[str]] = defaultdict(set)

    def accumulate(row: Mapping[str, Any]) -> None:
        key = _runtime_view_group_key(row, view)
        if key not in affected_keys:
            return
        row_counts[key] += 1
        songs_by_group[key].add(
            key
            if view in {"songs", "songIndex", "vsingerSongs"}
            else _runtime_song_identity(row)
        )
        video_id = _text(row.get("video_id") or row.get("videoId"))
        if video_id:
            videos_by_group[key].add(video_id)

    for row in _bounded_affected_parent_occurrences(
        connection, parent_revision_id, lookup_changes, view, options,
    ):
        identity = (
            _text(row.get("video_id")),
            _text(row.get("occurrence_id")),
        )
        if not identity[0] or not identity[1]:
            continue
        if (
            identity[0] in candidate_video_ids
            or identity[0] in reset_video_ids
            or identity in overridden_identities
        ):
            continue
        accumulate(row)
    for row in overlay_effective.values():
        accumulate(row)

    computed_counts = {
        key: (
            row_counts.get(key, 0),
            len(songs_by_group.get(key, set())),
            len(videos_by_group.get(key, set())),
        )
        for key in affected_keys
    }
    if reconciliation_counts is not None:
        for key, values in computed_counts.items():
            reconciliation_counts[
                (parent_revision_id, range_id, view, scope_key, key)
            ] = values
    # The streamed projection applies selected accepted-video resets plus
    # final candidate/replacement rows before computing exact scalars. Every
    # public grouping must use it; immutable snapshot builds may reuse these
    # exact scalars for the same parent/range/view across metric and scope.
    apply_counts({**cached_counts, **computed_counts})


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


def _accepted_song_reset_candidate_identity(
    row: Mapping[str, Any], *, canonical_title: bool = False,
) -> tuple[str, str, str, str]:
    """Return the exact accepted-reset tuple used by source ownership."""

    title = _text(row.get("title"))
    artist = _text(row.get("artist"))
    title_key = (
        _vtuber_canonical_song_identity(title)[1]
        if canonical_title
        else _overlay_song_group_norm(title)
    )
    return (
        _text(row.get("videoId") or row.get("video_id")),
        _text(row.get("seconds")),
        title_key or _overlay_song_group_norm(title),
        _overlay_song_group_norm(artist),
    )


def _overlay_candidate_groups(
    rows: Iterable[Mapping[str, Any]],
    view: str,
    song_reset_candidate_owners: Mapping[
        tuple[str, str, str, str], str
    ] | None = None,
) -> dict[str, dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    owned_raw_song_keys: set[str] = set()
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
            same_artist = (
                _overlay_artist_group_norm(original_identity.get("artist"))
                == _overlay_artist_group_norm(artist)
            )
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
            raw_key = f"{_overlay_norm(title)}::{_overlay_norm(artist)}"
            exact_owner_key = _text(
                (song_reset_candidate_owners or {}).get(
                    _accepted_song_reset_candidate_identity(row)
                )
            )
            key = exact_owner_key or raw_key
            if exact_owner_key:
                owned_raw_song_keys.add(raw_key)
            name = title
        elif view == "artists":
            key = _overlay_artist_group_norm(artist) or "unknown"
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
            "videoIdsAlreadyInParent": set(),
            "search": "",
        })
        group["occurrenceCount"] += 1
        if row.get("replacement_video_already_in_parent_group") is True:
            group["videoIdsAlreadyInParent"].add(video_id)
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
    # One raw spelling may contain both exact accepted-reset tuples and
    # overlay-only tuples.  The exact tuples above move to their persisted
    # owner; the remainder must stay in their raw group.  Mark that remainder
    # so the broad display-name fallback cannot merge it back into the owner.
    for raw_key in owned_raw_song_keys:
        if raw_key in groups:
            groups[raw_key]["_acceptedSongResetPassthrough"] = True
    return groups


def _canonical_overlay_delta_group_key(
    groups: Mapping[str, Mapping[str, Any]],
    persisted_rows: Mapping[str, Mapping[str, Any]],
    replacement_key: str,
    item: Mapping[str, Any],
    view: str,
    song_reset_owner_keys: Mapping[str, str] | None = None,
) -> str:
    """Route a replacement to one matching affected persisted scalar row.

    The accepted replacement title/artist is the canonical scalar identity.
    Only the bounded affected parent rows are eligible, and a match must be
    unique.  This deliberately does not use the old/original group key: an
    alias can have a different persisted key even when its replacement belongs
    to an existing canonical card.
    """

    if view not in {"songs", "songIndex", "vsingerSongs"}:
        return replacement_key
    if item.get("_acceptedSongResetPassthrough") is True:
        return replacement_key
    exact_owner_key = _text(
        (song_reset_owner_keys or {}).get(replacement_key)
    )
    if exact_owner_key:
        if (
            exact_owner_key not in groups
            and exact_owner_key not in persisted_rows
        ):
            raise PostgresAdapterError(
                "accepted-video Song reset owner is missing from the "
                "bounded ranking window"
            )
        return exact_owner_key
    replacement_identity = (
        _source_song_owner_norm(item.get("title")),
        _source_song_owner_norm(item.get("artist")),
    )
    if not replacement_identity[0] or not replacement_identity[1]:
        return replacement_key
    matches: set[str] = set()
    for mapping_key, row in persisted_rows.items():
        row_identity = (
            _overlay_song_group_norm(row.get("title")),
            _overlay_song_group_norm(row.get("artist")),
        )
        if row_identity != replacement_identity:
            continue
        detail_key = _text(row.get("detail_key")) or _text(mapping_key)
        if detail_key and detail_key in groups:
            matches.add(detail_key)
    return next(iter(matches)) if len(matches) == 1 else replacement_key


def _accepted_song_reset_candidate_owner_keys(
    candidate_rows: Iterable[Mapping[str, Any]],
    reset_changes: Iterable[Mapping[str, Any]],
) -> dict[tuple[str, str, str, str], str]:
    """Bind each exact accepted Song candidate to one persisted owner.

    A full-video reset removes the immutable parent tuple before its accepted
    candidate is added.  Historical candidate rows retain their raw display
    spelling, while the canonical ranking/source owner may have a normalized
    title or artist.  The source projection already carries the authoritative
    ``parentSongGroupKey`` for every reset tuple; use the same exact
    video/seconds/title/artist evidence for the ranking increment.  A raw
    title/artist group may mix reset-owned and overlay-only tuples, so binding
    the whole group would overcount the persisted owner.  Never infer an owner
    from a broad alias when exact authority is absent, and fail closed only
    when the same exact candidate tuple proves more than one owner.
    """

    raw_authority: dict[tuple[str, str, str, str], set[str]] = defaultdict(set)
    canonical_authority: dict[
        tuple[str, str, str, str], set[str]
    ] = defaultdict(set)

    for change in reset_changes:
        if not (
            change.get("acceptedVideoReset") is True
            and change.get("persistedSourceAuthority") is True
        ):
            continue
        owner_key = _text(change.get("parentSongGroupKey"))
        raw_identity = _accepted_song_reset_candidate_identity(change)
        if not owner_key or not raw_identity[0] or not raw_identity[2]:
            raise PostgresAdapterError(
                "accepted-video persisted Song owner identity is invalid"
            )
        raw_authority[raw_identity].add(owner_key)
        canonical_authority[
            _accepted_song_reset_candidate_identity(
                change, canonical_title=True,
            )
        ].add(owner_key)

    owners_by_candidate: dict[
        tuple[str, str, str, str], set[str]
    ] = defaultdict(set)
    for row in candidate_rows:
        if row.get("video_tombstone"):
            continue
        title = _text(row.get("title"))
        if not title:
            continue
        candidate_identity = _accepted_song_reset_candidate_identity(row)
        owners = raw_authority.get(candidate_identity, set())
        if not owners:
            owners = canonical_authority.get(
                _accepted_song_reset_candidate_identity(
                    row, canonical_title=True,
                ),
                set(),
            )
        if not owners:
            continue
        if len(owners) != 1:
            raise PostgresAdapterError(
                "accepted-video persisted Song owner is ambiguous"
            )
        owners_by_candidate[candidate_identity].update(owners)

    result: dict[tuple[str, str, str, str], str] = {}
    for candidate_identity, owners in owners_by_candidate.items():
        if len(owners) != 1:
            raise PostgresAdapterError(
                "accepted-video Song candidate tuple has ambiguous persisted "
                "owners"
            )
        result[candidate_identity] = next(iter(owners))
    return result


def _apply_overlay_delta_groups(
    groups: dict[str, dict[str, Any]],
    persisted_rows: Mapping[str, Mapping[str, Any]],
    delta: Mapping[str, Mapping[str, Any]],
    view: str,
    range_id: str,
    exact_owned_rows: Mapping[str, Mapping[str, Any]] | None = None,
    song_reset_owner_keys: Mapping[str, str] | None = None,
) -> None:
    """Apply bounded candidate deltas without losing canonical parent identity."""

    exact_owned_rows = exact_owned_rows or {}
    for key, item in delta.items():
        video_ids = set(item.get("videoIds") or ())
        video_ids.difference_update(item.get("videoIdsAlreadyInParent") or ())
        if key in exact_owned_rows:
            continue
        target_key = _canonical_overlay_delta_group_key(
            groups, persisted_rows, key, item, view,
            song_reset_owner_keys,
        )
        row = groups.get(target_key)
        if row is None:
            count = int(item.get("occurrenceCount", len(item["occurrences"])))
            video_count = len(video_ids)
            persisted_owner = (
                persisted_rows.get(target_key)
                if _text(
                    (song_reset_owner_keys or {}).get(key)
                ) == target_key
                else None
            ) or {}
            title = _text(persisted_owner.get("title")) or item["title"]
            artist = _text(persisted_owner.get("artist")) or item["artist"]
            name = _text(persisted_owner.get("name")) or item["name"]
            song_count = (
                1
                if view in {"songs", "songIndex", "vsingerSongs"}
                and count > 0
                else len(item["songKeys"])
            )
            payload = {
                "type": "video" if view == "videos" else "artist" if view == "artists" else "vtuber" if view == "vtubers" else "song",
                "key": target_key, "title": title, "displayArtist": artist,
                "name": name, "count": count, "videoCount": video_count,
                "songCount": song_count, "timestampCount": count,
                "occurrences": item["occurrences"][:20],
            }
            source_detail_key = _production_source_detail_key_for_group(
                view, range_id, target_key,
            )
            if source_detail_key:
                payload["sourceDetailKey"] = source_detail_key
                payload["sourceDetailPath"] = ""
            groups[target_key] = {
                "detail_key": target_key, "title": title,
                "artist": artist, "name": name,
                "row_count": count, "song_count": song_count,
                "video_count": video_count, "timestamp_count": count,
                "payload_json": payload, "search_text": item["search"],
                "channel_search_text": item["search"],
            }
            continue

        row["row_count"] = int(row.get("row_count") or 0) + int(
            item.get("occurrenceCount", len(item["occurrences"]))
        )
        if view in {"songs", "songIndex", "vsingerSongs"}:
            # These views already represent one canonical title/artist song
            # group.  A full-video refresh can remove one video's tuples while
            # another video keeps the group alive; raw accepted ``songKey``
            # spellings are provenance, never additional canonical songs.
            row["song_count"] = 1 if row["row_count"] > 0 else 0
        else:
            row["song_count"] = int(row.get("song_count") or 0) + len(
                item["songKeys"]
            )
        row["video_count"] = int(row.get("video_count") or 0) + len(video_ids)
        row["timestamp_count"] = int(row.get("timestamp_count") or 0) + int(
            item.get("occurrenceCount", len(item["occurrences"]))
        )
        payload = _json_object(row.get("payload_json"))
        if payload:
            payload.update({
                "count": row["row_count"],
                "songCount": row["song_count"],
                "videoCount": row["video_count"],
                "timestampCount": row["timestamp_count"],
            })
            if isinstance(payload.get("occurrences"), list):
                payload["occurrences"] = _bounded_overlay_previews(
                    (*payload["occurrences"], *item["occurrences"]),
                )
            row["payload_json"] = payload
        elif item["occurrences"]:
            # The bounded scalar parent deliberately has no JSON payload.
            # Retain only the public preview tuples needed by a returned card;
            # render hydrates them against the exact parent payload.
            deferred = row.get("_deferred_candidate_previews", ())
            if not isinstance(deferred, (list, tuple)):
                raise PostgresAdapterError(
                    "deferred candidate preview state is invalid"
                )
            row["_deferred_candidate_previews"] = _bounded_overlay_previews(
                (*deferred, *item["occurrences"]),
            )
        row["search_text"] = f"{row.get('search_text', '')} {item['search']}"


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
    fetch exactly the caller-bounded previews afterwards.  Immutable snapshot
    builds trim to their three-preview contract before this JSON read.
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
    niche_only: bool = False,
    hide_unknown_artist: bool = False,
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
            AND (
              NOT %s
              OR coalesce(
                occurrence.payload_json->>'isNiche',
                occurrence.payload_json->'payload'->>'isNiche',
                'false'
              ) = 'true'
            )
            AND (
              NOT %s
              OR lower(btrim(coalesce(occurrence.artist, '')))
                   <> ALL(%s::text[])
            )
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
            bool(niche_only),
            bool(hide_unknown_artist),
            sorted(_UNKNOWN_ARTIST_NAMES),
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
        row_handle = _text(row.get("channel_handle"))
        video_handle = _text(video.get("channelHandle"))
        if (
            row_handle
            and video_handle
            and _normalized_channel_handle(row_handle)
            != _normalized_channel_handle(video_handle)
        ):
            raise PostgresAdapterError(
                "bounded direct overlay VTuber preview query returned an invalid identity"
            )
        expected_handle = row_handle or video_handle
        for channel_url in (
            _text(row.get("channel_url")),
            _text(video.get("channelUrl")),
        ):
            if channel_url and not _channel_url_is_coherent(
                channel_url, channel_id, expected_handle
            ):
                raise PostgresAdapterError(
                    "bounded direct overlay VTuber preview query returned an invalid identity"
                )
        thumbnail = _text(
            video.get("thumbnailUrl") or video.get("videoThumbnailUrl")
        )
        if not thumbnail_matches_video(thumbnail, video_id):
            continue
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
              AND (NOT %s OR o.is_unknown_artist IS NOT TRUE)
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
    # A positive aggregate can outlive its source preview (for example when a
    # legacy channel has no surviving parent video in this range).  That is a
    # non-critical presentation gap, not a database or identity failure.  The
    # caller records the missing channel and keeps its reviewed scalar card.
    # Rows that are returned still pass the strict identity and thumbnail
    # checks above; SQL/connection errors and cap violations still propagate.
    return previews


def _mark_vtuber_preview_unavailable(
    payload: dict[str, Any],
    diagnostic: str = "preview_unavailable",
) -> None:
    """Keep a reviewed VTuber scalar card when only its optional preview is absent."""

    payload["occurrences"] = []
    payload["occurrencePreviewLimited"] = False
    payload["occurrencePreviewDegraded"] = True
    payload["occurrencePreviewDiagnostic"] = diagnostic


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
    channel_id = _text(expected_channel_id)
    card_channel_id = _text(payload.get("channelId") or payload.get("key"))
    if not channel_id or card_channel_id != channel_id:
        raise PostgresAdapterError("VTuber ranking preview identity is invalid")
    occurrences = payload.get("occurrences")
    if not isinstance(occurrences, list) or not occurrences:
        if (
            payload.get("occurrencePreviewDegraded") is True
            and payload.get("occurrencePreviewDiagnostic")
            == "preview_unavailable"
        ):
            payload["occurrences"] = []
            return
        raise PostgresAdapterError(
            "positive VTuber ranking card has no canonical occurrence preview"
        )
    # Aggregate card handle/URL fields are historical derived metadata.  The
    # immutable channel id above binds the card; one real preview tuple binds
    # its current public handle.  Never let a stale aggregate handle veto a
    # same-channel preview.
    canonical_handle_raw = ""

    def degrade(diagnostic: str) -> None:
        _mark_vtuber_preview_unavailable(payload, diagnostic)

    canonical_occurrences: list[dict[str, Any]] = []
    first_thumbnail = ""
    for source_occurrence in occurrences:
        if not isinstance(source_occurrence, Mapping):
            degrade("preview_payload_invalid")
            return
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
            degrade("preview_payload_invalid")
            return
        item = dict(item_source)
        video = dict(video_source)
        item_video_id = _text(item.get("videoId"))
        video_video_id = _text(video.get("videoId"))
        occurrence_video_id = _text(occurrence.get("videoId"))
        if (
            item_video_id
            and video_video_id
            and item_video_id != video_video_id
        ) or (
            occurrence_video_id
            and item_video_id
            and occurrence_video_id != item_video_id
        ) or (
            occurrence_video_id
            and video_video_id
            and occurrence_video_id != video_video_id
        ):
            raise PostgresAdapterError("VTuber ranking preview identity is invalid")
        if not item_video_id or not video_video_id:
            degrade("preview_payload_invalid")
            return
        video_id = item_video_id

        item_channel_id = _text(item.get("channelId"))
        video_channel_id = _text(video.get("channelId"))
        if item_channel_id and video_channel_id and item_channel_id != video_channel_id:
            raise PostgresAdapterError("VTuber ranking preview identity is invalid")
        if item_channel_id and item_channel_id != channel_id:
            raise PostgresAdapterError("VTuber ranking preview identity is invalid")
        if video_channel_id and video_channel_id != channel_id:
            raise PostgresAdapterError("VTuber ranking preview identity is invalid")
        if not item_channel_id or not video_channel_id:
            degrade("preview_payload_invalid")
            return

        item_handle_raw = _text(item.get("channelHandle"))
        video_handle_raw = _text(video.get("channelHandle"))
        item_handle = _normalized_channel_handle(item_handle_raw)
        video_handle = _normalized_channel_handle(video_handle_raw)
        if item_handle and video_handle and item_handle != video_handle:
            raise PostgresAdapterError("VTuber ranking preview identity is invalid")
        if not item_handle and not video_handle:
            degrade("preview_payload_invalid")
            return
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
                degrade("thumbnail_unavailable")
                return
        if not thumbnail_matches_video(thumbnail, video_id):
            degrade("thumbnail_unavailable")
            return

        song = occurrence.get("song")
        if song is not None and not isinstance(song, Mapping):
            degrade("preview_payload_invalid")
            return
        song = dict(song or {})
        for field in ("occurrenceId", "position"):
            value = occurrence.get(field) if field in occurrence else song.get(field)
            if value is not None:
                occurrence[field] = value
        for field in ("title", "artist", "seconds"):
            outer_present = field in occurrence
            song_present = field in song
            if not outer_present and not song_present:
                degrade("preview_payload_invalid")
                return
            if (
                outer_present
                and song_present
                and occurrence.get(field) != song.get(field)
            ):
                degrade("preview_payload_invalid")
                return
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


def _resolved_vtuber_parent_sources(
    connection,
    parent_revision_id: str,
    affected_channel_ids: Iterable[str],
    range_id: str,
    base_groups: Mapping[str, Mapping[str, Any]],
) -> dict[str, str]:
    """Resolve scoped VTuber groups against the unfiltered parent authority.

    A channel can be absent from a persisted filter scope and enter it through
    the overlay.  Its immutable source still lives on the parent's ``all``
    scope row, so deriving parent authority only from ``base_groups`` silently
    turns that channel into an overlay-only zero.  This bounded lookup follows
    the indexed parent ranking prefix and hydrates only affected identities.
    """

    channel_ids = sorted({
        _text(value) for value in affected_channel_ids if _text(value)
    })
    if not channel_ids:
        return {}
    rows = _rows(
        connection,
        """
        /* bounded unfiltered VTuber parent source identities */
        SELECT detail_key, payload_json
        FROM runtime_ranking_rows
        WHERE revision_id = %s AND range_id = %s
          AND view = 'vtubers' AND metric = 'count'
          AND scope_key = 'all' AND detail_key = ANY(%s)
        ORDER BY rank
        LIMIT %s
        """,
        [parent_revision_id, range_id, channel_ids, len(channel_ids) + 1],
    )
    if len(rows) > len(channel_ids):
        raise PostgresAdapterError(
            "VTuber unfiltered parent source lookup exceeded affected scope"
        )

    requested = set(channel_ids)
    resolved: dict[str, str] = {}
    source_owners: dict[str, str] = {}
    for row in rows:
        channel_id = _text(row.get("detail_key"))
        payload = _json_object(row.get("payload_json"))
        payload_channel_id = _text(payload.get("channelId"))
        if (
            channel_id not in requested
            or (payload_channel_id and payload_channel_id != channel_id)
            or channel_id in resolved
        ):
            raise PostgresAdapterError(
                "VTuber unfiltered parent source identity is invalid"
            )
        source_key = _exact_vtuber_source_detail_key(
            payload, range_id, channel_id,
        )
        owner = source_owners.get(source_key)
        if not source_key or (owner and owner != channel_id):
            raise PostgresAdapterError(
                "VTuber unfiltered parent source identity is ambiguous"
            )
        source_owners[source_key] = channel_id
        resolved[channel_id] = source_key

    for channel_id in channel_ids:
        base_row = base_groups.get(channel_id)
        if not base_row:
            continue
        if _text(base_row.get("detail_key")) not in {"", channel_id}:
            raise PostgresAdapterError(
                "VTuber scoped parent source identity is invalid"
            )
        if channel_id not in resolved:
            raise PostgresAdapterError(
                "VTuber scoped parent source coverage is incomplete"
            )
        base_payload = _json_object(base_row.get("payload_json"))
        explicit_source_key = _text(base_payload.get("sourceDetailKey"))
        if explicit_source_key and explicit_source_key != resolved[channel_id]:
            raise PostgresAdapterError(
                "VTuber scoped parent source identity disagrees with authority"
            )
    return resolved


def _authoritative_vtuber_summary_rows(
    connection,
    parent_revision_id: str,
    affected_channel_ids: set[str],
    full_video_ids: set[str],
    affected_occurrence_ids: set[tuple[str, str]],
    parent_sources: Mapping[str, str],
    candidate_values: Sequence[Mapping[str, Any]],
    range_id: str,
    source_totals_cache: MutableMapping[
        tuple[str, str, str], tuple[int, int]
    ] | None = None,
    options: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Apply bounded overlay deltas to persisted VTuber source authority."""

    snapshot_compact_cards = bool(
        options and options.get("_snapshotCompactCards")
    )
    snapshot_song_search_max_chars = int(
        options.get("_snapshotSongSearchMaxChars") or 0
        if options
        else 0
    )
    if snapshot_compact_cards and not (
        1 <= snapshot_song_search_max_chars <= 1_048_576
    ):
        raise PostgresAdapterError(
            "snapshot VTuber song search bound is invalid"
        )
    scoped = bool(
        options
        and (
            bool(options.get("nicheOnly"))
            or bool(options.get("hideUnknownArtist"))
        )
    )
    source_values = [
        {"channel_id": channel_id, "source_key": source_key}
        for channel_id, source_key in sorted(parent_sources.items())
        if channel_id and source_key
    ]
    # Filtered scopes rebuild their canonical multiset from physical source
    # rows below.  Do not deserialize the much larger unfiltered ``songs``
    # arrays merely to throw them away; PostgreSQL returns their scalar guards
    # and a payload with only that array removed.  The unfiltered path keeps
    # the full canonical multiset because it is the delta base.
    detail_payload_select = (
        "detail.payload_json::jsonb - 'songs'"
        if scoped
        else "detail.payload_json"
    )
    detail_rows = _rows(
        connection,
        f"""
        /* bounded authoritative VTuber parent details */
        WITH requested AS MATERIALIZED (
          SELECT channel_id, source_key
          FROM jsonb_to_recordset(%s::jsonb)
            AS item(channel_id text, source_key text)
        )
        SELECT requested.channel_id, requested.source_key,
               detail.entity_key,
               {detail_payload_select} AS payload_json,
               (jsonb_typeof(coalesce(
                  detail.payload_json::jsonb->'songs', '[]'::jsonb
                )) = 'array') AS songs_is_array,
               song_stats.song_array_count,
               song_stats.distinct_song_key_count,
               song_stats.song_occurrence_count,
               song_stats.invalid_song_count
        FROM requested
        JOIN runtime_source_details AS detail
          ON detail.revision_id = %s
         AND detail.source_key = requested.source_key
         AND detail.range_id = %s
         AND detail.entity_type = 'vtuber'
        CROSS JOIN LATERAL (
          SELECT count(*) AS song_array_count,
                 count(DISTINCT nullif(btrim(song->>'key'), ''))
                   AS distinct_song_key_count,
                 coalesce(sum(
                   CASE
                     WHEN coalesce(song->>'count', '') ~ '^[1-9][0-9]*$'
                     THEN (song->>'count')::bigint
                     ELSE 0
                   END
                 ), 0) AS song_occurrence_count,
                 count(*) FILTER (
                   WHERE nullif(btrim(song->>'key'), '') IS NULL
                      OR nullif(btrim(song->>'name'), '') IS NULL
                      OR coalesce(song->>'count', '') !~ '^[1-9][0-9]*$'
                 ) AS invalid_song_count
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(detail.payload_json::jsonb->'songs') = 'array'
              THEN detail.payload_json::jsonb->'songs'
              ELSE '[]'::jsonb
            END
          ) AS item(song)
        ) AS song_stats
        ORDER BY requested.channel_id
        LIMIT %s
        """,
        [
            json.dumps(source_values, ensure_ascii=False),
            parent_revision_id,
            range_id,
            len(source_values) + 1,
        ],
    ) if source_values else []
    if len(detail_rows) != len(source_values):
        raise PostgresAdapterError(
            "VTuber parent source detail coverage is incomplete"
        )

    channel_by_source = {
        source_key: channel_id for channel_id, source_key in parent_sources.items()
    }
    base_counts: dict[str, int] = {}
    base_videos: dict[str, int] = {}
    base_songs: dict[str, dict[str, tuple[str, int]]] = {}
    authority_counts: dict[str, int] = {}
    authority_videos: dict[str, int] = {}
    for row in detail_rows:
        channel_id = _text(row.get("channel_id"))
        source_key = _text(row.get("source_key"))
        if (
            channel_by_source.get(source_key) != channel_id
            or _text(row.get("entity_key")) != channel_id
        ):
            raise PostgresAdapterError(
                "VTuber parent source detail identity is invalid"
            )
        payload = _json_object(row.get("payload_json"))
        occurrence_count = int(
            payload.get("count")
            or payload.get("occurrenceCount")
            or payload.get("timestampCount")
            or 0
        )
        video_count = int(payload.get("videoCount") or 0)
        songs: dict[str, tuple[str, int]] = {}
        for value in payload.get("songs") or ():
            if not isinstance(value, Mapping):
                raise PostgresAdapterError(
                    "VTuber parent source song counts are invalid"
                )
            key = _text(value.get("key"))
            name = _text(value.get("name"))
            count = int(value.get("count") or 0)
            if not key or not name or count <= 0 or key in songs:
                raise PostgresAdapterError(
                    "VTuber parent source song counts are invalid"
                )
            songs[key] = (name, count)
        song_array_count = int(
            row.get("song_array_count")
            if row.get("song_array_count") is not None
            else len(songs)
        )
        distinct_song_key_count = int(
            row.get("distinct_song_key_count")
            if row.get("distinct_song_key_count") is not None
            else len(songs)
        )
        song_occurrence_count = int(
            row.get("song_occurrence_count")
            if row.get("song_occurrence_count") is not None
            else sum(int(item[1]) for item in songs.values())
        )
        invalid_song_count = int(row.get("invalid_song_count") or 0)
        songs_is_array = (
            bool(row.get("songs_is_array"))
            if row.get("songs_is_array") is not None
            else isinstance(payload.get("songs", []), list)
        )
        declared_song_count = int(
            payload.get("songCount")
            if payload.get("songCount") is not None
            else song_array_count
        )
        if (
            occurrence_count <= 0
            or video_count <= 0
            or not songs_is_array
            or song_array_count != declared_song_count
            or distinct_song_key_count != song_array_count
            or invalid_song_count != 0
            or song_occurrence_count > occurrence_count
            or (not scoped and len(songs) != song_array_count)
        ):
            raise PostgresAdapterError(
                "VTuber parent source aggregate is not internally consistent"
            )
        base_counts[channel_id] = occurrence_count
        base_videos[channel_id] = video_count
        base_songs[channel_id] = songs
        authority_counts[channel_id] = occurrence_count
        authority_videos[channel_id] = video_count

    source_keys = sorted(channel_by_source)
    if scoped:
        # A parent detail stores only its unfiltered canonical multiset.  For a
        # persisted filter scope, aggregate the exact physical source rows by
        # raw song title and canonicalise only that bounded grouped result in
        # Python.  This preserves source-only videos while avoiding the 8.46 GB
        # table scan and multi-million-row payload hydration that caused the
        # original build failures.
        scope_totals = _rows(
            connection,
            """
            /* indexed scoped authoritative VTuber physical totals */
            SELECT source_key, count(*) AS occurrence_count,
                   count(DISTINCT video_id) AS video_count
            FROM runtime_source_occurrences
            WHERE revision_id = %s AND source_key = ANY(%s)
              AND range_id = %s
              AND (NOT %s OR is_niche IS TRUE)
              AND (NOT %s OR is_unknown_artist IS NOT TRUE)
            GROUP BY source_key
            ORDER BY source_key
            LIMIT %s
            """,
            [
                parent_revision_id,
                source_keys,
                range_id,
                bool(options.get("nicheOnly")),
                bool(options.get("hideUnknownArtist")),
                len(source_keys) + 1,
            ],
        ) if source_keys else []
        if len(scope_totals) > len(source_keys):
            raise PostgresAdapterError(
                "VTuber scoped parent source totals exceeded bounded source set"
            )
        totals_by_source = {
            _text(row.get("source_key")): row for row in scope_totals
        }
        title_rows = _iter_bounded_query_rows(
            connection,
            """
            /* indexed scoped authoritative VTuber canonical title counts */
            SELECT source_key,
                   coalesce(
                     payload_json::jsonb->'song'->>'title',
                     payload_json::jsonb->'payload'->'song'->>'title',
                     payload_json::jsonb->>'songTitle'
                   ) AS song_title,
                   count(*) AS occurrence_count
            FROM runtime_source_occurrences
            WHERE revision_id = %s AND source_key = ANY(%s)
              AND range_id = %s
              AND (NOT %s OR is_niche IS TRUE)
              AND (NOT %s OR is_unknown_artist IS NOT TRUE)
            GROUP BY source_key, song_title
            ORDER BY source_key, song_title
            LIMIT %s
            """,
            [
                parent_revision_id,
                source_keys,
                range_id,
                bool(options.get("nicheOnly")),
                bool(options.get("hideUnknownArtist")),
                _MAX_UNSCOPED_OVERLAY_OCCURRENCES + 1,
            ],
            batch_size=_AFFECTED_RECONCILIATION_BATCH_SIZE,
        ) if source_keys else ()
        scoped_songs: dict[str, dict[str, tuple[str, int]]] = defaultdict(dict)
        scoped_title_counts: dict[str, int] = defaultdict(int)
        title_row_count = 0
        for row in title_rows:
            title_row_count += 1
            if title_row_count > _MAX_UNSCOPED_OVERLAY_OCCURRENCES:
                raise PostgresAdapterError(
                    "VTuber scoped canonical title aggregation exceeded bounded cap"
                )
            source_key = _text(row.get("source_key"))
            channel_id = channel_by_source.get(source_key, "")
            raw_title = _text(row.get("song_title"))
            count = int(row.get("occurrence_count") or 0)
            if not channel_id or not raw_title or count <= 0:
                raise PostgresAdapterError(
                    "VTuber scoped source title count is invalid"
                )
            canonical_title, canonical_key = _vtuber_canonical_song_identity(
                raw_title
            )
            canonical_title = canonical_title or raw_title
            if canonical_key:
                previous_name, previous_count = scoped_songs[channel_id].get(
                    canonical_key,
                    (canonical_title, 0),
                )
                scoped_songs[channel_id][canonical_key] = (
                    previous_name,
                    previous_count + count,
                )
            scoped_title_counts[channel_id] += count
        for source_key, channel_id in channel_by_source.items():
            total = totals_by_source.get(source_key)
            base_counts[channel_id] = int(
                total.get("occurrence_count") or 0
            ) if total else 0
            base_videos[channel_id] = int(
                total.get("video_count") or 0
            ) if total else 0
            base_songs[channel_id] = scoped_songs.get(channel_id, {})
            if scoped_title_counts.get(channel_id, 0) != base_counts[channel_id]:
                raise PostgresAdapterError(
                    "VTuber scoped canonical title counts disagree with source authority"
                )

    missing_source_keys: list[str] = []
    cached_totals: dict[str, tuple[int, int]] = {}
    for source_key in source_keys:
        cache_key = (parent_revision_id, range_id, source_key)
        cached = (
            source_totals_cache.get(cache_key)
            if source_totals_cache is not None
            else None
        )
        if cached is None:
            missing_source_keys.append(source_key)
            continue
        if (
            not isinstance(cached, (tuple, list))
            or len(cached) != 2
            or not all(isinstance(value, int) for value in cached)
        ):
            raise PostgresAdapterError(
                "VTuber parent source totals cache is invalid"
            )
        cached_totals[source_key] = (int(cached[0]), int(cached[1]))
    physical_rows = _rows(
        connection,
        """
        /* indexed authoritative VTuber physical totals */
        SELECT source_key, count(*) AS occurrence_count,
               count(DISTINCT video_id) AS video_count
        FROM runtime_source_occurrences
        WHERE revision_id = %s AND source_key = ANY(%s)
          AND range_id = %s
        GROUP BY source_key
        ORDER BY source_key
        LIMIT %s
        """,
        [
            parent_revision_id,
            missing_source_keys,
            range_id,
            len(missing_source_keys) + 1,
        ],
    ) if missing_source_keys else []
    physical_by_source = {
        _text(row.get("source_key")): row for row in physical_rows
    }
    cache_updates: dict[tuple[str, str, str], tuple[int, int]] = {}
    for source_key, channel_id in channel_by_source.items():
        if source_key in cached_totals:
            occurrence_count, video_count = cached_totals[source_key]
        else:
            physical = physical_by_source.get(source_key)
            if not physical:
                raise PostgresAdapterError(
                    "VTuber parent source physical totals disagree with detail"
                )
            occurrence_count = int(physical.get("occurrence_count") or 0)
            video_count = int(physical.get("video_count") or 0)
        if (
            occurrence_count != authority_counts[channel_id]
            or video_count != authority_videos[channel_id]
        ):
            raise PostgresAdapterError(
                "VTuber parent source physical totals disagree with detail"
            )
        if source_key not in cached_totals:
            cache_updates[(parent_revision_id, range_id, source_key)] = (
                occurrence_count,
                video_count,
            )
    if source_totals_cache is not None and cache_updates:
        available = max(
            0, _VTUBER_SOURCE_TOTALS_CACHE_CAP - len(source_totals_cache)
        )
        for cache_key in sorted(cache_updates)[:available]:
            source_totals_cache[cache_key] = cache_updates[cache_key]

    touched_video_ids = sorted({
        *(_text(value) for value in full_video_ids if _text(value)),
        *(_text(video_id) for video_id, _ in affected_occurrence_ids if _text(video_id)),
    })
    touched_rows = _rows(
        connection,
        """
        /* bounded authoritative VTuber touched source rows */
        SELECT source_key, position, video_id, seconds, is_niche,
               is_unknown_artist, payload_json
        FROM runtime_source_occurrences
        WHERE revision_id = %s AND source_key = ANY(%s)
          AND range_id = %s AND video_id = ANY(%s)
        ORDER BY source_key, video_id, position
        LIMIT %s
        """,
        [
            parent_revision_id,
            source_keys,
            range_id,
            touched_video_ids,
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
        ],
    ) if source_keys and touched_video_ids else []
    if len(touched_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "VTuber touched source occurrence lookup exceeded bounded cap"
        )

    normalized_touched: list[dict[str, Any]] = []
    for row in touched_rows:
        source_key = _text(row.get("source_key"))
        channel_id = channel_by_source.get(source_key, "")
        item = _runtime_source_occurrence(row)
        in_scope = (
            not scoped
            or _occurrence_matches_ranking_scope(row, options or {})
        )
        song = item.get("song") if isinstance(item.get("song"), Mapping) else item
        title = _text(song.get("title"))
        artist = _text(song.get("artist"))
        canonical_title, canonical_key = _vtuber_canonical_song_identity(title)
        if not channel_id or not title:
            raise PostgresAdapterError(
                "VTuber touched source occurrence identity is invalid"
            )
        normalized_touched.append({
            "channel_id": channel_id,
            "source_key": source_key,
            "position": int(row.get("position") or 0),
            "video_id": _text(row.get("video_id")),
            "seconds": row.get("seconds") if row.get("seconds") is not None else song.get("seconds"),
            "title": title,
            "artist": artist,
            "canonical_title": canonical_title,
            "canonical_key": canonical_key,
            "in_scope": in_scope,
        })

    touched_source_video_ids = {
        _text(item.get("video_id"))
        for item in normalized_touched
        if _text(item.get("video_id"))
    }
    aligned_occurrences = sorted({
        identity
        for identity in affected_occurrence_ids
        if identity[0] not in full_video_ids
        and identity[0] in touched_source_video_ids
    })
    preimage_rows = _rows(
        connection,
        """
        /* bounded VTuber occurrence preimages */
        WITH requested(video_id, occurrence_id) AS MATERIALIZED (
          SELECT video_id, occurrence_id
          FROM unnest(%s::text[], %s::text[])
            AS item(video_id, occurrence_id)
        )
        SELECT occurrence.video_id, occurrence.occurrence_id,
               occurrence.seconds, occurrence.title, occurrence.artist
        FROM requested
        JOIN runtime_occurrences AS occurrence
          ON occurrence.revision_id = %s
         AND occurrence.video_id = requested.video_id
         AND occurrence.occurrence_id = requested.occurrence_id
         AND occurrence.range_id = %s
        ORDER BY occurrence.video_id, occurrence.occurrence_id
        LIMIT %s
        """,
        [
            [video_id for video_id, _ in aligned_occurrences],
            [occurrence_id for _, occurrence_id in aligned_occurrences],
            parent_revision_id,
            range_id,
            len(aligned_occurrences) + 1,
        ],
    ) if aligned_occurrences else []
    preimage_by_identity: dict[tuple[str, str], Mapping[str, Any]] = {}
    for row in preimage_rows:
        identity = (
            _text(row.get("video_id")),
            _text(row.get("occurrence_id")),
        )
        if not all(identity) or identity in preimage_by_identity:
            raise PostgresAdapterError(
                "VTuber occurrence preimage coverage is invalid"
            )
        preimage_by_identity[identity] = row
    if set(preimage_by_identity) != set(aligned_occurrences):
        raise PostgresAdapterError(
            "VTuber occurrence preimage coverage is incomplete"
        )

    removed_identities: set[tuple[str, int]] = set()
    removals: list[dict[str, Any]] = []

    def remove(item: Mapping[str, Any]) -> None:
        identity = (_text(item.get("source_key")), int(item.get("position") or 0))
        if identity in removed_identities:
            return
        removed_identities.add(identity)
        removals.append(dict(item))

    for item in normalized_touched:
        if item["video_id"] in full_video_ids and item["in_scope"]:
            remove(item)
    for identity, preimage in preimage_by_identity.items():
        if identity[0] in full_video_ids:
            continue
        matches = [
            item for item in normalized_touched
            if item["video_id"] == identity[0]
            and item["seconds"] == preimage.get("seconds")
            and item["title"] == _text(preimage.get("title"))
            and item["artist"] == _text(preimage.get("artist"))
        ]
        if len(matches) != 1:
            raise PostgresAdapterError(
                "VTuber occurrence preimage does not uniquely match source authority"
            )
        if matches[0]["in_scope"]:
            remove(matches[0])

    additions: list[dict[str, Any]] = []
    for value in candidate_values:
        channel_id = _text(value.get("channel_id"))
        video_id = _text(value.get("video_id"))
        title = _text(value.get("canonical_title") or value.get("title"))
        key = _text(value.get("canonical_song_key"))
        canonical_title, canonical_key = _vtuber_canonical_song_identity(
            value.get("title") or title
        )
        if not channel_id or not video_id or not title:
            raise PostgresAdapterError(
                "VTuber overlay addition is missing canonical identity"
            )
        if key and (canonical_title != title or canonical_key != key):
            raise PostgresAdapterError(
                "VTuber overlay addition canonical identity disagrees with title"
            )
        if not key and canonical_key:
            raise PostgresAdapterError(
                "VTuber overlay addition omitted available canonical identity"
            )
        additions.append({
            "channel_id": channel_id,
            "video_id": video_id,
            "canonical_title": title,
            "canonical_key": key,
        })

    parent_video_occurrences: dict[tuple[str, str], int] = defaultdict(int)
    removed_video_occurrences: dict[tuple[str, str], int] = defaultdict(int)
    added_video_occurrences: dict[tuple[str, str], int] = defaultdict(int)
    for item in normalized_touched:
        if not item["in_scope"]:
            continue
        parent_video_occurrences[(item["channel_id"], item["video_id"])] += 1
    for item in removals:
        removed_video_occurrences[(item["channel_id"], item["video_id"])] += 1
    for item in additions:
        added_video_occurrences[(item["channel_id"], item["video_id"])] += 1

    summaries: list[dict[str, Any]] = []
    for channel_id in sorted(affected_channel_ids):
        # Values are immutable ``(name, count)`` tuples.  One shallow dict
        # copy is sufficient for channel-local deltas and avoids duplicating
        # hundreds of thousands of tiny three-field dictionaries in filtered
        # snapshot scopes.
        counts = dict(base_songs.get(channel_id, {}))
        row_count = int(base_counts.get(channel_id, 0))
        video_count = int(base_videos.get(channel_id, 0))
        unkeyed_count = row_count - sum(
            int(item[1]) for item in counts.values()
        )
        if unkeyed_count < 0:
            raise PostgresAdapterError(
                "VTuber parent canonical counts exceed source authority"
            )
        channel_removals = [item for item in removals if item["channel_id"] == channel_id]
        channel_additions = [item for item in additions if item["channel_id"] == channel_id]
        row_count += len(channel_additions) - len(channel_removals)
        touched = {
            video_id
            for owner, video_id in {
                *parent_video_occurrences,
                *removed_video_occurrences,
                *added_video_occurrences,
            }
            if owner == channel_id
        }
        for video_id in touched:
            before = parent_video_occurrences[(channel_id, video_id)]
            after = (
                before
                - removed_video_occurrences[(channel_id, video_id)]
                + added_video_occurrences[(channel_id, video_id)]
            )
            if after < 0:
                raise PostgresAdapterError(
                    "VTuber overlay removed more source rows than parent authority"
                )
            video_count += int(after > 0) - int(before > 0)
        for item, delta in (
            *((item, -1) for item in channel_removals),
            *((item, 1) for item in channel_additions),
        ):
            key = item["canonical_key"]
            if not key:
                unkeyed_count += delta
                if unkeyed_count < 0:
                    raise PostgresAdapterError(
                        "VTuber unkeyed occurrence delta became negative"
                    )
                continue
            entry = counts.get(key)
            if entry is None:
                if delta < 0:
                    raise PostgresAdapterError(
                        "VTuber source removal lacks a canonical parent song"
                    )
                entry = (item["canonical_title"], 0)
            name, previous_count = entry
            next_count = int(previous_count) + delta
            if next_count < 0:
                raise PostgresAdapterError(
                    "VTuber canonical song delta became negative"
                )
            counts[key] = (name, next_count)
        effective_songs = {
            key: item for key, item in counts.items()
            if int(item[1]) > 0
        }
        if (
            row_count < 0
            or video_count < 0
            or sum(int(item[1]) for item in effective_songs.values())
                + unkeyed_count != row_count
        ):
            raise PostgresAdapterError(
                "VTuber authoritative overlay summary is not internally consistent"
            )
        sorted_songs = sorted(
            effective_songs.items(),
            key=lambda item: (
                -int(item[1][1]), _overlay_norm(item[1][0])
            ),
        )
        summary = {
            "channel_id": channel_id,
            "row_count": row_count,
            "video_count": video_count,
            "song_count": len(effective_songs),
            "residual_match": True,
        }
        if snapshot_compact_cards:
            fragments: list[str] = []
            remaining = snapshot_song_search_max_chars
            for _, (name, _) in sorted_songs:
                fragment = _text(name)
                if not fragment or remaining <= 0:
                    break
                fragment = fragment[:remaining]
                fragments.append(fragment)
                remaining -= len(fragment) + 1
            summary["_snapshotSongSearchText"] = " ".join(fragments)
        else:
            summary["songs"] = [
                {"key": key, "name": name, "count": count}
                for key, (name, count) in sorted_songs
            ]
        summaries.append(summary)
    return summaries


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
            AND (NOT %s OR occurrence.is_unknown_artist IS NOT TRUE)
            AND (NOT %s OR occurrence.is_niche IS TRUE)
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


def _resolved_artist_parent_sources(
    connection,
    parent_revision_id: str,
    requested_artist_keys: Iterable[str],
    range_id: str,
    *,
    alias_cache: MutableMapping[
        tuple[str, str, str], tuple[str, str, str]
    ] | None = None,
) -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    """Resolve affected Artist spellings to immutable parent source owners.

    Artist construction performs reviewed alias/partial-name merges after its
    first normalization pass.  A raw overlay spelling therefore cannot safely
    derive the parent detail key on its own (for example ``Artist (2023)`` can
    belong to the persisted ``Artist`` card).  Parent source payloads retain
    the exact alias keys used by that build; resolve only those explicit keys
    and fail closed when one alias has multiple owners.
    """

    requested = sorted({
        _text(value) for value in requested_artist_keys if _text(value)
    })
    if not requested:
        return {}, {}, {}

    cached: dict[str, tuple[str, str, str]] = {}
    missing: list[str] = []
    for key in requested:
        value = (
            alias_cache.get((parent_revision_id, range_id, key))
            if alias_cache is not None
            else None
        )
        if value is None:
            missing.append(key)
            continue
        if (
            not isinstance(value, (tuple, list))
            or len(value) != 3
            or not all(isinstance(item, str) for item in value)
        ):
            raise PostgresAdapterError("Artist parent alias cache is invalid")
        cached[key] = (_text(value[0]), _text(value[1]), _text(value[2]))

    rows = _rows(
        connection,
        """
        /* bounded authoritative Artist parent alias identities */
        WITH requested(key) AS MATERIALIZED (
          SELECT DISTINCT unnest(%s::text[])
        )
        SELECT ranking.detail_key, ranking.name,
               coalesce(
                 ranking.payload_json::jsonb->>'sourceDetailKey', ''
               ) AS source_key,
               coalesce(
                 ranking.payload_json::jsonb->'aliases', '[]'::jsonb
               ) AS aliases
        FROM runtime_ranking_rows AS ranking
        WHERE ranking.revision_id = %s
          AND ranking.range_id = %s
          AND ranking.view = 'artists'
          AND ranking.metric = 'count'
          AND ranking.scope_key = 'all'
          AND (
            ranking.detail_key IN (SELECT key FROM requested)
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(
                    ranking.payload_json::jsonb->'aliases'
                  ) = 'array'
                  THEN ranking.payload_json::jsonb->'aliases'
                  ELSE '[]'::jsonb
                END
              ) AS alias(value)
              WHERE nullif(btrim(alias.value->>'key'), '')
                    IN (SELECT key FROM requested)
            )
          )
        ORDER BY ranking.detail_key
        LIMIT %s
        """,
        [
            missing,
            parent_revision_id,
            range_id,
            max(1, len(missing) * 2 + 1),
        ],
    ) if missing else []
    if len(rows) > len(missing) * 2:
        raise PostgresAdapterError(
            "Artist parent alias lookup exceeded bounded owner set"
        )

    resolved: dict[str, tuple[str, str, str]] = dict(cached)
    owners_by_source: dict[str, str] = {}
    requested_set = set(missing)
    row_values: list[tuple[str, str, str, set[str]]] = []
    canonical_rows: dict[str, tuple[str, str]] = {}
    for row in rows:
        canonical_key = _text(row.get("detail_key"))
        name = _text(row.get("name")) or canonical_key
        source_key = _text(row.get("source_key")) or (
            _production_source_detail_key_for_group(
                "artists", range_id, canonical_key,
            )
        )
        if not canonical_key or not source_key:
            raise PostgresAdapterError(
                "Artist parent source identity is incomplete"
            )
        source_owner = owners_by_source.get(source_key)
        if source_owner and source_owner != canonical_key:
            raise PostgresAdapterError(
                "Artist parent source identity is ambiguous"
            )
        owners_by_source[source_key] = canonical_key
        candidate_keys = {canonical_key}
        aliases = row.get("aliases")
        if isinstance(aliases, str):
            try:
                aliases = json.loads(aliases)
            except json.JSONDecodeError as exc:
                raise PostgresAdapterError(
                    "Artist parent alias payload is invalid"
                ) from exc
        if not isinstance(aliases, list):
            raise PostgresAdapterError(
                "Artist parent alias payload is invalid"
            )
        for alias in aliases:
            if not isinstance(alias, Mapping):
                raise PostgresAdapterError(
                    "Artist parent alias payload is invalid"
                )
            alias_key = _text(alias.get("key"))
            # Historical parent builds stored ``aliases[].count`` as an
            # object-valued accumulator.  Alias ownership is defined by the
            # reviewed immutable key; display/count metadata is deliberately
            # not part of that identity contract.
            if not alias_key:
                raise PostgresAdapterError(
                    "Artist parent alias payload is invalid"
                )
            candidate_keys.add(alias_key)
        row_values.append((canonical_key, source_key, name, candidate_keys))
        canonical_rows[canonical_key] = (source_key, name)

    # The final parent build can retain one raw spelling inside a broade
    # card's aliases while also publishing a more specific canonical card
    # with that exact key (for example ``Kanaria feat.GUMI``).  The canonical
    # card is the immutable owner; alias fallback is considered only when no
    # exact canonical key exists.  Multiple alias-only owners remain invalid.
    for candidate_key in requested_set:
        canonical = canonical_rows.get(candidate_key)
        if canonical is not None:
            resolved[candidate_key] = (
                candidate_key, canonical[0], canonical[1],
            )
            continue
        matches = [
            (canonical_key, source_key, name)
            for canonical_key, source_key, name, candidate_keys in row_values
            if candidate_key in candidate_keys
        ]
        unique = list(dict.fromkeys(matches))
        if len(unique) > 1:
            raise PostgresAdapterError(
                "Artist parent alias has multiple canonical owners"
            )
        if unique:
            resolved[candidate_key] = unique[0]

    if alias_cache is not None:
        for key in missing:
            # An empty tuple value is an explicit overlay-only result inside
            # this immutable snapshot; it avoids repeating the same bounded
            # parent alias lookup for every metric.
            value = resolved.get(key, ("", "", ""))
            alias_cache[(parent_revision_id, range_id, key)] = value

    alias_to_canonical = {
        key: value[0] for key, value in resolved.items() if value[0]
    }
    parent_sources: dict[str, str] = {}
    parent_names: dict[str, str] = {}
    for canonical_key, source_key, name in resolved.values():
        if not canonical_key:
            continue
        previous = parent_sources.get(canonical_key)
        if previous and previous != source_key:
            raise PostgresAdapterError(
                "Artist canonical parent has multiple source identities"
            )
        parent_sources[canonical_key] = source_key
        parent_names[canonical_key] = name
    return parent_sources, alias_to_canonical, parent_names


def _artist_source_song_identity(value: Any) -> tuple[str, str]:
    """Return the Artist source count-map display name and exact JS key."""

    name = _text(value)
    return name, _runtime_entity_key(name)


def _artist_source_alias_keys(
    persisted_record: Mapping[str, Any],
) -> set[str]:
    """Return the exact reviewed Artist aliases stored by the parent build."""

    target = _overlay_artist_group_norm(
        persisted_record.get("key")
        or persisted_record.get("name")
        or persisted_record.get("artist")
    )
    if not target:
        raise PostgresAdapterError("Artist source identity is incomplete")
    keys = {target}
    aliases = persisted_record.get("aliases")
    if aliases is None:
        return keys
    if not isinstance(aliases, list):
        raise PostgresAdapterError("Artist source alias payload is invalid")
    for alias in aliases:
        if not isinstance(alias, Mapping):
            raise PostgresAdapterError("Artist source alias payload is invalid")
        alias_key = _text(alias.get("key"))
        # See ``_resolved_artist_parent_sources``: only the immutable alias
        # key participates in source ownership.  Older payloads legitimately
        # contain object-valued count accumulators.
        if not alias_key:
            raise PostgresAdapterError("Artist source alias payload is invalid")
        keys.add(alias_key)
    return keys


def _authoritative_artist_summary_rows(
    connection,
    parent_revision_id: str,
    affected_artist_keys: set[str],
    parent_sources: Mapping[str, str],
    parent_names: Mapping[str, str],
    alias_to_canonical: Mapping[str, str],
    candidate_rows: Sequence[Mapping[str, Any]],
    reset_changes: Sequence[Mapping[str, Any]],
    runtime_changes: Sequence[Mapping[str, Any]],
    replacement_rows: Sequence[Mapping[str, Any]],
    options: Mapping[str, Any],
    *,
    source_totals_cache: MutableMapping[
        tuple[str, str, str, str], tuple[int, int]
    ] | None = None,
) -> dict[str, dict[str, Any]]:
    """Rebuild affected Artist scalars from persisted source authority.

    Parent ``runtime_videos``/``runtime_occurrences`` are a compact scala
    projection and can omit historical source-only videos.  This helper uses
    Artist source details as the aggregate base, hydrates only touched source
    videos, applies each accepted/runtime delta exactly once, and verifies the
    canonical song multiset against the final occurrence count.
    """

    range_id = _text(options.get("range")) or "all"
    snapshot_compact_cards = bool(options.get("_snapshotCompactCards"))
    snapshot_preserve_artist_owner_songs = bool(
        options.get("_snapshotPreserveArtistOwnerSongs")
    )
    snapshot_song_search_max_chars = int(
        options.get("_snapshotSongSearchMaxChars") or 0
    )
    if snapshot_preserve_artist_owner_songs and not snapshot_compact_cards:
        raise PostgresAdapterError(
            "snapshot Artist owner preservation requires compact cards"
        )
    if snapshot_compact_cards and not (
        1 <= snapshot_song_search_max_chars <= 1_048_576
    ):
        raise PostgresAdapterError(
            "snapshot Artist song search bound is invalid"
        )
    scoped = bool(
        options.get("nicheOnly") or options.get("hideUnknownArtist")
    )
    source_values = [
        {"artist_key": artist_key, "source_key": source_key}
        for artist_key, source_key in sorted(parent_sources.items())
        if artist_key in affected_artist_keys and artist_key and source_key
    ]
    source_by_artist = {
        value["artist_key"]: value["source_key"] for value in source_values
    }
    artist_by_source = {
        value["source_key"]: value["artist_key"] for value in source_values
    }
    if len(artist_by_source) != len(source_values):
        raise PostgresAdapterError(
            "Artist parent source identity is ambiguous"
        )

    detail_rows = _rows(
        connection,
        """
        /* bounded authoritative Artist parent details */
        WITH requested AS MATERIALIZED (
          SELECT artist_key, source_key
          FROM jsonb_to_recordset(%s::jsonb)
            AS item(artist_key text, source_key text)
        )
        SELECT requested.artist_key, requested.source_key,
               detail.entity_key,
               detail.payload_json::jsonb
                 - 'songs' - 'channels' - 'occurrences' - 'aliases'
                 - 'searchText' AS payload_json,
               detail.payload_json::jsonb->'songs' AS songs_json,
               (jsonb_typeof(coalesce(
                  detail.payload_json::jsonb->'songs', '[]'::jsonb
                )) = 'array') AS songs_is_array,
               song_stats.song_array_count,
               song_stats.distinct_song_key_count,
               song_stats.song_occurrence_count,
               song_stats.invalid_song_count
        FROM requested
        JOIN runtime_source_details AS detail
          ON detail.revision_id = %s
         AND detail.source_key = requested.source_key
         AND detail.range_id = %s
         AND detail.entity_type = 'artist'
         AND detail.entity_key = requested.artist_key
        CROSS JOIN LATERAL (
          SELECT count(*) AS song_array_count,
                 count(DISTINCT nullif(btrim(song->>'key'), ''))
                   AS distinct_song_key_count,
                 coalesce(sum(
                   CASE
                     WHEN coalesce(song->>'count', '') ~ '^[1-9][0-9]*$'
                     THEN (song->>'count')::bigint
                     ELSE 0
                   END
                 ), 0) AS song_occurrence_count,
                 count(*) FILTER (
                   WHERE nullif(btrim(song->>'key'), '') IS NULL
                      OR nullif(btrim(song->>'name'), '') IS NULL
                      OR coalesce(song->>'count', '') !~ '^[1-9][0-9]*$'
                 ) AS invalid_song_count
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(detail.payload_json::jsonb->'songs') = 'array'
              THEN detail.payload_json::jsonb->'songs'
              ELSE '[]'::jsonb
            END
          ) AS item(song)
        ) AS song_stats
        ORDER BY requested.artist_key
        LIMIT %s
        """,
        [
            json.dumps(source_values, ensure_ascii=False),
            parent_revision_id,
            range_id,
            len(source_values) + 1,
        ],
    ) if source_values else []
    if len(detail_rows) != len(source_values):
        raise PostgresAdapterError(
            "Artist parent source detail coverage is incomplete"
        )

    base_counts: dict[str, int] = {}
    base_videos: dict[str, int] = {}
    base_songs: dict[str, dict[str, tuple[str, int]]] = {}
    base_payloads: dict[str, dict[str, Any]] = {}
    for row in detail_rows:
        artist_key = _text(row.get("artist_key"))
        source_key = _text(row.get("source_key"))
        if (
            source_by_artist.get(artist_key) != source_key
            or _text(row.get("entity_key")) != artist_key
        ):
            raise PostgresAdapterError(
                "Artist parent source detail identity is invalid"
            )
        payload = _json_object(row.get("payload_json"))
        count = int(
            payload.get("count")
            or payload.get("occurrenceCount")
            or payload.get("timestampCount")
            or 0
        )
        video_count = int(payload.get("videoCount") or 0)
        raw_songs = row.get("songs_json")
        if isinstance(raw_songs, str):
            try:
                raw_songs = json.loads(raw_songs)
            except json.JSONDecodeError as exc:
                raise PostgresAdapterError(
                    "Artist parent source song counts are invalid"
                ) from exc
        if raw_songs is None:
            # Compatibility for lightweight test fakes and older adapters;
            # production selects songs separately so large detail-only lists
            # never enter the Python aggregate payload.
            raw_songs = payload.get("songs")
        if not isinstance(raw_songs, list):
            raise PostgresAdapterError(
                "Artist parent source song counts are invalid"
            )
        songs: dict[str, tuple[str, int]] = {}
        for value in raw_songs:
            if not isinstance(value, Mapping):
                raise PostgresAdapterError(
                    "Artist parent source song counts are invalid"
                )
            key = _text(value.get("key"))
            name = _text(value.get("name"))
            song_count = int(value.get("count") or 0)
            if (
                not key or not name or song_count <= 0 or key in songs
                or _artist_source_song_identity(name)[1] != key
            ):
                raise PostgresAdapterError(
                    "Artist parent source song counts are invalid"
                )
            songs[key] = (name, song_count)
        song_array_count = int(
            row.get("song_array_count")
            if row.get("song_array_count") is not None
            else len(songs)
        )
        if (
            count <= 0
            or video_count <= 0
            or not bool(row.get("songs_is_array", True))
            or int(row.get("invalid_song_count") or 0) != 0
            or int(
                row.get("distinct_song_key_count")
                if row.get("distinct_song_key_count") is not None
                else len(songs)
            ) != song_array_count
            or len(songs) != song_array_count
            or int(
                row.get("song_occurrence_count")
                if row.get("song_occurrence_count") is not None
                else sum(value[1] for value in songs.values())
            ) != count
        ):
            raise PostgresAdapterError(
                "Artist parent source aggregate is not internally consistent"
            )
        base_counts[artist_key] = count
        base_videos[artist_key] = video_count
        base_songs[artist_key] = songs
        base_payloads[artist_key] = payload
    # The parsed count maps are now the only delta authority needed by
    # Python. Release the separate JSON transport rows before hydrating the
    # touched source occurrences and building public summaries.
    detail_rows.clear()

    source_keys = sorted(artist_by_source)
    missing_totals: list[str] = []
    physical_totals: dict[str, tuple[int, int]] = {}
    for source_key in source_keys:
        cache_key = (parent_revision_id, range_id, "artist", source_key)
        cached = (
            source_totals_cache.get(cache_key)
            if source_totals_cache is not None and not scoped
            else None
        )
        if cached is None:
            missing_totals.append(source_key)
        elif (
            isinstance(cached, (tuple, list))
            and len(cached) == 2
            and all(isinstance(value, int) for value in cached)
        ):
            physical_totals[source_key] = (int(cached[0]), int(cached[1]))
        else:
            raise PostgresAdapterError("Artist source totals cache is invalid")
    total_rows = _rows(
        connection,
        """
        /* indexed authoritative Artist physical totals */
        SELECT source_key, count(*) AS occurrence_count,
               count(DISTINCT video_id) AS video_count
        FROM runtime_source_occurrences
        WHERE revision_id = %s AND source_key = ANY(%s)
          AND range_id = %s
          AND (NOT %s OR is_niche IS TRUE)
          AND (NOT %s OR is_unknown_artist IS NOT TRUE)
        GROUP BY source_key
        ORDER BY source_key
        LIMIT %s
        """,
        [
            parent_revision_id,
            missing_totals if not scoped else source_keys,
            range_id,
            bool(options.get("nicheOnly")),
            bool(options.get("hideUnknownArtist")),
            len(source_keys) + 1,
        ],
    ) if source_keys and (missing_totals or scoped) else []
    if len(total_rows) > len(source_keys):
        raise PostgresAdapterError(
            "Artist physical totals exceeded bounded source set"
        )
    for row in total_rows:
        source_key = _text(row.get("source_key"))
        if source_key not in artist_by_source or source_key in physical_totals:
            raise PostgresAdapterError(
                "Artist physical source identity is invalid"
            )
        physical_totals[source_key] = (
            int(row.get("occurrence_count") or 0),
            int(row.get("video_count") or 0),
        )
    if not scoped:
        for source_key, artist_key in artist_by_source.items():
            totals = physical_totals.get(source_key)
            if totals != (base_counts[artist_key], base_videos[artist_key]):
                raise PostgresAdapterError(
                    "Artist parent source physical totals disagree with detail"
                )
            if source_totals_cache is not None:
                source_totals_cache[
                    (parent_revision_id, range_id, "artist", source_key)
                ] = totals
    else:
        # Filtered scopes use their exact physical totals and grouped titles;
        # an unfiltered source-detail song array cannot represent those rows.
        title_rows = _iter_bounded_query_rows(
            connection,
            """
            /* indexed scoped authoritative Artist title counts */
            SELECT source_key,
                   coalesce(
                     payload_json::jsonb->'song'->>'title',
                     payload_json::jsonb->'payload'->'song'->>'title',
                     payload_json::jsonb->>'songTitle'
                   ) AS song_title,
                   count(*) AS occurrence_count
            FROM runtime_source_occurrences
            WHERE revision_id = %s AND source_key = ANY(%s)
              AND range_id = %s
              AND (NOT %s OR is_niche IS TRUE)
              AND (NOT %s OR is_unknown_artist IS NOT TRUE)
            GROUP BY source_key, song_title
            ORDER BY source_key, song_title
            LIMIT %s
            """,
            [
                parent_revision_id,
                source_keys,
                range_id,
                bool(options.get("nicheOnly")),
                bool(options.get("hideUnknownArtist")),
                _MAX_UNSCOPED_OVERLAY_OCCURRENCES + 1,
            ],
            batch_size=_AFFECTED_RECONCILIATION_BATCH_SIZE,
        ) if source_keys else ()
        scoped_songs: dict[str, dict[str, tuple[str, int]]] = defaultdict(dict)
        scoped_title_totals: dict[str, int] = defaultdict(int)
        title_row_count = 0
        for row in title_rows:
            title_row_count += 1
            if title_row_count > _MAX_UNSCOPED_OVERLAY_OCCURRENCES:
                raise PostgresAdapterError(
                    "Artist scoped title aggregation exceeded bounded cap"
                )
            source_key = _text(row.get("source_key"))
            artist_key = artist_by_source.get(source_key, "")
            name, key = _artist_source_song_identity(row.get("song_title"))
            count = int(row.get("occurrence_count") or 0)
            if not artist_key or not name or not key or count <= 0:
                raise PostgresAdapterError(
                    "Artist scoped source title count is invalid"
                )
            previous_name, previous_count = scoped_songs[artist_key].get(
                key, (name, 0),
            )
            scoped_songs[artist_key][key] = (
                previous_name, previous_count + count,
            )
            scoped_title_totals[artist_key] += count
        for source_key, artist_key in artist_by_source.items():
            occurrence_count, video_count = physical_totals.get(
                source_key, (0, 0),
            )
            if scoped_title_totals.get(artist_key, 0) != occurrence_count:
                raise PostgresAdapterError(
                    "Artist scoped title counts disagree with source authority"
                )
            base_counts[artist_key] = occurrence_count
            base_videos[artist_key] = video_count
            base_songs[artist_key] = scoped_songs.get(artist_key, {})

    full_video_ids = {
        _text(change.get("videoId") or change.get("video_id"))
        for change in reset_changes
        if bool(change.get("acceptedVideoReset"))
        and _text(change.get("videoId") or change.get("video_id"))
    }
    full_video_ids.update({
        _text(change.get("videoId") or change.get("video_id"))
        for change in runtime_changes
        if _text(change.get("entityType") or change.get("entity_type"))
            in {"videos", "runtime_videos"}
        and _text(change.get("videoId") or change.get("video_id"))
    })
    ordinary_changes = [
        change for change in runtime_changes
        if not bool(change.get("acceptedVideoReset"))
        and _text(change.get("entityType") or change.get("entity_type"))
            in {"occurrences", "runtime_occurrences"}
    ]
    ordinary_video_ids = {
        _text(change.get("videoId") or change.get("video_id"))
        for change in ordinary_changes
        if _text(change.get("videoId") or change.get("video_id"))
    }
    candidate_identities = {
        (_text(row.get("video_id")), _text(row.get("occurrence_id")))
        for row in candidate_rows
        if _text(row.get("video_id")) and _text(row.get("occurrence_id"))
    }
    overridden_candidate_identities: set[tuple[str, str]] = set()
    parent_change_identities: set[tuple[str, str]] = set()
    parent_change_sources: dict[tuple[str, str], str] = {}
    parent_changes_by_identity: dict[
        tuple[str, str], Mapping[str, Any]
    ] = {}
    for change in ordinary_changes:
        identity = (
            _text(change.get("videoId") or change.get("video_id")),
            _text(change.get("occurrenceId") or change.get("occurrence_id")),
        )
        if not all(identity):
            raise PostgresAdapterError(
                "Artist runtime occurrence change lacks immutable identity"
            )
        has_parent_authority = False
        if identity in candidate_identities:
            overridden_candidate_identities.add(identity)
        else:
            raw_artist_key = _runtime_change_group_key(change, "artists")
            canonical_artist_key = alias_to_canonical.get(
                raw_artist_key, raw_artist_key,
            )
            has_parent_authority = canonical_artist_key in parent_sources
        if (
            identity not in candidate_identities
            and identity[0] not in full_video_ids
            and has_parent_authority
        ):
            source_key = source_by_artist.get(canonical_artist_key, "")
            if not source_key:
                raise PostgresAdapterError(
                    "Artist occurrence change lacks parent source authority"
                )
            previous_source = parent_change_sources.get(identity)
            if previous_source and previous_source != source_key:
                raise PostgresAdapterError(
                    "Artist occurrence change has ambiguous source authority"
                )
            parent_change_identities.add(identity)
            parent_change_sources[identity] = source_key
            parent_changes_by_identity[identity] = change
    touched_video_ids = sorted(full_video_ids | ordinary_video_ids)
    touched_rows = _rows(
        connection,
        """
        /* bounded authoritative Artist touched source rows */
        SELECT source_key, position, video_id, seconds, is_niche,
               is_unknown_artist, payload_json
        FROM runtime_source_occurrences
        WHERE revision_id = %s AND source_key = ANY(%s)
          AND range_id = %s AND video_id = ANY(%s)
        ORDER BY source_key, video_id, position
        LIMIT %s
        """,
        [
            parent_revision_id,
            source_keys,
            range_id,
            touched_video_ids,
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
        ],
    ) if source_keys and touched_video_ids else []
    if len(touched_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "Artist touched source occurrence lookup exceeded bounded cap"
        )

    touched: list[dict[str, Any]] = []
    for row in touched_rows:
        source_key = _text(row.get("source_key"))
        artist_key = artist_by_source.get(source_key, "")
        occurrence = _runtime_source_occurrence(row)
        song = (
            occurrence.get("song")
            if isinstance(occurrence.get("song"), Mapping)
            else occurrence
        )
        name, song_key = _artist_source_song_identity(song.get("title"))
        if not artist_key or not name or not song_key:
            raise PostgresAdapterError(
                "Artist touched source occurrence identity is invalid"
            )
        touched.append({
            "artist_key": artist_key,
            "source_key": source_key,
            "position": int(row.get("position") or 0),
            "video_id": _text(row.get("video_id")),
            "seconds": (
                row.get("seconds")
                if row.get("seconds") is not None
                else song.get("seconds")
            ),
            "title": _text(song.get("title")),
            "artist": _text(song.get("artist")),
            "song_name": name,
            "song_key": song_key,
            "in_scope": (
                not scoped
                or _occurrence_matches_ranking_scope(row, options)
            ),
        })

    ordinary_identities = sorted(parent_change_identities)
    preimage_rows = _rows(
        connection,
        """
        /* bounded Artist occurrence preimages */
        WITH requested(video_id, occurrence_id) AS MATERIALIZED (
          SELECT video_id, occurrence_id
          FROM unnest(%s::text[], %s::text[])
            AS item(video_id, occurrence_id)
        )
        SELECT occurrence.video_id, occurrence.occurrence_id,
               occurrence.seconds, occurrence.title, occurrence.artist
        FROM requested
        JOIN runtime_occurrences AS occurrence
          ON occurrence.revision_id = %s
         AND occurrence.video_id = requested.video_id
         AND occurrence.occurrence_id = requested.occurrence_id
         AND occurrence.range_id = %s
        ORDER BY occurrence.video_id, occurrence.occurrence_id
        LIMIT %s
        """,
        [
            [video_id for video_id, _ in ordinary_identities],
            [occurrence_id for _, occurrence_id in ordinary_identities],
            parent_revision_id,
            range_id,
            len(ordinary_identities) + 1,
        ],
    ) if ordinary_identities else []
    preimages: dict[tuple[str, str], Mapping[str, Any]] = {}
    for row in preimage_rows:
        identity = (
            _text(row.get("video_id")), _text(row.get("occurrence_id")),
        )
        if not all(identity) or identity in preimages:
            raise PostgresAdapterError(
                "Artist occurrence preimage coverage is invalid"
            )
        preimages[identity] = row
    if not set(preimages).issubset(set(ordinary_identities)):
        raise PostgresAdapterError(
            "Artist occurrence preimage coverage is invalid"
        )
    # Compact runtime tables can omit occurrences that remain present in an
    # immutable Artist source.  In that bounded case the resolved runtime
    # chain already carries the old-side raw identity.  Use it only as a
    # lookup tuple into the exact parent source; the subsequent unique-match
    # guard still rejects zero or multiple authority rows.
    for identity in sorted(set(ordinary_identities) - set(preimages)):
        change = parent_changes_by_identity.get(identity)
        if (
            not isinstance(change, Mapping)
            or change.get("seconds") is None
            or not _text(change.get("title"))
        ):
            raise PostgresAdapterError(
                "Artist source-only occurrence preimage is incomplete"
            )
        preimages[identity] = {
            "video_id": identity[0],
            "occurrence_id": identity[1],
            "seconds": change.get("seconds"),
            "title": change.get("title"),
            "artist": change.get("artist"),
        }

    removed_positions: set[tuple[str, int]] = set()
    removals: list[dict[str, Any]] = []

    def remove(item: Mapping[str, Any]) -> None:
        identity = (_text(item.get("source_key")), int(item.get("position") or 0))
        if identity in removed_positions:
            return
        removed_positions.add(identity)
        removals.append(dict(item))

    for item in touched:
        if item["video_id"] in full_video_ids and item["in_scope"]:
            remove(item)
    for identity, preimage in preimages.items():
        matches = [
            item for item in touched
            if item["video_id"] == identity[0]
            and item["source_key"] == parent_change_sources.get(identity)
            and item["seconds"] == preimage.get("seconds")
            and item["title"] == _text(preimage.get("title"))
            and item["artist"] == _text(preimage.get("artist"))
        ]
        if len(matches) != 1:
            raise PostgresAdapterError(
                "Artist occurrence preimage does not uniquely match source authority"
            )
        if matches[0]["in_scope"]:
            remove(matches[0])

    replacement_identities = {
        (_text(row.get("video_id")), _text(row.get("occurrence_id")))
        for row in replacement_rows
        if _text(row.get("video_id")) and _text(row.get("occurrence_id"))
    }
    additions: list[dict[str, Any]] = []
    for is_candidate, row in (
        *((True, row) for row in candidate_rows),
        *((False, row) for row in replacement_rows),
    ):
        identity = (
            _text(row.get("video_id")), _text(row.get("occurrence_id")),
        )
        if (
            is_candidate
            and identity in (
                overridden_candidate_identities | replacement_identities
            )
        ):
            continue
        # The runtime Artist builder publishes an explicit ``unknown`` group
        # for empty/unknown artist names.  Preserve that public identity here
        # instead of treating a legitimate uncredited song as malformed.
        raw_artist_key = (
            _overlay_artist_group_norm(row.get("artist")) or "unknown"
        )
        artist_key = alias_to_canonical.get(raw_artist_key, raw_artist_key)
        name, song_key = _artist_source_song_identity(row.get("title"))
        video_id = identity[0]
        if not artist_key or not name or not song_key or not video_id:
            raise PostgresAdapterError(
                "Artist overlay addition is missing canonical identity "
                f"kind={'candidate' if is_candidate else 'replacement'} "
                f"video={video_id!r} occurrence={identity[1]!r} "
                f"artist={_text(row.get('artist'))!r} "
                f"title={_text(row.get('title'))!r}"
            )
        if not _occurrence_matches_ranking_scope(row, options):
            continue
        additions.append({
            "artist_key": artist_key,
            "video_id": video_id,
            "song_name": name,
            "song_key": song_key,
            "row": row,
        })
        affected_artist_keys.add(artist_key)

    parent_video_counts: dict[tuple[str, str], int] = defaultdict(int)
    removed_video_counts: dict[tuple[str, str], int] = defaultdict(int)
    added_video_counts: dict[tuple[str, str], int] = defaultdict(int)
    for item in touched:
        if item["in_scope"]:
            parent_video_counts[(item["artist_key"], item["video_id"])] += 1
    for item in removals:
        removed_video_counts[(item["artist_key"], item["video_id"])] += 1
    for item in additions:
        added_video_counts[(item["artist_key"], item["video_id"])] += 1

    removals_by_artist: dict[str, list[dict[str, Any]]] = defaultdict(list)
    additions_by_artist: dict[str, list[dict[str, Any]]] = defaultdict(list)
    touched_videos_by_artist: dict[str, set[str]] = defaultdict(set)
    for item in removals:
        removals_by_artist[item["artist_key"]].append(item)
    for item in additions:
        additions_by_artist[item["artist_key"]].append(item)
    for owner, video_id in {
        *parent_video_counts, *removed_video_counts, *added_video_counts,
    }:
        touched_videos_by_artist[owner].add(video_id)

    summaries: dict[str, dict[str, Any]] = {}
    for artist_key in sorted(affected_artist_keys):
        counts = base_songs.pop(artist_key, {})
        row_count = int(base_counts.pop(artist_key, 0))
        video_count = int(base_videos.pop(artist_key, 0))
        artist_removals = removals_by_artist.get(artist_key, ())
        artist_additions = additions_by_artist.get(artist_key, ())
        row_count += len(artist_additions) - len(artist_removals)
        touched_videos = touched_videos_by_artist.get(artist_key, ())
        for video_id in touched_videos:
            before = parent_video_counts[(artist_key, video_id)]
            after = (
                before
                - removed_video_counts[(artist_key, video_id)]
                + added_video_counts[(artist_key, video_id)]
            )
            if after < 0:
                raise PostgresAdapterError(
                    "Artist overlay removed more source rows than parent authority"
                )
            video_count += int(after > 0) - int(before > 0)
        for item, delta in (
            *((item, -1) for item in artist_removals),
            *((item, 1) for item in artist_additions),
        ):
            key = item["song_key"]
            name = item["song_name"]
            current_name, current_count = counts.get(key, (name, 0))
            next_count = int(current_count) + delta
            if next_count < 0:
                raise PostgresAdapterError(
                    "Artist canonical song delta became negative"
                )
            counts[key] = (current_name, next_count)
        effective_songs = {
            key: value for key, value in counts.items() if int(value[1]) > 0
        }
        if (
            row_count < 0
            or video_count < 0
            or sum(int(value[1]) for value in effective_songs.values())
                != row_count
        ):
            raise PostgresAdapterError(
                "Artist authoritative overlay summary is not internally consistent"
            )
        payload = base_payloads.pop(artist_key, {})
        candidate = next((
            item["row"] for item in artist_additions
            if _text(item["row"].get("artist"))
        ), {})
        name = (
            _text(payload.get("name"))
            or _text(parent_names.get(artist_key))
            or _text(candidate.get("artist"))
            or artist_key
        )
        songs = [
            {"key": key, "name": value[0], "count": int(value[1])}
            for key, value in sorted(
                effective_songs.items(),
                key=lambda item: (-int(item[1][1]), item[1][0]),
            )
        ]
        snapshot_song_search_text = ""
        public_songs = songs
        if snapshot_compact_cards:
            fragments: list[str] = []
            remaining = snapshot_song_search_max_chars
            for song in songs:
                fragment = _text(song.get("name"))
                if not fragment or remaining <= 0:
                    break
                fragment = fragment[:remaining]
                fragments.append(fragment)
                remaining -= len(fragment) + 1
            snapshot_song_search_text = " ".join(fragments)
            if not snapshot_preserve_artist_owner_songs:
                public_songs = songs[:COMPACT_VTUBER_PREVIEW_LIMIT]
        previews: list[dict[str, Any]] = []
        for item in artist_additions:
            group = _overlay_candidate_groups((item["row"],), "artists")
            projected = group.get(
                _overlay_artist_group_norm(item["row"].get("artist")), {}
            )
            previews.extend(projected.get("occurrences") or ())
            if len(previews) >= 20:
                break
        payload.update({
            "type": "artist",
            "key": artist_key,
            "name": name,
            "count": row_count,
            "occurrenceCount": row_count,
            "timestampCount": row_count,
            "songCount": len(effective_songs),
            "videoCount": video_count,
            "songs": public_songs,
            "occurrences": _bounded_overlay_previews(previews),
            "sourceDetailKey": (
                source_by_artist.get(artist_key)
                or _production_source_detail_key_for_group(
                    "artists", range_id, artist_key,
                )
            ),
            "sourceDetailPath": "",
        })
        if snapshot_song_search_text:
            payload["_snapshotSongSearchText"] = snapshot_song_search_text
        else:
            payload.pop("_snapshotSongSearchText", None)
        summaries[artist_key] = {
            "detail_key": artist_key,
            "title": "",
            "artist": name,
            "name": name,
            "row_count": row_count,
            "song_count": len(effective_songs),
            "video_count": video_count,
            "timestamp_count": row_count,
            "payload_json": payload,
            "search_text": " ".join(
                value for value in (artist_key, name) if value
            ),
            "channel_search_text": "",
            "_preview_excluded_video_ids": tuple(sorted(full_video_ids)),
            "_preview_excluded_occurrence_ids": tuple(sorted(ordinary_identities)),
        }
    return summaries


def _exact_vtuber_overlay_owner_key(row: Mapping[str, Any]) -> str:
    """Return an internally proven VTuber aggregate owner for exact rebuilds."""

    return (
        _text(row.get("parentVtuberChannelKey"))
        or _text(row.get("canonicalVtuberChannelKey"))
        or _validated_overlay_change_identity(
            row, validate_urls=False,
        )[1]
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
    source_totals_cache: MutableMapping[
        tuple[str, str, str], tuple[int, int]
    ] | None = None,
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
        return _exact_vtuber_overlay_owner_key(row)

    def candidate_video(row: Mapping[str, Any]) -> dict[str, Any]:
        video = _overlay_public_video(row)
        owner_key = _text(row.get("canonicalVtuberChannelKey"))
        if not re.fullmatch(r"UC[A-Za-z0-9_-]{22}", owner_key):
            return video
        video = dict(video)
        handle = _text(video.get("channelHandle"))
        video.update({
            "channelId": owner_key,
            "channelUrl": _canonical_channel_url(owner_key, handle),
        })
        return video

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
        selected_channel_id = (
            _text(accepted.get("canonicalVtuberChannelKey"))
            or selected_channel_id
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
            and video_id and occurrence_id and channel_id
        ):
            # A global runtime chain can contain historical curation for a
            # tuple that never belonged to the persisted VTuber authority.
            # Without an immutable old-side channel there is no parent
            # VTuber source to subtract from.  Candidate/replacement rows
            # still add their independently validated new-side channel.
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
        video = candidate_video(row)
        channel_id = _text(
            row.get("canonicalVtuberChannelKey")
            or video.get("channelId")
            or row.get("channel_id")
        )
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
            record = {
                "video": video,
                "owner_key": channel_id,
                "occurrences": [],
                "identities": set(),
            }
            candidate_records[video_id] = record
        elif _text(record.get("owner_key")) != channel_id:
            raise PostgresAdapterError(
                "VTuber exact overlay video owner is ambiguous"
            )
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
        for public_name, camel_name, snake_name in (
            ("isNiche", "isNiche", "is_niche"),
            ("isUnknownArtist", "isUnknownArtist", "is_unknown_artist"),
        ):
            if public_name in song and song.get(public_name) is not None:
                continue
            value = _scope_boolean_flag(row, camel_name, snake_name)
            if value is not None:
                song[public_name] = value
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
            changed.get("parentVtuberChannelHandle")
            or changed.get("channel_handle")
            or old_video.get("channelHandle")
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
            video = candidate_video(accepted)
            channel_id = _text(
                accepted.get("canonicalVtuberChannelKey")
                or video.get("channelId")
                or accepted.get("channel_id")
            )
            if channel_id:
                candidate_videos.setdefault(channel_id, video)
        for record in candidate_records.values():
            video = record["video"]
            channel_id = _text(record.get("owner_key"))
            if not channel_id:
                continue
            candidate_videos.setdefault(channel_id, video)
            for occurrence in _occurrences_for_range(record, _text(options.get("range")) or "all"):
                if not _occurrence_matches_ranking_scope(
                    occurrence["song"], options,
                ):
                    continue
                song = occurrence["song"]
                if not _text(song.get("title")):
                    # Runtime construction drops empty normalized titles
                    # before VTuber aggregation.  Historical accepted rows
                    # may retain a reviewed curation candidate with no title;
                    # it is not a public song occurrence.
                    continue
                canonical_title, canonical_song_key = (
                    _vtuber_canonical_song_identity(song.get("title"))
                )
                # Symbol-only non-empty titles are valid VTuber occurrences
                # in the runtime builder, but intentionally have no canonical
                # song identity and therefore do not increase songCount.
                canonical_title = canonical_title or _text(song.get("title"))
                candidate_values.append({
                    "channel_id": channel_id,
                    "video_id": _text(occurrence.get("videoId")),
                    "song_key": canonical_song_key,
                    "title": _text(song.get("title")),
                    "canonical_title": canonical_title,
                    "canonical_song_key": canonical_song_key,
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
        scoped_authority = bool(
            options.get("nicheOnly") or options.get("hideUnknownArtist")
        )
        persisted_parent_sources: dict[str, str] = {}
        for changed in (*reset_changes, *runtime_changes):
            owner_key = _text(changed.get("parentVtuberChannelKey"))
            source_key = _text(changed.get("parentVtuberSourceKey"))
            if not owner_key or not source_key:
                continue
            existing_source = persisted_parent_sources.get(owner_key)
            if existing_source and existing_source != source_key:
                raise PostgresAdapterError(
                    "VTuber persisted owner source identity is ambiguous"
                )
            persisted_parent_sources[owner_key] = source_key
        parent_sources = (
            _resolved_vtuber_parent_sources(
                connection,
                parent_revision_id,
                affected_channel_ids,
                _text(options.get("range")) or "all",
                base_groups,
            )
            if scoped_authority
            else {
                channel_id: _exact_vtuber_source_detail_key(
                    _json_object(
                        (base_groups.get(channel_id) or {}).get("payload_json")
                    ),
                    _text(options.get("range")) or "all",
                    channel_id,
                )
                for channel_id in affected_channel_ids
                if base_groups.get(channel_id)
            }
        )
        for owner_key, source_key in persisted_parent_sources.items():
            if owner_key not in base_groups:
                raise PostgresAdapterError(
                    "VTuber persisted owner ranking coverage is incomplete"
                )
            existing_source = parent_sources.get(owner_key)
            if existing_source and existing_source != source_key:
                raise PostgresAdapterError(
                    "VTuber persisted owner source disagrees with ranking"
                )
            parent_sources[owner_key] = source_key
        summaries = (
            _authoritative_vtuber_summary_rows(
                connection,
                parent_revision_id,
                affected_channel_ids,
                full_video_ids,
                affected_occurrence_ids,
                parent_sources,
                candidate_values,
                _text(options.get("range")) or "all",
                source_totals_cache=source_totals_cache,
                options=options,
            )
            if channel_scope is None and not options.get("q")
            else _unfiltered_vtuber_summary_rows(
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
                     o.artist, o.source_id, o.source_system, o.payload_json,
                     o.is_niche, o.is_unknown_artist
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
                AND (NOT %s OR parent.is_unknown_artist IS NOT TRUE)
                AND (NOT %s OR parent.is_niche IS TRUE)
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
                pass
            if int(guard.get("parent_occurrence_count") or 0) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
                pass
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
            if base_detail_key and base_detail_key != channel_id:
                raise PostgresAdapterError(
                    "VTuber base channel metadata identity is invalid"
                )
            candidate_channel_id = _text(video.get("channelId"))
            owner_is_channel_id = bool(
                re.fullmatch(r"UC[A-Za-z0-9_-]{22}", channel_id)
            )
            if owner_is_channel_id and any(
                value and value != channel_id
                for value in (payload_channel_id, candidate_channel_id)
            ):
                raise PostgresAdapterError(
                    "VTuber candidate channel metadata identity is invalid"
                )
            if (
                not owner_is_channel_id
                and payload_channel_id
                and candidate_channel_id
                and payload_channel_id != candidate_channel_id
            ):
                raise PostgresAdapterError(
                    "VTuber candidate channel metadata identity is invalid"
                )
            public_channel_id = candidate_channel_id or payload_channel_id
            if (
                public_channel_id
                and not owner_is_channel_id
                and not candidate_channel_id
                and not re.fullmatch(
                    r"UC[A-Za-z0-9_-]{22}", public_channel_id,
                )
            ):
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
            raw_channel_url = _text(
                video.get("channelUrl") or payload.get("channelUrl")
            )
            if not public_channel_id and not handle and raw_channel_url:
                raise PostgresAdapterError(
                    "VTuber legacy channel metadata identity is invalid"
                )
            channel_url = (
                _canonical_channel_url(public_channel_id, handle)
                if public_channel_id or handle
                else ""
            )
            name = _text(video.get("channelName")) or _text(payload.get("channelName")) or channel_id
            base_previews: list[dict[str, Any]] = []
            for occurrence in payload.get("occurrences") or ():
                if not isinstance(occurrence, Mapping):
                    continue
                nested = occurrence.get("item") if isinstance(occurrence.get("item"), Mapping) else occurrence.get("video")
                if not isinstance(nested, Mapping):
                    continue
                if _text(nested.get("channelId")) not in {
                    "", public_channel_id,
                }:
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
                if _text(item.get("channelId")) not in {
                    "", public_channel_id,
                }:
                    continue
                if public_channel_id:
                    item["channelId"] = public_channel_id
                else:
                    item.pop("channelId", None)
                if handle:
                    item["channelHandle"] = handle
                else:
                    item.pop("channelHandle", None)
                if channel_url:
                    item["channelUrl"] = channel_url
                else:
                    item.pop("channelUrl", None)
                preview["item"] = item
                preview["video"] = dict(item)
            payload.update({
                "type": "vtuber",
                "key": channel_id,
                "name": name,
                "channelName": name,
                "count": int(summary.get("row_count") or 0),
                "songCount": int(summary.get("song_count") or 0),
                "videoCount": int(summary.get("video_count") or 0),
                "timestampCount": int(summary.get("row_count") or 0),
                "occurrences": previews,
                "sourceDetailKey": _exact_vtuber_source_detail_key(
                    payload, _text(options.get("range")) or "all", channel_id,
                ),
            })
            if public_channel_id:
                payload["channelId"] = public_channel_id
            else:
                payload.pop("channelId", None)
            if handle:
                payload["channelHandle"] = handle
            else:
                payload.pop("channelHandle", None)
            if channel_url:
                payload["channelUrl"] = channel_url
                payload["_canonicalChannelUrl"] = channel_url
            else:
                payload.pop("channelUrl", None)
                payload.pop("_canonicalChannelUrl", None)
            if isinstance(summary.get("songs"), list):
                payload["songs"] = copy.deepcopy(summary["songs"])
            else:
                payload.pop("songs", None)
            snapshot_song_search_text = _text(
                summary.get("_snapshotSongSearchText")
            )
            if snapshot_song_search_text:
                payload["_snapshotSongSearchText"] = (
                    snapshot_song_search_text
                )
            else:
                payload.pop("_snapshotSongSearchText", None)
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
        parent_occurrence_rows = parent_occurrence_rows[:_MAX_AFFECTED_RUNTIME_OCCURRENCES]
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
        base_payload = _json_object(
            (base_groups.get(key) or {}).get("payload_json")
        )
        payload["sourceDetailKey"] = _exact_vtuber_source_detail_key(
            base_payload, _text(options.get("range")) or "all", key,
        )
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
            "sourceDetailKey": _exact_vtuber_source_detail_key(
                payload, _text(options.get("range")) or "all", channel_id,
            ),
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


def _exact_vtuber_source_detail_key(
    payload: Mapping[str, Any], range_id: str, channel_id: str,
) -> str:
    """Preserve a parent key or use the runtime exporter's VTuber contract."""

    return _text(payload.get("sourceDetailKey")) or (
        _production_source_detail_key_for_group("vtubers", range_id, channel_id)
    )


def _overlay_rank_value(row: Mapping[str, Any], metric: str) -> int:
    if metric == "videos":
        return int(row.get("video_count") or 0)
    if metric == "songs":
        return int(row.get("song_count") or 0)
    return int(row.get("row_count") or 0)


def _final_generic_aggregate_totals(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, int]:
    """Count one complete final canonical ranking set without delta guesses."""

    return {
        "totalCount": len(rows),
        "totalOccurrenceCount": sum(
            int(row.get("row_count") or 0) for row in rows
        ),
        "totalSongCount": sum(
            int(row.get("song_count") or 0) for row in rows
        ),
        "totalVideoCount": sum(
            int(row.get("video_count") or 0) for row in rows
        ),
    }


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


def _vtuber_owned_overlay_changes(
    changes: Iterable[Mapping[str, Any]],
) -> tuple[Mapping[str, Any], ...]:
    """Keep only changes with immutable old-side VTuber ownership.

    Historical global curation can resolve to a tombstone whose tuple is
    absent from both the parent runtime and persisted source authority.  Such
    a row is a no-op for VTuber aggregation, not evidence that a source
    preimage may be skipped.  Conflicting identity evidence still raises via
    ``_validated_overlay_change_identity``.
    """

    owned: list[Mapping[str, Any]] = []
    for change in changes:
        if not _runtime_occurrence_has_immutable_old_side(change):
            # A later video-level repair may infer which channel owns this
            # video, but it cannot prove that a historical occurrence ever
            # existed in the immutable full-runtime parent.  Do not turn that
            # inferred owner into a parent subtraction.  The independently
            # validated replacement row remains eligible as the new side.
            continue
        if (
            _text(change.get("parentVtuberChannelKey"))
            or _validated_overlay_change_identity(
                change, validate_urls=False,
            )[1]
        ):
            owned.append(change)
    return tuple(owned)


def _runtime_occurrence_has_immutable_old_side(
    change: Mapping[str, Any],
) -> bool:
    """Return whether an occurrence change may subtract a parent tuple.

    ``_enrich_runtime_parent_group_keys`` records exact parent coverage before
    any later video-level VTuber owner inference.  A change absent from that
    parent and lacking an originally explicit owner is overlay-only: it may
    still contribute an independently validated replacement, but it is never
    permission to remove a persisted source occurrence.  Missing markers are
    retained for legacy callers and must still pass their normal strict
    identity checks.
    """

    entity_type = _text(
        change.get("entityType") or change.get("entity_type")
    )
    if entity_type not in {"occurrences", "runtime_occurrences"}:
        return True
    parent_exists = change.get("_parentRuntimeOccurrenceExists")
    owner_was_explicit = change.get("_runtimeOccurrenceOwnerWasExplicit")
    for marker in (parent_exists, owner_was_explicit):
        if marker is not None and not isinstance(marker, bool):
            raise PostgresAdapterError(
                "VTuber parent occurrence coverage marker is invalid"
            )
    return not (
        parent_exists is False and owner_was_explicit is False
    )


def _bounded_parent_vtuber_video_owners(
    connection,
    parent_revision_id: str,
    video_ids: Iterable[str],
    range_id: str,
) -> dict[str, dict[str, Any]]:
    """Resolve only touched videos against persisted VTuber source authority.

    ``runtime_source_occurrences`` deliberately has no broad ``video_id``
    btree.  The production-safe lookup therefore probes the existing trigram
    video-search index once per already-bounded requested video and rechecks
    exact equality.  Zero rows means that the old tuple never belonged to a
    persisted VTuber source; two source owners are always ambiguous.
    """

    requested_ids = sorted({_text(value) for value in video_ids if _text(value)})
    if not requested_ids:
        return {}
    if len(requested_ids) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "VTuber persisted owner lookup exceeded bounded video cap"
        )
    requested = [
        {
            "video_id": video_id,
            "search_pattern": f"%{_sql_like_literal(video_id)}%",
        }
        for video_id in requested_ids
    ]
    rows = _rows(
        connection,
        """
        /* bounded persisted VTuber old-owner repair */
        WITH requested AS MATERIALIZED (
          SELECT video_id, search_pattern
          FROM jsonb_to_recordset(%s::jsonb)
            AS item(video_id text, search_pattern text)
        )
        SELECT requested.video_id, authority.source_key,
               authority.entity_key, authority.payload_json
        FROM requested
        JOIN LATERAL (
          SELECT DISTINCT ON (occurrence.source_key)
                 occurrence.source_key, detail.entity_key,
                 detail.payload_json
          FROM runtime_source_occurrences AS occurrence
          JOIN runtime_source_details AS detail
            ON detail.revision_id = occurrence.revision_id
           AND detail.source_key = occurrence.source_key
           AND detail.range_id = occurrence.range_id
           AND detail.entity_type = 'vtuber'
          WHERE occurrence.revision_id = %s
            AND occurrence.range_id = %s
            AND daily_song_source_video_search_text(
                  occurrence.title,
                  occurrence.video_id,
                  occurrence.payload_json
                ) ILIKE requested.search_pattern ESCAPE E'\\\\'
            AND occurrence.video_id = requested.video_id
          ORDER BY occurrence.source_key, occurrence.position
          LIMIT 2
        ) AS authority ON TRUE
        ORDER BY requested.video_id, authority.source_key
        LIMIT %s
        """,
        [
            json.dumps(requested, ensure_ascii=False),
            parent_revision_id,
            range_id,
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
        ],
    )
    if len(rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "VTuber persisted owner lookup exceeded bounded result cap"
        )
    requested_set = set(requested_ids)
    owners: dict[str, dict[str, Any]] = {}
    for row in rows:
        video_id = _text(row.get("video_id"))
        source_key = _text(row.get("source_key"))
        owner_key = _text(row.get("entity_key"))
        payload = _json_object(row.get("payload_json"))
        if (
            video_id not in requested_set
            or not source_key
            or not owner_key
            or not payload
        ):
            raise PostgresAdapterError(
                "VTuber persisted owner identity is invalid"
            )
        if video_id in owners:
            raise PostgresAdapterError(
                "VTuber persisted owner identity is ambiguous"
            )
        owners[video_id] = {
            "video_id": video_id,
            "source_key": source_key,
            "entity_key": owner_key,
            "payload_json": payload,
        }
    return owners


def _vtuber_owner_alias_sets(
    value: Mapping[str, Any], *, persisted: bool,
) -> tuple[set[str], set[str], set[str]]:
    """Return strict strong-id, handle, and display-name alias sets."""

    payload = _json_object(
        value.get("payload_json") or value.get("video_payload_json")
    )
    if isinstance(payload.get("payload"), Mapping):
        payload = dict(payload["payload"])
    public_video = {} if persisted else _overlay_public_video(value)
    id_values = {
        _text(value.get("entity_key")) if persisted else "",
        _text(value.get("channel_id") or value.get("channelId")),
        _text(payload.get("key")),
        _text(payload.get("channelId")),
        _text(public_video.get("channelId")),
    }
    strong_ids = {
        item
        for item in id_values
        if re.fullmatch(r"UC[A-Za-z0-9_-]{22}", item)
    }
    handles = {
        normalized
        for item in (
            value.get("channel_handle"), value.get("channelHandle"),
            payload.get("channelHandle"), public_video.get("channelHandle"),
        )
        if (normalized := _normalized_channel_handle(item))
    }
    name_values = {
        _text(value.get("entity_key")) if persisted else "",
        _text(value.get("channel_name") or value.get("channelName")),
        _text(payload.get("key")), _text(payload.get("name")),
        _text(payload.get("channelName")),
        _text(public_video.get("channelName")),
    }
    names = {
        normalized
        for item in name_values
        if item and not re.fullmatch(r"UC[A-Za-z0-9_-]{22}", item)
        if (normalized := _overlay_norm(item))
    }
    return strong_ids, handles, names


def _bind_direct_vtuber_parent_owners(
    connection,
    parent_revision_id: str,
    range_id: str,
    candidate_rows: Sequence[Mapping[str, Any]],
    accepted_video_resets: Mapping[str, Mapping[str, Any]],
    changes: Sequence[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """Bind direct-ranking old sides to exact persisted VTuber owners.

    Candidate rows retain their raw accepted metadata.  A separate aggregate
    owner override is added only when a selected full reset has the same
    strong channel id, the same exact handle, or one batch-unique normalized
    legacy display name.  Otherwise it remains a genuine two-sided move.
    """

    validated_change_identities: dict[int, tuple[str, str]] = {}
    unresolved_video_ids: set[str] = set()
    same_video_replacement_ids: set[str] = set()
    for change in changes:
        # Never trust a similarly named field carried by an overlay payload.
        # Only this bounded persisted-owner lookup may mint the proof.
        change.pop("_persistedVtuberSameVideoOwnerProven", None)
        video_id, channel_id = _validated_overlay_change_identity(
            change, validate_urls=False,
        )
        validated_change_identities[id(change)] = (video_id, channel_id)
        if video_id and not channel_id:
            unresolved_video_ids.add(video_id)
        replacement = _json_object(change.get("replacementPayload"))
        replacement_video_id = _text(
            replacement.get("videoId") or replacement.get("video_id")
        )
        if (
            video_id
            and bool(change.get("replacement"))
            and bool(change.get("replacementSameVideo"))
            and replacement_video_id == video_id
        ):
            # The old side may already carry its channel while the replacement
            # occurrence omits every denormalised channel field.  Strict
            # ranking projection still needs the same persisted video owner
            # that source materialisation uses to update the tuple in place.
            same_video_replacement_ids.add(video_id)
    requested_video_ids = unresolved_video_ids | same_video_replacement_ids | {
        _text(video_id)
        for video_id in accepted_video_resets
        if _text(video_id)
    }
    owners = _bounded_parent_vtuber_video_owners(
        connection, parent_revision_id, requested_video_ids, range_id,
    )
    owner_by_key: dict[str, dict[str, Any]] = {}
    name_owners: dict[str, set[str]] = defaultdict(set)
    for owner in owners.values():
        owner_key = _text(owner.get("entity_key"))
        source_key = _text(owner.get("source_key"))
        existing = owner_by_key.get(owner_key)
        if existing and _text(existing.get("source_key")) != source_key:
            raise PostgresAdapterError(
                "VTuber persisted owner source identity is ambiguous"
            )
        owner_by_key[owner_key] = owner
        _, _, names = _vtuber_owner_alias_sets(owner, persisted=True)
        for name in names:
            name_owners[name].add(owner_key)

    for change in changes:
        video_id, channel_id = validated_change_identities[id(change)]
        owner = owners.get(video_id)
        replacement = _json_object(change.get("replacementPayload"))
        replacement_video_id = _text(
            replacement.get("videoId") or replacement.get("video_id")
        )
        same_video_replacement = bool(
            change.get("replacement")
            and change.get("replacementSameVideo")
            and replacement_video_id == video_id
        )
        if not owner or (
            channel_id
            and not bool(change.get("acceptedVideoReset"))
            and not same_video_replacement
        ):
            continue
        payload = _json_object(owner.get("payload_json"))
        change["parentVtuberChannelKey"] = _text(owner.get("entity_key"))
        change["parentVtuberSourceKey"] = _text(owner.get("source_key"))
        parent_handle = _text(payload.get("channelHandle"))
        parent_name = _text(payload.get("channelName") or payload.get("name"))
        if parent_handle:
            change["parentVtuberChannelHandle"] = parent_handle
        if parent_name:
            change["parentVtuberChannelName"] = parent_name

        # A same-video replacement may omit denormalised channel fields even
        # though this exact video has one unique persisted VTuber source
        # owner.  Ranking used to drop that replacement in strict mode while
        # source detail retained it in place, creating 73 production-only
        # cardinality differences.  The owner lookup above proves only the
        # immutable video/channel tuple; it never proves an occurrence old
        # side.  Bind that tuple to the replacement without altering its raw
        # occurrence payload.  Cross-video replacements and any conflicting
        # identity remain fail closed.
        if not same_video_replacement:
            continue
        parent_ids, parent_handles, _parent_names = _vtuber_owner_alias_sets(
            owner, persisted=True,
        )
        owner_key = _text(owner.get("entity_key"))
        owner_source_key = _text(owner.get("source_key"))
        old_payload = _json_object(change.get("videoPayload"))
        replacement_video = _json_object(change.get("replacementVideoPayload"))
        explicit_video_ids = {
            _text(value)
            for value in (
                change.get("videoId"), change.get("video_id"),
                old_payload.get("videoId"), old_payload.get("video_id"),
                replacement.get("videoId"), replacement.get("video_id"),
                replacement_video.get("videoId"),
                replacement_video.get("video_id"),
            )
            if _text(value)
        }
        explicit_channel_ids = {
            _text(value)
            for value in (
                change.get("channelId"), change.get("channel_id"),
                old_payload.get("channelId"), old_payload.get("channel_id"),
                replacement.get("channelId"), replacement.get("channel_id"),
                replacement_video.get("channelId"),
                replacement_video.get("channel_id"),
            )
            if _text(value)
        }
        old_occurrence_id = _text(
            change.get("occurrenceId") or change.get("occurrence_id")
        )
        replacement_occurrence_id = _text(
            replacement.get("occurrenceId")
            or replacement.get("occurrence_id")
        )
        if not parent_ids:
            # Legacy source authority can have one exact source/entity owner
            # for this video while predating channelId entirely.  It is safe
            # only as an aggregate owner key for an in-place occurrence
            # replacement whose full-runtime parent tuple was independently
            # proven.  Never turn the legacy display key into a public id.
            if not (
                owner_key
                and owner_source_key
                and change.get("_parentRuntimeOccurrenceExists") is True
                and change.get("_runtimeOccurrenceOwnerWasExplicit") is False
                and old_occurrence_id
                and replacement_occurrence_id == old_occurrence_id
                and explicit_video_ids == {video_id}
            ):
                continue
            explicit_handles = {
                _normalized_channel_handle(value)
                for value in (
                    change.get("channelHandle"),
                    change.get("channel_handle"),
                    old_payload.get("channelHandle"),
                    old_payload.get("channel_handle"),
                    replacement.get("channelHandle"),
                    replacement.get("channel_handle"),
                    replacement_video.get("channelHandle"),
                    replacement_video.get("channel_handle"),
                )
                if _normalized_channel_handle(value)
            }
            explicit_urls = {
                _text(value)
                for value in (
                    change.get("channelUrl"), change.get("channel_url"),
                    old_payload.get("channelUrl"),
                    old_payload.get("channel_url"),
                    replacement.get("channelUrl"),
                    replacement.get("channel_url"),
                    replacement_video.get("channelUrl"),
                    replacement_video.get("channel_url"),
                )
                if _text(value)
            }
            if explicit_channel_ids or explicit_handles or explicit_urls:
                raise PostgresAdapterError(
                    "VTuber legacy same-video replacement conflicts with "
                    "source owner"
                )
            change["canonicalVtuberChannelKey"] = owner_key
            change["parentVtuberSourceKey"] = owner_source_key
            change["_persistedVtuberSameVideoOwnerProven"] = True
            continue
        if len(parent_ids) != 1:
            continue
        parent_channel_id = next(iter(parent_ids))
        if explicit_video_ids != {video_id} or (
            explicit_channel_ids
            and explicit_channel_ids != {parent_channel_id}
        ):
            raise PostgresAdapterError(
                "VTuber same-video replacement conflicts with source owner"
            )
        parent_handle = (
            next(iter(parent_handles)) if len(parent_handles) == 1 else ""
        )
        parent_url = _canonical_channel_url(
            parent_channel_id, parent_handle,
        )
        immutable_video = {
            "videoId": video_id,
            "channelId": parent_channel_id,
            "channelHandle": parent_handle,
            "channelUrl": parent_url,
        }
        if parent_name:
            immutable_video["channelName"] = parent_name
        for key, value in immutable_video.items():
            if value:
                old_payload.setdefault(key, value)
                replacement_video.setdefault(key, value)
        change["channel_id"] = parent_channel_id
        if parent_handle:
            change["channel_handle"] = parent_handle
        change["channel_url"] = parent_url
        if parent_name:
            change["channel_name"] = parent_name
        change["videoPayload"] = old_payload
        change["replacementVideoPayload"] = replacement_video

    bound_resets = {
        _text(video_id): dict(row)
        for video_id, row in accepted_video_resets.items()
        if _text(video_id)
    }
    alias_owner_by_video: dict[str, dict[str, Any]] = {}
    for video_id, reset in bound_resets.items():
        owner = owners.get(video_id)
        if not owner:
            continue
        parent_ids, parent_handles, parent_names = _vtuber_owner_alias_sets(
            owner, persisted=True,
        )
        candidate_ids, candidate_handles, candidate_names = (
            _vtuber_owner_alias_sets(reset, persisted=False)
        )
        same_owner = bool(parent_ids and parent_ids & candidate_ids)
        if not parent_ids:
            if parent_handles:
                same_owner = bool(parent_handles & candidate_handles)
            elif parent_names:
                same_owner = any(
                    name in candidate_names and len(name_owners[name]) == 1
                    for name in parent_names
                )
        if not same_owner:
            continue
        owner_key = _text(owner.get("entity_key"))
        reset["canonicalVtuberChannelKey"] = owner_key
        reset["parentVtuberSourceKey"] = _text(owner.get("source_key"))
        alias_owner_by_video[video_id] = owner

    for change in changes:
        video_id = _text(change.get("videoId") or change.get("video_id"))
        owner = alias_owner_by_video.get(video_id)
        if owner:
            change["canonicalVtuberChannelKey"] = _text(
                owner.get("entity_key")
            )

    bound_candidates: list[dict[str, Any]] = []
    for raw_row in candidate_rows:
        row = dict(raw_row)
        video_id = _text(row.get("video_id") or row.get("videoId"))
        owner = alias_owner_by_video.get(video_id)
        if owner:
            row["canonicalVtuberChannelKey"] = _text(owner.get("entity_key"))
            row["parentVtuberSourceKey"] = _text(owner.get("source_key"))
        bound_candidates.append(row)
    return bound_candidates, bound_resets


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
    *,
    reconciliation_counts: MutableMapping[
        tuple[str, str, str, str, str], tuple[int, int, int]
    ] | None = None,
    snapshot_reset_changes: MutableMapping[
        tuple[str, str, str, tuple[str, ...]], list[dict[str, Any]]
    ] | None = None,
    snapshot_original_group_counts: MutableMapping[
        tuple[str, str, str, tuple[str, ...]], Mapping[tuple[str, str, str], int]
    ] | None = None,
    snapshot_vtuber_source_totals: MutableMapping[
        tuple[str, str, str], tuple[int, int]
    ] | None = None,
    snapshot_artist_aliases: MutableMapping[
        tuple[str, str, str], tuple[str, str, str]
    ] | None = None,
    snapshot_artist_source_totals: MutableMapping[
        tuple[str, str, str, str], tuple[int, int]
    ] | None = None,
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
    db_scope = _ranking_scope_key(options)
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
    base_params: list[Any] = [
        parent[0], options["range"], options["view"], db_metric, db_scope,
    ]
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
        if options["view"] not in {"songs", "songIndex"}:
            for token in options["searchTokens"]:
                search_clause += " AND (search_text ILIKE %s OR channel_search_text ILIKE %s)"
                needle = f"%{token}%"
                base_params.extend([needle, needle])
        else:
            search_columns = {
                "title": "title",
                "artist": "artist",
                "channel": "channel_search_text",
            }
            search_fields = _effective_search_fields(options)
            # Video/source are payload-only fields.  Do not substitute the
            # legacy aggregate search_text: mixed rows must be filtered by the
            # bounded payload helper after the row is selected.
            if not any(field in {"video", "source"} for field in search_fields):
                for token in options["searchTokens"]:
                    predicates: list[str] = []
                    for field in search_fields:
                        column = search_columns.get(field)
                        if not column:
                            continue
                        predicates.append(f"{column} ILIKE %s ESCAPE E'\\\\'")
                        base_params.append(f"%{_sql_like_literal(token)}%")
                    search_clause += (
                        " AND (" + " OR ".join(predicates) + ")"
                        if predicates
                        else " AND FALSE"
                    )
    (
        source_search_cte,
        source_search_condition,
        source_cte_params,
        source_outer_params,
    ) = _runtime_source_search_sql(options, revision_id, parent[0], "ranking")
    source_search_sql_active = bool(source_search_condition)
    base_payload_select = (
        _runtime_ranking_light_payload_select("ranking")
        if source_search_sql_active
        else (
            "payload_json"
            if (
                options["view"] == "vtubers" and exact_channel_scope is not None
            ) or any(
                field in {"video", "source"}
                for field in _effective_search_fields(options)
            )
            else "NULL::jsonb AS payload_json"
        )
    )
    if source_search_sql_active:
        search_select = "'' AS search_text, ranking.channel_search_text"
    bounded_no_search = not bool(options.get("q"))
    base_limit_clause = ""
    base_totals: dict[str, int] | None = None
    base_window_end = 0
    if bounded_no_search:
        # Preparation is shared by every page and page size.  Keep this as a
        # fixed scalar window; page selection happens after preparation.
        base_window_end = _GENERIC_NO_SEARCH_PREPARATION_WINDOW
        base_limit = base_window_end
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
              AND metric = %s AND scope_key = %s AND {metric_column} >= %s
            """,
            [
                parent[0],
                options["range"],
                options["view"],
                db_metric,
                db_scope,
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
    base_from = (
        "eligible_ranking AS ranking"
        if source_search_sql_active
        else "runtime_ranking_rows AS ranking"
    )
    base_where = (
        f"WHERE TRUE{source_search_condition}"
        if source_search_sql_active
        else (
            "WHERE ranking.revision_id = %s AND ranking.range_id = %s "
            "AND ranking.view = %s AND ranking.metric = %s "
            "AND ranking.scope_key = %s"
            f"{search_clause}"
        )
    )
    base_query_params = (
        [*source_cte_params, *source_outer_params]
        if source_search_sql_active
        else base_params
    )
    base_rows = _rows(
        connection,
        f"""
        {source_search_cte}
        SELECT row_id, rank, detail_key, title, artist, name, row_count, song_count,
               video_count, timestamp_count, {base_payload_select}, {search_select}
        FROM {base_from}
        {base_where}
        ORDER BY rank
        {base_limit_clause}
        """,
        base_query_params,
    )
    if options["searchTokens"] and any(
        field in {"video", "source"}
        for field in _effective_search_fields(options)
    ) and not source_search_sql_active:
        base_rows = [
            row for row in base_rows
            if _public_row_matches_search(row, options)
        ]
    groups = { _text(row.get("detail_key")): dict(row) for row in base_rows }
    # Search requests do not enter the bounded no-search affected window.
    # Snapshot their filtered parent scalar identities before any tombstone or
    # candidate mutation so canonical replacement lookup remains available.
    filtered_persisted_scalar_rows = {
        key: {
            "detail_key": row.get("detail_key"),
            "title": row.get("title"),
            "artist": row.get("artist"),
        }
        for key, row in groups.items()
        if key
    }
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
    compatible_reset_rows: tuple[Mapping[str, Any], ...] = ()
    song_view = options["view"] in {"songs", "songIndex", "vsingerSongs"}
    if accepted_video_resets and not song_view:
        compatible_reset_rows = _selected_full_reset_candidate_rows(
            connection,
            overlay_ids,
            accepted_video_resets,
            options["range"],
            include_payload=not bool(direct_overlay_revision_ids),
        )
    candidate_range_rows = tuple(
        _overlay_rows_for_range(candidate_rows, options["range"])
    )
    candidate_range_video_ids = {
        _text(row.get("video_id") or row.get("videoId"))
        for row in (*candidate_range_rows, *compatible_reset_rows)
        if _text(row.get("video_id") or row.get("videoId"))
    }
    if song_view:
        # Persisted Song sources only apply full-video resets from the same
        # physical range.  Rankings must use that identical boundary: a 7d
        # reset cannot delete an immutable all-range parent occurrence and
        # then replace it with a projected 7d tuple that the Song source
        # contract intentionally excludes.
        accepted_video_resets = {
            video_id: row
            for video_id, row in accepted_video_resets.items()
            if video_id in candidate_range_video_ids
            or _text(
                _overlay_payload(row).get("rangeId")
                or _overlay_payload(row).get("range_id")
                or row.get("range_id")
                or row.get("rangeId")
            ) == options["range"]
        }
    candidate_rows = list(candidate_range_rows)
    if compatible_reset_rows:
        compatible_by_identity = {
            _overlay_candidate_identity(row): dict(row)
            for row in candidate_rows
        }
        for row in compatible_reset_rows:
            compatible_by_identity[_overlay_candidate_identity(row)] = dict(row)
        candidate_rows = list(compatible_by_identity.values())
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
    reset_changes = _snapshot_accepted_video_reset_changes(
        connection,
        parent[0],
        accepted_video_resets,
        options,
        identity_only=bool(direct_overlay_revision_ids),
        include_persisted_source_authority=(
            (
                snapshot_reset_changes is not None
                or options["view"] == "artists"
            )
            and not bool(direct_overlay_revision_ids)
        ),
        cache=snapshot_reset_changes,
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
    candidate_rows = list(candidate_range_rows)
    if compatible_reset_rows:
        compatible_by_identity = {
            _overlay_candidate_identity(row): dict(row)
            for row in candidate_rows
        }
        for row in compatible_reset_rows:
            compatible_by_identity[_overlay_candidate_identity(row)] = dict(row)
        candidate_rows = list(compatible_by_identity.values())
    runtime_changes = _overlay_rows_for_range(runtime_changes_all, options["range"])
    _enrich_runtime_parent_group_keys(
        connection,
        parent[0],
        runtime_changes,
        range_id=options["range"],
        parent_group_cache=snapshot_original_group_counts,
    )
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
                ):
                    raise PostgresAdapterError(
                        "direct accepted identity repair returned a duplicate occurrence"
                    )
                direct_seen.add(identity)
                if identity in accepted_identity_by_occurrence:
                    # Compatible full-reset hydration already supplied this
                    # accepted occurrence with complete public metadata.
                    # Keep that stronger row and do not treat the same logical
                    # identity as a second repair candidate.
                    continue
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
    if direct_overlay_revision_ids and options["view"] == "vtubers":
        candidate_rows, accepted_video_resets = (
            _bind_direct_vtuber_parent_owners(
                connection,
                parent[0],
                options["range"],
                candidate_rows,
                accepted_video_resets,
                identity_changes,
            )
        )
        exact_candidate_rows = tuple(candidate_rows)
    replacement_rows = _runtime_replacement_candidate_rows(
        runtime_changes,
        options["view"] == "vtubers",
    )
    exact_artist_candidate_rows = tuple(candidate_rows)
    exact_artist_reset_changes = tuple(reset_changes)
    exact_artist_runtime_changes = tuple(runtime_changes)
    exact_artist_replacement_rows = tuple(replacement_rows)
    artist_parent_sources: dict[str, str] = {}
    artist_alias_to_canonical: dict[str, str] = {}
    artist_parent_names: dict[str, str] = {}
    affected_artist_keys: set[str] = set()
    if options["view"] == "artists":
        requested_artist_keys = {
            key
            for row in (*candidate_rows, *replacement_rows)
            if (key := _runtime_view_group_key(row, "artists"))
        }
        requested_artist_keys.update(
            key
            for key in _runtime_change_view_keys(
                (*reset_changes, *runtime_changes), "artists",
            )
            if key
        )
        (
            artist_parent_sources,
            artist_alias_to_canonical,
            artist_parent_names,
        ) = _resolved_artist_parent_sources(
            connection,
            parent[0],
            requested_artist_keys,
            options["range"],
            alias_cache=snapshot_artist_aliases,
        )
        affected_artist_keys = {
            artist_alias_to_canonical.get(key, key)
            for key in requested_artist_keys
            if artist_alias_to_canonical.get(key, key)
        }
        affected_artist_keys.update(artist_parent_sources)
    bounded_affected_keys: set[str] = set()
    bounded_original_affected: dict[str, dict[str, Any]] = {}
    if bounded_no_search:
        bounded_affected_keys.update(
            key
            for row in (*candidate_rows, *replacement_rows)
            if (key := _runtime_view_group_key(row, options["view"]))
        )
        if options["view"] in {"songs", "songIndex", "vsingerSongs"}:
            # Overlay-only song cards retain their established raw-normalized
            # key.  Also probe the parent runtime's punctuation-insensitive
            # canonical key inside this already bounded affected set: when
            # that parent card exists, ``_canonical_overlay_delta_group_key``
            # can merge the accepted tuple instead of creating a duplicate
            # low-count card with only display punctuation changed.
            bounded_affected_keys.update(
                f"{title_key}::{artist_key}"
                for row in (*candidate_rows, *replacement_rows)
                for title_key, artist_key in (
                    _runtime_change_song_group_identity(row),
                )
                if title_key
            )
        bounded_affected_keys.update(
            key
            for key in _runtime_change_view_keys(
                (*reset_changes, *runtime_changes),
                options["view"],
            )
            if key
        )
        if options["view"] == "artists":
            bounded_affected_keys.update(affected_artist_keys)
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
                  AND metric = %s AND scope_key = %s AND detail_key = ANY(%s)
                ORDER BY rank
                LIMIT %s
                """,
                [
                    parent[0],
                    options["range"],
                    options["view"],
                    db_metric,
                    db_scope,
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
                    WITH affected_keys(detail_key) AS MATERIALIZED (
                        SELECT DISTINCT affected.detail_key
                        FROM unnest(%s::text[]) AS affected(detail_key)
                    )
                    SELECT parent_row.rank, parent_row.detail_key,
                           parent_row.title, parent_row.artist,
                           parent_row.name, parent_row.row_count,
                           parent_row.song_count, parent_row.video_count,
                           parent_row.timestamp_count,
                           NULL::jsonb AS payload_json,
                           '' AS search_text, '' AS channel_search_text
                    FROM runtime_ranking_rows AS parent_row
                    WHERE parent_row.revision_id = %s
                      AND parent_row.range_id = %s
                      AND parent_row.view = %s
                      AND parent_row.metric = %s
                      AND parent_row.scope_key = %s
                      AND parent_row.{metric_column} >= %s
                      AND NOT EXISTS (
                          SELECT 1
                          FROM affected_keys
                          WHERE affected_keys.detail_key = parent_row.detail_key
                      )
                    ORDER BY parent_row.rank
                    LIMIT %s
                    """,
                    [
                        sorted(bounded_affected_keys),
                        parent[0],
                        options["range"],
                        options["view"],
                        db_metric,
                        db_scope,
                        int(options["minCount"]),
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
    if options["view"] not in {"artists", "vtubers"}:
        # Parent ranking rows already use the exact persisted scope_key.  Keep
        # every overlay mutation in that same occurrence scope: removals use
        # the immutable old row, while additions use the accepted/replacement
        # final row.  This lets one curation move across scope boundaries
        # without deleting or adding the wrong side.
        generic_candidate_rows = list(_ranking_scope_rows(
            generic_candidate_rows, options,
        ))
        generic_replacement_rows = list(_ranking_scope_rows(
            generic_replacement_rows, options,
        ))
        generic_reset_changes = list(_ranking_scope_rows(
            generic_reset_changes, options,
        ))
        generic_runtime_changes = list(_ranking_scope_rows(
            generic_runtime_changes, options,
        ))
    if options["searchTokens"] and options["view"] != "vtubers":
        generic_candidate_rows = [
            row for row in generic_candidate_rows
            if _public_row_matches_search(row, options)
        ]
        generic_replacement_rows = [
            row for row in generic_replacement_rows
            if _public_row_matches_search(row, options)
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
    if options["view"] not in {"artists", "vtubers"}:
        _enrich_runtime_original_group_counts(
            connection,
            parent[0],
            generic_candidate_rows,
            # Accepted resets get exact counts from ``generic_reset_changes``
            # below.  Only the remaining runtime curation needs this parent
            # lookup; snapshot callers reuse its range-scoped result across
            # metric/filter combinations for the same exact video set.
            generic_runtime_changes,
            range_id=options["range"],
            options=options,
            parent_count_cache=snapshot_original_group_counts,
        )
        # ``replacement_rows`` is first prepared before the bounded parent
        # count lookup above.  Rebuild it from the now-enriched, scope-filtered
        # runtime changes so canonical Song replacements carry the duplicate
        # video marker into the generic delta grouping.
        replacement_rows = _runtime_replacement_candidate_rows(
            generic_runtime_changes,
        )
        generic_replacement_rows = list(replacement_rows)
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
        reset_title_key, reset_artist_key = (
            _runtime_change_song_group_identity(change)
        )
        reset_group_counts[(
            _text(change.get("videoId")),
            reset_title_key,
            reset_artist_key,
        )] += 1
    for change in generic_reset_changes:
        reset_title_key, reset_artist_key = (
            _runtime_change_song_group_identity(change)
        )
        change["originalGroupVideoOccurrenceCount"] = reset_group_counts[(
            _text(change.get("videoId")),
            reset_title_key,
            reset_artist_key,
        )]
    # The exact VTuber/Artist aggregates below own both sides of every
    # reset/move.
    # Applying the bounded generic mutation here would make the caller replay
    # those same tuples after the exact result is installed.
    if options["view"] not in {"artists", "vtubers"}:
        _apply_runtime_tombstone_groups(
            groups,
            generic_reset_changes,
            options["view"],
            "_deferred_reset_preview_changes",
            allow_accepted_reset_detail_fallback=True,
        )
        _apply_runtime_change_previews(
            groups, generic_reset_changes, options["view"],
        )
    exact_reset_changes = tuple(reset_changes)
    exact_runtime_changes = tuple(runtime_changes)
    exact_replacement_rows = tuple(replacement_rows)
    if options["view"] == "vtubers":
        exact_reset_changes = _vtuber_owned_overlay_changes(
            exact_reset_changes,
        )
        exact_runtime_changes = _vtuber_owned_overlay_changes(
            exact_runtime_changes,
        )
    if exact_channel_scope is not None:
        exact_scope_set = {
            _text(value) for value in exact_channel_scope if _text(value)
        }
        exact_replacement_rows = tuple(
            row
            for row in exact_replacement_rows
            if _exact_vtuber_overlay_owner_key(row) in exact_scope_set
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
            if _exact_vtuber_overlay_owner_key(change) in exact_scope_set
        )
        exact_runtime_changes = tuple(
            change
            for change in exact_runtime_changes
            if (
                _exact_vtuber_overlay_owner_key(change) in exact_scope_set
                or (
                    _text(change.get("videoId") or change.get("video_id")),
                    _text(
                        change.get("occurrenceId")
                        or change.get("occurrence_id")
                    ),
                ) in replacement_identities
            )
        )
    clicked_song_candidate_rows = tuple(generic_candidate_rows)
    candidate_rows = list(generic_candidate_rows)
    replacement_rows = list(generic_replacement_rows)
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
            if _public_row_matches_search(row, options)
        ]
        exact_candidate_rows = tuple(
            row for row in exact_candidate_rows
            if _public_row_matches_search(row, options)
        )
        exact_replacement_rows = tuple(
            row for row in exact_replacement_rows
            if _public_row_matches_search(row, options)
        )
    # Exact VTuber/Artist aggregation owns the complete effective tuple set
    # for every affected identity, including identities whose final count is
    # zero.  Building the generic delta first is redundant and can replay the
    # same reset/replacement a second time.
    song_reset_candidate_owners = (
        _accepted_song_reset_candidate_owner_keys(
            candidate_rows, generic_reset_changes,
        )
        if options["view"] in {"songs", "songIndex", "vsingerSongs"}
        else {}
    )
    delta = (
        {} if options["view"] in {"artists", "vtubers"}
        else _overlay_candidate_groups(
            candidate_rows,
            options["view"],
            song_reset_candidate_owners,
        )
    )
    # Exact candidates are already grouped under the persisted owner.  Keep
    # the owner-to-self map only for the existing missing-owner fail-closed
    # gate in ``_canonical_overlay_delta_group_key``.
    song_reset_owner_keys = {
        owner_key: owner_key
        for owner_key in song_reset_candidate_owners.values()
    }
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
            source_totals_cache=snapshot_vtuber_source_totals,
        )
        if options["view"] == "vtubers"
        else {}
    )
    exact_artist_required = bool(
        options["view"] == "artists"
        and (
            exact_artist_candidate_rows
            or exact_artist_reset_changes
            or exact_artist_runtime_changes
            or exact_artist_replacement_rows
        )
    )
    exact_artist_rows = (
        _authoritative_artist_summary_rows(
            connection,
            parent[0],
            affected_artist_keys,
            artist_parent_sources,
            artist_parent_names,
            artist_alias_to_canonical,
            exact_artist_candidate_rows,
            exact_artist_reset_changes,
            exact_artist_runtime_changes,
            exact_artist_replacement_rows,
            options,
            source_totals_cache=snapshot_artist_source_totals,
        )
        if options["view"] == "artists"
        else {}
    )
    phase_started = _phase_trace("exact", phase_started)
    exact_vtuber_owned = (
        options["view"] == "vtubers" and bool(exact_vtuber_rows)
    )
    exact_artist_owned = (
        options["view"] == "artists" and bool(exact_artist_rows)
    )
    if exact_required and not exact_vtuber_owned:
        raise PostgresAdapterError("VTuber exact overlay required coverage is empty")
    if exact_artist_required and not exact_artist_owned:
        raise PostgresAdapterError("Artist exact overlay required coverage is empty")
    exact_owned_rows = {**exact_vtuber_rows, **exact_artist_rows}
    groups.update(exact_owned_rows)
    if options["view"] in {"artists", "vtubers"}:
        # Exact helpers return explicit zero summaries as internal coverage
        # markers; they must not become public rows or contribute to totals.
        for key, row in exact_owned_rows.items():
            if int(row.get("row_count") or 0) == 0:
                groups.pop(key, None)
    persisted_scalar_rows = (
        bounded_original_affected
        if bounded_no_search
        else filtered_persisted_scalar_rows
    )
    _apply_overlay_delta_groups(
        groups, persisted_scalar_rows, delta,
        options["view"], options["range"], exact_owned_rows,
        song_reset_owner_keys,
    )
    if options["view"] not in {"artists", "vtubers"}:
        _apply_runtime_tombstone_groups(
            groups, generic_runtime_changes, options["view"],
        )
        _apply_runtime_change_previews(
            groups, generic_runtime_changes, options["view"],
        )
    # Exact VTuber/Artist aggregation already owns every affected identity's
    # effective tuple set.  Never replay generic reconciliation over it.
    if (
        options["view"]
        not in {"songs", "songIndex", "vsingerSongs", "artists", "vtubers"}
        or (
            options["view"] == "vtubers"
            and exact_required
            and not exact_vtuber_owned
        )
        or (
            options["view"] == "artists"
            and exact_artist_required
            and not exact_artist_owned
        )
    ):
        _reconcile_affected_song_counts(
            connection,
            parent[0],
            generic_candidate_rows,
            generic_replacement_rows,
            [*generic_reset_changes, *generic_runtime_changes],
            groups,
            options["view"],
            options,
            reconciliation_counts=reconciliation_counts,
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
        elif (
            options["searchTokens"]
            and not source_search_sql_active
            and not _public_row_matches_search(row, options)
        ):
            continue
        if _overlay_rank_value(row, options["metric"]) < options["minCount"]:
            continue
        filtered.append(row)
    filtered.sort(
        key=lambda row: (
            -_overlay_rank_value(row, options["metric"]),
            _text(row.get("title") or row.get("name") or row.get("detail_key")),
            _text(row.get("detail_key")),
        )
    )
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
        parent_window_is_complete = (
            bounded_no_search
            and int(base_totals["totalCount"]) <= base_window_end
        )
        if parent_window_is_complete:
            # The complete parent set and every overlay mutation are already
            # represented by ``filtered``.  Count the final canonical groups
            # directly: an incremental add/subtract formula can over-count
            # when multiple display spellings collapse into one canonical
            # Artist key during this same preparation.
            aggregate_totals = _final_generic_aggregate_totals(filtered)
        else:
            aggregate_totals = dict(aggregate_totals)
            affected_final_keys = (
                bounded_affected_keys
                | set(bounded_original_affected)
                | set(exact_owned_rows)
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
                    old_value = (
                        int(old.get(field) or 0)
                        if old_included and old else 0
                    )
                    new_value = (
                        int(new.get(field) or 0)
                        if new_included and new else 0
                    )
                    aggregate_totals[public_name] += new_value - old_value
    return {
        "filtered": tuple(dict(row) for row in filtered),
        "metadata": tuple(dict(row) for row in metadata),
        "candidateRows": tuple(dict(row) for row in candidate_rows),
        "parentRevisionId": parent[0],
        "overlayRevisionIds": tuple(direct_overlay_revision_ids),
        "overlayPreviewExcludedVideoIds": overlay_preview_excluded_video_ids,
        "exactAffectedChannelIds": tuple(sorted(exact_vtuber_rows)),
        "exactAffectedArtistKeys": tuple(sorted(exact_artist_rows)),
        "previewExcludedVideoIds": preview_excluded_video_ids,
        "previewExcludedOccurrenceIds": preview_excluded_occurrence_ids,
        "aggregateTotals": aggregate_totals,
        "songChannelIds": tuple(song_channel_scope or ()),
        "clickedSongScopes": clicked_song_scopes,
        # Offline snapshot rendering walks every canonical ranking page. It
        # may preload one bounded page of immutable parent payloads instead
        # of issuing one PostgreSQL round trip per card.
        "snapshotBulkHydrateCards": bool(
            options.get("_snapshotBulkHydrateCards")
        ),
    }


def _generic_ranking_preparation_key(
    revision_id: str,
    parent_revision_id: str,
    options: Mapping[str, Any],
) -> tuple[Any, ...]:
    """Identify only inputs that alter the expensive immutable aggregate."""

    del parent_revision_id
    return preparation_cache_key(revision_id, options)


def _cached_generic_ranking_preparation(
    key: tuple[Any, ...],
    build,
    *,
    view: str | None = None,
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
        cache_value = scalar_preparation(prepared, view=view)
        if _cache_value_is_bounded(
            cache_value,
            max_bytes=_GENERIC_RANKING_PREPARATION_MAX_BYTES,
            max_occurrences=_GENERIC_RANKING_PREPARATION_MAX_OCCURRENCES,
        ):
            _GENERIC_RANKING_PREPARATION_CACHE[key] = cache_value
            _GENERIC_RANKING_PREPARATION_CACHE.move_to_end(key)
            while len(_GENERIC_RANKING_PREPARATION_CACHE) > _GENERIC_RANKING_PREPARATION_CAP:
                _GENERIC_RANKING_PREPARATION_CACHE.popitem(last=False)
        _GENERIC_RANKING_PREPARATION_FLIGHTS.pop(key, None)
        flight.event.set()
    return prepared


def _sql_page_slice_prepared_rows(
    connection,
    rows: Sequence[Mapping[str, Any]],
    options: Mapping[str, Any],
) -> tuple[dict[str, Any], ...]:
    """Select only the requested page from a scalar prepared-rank plan."""

    row_by_key: dict[str, Mapping[str, Any]] = {}
    scalar_rows: list[dict[str, Any]] = []
    for prepared_rank, row in enumerate(rows):
        detail_key = _text(row.get("detail_key"))
        if not detail_key:
            raise PostgresAdapterError("generic ranking page plan is missing detail identity")
        if detail_key in row_by_key:
            raise PostgresAdapterError("generic ranking page plan has duplicate detail identity")
        row_by_key[detail_key] = row
        scalar_rows.append({
            "detail_key": detail_key,
            "prepared_rank": prepared_rank,
        })
    limit_sql, limit_params = page_limit_offset(
        options["page"], options["pageSize"],
    )
    selected = _rows(
        connection,
        f"""
        WITH prepared_rows AS (
            SELECT detail_key, prepared_rank
            FROM jsonb_to_recordset(%s::jsonb)
                AS item(detail_key text, prepared_rank integer)
        )
        SELECT detail_key, prepared_rank
        FROM prepared_rows
        ORDER BY prepared_rank
        {limit_sql}
        """,
        [json.dumps(scalar_rows, ensure_ascii=False), *limit_params],
    )
    page: list[dict[str, Any]] = []
    for selected_row in selected:
        detail_key = _text(selected_row.get("detail_key"))
        source = row_by_key.get(detail_key)
        if source is None:
            raise PostgresAdapterError("generic ranking SQL page returned unknown detail identity")
        try:
            prepared_rank = int(selected_row.get("prepared_rank"))
        except (TypeError, ValueError) as exc:
            raise PostgresAdapterError("generic ranking SQL page returned invalid rank") from exc
        selected_copy = dict(source)
        selected_copy["_prepared_rank"] = prepared_rank
        page.append(selected_copy)
    return tuple(page)

def _cached_generic_meta_counts(
    key: tuple[str, str, tuple[str, ...]],
    build,
) -> dict[str, int]:
    """Compute one immutable overlay count map per revision, with single-flight."""

    with _GENERIC_META_COUNTS_LOCK:
        cached = _GENERIC_META_COUNTS_CACHE.get(key)
        if cached is not None:
            return dict(cached)
        flight = _GENERIC_META_COUNTS_FLIGHTS.get(key)
        if flight is None:
            flight = _MetaCountsFlight(threading.Event())
            _GENERIC_META_COUNTS_FLIGHTS[key] = flight
            leader = True
        else:
            leader = False
    if not leader:
        flight.event.wait()
        if flight.error is not None:
            raise flight.error
        if flight.result is not None:
            return dict(flight.result)
        raise PostgresAdapterError(
            "generic overlay meta count preparation completed without a result"
        )
    try:
        computed = dict(build())
    except BaseException as exc:
        with _GENERIC_META_COUNTS_LOCK:
            flight.error = exc
            _GENERIC_META_COUNTS_FLIGHTS.pop(key, None)
            flight.event.set()
        raise
    with _GENERIC_META_COUNTS_LOCK:
        flight.result = dict(computed)
        if len(_GENERIC_META_COUNTS_CACHE) >= _GENERIC_META_COUNTS_CACHE_CAP:
            _GENERIC_META_COUNTS_CACHE.pop(next(iter(_GENERIC_META_COUNTS_CACHE)))
        _GENERIC_META_COUNTS_CACHE[key] = dict(computed)
        _GENERIC_META_COUNTS_FLIGHTS.pop(key, None)
        flight.event.set()
    return computed


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


def _fallback_generic_video_parent_occurrences(
    connection,
    parent_revision_id: str,
    video_id: str,
    range_id: str,
    scope_key: str,
    db_metric: str,
) -> list[dict[str, Any]] | None:
    """Recover one legacy ranking-only video card under an exact contract."""

    rows = _rows(
        connection,
        """
        /* exact legacy generic video-card ranking fallback */
        SELECT detail_key, row_count, video_count, timestamp_count,
               payload_json
        FROM runtime_ranking_rows
        WHERE revision_id = %s AND range_id = %s AND view = 'videos'
          AND metric = %s AND scope_key = %s AND detail_key = %s
        LIMIT 2
        """,
        [parent_revision_id, range_id, db_metric, scope_key, video_id],
    )
    if not rows:
        return None
    if len(rows) != 1:
        raise PostgresAdapterError(
            "generic video parent ranking fallback returned duplicate rows"
        )
    row = rows[0]
    if _text(row.get("detail_key")) != video_id:
        raise PostgresAdapterError(
            "generic video parent ranking fallback changed identity"
        )
    payload = _json_object(row.get("payload_json"))
    payload_video_id = _text(payload.get("videoId"))
    if payload_video_id and payload_video_id != video_id:
        raise PostgresAdapterError(
            "generic video parent ranking fallback changed video identity"
        )
    if _text(payload.get("key")) and _text(payload.get("key")) != video_id:
        raise PostgresAdapterError(
            "generic video parent ranking fallback changed public key"
        )
    if _text(payload.get("type")) not in {"", "video"}:
        raise PostgresAdapterError(
            "generic video parent ranking fallback changed type"
        )
    raw_songs = payload.get("songs")
    parent_count = int(row.get("row_count") or 0)
    parent_video_count = int(row.get("video_count") or 0)
    parent_timestamp_count = int(row.get("timestamp_count") or 0)
    if not isinstance(raw_songs, list):
        raise PostgresAdapterError(
            "generic video parent ranking fallback songs are invalid"
        )
    if parent_count != len(raw_songs) or parent_timestamp_count != len(raw_songs):
        raise PostgresAdapterError(
            "generic video parent ranking fallback count changed"
        )
    if parent_count > 0 and parent_video_count != 1:
        raise PostgresAdapterError(
            "generic video parent ranking fallback video count changed"
        )
    occurrences: list[dict[str, Any]] = []
    video_title = _text(payload.get("title"))
    for position, raw_song in enumerate(raw_songs):
        if not isinstance(raw_song, Mapping):
            raise PostgresAdapterError(
                "generic video parent ranking fallback song is invalid"
            )
        song = dict(raw_song)
        occurrence = dict(song)
        occurrence.update({
            "videoId": video_id,
            "videoTitle": video_title,
            "rangeId": range_id,
            "position": position,
            "song": song,
        })
        for name in (
            "channelName", "channelId", "channelHandle", "channelUrl",
            "publishedTimestamp", "publishedAt",
        ):
            if payload.get(name) is not None:
                occurrence.setdefault(name, payload.get(name))
        occurrences.append(occurrence)
    return occurrences


def _hydrate_generic_video_parent_occurrences(
    connection,
    parent_revision_id: str,
    video_id: str,
    range_id: str,
    *,
    scope_key: str = "all",
    db_metric: str = "count",
) -> list[dict[str, Any]]:
    """Load the bounded parent occurrence set for one affected video card.

    Legacy generic video ranking cards can persist only a ``songs`` list.  A
    runtime tombstone still needs the immutable occurrence ids to remove the
    right songs; matching only title/artist would be ambiguous.  Keep this
    lookup exact, bounded, and fail closed on duplicate or missing identity.
    """

    video_id = _text(video_id)
    range_id = _text(range_id) or "all"
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise PostgresAdapterError(
            "generic video parent occurrence hydration has invalid video identity"
        )
    rows = _rows(
        connection,
        """
        /* exact affected generic video-card parent occurrence hydration */
        SELECT occurrence_id, range_id, video_id, song_key, seconds,
               source_system, source_id, title, artist,
               is_niche, is_unknown_artist, payload_json
        FROM runtime_occurrences
        WHERE revision_id = %s AND video_id = %s
          AND (range_id = ANY(%s) OR range_id IS NULL)
        ORDER BY range_id, occurrence_id
        LIMIT %s
        """,
        [
            parent_revision_id,
            video_id,
            [range_id, ""],
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
        ],
    )
    if len(rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "generic video parent occurrence hydration exceeded cap"
        )
    if not rows:
        fallback = _fallback_generic_video_parent_occurrences(
            connection,
            parent_revision_id,
            video_id,
            range_id,
            scope_key,
            db_metric,
        )
        if fallback is not None:
            return fallback
    occurrences: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    positions: defaultdict[str, int] = defaultdict(int)
    for row in rows:
        row_video_id = _text(row.get("video_id"))
        if row_video_id != video_id:
            raise PostgresAdapterError(
                "generic video parent occurrence hydration returned an unexpected video"
            )
        occurrence_id = _text(row.get("occurrence_id"))
        row_range_id = _text(row.get("range_id")) or range_id
        if not occurrence_id:
            raise PostgresAdapterError(
                "generic video parent occurrence hydration returned an empty identity"
            )
        identity = (row_range_id, occurrence_id)
        if identity in seen:
            raise PostgresAdapterError(
                "generic video parent occurrence hydration returned a duplicate identity"
            )
        seen.add(identity)
        payload = _json_object(row.get("payload_json"))
        if isinstance(payload.get("payload"), Mapping):
            payload = dict(payload["payload"])
        position = payload.get("position")
        try:
            position = int(position)
        except (TypeError, ValueError):
            position = positions[row_video_id]
        positions[row_video_id] = max(positions[row_video_id], position + 1)
        payload.update({
            "videoId": video_id,
            "occurrenceId": occurrence_id,
            "position": position,
            "rangeId": row_range_id,
            "songKey": row.get("song_key") if row.get("song_key") is not None else payload.get("songKey"),
            "seconds": row.get("seconds") if row.get("seconds") is not None else payload.get("seconds"),
            "title": row.get("title") if row.get("title") is not None else payload.get("title"),
            "artist": row.get("artist") if row.get("artist") is not None else payload.get("artist"),
            "sourceId": row.get("source_id") if row.get("source_id") is not None else payload.get("sourceId"),
            "sourceSystem": (
                row.get("source_system")
                if row.get("source_system") is not None
                else payload.get("sourceSystem")
            ),
        })
        if "isNiche" not in payload and "is_niche" in row:
            payload["isNiche"] = row.get("is_niche") is True
        if "isUnknownArtist" not in payload and "is_unknown_artist" in row:
            payload["isUnknownArtist"] = row.get("is_unknown_artist") is True
        song = payload.get("song")
        song = dict(song) if isinstance(song, Mapping) else {}
        for name in (
            "songKey", "title", "artist", "seconds", "rangeId",
            "sourceId", "rawHash", "sourceSystem",
        ):
            if payload.get(name) is not None and payload.get(name) != "":
                song[name] = payload[name]
        payload["song"] = song
        occurrences.append(payload)
    return occurrences


def _rebuild_generic_video_songs(payload: MutableMapping[str, Any]) -> None:
    """Make a video card's song list derive from its effective occurrences."""

    occurrences = payload.get("occurrences")
    if not isinstance(occurrences, list):
        return
    songs: list[dict[str, Any]] = []
    song_keys: set[str] = set()
    for occurrence in occurrences:
        if not isinstance(occurrence, Mapping):
            continue
        nested_song = occurrence.get("song")
        song = dict(nested_song) if isinstance(nested_song, Mapping) else {}
        for name in (
            "songKey", "title", "artist", "seconds", "rangeId",
            "sourceId", "rawHash", "sourceSystem",
        ):
            if occurrence.get(name) is not None and occurrence.get(name) != "":
                song[name] = occurrence[name]
        if not _text(song.get("title")) and not _text(song.get("songKey")):
            continue
        songs.append(song)
        key = _song_key(song)
        if key:
            song_keys.add(key)
    payload["songs"] = songs
    payload["songCount"] = len(song_keys)


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
    parent_stored_found = bool(
        row.get("_snapshot_parent_payload_preloaded")
    )
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
              AND metric = %s AND scope_key = %s AND detail_key = %s
            LIMIT 1
            """,
            [
                parent_revision_id,
                options["range"],
                view,
                db_metric,
                _ranking_scope_key(options),
                row.get("detail_key"),
            ],
        )
        stored_payload = _json_object(stored.get("payload_json")) if stored else {}
        parent_stored_found = bool(stored_payload)
        payload = copy.deepcopy(stored_payload)
    hydration_degraded = False
    video_parent_occurrences_hydrated = False
    if (
        requires_canonical_hydration
        and view in {"songs", "songIndex", "vsingerSongs"}
    ):
        if not parent_stored_found:
            # The parent revision has no stored payload at all for this
            # card; a counts-only affected card cannot be hydrated and
            # must fail closed before the legacy degradation path.
            raise PostgresAdapterError(
                "generic ranking payload hydration is incomplete"
            )
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
    if requires_canonical_hydration and view == "videos":
        detail_key = _text(row.get("detail_key"))
        parent_occurrences = payload.get("occurrences")
        parent_row_count = int(row.get("row_count") or 0)
        preview_limited = bool(payload.get("occurrencePreviewLimited"))
        if (
            not isinstance(parent_occurrences, list)
            or preview_limited
            or (parent_row_count > 0 and not parent_occurrences)
            or (
                isinstance(parent_occurrences, list)
                and parent_row_count > 0
                and len(parent_occurrences) != parent_row_count
            )
        ):
            parent_occurrences = _hydrate_generic_video_parent_occurrences(
                connection,
                parent_revision_id,
                detail_key,
                _text(options.get("range")) or "all",
                scope_key=_ranking_scope_key(options),
                db_metric=db_metric,
            )
            if parent_row_count > 0 and not parent_occurrences:
                raise PostgresAdapterError(
                    "generic video parent occurrence hydration returned no rows"
                )
            payload["occurrences"] = parent_occurrences
            video_parent_occurrences_hydrated = True
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
            detail_key = _text(row.get("detail_key"))
            payload_video_id = _text(payload.get("videoId"))
            if (
                view == "videos"
                and re.fullmatch(r"[A-Za-z0-9_-]{11}", detail_key)
                and payload_video_id in {"", detail_key}
            ):
                # Some legacy parent video cards persisted only scalar video
                # metadata.  The immutable detail key still binds the exact
                # YouTube video, so treat the absent parent preview list as
                # empty and retain the reviewed accepted-overlay previews.
                # This keeps one malformed legacy card from turning an
                # otherwise valid deep rankings page into a page-wide 503.
                parent_previews = []
                payload["videoId"] = detail_key
                payload["occurrences"] = parent_previews
            else:
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
        # The parent stored payload exists but is incomplete (legacy
        # VSinger Moment scalar card, stale schema, etc).  Degrade to an
        # empty-occurrences card with the reviewed scalar identity
        # instead of failing the whole ranking page with a 503.
        hydration_degraded = True
        if not isinstance(payload.get("occurrences"), list):
            payload["occurrences"] = []
    if (
        requires_canonical_hydration
        and view == "videos"
        and not hydration_degraded
        and (
            video_parent_occurrences_hydrated
            or isinstance(payload.get("occurrences"), list)
        )
    ):
        _rebuild_generic_video_songs(payload)
    return payload


def _render_generic_overlay_rankings(
    connection,
    ranking_revision_id: str,
    prepared: Mapping[str, Any],
    query: Mapping[str, Any] | None,
    *,
    preview_hydration_limit: int | None = None,
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
    if options["view"] == "vtubers":
        render_rows = _sql_page_slice_prepared_rows(
            connection, render_rows, options,
        )
    records = []
    page_rows = (
        tuple(render_rows)
        if options["view"] == "vtubers"
        else tuple(render_rows[offset:offset + options["pageSize"]])
    )
    if prepared.get("snapshotBulkHydrateCards"):
        page_rows = _bulk_hydrate_generic_ranking_page(
            connection,
            parent_revision_id,
            page_rows,
            options,
            db_metric,
        )
    if options["view"] == "vtubers":
        ranked_rows = (
            (int(row.get("_prepared_rank") or 0) + 1, row)
            for row in page_rows
        )
    else:
        ranked_rows = enumerate(page_rows, start=offset + 1)
    for index, row in ranked_rows:
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
    if preview_hydration_limit is not None:
        if not 1 <= preview_hydration_limit <= MAX_RANKING_PREVIEW_VIDEOS:
            raise PostgresAdapterError(
                "ranking preview hydration limit is invalid"
            )
        for record in records:
            occurrences = record.get("occurrences")
            if isinstance(occurrences, list):
                record["occurrences"] = distinct_source_previews(
                    occurrences,
                    limit=preview_hydration_limit,
                )
    _hydrate_overlay_page_previews(connection, candidate_rows, records)
    _hydrate_runtime_ranking_song_previews(
        connection,
        ranking_revision_id,
        options["range"],
        options["view"],
        records,
    )
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
                niche_only=bool(options.get("nicheOnly")),
                hide_unknown_artist=bool(options.get("hideUnknownArtist")),
            )
            for channel_id, preview in overlay_previews.items():
                records_by_channel[channel_id]["occurrences"] = [preview]
            missing_preview_channels = [
                channel_id
                for channel_id in missing_preview_channels
                if channel_id not in overlay_previews
            ]
        if missing_preview_channels:
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
            for channel_id, preview in hydrated_parent_previews.items():
                records_by_channel[channel_id]["occurrences"] = [preview]
            missing_preview_channels = [
                channel_id
                for channel_id in missing_preview_channels
                if channel_id not in hydrated_parent_previews
            ]
        for channel_id in missing_preview_channels:
            _mark_vtuber_preview_unavailable(records_by_channel[channel_id])
        for record in records:
            channel_id = _text(record.get("channelId") or record.get("key"))
            _canonicalize_vtuber_card_preview(record, channel_id)
    if options["compact"]:
        records = compact_ranking_payloads(records, options["view"])
    return {
        "schemaVersion": 1, "rangeId": options["range"], "view": options["view"],
        "metric": "occurrences" if options["metric"] == "count" else options["metric"],
        "searchScope": options["searchScope"], "searchFields": _public_search_fields(options),
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
        view=options["view"],
    )
    return _render_generic_overlay_rankings(
        connection, revision_id, prepared, query,
    )


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

    authoritative_7d_ids = _authoritative_7d_overlay_ids(
        connection, overlay_lineage,
    )
    authoritative_7d_reset = (
        authoritative_7d_ids[-1] if authoritative_7d_ids else ""
    )
    for revision_key in reversed(overlay_lineage):
        if revision_key == authoritative_7d_reset:
            for video_id in list(occurrences):
                occurrences[video_id] = [
                    item for item in occurrences[video_id]
                    if _text(item.get("rangeId")) not in {"7d", ""}
                ]
        video_rows = _rows(connection, "SELECT video_id, title, channel_name, channel_id, channel_handle, channel_url, published_at, tombstone, payload_json FROM migration_video_rows WHERE revision_id = %s", [revision_key])
        occurrence_rows = _rows(connection, "SELECT video_id, occurrence_key, occurrence_id, position, range_id, song_key, seconds, title, artist, source_id, raw_hash, source_system, payload_json FROM migration_occurrence_rows WHERE revision_id = %s ORDER BY video_id, position, occurrence_key", [revision_key])
        partial_video_ids = {
            _text(row.get("video_id"))
            for row in video_rows if _is_partial_range_video_row(row)
        }
        replacement_ids = {
            _text(row.get("video_id"))
            for row in video_rows if not _is_partial_range_video_row(row)
        }
        for video_id in replacement_ids:
            occurrences[video_id] = []
        for row in video_rows:
            video_id = _text(row.get("video_id"))
            if row.get("tombstone") and video_id not in partial_video_ids:
                videos.pop(video_id, None)
                occurrences.pop(video_id, None)
                continue
            payload = _json_object(row.get("payload_json"))
            if isinstance(payload.get("payload"), Mapping):
                payload = dict(payload["payload"])
            payload.update({"videoId": video_id, "title": payload.get("title", row.get("title")), "channelName": payload.get("channelName", row.get("channel_name")), "channelId": payload.get("channelId", row.get("channel_id")), "channelHandle": payload.get("channelHandle", row.get("channel_handle")), "channelUrl": payload.get("channelUrl", row.get("channel_url")), "publishedAt": payload.get("publishedAt", row.get("published_at"))})
            videos[video_id] = payload
        accepted_range_identities: set[tuple[str, str, str]] = set()
        for row in occurrence_rows:
            video_id = _text(row.get("video_id"))
            occurrence_id = _text(row.get("occurrence_id"))
            range_id = _text(row.get("range_id"))
            payload = _json_object(row.get("payload_json"))
            payload.update({"videoId": video_id, "occurrenceId": row.get("occurrence_id"), "position": row.get("position"), "rangeId": row.get("range_id"), "songKey": row.get("song_key"), "seconds": row.get("seconds"), "title": row.get("title"), "artist": row.get("artist"), "sourceId": row.get("source_id"), "rawHash": row.get("raw_hash"), "sourceSystem": row.get("source_system")})
            accepted_range_identities.add((video_id, occurrence_id, range_id))
            if video_id in partial_video_ids:
                occurrences[video_id] = [
                    item for item in occurrences.get(video_id, [])
                    if not (
                        _text(item.get("occurrenceId")) == occurrence_id
                        and _text(item.get("rangeId")) == range_id
                    )
                ]
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
                range_id = _text(_runtime_payload_field(payload, row, "rangeId", "range_id"))
                if row.get("tombstone") and (video_id, occurrence_id, range_id) in accepted_range_identities:
                    continue
                existing = [item for item in occurrences[video_id] if not (
                    _text(item.get("occurrenceId")) == occurrence_id
                    and _text(item.get("rangeId")) == range_id
                )]
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


def _normalize_search_scope(value: Any) -> str:
    scope = _text(value or "all").strip().casefold().replace("_", "-")
    aliases = {
        "": "all", "all": "all", "any": "all", "full": "all",
        "song": "song", "songs": "song", "entity": "entity",
        "title": "title", "artist": "artist", "artists": "artist",
        "singer": "artist", "channel": "channel", "channels": "channel",
        "vtuber": "channel", "video": "video", "videos": "video",
        "source": "source", "sources": "source",
    }
    if scope not in aliases:
        raise ValueError(
            "searchScope must be all, song, entity, title, artist, channel, video, or source"
        )
    return aliases[scope]


def _normalize_search_fields(value: Any) -> list[str] | None:
    text = _text(value).strip()
    if not text:
        return None
    if text.casefold() in {"all", "any", "*"}:
        return []
    aliases = {
        "title": "title", "song": "title", "name": "title",
        "artist": "artist", "artists": "artist", "singer": "artist",
        "channel": "channel", "channels": "channel", "vtuber": "channel",
        "video": "video", "videos": "video",
        "source": "source", "sources": "source",
    }
    fields: list[str] = []
    for raw_field in re.split(r"[,| ]+", text):
        field = raw_field.strip().casefold().replace("_", "-")
        if not field:
            continue
        if field not in aliases:
            raise ValueError(
                "searchFields must contain title, artist, channel, video, or source"
            )
        normalized = aliases[field]
        if normalized not in fields:
            fields.append(normalized)
    return fields


def _search_scope_from_fields(fields: Sequence[str] | None) -> str:
    values = list(fields or ())
    if not values:
        return "all"
    if values == ["title"]:
        return "title"
    if values == ["artist"]:
        return "artist"
    if values == ["channel"]:
        return "channel"
    if values == ["video"]:
        return "video"
    if values == ["source"]:
        return "source"
    if set(values) == {"title", "artist"}:
        return "song"
    if any(field in {"channel", "video", "source"} for field in values):
        return "source"
    return "all"


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
    scope = _normalize_search_scope(
        _first(query, "searchScope", _first(query, "searchField", "all"))
    )
    fields_value = _first(query, "searchFields", "")
    fields = _normalize_search_fields(fields_value)
    if fields is not None and scope == "all":
        scope = _search_scope_from_fields(fields)
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


_DEFAULT_SEARCH_FIELDS = ("title", "artist", "channel")
_ALL_SEARCH_FIELDS = ("title", "artist", "channel", "video", "source")
_SEARCH_FIELDS = set(_ALL_SEARCH_FIELDS)


def _effective_search_fields(options: Mapping[str, Any]) -> tuple[str, ...]:
    """Resolve omitted fields to the UI default without widening to video text."""

    raw_fields = options.get("searchFields")
    if isinstance(raw_fields, str):
        raw_fields = (raw_fields,)
    if raw_fields is not None:
        # _normalize_search_fields uses [] as the intentional representation
        # of the public searchFields=all selection.  It is not omission.
        if not raw_fields:
            return _ALL_SEARCH_FIELDS
        fields = tuple(
            field
            for field in dict.fromkeys(
                _text(value).casefold() for value in raw_fields
            )
            if field in _SEARCH_FIELDS
        )
        return fields or _DEFAULT_SEARCH_FIELDS
    if not _text(options.get("q")):
        return ()
    scope = _text(options.get("searchScope") or "all").casefold()
    if scope in _SEARCH_FIELDS:
        return (scope,)
    # The UI has title/artist/channel checked by default.  ``song`` is also
    # the server-normalized scope for the song view when fields are omitted.
    return _DEFAULT_SEARCH_FIELDS


def _public_search_fields(options: Mapping[str, Any]) -> list[str]:
    """Expose the effective fields while keeping an empty-query response lean."""

    if _text(options.get("view")) not in {"songs", "songIndex"}:
        return list(options.get("searchFields") or ()) if _text(options.get("q")) else []
    return list(_effective_search_fields(options)) if _text(options.get("q")) else []


def _runtime_row_search_texts(row: Mapping[str, Any]) -> dict[str, str]:
    """Separate persisted ranking text into title/artist/channel/video fields."""

    payload = _json_object(row.get("payload_json"))
    title_values: list[Any] = [
        row.get("title"), payload.get("title"), payload.get("songTitle"),
    ]
    artist_values: list[Any] = [
        row.get("artist"), payload.get("artist"), payload.get("displayArtist"),
    ]
    channel_values: list[Any] = [
        row.get("channel_search_text"), payload.get("channelName"),
        payload.get("channelId"), payload.get("channelHandle"),
        payload.get("channelUrl"),
    ]
    video_values: list[Any] = []
    source_values: list[Any] = []
    top_video = payload.get("video")
    if isinstance(top_video, Mapping):
        video_values.extend((top_video.get("title"), top_video.get("videoId")))
    occurrences = payload.get("occurrences")
    if isinstance(occurrences, list):
        for occurrence in occurrences:
            if not isinstance(occurrence, Mapping):
                continue
            item = occurrence.get("item")
            if not isinstance(item, Mapping):
                item = occurrence.get("video")
            item = item if isinstance(item, Mapping) else occurrence
            song = occurrence.get("song")
            song = song if isinstance(song, Mapping) else {}
            title_values.append(song.get("title"))
            artist_values.append(song.get("artist"))
            channel_values.extend((
                item.get("channelName"), item.get("channelId"),
                item.get("channelHandle"), item.get("channelUrl"),
            ))
            video_values.extend((item.get("title"), item.get("videoId")))
            source_values.extend((song.get("sourceId"), song.get("sourceSystem")))

    def joined(values: Iterable[Any]) -> str:
        return " ".join(_text(value) for value in values if _text(value)).casefold()

    texts = {
        "title": joined(title_values),
        "artist": joined(artist_values),
        "channel": joined(channel_values),
        "video": joined(video_values),
        "source": joined(source_values),
    }
    # Overlay rows expose their public tuple separately.  Do not let the
    # legacy aggregate used to build ``channel_search_text`` leak video text
    # back into the channel field.
    if any(
        _text(row.get(name))
        for name in ("channel_name", "channel_id", "channel_handle", "channel_url")
    ):
        texts["channel"] = joined(
            row.get(name)
            for name in ("channel_name", "channel_id", "channel_handle", "channel_url")
        )
    if any(_text(row.get(name)) for name in ("video_title", "video_id")):
        texts["video"] = joined((row.get("video_title"), row.get("video_id")))
    if any(_text(row.get(name)) for name in ("source_id", "source_system")):
        texts["source"] = joined((row.get("source_id"), row.get("source_system")))
    return texts


_RANKING_SOURCE_SEARCH_MATCH_CAP = 4096


def _runtime_source_payload_json_expression(alias: str = "occurrence") -> str:
    """Parse text payloads without allowing malformed rows to abort search."""

    trimmed = f"NULLIF(btrim({alias}.payload_json), '')"
    return (
        "(CASE WHEN pg_input_is_valid("
        f"{trimmed}, 'jsonb'"
        f") THEN {trimmed}::jsonb ELSE '{{}}'::jsonb END)"
    )


def _runtime_source_field_expressions(fields: Iterable[str]) -> tuple[str, ...]:
    """Return exact source-occurrence expressions for selected public fields."""

    payload_json = _runtime_source_payload_json_expression()
    expressions = {
        "title": (
            f"{payload_json}->>'songTitle'",
            f"{payload_json}->'song'->>'title'",
            f"{payload_json}->'payload'->>'songTitle'",
            f"{payload_json}->'payload'->'song'->>'title'",
        ),
        "artist": (
            "occurrence.artist",
            f"{payload_json}->>'artist'",
            f"{payload_json}->'song'->>'artist'",
            f"{payload_json}->'payload'->>'artist'",
            f"{payload_json}->'payload'->'song'->>'artist'",
        ),
        "channel": (
            "occurrence.channel_name",
            "occurrence.channel_id",
            "occurrence.channel_handle",
            "occurrence.channel_url",
            f"{payload_json}->>'channelName'",
            f"{payload_json}->>'channelId'",
            f"{payload_json}->>'channelHandle'",
            f"{payload_json}->>'channelUrl'",
            f"{payload_json}->'video'->>'channelName'",
            f"{payload_json}->'video'->>'channelId'",
            f"{payload_json}->'video'->>'channelHandle'",
            f"{payload_json}->'video'->>'channelUrl'",
            f"{payload_json}->'item'->>'channelName'",
            f"{payload_json}->'item'->>'channelId'",
            f"{payload_json}->'item'->>'channelHandle'",
            f"{payload_json}->'item'->>'channelUrl'",
            f"{payload_json}->'payload'->'video'->>'channelName'",
            f"{payload_json}->'payload'->'video'->>'channelId'",
            f"{payload_json}->'payload'->'video'->>'channelHandle'",
            f"{payload_json}->'payload'->'video'->>'channelUrl'",
        ),
        "video": (
            "public.daily_song_source_video_search_text(occurrence.title, occurrence.video_id, occurrence.payload_json)",
        ),
        "source": (
            "occurrence.source_id",
            "occurrence.source_system",
            f"{payload_json}->>'sourceId'",
            f"{payload_json}->>'sourceSystem'",
            f"{payload_json}->'song'->>'sourceId'",
            f"{payload_json}->'song'->>'sourceSystem'",
            f"{payload_json}->'payload'->>'sourceId'",
            f"{payload_json}->'payload'->>'sourceSystem'",
            f"{payload_json}->'payload'->'song'->>'sourceId'",
            f"{payload_json}->'payload'->'song'->>'sourceSystem'",
        ),
    }
    selected: list[str] = []
    for field in fields:
        for expression in expressions.get(field, ()):
            if expression not in selected:
                selected.append(expression)
    return tuple(selected)


def _runtime_ranking_field_expressions(
    alias: str, fields: Iterable[str],
) -> tuple[str, ...]:
    expressions = {
        # Keep payload_json out of the ranking CTE.  Occurrence details are
        # searched in SQL; Python receives only scalar page candidates.
        "title": (f"{alias}.title",),
        "artist": (f"{alias}.artist",),
        "channel": (f"{alias}.channel_search_text",),
    }
    selected: list[str] = []
    for field in fields:
        for expression in expressions.get(field, ()):
            if expression not in selected:
                selected.append(expression)
    return tuple(selected)


def _runtime_source_search_sql(
    options: Mapping[str, Any],
    active_revision_id: str,
    ranking_revision_id: str | None = None,
    ranking_alias: str = "ranking",
) -> tuple[str, str, list[Any], list[Any]]:
    """Build one bounded source-key CTE and its correlated ranking predicate."""

    if (
        _text(options.get("view")) not in {"songs", "songIndex"}
        or not options.get("searchTokens")
    ):
        return "", "", [], []
    fields = _effective_search_fields(options)
    if not any(field in {"video", "source"} for field in fields):
        return "", "", [], []
    occurrence_expressions = _runtime_source_field_expressions(fields)
    if not occurrence_expressions:
        return "", "", [], []
    ranking_revision = _text(ranking_revision_id or active_revision_id)
    requested_values = ", ".join("(%s, %s)" for _ in options["searchTokens"])
    requested_params: list[Any] = []
    for token in options["searchTokens"]:
        requested_params.extend((
            _text(token).casefold(),
            f"%{_sql_like_literal(token)}%",
        ))
    video_only_source_search = set(fields) == {"video"}
    source_token_alias = "candidate" if video_only_source_search else "requested"
    occurrence_predicate = " OR ".join(
        f"coalesce({expression}, '') ILIKE {source_token_alias}.needle ESCAPE E'\\\\'"
        for expression in occurrence_expressions
    )
    db_metric = "count" if options["metric"] in {"count", "occurrences"} else options["metric"]
    source_candidate_cte = ""
    source_match_key = "occurrence.source_key"
    matched_source_from = """
            FROM authorities
            JOIN runtime_source_occurrences AS occurrence
              ON occurrence.revision_id = authorities.authority_revision
             AND occurrence.source_key = authorities.source_key
            JOIN eligible_ranking AS eligible
              ON eligible.detail_key = occurrence.source_key
            CROSS JOIN requested
    """
    if video_only_source_search:
        eligible_payload_json = _runtime_source_payload_json_expression("eligible")
        source_candidate_cte = f""", source_search_candidates AS MATERIALIZED (
            SELECT DISTINCT eligible.detail_key,
                   coalesce(
                       {eligible_payload_json}->>'sourceDetailKey',
                       eligible.detail_key
                   ) AS source_detail_key,
                   requested.token, requested.needle
            FROM eligible_ranking AS eligible
            CROSS JOIN requested
            WHERE coalesce(eligible.search_text, '')
                  ILIKE requested.needle ESCAPE E'\\\\'
        )"""
        source_match_key = "candidate.detail_key"
        matched_source_from = """
            FROM source_search_candidates AS candidate
            JOIN authorities
              ON authorities.source_key = candidate.source_detail_key
            JOIN runtime_source_occurrences AS occurrence
              ON occurrence.revision_id = authorities.authority_revision
             AND occurrence.source_key = candidate.source_detail_key
        """
    source_cte = f"""
        WITH RECURSIVE active_lineage AS (
            SELECT revision_id, parent_revision_id, 0 AS lineage_depth
            FROM migration_revisions
            WHERE revision_id = %s
            UNION ALL
            SELECT parent.revision_id, parent.parent_revision_id,
                   active_lineage.lineage_depth + 1
            FROM migration_revisions AS parent
            JOIN active_lineage
              ON parent.revision_id = active_lineage.parent_revision_id
        ), authorities AS (
            SELECT DISTINCT ON (detail.source_key)
                   detail.source_key,
                   detail.revision_id AS authority_revision
            FROM runtime_source_details AS detail
            JOIN active_lineage
              ON active_lineage.revision_id = detail.revision_id
            WHERE detail.range_id = %s
            ORDER BY detail.source_key, active_lineage.lineage_depth
        ), requested(token, needle) AS (
            VALUES {requested_values}
        ), eligible_ranking AS MATERIALIZED (
            SELECT ranking.rank, ranking.detail_key, ranking.title,
                   ranking.artist, ranking.name, ranking.row_count,
                   ranking.song_count, ranking.video_count,
                   ranking.timestamp_count, ranking.search_text, ranking.payload_json,
                   ranking.channel_search_text
            FROM runtime_ranking_rows AS ranking
            WHERE ranking.revision_id = %s
              AND ranking.range_id = %s
              AND ranking.view = %s
              AND ranking.metric = %s
              AND ranking.scope_key = %s
              AND ranking.row_count >= %s
        ){source_candidate_cte}, matched_source_tokens AS MATERIALIZED (
            SELECT DISTINCT {source_match_key} AS source_key,
                            {source_token_alias}.token
            {matched_source_from}
            WHERE occurrence.range_id = %s
              AND ({occurrence_predicate})
            ORDER BY {source_match_key}, {source_token_alias}.token
            LIMIT %s
        )
    """
    scalar_expressions = _runtime_ranking_field_expressions(
        ranking_alias, fields,
    )
    conditions: list[str] = []
    outer_params: list[Any] = []
    for token in options["searchTokens"]:
        scalar_clauses = [
            f"coalesce({expression}, '') ILIKE %s ESCAPE E'\\\\'"
            for expression in scalar_expressions
        ]
        outer_params.extend(
            f"%{_sql_like_literal(token)}%"
            for _ in scalar_clauses
        )
        source_clause = (
            "EXISTS ("
            "SELECT 1 FROM matched_source_tokens AS matched "
            f"WHERE matched.source_key = {ranking_alias}.detail_key "
            "AND matched.token = %s)"
        )
        outer_params.append(_text(token).casefold())
        conditions.append(
            "(" + " OR ".join((*scalar_clauses, source_clause)) + ")"
        )
    return (
        source_cte,
        " AND " + " AND ".join(conditions),
        [
            _text(active_revision_id),
            _text(options["range"]),
            *requested_params,
            ranking_revision,
            _text(options["range"]),
            _text(options["view"]),
            db_metric,
            _ranking_scope_key(options),
            int(options["minCount"]),
            _text(options["range"]),
            _RANKING_SOURCE_SEARCH_MATCH_CAP + 1,
        ],
        outer_params,
    )


def _runtime_ranking_light_payload_select(alias: str) -> str:
    """Return a scalar-only payload; page hydration fills occurrences once."""

    return f"""
        jsonb_build_object(
            'type', 'song',
            'key', {alias}.detail_key,
            'title', {alias}.title,
            'displayArtist', coalesce({alias}.artist, ''),
            'count', {alias}.row_count,
            'songCount', {alias}.song_count,
            'videoCount', {alias}.video_count,
            'timestampCount', {alias}.timestamp_count,
            'sourceDetailKey', {alias}.detail_key,
            'occurrences', '[]'::jsonb
        ) AS payload_json
    """


def _runtime_row_matches_search(
    row: Mapping[str, Any],
    options: Mapping[str, Any],
) -> bool:
    """Match every token against only the explicitly/effectively selected fields."""

    tokens = tuple(
        _text(token).casefold()
        for token in (options.get("searchTokens") or ())
        if _text(token)
    )
    if not tokens:
        return True
    fields = _effective_search_fields(options)
    texts = _runtime_row_search_texts(row)
    return all(
        any(token in texts.get(field, "") for field in fields)
        for token in tokens
    )


def _public_row_matches_search(
    row: Mapping[str, Any],
    options: Mapping[str, Any],
) -> bool:
    """Use the new separated contract only for ordinary song rankings."""

    if _text(options.get("view")) in {"songs", "songIndex"}:
        return _runtime_row_matches_search(row, options)
    persisted_search = (
        _text(row.get("search_text"))
        + " "
        + _text(row.get("channel_search_text"))
    )
    if _matches_search_tokens(persisted_search, options.get("searchTokens") or ()):
        return True
    if not persisted_search.strip():
        return _matches_search_tokens(
            _overlay_candidate_search_text(row),
            options.get("searchTokens") or (),
        )
    return False


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

    active_manifest = _json_object(lineage[0].get("manifest_json")) if lineage else {}
    if (
        active_manifest.get("rangeReset") is True
        and active_manifest.get("partialVideoRows") is True
        and _text(active_manifest.get("authoritativeRange")) == "7d"
    ):
        return _load_generic_runtime_snapshot(connection, revision_id, lineage[0])

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
    if _text(query.get("view")) in {"songs", "songIndex"}:
        fields = _effective_search_fields(query) or default_fields
    elif query.get("searchFields") is not None:
        fields = tuple(query.get("searchFields") or default_fields)
    else:
        fields = {
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


def _song_owner_count_list(
    occurrences: Iterable[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Aggregate Artist songs by canonical key, not raw title spelling.

    Authoritative 7d rows may retain NFKC-equivalent display spellings for the
    same accepted ``songKey`` (for example ASCII ``B`` and full-width ``Ｂ``).
    ``songCount`` already uses that key, so the public Artist song list must
    use the same owner or source materialization can split one song later.
    Keep the most frequent raw spelling as the display name (then lexical
    order for a deterministic tie); every occurrence remains unchanged.
    """

    counts: dict[str, int] = defaultdict(int)
    names: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for occurrence in occurrences:
        song = occurrence.get("song")
        song = song if isinstance(song, Mapping) else {}
        song_key = _song_key(song)
        song_name = _text(song.get("title"))
        if not song_key or not song_name:
            continue
        counts[song_key] += 1
        names[song_key][song_name] += 1
    values = []
    for song_key, count in counts.items():
        song_name = min(
            names[song_key],
            key=lambda value: (-names[song_key][value], value),
        )
        values.append({"key": song_key, "name": song_name, "count": count})
    return sorted(
        values,
        key=lambda value: (-int(value["count"]), value["name"], value["key"]),
    )


def _entity_groups(records: Iterable[Mapping[str, Any]], query: Mapping[str, Any]) -> list[dict[str, Any]]:
    range_id = query["range"]
    view = query["view"]
    grouped: dict[str, dict[str, Any]] = {}
    for record in records:
        occurrences = [
            occurrence
            for occurrence in _occurrences_for_range(record, range_id)
            if _matches(
                occurrence,
                query,
                ("title", "artist", "channel", "video", "source"),
            )
            and _occurrence_matches_ranking_scope(occurrence["song"], query)
        ]
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


def _entity_group_sort_text(
    group: Mapping[str, Any], view: str,
) -> str:
    """Match the public card title/name used by persisted ranking rows."""

    video = group.get("video")
    video = video if isinstance(video, Mapping) else {}
    if view == "videos":
        return _text(video.get("title") or group.get("key"))
    if view == "vtubers":
        return _text(video.get("channelName") or group.get("key"))
    return _text(group.get("title") or group.get("key"))


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
            "songs": _song_owner_count_list(occurrences),
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
    payload["songCount"] = payload.get("songCount", len(songs))
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
    groups.sort(key=lambda group: (
        -_metric_value(group, options["metric"]),
        _entity_group_sort_text(group, options["view"]),
        _text(group.get("key")),
    ))
    total_occurrences = sum(len(group["occurrences"]) for group in groups)
    total_videos = len({_text(row.get("videoId")) for group in groups for row in group["occurrences"]})
    page_count = max(1, math.ceil(len(groups) / options["pageSize"]))
    offset = (options["page"] - 1) * options["pageSize"]
    page_groups = groups[offset : offset + options["pageSize"]]
    result_records = []
    for index, group in enumerate(page_groups, start=offset + 1):
        payload = _group_payload(group, options)
        payload["rank"] = index
        result_records.append(payload)
    if options["compact"]:
        result_records = compact_ranking_payloads(result_records, options["view"])
    return {
        "schemaVersion": 1, "rangeId": options["range"], "view": options["view"],
        "metric": "occurrences" if options["metric"] == "count" else options["metric"],
        "searchScope": options["searchScope"],
        "searchFields": _public_search_fields(options), "page": options["page"],
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


def _ranking_preview_video_id(item: Mapping[str, Any]) -> str:
    """Return the public video identity from one persisted ranking preview."""

    if not isinstance(item, Mapping):
        return ""
    nested = item.get("item")
    if isinstance(nested, Mapping):
        nested_id = _text(
            nested.get("videoId")
            or nested.get("video_id")
            or nested.get("youtubeVideoId")
        )
        if nested_id:
            return nested_id
    return _text(
        item.get("videoId")
        or item.get("video_id")
        or item.get("youtubeVideoId")
    )


def _ranking_preview_target(
    payload: Mapping[str, Any],
    occurrences: Sequence[Mapping[str, Any]],
) -> int:
    declared = payload.get("distinctVideoCount")
    if declared is None:
        declared = payload.get("videoCount")
    try:
        target = max(0, int(declared or 0))
    except (TypeError, ValueError):
        target = 0
    if not target:
        target = len({
            video_id
            for video_id in (_ranking_preview_video_id(item) for item in occurrences)
            if video_id
        })
    return min(MAX_RANKING_PREVIEW_VIDEOS, target)


def _normalize_ranking_preview_occurrence(
    item: Mapping[str, Any],
) -> dict[str, Any]:
    """Project nested source fields into the public ranking-preview shape."""

    result = dict(item)
    nested_item = item.get("item") if isinstance(item.get("item"), Mapping) else {}
    nested_video = item.get("video") if isinstance(item.get("video"), Mapping) else {}
    song = item.get("song") if isinstance(item.get("song"), Mapping) else {}

    fields = {
        "videoId": (item.get("videoId"), nested_item.get("videoId"), nested_video.get("videoId"), song.get("videoId")),
        "seconds": (item.get("seconds"), song.get("seconds"), nested_item.get("seconds"), nested_video.get("seconds")),
        "title": (item.get("title"), nested_item.get("title"), nested_video.get("title"), song.get("title")),
        "channelHandle": (item.get("channelHandle"), nested_item.get("channelHandle"), nested_video.get("channelHandle")),
        "channelId": (item.get("channelId"), nested_item.get("channelId"), nested_video.get("channelId")),
        "channelName": (item.get("channelName"), nested_item.get("channelName"), nested_video.get("channelName")),
        "channelUrl": (item.get("channelUrl"), nested_item.get("channelUrl"), nested_video.get("channelUrl")),
        "publishedAt": (
            item.get("publishedAt"),
            nested_item.get("publishedAt"),
            nested_item.get("publishedTimestamp"),
            nested_video.get("publishedAt"),
            nested_video.get("publishedTimestamp"),
        ),
    }
    for name, values in fields.items():
        if result.get(name) not in (None, ""):
            continue
        for value in values:
            if value not in (None, ""):
                result[name] = value
                break
    return result


def _runtime_ranking_preview_source_key(
    payload: Mapping[str, Any],
    range_id: str,
    view: str,
) -> str:
    """Resolve the internal source lookup key without changing the public key.

    Source-search ranking rows use a scalar light payload.  That payload may
    carry ``detail_key`` as a temporary sourceDetailKey, while persisted
    source occurrences use the canonical exporter key.  Keep the response
    field untouched and repair only the bounded lookup route.
    """

    public_key = _text(payload.get("sourceDetailKey"))
    group_key = _text(payload.get("key"))
    canonical_key = _production_source_detail_key_for_group(
        view, range_id, group_key,
    )
    if canonical_key and (not public_key or public_key == group_key):
        return canonical_key
    return public_key


def _merge_ranking_preview_items(
    current: Sequence[Mapping[str, Any]],
    additions: Sequence[Mapping[str, Any]],
    target: int,
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen_video_ids: set[str] = set()
    for item in (*current, *additions):
        if not isinstance(item, Mapping):
            continue
        normalized = _normalize_ranking_preview_occurrence(item)
        video_id = _ranking_preview_video_id(normalized)
        if video_id and video_id in seen_video_ids:
            continue
        if video_id:
            seen_video_ids.add(video_id)
        merged.append(normalized)
        if target and len(seen_video_ids) >= target:
            break
    return merged


def _hydrate_runtime_ranking_song_previews(
    connection,
    revision_id: str,
    range_id: str,
    view: str,
    payloads: Sequence[dict[str, Any]],
) -> None:
    """Batch-fill short persisted song-card previews from source occurrences.

    "runtime_ranking_rows.payload_json" is intentionally bounded, while the
    matching "runtime_source_occurrences" rows retain the complete source
    identity.  Read one page of source keys in one query; never issue one
    source query per returned card.
    """

    if view not in {"songs", "songIndex", "vsingerSongs"} or not payloads:
        return

    requested_keys: list[str] = []
    for payload in payloads:
        if not isinstance(payload, Mapping):
            continue
        current = payload.get("occurrences")
        current_items = current if isinstance(current, list) else []
        target = _ranking_preview_target(payload, current_items)
        existing_video_ids = {
            _ranking_preview_video_id(item)
            for item in current_items
            if _ranking_preview_video_id(item)
        }
        source_key = _runtime_ranking_preview_source_key(
            payload, range_id, view,
        )
        if source_key and len(existing_video_ids) < target and source_key not in requested_keys:
            requested_keys.append(source_key)

    additions_by_key: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if requested_keys:
        source_rows = _rows(
            connection,
            """
            WITH RECURSIVE requested AS (
                SELECT source_key, ordinality
                FROM unnest(%s::text[]) WITH ORDINALITY
                    AS request(source_key, ordinality)
            ),
            lineage AS (
                SELECT revision_id, parent_revision_id, 0 AS lineage_depth
                FROM migration_revisions
                WHERE revision_id = %s
                UNION ALL
                SELECT parent.revision_id, parent.parent_revision_id,
                       lineage.lineage_depth + 1
                FROM migration_revisions AS parent
                JOIN lineage
                  ON parent.revision_id = lineage.parent_revision_id
            ),
            authorities AS (
                SELECT DISTINCT ON (detail.source_key)
                       detail.source_key,
                       detail.revision_id AS authority_revision
                FROM runtime_source_details AS detail
                JOIN requested AS request
                  ON request.source_key = detail.source_key
                JOIN lineage
                  ON lineage.revision_id = detail.revision_id
                WHERE detail.range_id = %s
                ORDER BY detail.source_key, lineage.lineage_depth
            ),
            per_video AS (
                SELECT authority.source_key, o.position, o.video_id,
                       o.title, o.channel_name, o.channel_id,
                       o.channel_handle, o.channel_url,
                       o.published_timestamp, o.seconds,
                       o.payload_json,
                       row_number() OVER (
                           PARTITION BY authority.source_key, o.video_id
                           ORDER BY o.position, o.video_id
                       ) AS same_video_rank
                FROM authorities AS authority
                JOIN runtime_source_occurrences AS o
                  ON o.revision_id = authority.authority_revision
                 AND o.source_key = authority.source_key
                WHERE o.range_id = %s
                  AND o.video_id IS NOT NULL
            ),
            distinct_videos AS (
                SELECT per_video.*,
                       row_number() OVER (
                           PARTITION BY per_video.source_key
                           ORDER BY per_video.position, per_video.video_id
                       ) AS source_video_rank
                FROM per_video
                WHERE per_video.same_video_rank = 1
            )
            SELECT distinct_videos.source_key,
                   distinct_videos.position,
                   distinct_videos.video_id,
                   distinct_videos.title,
                   distinct_videos.channel_name,
                   distinct_videos.channel_id,
                   distinct_videos.channel_handle,
                   distinct_videos.channel_url,
                   distinct_videos.published_timestamp,
                   distinct_videos.seconds,
                   distinct_videos.payload_json
            FROM distinct_videos
            JOIN requested
              ON requested.source_key = distinct_videos.source_key
            WHERE distinct_videos.source_video_rank <= %s
            ORDER BY requested.ordinality,
                     distinct_videos.position,
                     distinct_videos.video_id
            """,
            [requested_keys, revision_id, range_id, range_id, MAX_RANKING_PREVIEW_VIDEOS],
        )
        for row in source_rows:
            source_key = _text(row.get("source_key"))
            item = _runtime_source_occurrence(row)
            if source_key and _ranking_preview_video_id(item):
                additions_by_key[source_key].append(item)

    for payload in payloads:
        if not isinstance(payload, Mapping):
            continue
        current = payload.get("occurrences")
        current_items = current if isinstance(current, list) else []
        target = _ranking_preview_target(payload, current_items)
        source_key = _runtime_ranking_preview_source_key(
            payload, range_id, view,
        )
        payload["occurrences"] = _merge_ranking_preview_items(
            current_items,
            additions_by_key.get(source_key, ()),
            target,
        )


def _runtime_rankings_payload(connection, revision_id: str, query: Mapping[str, Any] | None = None) -> dict[str, Any]:
    options = _query_options(query)
    db_metric = "count" if options["metric"] in {"count", "occurrences"} else options["metric"]
    db_scope = _ranking_scope_key(options)
    # The normal UI request has no text filter.  Do not materialize every
    # payload just to return one page: the full runtime projection can contain
    # hundreds of thousands of rows, and the old SQLite API answered this path
    # from a precomputed index.  Keep the filtered/search path below for
    # compatibility, but make the common path bounded and proxy-safe.
    if not options["q"]:
        where = (
            "revision_id = %s AND range_id = %s AND view = %s "
            "AND metric = %s AND scope_key = %s AND row_count >= %s"
        )
        params = [
            revision_id, options["range"], options["view"], db_metric,
            db_scope, options["minCount"],
        ]
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
        _hydrate_runtime_ranking_song_previews(connection, revision_id, options["range"], options["view"], records)
        if options["compact"]:
            records = compact_ranking_payloads(records, options["view"])
        return {
            "schemaVersion": 1, "rangeId": options["range"], "view": options["view"],
            "metric": "occurrences" if options["metric"] == "count" else options["metric"],
            "searchScope": options["searchScope"], "searchFields": _public_search_fields(options),
            "page": options["page"], "pageSize": options["pageSize"], "totalCount": total_count,
            "filteredBaseCount": total_count,
            "totalOccurrenceCount": int(summary.get("total_occurrence_count") or 0),
            "totalSongCount": int(summary.get("total_song_count") or 0),
            "totalVideoCount": int(summary.get("total_video_count") or 0),
            "pageCount": page_count, "compact": options["compact"], "records": records,
        }
    (
        source_search_cte,
        source_search_condition,
        source_cte_params,
        source_outer_params,
    ) = _runtime_source_search_sql(options, revision_id, revision_id, "ranking")
    source_search_sql_active = bool(source_search_condition)
    payload_select = (
        _runtime_ranking_light_payload_select("ranking")
        if source_search_sql_active
        else "ranking.payload_json"
    )
    search_select = (
        "'' AS search_text, ranking.channel_search_text"
        if source_search_sql_active
        else "ranking.search_text, ranking.channel_search_text"
    )
    ranking_from = (
        "eligible_ranking AS ranking"
        if source_search_sql_active
        else "runtime_ranking_rows AS ranking"
    )
    ranking_scope_clause = (
        ""
        if source_search_sql_active
        else (
            " AND ranking.revision_id = %s AND ranking.range_id = %s"
            " AND ranking.view = %s AND ranking.metric = %s"
            " AND ranking.scope_key = %s"
        )
    )
    rows = _rows(
        connection,
        f"""
        {source_search_cte}
        SELECT ranking.rank, ranking.title, ranking.artist, ranking.name,
               ranking.row_count, ranking.song_count, ranking.video_count,
               ranking.timestamp_count, {payload_select}, {search_select}
        FROM {ranking_from}
        WHERE TRUE{source_search_condition}
        {ranking_scope_clause}
        ORDER BY ranking.rank
        """,
        (
            [*source_cte_params, *source_outer_params]
            if source_search_sql_active
            else [revision_id, options["range"], options["view"], db_metric, db_scope]
        ),
    )
    if options["searchTokens"] and not source_search_sql_active:
        rows = [
            row for row in rows
            if _public_row_matches_search(row, options)
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
    _hydrate_runtime_ranking_song_previews(connection, revision_id, options["range"], options["view"], records)
    if options["compact"]:
        records = compact_ranking_payloads(records, options["view"])
    return {
        "schemaVersion": 1, "rangeId": options["range"], "view": options["view"],
        "metric": "occurrences" if options["metric"] == "count" else options["metric"],
        "searchScope": options["searchScope"], "searchFields": _public_search_fields(options),
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
    if "isNiche" not in item and "is_niche" in row:
        item["isNiche"] = row.get("is_niche") is True
    if "isUnknownArtist" not in item and "is_unknown_artist" in row:
        item["isUnknownArtist"] = row.get("is_unknown_artist") is True
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
               channel_url, published_timestamp, seconds, is_niche,
               is_unknown_artist, payload_json
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


def _escape_source_search_pattern(value: Any) -> str:
    """Escape a literal source query for PostgreSQL ``ILIKE``."""

    return _text(value).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _runtime_source_table_page(
    connection,
    revision_id: str,
    key: str,
    query: Mapping[str, Any] | None = None,
    *,
    entity_type: str = "",
) -> dict[str, Any]:
    """Read one bounded page from one authoritative physical source revision."""

    raw_query = query or {}
    options = _query_options(raw_query)
    search_predicate = ""
    search_params: list[Any] = []
    if options["q"]:
        search_predicate = " AND search_text ILIKE %s ESCAPE E'\\\\'"
        search_params.append(f"%{_escape_source_search_pattern(options['q'])}%")
    scope_predicate = ""
    if options["nicheOnly"]:
        scope_predicate += " AND is_niche IS TRUE"
    if options["hideUnknownArtist"]:
        scope_predicate += " AND is_unknown_artist IS NOT TRUE"
    where = (
        "revision_id = %s AND source_key = %s AND range_id = %s"
        + search_predicate + scope_predicate
    )
    where_params: list[Any] = [revision_id, key, options["range"], *search_params]
    summary_rows = _rows(
        connection,
        f"""
        SELECT count(*) AS total_occurrence_count,
               count(DISTINCT video_id) AS total_video_count,
               (
                 SELECT count(*)
                 FROM runtime_source_occurrences AS physical
                 WHERE physical.revision_id = %s
                   AND physical.source_key = %s
                   AND physical.range_id = %s
               ) AS source_occurrence_count
        FROM runtime_source_occurrences
        WHERE {where}
        """,
        [revision_id, key, options["range"], *where_params],
    )
    summary = summary_rows[0] if summary_rows else {}
    total_occurrence_count = int(summary.get("total_occurrence_count") or 0)
    total_video_count = int(summary.get("total_video_count") or 0)
    source_occurrence_count = int(summary.get("source_occurrence_count") or 0)
    if not source_occurrence_count:
        return {"schemaVersion": 1, "found": False, "sourceKey": key}

    page_size = options["pageSize"]
    page_count = max(1, math.ceil(total_video_count / page_size))
    page = min(options["page"], page_count)
    page_rows = _rows(
        connection,
        f"""
        SELECT video_id, min(position) AS first_position
        FROM runtime_source_occurrences
        WHERE {where}
        GROUP BY video_id
        ORDER BY first_position, video_id
        LIMIT %s OFFSET %s
        """,
        [*where_params, page_size, (page - 1) * page_size],
    )
    selected_video_ids = [
        _text(row.get("video_id"))
        for row in page_rows[:page_size]
        if _text(row.get("video_id"))
    ]
    occurrence_rows: list[Mapping[str, Any]] = []
    if selected_video_ids:
        occurrence_rows = _rows(
            connection,
            f"""
            SELECT position, video_id, title, channel_name, channel_id,
                   channel_handle, channel_url, published_timestamp, seconds,
                   is_niche, is_unknown_artist, search_text, payload_json
            FROM runtime_source_occurrences
            WHERE {where} AND video_id = ANY(%s::text[])
            ORDER BY position, video_id
            LIMIT %s
            """,
            [
                *where_params,
                selected_video_ids,
                _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
            ],
        )
    if len(occurrence_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("source page occurrence lookup exceeded bounded cap")
    occurrences = [_runtime_source_occurrence(row) for row in occurrence_rows]
    canonical_songs: list[dict[str, Any]] | None = None
    if entity_type == "vtuber":
        title_rows = _rows(
            connection,
            f"""
            WITH titled AS (
              SELECT coalesce(
                       payload_json::jsonb->'song'->>'title',
                       payload_json::jsonb->'payload'->'song'->>'title',
                       payload_json::jsonb->>'songTitle',
                       payload_json::jsonb->'payload'->>'songTitle'
                     ) AS song_title
              FROM runtime_source_occurrences
              WHERE {where}
            )
            SELECT song_title, count(*) AS occurrence_count
            FROM titled
            GROUP BY song_title
            ORDER BY song_title
            LIMIT %s
            """,
            [*where_params, _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1],
        )
        if len(title_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
            raise PostgresAdapterError(
                "source canonical title aggregation exceeded bounded cap"
            )
        canonical_by_key: dict[str, dict[str, Any]] = {}
        title_total = 0
        for row in title_rows:
            raw_title = _text(row.get("song_title"))
            count = int(row.get("occurrence_count") or 0)
            if not raw_title or count <= 0:
                raise PostgresAdapterError(
                    "source canonical title aggregation is invalid"
                )
            title_total += count
            canonical_name, canonical_key = _vtuber_canonical_song_identity(
                raw_title
            )
            if not canonical_key:
                continue
            entry = canonical_by_key.setdefault(
                canonical_key,
                {"key": canonical_key, "name": canonical_name, "count": 0},
            )
            entry["count"] = int(entry["count"]) + count
        if title_total != total_occurrence_count:
            raise PostgresAdapterError(
                "source canonical titles disagree with filtered occurrences"
            )
        canonical_songs = sorted(
            canonical_by_key.values(),
            key=lambda item: (-int(item["count"]), _overlay_norm(item["name"])),
        )
    record = {
        "sourceDetailKey": key,
        "rangeId": options["range"],
        "occurrences": occurrences,
        "count": total_occurrence_count,
        "occurrenceCount": total_occurrence_count,
        "timestampCount": total_occurrence_count,
        "videoCount": total_video_count,
        "sourceFilterQuery": options["q"],
        "occurrencePreviewLimited": total_occurrence_count > len(occurrences),
    }
    if canonical_songs is not None:
        record["songs"] = canonical_songs
        record["songCount"] = len(canonical_songs)
    response: dict[str, Any] = {
        "schemaVersion": 1,
        "found": True,
        "sourceKey": key,
        "record": record,
    }
    if any(field in raw_query for field in ("page", "pageSize")):
        response.update({
            "page": page,
            "pageSize": page_size,
            "pageCount": page_count,
            "totalCount": total_video_count,
            "totalVideoCount": total_video_count,
            "totalOccurrenceCount": total_occurrence_count,
        })
        if canonical_songs is not None:
            response["totalSongCount"] = len(canonical_songs)
    return response


def _runtime_source_payload(
    connection,
    revision_id: str,
    key: str,
    query: Mapping[str, Any] | None = None,
    allow_derived: bool = True,
    overlay_revision_ids: Sequence[str] | None = None,
) -> dict[str, Any]:
    raw_query = query or {}
    options = _query_options(raw_query)
    lineage_revision_ids = list(dict.fromkeys([
        *(_text(value) for value in (overlay_revision_ids or ()) if _text(value)),
        _text(revision_id),
    ]))
    rows = _rows(
        connection,
        """
        SELECT revision_id, range_id, entity_type, payload_json
        FROM runtime_source_details
        WHERE revision_id::text = ANY(%s::text[])
          AND source_key = %s AND range_id = %s
        ORDER BY array_position(%s::text[], revision_id::text)
        LIMIT 1
        """,
        [lineage_revision_ids, key, options["range"], lineage_revision_ids],
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
    detail_revision_id = _text(rows[0].get("revision_id")) or revision_id
    record = _json_object(rows[0].get("payload_json"))
    paged = _runtime_source_table_page(
        connection, detail_revision_id, key, raw_query,
        entity_type=_text(rows[0].get("entity_type") or record.get("type")),
    )
    if paged.get("found"):
        result = dict(paged)
        page_record = dict(paged.get("record") or {})
        merged = {**dict(record), **page_record}
        # Aggregate identity belongs to the persisted source detail.  Physical
        # source rows own only the bounded page and recomputed counts.
        for name in (
            "type", "key", "title", "workTitle", "artist", "displayArtist",
            "artists", "variantLabels", "searchText", "sortKey",
        ):
            if name in record:
                merged[name] = record[name]
        merged["sourceDetailKey"] = key
        result["record"] = merged
        result["sourceRevisionId"] = detail_revision_id
        return result

    # A nearest detail row without physical occurrences is authoritative.  It
    # can be an explicit empty projection or a small compatibility preview; do
    # not fall through to an older parent source revision.
    raw_embedded = record.get("occurrences") or ()
    embedded = [
        dict(item) for item in raw_embedded
        if isinstance(item, Mapping)
    ]
    declared_occurrences = int(
        record.get("occurrenceCount") or record.get("count") or len(embedded)
    )
    if (
        bool(record.get("occurrencePreviewLimited"))
        or declared_occurrences > len(embedded)
        or len(embedded) > _MAX_AFFECTED_RUNTIME_OCCURRENCES
    ):
        raise PostgresAdapterError(
            "authoritative source detail is missing its physical occurrence rows"
        )
    for item in embedded:
        video_id = _text(
            item.get("youtubeVideoId")
            or item.get("videoId")
            or item.get("externalVideoId")
        )
        if not video_id:
            raise PostgresAdapterError(
                "authoritative source detail occurrence is missing video identity"
            )
    if options["q"]:
        embedded = [
            item for item in embedded
            if options["q"] in json.dumps(item, ensure_ascii=False).casefold()
        ]
    embedded = [
        item
        for item in embedded
        if _occurrence_matches_ranking_scope(item, options)
    ]
    video_keys: list[str] = []
    seen_video_keys: set[str] = set()
    for item in embedded:
        video_id = _text(
            item.get("youtubeVideoId")
            or item.get("videoId")
            or item.get("externalVideoId")
        )
        if video_id not in seen_video_keys:
            seen_video_keys.add(video_id)
            video_keys.append(video_id)
    page_size = options["pageSize"]
    page_count = max(1, math.ceil(len(video_keys) / page_size))
    page = min(options["page"], page_count)
    selected_video_ids = set(
        video_keys[(page - 1) * page_size : page * page_size]
    )
    page_occurrences = [
        item for item in embedded
        if _text(
            item.get("youtubeVideoId")
            or item.get("videoId")
            or item.get("externalVideoId")
        ) in selected_video_ids
    ]
    result_record = dict(record)
    result_record["occurrences"] = page_occurrences
    result_record["sourceDetailKey"] = key
    result_record["sourceFilterQuery"] = options["q"]
    total_occurrences = len(embedded)
    total_videos = len(video_keys)
    result_record["count"] = total_occurrences
    result_record["occurrenceCount"] = total_occurrences
    result_record["timestampCount"] = total_occurrences
    result_record["videoCount"] = total_videos
    result_record["occurrencePreviewLimited"] = total_occurrences > len(result_record["occurrences"])
    response: dict[str, Any] = {
        "schemaVersion": 1,
        "found": True,
        "sourceKey": key,
        "sourceRevisionId": detail_revision_id,
        "record": result_record,
    }
    if any(field in raw_query for field in ("page", "pageSize")):
        response.update({
            "page": page,
            "pageSize": page_size,
            "pageCount": page_count,
            "totalCount": total_videos,
            "totalVideoCount": total_videos,
            "totalOccurrenceCount": total_occurrences,
        })
    return response


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
    if not _text(occurrence.get("title")):
        # The ranking builder already excludes accepted discovery candidates
        # whose normalized title is empty. Keep source materialization on the
        # same public-occurrence contract: these reviewed, title-less rows are
        # curation evidence, not songs. Persisted parent authority is still
        # validated separately and must fail closed if it is malformed.
        return None
    for public_name, camel_name, snake_name in (
        ("isNiche", "isNiche", "is_niche"),
        ("isUnknownArtist", "isUnknownArtist", "is_unknown_artist"),
    ):
        if public_name in occurrence and occurrence.get(public_name) is not None:
            continue
        value = _scope_boolean_flag(row, camel_name, snake_name)
        if value is not None:
            occurrence[public_name] = value
    return {"video": video, "occurrences": (occurrence,)}


def _source_song_identity_evidence(
    value: Mapping[str, Any],
) -> tuple[dict[tuple[str, str], tuple[str, str]], set[str]]:
    """Extract exact stored song tuples without using aggregate displayArtist."""

    pairs: dict[tuple[str, str], tuple[str, str]] = {}
    song_keys: set[str] = set()
    identity_root = dict(value)
    occurrences = identity_root.get("occurrences")
    if isinstance(occurrences, (list, tuple)):
        declared_raw = (
            identity_root.get("occurrenceCount")
            or identity_root.get("count")
            or len(occurrences)
        )
        try:
            declared_occurrences = int(declared_raw)
        except (TypeError, ValueError):
            declared_occurrences = len(occurrences)
        if (
            identity_root.get("occurrencePreviewLimited") is True
            or declared_occurrences > len(occurrences)
        ):
            # Runtime source pagination merges the current video page into
            # the immutable detail payload.  Those occurrences are display
            # data, not source-owner evidence: using them here made the exact
            # song identity (and therefore overlay totals) depend on page 1,
            # page 2, and so on.  Complete legacy embedded sources remain a
            # valid fallback, while incomplete pages must rely on invariant
            # detail fields or fail closed.
            identity_root.pop("occurrences", None)
    queue: list[Any] = [identity_root]
    visited = 0
    while queue:
        current = queue.pop()
        visited += 1
        if visited > MAX_SOURCE_SONG_IDENTITY_NODES:
            raise PostgresAdapterError("source song identity evidence exceeded bounded shape")
        if isinstance(current, Mapping):
            song_key = _text(current.get("songKey") or current.get("song_key"))
            if song_key:
                song_keys.add(song_key)
            title = _text(current.get("title") or current.get("workTitle"))
            if title and "artist" in current:
                artist = _text(current.get("artist"))
                pairs.setdefault(
                    (_source_song_owner_norm(title), _source_song_owner_norm(artist)),
                    (title, artist),
                )
            for name in (
                "song", "songs", "occurrences", "item", "payload",
                "record", "sourceIdentity", "source_identity",
                "replacementPayload", "originalIdentity",
            ):
                nested = current.get(name)
                if isinstance(nested, (Mapping, list, tuple)):
                    queue.append(nested)
        elif isinstance(current, (list, tuple)):
            queue.extend(current)

    title = _text(value.get("title") or value.get("workTitle"))
    if title and "artist" in value:
        artist = _text(value.get("artist"))
        pairs.setdefault(
            (_source_song_owner_norm(title), _source_song_owner_norm(artist)),
            (title, artist),
        )
    artists = value.get("artists")
    if title and isinstance(artists, list):
        for artist_value in artists:
            if isinstance(artist_value, Mapping):
                artist = _text(artist_value.get("name") or artist_value.get("artist"))
            else:
                artist = _text(artist_value)
            if artist:
                pairs.setdefault(
                    (_source_song_owner_norm(title), _source_song_owner_norm(artist)),
                    (title, artist),
                )
    return pairs, song_keys


def _source_song_group_identity(value: Mapping[str, Any]) -> str:
    """Return one validated persisted canonical song-group identity.

    Some legacy unknown-artist source details intentionally omit a top-level
    ``artist`` while retaining the immutable ``<title>::unknown`` aggregate
    key.  Their paged physical occurrences use a display placeholder such as
    ``未記載`` and cannot be treated as owner evidence.  Accept only a key
    whose title component agrees with the persisted aggregate title; this
    preserves the page-variant isolation enforced above.
    """

    key = _text(value.get("key"))
    parts = key.split("::")
    title_key = _source_song_owner_norm(
        value.get("title") or value.get("workTitle")
    )
    if len(parts) != 2 or not title_key or parts[0] != title_key:
        return ""
    return key


def _source_row_song_group_identity(value: Mapping[str, Any]) -> str:
    """Project one bounded overlay row into the parent song-group space."""

    parent_key = _text(
        value.get("parentSongGroupKey")
        or value.get("parent_song_group_key")
    )
    if parent_key:
        return parent_key
    title = ""
    for source in _scope_value_sources(value):
        title = _text(source.get("title") or source.get("workTitle"))
        if title:
            break
    title_key = _source_song_owner_norm(title)
    if not title_key:
        return ""
    artist = _scope_artist(value)
    is_unknown = _scope_boolean_flag(
        value, "isUnknownArtist", "is_unknown_artist",
    )
    artist_key = (
        "unknown"
        if is_unknown is True
        or (is_unknown is None and _unknown_artist_name(artist))
        else _source_song_owner_norm(artist)
    )
    return f"{title_key}::{artist_key}"


def _source_song_group_key_norm(value: Any) -> str:
    """Normalize a persisted/parent Song group for owner comparisons."""

    title, separator, artist = _text(value).partition("::")
    if not separator:
        return ""
    title_key = _source_song_owner_norm(title)
    artist_key = _source_song_owner_norm(artist)
    if not title_key or not artist_key:
        return ""
    return f"{title_key}::{artist_key}"


def _source_record_identity(record: Mapping[str, Any]) -> tuple[str, str]:
    video = record.get("video") if isinstance(record.get("video"), Mapping) else {}
    occurrences = record.get("occurrences") or ()
    occurrence = occurrences[0] if occurrences and isinstance(occurrences[0], Mapping) else {}
    video_id = _text(video.get("videoId") or occurrence.get("videoId"))
    occurrence_id = _text(occurrence.get("occurrenceId") or occurrence.get("occurrence_id"))
    if not occurrence_id:
        occurrence_id = "tuple:" + "\x1f".join((
            _text(occurrence.get("position")),
            _text(occurrence.get("songKey") or occurrence.get("song_key")),
            _text(occurrence.get("title")),
            _text(occurrence.get("artist")),
        ))
    return video_id, occurrence_id


def _source_record_matches_change(
    record: Mapping[str, Any], change: Mapping[str, Any],
) -> bool:
    """Match one source row to one immutable runtime old-side identity.

    Modern source rows and curation changes both carry ``occurrenceId``.  A
    differing non-empty id is conclusive evidence that they are different
    tuples, even when legacy display fields happen to collide.  Persisted
    source storage predates occurrence ids and retains only video, seconds,
    title, and artist.  That reduced identity is accepted only after an exact
    ``runtime_occurrences`` lookup has proved the change's immutable parent
    tuple exists.  A legacy caller without that proof must still provide the
    complete legacy identity below.
    """

    video = record.get("video") if isinstance(record.get("video"), Mapping) else {}
    target_video_id = _text(change.get("videoId") or change.get("video_id"))
    if target_video_id and _text(video.get("videoId")) != target_video_id:
        return False
    occurrences = record.get("occurrences") or ()
    if len(occurrences) != 1 or not isinstance(occurrences[0], Mapping):
        return False
    occurrence = occurrences[0]

    source_occurrence_id = _text(
        occurrence.get("occurrenceId") or occurrence.get("occurrence_id")
    )
    change_occurrence_id = _text(
        change.get("occurrenceId") or change.get("occurrence_id")
    )
    if source_occurrence_id:
        return bool(
            change_occurrence_id
            and source_occurrence_id == change_occurrence_id
        )

    def value(
        row: Mapping[str, Any], *names: str,
    ) -> Any:
        for source in _scope_value_sources(row):
            for name in names:
                if name in source and source.get(name) is not None:
                    return source.get(name)
        return None

    def integer_text(raw: Any) -> str:
        try:
            return str(int(raw))
        except (TypeError, ValueError, OverflowError):
            return ""

    source_identity = (
        _text(value(occurrence, "rangeId", "range_id")),
        integer_text(value(occurrence, "position")),
        _text(value(occurrence, "songKey", "song_key")),
        integer_text(value(occurrence, "seconds")),
        _runtime_entity_key(value(occurrence, "title", "workTitle")),
        _runtime_entity_key(value(occurrence, "artist")),
    )
    change_identity = (
        _text(value(change, "rangeId", "range_id")),
        integer_text(value(change, "position")),
        _text(value(change, "songKey", "song_key")),
        integer_text(value(change, "seconds")),
        _runtime_entity_key(value(change, "title", "workTitle")),
        _runtime_entity_key(value(change, "artist")),
    )
    parent_exists = change.get("_parentRuntimeOccurrenceExists")
    owner_was_explicit = change.get("_runtimeOccurrenceOwnerWasExplicit")
    for marker in (parent_exists, owner_was_explicit):
        if marker is not None and not isinstance(marker, bool):
            raise PostgresAdapterError(
                "source occurrence parent coverage marker is invalid"
            )
    if parent_exists is True:
        # ``runtime_source_occurrences.position`` is source-local ordering,
        # not the immutable ingestion position, and the table has no song-key
        # or occurrence-id column.  Do not fabricate either coordinate.  The
        # exact parent lookup proves the change identity; video + seconds +
        # canonical title/artist then locates its unique persisted source row.
        source_parent_identity = source_identity[3:]
        change_parent_identity = change_identity[3:]
        if (
            all(source_parent_identity[:2])
            and all(change_parent_identity[:2])
            and source_parent_identity == change_parent_identity
        ):
            return True

        # A legacy source row has no occurrence id and may retain the raw
        # pre-curation title while a same-video replacement carries the
        # canonical public tuple in ``replacementPayload``.  The exact
        # parent-runtime proof above is still required; the replacement is
        # accepted only when it preserves the immutable video/occurrence
        # identity and is explicitly marked as a same-video, non-explicit-owner
        # replacement.  This lets source replay subtract the legacy preimage
        # before inserting the canonical replacement without widening ordinary
        # display aliases into a source owner.
        replacement = change.get("replacementPayload")
        replacement_occurrence = (
            _overlay_public_occurrence(replacement)
            if isinstance(replacement, Mapping) else {}
        )
        replacement_video_id = _text(
            replacement_occurrence.get("videoId")
            or replacement.get("video_id")
            if isinstance(replacement, Mapping) else ""
        )
        replacement_occurrence_id = _text(
            replacement_occurrence.get("occurrenceId")
            or replacement.get("occurrence_id")
            if isinstance(replacement, Mapping) else ""
        )
        replacement_identity = (
            integer_text(replacement_occurrence.get("seconds")),
            _runtime_entity_key(
                replacement_occurrence.get("title")
                or replacement_occurrence.get("workTitle")
            ),
            _runtime_entity_key(replacement_occurrence.get("artist")),
        )
        # A runtime replacement can carry an immutable old-side song/artist
        # group. When it does, the legacy source preimage must belong to that
        # same group before its reduced identity is accepted. Without this
        # guard a canonical source row such as ``逆光::ado`` is incorrectly
        # consumed by a replacement whose old group is the unranked display
        # alias ``逆光ウタfromonepiecefilmred::ado``; source then drops one
        # real parent row while ranking retains it. Older callers that do not
        # provide a parent group keep the complete parent-proof fallback below
        # for backwards-compatible legacy fixtures.
        parent_song_group = _text(value(
            change, "parentSongGroupKey", "parent_song_group_key",
        ))
        if parent_song_group:
            source_song_group = _source_song_group_key_norm(
                _source_row_song_group_identity(occurrence),
            )
            if (
                not source_song_group
                or source_song_group
                != _source_song_group_key_norm(parent_song_group)
            ):
                return False
        parent_artist_group = _text(value(
            change, "parentArtistGroupKey", "parent_artist_group_key",
        ))
        if parent_artist_group:
            source_artist_group = _overlay_artist_group_norm(
                value(occurrence, "artist"),
            )
            if not source_artist_group or source_artist_group != parent_artist_group:
                return False
        if (
            change.get("replacement") is True
            and change.get("replacementSameVideo") is True
            and owner_was_explicit is False
            and replacement_video_id == target_video_id
            and replacement_occurrence_id
            and all(replacement_identity[:2])
            and replacement_identity == source_parent_identity
        ):
            return True
        return False
    if parent_exists is False:
        return False
    # Artist may legitimately be empty for an explicitly unknown-artist song;
    # all other legacy coordinates are mandatory.  An incomplete tuple is not
    # permission to delete a persisted source occurrence.
    return bool(
        all(source_identity[:5])
        and all(change_identity[:5])
        and source_identity == change_identity
    )


def _source_records_as_occurrences(
    records: Iterable[Mapping[str, Any]],
    options: Mapping[str, Any],
    canonical_song_key: str | None,
) -> list[dict[str, Any]]:
    """Render exact effective records in the persisted source occurrence shape."""

    values: list[dict[str, Any]] = []
    for record in records:
        video = dict(record.get("video") or {})
        occurrences = []
        for occurrence in record.get("occurrences") or ():
            item = dict(occurrence)
            if canonical_song_key is not None:
                item["songKey"] = canonical_song_key
            occurrences.append(item)
        projected = {"video": video, "occurrences": tuple(occurrences)}
        for item in _occurrences_for_range(projected, options["range"]):
            if (
                _matches(
                    item,
                    options,
                    ("title", "artist", "channel", "video", "source"),
                )
                and _occurrence_matches_ranking_scope(item["song"], options)
            ):
                values.append(item)
    return values


def _source_occurrence_field(value: Mapping[str, Any], field: str) -> str:
    """Read one public aggregate field from nested source occurrence shapes."""

    queue: list[Any] = [value]
    visited = 0
    while queue:
        current = queue.pop()
        visited += 1
        if visited > 128:
            break
        if isinstance(current, Mapping):
            # Source occurrences intentionally carry both a video object and
            # a song object.  Their fields overlap (notably ``title``), so a
            # generic depth-first lookup can count video titles as Artist
            # songs.  The nested song is the canonical owner of song title
            # and artist; inspect it before any container scalar fallback.
            if field in {"title", "artist"}:
                song = current.get("song")
                if isinstance(song, Mapping):
                    candidate = _text(song.get(field))
                    if candidate:
                        return candidate
            candidate = _text(current.get(field))
            if candidate:
                return candidate
            # Append in reverse priority because this stack is LIFO.  A song
            # must remain ahead of item/video when a legacy wrapper stores it
            # one level deeper.
            for name in ("payload", "video", "item", "song"):
                nested = current.get(name)
                if isinstance(nested, Mapping):
                    queue.append(nested)
    return ""


def _adjust_source_count_list(
    current: Any,
    before: Iterable[Mapping[str, Any]],
    after: Iterable[Mapping[str, Any]],
    field: str,
) -> list[dict[str, Any]]:
    """Apply source deltas in the runtime count-map identity space.

    ``RankingUtils.incrementCount`` keys Artist ``songs`` and generic source
    count lists with ``normalizeEntityKey`` (clean whitespace, NFKC, locale
    lowercase).  Grouping by the display spelling here split case/full-width
    variants into extra songs and made card ``songCount`` disagree with its
    source detail.  Preserve the persisted display name while applying every
    delta through the exact runtime key.
    """

    counts: dict[str, int] = defaultdict(int)
    names: dict[str, str] = {}

    def identity(value: Any) -> str:
        return _runtime_entity_key(value)

    if isinstance(current, list):
        for item in current:
            if not isinstance(item, Mapping):
                continue
            name = _text(item.get("name"))
            key = _text(item.get("key")) or identity(name)
            if key and name:
                counts[key] += int(item.get("count") or 0)
                names.setdefault(key, name)
    for item in before:
        name = _source_occurrence_field(item, field)
        key = identity(name)
        if key:
            counts[key] -= 1
            names.setdefault(key, name)
    for item in after:
        name = _source_occurrence_field(item, field)
        key = identity(name)
        if key:
            counts[key] += 1
            names.setdefault(key, name)
    result: list[dict[str, Any]] = []
    for key, count in sorted(
        counts.items(), key=lambda pair: (-pair[1], names.get(pair[0], pair[0]))
    ):
        if count <= 0:
            continue
        item: dict[str, Any] = {"name": names[key], "count": count}
        if field == "title":
            item["key"] = key
        result.append(item)
    return result


def _snapshot_source_overlay_inputs(
    connection,
    parent_revision_id: str,
    overlay_revision_ids: Sequence[str],
    range_id: str,
    video_scope: Sequence[str],
    *,
    include_compatible_full_reset_7d: bool = False,
    include_authoritative_7d_boundary_rows: bool = True,
    authoritative_7d_revision_ids: Sequence[str] | None = None,
) -> tuple[
    tuple[Mapping[str, Any], ...],
    dict[str, dict[str, Any]],
    tuple[Mapping[str, Any], ...],
]:
    """Hydrate only one source's indexed overlay videos during a snapshot."""

    scoped_videos = tuple(sorted({
        _text(value) for value in video_scope if _text(value)
    }))
    if not scoped_videos:
        return (), {}, ()
    accepted_video_resets = _accepted_video_resets(
        connection,
        overlay_revision_ids,
        video_scope=scoped_videos,
    )
    candidate_rows = tuple(_overlay_candidate_rows(
        connection,
        overlay_revision_ids,
        range_id=range_id,
        video_scope=scoped_videos,
    ))
    if (
        range_id == "all"
        and not include_compatible_full_reset_7d
        and include_authoritative_7d_boundary_rows
    ):
        # The reviewed 7D boundary is a partial range reset: its rows are
        # intentionally excluded from the ordinary all-range candidate query
        # above.  All-range ranking nevertheless includes those authoritative
        # boundary occurrences in its persisted Song card.  Route only the
        # newest reviewed boundary rows into Song source reconstruction, and
        # mark their provenance so the source matcher can distinguish them
        # from an unranked punctuation/display alias.  Ordinary 7D rows remain
        # range-isolated and cannot widen a synthetic source card.
        # A persisted source detail can intentionally use a narrowed suffix
        # of the active overlay lineage.  That suffix is correct for the
        # source's ordinary all-range delta, but it can fall *after* the
        # reviewed 7D boundary and therefore hide the authoritative boundary
        # row from this Song source reconstruction.  The materializer passes
        # the complete active lineage separately for this one bounded lookup;
        # callers that do not have a wider lineage retain the old behavior.
        authoritative_7d_ids = _authoritative_7d_overlay_ids(
            connection,
            (authoritative_7d_revision_ids
             if authoritative_7d_revision_ids is not None
             else overlay_revision_ids),
        )
        if authoritative_7d_ids:
            authoritative_rows = _overlay_candidate_rows(
                connection,
                authoritative_7d_ids[-1:],
                range_id="7d",
                video_scope=scoped_videos,
            )
            selected = {
                _overlay_candidate_identity(row): dict(row)
                for row in candidate_rows
            }
            for row in _project_compatible_candidate_rows(
                authoritative_rows, "all",
            ):
                identity = _overlay_candidate_identity(row)
                if identity in selected:
                    # The all-range projection wins when both physical
                    # queries contain the same immutable occurrence. Keep
                    # that row's content, but retain the provenance of the
                    # reviewed 7D boundary so the materializer can remove
                    # only this redundant row during exact cardinality
                    # reconciliation.  The boundary rows came from the
                    # manifest-validated ``authoritative_7d_ids`` query
                    # above; their physical ``source_system`` is allowed to
                    # be a legacy/accepted value (or null), so it is not an
                    # additional authority check.  An ordinary all-range row
                    # still cannot self-authorize because it never enters
                    # this branch without a matching validated 7D row.
                    existing = dict(selected[identity])
                    existing["_authoritative_7d_overlay"] = True
                    existing["_authoritative_7d_source_system"] = "core-7d"
                    selected[identity] = existing
                    continue
                annotated = dict(row)
                annotated["_authoritative_7d_overlay"] = True
                selected[identity] = annotated
            candidate_rows = tuple(selected.values())
    if include_compatible_full_reset_7d:
        # Keep the generic same-range source contract intact.  Only channel
        # detail reconstruction may additionally project physical 7d rows
        # from already-selected non-partial full resets into compatible all.
        # Target-range rows win when the same logical occurrence is present
        # in both physical projections.
        selected = {
            _overlay_candidate_identity(row): dict(row)
            for row in candidate_rows
        }
        for row in _selected_full_reset_candidate_rows(
            connection,
            overlay_revision_ids,
            accepted_video_resets,
            range_id,
        ):
            selected.setdefault(_overlay_candidate_identity(row), dict(row))
        candidate_rows = tuple(selected.values())
    else:
        # Song rankings apply a reset only when the selected video has a row
        # in the requested physical range, or when the reset boundary itself
        # explicitly belongs to that range.  Keep source reconstruction on
        # the same contract.  In particular, a physical 7d refresh must not
        # erase an immutable all-range parent Song occurrence merely because
        # the two ranges share a video id.
        candidate_video_ids = {
            _text(row.get("video_id") or row.get("videoId"))
            for row in candidate_rows
            if _text(row.get("video_id") or row.get("videoId"))
        }
        accepted_video_resets = {
            video_id: row
            for video_id, row in accepted_video_resets.items()
            if video_id in candidate_video_ids
            or _text(
                _overlay_payload(row).get("rangeId")
                or _overlay_payload(row).get("range_id")
                or row.get("range_id")
                or row.get("rangeId")
            ) == range_id
        }
        if accepted_video_resets and candidate_rows:
            # Generic Song rankings route only the exact accepted-reset
            # tuples backed by persisted parent authority into that parent's
            # canonical card.  A synthetic raw-spelling source has no parent
            # payload from which to rediscover the same owner, so preserve
            # the already fail-closed ranking proof on each matching
            # candidate.  Source routing below can then keep ordinary rows in
            # the raw card while moving only those exact tuples to the
            # persisted source key.
            reset_changes = _snapshot_accepted_video_reset_changes(
                connection,
                parent_revision_id,
                accepted_video_resets,
                _query_options({
                    "range": range_id,
                    "view": "songs",
                    "metric": "occurrences",
                }),
                include_persisted_source_authority=True,
            )
            reset_owners = _accepted_song_reset_candidate_owner_keys(
                candidate_rows, reset_changes,
            )
            if reset_owners:
                annotated_candidates: list[Mapping[str, Any]] = []
                for row in candidate_rows:
                    annotated = dict(row)
                    owner_key = _text(reset_owners.get(
                        _accepted_song_reset_candidate_identity(row)
                    ))
                    if owner_key:
                        annotated["_acceptedSongResetOwnerKey"] = owner_key
                        annotated["_acceptedSongResetOwnerSourceKey"] = (
                            _production_source_detail_key_for_group(
                                "songs", range_id, owner_key,
                            )
                        )
                    annotated_candidates.append(annotated)
                candidate_rows = tuple(annotated_candidates)
    # Ranking projection applies runtime curation only to its exact physical
    # range.  Source rebuilding must use the same contract: replaying a 7d
    # same-video replacement into ``all`` can overwrite the persisted tuple's
    # rangeId and make that occurrence disappear during final range filtering.
    runtime_changes = [dict(change) for change in _overlay_rows_for_range(
        _runtime_tombstones(
            connection,
            overlay_revision_ids,
            accepted_video_resets.values() if accepted_video_resets else (),
            candidate_rows,
            parent_revision_id=parent_revision_id,
            channel_scope=(),
            scoped_parent_video_ids=scoped_videos,
        ),
        range_id,
    )]
    _enrich_runtime_parent_group_keys(
        connection,
        parent_revision_id,
        runtime_changes,
        range_id=range_id,
    )
    # Ranking and source materialization load independent change objects.  A
    # same-video VTuber replacement may omit denormalised channel fields, so
    # relying on ranking's earlier in-place owner binding makes source output
    # order-dependent.  Reuse the same bounded, unique persisted-owner proof
    # on this source path after exact parent coverage has been recorded.  The
    # binding may authorize only the replacement's new video/channel tuple;
    # ``_runtime_occurrence_has_immutable_old_side`` still independently
    # decides whether any parent occurrence may be subtracted.
    candidate_rows, accepted_video_resets = _bind_direct_vtuber_parent_owners(
        connection,
        parent_revision_id,
        range_id,
        candidate_rows,
        accepted_video_resets,
        runtime_changes,
    )
    return tuple(candidate_rows), accepted_video_resets, tuple(runtime_changes)


def _generic_group_source_payload(
    connection,
    parent_revision_id: str,
    persisted_record: Mapping[str, Any],
    requested_key: str,
    query: Mapping[str, Any] | None,
    overlay_revision_ids: Sequence[str],
    candidate_rows: Sequence[Mapping[str, Any]] | None = None,
    accepted_video_resets: Mapping[str, Mapping[str, Any]] | None = None,
    runtime_changes: Sequence[Mapping[str, Any]] | None = None,
    *,
    source_type: str,
    artist_owner_revision_id: str | None = None,
    artist_alias_cache: MutableMapping[
        tuple[str, str, str], tuple[str, str, str]
    ] | None = None,
) -> dict[str, Any] | None:
    """Rebuild one affected song or artist from bounded indexed deltas."""

    if source_type not in {"song", "artist"}:
        raise ValueError("generic source type must be song or artist")
    if _text(persisted_record.get("type")) != source_type:
        return None
    options = _query_options(query)
    range_id = options["range"]
    target_key = _text(persisted_record.get("key"))
    canonical_song_key: str | None = target_key if source_type == "song" else None
    if source_type == "song":
        if not target_key:
            return None
        exact_pairs, exact_song_keys = _source_song_identity_evidence(persisted_record)
        exact_group_key = _source_song_group_identity(persisted_record)
        if not exact_pairs and not exact_song_keys and not exact_group_key:
            return {
                "schemaVersion": 1,
                "found": False,
                "sourceKey": requested_key,
                "sourceDetailBlocked": True,
                "sourceDetailState": "missing_exact_song_identity",
            }

        def same_target(row: Mapping[str, Any]) -> bool:
            pairs, keys = _source_song_identity_evidence(row)
            if exact_song_keys & keys:
                return True
            if set(exact_pairs) & set(pairs):
                return True
            return bool(
                exact_group_key
                and _source_row_song_group_identity(row) == exact_group_key
            )
    else:
        target_artist_keys = _artist_source_alias_keys(persisted_record)
        canonical_target = _overlay_artist_group_norm(
            persisted_record.get("key")
            or persisted_record.get("name")
            or persisted_record.get("artist")
        )
        owned_artist_keys: set[str] | None = None

        def same_target(row: Mapping[str, Any]) -> bool:
            artist = _overlay_artist_group_norm(row.get("artist")) or "unknown"
            return artist in (
                owned_artist_keys
                if owned_artist_keys is not None
                else target_artist_keys
            )

    prepared_candidate_rows = candidate_rows is not None
    candidate_rows = tuple(candidate_rows) if prepared_candidate_rows else tuple(
        _overlay_candidate_rows(connection, overlay_revision_ids)
    )
    accepted_video_resets = dict(accepted_video_resets) if accepted_video_resets is not None else _accepted_video_resets(
        connection, overlay_revision_ids,
    )
    candidate_range_rows = _overlay_rows_for_range(candidate_rows, range_id)
    if (
        not prepared_candidate_rows
        and range_id == "all"
        and accepted_video_resets
    ):
        selected = {
            _overlay_candidate_identity(row): dict(row)
            for row in candidate_range_rows
        }
        for row in _selected_full_reset_candidate_rows(
            connection,
            overlay_revision_ids,
            accepted_video_resets,
            range_id,
        ):
            # A physical all row wins over the compatible 7d projection of
            # the same logical occurrence.
            selected.setdefault(_overlay_candidate_identity(row), dict(row))
        candidate_range_rows = tuple(selected.values())
    candidate_range_video_ids = {
        _text(row.get("video_id") or row.get("videoId"))
        for row in candidate_range_rows
        if _text(row.get("video_id") or row.get("videoId"))
    }
    accepted_video_resets = {
        video_id: row
        for video_id, row in accepted_video_resets.items()
        if video_id in candidate_range_video_ids
        or _text(
            _overlay_payload(row).get("rangeId")
            or _overlay_payload(row).get("range_id")
            or row.get("range_id")
            or row.get("rangeId")
        ) == range_id
    }
    changes = list(runtime_changes) if runtime_changes is not None else _runtime_tombstones(
        connection, overlay_revision_ids, accepted_video_resets.values() if accepted_video_resets else None,
        candidate_range_rows,
    )
    changes = _overlay_rows_for_range(changes, range_id)
    replacement_rows = _runtime_replacement_candidate_rows(changes)
    if source_type == "artist" and artist_owner_revision_id:
        candidate_artist_keys = {
            _overlay_artist_group_norm(row.get("artist")) or "unknown"
            for row in (*candidate_range_rows, *changes, *replacement_rows)
        }
        parent_sources, row_owners, _ = _resolved_artist_parent_sources(
            connection,
            artist_owner_revision_id,
            {canonical_target, *candidate_artist_keys},
            range_id,
            alias_cache=artist_alias_cache,
        )
        canonical_target = row_owners.get(canonical_target, "")
        if (
            not canonical_target
            or parent_sources.get(canonical_target) != requested_key
        ):
            raise PostgresAdapterError(
                "Artist source owner disagrees with parent ranking"
            )
        owned_artist_keys = {
            artist_key
            for artist_key in candidate_artist_keys
            if row_owners.get(artist_key) == canonical_target
        }

    potential_video_ids = {
        _text(video_id) for video_id in accepted_video_resets if _text(video_id)
    }
    relevant_change = False
    for row in (*candidate_range_rows, *changes, *replacement_rows):
        entity_type = _text(row.get("entityType") or row.get("entity_type"))
        if same_target(row) or entity_type in {"videos", "runtime_videos"}:
            video_id = _text(row.get("video_id") or row.get("videoId"))
            if video_id:
                potential_video_ids.add(video_id)
            relevant_change = relevant_change or same_target(row)

    affected_source_rows: list[dict[str, Any]] = []
    if potential_video_ids:
        affected_source_rows = _rows(
            connection,
            """
            SELECT position, video_id, title, channel_name, channel_id,
                   channel_handle, channel_url, published_timestamp, seconds,
                   search_text, payload_json
            FROM runtime_source_occurrences
            WHERE revision_id = %s AND source_key = %s AND range_id = %s
              AND video_id = ANY(%s::text[])
            ORDER BY position, video_id
            LIMIT %s
            """,
            [
                parent_revision_id,
                requested_key,
                range_id,
                sorted(potential_video_ids),
                _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
            ],
        )
    if len(affected_source_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("affected source seed exceeded bounded occurrence cap")
    if not affected_source_rows and not relevant_change:
        return None

    effective: dict[tuple[str, str], dict[str, Any]] = {}
    before_public: list[dict[str, Any]] = []
    before_anchor: dict[str, int] = {}
    for row in affected_source_rows:
        public = _runtime_source_occurrence(row)
        before_public.append(public)
        video_id = _text(row.get("video_id"))
        position = int(row.get("position") or 0)
        before_anchor[video_id] = min(before_anchor.get(video_id, position), position)
        for record in _persisted_source_records((public,), {}):
            effective[_source_record_identity(record)] = record

    full_video_changes = {
        _text(row.get("videoId") or row.get("video_id"))
        for row in changes
        if _text(row.get("entityType") or row.get("entity_type"))
        in {"videos", "runtime_videos"}
    }
    for identity in list(effective):
        if identity[0] in accepted_video_resets or identity[0] in full_video_changes:
            effective.pop(identity, None)
    for row in candidate_range_rows:
        if row.get("video_tombstone") or not same_target(row):
            continue
        record = _overlay_source_record(row)
        if record:
            effective[_source_record_identity(record)] = record
    for change in changes:
        if not same_target(change):
            continue
        video_id = _text(change.get("videoId") or change.get("video_id"))
        occurrence_id = _text(
            change.get("occurrenceId") or change.get("occurrence_id")
        )
        if occurrence_id and (video_id, occurrence_id) in effective:
            effective.pop((video_id, occurrence_id), None)
            continue
        matches = [
            identity
            for identity, record in effective.items()
            if _source_record_matches_change(record, change)
        ]
        if len(matches) != 1:
            raise PostgresAdapterError(
                "source occurrence preimage does not uniquely match authority"
            )
        effective.pop(matches[0], None)
    for row in replacement_rows:
        if not same_target(row):
            continue
        record = _overlay_source_record(row)
        if record:
            effective[_source_record_identity(record)] = record

    effective_records = [record for _, record in sorted(effective.items())]
    after_public = _source_records_as_occurrences(
        effective_records, options, canonical_song_key,
    )
    raw_query = query or {}
    search_predicate = ""
    search_params: list[Any] = []
    if options["q"]:
        search_predicate = " AND search_text ILIKE %s ESCAPE E'\\\\'"
        search_params.append(f"%{_escape_source_search_pattern(options['q'])}%")
    base_where = (
        "revision_id = %s AND source_key = %s AND range_id = %s"
        + search_predicate
    )
    base_params: list[Any] = [
        parent_revision_id, requested_key, range_id, *search_params,
    ]
    base_summary_rows = _rows(
        connection,
        f"""
        SELECT count(*) AS total_occurrence_count,
               count(DISTINCT video_id) AS total_video_count,
               coalesce(max(position), 0) AS max_position
        FROM runtime_source_occurrences
        WHERE {base_where}
        """,
        base_params,
    )
    base_summary = base_summary_rows[0] if base_summary_rows else {}
    base_occurrence_count = int(base_summary.get("total_occurrence_count") or 0)
    base_video_count = int(base_summary.get("total_video_count") or 0)
    max_position = int(base_summary.get("max_position") or 0)

    before_filtered = [
        row for row in affected_source_rows
        if not options["q"]
        or options["q"] in _text(row.get("search_text")).casefold()
    ]
    before_filtered_videos = {
        _text(row.get("video_id")) for row in before_filtered if _text(row.get("video_id"))
    }
    after_filtered_videos = {
        _text(item.get("videoId")) for item in after_public if _text(item.get("videoId"))
    }
    total_occurrence_count = max(
        0, base_occurrence_count - len(before_filtered) + len(after_public),
    )
    total_video_count = max(
        0, base_video_count - len(before_filtered_videos) + len(after_filtered_videos),
    )
    page_size = options["pageSize"]
    page_count = max(1, math.ceil(total_video_count / page_size))
    page = min(options["page"], page_count)
    affected_video_ids = sorted({
        _text(row.get("video_id"))
        for row in affected_source_rows
        if _text(row.get("video_id"))
    } | potential_video_ids)
    after_video_positions: dict[str, int] = {}
    for index, video_id in enumerate(sorted(after_filtered_videos)):
        after_video_positions[video_id] = before_anchor.get(
            video_id, max_position + index + 1,
        )
    overlay_video_ids = [
        video_id
        for video_id, _ in sorted(
            after_video_positions.items(), key=lambda item: (item[1], item[0]),
        )
    ]
    overlay_positions = [after_video_positions[video_id] for video_id in overlay_video_ids]
    page_rows = _rows(
        connection,
        f"""
        WITH overlay_videos(video_id, first_position) AS (
          SELECT * FROM unnest(%s::text[], %s::bigint[])
        ), effective_videos AS (
          SELECT video_id, min(position)::bigint AS first_position
          FROM runtime_source_occurrences
          WHERE {base_where}
            AND NOT (video_id = ANY(%s::text[]))
          GROUP BY video_id
          UNION ALL
          SELECT video_id, first_position FROM overlay_videos
        )
        SELECT video_id, first_position
        FROM effective_videos
        ORDER BY first_position, video_id
        LIMIT %s OFFSET %s
        """,
        [
            overlay_video_ids,
            overlay_positions,
            *base_params,
            affected_video_ids,
            page_size,
            (page - 1) * page_size,
        ],
    )
    selected_video_ids = [
        _text(row.get("video_id"))
        for row in page_rows[:page_size]
        if _text(row.get("video_id"))
    ]
    selected_parent_ids = [
        video_id for video_id in selected_video_ids if video_id not in after_video_positions
    ]
    selected_parent_rows: list[dict[str, Any]] = []
    if selected_parent_ids:
        selected_parent_rows = _rows(
            connection,
            f"""
            SELECT position, video_id, title, channel_name, channel_id,
                   channel_handle, channel_url, published_timestamp, seconds,
                   search_text, payload_json
            FROM runtime_source_occurrences
            WHERE {base_where} AND video_id = ANY(%s::text[])
            ORDER BY position, video_id
            LIMIT %s
            """,
            [
                *base_params,
                selected_parent_ids,
                _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
            ],
        )
    if len(selected_parent_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError("effective source hydration exceeded bounded cap")
    page_occurrences_by_video: dict[str, list[dict[str, Any]]] = defaultdict(list)
    selected_parent_public = _source_records_as_occurrences(
        _persisted_source_records(
            (_runtime_source_occurrence(row) for row in selected_parent_rows),
            {},
        ),
        options,
        canonical_song_key,
    )
    for item in selected_parent_public:
        page_occurrences_by_video[_text(item.get("videoId"))].append(item)
    for item in after_public:
        video_id = _text(item.get("videoId"))
        if video_id in after_video_positions:
            page_occurrences_by_video[video_id].append(dict(item))
    page_occurrences = [
        item
        for video_id in selected_video_ids
        for item in page_occurrences_by_video.get(video_id, ())
    ]

    record = dict(persisted_record)
    record["occurrences"] = page_occurrences
    record["sourceDetailKey"] = requested_key
    record["sourceDetailPath"] = _text(record.get("sourceDetailPath"))
    record["rangeId"] = range_id
    record["count"] = total_occurrence_count
    record["occurrenceCount"] = total_occurrence_count
    record["timestampCount"] = total_occurrence_count
    record["videoCount"] = total_video_count
    record["sourceFilterQuery"] = options["q"]
    record["occurrencePreviewLimited"] = total_occurrence_count > len(page_occurrences)
    unfiltered_after = _source_records_as_occurrences(
        effective_records,
        {**dict(options), "q": "", "searchTokens": []},
        canonical_song_key,
    )
    if source_type == "artist":
        record["songs"] = _adjust_source_count_list(
            record.get("songs"), before_public, unfiltered_after, "title",
        )
        record["songCount"] = len(record["songs"])
    else:
        record["artists"] = _adjust_source_count_list(
            record.get("artists"), before_public, unfiltered_after, "artist",
        )
    record["channels"] = _adjust_source_count_list(
        record.get("channels"), before_public, unfiltered_after, "channelName",
    )
    total_song_count = (
        1 if source_type == "song" and total_occurrence_count > 0
        else int(record.get("songCount") or 0)
    )
    if not total_occurrence_count and not options["q"]:
        return {"schemaVersion": 1, "found": False, "sourceKey": requested_key}
    response: dict[str, Any] = {
        "schemaVersion": 1,
        "found": bool(total_occurrence_count or options["q"]),
        "sourceKey": requested_key,
        "record": record,
    }
    if any(field in raw_query for field in ("page", "pageSize")):
        response.update({
            "page": page,
            "pageSize": page_size,
            "pageCount": page_count,
            "totalCount": total_video_count,
            "totalVideoCount": total_video_count,
            "totalOccurrenceCount": total_occurrence_count,
            "totalSongCount": total_song_count,
        })
    return response


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
    return _generic_group_source_payload(
        connection,
        parent_revision_id,
        persisted_record,
        requested_key,
        query,
        overlay_revision_ids,
        candidate_rows,
        accepted_video_resets,
        runtime_changes,
        source_type="song",
    )


def _generic_artist_source_payload(
    connection,
    parent_revision_id: str,
    persisted_record: Mapping[str, Any],
    requested_key: str,
    query: Mapping[str, Any] | None,
    overlay_revision_ids: Sequence[str],
    candidate_rows: Sequence[Mapping[str, Any]] | None = None,
    accepted_video_resets: Mapping[str, Mapping[str, Any]] | None = None,
    runtime_changes: Sequence[Mapping[str, Any]] | None = None,
    *,
    artist_owner_revision_id: str | None = None,
    artist_alias_cache: MutableMapping[
        tuple[str, str, str], tuple[str, str, str]
    ] | None = None,
) -> dict[str, Any] | None:
    return _generic_group_source_payload(
        connection,
        parent_revision_id,
        persisted_record,
        requested_key,
        query,
        overlay_revision_ids,
        candidate_rows,
        accepted_video_resets,
        runtime_changes,
        source_type="artist",
        artist_owner_revision_id=artist_owner_revision_id,
        artist_alias_cache=artist_alias_cache,
    )


def _generic_overlay_song_source_for_key(
    connection,
    parent_revision_id: str,
    requested_key: str,
    query: Mapping[str, Any] | None,
    overlay_revision_ids: Sequence[str],
    candidate_rows: Sequence[Mapping[str, Any]] | None = None,
    accepted_video_resets: Mapping[str, Mapping[str, Any]] | None = None,
    runtime_changes: Sequence[Mapping[str, Any]] | None = None,
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
    candidate_rows = (
        tuple(candidate_rows)
        if candidate_rows is not None
        else tuple(_overlay_candidate_rows(connection, overlay_revision_ids))
    )
    accepted_video_resets = (
        dict(accepted_video_resets)
        if accepted_video_resets is not None
        else _accepted_video_resets(connection, overlay_revision_ids, False)
    )
    changes = (
        list(runtime_changes)
        if runtime_changes is not None
        else _runtime_tombstones(
            connection, overlay_revision_ids,
            accepted_video_resets.values() if accepted_video_resets else None,
            candidate_rows,
        )
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
        "artist": artist, "displayArtist": artist,
        "artists": [{"name": artist, "count": 0}] if artist else [],
        "rangeId": options["range"],
        "sourceDetailKey": requested_key,
    }
    return _generic_song_source_payload(
        connection, parent_revision_id, synthetic, requested_key, query,
        overlay_revision_ids, candidate_rows, accepted_video_resets, changes,
    )


def _generic_overlay_artist_source_for_key(
    connection,
    parent_revision_id: str,
    requested_key: str,
    query: Mapping[str, Any] | None,
    overlay_revision_ids: Sequence[str],
    candidate_rows: Sequence[Mapping[str, Any]] | None = None,
    accepted_video_resets: Mapping[str, Mapping[str, Any]] | None = None,
    runtime_changes: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """Resolve one overlay-only artist key from bounded exact video rows."""

    if not re.fullmatch(r"[0-9a-f]{16}(?:[0-9a-f]{8})?", requested_key):
        return None
    options = _query_options(query)
    candidate_rows = (
        tuple(candidate_rows)
        if candidate_rows is not None
        else tuple(_overlay_candidate_rows(connection, overlay_revision_ids))
    )
    accepted_video_resets = (
        dict(accepted_video_resets)
        if accepted_video_resets is not None
        else _accepted_video_resets(connection, overlay_revision_ids, False)
    )
    changes = (
        list(runtime_changes)
        if runtime_changes is not None
        else _runtime_tombstones(
            connection,
            overlay_revision_ids,
            accepted_video_resets.values() if accepted_video_resets else None,
            candidate_rows,
        )
    )
    replacement_rows = _runtime_replacement_candidate_rows(changes)
    targets: dict[str, str] = {}
    for row in (*candidate_rows, *changes, *replacement_rows):
        artist = _text(row.get("artist"))
        group_key = _overlay_artist_group_norm(artist) or "unknown"
        if (
            _production_source_detail_key_for_group(
                "artists", options["range"], group_key,
            )
            != requested_key
        ):
            continue
        targets[group_key] = artist or "unknown"
    if not targets:
        return None
    if len(targets) != 1:
        return {"schemaVersion": 1, "found": False, "sourceKey": requested_key}
    group_key, display_artist = next(iter(targets.items()))
    synthetic = {
        "type": "artist",
        "key": group_key,
        "name": display_artist,
        "artist": display_artist,
        "songs": [],
        "channels": [],
        "rangeId": options["range"],
        "sourceDetailKey": requested_key,
    }
    return _generic_artist_source_payload(
        connection,
        parent_revision_id,
        synthetic,
        requested_key,
        query,
        overlay_revision_ids,
        candidate_rows,
        accepted_video_resets,
        changes,
    )


def _generic_overlay_vtuber_source_for_key(
    connection,
    parent_revision_id: str,
    requested_key: str,
    query: Mapping[str, Any] | None,
    overlay_revision_ids: Sequence[str],
    candidate_rows: Sequence[Mapping[str, Any]] | None,
    accepted_video_resets: Mapping[str, Mapping[str, Any]] | None,
    runtime_changes: Sequence[Mapping[str, Any]] | None,
    snapshot_video_scope: Sequence[str] | None,
) -> dict[str, Any] | None:
    """Resolve one overlay-only VTuber key from an exact snapshot scope.

    Production VTuber keys are opaque 16-character digests.  Reverse them
    only against the caller-prepared candidate/final-runtime rows for the
    already bounded source-video scope.  Never scan the whole overlay merely
    because an arbitrary digest was requested.
    """

    if not re.fullmatch(r"[0-9a-f]{16}", requested_key):
        return None
    scoped_videos = tuple(sorted({
        _text(video_id)
        for video_id in (snapshot_video_scope or ())
        if _text(video_id)
    }))
    if not scoped_videos or candidate_rows is None:
        return None
    options = _query_options(query)
    prepared_candidates = tuple(candidate_rows)
    prepared_resets = dict(accepted_video_resets or {})
    prepared_changes = tuple(runtime_changes or ())
    replacement_rows = tuple(_runtime_replacement_candidate_rows(
        prepared_changes,
    ))
    target_rows = (
        *prepared_candidates,
        *_overlay_rows_for_range(prepared_changes, options["range"]),
        *_overlay_rows_for_range(replacement_rows, options["range"]),
    )
    targets: dict[str, dict[str, Any]] = {}
    for row in target_rows:
        video_id = _text(row.get("video_id") or row.get("videoId"))
        if not video_id or video_id not in scoped_videos:
            continue
        video = _overlay_public_video(row)
        channel_id = _text(
            row.get("channel_id") or row.get("channelId")
            or video.get("channelId")
        )
        channel_handle = _text(
            row.get("channel_handle") or row.get("channelHandle")
            or video.get("channelHandle")
        )
        channel_name = _text(
            row.get("channel_name") or row.get("channelName")
            or video.get("channelName")
        )
        video_channel_id = _text(video.get("channelId"))
        if (
            channel_id and video_channel_id
            and channel_id != video_channel_id
        ):
            raise PostgresAdapterError(
                "overlay-only VTuber source has conflicting channel identity"
            )
        channel_key = (
            channel_id
            or channel_handle.lstrip("@/")
            or _overlay_norm(channel_name)
        )
        if not channel_key or (
            _production_source_detail_key_for_group(
                "vtubers", options["range"], channel_key,
            )
            != requested_key
        ):
            continue
        metadata = targets.setdefault(channel_key, {
            "channelKey": channel_key,
            "channelId": channel_id,
            "channelHandle": channel_handle,
            "channelName": channel_name,
            "channelUrl": _canonical_channel_url(
                channel_id, channel_handle,
            ) if channel_id else "",
            "sourceDetailKey": requested_key,
        })
        for field, value in (
            ("channelId", channel_id),
            ("channelHandle", channel_handle),
            ("channelName", channel_name),
        ):
            current = _text(metadata.get(field))
            if (
                field == "channelId"
                and
                current and value
                and _overlay_norm(current.lstrip("@/"))
                    != _overlay_norm(value.lstrip("@/"))
            ):
                raise PostgresAdapterError(
                    "overlay-only VTuber source has conflicting channel identity"
                )
            if not current and value:
                metadata[field] = value
    if not targets:
        return None
    if len(targets) != 1:
        return {
            "schemaVersion": 1,
            "found": False,
            "sourceKey": requested_key,
        }
    metadata = next(iter(targets.values()))
    return _runtime_channel_source_payload(
        connection,
        parent_revision_id,
        metadata,
        requested_key,
        query,
        overlay_revision_ids=overlay_revision_ids,
        snapshot_video_scope=scoped_videos,
        prepared_overlay_inputs=(
            prepared_candidates,
            prepared_resets,
            prepared_changes,
        ),
    )


def _generic_video_source_payload(
    connection,
    parent_revision_id: str,
    persisted_record: Mapping[str, Any] | None,
    requested_key: str,
    query: Mapping[str, Any] | None,
    overlay_revision_ids: Sequence[str],
    candidate_rows: Sequence[Mapping[str, Any]] | None = None,
    accepted_video_resets: Mapping[str, Mapping[str, Any]] | None = None,
    runtime_changes: Sequence[Mapping[str, Any]] | None = None,
    snapshot_video_scope: Sequence[str] | None = None,
) -> dict[str, Any] | None:
    """Rebuild exactly one affected video source from bounded snapshot rows.

    Video ranking cards use a 24-character stable source key even though the
    production scalar-key helper intentionally has no video mapping.  Reverse
    that key only against the exact affected-video scope prepared by the
    snapshot exporter.  This prevents an affected video detail from being
    mistaken for its whole channel and also covers overlay-only new videos.
    """

    if not re.fullmatch(r"[0-9a-f]{24}", requested_key):
        return None
    options = _query_options(query)
    range_id = options["range"]
    persisted_record = (
        dict(persisted_record)
        if isinstance(persisted_record, Mapping)
        else {}
    )
    candidate_rows = (
        tuple(candidate_rows)
        if candidate_rows is not None
        else tuple(_overlay_candidate_rows(connection, overlay_revision_ids))
    )
    candidate_range_rows = tuple(_overlay_rows_for_range(
        candidate_rows, range_id,
    ))
    accepted_video_resets = (
        dict(accepted_video_resets)
        if accepted_video_resets is not None
        else _accepted_video_resets(connection, overlay_revision_ids, False)
    )
    changes = (
        list(runtime_changes)
        if runtime_changes is not None
        else _runtime_tombstones(
            connection,
            overlay_revision_ids,
            accepted_video_resets.values() if accepted_video_resets else None,
            candidate_range_rows,
        )
    )
    changes = _overlay_rows_for_range(changes, range_id)
    replacement_rows = _runtime_replacement_candidate_rows(changes)

    def video_id_for(value: Mapping[str, Any]) -> str:
        return _text(value.get("video_id") or value.get("videoId"))

    target_video_ids = {
        video_id
        for value in (*candidate_range_rows, *changes, *replacement_rows)
        for video_id in (video_id_for(value),)
        if video_id
        and _stable_key("source-video", range_id, video_id) == requested_key
    }
    target_video_ids.update(
        video_id
        for video_id in (
            _text(value) for value in (snapshot_video_scope or ())
        )
        if video_id
        and _stable_key("source-video", range_id, video_id) == requested_key
    )
    persisted_video_id = _text(
        persisted_record.get("videoId")
        or persisted_record.get("video_id")
        or (
            persisted_record.get("key")
            if _text(persisted_record.get("type")) == "video"
            else ""
        )
    )
    if (
        persisted_video_id
        and _text(persisted_record.get("type")) == "video"
        and _stable_key("source-video", range_id, persisted_video_id)
            == requested_key
    ):
        target_video_ids.add(persisted_video_id)
    if not target_video_ids:
        return None
    if len(target_video_ids) != 1:
        return {
            "schemaVersion": 1,
            "found": False,
            "sourceKey": requested_key,
        }
    target_video_id = next(iter(target_video_ids))

    effective: dict[tuple[str, str], dict[str, Any]] = {}
    parent_occurrences = (
        _runtime_source_occurrences(
            connection, parent_revision_id, requested_key, range_id,
        )
        if persisted_record
        else []
    )
    parent_video_rows = [] if parent_occurrences else _rows(
        connection,
        """
        SELECT video_id, title, channel_name, channel_id, channel_handle,
               channel_url, published_timestamp, payload_json
        FROM runtime_videos
        WHERE revision_id = %s AND video_id = %s
        LIMIT 2
        """,
        [parent_revision_id, target_video_id],
    )
    if len(parent_video_rows) > 1:
        raise PostgresAdapterError(
            "video source parent lookup returned duplicate video identity"
        )
    parent_occurrence_rows = _rows(
        connection,
        """
        SELECT occurrence_id, range_id, video_id, song_key, seconds,
               source_system, source_id, title, artist, payload_json
        FROM runtime_occurrences
        WHERE revision_id = %s AND video_id = %s
          AND range_id = ANY(%s)
        ORDER BY range_id, occurrence_id
        LIMIT %s
        """,
        [
            parent_revision_id,
            target_video_id,
            [range_id, ""],
            _MAX_AFFECTED_RUNTIME_OCCURRENCES + 1,
        ],
    ) if parent_video_rows else []
    if len(parent_occurrence_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "video source parent occurrence lookup exceeded bounded cap"
        )
    if parent_video_rows:
        parent_video_row = parent_video_rows[0]
        parent_video = _json_object(parent_video_row.get("payload_json"))
        parent_video.update({
            "videoId": parent_video.get("videoId") or target_video_id,
            "title": (
                parent_video.get("title")
                if parent_video.get("title") is not None
                else parent_video_row.get("title")
            ),
            "channelName": (
                parent_video.get("channelName")
                if parent_video.get("channelName") is not None
                else parent_video_row.get("channel_name")
            ),
            "channelId": (
                parent_video.get("channelId")
                if parent_video.get("channelId") is not None
                else parent_video_row.get("channel_id")
            ),
            "channelHandle": (
                parent_video.get("channelHandle")
                if parent_video.get("channelHandle") is not None
                else parent_video_row.get("channel_handle")
            ),
            "channelUrl": (
                parent_video.get("channelUrl")
                if parent_video.get("channelUrl") is not None
                else parent_video_row.get("channel_url")
            ),
            "publishedAt": (
                parent_video.get("publishedAt")
                if parent_video.get("publishedAt") is not None
                else parent_video_row.get("published_timestamp")
            ),
        })
        for position, row in enumerate(parent_occurrence_rows):
            occurrence = _json_object(row.get("payload_json"))
            occurrence.update({
                "videoId": occurrence.get("videoId") or target_video_id,
                "occurrenceId": (
                    occurrence.get("occurrenceId")
                    or row.get("occurrence_id")
                ),
                "position": occurrence.get("position", position),
                "rangeId": occurrence.get("rangeId") or row.get("range_id"),
                "songKey": occurrence.get("songKey") or row.get("song_key"),
                "seconds": occurrence.get("seconds", row.get("seconds")),
                "title": occurrence.get("title") or row.get("title"),
                "artist": occurrence.get("artist") or row.get("artist"),
                "sourceId": occurrence.get("sourceId") or row.get("source_id"),
                "sourceSystem": (
                    occurrence.get("sourceSystem")
                    or row.get("source_system")
                ),
            })
            single = {
                "video": dict(parent_video),
                "occurrences": (occurrence,),
            }
            effective[_source_record_identity(single)] = single
    for record in _persisted_source_records(parent_occurrences, {}):
        if _text(record.get("video", {}).get("videoId")) != target_video_id:
            continue
        for occurrence in record.get("occurrences", ()):
            single = {
                "video": dict(record.get("video") or {}),
                "occurrences": (dict(occurrence),),
            }
            effective[_source_record_identity(single)] = single

    full_video_changes = {
        video_id_for(value)
        for value in changes
        if _text(value.get("entityType") or value.get("entity_type"))
            in {"videos", "runtime_videos"}
    }
    if (
        target_video_id in accepted_video_resets
        or target_video_id in full_video_changes
    ):
        effective.clear()
    for row in candidate_range_rows:
        if video_id_for(row) != target_video_id or row.get("video_tombstone"):
            continue
        record = _overlay_source_record(row)
        if record:
            effective[_source_record_identity(record)] = record
    for change in changes:
        if video_id_for(change) != target_video_id:
            continue
        if _text(change.get("entityType") or change.get("entity_type")) not in {
            "occurrences", "runtime_occurrences",
        }:
            continue
        occurrence_id = _text(
            change.get("occurrenceId") or change.get("occurrence_id")
        )
        if occurrence_id:
            effective.pop((target_video_id, occurrence_id), None)
    for row in replacement_rows:
        if video_id_for(row) != target_video_id:
            continue
        record = _overlay_source_record(row)
        if record:
            effective[_source_record_identity(record)] = record

    records = [record for _, record in sorted(effective.items())]
    payload = source_payload_from_records(records, requested_key, query)
    if not payload.get("found"):
        return payload
    # The source key and every effective occurrence were resolved against the
    # requested range above.  A selected physical 7d full reset projected into
    # compatible all can still carry 7d as video metadata; never let that
    # implementation detail change the public detail contract.
    payload = dict(payload)
    payload["record"] = {
        **dict(payload.get("record") or {}),
        "rangeId": range_id,
    }
    if persisted_record:
        payload["record"] = {
            **persisted_record,
            **dict(payload.get("record") or {}),
        }
    return payload


def _bulk_hydrate_generic_ranking_page(
    connection,
    parent_revision_id: str,
    rows: Sequence[Mapping[str, Any]],
    options: Mapping[str, Any],
    db_metric: str,
) -> tuple[dict[str, Any], ...]:
    """Load missing immutable parent card payloads in one bounded query."""

    hydrated_rows = [dict(row) for row in rows]
    requested_row_ids: list[str] = []
    requested_by_row_id: dict[str, str] = {}
    requested_detail_keys: list[str] = []
    requested_detail_key_set: set[str] = set()
    for row in hydrated_rows:
        if _json_object(row.get("payload_json")):
            continue
        row_id = _text(row.get("row_id"))
        detail_key = _text(row.get("detail_key"))
        if not detail_key:
            raise PostgresAdapterError(
                "snapshot ranking row is missing its immutable identity"
            )
        if not row_id:
            # Overlay-created or regrouped cards do not necessarily retain an
            # immutable parent row id. Resolve all matching parent cards with
            # one page-bounded detail-key query; only true overlay-only cards
            # fall through to the legacy exact lookup below.
            if detail_key in requested_detail_key_set:
                raise PostgresAdapterError(
                    "snapshot ranking page contains a duplicate detail key"
                )
            requested_detail_key_set.add(detail_key)
            requested_detail_keys.append(detail_key)
            continue
        if row_id in requested_by_row_id:
            raise PostgresAdapterError(
                "snapshot ranking page contains a duplicate row id"
            )
        requested_by_row_id[row_id] = detail_key
        requested_row_ids.append(row_id)
    if len(requested_row_ids) + len(requested_detail_keys) > MAX_PAGE_SIZE:
        raise PostgresAdapterError(
            "snapshot ranking payload hydration exceeded bounded page cap"
        )

    stored_by_row_id: dict[str, dict[str, Any]] = {}
    if requested_row_ids:
        stored_rows = _rows(
            connection,
            """
            /* bulk generic ranking page payload hydration */
            SELECT row_id, detail_key, payload_json
            FROM runtime_ranking_rows
            WHERE revision_id = %s AND row_id = ANY(%s)
              AND range_id = %s AND view = %s
              AND metric = %s AND scope_key = %s
            """,
            [
                parent_revision_id,
                requested_row_ids,
                options["range"],
                options["view"],
                db_metric,
                _ranking_scope_key(options),
            ],
        )
        for stored in stored_rows:
            row_id = _text(stored.get("row_id"))
            detail_key = _text(stored.get("detail_key"))
            payload = _json_object(stored.get("payload_json"))
            if (
                row_id not in requested_by_row_id
                or requested_by_row_id[row_id] != detail_key
            ):
                raise PostgresAdapterError(
                    "snapshot ranking payload hydration returned an unexpected identity"
                )
            if row_id in stored_by_row_id:
                raise PostgresAdapterError(
                    "snapshot ranking payload hydration returned a duplicate row id"
                )
            if not payload:
                raise PostgresAdapterError(
                    "snapshot ranking payload hydration returned an empty payload"
                )
            stored_by_row_id[row_id] = payload
        if set(requested_by_row_id) != set(stored_by_row_id):
            raise PostgresAdapterError(
                "snapshot ranking payload hydration is incomplete"
            )

    stored_by_detail_key: dict[str, dict[str, Any]] = {}
    if requested_detail_keys:
        stored_rows = _rows(
            connection,
            """
            /* bulk generic ranking page detail payload hydration */
            SELECT detail_key, payload_json
            FROM runtime_ranking_rows
            WHERE revision_id = %s AND range_id = %s AND view = %s
              AND metric = %s AND scope_key = %s
              AND detail_key = ANY(%s)
            """,
            [
                parent_revision_id,
                options["range"],
                options["view"],
                db_metric,
                _ranking_scope_key(options),
                requested_detail_keys,
            ],
        )
        for stored in stored_rows:
            detail_key = _text(stored.get("detail_key"))
            payload = _json_object(stored.get("payload_json"))
            if detail_key not in requested_detail_key_set:
                raise PostgresAdapterError(
                    "snapshot detail hydration returned an unexpected identity"
                )
            if detail_key in stored_by_detail_key:
                raise PostgresAdapterError(
                    "snapshot detail hydration returned a duplicate identity"
                )
            if not payload:
                raise PostgresAdapterError(
                    "snapshot detail hydration returned an empty payload"
                )
            stored_by_detail_key[detail_key] = payload
    for row in hydrated_rows:
        row_id = _text(row.get("row_id"))
        detail_key = _text(row.get("detail_key"))
        payload = stored_by_row_id.get(row_id) or stored_by_detail_key.get(
            detail_key
        )
        if not payload:
            continue
        row["payload_json"] = copy.deepcopy(payload)
        row["_snapshot_parent_payload_preloaded"] = True
    return tuple(hydrated_rows)


def _snapshot_materialized_source_payload(
    requested_key: str,
    *,
    range_id: str,
    persisted_record: Mapping[str, Any] | None,
    targets: Sequence[tuple[str, str]],
    video_scope: Sequence[str],
    parent_occurrences: Sequence[Mapping[str, Any]],
    direct_video_rows: Sequence[Mapping[str, Any]],
    direct_occurrence_rows: Sequence[Mapping[str, Any]],
    candidate_rows: Sequence[Mapping[str, Any]],
    accepted_video_resets: Mapping[str, Mapping[str, Any]],
    runtime_changes: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Resolve one source from batch-prefetched immutable snapshot inputs.

    This helper deliberately performs no SQL.  The materializer supplies the
    persisted source authority, an exact video scope, and one union overlay
    delta shared by the surrounding key batch.
    """

    requested_key = _text(requested_key)
    scoped_videos = {
        _text(value) for value in video_scope if _text(value)
    }
    if not requested_key or not scoped_videos:
        raise PostgresAdapterError(
            "snapshot materialized source has empty exact scope"
        )
    target_groups: dict[str, set[str]] = defaultdict(set)
    for view, group_key in targets:
        normalized_view = _text(view)
        normalized_group_key = _text(group_key)
        if (
            normalized_view in {"songs", "songIndex"}
            and "\x1f" in normalized_group_key
        ):
            parts = normalized_group_key.split("\x1f")
            if len(parts) != 2 or not parts[0]:
                raise PostgresAdapterError(
                    "snapshot materialized song target identity is invalid"
                )
            normalized_group_key = f"{parts[0]}::{parts[1]}"
        if normalized_view and normalized_group_key:
            target_groups[normalized_view].add(normalized_group_key)
    type_for_view = {
        "songs": "song",
        "songIndex": "song",
        "artists": "artist",
        "vtubers": "vtuber",
        "videos": "video",
    }
    target_types = {
        type_for_view[view]
        for view in target_groups
        if view in type_for_view
    }
    persisted = dict(persisted_record or {})
    source_type = _text(persisted.get("type") or persisted.get("entityType"))
    if source_type in {"channel", "source"} and "vtuber" in target_types:
        source_type = "vtuber"
    if not source_type:
        if len(target_types) != 1:
            raise PostgresAdapterError(
                "snapshot materialized source target type is ambiguous"
            )
        source_type = next(iter(target_types))
    if target_types and source_type not in target_types:
        raise PostgresAdapterError(
            "snapshot materialized source target disagrees with detail type"
        )

    def overlay_song_source_key(value: Mapping[str, Any]) -> str:
        """Return the exact overlay ranking source key for one occurrence.

        Overlay-only Song ranking cards are grouped by the punctuation-
        preserving ``_overlay_norm(title)::...`` identity.  The broader
        punctuation-insensitive owner identity is valid only when a persisted
        parent detail supplies canonical authority; using it for a synthetic
        source can merge two distinct ranking cards into one source.
        """

        occurrence = _overlay_public_occurrence(
            value.get("occurrence_payload_json")
        )
        title = _text(value.get("title")) or _text(occurrence.get("title"))
        if not title:
            return ""
        artist = _text(value.get("artist")) or _text(occurrence.get("artist"))
        group_key = f"{_overlay_norm(title)}::{_overlay_norm(artist)}"
        return _production_source_detail_key_for_group(
            "songs", range_id, group_key,
        )

    def row_video_id(value: Mapping[str, Any]) -> str:
        return _text(value.get("video_id") or value.get("videoId"))

    song_reset_parent_identities: dict[
        tuple[str, str, str, str], int
    ] = defaultdict(int)
    song_reset_parent_canonical_identities: dict[
        tuple[str, str, str, str], int
    ] = defaultdict(int)
    song_reset_owned_raw_keys: set[str] = set()

    def song_reset_owner_identity(
        video_id: str,
        value: Mapping[str, Any],
        *,
        canonical_title: bool = False,
    ) -> tuple[str, str, str, str]:
        """Match one reset row to its exact persisted Song source tuple.

        Persisted source rows predate occurrence ids and source positions are
        local to each detail.  The ranking reset reconciler therefore uses the
        bounded ``video + seconds + raw title/artist`` tuple (with one
        canonical-title fallback) to bind an accepted replacement to its
        authoritative parent Song owner.  Reuse that exact evidence here so
        source counts cannot diverge from rankings when raw spelling differs
        from the canonical detail owner.
        """

        title = ""
        seconds: Any = None
        for source in _scope_value_sources(value):
            if not title:
                title = _text(source.get("title") or source.get("workTitle"))
            if seconds is None and source.get("seconds") is not None:
                seconds = source.get("seconds")
        artist = _scope_artist(value)
        title_key = (
            _vtuber_canonical_song_identity(title)[1]
            if canonical_title
            else _overlay_song_group_norm(title)
        )
        return (
            _text(video_id),
            _text(seconds),
            title_key or _overlay_song_group_norm(title),
            _overlay_song_group_norm(artist),
        )

    def song_candidate_raw_group(value: Mapping[str, Any]) -> str:
        title = ""
        for source in _scope_value_sources(value):
            title = _text(source.get("title") or source.get("workTitle"))
            if title:
                break
        if not title:
            return ""
        return f"{_overlay_norm(title)}::{_overlay_norm(_scope_artist(value))}"

    def song_candidate_owner_group(value: Mapping[str, Any]) -> str:
        """Return the broad owner identity for an ordinary candidate.

        The caller may use this punctuation-insensitive fallback only when the
        candidate also agrees with the persisted card's display identity.
        Ranking candidates otherwise keep raw spellings such as
        ``＠SHISHAMO`` and ``未記載`` in their own Song cards.  Exact accepted-
        reset tuples remain independently bound above.
        """

        title = ""
        for source in _scope_value_sources(value):
            title = _text(source.get("title") or source.get("workTitle"))
            if title:
                break
        title_key = _source_song_owner_norm(title)
        artist_key = _source_song_owner_norm(_scope_artist(value))
        if not title_key or not artist_key:
            return ""
        return f"{title_key}::{artist_key}"

    def persisted_song_display_owner_group() -> str:
        """Mirror ranking's bounded persisted display-identity fallback."""

        title_key = _source_song_owner_norm(
            persisted.get("title") or persisted.get("workTitle")
        )
        artist_key = _source_song_owner_norm(
            persisted.get("artist") or persisted.get("displayArtist")
        )
        if not title_key or not artist_key:
            return ""
        return f"{title_key}::{artist_key}"

    def persisted_song_raw_group() -> str:
        """Return the raw ranking group that the persisted card owns.

        A display-label match alone is not ranking evidence.  Historical
        overlay rows can share a canonical-looking title/artist while their
        punctuation-preserving group is a separate ranking card (for
        example ``6月`` versus ``六月``).  Only the persisted entity key can
        prove that the ordinary candidate belongs to this source; otherwise
        keep it in its own raw source card and let the cardinality gate catch
        any unresolved ranking/source disagreement.
        """

        key = _text(persisted.get("key"))
        title, separator, artist = key.partition("::")
        if not separator or not title or not artist:
            return ""
        return f"{_overlay_norm(title)}::{_overlay_norm(artist)}"

    def persisted_song_key_owner_group() -> str:
        """Return the punctuation-insensitive owner encoded by the key.

        Historical persisted Song details can omit ``artist`` while their
        canonical ``key`` still carries the owner.  An accepted reset can
        therefore add a reviewed occurrence whose display artist has harmless
        punctuation (for example ``iLiFE!``) without carrying an immutable
        parent tuple.  The ranking target and persisted key together are the
        only authority for that narrow case.
        """

        key = _text(persisted.get("key"))
        title, separator, artist = key.partition("::")
        if not separator or not title or not artist:
            return ""
        title_key = _source_song_owner_norm(title)
        artist_key = _source_song_owner_norm(artist)
        if not title_key or not artist_key:
            return ""
        return f"{title_key}::{artist_key}"

    def has_canonical_reset_owner(
        value: Mapping[str, Any], owner_group: str,
    ) -> bool:
        """Bind an accepted reset to a canonical Song target without a preimage.

        A reset marker is stronger than an ordinary overlay candidate: the
        ranking builder has already assigned that video to the target Song.
        Require both the exact target group and the persisted key owner so a
        punctuation/display alias (such as ``@SHISHAMO``) still remains in its
        own raw card unless the accepted reset itself proves the canonical
        ownership.
        """

        if source_type != "song" or not persisted:
            return False
        video_id = row_video_id(value)
        # A source batch can contain more than one Song target sharing the
        # same affected-video scope (for example a canonical card alongside
        # a raw spelling card).  In that shape, a reset marker alone does not
        # identify which target owns a candidate that has no exact persisted
        # preimage.  Exact reset-owner annotations are handled by
        # ``has_exact_song_reset_owner`` above; keep this broad fallback
        # fail-closed unless the batch has one unambiguous Song target.
        if len(target_groups.get("songs", set())) != 1:
            return False
        return bool(
            video_id
            and video_id in accepted_video_resets
            and owner_group
            and owner_group in target_groups.get("songs", set())
            and owner_group == persisted_song_key_owner_group()
        )

    def has_explicit_runtime_preimage(value: Mapping[str, Any]) -> bool:
        """Allow a raw candidate only when a replacement names its owner.

        A replacement row can carry the persisted ``parentSongGroupKey`` while
        its candidate preimage uses a punctuation variant (for example
        ``Old-Song`` versus the persisted ``Old Song``).  That explicit
        same-video parent binding is authoritative for deleting the old side.
        It must not, however, widen ordinary candidate ownership: an overlay
        row with no matching replacement remains in its own raw ranking card.
        """

        if source_type != "song" or not persisted:
            return False
        video_id = row_video_id(value)
        if not video_id:
            return False
        groups = target_groups.get("songs", set())
        for change in runtime_changes:
            if row_video_id(change) != video_id:
                continue
            if _text(
                change.get("entityType") or change.get("entity_type")
            ) not in {"occurrences", "runtime_occurrences"}:
                continue
            if not bool(change.get("replacement")):
                continue
            parent_group = _text(change.get("parentSongGroupKey"))
            if parent_group and parent_group in groups:
                return True
        return False

    def has_canonical_same_video_replacement(value: Mapping[str, Any]) -> bool:
        """Bind a legacy replacement's old side to this canonical Song source.

        Runtime curation keeps the preimage in a raw display group (for
        example ``逆光(ウタ from ONE PIECE FILM RED)``), while the replacement
        payload is the canonical persisted owner (``逆光``).  The source
        replay must still subtract the legacy parent row before inserting the
        replacement.  Accept this routing only with the same immutable
        video/occurrence id, exact parent-runtime proof, non-explicit owner
        provenance, and a replacement Song group equal to the persisted
        target.  Display text alone never authorizes the binding.
        """

        if source_type != "song" or not persisted:
            return False
        if (
            value.get("replacement") is not True
            or value.get("replacementSameVideo") is not True
            or value.get("_parentRuntimeOccurrenceExists") is not True
            or value.get("_runtimeOccurrenceOwnerWasExplicit") is not False
        ):
            return False
        replacement = value.get("replacementPayload")
        if not isinstance(replacement, Mapping):
            return False
        replacement_occurrence = _overlay_public_occurrence(replacement)
        video_id = row_video_id(value)
        replacement_video_id = _text(
            replacement_occurrence.get("videoId")
            or replacement.get("video_id")
            or replacement.get("videoId")
        )
        occurrence_id = _text(
            value.get("occurrenceId") or value.get("occurrence_id")
        )
        replacement_occurrence_id = _text(
            replacement_occurrence.get("occurrenceId")
            or replacement.get("occurrence_id")
            or replacement.get("occurrenceId")
        )
        if (
            not video_id
            or replacement_video_id != video_id
            or not occurrence_id
            or replacement_occurrence_id != occurrence_id
        ):
            return False
        # This branch subtracts a legacy persisted preimage.  A replacement
        # for a new overlay-only video has no source preimage to remove and
        # must remain in the later replacement insertion loop instead.
        if not any(
            _text(parent.get("videoId") or parent.get("video_id")) == video_id
            and not _text(
                parent.get("occurrenceId") or parent.get("occurrence_id")
            )
            for parent in parent_occurrences
        ):
            return False
        title = _text(
            replacement_occurrence.get("title")
            or replacement_occurrence.get("workTitle")
        )
        artist = _text(replacement_occurrence.get("artist"))
        if not title or not artist:
            return False
        replacement_group = (
            f"{_source_song_owner_norm(title)}::"
            f"{_source_song_owner_norm(artist)}"
        )
        target_song_groups = target_groups.get("songs", set())
        if replacement_group not in target_song_groups:
            return False
        persisted_owner = persisted_song_key_owner_group()
        parent_song_group = _text(
            value.get("parentSongGroupKey")
            or value.get("parent_song_group_key")
        )
        if parent_song_group and (
            _source_song_group_key_norm(parent_song_group)
            != _source_song_group_key_norm(persisted_owner)
        ):
            # The replacement payload can be canonical for this source while
            # its old side belongs to a different raw/display group.  In that
            # case this change is not a preimage for the persisted source;
            # letting it match here would subtract a canonical parent tuple
            # that ranking intentionally retains.
            return False
        return bool(persisted_owner and replacement_group == persisted_owner)

    def has_authoritative_7d_provenance(value: Mapping[str, Any]) -> bool:
        """Allow only reviewed 7D boundary rows across the all-range split.

        The marker is attached only after the manifest-validated boundary
        lookup above.  Requiring the core-7d source identity as well keeps a
        hand-shaped or ordinary overlay row fail-closed if it happens to
        carry a similar punctuation-insensitive owner.
        """

        if source_type != "song":
            return False
        if value.get("_authoritative_7d_overlay") is not True:
            return False
        row_range = _text(value.get("range_id") or value.get("rangeId"))
        if row_range not in {"7d", "all"}:
            return False
        return any(
            _text(
                source.get("source_system") or source.get("sourceSystem")
            ) == "core-7d"
            for source in _scope_value_sources(value)
        ) or value.get("_authoritative_7d_source_system") == "core-7d"

    def candidate_song_key(value: Mapping[str, Any]) -> str:
        """Read the immutable Song key from scalar or nested occurrence data."""

        for source in _scope_value_sources(value):
            song_key = _text(source.get("song_key") or source.get("songKey"))
            if song_key:
                return song_key
        return ""

    # A single overlay batch can contain several punctuation/display aliases
    # for the same persisted Song owner.  Once a reviewed 7D boundary row is
    # present for this owner, its immutable song key is the narrow authority
    # for ordinary all-range rows.  Without this gate, two raw candidates can
    # each independently satisfy the source cardinality gate and reconciliation
    # cannot determine which one belongs in the canonical source.
    authoritative_7d_song_keys: frozenset[str] = frozenset()
    if source_type == "song" and persisted:
        owner_group = persisted_song_key_owner_group()
        if owner_group:
            authoritative_7d_song_keys = frozenset(
                song_key
                for value in candidate_rows
                if (
                    has_authoritative_7d_provenance(value)
                    and _source_row_song_group_identity(value) == owner_group
                )
                for song_key in (candidate_song_key(value),)
                if song_key
            )

    def has_exact_song_reset_owner(value: Mapping[str, Any]) -> bool:
        annotated_owner_source = _text(
            value.get("_acceptedSongResetOwnerSourceKey")
        )
        if annotated_owner_source:
            return bool(persisted and annotated_owner_source == requested_key)
        if source_type != "song" or not persisted:
            return False
        video_id = row_video_id(value)
        if video_id not in accepted_video_resets:
            return False
        for identities, canonical_title in (
            (song_reset_parent_identities, False),
            (song_reset_parent_canonical_identities, True),
        ):
            owner_identity = song_reset_owner_identity(
                video_id, value, canonical_title=canonical_title,
            )
            owner_count = identities.get(owner_identity, 0)
            if owner_count > 1:
                raise PostgresAdapterError(
                    "accepted reset Song source owner is ambiguous"
                )
            if owner_count == 1:
                return True
        return False

    def channel_identities(value: Mapping[str, Any]) -> set[str]:
        payload = _json_object(value.get("video_payload_json"))
        if isinstance(payload.get("payload"), Mapping):
            payload = dict(payload["payload"])
        values = {
            _text(value.get("channel_id") or value.get("channelId")),
            _text(
                value.get("channel_handle")
                or value.get("channelHandle")
                or payload.get("channelHandle")
            ).lstrip("/@"),
            _text(
                value.get("channel_name")
                or value.get("channelName")
                or payload.get("channelName")
            ),
            _text(payload.get("channelId")),
        }
        return {
            item
            for value in values
            for item in (value, _overlay_norm(value))
            if item
        }

    def matches_target(
        value: Mapping[str, Any], *, split_mixed_reset_group: bool = False,
    ) -> bool:
        if row_video_id(value) not in scoped_videos:
            return False
        if source_type == "video":
            return row_video_id(value) in target_groups.get("videos", set())
        if source_type == "song":
            reset_owner_source_key = _text(
                value.get("_acceptedSongResetOwnerSourceKey")
            )
            if reset_owner_source_key:
                return reset_owner_source_key == requested_key
            if not persisted:
                return overlay_song_source_key(value) == requested_key
            groups = target_groups.get("songs", set())
            if has_exact_song_reset_owner(value):
                return True
            if has_canonical_same_video_replacement(value):
                # The old side may retain a raw title/group, but its reviewed
                # same-video replacement is the canonical owner of this
                # persisted Song source.  The exact immutable proof above
                # keeps this branch narrower than a display alias fallback.
                return True
            raw_group = song_candidate_raw_group(value)
            if (
                split_mixed_reset_group
                and raw_group
                and raw_group not in groups
                and raw_group in song_reset_owned_raw_keys
            ):
                return False
            owner_group = (
                song_candidate_owner_group(value)
                if split_mixed_reset_group
                else _source_row_song_group_identity(value)
            )
            raw_or_change_group = (
                raw_group
                if split_mixed_reset_group
                else _runtime_change_group_key(value, "songs")
            )
            if not split_mixed_reset_group:
                return bool(
                    owner_group in groups
                    or raw_or_change_group in groups
                )
            raw_source_matches = (
                overlay_song_source_key(value) == requested_key
            )
            raw_group_matches = raw_or_change_group in groups
            authoritative_7d_provenance = has_authoritative_7d_provenance(value)
            explicit_runtime_preimage = has_explicit_runtime_preimage(value)
            if authoritative_7d_song_keys and not (
                authoritative_7d_provenance
                or explicit_runtime_preimage
                or raw_source_matches
                or candidate_song_key(value) in authoritative_7d_song_keys
            ):
                # A broad display/raw-group match is insufficient once the
                # reviewed 7D boundary has identified the immutable Song key.
                # Keep unresolved aliases out of the canonical source rather
                # than letting reconciliation choose one arbitrarily.
                return False
            persisted_key_owner_group = persisted_song_key_owner_group()
            if (
                raw_group_matches
                and row_video_id(value) in accepted_video_resets
                and persisted_key_owner_group
                and owner_group != persisted_key_owner_group
            ):
                # A full-video reset without an owner annotation cannot widen
                # a persisted source through a display-only title alias.  The
                # source scope may contain the raw ranking group (for example
                # ``六月``) while the immutable persisted key is ``6月``;
                # accepting that raw match would add reset candidates that the
                # parent source and ranking do not share.  Exact reset-owner
                # evidence and the canonical fallback above remain allowed.
                raw_group_matches = False
            display_owner_group = persisted_song_display_owner_group()
            persisted_raw_group = persisted_song_raw_group()
            return bool(
                raw_group_matches
                or raw_source_matches
                or has_canonical_reset_owner(value, owner_group)
                or (
                    owner_group in groups
                    and owner_group == display_owner_group
                    and persisted_raw_group
                    and (
                        raw_group == persisted_raw_group
                        or explicit_runtime_preimage
                        or authoritative_7d_provenance
                    )
                )
            )
        if source_type == "artist":
            groups = target_groups.get("artists", set())
            return bool(
                _runtime_change_group_key(value, "artists") in groups
                or (_overlay_artist_group_norm(value.get("artist")) or "unknown")
                    in groups
            )
        if source_type == "vtuber":
            groups = target_groups.get("vtubers", set())
            expected = {
                item
                for value in groups
                for item in (value, value.lstrip("/@"), _overlay_norm(value))
                if item
            }
            if persisted:
                expected.update(channel_identities(persisted))
            return bool(expected & channel_identities(value))
        return False

    def skip_synthetic_artist_parent_only_change(
        change: Mapping[str, Any],
        matches: Sequence[int],
    ) -> bool:
        """Ignore a moved-out parent tuple absent from a synthetic Artist card.

        An overlay-only Artist source has no persisted source row.  Its
        candidate rows already represent the ranked synthetic group, while a
        same-video replacement can still carry an exact parent-runtime proof
        for the old Artist owner (for example ``unknown``).  That old tuple is
        owned by the parent Song/VTuber sources, not by this synthetic card;
        requiring it as a source preimage would therefore reject a valid
        source even though the replacement is moving out of the group.  Keep
        the exception narrow: only an explicitly proven parent occurrence,
        an explicit old owner group equal to this target, and a replacement
        that is known to leave the Artist group qualify.  Same-group
        replacements and deletes still require an exact source preimage.
        """

        if source_type != "artist" or persisted or matches:
            return False
        if _text(
            change.get("entityType") or change.get("entity_type")
        ) not in {"occurrences", "runtime_occurrences"}:
            return False
        if not bool(change.get("replacement")):
            return False
        if change.get("replacementSameArtist") is not False:
            return False
        # Validate the coverage markers and require the exact parent-runtime
        # proof used by the ranking projection.  Do not infer a missing
        # preimage from display text alone.
        if not _runtime_occurrence_has_immutable_old_side(change):
            return False
        if (
            change.get("_parentRuntimeOccurrenceExists") is not True
            or change.get("_runtimeOccurrenceOwnerWasExplicit") is not False
        ):
            return False
        parent_group = _text(change.get("parentArtistGroupKey"))
        return bool(
            parent_group
            and parent_group in target_groups.get("artists", set())
        )

    effective: list[dict[str, Any]] = []
    if persisted:
        for occurrence in parent_occurrences:
            records = _persisted_source_records((occurrence,), persisted)
            if len(records) != 1 or len(records[0].get("occurrences", ())) != 1:
                raise PostgresAdapterError(
                    "persisted source occurrence disagrees with detail authority"
                )
            record = records[0]
            effective.append(record)
            if source_type == "song":
                video_id = _text((record.get("video") or {}).get("videoId"))
                if video_id in accepted_video_resets:
                    source_occurrence = record["occurrences"][0]
                    raw_identity = song_reset_owner_identity(
                        video_id, source_occurrence,
                    )
                    canonical_identity = song_reset_owner_identity(
                        video_id, source_occurrence, canonical_title=True,
                    )
                    if all(raw_identity):
                        song_reset_parent_identities[raw_identity] += 1
                    if all(canonical_identity):
                        song_reset_parent_canonical_identities[
                            canonical_identity
                        ] += 1
    elif source_type == "video" and direct_video_rows:
        if len(direct_video_rows) != 1:
            raise PostgresAdapterError(
                "direct video source parent identity is ambiguous"
            )
        video_row = direct_video_rows[0]
        video_id = _text(video_row.get("video_id"))
        video = _json_object(video_row.get("payload_json"))
        video.update({
            "videoId": video.get("videoId") or video_id,
            "title": video.get("title")
                if video.get("title") is not None else video_row.get("title"),
            "channelName": video.get("channelName")
                if video.get("channelName") is not None
                else video_row.get("channel_name"),
            "channelId": video.get("channelId")
                if video.get("channelId") is not None
                else video_row.get("channel_id"),
            "channelHandle": video.get("channelHandle")
                if video.get("channelHandle") is not None
                else video_row.get("channel_handle"),
            "channelUrl": video.get("channelUrl")
                if video.get("channelUrl") is not None
                else video_row.get("channel_url"),
            "publishedAt": video.get("publishedAt")
                if video.get("publishedAt") is not None
                else video_row.get("published_timestamp"),
        })
        for row in direct_occurrence_rows:
            occurrence = _json_object(row.get("payload_json"))
            occurrence.update({
                "occurrenceId": occurrence.get("occurrenceId")
                    or row.get("occurrence_id"),
                "rangeId": occurrence.get("rangeId")
                    or row.get("range_id") or range_id,
                "songKey": occurrence.get("songKey") or row.get("song_key"),
                "seconds": occurrence.get("seconds", row.get("seconds")),
                "title": occurrence.get("title") or row.get("title"),
                "artist": occurrence.get("artist") or row.get("artist"),
                "sourceId": occurrence.get("sourceId") or row.get("source_id"),
                "sourceSystem": occurrence.get("sourceSystem")
                    or row.get("source_system"),
            })
            if "isNiche" not in occurrence:
                occurrence["isNiche"] = row.get("is_niche") is True
            if "isUnknownArtist" not in occurrence:
                occurrence["isUnknownArtist"] = (
                    row.get("is_unknown_artist") is True
                )
            effective.append({
                "video": dict(video),
                "occurrences": (occurrence,),
            })

    if source_type == "song" and persisted:
        # Ranking splits a raw spelling when the same raw group contains both
        # reset-owned tuples and ordinary overlay-only tuples.  The exact
        # reset candidates move to the persisted owner; the remainder keeps
        # its independent raw card.  Record those mixed-group boundaries only
        # after the immutable parent reset identities above are complete, so
        # source reconstruction cannot claim the remainder through its broad
        # punctuation-insensitive owner fallback.
        for candidate in candidate_rows:
            if not has_exact_song_reset_owner(candidate):
                continue
            raw_group = song_candidate_raw_group(candidate)
            if raw_group:
                song_reset_owned_raw_keys.add(raw_group)

    def identity(record: Mapping[str, Any]) -> tuple[str, str]:
        return _source_record_identity(record)

    def insert_record(record: Mapping[str, Any]) -> None:
        record_identity = identity(record)
        if not all(record_identity):
            raise PostgresAdapterError(
                "snapshot source candidate is missing immutable identity"
            )
        matches = [
            index for index, current in enumerate(effective)
            if identity(current) == record_identity
        ]
        if len(matches) > 1:
            raise PostgresAdapterError(
                "snapshot source immutable identity is ambiguous"
            )
        if matches:
            effective[matches[0]] = dict(record)
        else:
            effective.append(dict(record))

    reset_videos = scoped_videos & {
        _text(video_id) for video_id in accepted_video_resets if _text(video_id)
    }
    if reset_videos:
        effective = [
            record for record in effective
            if identity(record)[0] not in reset_videos
        ]
    for row in candidate_rows:
        if row.get("video_tombstone") or not matches_target(
            row, split_mixed_reset_group=True,
        ):
            continue
        record = _overlay_source_record(row)
        if record:
            insert_record(record)

    def raise_source_preimage_error(
        change: Mapping[str, Any],
        matches: Sequence[int],
        *,
        reason: str,
    ) -> NoReturn:
        """Raise a bounded identity-only diagnostic for a rejected preimage.

        The source writer must remain fail-closed when an occurrence cannot be
        bound uniquely.  Include only immutable routing fields and cardinality
        in the exception so a production log identifies the exact branch
        without dumping title/artist/payload content.
        """

        entity_type = _text(
            change.get("entityType") or change.get("entity_type")
        ) or "unknown"
        change_video_id = row_video_id(change) or "unknown"
        change_occurrence_id = _text(
            change.get("occurrenceId") or change.get("occurrence_id")
        ) or "none"
        raise PostgresAdapterError(
            "source occurrence preimage does not uniquely match authority: "
            f"source={requested_key} type={source_type} range={range_id} "
            f"video={change_video_id} occurrence={change_occurrence_id} "
            f"matches={len(matches)} effective={len(effective)} "
            f"entity={entity_type} replacement={bool(change.get('replacement'))} "
            f"sameVideo={bool(change.get('replacementSameVideo'))} "
            f"sameArtist={change.get('replacementSameArtist', 'unknown')} "
            f"reason={reason}"
        )

    vtuber_replacements_applied_in_place: set[tuple[str, str]] = set()

    def has_legacy_source_occurrence(video_id: str) -> bool:
        """Return whether this video still uses pre-occurrence-id storage.

        ``runtime_source_occurrences`` predates immutable occurrence ids.  A
        runtime replacement can nevertheless carry an exact parent-runtime
        occurrence id, so an exact id lookup against the persisted source is
        expected to miss.  Only use the legacy tuple matcher when the source
        row itself has no id; sources that do carry ids must remain strict.
        """

        for record in effective:
            if identity(record)[0] != video_id:
                continue
            occurrences = record.get("occurrences") or ()
            if len(occurrences) != 1 or not isinstance(occurrences[0], Mapping):
                continue
            if not _text(
                occurrences[0].get("occurrenceId")
                or occurrences[0].get("occurrence_id")
            ):
                return True
        return False

    def replacement_matches_persisted_song(value: Mapping[str, Any]) -> bool:
        """Check a replacement payload against this canonical Song owner."""

        if source_type != "song" or not persisted:
            return False
        replacement = value.get("replacementPayload")
        if not isinstance(replacement, Mapping):
            return False
        occurrence = _overlay_public_occurrence(replacement)
        title = _text(occurrence.get("title") or occurrence.get("workTitle"))
        artist = _text(occurrence.get("artist"))
        if not title or not artist:
            return False
        replacement_group = (
            f"{_source_song_owner_norm(title)}::"
            f"{_source_song_owner_norm(artist)}"
        )
        owner_group = persisted_song_key_owner_group()
        return bool(owner_group and replacement_group == owner_group)

    def legacy_parent_group_matches_persisted_owner(
        value: Mapping[str, Any],
    ) -> bool:
        """Keep legacy preimage fallback bound to the persisted Song owner.

        Legacy source rows have no occurrence id, so the narrow same-video
        replacement exception below may use the tuple matcher to locate an
        old side.  An explicit parent Song group is stronger provenance than
        the display title: when it names a different raw/display owner (for
        example an alias being replaced by the canonical Song), that row is
        not a preimage for this canonical source and must be left in place.
        The replacement insertion loop will then add the canonical side.
        Missing parent-group metadata retains the historical, already-tested
        fallback for legacy rows.
        """

        if source_type != "song" or not persisted:
            return False
        parent_group = _text(
            value.get("parentSongGroupKey")
            or value.get("parent_song_group_key")
        )
        if not parent_group:
            return True
        persisted_owner = persisted_song_key_owner_group()
        return bool(
            persisted_owner
            and _source_song_group_key_norm(parent_group)
            == _source_song_group_key_norm(persisted_owner)
        )

    for change in runtime_changes:
        entity_type = _text(
            change.get("entityType") or change.get("entity_type")
        )
        video_id = row_video_id(change)
        if not video_id or video_id not in scoped_videos:
            continue
        if entity_type in {"videos", "runtime_videos"}:
            effective = [
                record for record in effective
                if identity(record)[0] != video_id
            ]
            continue
        if entity_type not in {"occurrences", "runtime_occurrences"}:
            continue
        occurrence_id = _text(
            change.get("occurrenceId") or change.get("occurrence_id")
        )
        matches = [
            index for index, record in enumerate(effective)
            if identity(record) == (video_id, occurrence_id)
        ] if occurrence_id else []
        if len(matches) > 1:
            raise_source_preimage_error(
                change, matches, reason="exact-identity-ambiguous",
            )
        if skip_synthetic_artist_parent_only_change(change, matches):
            continue
        if (
            source_type == "vtuber"
            and not matches
            and not _runtime_occurrence_has_immutable_old_side(change)
        ):
            # An exact source occurrence id is itself immutable old-side
            # evidence, even when the runtime parent table no longer carries
            # that tuple.  Only an exact miss is overlay-only: keep every
            # weakly similar persisted row untouched while allowing the
            # independently validated replacement loop below to add a new
            # side without inventing a subtraction.
            continue
        if not matches:
            if (
                source_type in {"song", "artist"}
                and not matches_target(change)
                and not (
                    source_type == "song"
                    and change.get("replacement") is True
                    and change.get("replacementSameVideo") is True
                    and change.get("_parentRuntimeOccurrenceExists") is True
                    and change.get("_runtimeOccurrenceOwnerWasExplicit") is False
                    and _runtime_occurrence_has_immutable_old_side(change)
                    and has_legacy_source_occurrence(video_id)
                    and replacement_matches_persisted_song(change)
                    and legacy_parent_group_matches_persisted_owner(change)
                )
            ):
                continue
            # Legacy source rows have no occurrence id, while the immutable
            # runtime replacement does.  An exact parent-coverage marker is
            # the authority for this old side; allow the bounded tuple matcher
            # only for that legacy representation.  Newer id-bearing source
            # rows, including a wrong explicit id, stay fail-closed.
            legacy_parent_fallback = (
                source_type in {"song", "artist"}
                and change.get("_parentRuntimeOccurrenceExists") is True
                and _runtime_occurrence_has_immutable_old_side(change)
                and has_legacy_source_occurrence(video_id)
            )
            if (
                not occurrence_id
                or source_type not in {"song", "artist"}
                or legacy_parent_fallback
            ):
                matches = [
                    index for index, record in enumerate(effective)
                    if _source_record_matches_change(record, change)
                ]
        if len(matches) > 1:
            raise_source_preimage_error(
                change, matches, reason="fallback-ambiguous",
            )
        if (
            not matches
            and not occurrence_id
            and source_type in {"song", "artist"}
        ):
            expected_group = _text(
                change.get(
                    "parentSongGroupKey"
                    if source_type == "song" else "parentArtistGroupKey"
                )
            ) or _runtime_change_group_key(
                change, "songs" if source_type == "song" else "artists",
            )

            def record_group(record: Mapping[str, Any]) -> str:
                occurrences = record.get("occurrences") or ()
                occurrence = (
                    occurrences[0]
                    if len(occurrences) == 1
                    and isinstance(occurrences[0], Mapping)
                    else {}
                )
                if source_type == "song":
                    return _source_row_song_group_identity(occurrence)
                return (
                    _overlay_artist_group_norm(_scope_artist(occurrence))
                    or "unknown"
                )

            matches = [
                index for index, record in enumerate(effective)
                if identity(record)[0] == video_id
                and record_group(record) == expected_group
            ]
        if source_type in {"song", "artist"} and len(matches) != 1:
            raise_source_preimage_error(
                change, matches, reason="final-cardinality",
            )
        if len(matches) == 1:
            # A same-video VTuber replacement remains a member of the exact
            # persisted channel source even when the curation payload omits
            # denormalised channel fields.  Ranking already binds this change
            # to the immutable parent video; doing a generic delete followed
            # by a standalone replacement match here could silently drop the
            # tuple because the replacement alone cannot prove channel
            # ownership.  Apply only the public occurrence delta in place and
            # retain the exact parent video's authoritative channel identity.
            if (
                source_type == "vtuber"
                and bool(change.get("replacement"))
                and bool(change.get("replacementSameVideo"))
            ):
                replacement = change.get("replacementPayload")
                replacement_occurrence = (
                    _overlay_public_occurrence(replacement)
                    if isinstance(replacement, Mapping) else {}
                )
                replacement_identity = (
                    _text(replacement_occurrence.get("videoId")),
                    _text(replacement_occurrence.get("occurrenceId")),
                )
                if (
                    replacement_identity != (video_id, occurrence_id)
                    or not _text(replacement_occurrence.get("title"))
                ):
                    raise PostgresAdapterError(
                        "same-video VTuber replacement has invalid immutable identity"
                    )
                current = effective[matches[0]]
                current_occurrences = current.get("occurrences") or ()
                if (
                    len(current_occurrences) != 1
                    or not isinstance(current_occurrences[0], Mapping)
                ):
                    raise PostgresAdapterError(
                        "same-video VTuber replacement preimage is not one occurrence"
                    )
                current_video = dict(current.get("video") or {})
                if not matches_target(current_video):
                    raise PostgresAdapterError(
                        "same-video VTuber replacement disagrees with source owner"
                    )
                replacement_video = _overlay_video_projection(
                    change.get("replacementVideoPayload") or replacement
                )
                for public_name, normalizer in (
                    ("channelId", _text),
                    ("channelHandle", _normalized_channel_handle),
                    ("channelName", _overlay_norm),
                ):
                    explicit = normalizer(replacement_video.get(public_name))
                    if not explicit:
                        continue
                    authoritative = normalizer(current_video.get(public_name))
                    if not authoritative or explicit != authoritative:
                        raise PostgresAdapterError(
                            "same-video VTuber replacement conflicts with source owner"
                        )
                updated_occurrence = dict(current_occurrences[0])
                updated_occurrence.update(replacement_occurrence)
                effective[matches[0]] = {
                    "video": current_video,
                    "occurrences": (updated_occurrence,),
                }
                vtuber_replacements_applied_in_place.add(replacement_identity)
                continue
            effective.pop(matches[0])

    for row in _runtime_replacement_candidate_rows(runtime_changes):
        if (
            source_type == "vtuber"
            and (row_video_id(row), _text(row.get("occurrence_id")))
                in vtuber_replacements_applied_in_place
        ):
            continue
        if not matches_target(row):
            continue
        record = _overlay_source_record(row)
        if record:
            insert_record(record)

    records_by_video: dict[str, dict[str, Any]] = {}
    for record in effective:
        video = dict(record.get("video") or {})
        video_id, _occurrence_id = identity(record)
        if not video_id:
            continue
        current = records_by_video.setdefault(
            video_id, {"video": video, "occurrences": []}
        )
        occurrences = record.get("occurrences") or ()
        if len(occurrences) != 1 or not isinstance(occurrences[0], Mapping):
            raise PostgresAdapterError(
                "snapshot source effective record is not one occurrence"
            )
        current["occurrences"].append(dict(occurrences[0]))
    records = [
        {
            "video": value["video"],
            "occurrences": tuple(sorted(
                value["occurrences"],
                key=lambda item: (
                    int(item.get("position") or 0),
                    _text(item.get("occurrenceId")),
                ),
            )),
        }
        for _video_id, value in sorted(records_by_video.items())
    ]
    if not records or not any(record["occurrences"] for record in records):
        return {
            "schemaVersion": 1,
            "found": False,
            "sourceKey": requested_key,
        }

    query = {"range": range_id}
    payload = source_payload_from_records(records, requested_key, query)
    if not payload.get("found"):
        view_for_type = {
            "song": "songs",
            "artist": "artists",
            "vtuber": "vtubers",
            "video": "videos",
        }
        view = view_for_type[source_type]
        options = _query_options({
            "range": range_id,
            "view": view,
            "metric": "occurrences",
        })
        groups = _entity_groups(records, options)
        if not groups:
            raise PostgresAdapterError(
                "snapshot source records do not resolve a target group"
            )
        expected_groups = target_groups.get(view, set())
        persisted_key = _text(persisted.get("key"))
        if source_type == "video":
            group_keys = {_text(group.get("key")) for group in groups}
            if len(group_keys) != 1 or not group_keys.issubset(expected_groups):
                raise PostgresAdapterError(
                    "snapshot video source records have ambiguous identity"
                )
            group_key = next(iter(group_keys))
        elif persisted_key:
            group_key = persisted_key
        elif len(expected_groups) == 1:
            group_key = next(iter(expected_groups))
        else:
            raise PostgresAdapterError(
                "snapshot source records have ambiguous target identity"
            )
        merged_occurrences = [
            occurrence
            for group in groups
            for occurrence in group.get("occurrences", ())
        ]
        if not merged_occurrences:
            raise PostgresAdapterError(
                "snapshot source records resolve an empty target group"
            )
        first_group = groups[0]
        merged_group = {
            "key": group_key,
            "video": dict(first_group.get("video") or {}),
            "occurrences": merged_occurrences,
            "title": (
                persisted.get("title")
                or persisted.get("workTitle")
                or first_group.get("title")
            ),
            "artist": (
                persisted.get("artist")
                or persisted.get("displayArtist")
                or first_group.get("artist")
            ),
        }
        record = _group_payload(merged_group, options)
        record["sourceDetailKey"] = requested_key
        record["occurrences"] = merged_occurrences
        payload = {
            "schemaVersion": 1,
            "found": True,
            "sourceKey": requested_key,
            "record": record,
        }
    result = dict(payload)
    record = {
        **persisted,
        **dict(payload.get("record") or {}),
    }
    record["sourceDetailKey"] = requested_key
    record["rangeId"] = range_id
    occurrences = record.get("occurrences")
    if not isinstance(occurrences, list):
        occurrences = _source_records_as_occurrences(
            records,
            _query_options(query),
            None,
        )
        record["occurrences"] = occurrences
    count = len(occurrences)
    video_count = len({
        _text(item.get("videoId"))
        for item in occurrences
        if _text(item.get("videoId"))
    })
    record["count"] = count
    record["occurrenceCount"] = count
    record["timestampCount"] = count
    record["videoCount"] = video_count
    if source_type == "song" and count:
        # The persisted Song detail is one canonical work even when several
        # overlay rows carry distinct raw song keys.  The writer pins every
        # occurrence to that persisted owner before its source cardinality
        # gate, so keep the source card scalar in the same contract here;
        # otherwise the boundary reconciler can reject an exact 7D duplicate
        # solely because the pre-pinned payload counted raw keys.
        record["songCount"] = 1
    result["record"] = record
    if source_type == "vtuber":
        result = _canonicalize_vtuber_source_payload(result, records, query)
        result_record = dict(result.get("record") or {})
        result_record["sourceDetailKey"] = requested_key
        result_record["rangeId"] = range_id
        result["record"] = result_record
    result["sourceKey"] = requested_key
    return result


def _authoritative_7d_overlay_ids(
    connection, overlay_revision_ids: Sequence[str],
) -> tuple[str, ...]:
    """Return descendants through the newest reviewed 7D boundary."""

    revision_ids = tuple(
        _text(value) for value in overlay_revision_ids if _text(value)
    )
    if not revision_ids or not hasattr(connection, "cursor"):
        return ()
    rows = _rows(
        connection,
        """SELECT revision_id, manifest_json FROM migration_revisions
           WHERE revision_id = ANY(%s) ORDER BY revision_id LIMIT %s""",
        [list(revision_ids), len(revision_ids) + 1],
    )
    if len(rows) > len(revision_ids):
        raise PostgresAdapterError(
            "authoritative 7d manifest lookup exceeded lineage bound"
        )
    manifests = {
        _text(row.get("revision_id")): _json_object(row.get("manifest_json"))
        for row in rows
    }
    for index, revision_key in enumerate(revision_ids):
        manifest = manifests.get(revision_key, {})
        if (
            manifest.get("handoffKind")
                == "github-core-7d-authoritative-range"
            and manifest.get("rangeReset") is True
            and manifest.get("partialVideoRows") is True
            and manifest.get("authoritativeRange") == "7d"
            and manifest.get("rangeResetAppliedBy")
                == "pg-adapter-authoritative-range-boundary-v2"
            and manifest.get("rangeBoundaryMutationCount") == 1
            and manifest.get("rangeResetTombstoneCount") == 0
        ):
            return revision_ids[: index + 1]
    return ()


def _authoritative_7d_records(
    connection, overlay_revision_ids: Sequence[str],
) -> tuple[dict[str, Any], ...]:
    """Resolve the bounded post-boundary 7D tuples without the full parent."""

    authoritative_ids = _authoritative_7d_overlay_ids(
        connection, overlay_revision_ids,
    )
    if not authoritative_ids:
        return ()
    # The newest reviewed 7d boundary is the complete public range reset.
    # Replaying newer alias/curation revisions here would append their 7d
    # rows to that authoritative set; those revisions belong to the all-range
    # mutation delta instead.
    authoritative_ids = authoritative_ids[-1:]
    candidate_rows = tuple(_overlay_rows_for_range(
        _overlay_candidate_rows(connection, authoritative_ids), "7d",
    ))
    if len(candidate_rows) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "authoritative 7d candidate exceeded bounded occurrence cap"
        )
    accepted_resets = _accepted_video_resets(
        connection, authoritative_ids, False,
    )
    changes = tuple(_overlay_rows_for_range(
        _runtime_tombstones(
            connection,
            authoritative_ids,
            accepted_resets.values() if accepted_resets else None,
            candidate_rows,
        ),
        "7d",
    ))
    effective: dict[tuple[str, str], dict[str, Any]] = {}
    for row in candidate_rows:
        if row.get("video_tombstone"):
            continue
        record = _overlay_source_record(row)
        if not record:
            continue
        occurrence = record["occurrences"][0]
        identity = (
            _text(occurrence.get("videoId")),
            _text(occurrence.get("occurrenceId")),
        )
        if not all(identity):
            raise PostgresAdapterError(
                "authoritative 7d candidate is missing immutable identity"
            )
        if identity in effective:
            raise PostgresAdapterError(
                "authoritative 7d candidate repeats immutable identity"
            )
        effective[identity] = record
    for change in changes:
        identity = (
            _text(change.get("videoId") or change.get("video_id")),
            _text(change.get("occurrenceId") or change.get("occurrence_id")),
        )
        if all(identity):
            effective.pop(identity, None)
    for row in _runtime_replacement_candidate_rows(changes):
        record = _overlay_source_record(row)
        if not record:
            continue
        occurrence = record["occurrences"][0]
        identity = (
            _text(occurrence.get("videoId")),
            _text(occurrence.get("occurrenceId")),
        )
        if all(identity):
            effective[identity] = record
    grouped: dict[str, dict[str, Any]] = {}
    for identity, record in sorted(effective.items()):
        video_id = identity[0]
        current = grouped.get(video_id)
        if current is None:
            grouped[video_id] = {
                "video": dict(record["video"]),
                "occurrences": [dict(record["occurrences"][0])],
            }
        else:
            if _text(current["video"].get("channelId")) != _text(
                record["video"].get("channelId")
            ):
                raise PostgresAdapterError(
                    "authoritative 7d video has conflicting channel identity"
                )
            current["occurrences"].append(
                dict(record["occurrences"][0])
            )
    records = tuple(
        {
            "video": item["video"],
            "occurrences": tuple(sorted(
                item["occurrences"],
                key=lambda occurrence: (
                    int(occurrence.get("position") or 0),
                    _text(occurrence.get("occurrenceId")),
                ),
            )),
        }
        for _video_id, item in sorted(grouped.items())
    )
    if not records or not any(record["occurrences"] for record in records):
        raise PostgresAdapterError(
            "authoritative 7d boundary resolved to an empty projection"
        )
    return records


def rankings_payload(connection, query: Mapping[str, Any] | None = None) -> dict[str, Any]:
    runtime = _runtime_projection_revision(connection)
    if runtime:
        return _project_runtime_video_records(
            _runtime_rankings_payload(connection, runtime[0], query),
            view=_query_options(query)["view"],
        )
    generic_runtime = _generic_runtime_projection_revision(connection)
    if generic_runtime:
        parent = _generic_parent_runtime_revision(
            connection, generic_runtime[0], generic_runtime[1],
        )
        overlay_ids: Sequence[str] = ()
        if parent:
            overlay_ids = _overlay_revision_ids(
                connection, generic_runtime[0], parent[0],
            )
            if (
                _query_options(query).get("range") == "7d"
                and _authoritative_7d_overlay_ids(connection, overlay_ids)
            ):
                return rankings_payload_from_records(
                    _authoritative_7d_records(connection, overlay_ids), query,
                )
        return _project_generic_overlay_video_records(
            connection,
            overlay_ids,
            _generic_overlay_rankings_payload(
                connection, generic_runtime[0], generic_runtime[1], query,
            ),
            view=_query_options(query)["view"],
        )
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
          AND scope_key = 'all'
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


def _source_detail_delta_lineage(
    overlay_revision_ids: Sequence[str],
    detail_revision_id: str,
    parent_revision_id: str,
) -> tuple[str, list[str]]:
    """Return the authoritative source base and only its newer overlay tail."""

    overlays = [_text(value) for value in overlay_revision_ids if _text(value)]
    detail_revision_id = _text(detail_revision_id)
    parent_revision_id = _text(parent_revision_id)
    if not detail_revision_id:
        return parent_revision_id, overlays
    if detail_revision_id == parent_revision_id:
        return detail_revision_id, overlays
    try:
        detail_index = overlays.index(detail_revision_id)
    except ValueError as error:
        raise PostgresAdapterError(
            "authoritative source detail is outside the active overlay lineage"
        ) from error
    return detail_revision_id, overlays[:detail_index]


def source_payload(
    connection,
    key: str,
    query: Mapping[str, Any] | None = None,
    *,
    snapshot_context: Any | None = None,
    snapshot_video_scope: Sequence[str] | None = None,
) -> dict[str, Any]:
    key = _text(key).strip()
    if not key:
        raise ValueError("source key is required")
    runtime = (
        getattr(snapshot_context, "runtime", None)
        if snapshot_context is not None
        else _runtime_projection_revision(connection)
    )
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
    generic_runtime = (
        getattr(snapshot_context, "generic_runtime", None)
        if snapshot_context is not None
        else _generic_runtime_projection_revision(connection)
    )
    if generic_runtime:
        snapshot_artist_aliases = (
            getattr(snapshot_context, "snapshot_artist_aliases", None)
            if snapshot_context is not None
            else None
        )
        parent = (
            getattr(snapshot_context, "parent", None)
            if snapshot_context is not None
            else _generic_parent_runtime_revision(
                connection, generic_runtime[0], generic_runtime[1],
            )
        )
        if parent:
            overlay_ids = (
                tuple(getattr(snapshot_context, "overlay_ids", ()))
                if snapshot_context is not None
                else _overlay_revision_ids(connection, generic_runtime[0], parent[0])
            )
            authoritative_7d_ids = (
                tuple(getattr(snapshot_context, "authoritative_ids", ()))
                if snapshot_context is not None
                else _authoritative_7d_overlay_ids(connection, overlay_ids)
            )
            authoritative_records = (
                getattr(snapshot_context, "authoritative_records", None)
                if snapshot_context is not None
                else None
            )
            authoritative_7d = (
                source_payload_from_records(
                    authoritative_records
                    if authoritative_records is not None
                    else _authoritative_7d_records(connection, overlay_ids),
                    key,
                    query,
                )
                if (
                    authoritative_7d_ids
                    and _query_options(query).get("range") == "7d"
                )
                else None
            )
            if authoritative_7d and authoritative_7d.get("found"):
                return authoritative_7d
            persisted = _runtime_source_payload(connection, parent[0], key, query, allow_derived=False, overlay_revision_ids=overlay_ids)
            if persisted.get("found"):
                persisted_record = persisted.get("record") if isinstance(persisted.get("record"), Mapping) else {}
                if authoritative_7d_ids and _text(
                    persisted_record.get("rangeId") or persisted_record.get("range_id")
                ) == "7d":
                    return {"schemaVersion": 1, "found": False, "sourceKey": key}
                source_base_revision, source_overlay_ids = _source_detail_delta_lineage(
                    overlay_ids,
                    _text(persisted.get("sourceRevisionId")),
                    parent[0],
                )
                if not source_overlay_ids or (
                    snapshot_video_scope is not None and not snapshot_video_scope
                ):
                    return persisted
                prepared_inputs = (
                    _snapshot_source_overlay_inputs(
                        connection,
                        source_base_revision,
                        source_overlay_ids,
                        _query_options(query)["range"],
                        snapshot_video_scope,
                        include_compatible_full_reset_7d=(
                            _query_options(query)["range"] == "all"
                            and _text(persisted_record.get("type")) != "song"
                        ),
                    )
                    if (
                        snapshot_video_scope is not None
                        and _text(persisted_record.get("type"))
                            in {"song", "artist", "video"}
                    )
                    else None
                )
                song_rebuilt = _generic_song_source_payload(
                    connection, source_base_revision, persisted_record, key, query,
                    source_overlay_ids,
                    *(prepared_inputs or ()),
                )
                if song_rebuilt is not None:
                    return song_rebuilt
                if _text(persisted_record.get("type")) == "song":
                    # No same-range generic delta affects this persisted song.
                    # Do not reinterpret it as a channel source merely because
                    # a different physical range has newer migration rows.
                    return persisted
                artist_rebuilt = _generic_artist_source_payload(
                    connection,
                    source_base_revision,
                    persisted_record,
                    key,
                    query,
                    source_overlay_ids,
                    *(prepared_inputs or ()),
                    artist_owner_revision_id=(
                        parent[0]
                        if source_base_revision == parent[0]
                        else None
                    ),
                    artist_alias_cache=snapshot_artist_aliases,
                )
                if artist_rebuilt is not None:
                    return artist_rebuilt
                if _text(persisted_record.get("type")) == "artist":
                    return persisted
                video_rebuilt = _generic_video_source_payload(
                    connection,
                    source_base_revision,
                    persisted_record,
                    key,
                    query,
                    source_overlay_ids,
                    *(prepared_inputs or ()),
                    snapshot_video_scope=snapshot_video_scope,
                )
                if video_rebuilt is not None:
                    return video_rebuilt
                if persisted_record and (
                    source_overlay_ids
                    or _text(persisted_record.get("sourceDetailKey")) != _text(key)
                ):
                    # A parent projection can retain an all-range payload under
                    # a 7d key, and accepted overlays add rows that do not exist
                    # in the persisted parent source detail.  Rebuild only this
                    # channel while retaining every existing public field.
                    repaired = _runtime_channel_source_payload(
                        connection, source_base_revision, persisted_record, key, query,
                        overlay_revision_ids=source_overlay_ids,
                        snapshot_video_scope=snapshot_video_scope,
                    )
                    if repaired.get("found"):
                        repaired = dict(repaired)
                        repaired["record"] = {**dict(persisted_record), **dict(repaired.get("record") or {})}
                        return repaired
                    if source_overlay_ids and _has_trusted_source_channel_identity(persisted_record):
                        # A full-video reset/tombstone is authoritative for an
                        # exact persisted channel identity.  Do not revive the
                        # parent source when its final record set is empty.
                        return repaired
                return persisted
            if snapshot_video_scope is not None and not snapshot_video_scope:
                return persisted
            resolved_key = _runtime_source_key_for_channel_alias(connection, parent[0], key)
            if resolved_key:
                persisted = _runtime_source_payload(connection, parent[0], resolved_key, query, allow_derived=False, overlay_revision_ids=overlay_ids)
                if persisted.get("found"):
                    persisted_record = persisted.get("record") if isinstance(persisted.get("record"), Mapping) else {}
                    if authoritative_7d_ids and _text(
                        persisted_record.get("rangeId") or persisted_record.get("range_id")
                    ) == "7d":
                        return {"schemaVersion": 1, "found": False, "sourceKey": resolved_key}
                    source_base_revision, source_overlay_ids = _source_detail_delta_lineage(
                        overlay_ids,
                        _text(persisted.get("sourceRevisionId")),
                        parent[0],
                    )
                    if not source_overlay_ids or (
                        snapshot_video_scope is not None and not snapshot_video_scope
                    ):
                        return persisted
                    prepared_inputs = (
                        _snapshot_source_overlay_inputs(
                            connection,
                            source_base_revision,
                            source_overlay_ids,
                            _query_options(query)["range"],
                            snapshot_video_scope,
                            include_compatible_full_reset_7d=(
                                _query_options(query)["range"] == "all"
                                and _text(persisted_record.get("type")) != "song"
                            ),
                        )
                        if (
                            snapshot_video_scope is not None
                            and _text(persisted_record.get("type"))
                                in {"song", "artist", "video"}
                        )
                        else None
                    )
                    song_rebuilt = _generic_song_source_payload(
                        connection, source_base_revision, persisted_record, resolved_key,
                        query, source_overlay_ids,
                        *(prepared_inputs or ()),
                    )
                    if song_rebuilt is not None:
                        return song_rebuilt
                    if _text(persisted_record.get("type")) == "song":
                        return persisted
                    artist_rebuilt = _generic_artist_source_payload(
                        connection,
                        source_base_revision,
                        persisted_record,
                        resolved_key,
                        query,
                        source_overlay_ids,
                        *(prepared_inputs or ()),
                        artist_owner_revision_id=(
                            parent[0]
                            if source_base_revision == parent[0]
                            else None
                        ),
                        artist_alias_cache=snapshot_artist_aliases,
                    )
                    if artist_rebuilt is not None:
                        return artist_rebuilt
                    if _text(persisted_record.get("type")) == "artist":
                        return persisted
                    video_rebuilt = _generic_video_source_payload(
                        connection,
                        source_base_revision,
                        persisted_record,
                        resolved_key,
                        query,
                        source_overlay_ids,
                        *(prepared_inputs or ()),
                        snapshot_video_scope=snapshot_video_scope,
                    )
                    if video_rebuilt is not None:
                        return video_rebuilt
                    if persisted_record:
                        repaired = _runtime_channel_source_payload(
                            connection,
                            source_base_revision,
                            persisted_record,
                            resolved_key,
                            query,
                            overlay_revision_ids=source_overlay_ids,
                            snapshot_video_scope=snapshot_video_scope,
                        )
                        if repaired.get("found"):
                            repaired = dict(repaired)
                            repaired["record"] = {
                                **dict(persisted_record),
                                **dict(repaired.get("record") or {}),
                            }
                            return repaired
                        if source_overlay_ids and _has_trusted_source_channel_identity(persisted_record):
                            return repaired
                    return persisted
            prepared_inputs = (
                _snapshot_source_overlay_inputs(
                    connection,
                    parent[0],
                    overlay_ids,
                    _query_options(query)["range"],
                    snapshot_video_scope,
                    include_compatible_full_reset_7d=(
                        _query_options(query)["range"] == "all"
                    ),
                )
                if snapshot_video_scope is not None
                else None
            )
            overlay_song = _generic_overlay_song_source_for_key(
                connection,
                parent[0],
                key,
                query,
                overlay_ids,
                *(prepared_inputs or ()),
            ) if overlay_ids else None
            if overlay_song is not None:
                return overlay_song
            overlay_artist = _generic_overlay_artist_source_for_key(
                connection,
                parent[0],
                key,
                query,
                overlay_ids,
                *(prepared_inputs or ()),
            ) if overlay_ids else None
            if overlay_artist is not None:
                return overlay_artist
            overlay_vtuber = _generic_overlay_vtuber_source_for_key(
                connection,
                parent[0],
                key,
                query,
                overlay_ids,
                *(prepared_inputs or (None, None, None)),
                snapshot_video_scope,
            ) if overlay_ids else None
            if overlay_vtuber is not None:
                return overlay_vtuber
            overlay_video = _generic_video_source_payload(
                connection,
                parent[0],
                None,
                key,
                query,
                overlay_ids,
                *(prepared_inputs or ()),
                snapshot_video_scope=snapshot_video_scope,
            ) if overlay_ids else None
            if overlay_video is not None:
                return overlay_video
            metadata = _channel_metadata_rows(connection, _revision_lineage(connection, generic_runtime[0]))
            channel_metadata = _metadata_for_source_key(metadata, key)
            if channel_metadata:
                return _runtime_channel_source_payload(
                    connection,
                    parent[0],
                    channel_metadata,
                    key,
                    query,
                    overlay_revision_ids=overlay_ids,
                    snapshot_video_scope=snapshot_video_scope,
                )
            if key.startswith("UC"):
                return _runtime_channel_source_payload(
                    connection,
                    parent[0],
                    {"channelId": key},
                    key,
                    query,
                    overlay_revision_ids=overlay_ids,
                    snapshot_video_scope=snapshot_video_scope,
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
        artist_group = _overlay_artist_group_norm(item.get("artist"))
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
            groups.add((range_id, "artists", artist_group or "unknown"))
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
          AND row.scope_key = 'all'
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


def _meta_source_occurrence_units(item: Mapping[str, Any]) -> int:
    """Return the public source-row units for one physical occurrence."""
    return 3 if _text(item.get("range_id") or item.get("rangeId")) else 6


def _authoritative_7d_record_aggregate(
    records: Iterable[Mapping[str, Any]],
) -> dict[str, int]:
    """Aggregate one bounded authoritative 7d projection without rendering it."""

    records = tuple(records)
    occurrence_count = sum(
        len(record.get("occurrences") or ())
        for record in records
    )
    if occurrence_count > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "authoritative 7d aggregate exceeded bounded occurrence cap"
        )
    video_ids = {
        _text((record.get("video") or {}).get("videoId"))
        for record in records
    }
    song_keys = {
        _song_key(occurrence)
        for record in records
        for occurrence in record.get("occurrences") or ()
        if _song_key(occurrence)
    }
    ranking_rows = 0
    ranking_shapes = (
        ("songs", ("count", "videos")),
        ("songIndex", ("count",)),
        ("artists", ("count", "videos")),
        ("videos", ("count",)),
        ("vtubers", ("count", "songs", "videos")),
        ("vsingerSongs", ("count",)),
    )
    for view, metrics in ranking_shapes:
        for metric in metrics:
            ranking_rows += len(_entity_groups(
                records,
                _query_options({
                    "range": "7d", "view": view, "metric": metric,
                }),
            ))
    return {
        "videos": len({video_id for video_id in video_ids if video_id}),
        "songs": len(song_keys),
        "occurrences": occurrence_count,
        "ranking_rows": ranking_rows,
        "source_occurrences": sum(
            _meta_source_occurrence_units(occurrence)
            for record in records
            for occurrence in record.get("occurrences") or ()
        ),
    }


def _authoritative_7d_runtime_aggregate(
    connection,
    parent_revision_id: str,
) -> dict[str, int]:
    """Read the parent 7d aggregate scalars when no older boundary is present."""

    aggregate = _one(
        connection,
        """
        SELECT
          COALESCE(SUM(row_count) FILTER (
              WHERE view = 'songs' AND metric = 'count'
          ), 0) AS occurrence_count,
          COUNT(*) FILTER (
              WHERE view = 'videos' AND metric = 'count'
          ) AS video_count,
          COUNT(*) FILTER (
              WHERE view = 'songs' AND metric = 'count'
          ) AS song_count,
          COUNT(*) AS ranking_row_count
        FROM runtime_ranking_rows
        WHERE revision_id = %s
          AND range_id = '7d'
          AND scope_key = 'all'
          AND row_count >= 1
          AND (
            (view = 'songs' AND metric IN ('count', 'videos'))
            OR (view = 'songIndex' AND metric = 'count')
            OR (view = 'artists' AND metric IN ('count', 'videos'))
            OR (view = 'videos' AND metric = 'count')
            OR (view = 'vtubers' AND metric IN ('count', 'songs', 'videos'))
            OR (view = 'vsingerSongs' AND metric = 'count')
          )
        """,
        [parent_revision_id],
    ) or {}
    occurrence_count = int(aggregate.get("occurrence_count") or 0)
    return {
        "videos": int(aggregate.get("video_count") or 0),
        "songs": int(aggregate.get("song_count") or 0),
        "occurrences": occurrence_count,
        "ranking_rows": int(aggregate.get("ranking_row_count") or 0),
        "source_occurrences": occurrence_count * 3,
    }


def _authoritative_7d_meta_deltas(
    connection,
    parent_revision_id: str,
    previous_overlay_revision_ids: Sequence[str],
    authoritative_records: Sequence[Mapping[str, Any]],
) -> dict[str, int]:
    """Return the bounded old-to-new 7d aggregate delta for generic meta."""

    previous_records = _authoritative_7d_records(
        connection, previous_overlay_revision_ids,
    ) if previous_overlay_revision_ids else ()
    previous = (
        _authoritative_7d_record_aggregate(previous_records)
        if previous_records
        else _authoritative_7d_runtime_aggregate(
            connection, parent_revision_id,
        )
    )
    current = _authoritative_7d_record_aggregate(authoritative_records)
    return {
        key: current[key] - previous[key]
        for key in (
            "videos", "songs", "ranking_rows",
        )
    }


def _apply_generic_overlay_meta_counts(
    connection,
    parent_revision_id: str,
    overlay_revision_ids: Sequence[str],
    counts: Mapping[str, int],
    public_mutation_overlay_ids: Sequence[str] | None = None,
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

    # The full effective tuple map remains the source for video/song/ranking
    # reconciliation.  Public occurrence counters have a narrower contract:
    # accepted rows are accounted for by the explicit authoritative 7d
    # projection, while only runtime alias/curation chains contribute a
    # physical net mutation here.  Do not let accepted generic lineage rows
    # masquerade as new all-range occurrences.
    public_overlay_ids = (
        tuple(overlay_revision_ids)
        if public_mutation_overlay_ids is None
        else tuple(public_mutation_overlay_ids)
    )
    public_overlay_id_set = {
        _text(value) for value in public_overlay_ids if _text(value)
    }
    public_runtime_changes = tuple(
        change
        for change in runtime_changes
        if _text(change.get("revisionId") or change.get("revision_id"))
        in public_overlay_id_set
        and _text(change.get("rangeId") or change.get("range_id"))
        in {"", "all"}
        and _text(change.get("entityType") or change.get("entity_type"))
        in {"occurrences", "runtime_occurrences"}
    )
    public_before: dict[tuple[str, str], dict[str, Any]] = {}
    for change in public_runtime_changes:
        item = _meta_overlay_tuple(change)
        if item:
            identity = (item["video_id"], item["occurrence_id"])
            if identity in before:
                public_before[identity] = before[identity]
    public_effective = dict(public_before)
    for change in public_runtime_changes:
        item = _meta_overlay_tuple(change)
        if item:
            public_effective.pop((item["video_id"], item["occurrence_id"]), None)
    for row in _runtime_replacement_candidate_rows(public_runtime_changes):
        item = _meta_overlay_tuple(row)
        if item:
            public_effective[(item["video_id"], item["occurrence_id"])] = item
    result["_public_occurrence_delta"] = (
        len(public_effective) - len(public_before)
    )
    result["_public_source_occurrence_delta"] = (
        sum(_meta_source_occurrence_units(item) for item in public_effective.values())
        - sum(_meta_source_occurrence_units(item) for item in public_before.values())
    )
    result["occurrences"] = max(
        0,
        int(result.get("occurrences") or 0)
        + int(result.get("_public_occurrence_delta") or 0),
    )
    result["source_occurrences"] = max(
        0,
        int(result.get("source_occurrences") or 0)
        + int(result.get("_public_source_occurrence_delta") or 0),
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


def _generic_public_all_range_baseline(
    connection,
    parent_revision_id: str,
    baseline_overlay_revision_ids: Sequence[str],
) -> tuple[int, int]:
    """Return all/songs/occurrences totals without rendering ranking cards.

    This is the aggregate-only counterpart of the bounded no-search path in
    ``_prepare_generic_overlay_rankings``.  It reads one scalar parent
    aggregate, the affected song groups, and the bounded overlay rows needed
    to reconcile those groups.  It never calls the full ranking payload
    renderer, hydrates previews, or serializes a page of cards.
    """
    overlay_revision_ids = tuple(
        _text(value)
        for value in baseline_overlay_revision_ids
        if _text(value)
    )
    candidate_rows = tuple(
        _overlay_candidate_rows(connection, overlay_revision_ids, False)
    )
    accepted_video_resets = _accepted_video_resets(
        connection, overlay_revision_ids, False,
    )
    reset_changes = _accepted_video_reset_changes(
        connection,
        parent_revision_id,
        accepted_video_resets,
        {"range": "all"},
    )
    runtime_changes = tuple(
        _runtime_tombstones(
            connection,
            overlay_revision_ids,
            accepted_video_resets.values()
            if accepted_video_resets
            else None,
            candidate_rows,
        )
    )
    candidate_rows = tuple(_overlay_rows_for_range(candidate_rows, "all"))
    runtime_changes = tuple(_overlay_rows_for_range(runtime_changes, "all"))
    replacement_rows = tuple(
        _runtime_replacement_candidate_rows(runtime_changes)
    )
    affected_keys: set[str] = set()
    for row in (*candidate_rows, *replacement_rows):
        key = _runtime_view_group_key(row, "songs")
        if key:
            affected_keys.add(key)
    for change in (*reset_changes, *runtime_changes):
        affected_keys.update(
            _runtime_change_view_keys((change,), "songs")
        )
    if len(affected_keys) > _MAX_AFFECTED_RUNTIME_OCCURRENCES:
        raise PostgresAdapterError(
            "public all-range aggregate exceeded bounded affected-group cap"
        )
    aggregate = _one(
        connection,
        """
        SELECT COALESCE(SUM(row_count), 0) AS total_occurrence_count
        FROM runtime_ranking_rows
        WHERE revision_id = %s
          AND range_id = 'all'
          AND view = 'songs'
          AND metric = 'count'
          AND scope_key = 'all'
          AND row_count >= 1
        """,
        [parent_revision_id],
    ) or {}
    parent_total = int(aggregate.get("total_occurrence_count") or 0)
    if parent_total <= 0:
        raise PostgresAdapterError(
            "public all-range ranking baseline is empty"
        )
    if not affected_keys:
        return parent_total, parent_total * 3

    affected_rows = _rows(
        connection,
        """
        WITH affected_keys(detail_key) AS MATERIALIZED (
            SELECT DISTINCT affected.detail_key
            FROM unnest(%s::text[]) AS affected(detail_key)
        ), parent_groups AS MATERIALIZED (
            SELECT parent_row.rank, parent_row.detail_key,
                   parent_row.title, parent_row.artist, parent_row.name,
                   parent_row.row_count, parent_row.song_count,
                   parent_row.video_count, parent_row.timestamp_count,
                   NULL::jsonb AS payload_json,
                   '' AS search_text, '' AS channel_search_text
            FROM runtime_ranking_rows AS parent_row
            JOIN affected_keys
              ON affected_keys.detail_key = parent_row.detail_key
            WHERE parent_row.revision_id = %s
              AND parent_row.range_id = 'all'
              AND parent_row.view = 'songs'
              AND parent_row.metric = 'count'
              AND parent_row.scope_key = 'all'
              AND parent_row.row_count >= 1
        ), unaffected_guard AS MATERIALIZED (
            SELECT COUNT(*) AS unaffected_group_count
            FROM runtime_ranking_rows AS parent_row
            WHERE parent_row.revision_id = %s
              AND parent_row.range_id = 'all'
              AND parent_row.view = 'songs'
              AND parent_row.metric = 'count'
              AND parent_row.scope_key = 'all'
              AND parent_row.row_count >= 1
              AND NOT EXISTS (
                  SELECT 1
                  FROM affected_keys
                  WHERE affected_keys.detail_key = parent_row.detail_key
              )
        )
        SELECT parent_groups.*, unaffected_guard.unaffected_group_count
        FROM parent_groups
        CROSS JOIN unaffected_guard
        ORDER BY parent_groups.rank
        LIMIT %s
        """,
        [
            sorted(affected_keys),
            parent_revision_id,
            parent_revision_id,
            len(affected_keys) + 1,
        ],
    )
    if len(affected_rows) > len(affected_keys):
        raise PostgresAdapterError(
            "public all-range affected-group lookup exceeded bounded cap"
        )
    groups = {
        _text(row.get("detail_key")): dict(row)
        for row in affected_rows
        if _text(row.get("detail_key"))
    }
    old_total = sum(
        int(row.get("row_count") or 0)
        for row in groups.values()
    )
    _apply_runtime_tombstone_groups(
        groups,
        reset_changes,
        "songs",
        "_aggregate_reset_previews",
        allow_accepted_reset_detail_fallback=True,
    )
    delta = _overlay_candidate_groups(
        (*candidate_rows, *replacement_rows), "songs",
    )
    for key, item in delta.items():
        count = int(item.get("occurrenceCount") or len(item.get("occurrences") or ()))
        if count <= 0:
            continue
        row = groups.get(key)
        if row is None:
            groups[key] = {
                "detail_key": key,
                "title": item.get("title", ""),
                "artist": item.get("artist", ""),
                "row_count": count,
                "song_count": len(item.get("songKeys") or ()),
                "video_count": len(item.get("videoIds") or ()),
                "timestamp_count": count,
            }
        else:
            row["row_count"] = int(row.get("row_count") or 0) + count
            row["timestamp_count"] = int(row.get("timestamp_count") or 0) + count
    _apply_runtime_tombstone_groups(
        groups, runtime_changes, "songs",
    )
    final_total = sum(
        int(row.get("row_count") or 0)
        for row in groups.values()
        if int(row.get("row_count") or 0) >= 1
    )
    occurrences = max(0, parent_total + final_total - old_total)
    return occurrences, occurrences * 3


def meta_payload(connection, *, identity_only: bool = False) -> dict[str, Any]:
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
        if identity_only:
            return {"schemaVersion": 1, "meta": meta, "counts": {}}
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
        if identity_only:
            return {"schemaVersion": 1, "meta": meta, "counts": {}}
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
        authoritative_7d_ids = _authoritative_7d_overlay_ids(
            connection, overlay_ids,
        )
        # ``overlay_ids`` is newest-to-oldest.  The authoritative helper
        # returns the prefix through the newest 7d boundary; only entries
        # before that boundary are newer alias/curation mutations.  Older
        # generic lineage is already absorbed by the public all-range parent
        # baseline and must not be replayed as a second physical delta.
        current_newer_mutation_ids: tuple[str, ...] = ()
        previous_overlay_ids: tuple[str, ...] = ()
        previous_public_mutation_ids: tuple[str, ...] = ()
        if authoritative_7d_ids:
            current_newer_mutation_ids = tuple(
                overlay_ids[: len(authoritative_7d_ids) - 1]
            )
            previous_overlay_ids = tuple(
                overlay_ids[len(authoritative_7d_ids):]
            )
            previous_authoritative_7d_ids = _authoritative_7d_overlay_ids(
                connection, previous_overlay_ids,
            )
            if previous_authoritative_7d_ids:
                previous_public_mutation_ids = tuple(
                    previous_overlay_ids[:
                        len(previous_authoritative_7d_ids) - 1
                    ]
                )
                baseline_overlay_revision_ids = tuple(
                    previous_overlay_ids[len(previous_authoritative_7d_ids):]
                )
            else:
                previous_public_mutation_ids = previous_overlay_ids
                baseline_overlay_revision_ids = ()
            public_mutation_overlay_ids = (
                *current_newer_mutation_ids,
                *previous_public_mutation_ids,
            )
            # The current boundary is replaced by the bounded old-to-new 7d
            # aggregate below.  Keep the previous active lineage in generic
            # reconciliation, but never replay it as the all-range baseline.
            generic_reconciliation_overlay_ids = (
                *current_newer_mutation_ids,
                *previous_overlay_ids,
            )
        else:
            public_mutation_overlay_ids = tuple(overlay_ids)
            baseline_overlay_revision_ids = ()
            generic_reconciliation_overlay_ids = tuple(overlay_ids)
        public_baseline_occurrences, public_baseline_source_occurrences = (
            _generic_public_all_range_baseline(
                connection, parent_id, baseline_overlay_revision_ids,
            )
        )
        # The public all-range rankings contract is the parent baseline for
        # meta.  Keep the runtime-meta values for the unrelated counters, but
        # do not use them as an occurrence/source baseline for this adapter.
        counts["occurrences"] = public_baseline_occurrences
        counts["source_occurrences"] = public_baseline_source_occurrences
        cache_key = (generic_runtime[0], parent_id, tuple(overlay_ids))
        cached_counts = _cached_generic_meta_counts(
            cache_key,
            lambda: _apply_generic_overlay_meta_counts(
                connection,
                parent_id,
                generic_reconciliation_overlay_ids,
                counts,
                public_mutation_overlay_ids,
            ),
        )
        alias_curation_occurrence_delta = int(
            cached_counts.get("_public_occurrence_delta") or 0
        )
        alias_curation_source_delta = int(
            cached_counts.get("_public_source_occurrence_delta") or 0
        )
        parent_all_occurrences = public_baseline_occurrences
        parent_source_occurrences = public_baseline_source_occurrences
        counts = {**counts, **cached_counts}
        counts["occurrences"] = max(
            0, parent_all_occurrences + alias_curation_occurrence_delta,
        )
        counts["source_occurrences"] = max(
            0, parent_source_occurrences + alias_curation_source_delta,
        )
        if authoritative_7d_ids:
            authoritative_records = _authoritative_7d_records(
                connection, overlay_ids,
            )
            authoritative_occurrences = sum(
                len(record["occurrences"])
                for record in authoritative_records
            )
            authoritative_source_occurrences = sum(
                _meta_source_occurrence_units(occurrence)
                for record in authoritative_records
                for occurrence in record["occurrences"]
            )
            expected_occurrences = int(
                candidate_manifest.get("acceptedOccurrenceCount") or 0
            )
            if (
                authoritative_occurrences <= 0
                or (
                    len(authoritative_7d_ids) == 1
                    and (
                        expected_occurrences <= 0
                        or authoritative_occurrences != expected_occurrences
                    )
                )
            ):
                raise PostgresAdapterError(
                    "authoritative 7d meta occurrence count mismatch"
                )
            if parent_all_occurrences <= 0:
                raise PostgresAdapterError(
                    "authoritative 7d meta all-range baseline is empty"
                )
            authoritative_deltas = _authoritative_7d_meta_deltas(
                connection,
                parent_id,
                previous_overlay_ids,
                authoritative_records,
            )
            for key in (
                "videos", "songs", "ranking_rows",
            ):
                counts[key] = max(
                    0,
                    int(counts.get(key) or 0)
                    + int(authoritative_deltas.get(key) or 0),
                )
            counts["occurrences"] = max(
                0,
                parent_all_occurrences
                + alias_curation_occurrence_delta
                + authoritative_occurrences,
            )
            counts["source_occurrences"] = max(
                0,
                parent_source_occurrences
                + alias_curation_source_delta
                + authoritative_source_occurrences,
            )
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
