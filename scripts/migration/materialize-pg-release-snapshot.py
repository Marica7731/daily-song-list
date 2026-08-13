"""Materialize WDC ranking pages from one PostgreSQL repeatable-read snapshot.

The exporter runs next to the production PostgreSQL adapter as the database
peer user.  One read-only transaction fixes the active revision for the whole
export, so later parent-CAS activations cannot mix revisions across pages.
"""

from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
from decimal import Decimal
import gc
import json
import math
import os
from pathlib import Path
import sqlite3
import tempfile
import time
from typing import Any, Callable, Iterable, Mapping, Sequence

import pg_adapter as adapter


RANGES = ("7d", "all")
VIEWS = ("songs", "artists", "vtubers", "videos")
METRICS = ("occurrences", "songs", "videos")
PAGE_SIZE = 200
SOURCE_EXPORT_VIDEO_PAGE_SIZE = 30
SCOPES = (
    ("all", False, False),
    ("niche", True, False),
    ("visible", False, True),
    ("visibleNiche", True, True),
)
MAX_RANKING_SEARCH_CHARS = 65_536
MAX_CHANNEL_SEARCH_CHARS = 32_768
MAX_SOURCE_SEARCH_CHARS = 65_536
SOURCE_SCOPE_FETCH_SIZE = 10_000
SOURCE_SCOPE_PAYLOAD_FETCH_SIZE = 64
SOURCE_SCOPE_VIDEO_BATCH = 2_500
PARENT_VIDEO_EXPORT_BATCH = 500
MAX_SOURCE_SCOPE_ROWS = 5_000_000
SOURCE_WRITE_BATCH_SIZE = 64
SQLITE_CHECKPOINT_ROWS = 2_048
SQLITE_CACHE_DROP_ROWS = 2_048


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _meta_value(meta: Mapping[str, Any], *names: str) -> str:
    for name in names:
        value = _text(meta.get(name))
        if value:
            return value
    return ""


def canonical_meta(payload: Mapping[str, Any]) -> dict[str, str]:
    raw = payload.get("meta") if isinstance(payload.get("meta"), Mapping) else payload
    marker = {
        "active_revision_id": _meta_value(raw, "active_revision_id", "activeRevisionId"),
        "content_sha256": _meta_value(raw, "content_sha256", "contentSha256"),
        "parent_revision_id": _meta_value(raw, "parent_revision_id", "parentRevisionId"),
        "source_commit_sha": _meta_value(raw, "source_commit_sha", "sourceCommitSha"),
        "built_at": _meta_value(raw, "built_at", "builtAt", "generatedAt"),
        "latest_generated_at": _meta_value(
            raw,
            "latestGeneratedAt",
            "generatedAt",
            "latest_generated_at",
        ),
    }
    missing = [name for name, value in marker.items() if not value]
    if missing:
        raise RuntimeError("snapshot meta is missing: " + ", ".join(missing))
    return marker


def ranking_query(
    range_id: str,
    view: str,
    metric: str,
    page: int,
    scope_key: str = "all",
) -> dict[str, str]:
    query = {
        "range": range_id,
        "view": view,
        "metric": metric,
        "page": str(page),
        "pageSize": str(PAGE_SIZE),
        "compact": "0",
    }
    scope = {name: (niche, hidden) for name, niche, hidden in SCOPES}.get(scope_key)
    if scope is None:
        raise ValueError(f"unsupported ranking scope: {scope_key}")
    if scope[0]:
        query["nicheOnly"] = "1"
    if scope[1]:
        query["hideUnknownArtist"] = "1"
    return query


def validate_page(
    payload: Mapping[str, Any],
    *,
    range_id: str,
    view: str,
    metric: str,
    page: int,
    expected_total: int | None = None,
) -> tuple[int, int]:
    if _text(payload.get("rangeId")) != range_id:
        raise RuntimeError(f"page range mismatch for {range_id}/{view}/{metric}/{page}")
    if _text(payload.get("view")) != view:
        raise RuntimeError(f"page view mismatch for {range_id}/{view}/{metric}/{page}")
    public_metric = "occurrences" if metric == "count" else metric
    if _text(payload.get("metric")) != public_metric:
        raise RuntimeError(f"page metric mismatch for {range_id}/{view}/{metric}/{page}")
    if int(payload.get("page") or 0) != page:
        raise RuntimeError(f"page number mismatch for {range_id}/{view}/{metric}/{page}")
    if int(payload.get("pageSize") or 0) != PAGE_SIZE:
        raise RuntimeError(f"page size mismatch for {range_id}/{view}/{metric}/{page}")
    records = payload.get("records")
    if not isinstance(records, list) or len(records) > PAGE_SIZE:
        raise RuntimeError(f"page records are invalid for {range_id}/{view}/{metric}/{page}")
    total = int(payload.get("totalCount") or 0)
    if total < 0 or (expected_total is not None and total != expected_total):
        raise RuntimeError(f"page total changed for {range_id}/{view}/{metric}/{page}")
    page_count = max(1, math.ceil(total / PAGE_SIZE))
    if int(payload.get("pageCount") or 0) != page_count:
        raise RuntimeError(f"page count mismatch for {range_id}/{view}/{metric}/{page}")
    return total, page_count


def _json_default(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(f"unsupported JSON value: {type(value).__name__}")


def _json_text(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        default=_json_default,
    )


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str) and value.strip():
        parsed = json.loads(value)
        if isinstance(parsed, Mapping):
            return dict(parsed)
    return {}


def _drop_clean_file_cache(path: Path) -> bool:
    """Flush and evict clean cache pages for one private build file only."""

    fadvise = getattr(os, "posix_fadvise", None)
    advice = getattr(os, "POSIX_FADV_DONTNEED", None)
    if not callable(fadvise) or advice is None:
        return False
    descriptor = os.open(path, os.O_RDWR)
    try:
        sync = getattr(os, "fdatasync", os.fsync)
        sync(descriptor)
        fadvise(descriptor, 0, 0, advice)
    finally:
        os.close(descriptor)
    return True


def _write_json_file_and_drop_cache(path: Path, value: Any) -> bool:
    """Stream one private JSON artifact and evict only its clean file pages.

    Ranking snapshots can contain hundreds of multi-megabyte page files.  A
    plain ``Path.write_text(_json_text(...))`` both allocates the complete
    serialized string and leaves every written page charged to the isolated
    materializer cgroup.  Keep the bytes identical to ``_json_text`` while
    writing incrementally, then flush and advise away only this exact file.
    """

    with path.open("w", encoding="utf-8", newline="") as stream:
        json.dump(
            value,
            stream,
            ensure_ascii=False,
            separators=(",", ":"),
            default=_json_default,
        )
        stream.flush()
        fadvise = getattr(os, "posix_fadvise", None)
        advice = getattr(os, "POSIX_FADV_DONTNEED", None)
        if not callable(fadvise) or advice is None:
            return False
        sync = getattr(os, "fdatasync", os.fsync)
        sync(stream.fileno())
        fadvise(stream.fileno(), 0, 0, advice)
        return True


def _integer(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _stream_pg_rows(
    connection: Any,
    label: str,
    statement: str,
    params: Sequence[Any],
    *,
    fetch_size: int = SOURCE_SCOPE_FETCH_SIZE,
) -> Iterable[dict[str, Any]]:
    """Stream one bounded snapshot query without retaining its result graph."""

    if fetch_size < 1 or fetch_size > SOURCE_SCOPE_FETCH_SIZE:
        raise ValueError(f"invalid snapshot source fetch size: {fetch_size}")
    cursor = None
    if getattr(connection, "autocommit", True) is False:
        try:
            cursor = connection.cursor(
                name=f"dsl_source_{label}_{os.getpid()}_{time.monotonic_ns()}"[:63]
            )
        except TypeError:
            cursor = None
    if cursor is None:
        rows = adapter._rows(connection, statement, params)
        if len(rows) > MAX_SOURCE_SCOPE_ROWS:
            raise RuntimeError(f"snapshot source {label} exceeded streamed row cap")
        yield from rows
        return
    try:
        if hasattr(cursor, "itersize"):
            cursor.itersize = fetch_size
        cursor.execute(statement, list(params))
        description = cursor.description or ()
        names = [
            column.name if hasattr(column, "name") else column[0]
            for column in description
        ]
        total = 0
        while True:
            values = cursor.fetchmany(fetch_size)
            if not values:
                return
            total += len(values)
            if total > MAX_SOURCE_SCOPE_ROWS:
                raise RuntimeError(f"snapshot source {label} exceeded streamed row cap")
            for value in values:
                yield dict(zip(names, value))
            # A server-side cursor still materializes one client batch.  Drop
            # payload-bearing tuples before fetching the next batch instead
            # of retaining the prior 10,000-row graph in the generator frame.
            value = None
            values = None
    finally:
        close = getattr(cursor, "close", None)
        if close:
            close()


class SnapshotSourceScope:
    """Disk-backed source-key to affected-video index for one immutable build."""

    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection
        self.connection.executescript("""
        CREATE TEMP TABLE source_scope_videos(
          video_id TEXT PRIMARY KEY
        ) WITHOUT ROWID;
        CREATE TEMP TABLE source_scope_pairs(
          source_key TEXT NOT NULL,
          video_id TEXT NOT NULL,
          PRIMARY KEY(source_key,video_id)
        ) WITHOUT ROWID;
        CREATE TEMP TABLE source_scope_targets(
          view TEXT NOT NULL,
          group_key TEXT NOT NULL,
          source_key TEXT NOT NULL,
          PRIMARY KEY(view,group_key,source_key)
        ) WITHOUT ROWID;
        """)

    def add_videos(self, values: Iterable[str]) -> None:
        self.connection.executemany(
            "INSERT OR IGNORE INTO source_scope_videos(video_id) VALUES(?)",
            ((_text(value),) for value in values if _text(value)),
        )

    def add_pairs(self, values: Iterable[tuple[str, str]]) -> None:
        self.connection.executemany(
            "INSERT OR IGNORE INTO source_scope_pairs(source_key,video_id) VALUES(?,?)",
            (
                (_text(source_key), _text(video_id))
                for source_key, video_id in values
                if _text(source_key) and _text(video_id)
            ),
        )

    def add_targets(self, values: Iterable[tuple[str, str, str]]) -> None:
        self.connection.executemany(
            "INSERT OR IGNORE INTO source_scope_targets(view,group_key,source_key) "
            "VALUES(?,?,?)",
            (
                (_text(view), _text(group_key), _text(source_key))
                for view, group_key, source_key in values
                if _text(view) and _text(group_key) and _text(source_key)
            ),
        )

    def source_keys_for_group(self, view: str, group_key: str) -> tuple[str, ...]:
        return tuple(
            str(row[0])
            for row in self.connection.execute(
                "SELECT source_key FROM source_scope_targets "
                "WHERE view=? AND group_key=? ORDER BY source_key",
                (view, group_key),
            )
        )

    def affected_videos(self) -> tuple[str, ...]:
        return tuple(
            str(row[0])
            for row in self.connection.execute(
                "SELECT video_id FROM source_scope_videos ORDER BY video_id"
            )
        )

    def videos_for_source(self, source_key: str) -> tuple[str, ...]:
        return tuple(
            str(row[0])
            for row in self.connection.execute(
                "SELECT video_id FROM source_scope_pairs "
                "WHERE source_key=? ORDER BY video_id",
                (source_key,),
            )
        )

    def unaffected_parent_video_sources(self) -> tuple[tuple[str, str], ...]:
        """Return parent video-card keys whose videos have no overlay delta."""

        return tuple(
            (str(row[0]), str(row[1]))
            for row in self.connection.execute(
                "SELECT pair.source_key,pair.video_id "
                "FROM source_scope_pairs AS pair "
                "JOIN source_scope_targets AS target "
                "  ON target.view='videos' "
                " AND target.source_key=pair.source_key "
                " AND target.group_key=pair.video_id "
                "LEFT JOIN source_scope_videos AS affected "
                "  ON affected.video_id=pair.video_id "
                "WHERE affected.video_id IS NULL "
                "ORDER BY pair.source_key,pair.video_id"
            )
        )

    def stats(self) -> dict[str, int]:
        return {
            "videos": int(self.connection.execute(
                "SELECT count(*) FROM source_scope_videos"
            ).fetchone()[0]),
            "pairs": int(self.connection.execute(
                "SELECT count(*) FROM source_scope_pairs"
            ).fetchone()[0]),
            "sources": int(self.connection.execute(
                "SELECT count(DISTINCT source_key) FROM source_scope_pairs"
            ).fetchone()[0]),
            "targets": int(self.connection.execute(
                "SELECT count(*) FROM source_scope_targets"
            ).fetchone()[0]),
        }


def _production_source_key(view: str, range_id: str, group_key: str) -> str:
    return _text(adapter._production_source_detail_key_for_group(
        view, range_id, group_key,
    ))


def _derived_source_pairs(
    *,
    video_ids: Iterable[str],
    song_pairs: Iterable[tuple[str, str]] = (),
    channel_keys: Iterable[str] = (),
    requested_keys: set[str],
    source_scope: SnapshotSourceScope | None = None,
) -> set[tuple[str, str]]:
    videos = {_text(value) for value in video_ids if _text(value)}
    pairs: set[tuple[str, str]] = set()
    for video_id in videos:
        source_key = adapter._stable_key("source-video", "all", video_id)
        if source_key in requested_keys:
            pairs.add((source_key, video_id))
    for title, artist in song_pairs:
        normalized_title = adapter._overlay_norm(title)
        normalized_artist = adapter._overlay_norm(artist)
        if not normalized_title:
            continue
        song_group_key = f"{normalized_title}::{normalized_artist}"
        song_keys = {_production_source_key(
            "songs", "all", song_group_key,
        )}
        artist_group_key = normalized_artist or "unknown"
        artist_keys = {_production_source_key(
            "artists", "all", normalized_artist or "unknown",
        )}
        if source_scope is not None:
            canonical_song_group = "\x1f".join((
                adapter._overlay_song_group_norm(title),
                adapter._overlay_song_group_norm(artist),
            ))
            song_keys.update(source_scope.source_keys_for_group(
                "songs", canonical_song_group,
            ))
            artist_keys.update(source_scope.source_keys_for_group(
                "artists", artist_group_key,
            ))
        for source_key in (*song_keys, *artist_keys):
            if source_key in requested_keys:
                pairs.update((source_key, video_id) for video_id in videos)
    for channel_key in {_text(value) for value in channel_keys if _text(value)}:
        source_keys = {_production_source_key("vtubers", "all", channel_key)}
        if source_scope is not None:
            source_keys.update(source_scope.source_keys_for_group(
                "vtubers", channel_key,
            ))
        for source_key in source_keys:
            if source_key in requested_keys:
                pairs.update((source_key, video_id) for video_id in videos)
    return pairs


def _runtime_scope_evidence(
    value: Any,
) -> tuple[set[str], set[tuple[str, str]], set[str], set[str]]:
    """Extract conservative immutable scope evidence from one runtime event."""

    videos: set[str] = set()
    songs: set[tuple[str, str]] = set()
    channels: set[str] = set()
    ranges: set[str] = set()
    queue: list[Any] = [value]
    visited = 0
    while queue:
        current = queue.pop()
        visited += 1
        if visited > 512:
            raise RuntimeError("snapshot runtime source scope exceeded bounded shape")
        if isinstance(current, Mapping):
            video_id = _text(
                current.get("videoId")
                or current.get("video_id")
                or current.get("youtubeVideoId")
                or current.get("externalVideoId")
            )
            if video_id:
                videos.add(video_id)
            title = _text(current.get("title") or current.get("workTitle"))
            if title and "artist" in current:
                songs.add((title, _text(current.get("artist"))))
            channel_id = _text(current.get("channelId") or current.get("channel_id"))
            channel_handle = _text(
                current.get("channelHandle") or current.get("channel_handle")
            ).lstrip("@/")
            channel_name = adapter._overlay_norm(
                current.get("channelName") or current.get("channel_name")
            )
            channel_key = channel_id or channel_handle or channel_name
            if channel_key:
                channels.add(channel_key)
            range_id = _text(current.get("rangeId") or current.get("range_id"))
            if range_id:
                ranges.add(range_id)
            for nested in current.values():
                if isinstance(nested, (Mapping, list, tuple)):
                    queue.append(nested)
        elif isinstance(current, (list, tuple)):
            queue.extend(current)
    return videos, songs, channels, ranges


def build_snapshot_source_scope(
    connection: Any,
    sqlite_connection: sqlite3.Connection,
    *,
    overlay_revision_ids: Sequence[str],
    source_revision_ids: Sequence[str],
    requested_keys: Iterable[str],
) -> SnapshotSourceScope:
    """Build one scalar-only overlay index shared by every all-range source."""

    requested = {_text(value) for value in requested_keys if _text(value)}
    scope = SnapshotSourceScope(sqlite_connection)
    revision_ids = [_text(value) for value in overlay_revision_ids if _text(value)]
    if not revision_ids or not requested:
        return scope
    source_lineage = [_text(value) for value in source_revision_ids if _text(value)]
    if not source_lineage:
        raise RuntimeError("snapshot source scope has no source lineage")
    parent_revision_id = source_lineage[-1]

    target_buffer: list[tuple[str, str, str]] = []
    parent_video_pair_buffer: list[tuple[str, str]] = []
    for row in _stream_pg_rows(
        connection,
        "targets",
        """
        SELECT view,detail_key,title,artist,
               coalesce(payload_json::jsonb->>'sourceDetailKey','') AS source_key
        FROM runtime_ranking_rows
        WHERE revision_id = %s AND range_id = 'all'
          AND view = ANY(%s) AND metric = 'count' AND scope_key = 'all'
          AND (
            view = 'videos'
            OR coalesce(payload_json::jsonb->>'sourceDetailKey','') = ANY(%s)
          )
        ORDER BY view,detail_key
        LIMIT %s
        """,
        [
            parent_revision_id,
            ["songs", "songIndex", "artists", "vtubers", "videos"],
            sorted(requested),
            MAX_SOURCE_SCOPE_ROWS + 1,
        ],
    ):
        view = _text(row.get("view"))
        source_key = _text(row.get("source_key"))
        if view in {"songs", "songIndex"}:
            view = "songs"
            group_key = "\x1f".join((
                adapter._overlay_song_group_norm(row.get("title")),
                adapter._overlay_song_group_norm(row.get("artist")),
            ))
        elif view == "artists":
            group_key = _text(row.get("detail_key")) or adapter._overlay_norm(
                row.get("artist")
            )
        elif view == "vtubers":
            group_key = _text(row.get("detail_key"))
        elif view == "videos":
            group_key = _text(row.get("detail_key"))
            expected_key = adapter._stable_key(
                "source-video", "all", group_key,
            ) if group_key else ""
            if expected_key not in requested:
                continue
            if source_key and source_key != expected_key:
                raise RuntimeError(
                    "parent video ranking has an invalid source key: "
                    f"video={group_key} expected={expected_key} "
                    f"actual={source_key}"
                )
            source_key = expected_key
        else:
            continue
        if group_key and source_key:
            target_buffer.append((view, group_key, source_key))
            if view == "videos":
                parent_video_pair_buffer.append((source_key, group_key))
        if len(target_buffer) >= SOURCE_SCOPE_FETCH_SIZE:
            scope.add_targets(target_buffer)
            scope.add_pairs(parent_video_pair_buffer)
            target_buffer = []
            parent_video_pair_buffer = []
    scope.add_targets(target_buffer)
    scope.add_pairs(parent_video_pair_buffer)
    target_buffer = []
    parent_video_pair_buffer = []
    row = None
    _release_source_scope_stage("targets")

    pair_buffer: list[tuple[str, str]] = []
    video_buffer: list[str] = []

    def flush() -> None:
        nonlocal pair_buffer, video_buffer
        if video_buffer:
            scope.add_videos(video_buffer)
            video_buffer = []
        if pair_buffer:
            scope.add_pairs(pair_buffer)
            pair_buffer = []

    for row in _stream_pg_rows(
        connection,
        "videos",
        """
        SELECT video_id,channel_id,channel_handle,channel_name,
               coalesce(
                 payload_json::jsonb->>'partialRangeReset',
                 payload_json::jsonb->'payload'->>'partialRangeReset',
                 ''
               ) = 'true' AS partial_range_reset,
               coalesce(
                 payload_json::jsonb->>'rangeId',
                 payload_json::jsonb->>'range',
                 payload_json::jsonb->'payload'->>'rangeId',
                 payload_json::jsonb->'payload'->>'range',
                 ''
               ) AS partial_range_id
        FROM migration_video_rows
        WHERE revision_id = ANY(%s)
        LIMIT %s
        """,
        [revision_ids, MAX_SOURCE_SCOPE_ROWS + 1],
    ):
        if adapter._is_partial_range_video_row(row):
            continue
        video_id = _text(row.get("video_id"))
        if not video_id:
            continue
        video_buffer.append(video_id)
        channel_key = (
            _text(row.get("channel_id"))
            or _text(row.get("channel_handle")).lstrip("@/")
            or adapter._overlay_norm(row.get("channel_name"))
        )
        pair_buffer.extend(_derived_source_pairs(
            video_ids=(video_id,),
            channel_keys=(channel_key,),
            requested_keys=requested,
            source_scope=scope,
        ))
        if len(video_buffer) + len(pair_buffer) >= SOURCE_SCOPE_FETCH_SIZE:
            flush()
    flush()
    row = None
    _release_source_scope_stage("videos")

    for row in _stream_pg_rows(
        connection,
        "occurrences",
        """
        SELECT video_id,range_id,title,artist
        FROM migration_occurrence_rows
        WHERE revision_id = ANY(%s)
          AND coalesce(range_id,'') IN ('all','')
        LIMIT %s
        """,
        [revision_ids, MAX_SOURCE_SCOPE_ROWS + 1],
    ):
        video_id = _text(row.get("video_id"))
        title = _text(row.get("title"))
        artist = _text(row.get("artist"))
        if not video_id:
            continue
        video_buffer.append(video_id)
        pair_buffer.extend(_derived_source_pairs(
            video_ids=(video_id,),
            song_pairs=((title, artist),) if title else (),
            requested_keys=requested,
            source_scope=scope,
        ))
        if len(video_buffer) + len(pair_buffer) >= SOURCE_SCOPE_FETCH_SIZE:
            flush()
    flush()
    row = None
    _release_source_scope_stage("occurrences")

    # The all-range ranking contract projects physical 7d occurrences only
    # for already-selected non-partial full-video resets.  Add those exact
    # song/artist/channel identities to the disk-backed source scope as well;
    # ordinary 7d rows and partialRangeReset metadata remain excluded.
    accepted_resets = adapter._accepted_video_resets(
        connection,
        revision_ids,
        include_payload=False,
    )
    compatible_reset_rows = adapter._selected_full_reset_candidate_rows(
        connection,
        revision_ids,
        accepted_resets,
        "all",
        include_payload=False,
    )
    for row in compatible_reset_rows:
        video_id = _text(row.get("video_id") or row.get("videoId"))
        title = _text(row.get("title"))
        artist = _text(row.get("artist"))
        if not video_id:
            continue
        video_buffer.append(video_id)
        channel_key = (
            _text(row.get("channel_id") or row.get("channelId"))
            or _text(
                row.get("channel_handle") or row.get("channelHandle")
            ).lstrip("@/")
            or adapter._overlay_norm(
                row.get("channel_name") or row.get("channelName")
            )
        )
        pair_buffer.extend(_derived_source_pairs(
            video_ids=(video_id,),
            song_pairs=((title, artist),) if title else (),
            channel_keys=(channel_key,),
            requested_keys=requested,
            source_scope=scope,
        ))
        if len(video_buffer) + len(pair_buffer) >= SOURCE_SCOPE_FETCH_SIZE:
            flush()
    flush()
    row = None
    compatible_reset_rows = None
    accepted_resets = None
    _release_source_scope_stage("compatible_resets")

    for row in _stream_pg_rows(
        connection,
        "runtime",
        """
        SELECT range_id,payload_json
        FROM migration_runtime_rows
        WHERE revision_id = ANY(%s)
          AND coalesce(range_id,'') IN ('all','')
        LIMIT %s
        """,
        [revision_ids, MAX_SOURCE_SCOPE_ROWS + 1],
        fetch_size=SOURCE_SCOPE_PAYLOAD_FETCH_SIZE,
    ):
        payload = _json_object(row.get("payload_json"))
        videos, songs, channels, payload_ranges = _runtime_scope_evidence(payload)
        if payload_ranges and not payload_ranges.intersection({"all", ""}):
            continue
        video_buffer.extend(videos)
        pair_buffer.extend(_derived_source_pairs(
            video_ids=videos,
            song_pairs=songs,
            channel_keys=channels,
            requested_keys=requested,
            source_scope=scope,
        ))
        if len(video_buffer) + len(pair_buffer) >= SOURCE_SCOPE_FETCH_SIZE:
            flush()
    flush()
    row = None
    payload = None
    videos = songs = channels = payload_ranges = None
    _release_source_scope_stage("runtime")

    scalar_stats = scope.stats()
    if scalar_stats["videos"] > MAX_SOURCE_SCOPE_ROWS:
        raise RuntimeError("snapshot source scope exceeded affected-video cap")
    affected_videos = scope.affected_videos()
    for offset in range(0, len(affected_videos), SOURCE_SCOPE_VIDEO_BATCH):
        batch = affected_videos[offset : offset + SOURCE_SCOPE_VIDEO_BATCH]
        mapping_buffer: list[tuple[str, str]] = []
        for row in _stream_pg_rows(
            connection,
            f"parents_{offset // SOURCE_SCOPE_VIDEO_BATCH}",
            """
            SELECT DISTINCT source_key,video_id
            FROM runtime_source_occurrences
            WHERE revision_id = ANY(%s)
              AND range_id = 'all'
              AND video_id = ANY(%s)
              AND source_key = ANY(%s)
            ORDER BY source_key,video_id
            LIMIT %s
            """,
            [source_lineage, list(batch), sorted(requested), MAX_SOURCE_SCOPE_ROWS + 1],
        ):
            mapping_buffer.append((_text(row.get("source_key")), _text(row.get("video_id"))))
            if len(mapping_buffer) >= SOURCE_SCOPE_FETCH_SIZE:
                scope.add_pairs(mapping_buffer)
                mapping_buffer = []
        scope.add_pairs(mapping_buffer)
    affected_videos = ()
    batch = ()
    mapping_buffer = []
    row = None
    _release_source_scope_stage("parents")

    stats = scope.stats()
    if stats["pairs"] > MAX_SOURCE_SCOPE_ROWS:
        raise RuntimeError("snapshot source scope exceeded source-video pair cap")
    print(
        f"PG_SNAPSHOT_SOURCE_SCOPE videos={stats['videos']} "
        f"sources={stats['sources']} pairs={stats['pairs']}",
        flush=True,
    )
    return scope


class _BoundedTextAccumulator:
    """Preserve bounded-text order/dedup without retaining every source row."""

    def __init__(self, limit: int):
        self.limit = limit
        self.values: list[str] = []
        self.seen: set[str] = set()
        self.size = 0
        self.full = False

    def add(self, raw: Any) -> None:
        if self.full:
            return
        value = _text(raw)
        if not value or value in self.seen:
            return
        self.seen.add(value)
        remaining = self.limit - self.size - (1 if self.values else 0)
        if remaining <= 0:
            self.full = True
            return
        value = value[:remaining]
        self.values.append(value)
        self.size += len(value) + (1 if len(self.values) > 1 else 0)
        if self.size >= self.limit:
            self.full = True

    @property
    def text(self) -> str:
        return " ".join(self.values)[:self.limit]


def _bounded_text(parts: Iterable[Any], limit: int) -> str:
    accumulator = _BoundedTextAccumulator(limit)
    for raw in parts:
        accumulator.add(raw)
    return accumulator.text


def _current_process_status_kib(field: str) -> int:
    try:
        for line in Path("/proc/self/status").read_text(encoding="utf-8").splitlines():
            if line.startswith(f"{field}:"):
                return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        pass
    return -1


def _current_rss_kib() -> int:
    return _current_process_status_kib("VmRSS")


def _current_swap_kib() -> int:
    return _current_process_status_kib("VmSwap")


def _trim_process_heap() -> bool:
    """Collect unreachable graphs and return idle glibc pages to the host."""

    gc.collect()
    try:
        import ctypes

        trim = getattr(ctypes.CDLL(None), "malloc_trim", None)
        if trim is None:
            return False
        trim.argtypes = [ctypes.c_size_t]
        trim.restype = ctypes.c_int
        return bool(trim(0))
    except (AttributeError, ImportError, OSError, TypeError):
        return False


def _release_ranking_combo_memory(
    *,
    range_id: str,
    view: str,
    metric: str,
    scope_key: str,
) -> None:
    """Release one prepared ranking aggregate before building the next one."""

    trimmed = _trim_process_heap()
    rss_kib = _current_rss_kib()
    swap_kib = _current_swap_kib()
    print(
        f"PG_SNAPSHOT_COMBO_RELEASE {range_id}/{view}/{metric}/{scope_key} "
        f"rss_kib={rss_kib if rss_kib >= 0 else 'unknown'} "
        f"swap_kib={swap_kib if swap_kib >= 0 else 'unknown'} "
        f"trimmed={int(trimmed)}",
        flush=True,
    )


def _release_source_scope_stage(stage: str) -> None:
    """Return payload-batch memory between disk-backed scope stages."""

    trimmed = _trim_process_heap()
    rss_kib = _current_rss_kib()
    swap_kib = _current_swap_kib()
    print(
        f"PG_SNAPSHOT_SOURCE_SCOPE_STAGE stage={stage} "
        f"rss_kib={rss_kib if rss_kib >= 0 else 'unknown'} "
        f"swap_kib={swap_kib if swap_kib >= 0 else 'unknown'} "
        f"trimmed={int(trimmed)}",
        flush=True,
    )


def _release_materializer_memory(
    writer: "CanonicalSnapshotWriter",
    builder: Any,
    *,
    phase: str,
    drop_authoritative: bool = False,
) -> None:
    """Release phase-local payload graphs while preserving the PG snapshot."""

    if drop_authoritative and hasattr(builder, "authoritative_records"):
        builder.authoritative_records = None
    reconciliation_counts = getattr(builder, "reconciliation_counts", None)
    if isinstance(reconciliation_counts, dict):
        reconciliation_counts.clear()
    snapshot_reset_changes = getattr(builder, "snapshot_reset_changes", None)
    if isinstance(snapshot_reset_changes, dict):
        snapshot_reset_changes.clear()
    snapshot_original_group_counts = getattr(
        builder, "snapshot_original_group_counts", None,
    )
    if isinstance(snapshot_original_group_counts, dict):
        snapshot_original_group_counts.clear()
    snapshot_vtuber_source_totals = getattr(
        builder, "snapshot_vtuber_source_totals", None,
    )
    if isinstance(snapshot_vtuber_source_totals, dict):
        snapshot_vtuber_source_totals.clear()
    for name in (
        "_GENERIC_RANKING_PREPARATION_CACHE",
        "_GENERIC_META_COUNTS_CACHE",
        "_VTUBER_REPLACEMENT_CACHE",
    ):
        cache = getattr(adapter, name, None)
        clear = getattr(cache, "clear", None)
        if callable(clear):
            clear()
    writer.checkpoint(shrink=True)
    trimmed = _trim_process_heap()
    rss_kib = _current_rss_kib()
    swap_kib = _current_swap_kib()
    print(
        f"PG_SNAPSHOT_MEMORY_RELEASE phase={phase} "
        f"rss_kib={rss_kib if rss_kib >= 0 else 'unknown'} "
        f"swap_kib={swap_kib if swap_kib >= 0 else 'unknown'} "
        f"trimmed={int(trimmed)}",
        flush=True,
    )


def _flatten_scalars(value: Any, *, channel_only: bool = False) -> Iterable[str]:
    stack: list[tuple[str, Any]] = [("", value)]
    while stack:
        key, item = stack.pop()
        if isinstance(item, Mapping):
            for child_key, child in reversed(list(item.items())):
                stack.append((str(child_key), child))
            continue
        if isinstance(item, (list, tuple)):
            for child in reversed(item):
                stack.append((key, child))
            continue
        if item is None or isinstance(item, bool):
            continue
        if channel_only and not any(
            marker in key.casefold()
            for marker in ("channel", "handle", "vtuber", "singer")
        ):
            continue
        if isinstance(item, (str, int, float, Decimal)):
            yield str(item)


def _ranking_row(
    record: Mapping[str, Any],
    *,
    payload_record: Mapping[str, Any],
    range_id: str,
    view: str,
    metric: str,
    scope_key: str,
    expected_rank: int,
) -> tuple[Any, ...]:
    rank = _integer(record.get("rank"))
    if rank != expected_rank:
        raise RuntimeError(
            f"ranking rank mismatch for {range_id}/{view}/{metric}/{scope_key}: "
            f"expected={expected_rank} actual={rank}"
        )
    detail_key = _text(record.get("sourceDetailKey"))
    title = _text(record.get("title") or record.get("workTitle"))
    artist = _text(record.get("displayArtist") or record.get("artist"))
    name = _text(record.get("name") or record.get("channelName") or title)
    entity_key = _text(record.get("key") or record.get("videoId") or detail_key)
    db_metric = "count" if metric == "occurrences" else metric
    row_id = ":".join(
        (range_id, view, db_metric, scope_key, str(rank), entity_key or detail_key)
    )
    return (
        row_id,
        range_id,
        view,
        db_metric,
        scope_key,
        rank,
        detail_key,
        title,
        artist,
        name,
        _integer(record.get("count") or record.get("timestampCount")),
        _integer(record.get("songCount")),
        _integer(record.get("videoCount")),
        _integer(record.get("timestampCount") or record.get("count")),
        _json_text(dict(payload_record)),
        _bounded_text(
            _flatten_scalars(record),
            MAX_RANKING_SEARCH_CHARS,
        ),
        _bounded_text(
            _flatten_scalars(record, channel_only=True),
            MAX_CHANNEL_SEARCH_CHARS,
        ),
    )


def _nested_mapping(value: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    nested = value.get(name)
    return nested if isinstance(nested, Mapping) else {}


def _occurrence_value(item: Mapping[str, Any], *names: str) -> Any:
    nested_item = _nested_mapping(item, "item")
    nested_video = _nested_mapping(item, "video")
    for source in (item, nested_item, nested_video):
        for name in names:
            value = source.get(name)
            if value not in (None, ""):
                return value
    return None


def _timestamp(value: Any) -> int | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return int(moment.timestamp())
    try:
        return int(float(value))
    except (TypeError, ValueError, OverflowError):
        pass
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def _source_occurrence_row(
    source_key: str,
    range_id: str,
    position: int,
    raw: Mapping[str, Any],
    *,
    entity_type: str,
) -> tuple[Any, ...]:
    item = dict(raw)
    payload = _nested_mapping(item, "payload")
    if payload:
        item = {**payload, **{key: value for key, value in item.items() if key != "payload"}}
    video_id = _text(
        _occurrence_value(item, "videoId", "video_id", "youtubeVideoId", "externalVideoId")
    )
    if not video_id:
        raise RuntimeError(f"source occurrence has no video identity: {range_id}/{source_key}")
    song = _nested_mapping(item, "song")
    song_title = _text(song.get("title") or item.get("songTitle"))
    artist = _text(song.get("artist") or item.get("artist") or item.get("songArtist"))
    if entity_type == "vtuber":
        canonical_song_name, canonical_song_key = (
            adapter._vtuber_canonical_song_identity(song_title)
        )
    else:
        canonical_song_name = song_title
        song_identity = {**dict(song), "title": song_title, "artist": artist}
        if not _text(song_identity.get("songKey")) and item.get("songKey") is not None:
            song_identity["songKey"] = item.get("songKey")
        canonical_song_key = (
            adapter._song_key(song_identity)
            if song_title
            else ""
        )
    explicit_unknown = item.get("isUnknownArtist")
    if explicit_unknown is None:
        explicit_unknown = song.get("isUnknownArtist")
    is_unknown = (
        bool(explicit_unknown)
        if explicit_unknown is not None
        else adapter._unknown_artist_name(artist)
    )
    is_niche = bool(item.get("isNiche") is True or song.get("isNiche") is True)
    published = _occurrence_value(
        item, "publishedTimestamp", "publishedAt", "published_at", "streamedAt"
    )
    seconds_raw = _occurrence_value(item, "seconds")
    seconds = None if seconds_raw in (None, "") else _integer(seconds_raw)
    return (
        source_key,
        range_id,
        position,
        video_id,
        _text(_occurrence_value(item, "videoTitle", "title")),
        _text(_occurrence_value(item, "channelName", "channel_name")),
        _text(_occurrence_value(item, "channelId", "channel_id")),
        _text(_occurrence_value(item, "channelHandle", "channel_handle")),
        _text(_occurrence_value(item, "channelUrl", "channel_url")),
        _timestamp(published),
        seconds,
        1 if is_niche else 0,
        1 if is_unknown else 0,
        canonical_song_key,
        canonical_song_name,
        _bounded_text(_flatten_scalars(item), MAX_SOURCE_SEARCH_CHARS),
        _json_text(item),
    )


class CanonicalSnapshotWriter:
    def __init__(self, output: Path):
        if output.exists():
            raise FileExistsError(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temp_name = tempfile.mkstemp(
            prefix=f".{output.name}.", suffix=".tmp", dir=output.parent
        )
        os.close(descriptor)
        self.output = output
        self.temp = Path(temp_name)
        self.connection = sqlite3.connect(self.temp)
        self.connection.executescript("""
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        PRAGMA temp_store=FILE;
        PRAGMA cache_size=-32768;
        PRAGMA mmap_size=0;
        PRAGMA temp.cache_size=-8192;
        CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE source_details(
          source_key TEXT NOT NULL,range_id TEXT NOT NULL,entity_type TEXT NOT NULL,
          entity_key TEXT NOT NULL,payload_json TEXT NOT NULL,
          PRIMARY KEY(source_key,range_id)
        ) WITHOUT ROWID;
        CREATE TABLE source_occurrences(
          source_key TEXT NOT NULL,range_id TEXT NOT NULL,position INTEGER NOT NULL,
          video_id TEXT NOT NULL,title TEXT NOT NULL,channel_name TEXT NOT NULL,
          channel_id TEXT NOT NULL,channel_handle TEXT NOT NULL,channel_url TEXT NOT NULL,
          published_timestamp INTEGER,seconds INTEGER,is_niche INTEGER NOT NULL,
          is_unknown_artist INTEGER NOT NULL,canonical_song_key TEXT NOT NULL,
          canonical_song_name TEXT NOT NULL,search_text TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY(source_key,range_id,position)
        ) WITHOUT ROWID;
        CREATE TABLE ranking_rows(
          row_id TEXT NOT NULL,range_id TEXT NOT NULL,view TEXT NOT NULL,metric TEXT NOT NULL,
          scope_key TEXT NOT NULL,rank INTEGER NOT NULL,detail_key TEXT NOT NULL,title TEXT NOT NULL,
          artist TEXT NOT NULL,name TEXT NOT NULL,count INTEGER NOT NULL,song_count INTEGER NOT NULL,
          video_count INTEGER NOT NULL,timestamp_count INTEGER NOT NULL,payload_json TEXT NOT NULL,
          search_text TEXT NOT NULL,channel_search_text TEXT NOT NULL,
          PRIMARY KEY(range_id,view,metric,scope_key,rank)
        ) WITHOUT ROWID;
        CREATE INDEX ranking_rows_source_lookup
          ON ranking_rows(range_id,detail_key);
        """)
        self.ranking_rows = 0
        self.source_details = 0
        self.source_occurrences = 0
        self._pending_writes = 0
        self._cache_drop_pending_writes = 0
        self.cache_drop_attempts = 0
        self.cache_drop_count = 0
        self.max_source_write_batch = 0

    def _drop_file_cache(self, reason: str) -> None:
        self.cache_drop_attempts += 1
        dropped = _drop_clean_file_cache(self.temp)
        self.cache_drop_count += int(dropped)
        self._cache_drop_pending_writes = 0
        print(
            f"PG_SNAPSHOT_FILE_CACHE_DROP reason={reason} "
            f"bytes={self.temp.stat().st_size} dropped={int(dropped)}",
            flush=True,
        )

    def _record_writes(self, count: int) -> None:
        self._pending_writes += count
        self._cache_drop_pending_writes += count
        if self._pending_writes >= SQLITE_CHECKPOINT_ROWS:
            # This database is a private temporary candidate until finish()
            # atomically renames it.  Intermediate SQLite commits therefore
            # release dirty pages without weakening release atomicity.
            self.connection.commit()
            self._pending_writes = 0
        if self._cache_drop_pending_writes >= SQLITE_CACHE_DROP_ROWS:
            self.connection.commit()
            self._pending_writes = 0
            self._drop_file_cache("periodic")

    def checkpoint(self, *, shrink: bool = False) -> None:
        self.connection.commit()
        self._pending_writes = 0
        if shrink:
            self.connection.execute("PRAGMA shrink_memory")
        self._drop_file_cache("checkpoint")

    def add_ranking(self, row: Sequence[Any]) -> None:
        self.connection.execute(
            "INSERT INTO ranking_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            tuple(row),
        )
        self.ranking_rows += 1
        self._record_writes(1)

    def begin_source(
        self,
        source_key: str,
        range_id: str,
        record: Mapping[str, Any],
    ) -> dict[str, Any]:
        entity_type = _text(record.get("type") or record.get("entityType") or "source")
        entity_key = _text(
            record.get("key") or record.get("entityKey") or record.get("videoId") or source_key
        )
        detail = dict(record)
        detail.pop("occurrences", None)
        detail["sourceDetailKey"] = source_key
        detail["rangeId"] = range_id
        self.connection.execute(
            "INSERT INTO source_details VALUES(?,?,?,?,?)",
            (source_key, range_id, entity_type, entity_key, _json_text(detail)),
        )
        self.source_details += 1
        self._record_writes(1)
        return {
            "source_key": source_key,
            "range_id": range_id,
            "entity_type": entity_type,
            "position": 0,
            "source_search": _BoundedTextAccumulator(MAX_RANKING_SEARCH_CHARS),
            "channel_search": _BoundedTextAccumulator(MAX_CHANNEL_SEARCH_CHARS),
        }

    def add_source_occurrences(
        self,
        state: dict[str, Any],
        occurrences: Iterable[Mapping[str, Any]],
    ) -> int:
        source_key = _text(state["source_key"])
        range_id = _text(state["range_id"])
        source_search = state["source_search"]
        channel_search = state["channel_search"]
        rows: list[tuple[Any, ...]] = []
        written = 0

        def flush() -> None:
            nonlocal written
            if not rows:
                return
            self.max_source_write_batch = max(self.max_source_write_batch, len(rows))
            self.connection.executemany(
                "INSERT INTO source_occurrences VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                rows,
            )
            count = len(rows)
            self.source_occurrences += count
            written += count
            self._record_writes(count)
            rows.clear()

        for raw in occurrences:
            state["position"] = int(state["position"]) + 1
            row = _source_occurrence_row(
                source_key,
                range_id,
                int(state["position"]),
                raw,
                entity_type=_text(state["entity_type"]),
            )
            source_search.add(row[15])
            for value in (row[5], row[6], row[7], row[8]):
                channel_search.add(value)
            rows.append(row)
            if len(rows) >= SOURCE_WRITE_BATCH_SIZE:
                flush()
        flush()
        return written

    def finish_source(self, state: Mapping[str, Any]) -> int:
        source_key = _text(state["source_key"])
        range_id = _text(state["range_id"])
        self.connection.execute(
            """
            UPDATE ranking_rows
            SET search_text=substr(trim(search_text || ' ' || ?),1,?),
                channel_search_text=substr(trim(channel_search_text || ' ' || ?),1,?)
            WHERE range_id=? AND detail_key=?
            """,
            (
                state["source_search"].text,
                MAX_RANKING_SEARCH_CHARS,
                state["channel_search"].text,
                MAX_CHANNEL_SEARCH_CHARS,
                range_id,
                source_key,
            ),
        )
        self._record_writes(1)
        return int(state["position"])

    def add_source(
        self,
        source_key: str,
        range_id: str,
        record: Mapping[str, Any],
        occurrences: Iterable[Mapping[str, Any]],
    ) -> None:
        state = self.begin_source(source_key, range_id, record)
        self.add_source_occurrences(state, occurrences)
        self.finish_source(state)

    def add_meta(self, values: Mapping[str, Any]) -> None:
        self.connection.executemany(
            "INSERT INTO meta(key,value) VALUES(?,?)",
            sorted((str(key), str(value)) for key, value in values.items()),
        )

    def finish(self) -> dict[str, Any]:
        self.checkpoint(shrink=True)
        quick = str(self.connection.execute("PRAGMA quick_check").fetchone()[0])
        if quick.casefold() != "ok":
            raise RuntimeError(f"canonical snapshot quick_check failed: {quick}")
        self.connection.commit()
        self.connection.close()
        self._drop_file_cache("quick-check")
        os.replace(self.temp, self.output)
        return {
            "ranking_rows": self.ranking_rows,
            "source_details": self.source_details,
            "source_occurrences": self.source_occurrences,
            "snapshot_bytes": self.output.stat().st_size,
            "quick_check": quick,
            "cache_drop_attempts": self.cache_drop_attempts,
            "cache_drop_count": self.cache_drop_count,
        }

    def abort(self) -> None:
        try:
            self.connection.close()
        finally:
            self.temp.unlink(missing_ok=True)


def _source_query(
    range_id: str,
    page: int,
    page_size: int = PAGE_SIZE,
) -> dict[str, str]:
    return {
        "range": range_id,
        "page": str(page),
        "pageSize": str(page_size),
    }


def export_source(
    connection: Any,
    writer: CanonicalSnapshotWriter,
    *,
    range_id: str,
    source_key: str,
    payload_loader: Callable[[str, Mapping[str, Any]], Mapping[str, Any]] | None = None,
) -> None:
    seen_videos: set[str] = set()
    expected_page_count: int | None = None
    expected_video_count: int | None = None
    expected_occurrence_count: int | None = None
    stream_state: dict[str, Any] | None = None
    written_occurrences = 0
    page = 1
    while expected_page_count is None or page <= expected_page_count:
        query = _source_query(
            range_id,
            page,
            SOURCE_EXPORT_VIDEO_PAGE_SIZE,
        )
        payload = dict(
            payload_loader(source_key, query)
            if payload_loader is not None
            else adapter.source_payload(connection, source_key, query)
        )
        if payload.get("found") is not True:
            raise RuntimeError(f"canonical source is missing: {range_id}/{source_key}")
        if _text(payload.get("sourceKey")) != source_key:
            raise RuntimeError(
                f"canonical source key changed: requested={source_key} "
                f"actual={_text(payload.get('sourceKey'))}"
            )
        current_detail = payload.get("record")
        if not isinstance(current_detail, Mapping):
            raise RuntimeError(f"source record is invalid: {range_id}/{source_key}")
        current_detail = dict(current_detail)
        if _text(current_detail.get("sourceDetailKey")) != source_key:
            raise RuntimeError(f"source detail key mismatch: {range_id}/{source_key}")
        if _text(current_detail.get("rangeId") or range_id) != range_id:
            raise RuntimeError(f"source range mismatch: {range_id}/{source_key}")
        page_count = _integer(payload.get("pageCount"))
        video_count = _integer(payload.get("totalVideoCount"))
        occurrence_count = _integer(payload.get("totalOccurrenceCount"))
        if page_count < 1 or _integer(payload.get("page")) != page:
            raise RuntimeError(f"source pagination is invalid: {range_id}/{source_key}/{page}")
        if _integer(payload.get("pageSize")) != SOURCE_EXPORT_VIDEO_PAGE_SIZE:
            raise RuntimeError(f"source page size changed: {range_id}/{source_key}/{page}")
        if expected_page_count is None:
            expected_page_count = page_count
            expected_video_count = video_count
            expected_occurrence_count = occurrence_count
            stream_state = writer.begin_source(source_key, range_id, current_detail)
        elif (
            page_count != expected_page_count
            or video_count != expected_video_count
            or occurrence_count != expected_occurrence_count
        ):
            raise RuntimeError(f"source totals changed inside snapshot: {range_id}/{source_key}")
        page_occurrences = current_detail.get("occurrences")
        if not isinstance(page_occurrences, list):
            raise RuntimeError(f"source occurrences are invalid: {range_id}/{source_key}/{page}")
        page_videos = {
            _text(_occurrence_value(item, "videoId", "video_id", "youtubeVideoId", "externalVideoId"))
            for item in page_occurrences
            if isinstance(item, Mapping)
        }
        if "" in page_videos:
            raise RuntimeError(f"source page contains an empty video id: {range_id}/{source_key}")
        if seen_videos.intersection(page_videos):
            raise RuntimeError(f"source video crossed page boundary: {range_id}/{source_key}")
        seen_videos.update(page_videos)
        if stream_state is None:
            raise RuntimeError(f"source stream was not initialized: {range_id}/{source_key}")
        written_occurrences += writer.add_source_occurrences(
            stream_state,
            (item for item in page_occurrences if isinstance(item, Mapping)),
        )
        # Do not retain one fully hydrated JSON page while the adapter builds
        # the next page.  Ranking pages use 200 rows, but source pages expand
        # every occurrence for each selected video and can be hundreds of MiB.
        del page_occurrences, page_videos, current_detail, payload
        page += 1
    if len(seen_videos) != expected_video_count:
        raise RuntimeError(
            f"source video total mismatch: {range_id}/{source_key} "
            f"expected={expected_video_count} actual={len(seen_videos)}"
        )
    if written_occurrences != expected_occurrence_count:
        raise RuntimeError(
            f"source occurrence total mismatch: {range_id}/{source_key} "
            f"expected={expected_occurrence_count} actual={written_occurrences}"
        )
    if stream_state is None:
        raise RuntimeError(f"source stream is absent: {range_id}/{source_key}")
    if writer.finish_source(stream_state) != written_occurrences:
        raise RuntimeError(f"source stream position mismatch: {range_id}/{source_key}")


def export_sources_from_records(
    writer: CanonicalSnapshotWriter,
    *,
    records: Sequence[Mapping[str, Any]],
    range_id: str,
    source_keys: Iterable[str],
) -> int:
    """Export a complete authoritative range with one grouping pass per view."""

    pending = {_text(value) for value in source_keys if _text(value)}
    total = len(pending)
    completed = 0
    options = adapter._query_options(_source_query(range_id, 1))
    options["q"] = ""
    for view in VIEWS:
        options["view"] = view
        groups = adapter._entity_groups(records, options)
        for group in groups:
            payload = adapter._group_payload(group, options)
            source_key = _text(payload.get("sourceDetailKey"))
            if not source_key or source_key not in pending:
                continue
            detail = dict(payload)
            detail.pop("occurrences", None)
            detail["sourceDetailKey"] = source_key
            detail["rangeId"] = range_id
            writer.add_source(
                source_key,
                range_id,
                detail,
                (value for value in group.get("occurrences", ()) if isinstance(value, Mapping)),
            )
            pending.remove(source_key)
            completed += 1
            if completed % 25 == 0:
                print(
                    f"PG_SNAPSHOT_SOURCES range={range_id} "
                    f"complete={completed} total={total}",
                    flush=True,
                )
        del groups
        gc.collect()
    if pending:
        raise RuntimeError(
            f"authoritative source keys are missing for {range_id}: "
            + ", ".join(sorted(pending)[:10])
        )
    if completed % 25:
        print(
            f"PG_SNAPSHOT_SOURCES range={range_id} "
            f"complete={completed} total={total}",
            flush=True,
        )
    return completed


def export_unaffected_parent_video_sources(
    connection: Any,
    writer: CanonicalSnapshotWriter,
    *,
    parent_revision_id: str,
    sources: Sequence[tuple[str, str]],
) -> set[str]:
    """Bulk-export immutable parent video details without per-source SQL.

    Full runtime releases intentionally do not persist video source-detail
    rows.  The ranking row is the authoritative opaque-key-to-video mapping,
    while the exact parent video and occurrences provide the detail payload.
    Overlay-affected videos are excluded by ``SnapshotSourceScope`` and keep
    using the delta-aware adapter path.
    """

    ordered = tuple(sorted({
        (_text(source_key), _text(video_id))
        for source_key, video_id in sources
        if _text(source_key) and _text(video_id)
    }))
    source_keys = [source_key for source_key, _ in ordered]
    video_ids = [video_id for _, video_id in ordered]
    if len(set(source_keys)) != len(ordered) or len(set(video_ids)) != len(ordered):
        raise RuntimeError("parent video source mapping is not one-to-one")
    for source_key, video_id in ordered:
        expected_key = adapter._stable_key("source-video", "all", video_id)
        if source_key != expected_key:
            raise RuntimeError(
                "parent video source mapping changed: "
                f"video={video_id} expected={expected_key} actual={source_key}"
            )

    completed: set[str] = set()
    for offset in range(0, len(ordered), PARENT_VIDEO_EXPORT_BATCH):
        batch = ordered[offset : offset + PARENT_VIDEO_EXPORT_BATCH]
        batch_by_video = {
            video_id: source_key for source_key, video_id in batch
        }
        batch_video_ids = sorted(batch_by_video)
        video_rows = adapter._rows(
            connection,
            """
            SELECT video_id,title,channel_name,channel_id,channel_handle,
                   channel_url,published_timestamp,payload_json
            FROM runtime_videos
            WHERE revision_id = %s AND video_id = ANY(%s)
            ORDER BY video_id
            LIMIT %s
            """,
            [parent_revision_id, batch_video_ids, len(batch_video_ids) + 1],
        )
        video_by_id = {
            _text(row.get("video_id")): dict(row)
            for row in video_rows
            if _text(row.get("video_id"))
        }
        if set(video_by_id) != set(batch_video_ids):
            missing = sorted(set(batch_video_ids) - set(video_by_id))
            extra = sorted(set(video_by_id) - set(batch_video_ids))
            raise RuntimeError(
                "parent video source lookup changed: "
                f"missing={missing[:3]} extra={extra[:3]}"
            )

        current_video_id = ""
        current_occurrences: list[dict[str, Any]] = []

        def flush_video() -> None:
            nonlocal current_video_id, current_occurrences
            if not current_video_id:
                return
            video_row = video_by_id[current_video_id]
            video = _json_object(video_row.get("payload_json"))
            for public_name, column_name in (
                ("videoId", "video_id"),
                ("title", "title"),
                ("channelName", "channel_name"),
                ("channelId", "channel_id"),
                ("channelHandle", "channel_handle"),
                ("channelUrl", "channel_url"),
                ("publishedAt", "published_timestamp"),
            ):
                if video.get(public_name) is None:
                    video[public_name] = video_row.get(column_name)
            video["videoId"] = video.get("videoId") or current_video_id
            record = {
                "video": video,
                "occurrences": tuple(current_occurrences),
            }
            options = adapter._query_options({
                "range": "all",
                "view": "videos",
                "metric": "occurrences",
                "page": "1",
                "pageSize": "200",
            })
            groups = adapter._entity_groups((record,), options)
            if len(groups) != 1:
                raise RuntimeError(
                    f"parent video source is empty: {current_video_id}"
                )
            detail = adapter._group_payload(groups[0], options)
            source_key = batch_by_video[current_video_id]
            if _text(detail.get("sourceDetailKey")) != source_key:
                raise RuntimeError(
                    f"parent video source key changed: {current_video_id}"
                )
            occurrences = detail.pop("occurrences", None)
            if not isinstance(occurrences, list) or not occurrences:
                raise RuntimeError(
                    f"parent video source has no occurrences: {current_video_id}"
                )
            detail["rangeId"] = "all"
            writer.add_source(source_key, "all", detail, occurrences)
            completed.add(source_key)
            current_video_id = ""
            current_occurrences = []

        for row in _stream_pg_rows(
            connection,
            f"parent_video_occurrences_{offset // PARENT_VIDEO_EXPORT_BATCH}",
            """
            SELECT occurrence_id,range_id,video_id,song_key,seconds,
                   source_system,source_id,title,artist,payload_json
            FROM runtime_occurrences
            WHERE revision_id = %s AND video_id = ANY(%s)
              AND range_id = ANY(%s)
            ORDER BY video_id,range_id,occurrence_id
            LIMIT %s
            """,
            [
                parent_revision_id,
                batch_video_ids,
                ["all", ""],
                MAX_SOURCE_SCOPE_ROWS + 1,
            ],
        ):
            video_id = _text(row.get("video_id"))
            if video_id not in batch_by_video:
                raise RuntimeError(
                    f"parent video occurrence escaped scope: {video_id}"
                )
            if current_video_id and video_id != current_video_id:
                flush_video()
            if not current_video_id:
                current_video_id = video_id
            occurrence = _json_object(row.get("payload_json"))
            for public_name, column_name in (
                ("occurrenceId", "occurrence_id"),
                ("rangeId", "range_id"),
                ("songKey", "song_key"),
                ("seconds", "seconds"),
                ("title", "title"),
                ("artist", "artist"),
                ("sourceId", "source_id"),
                ("sourceSystem", "source_system"),
            ):
                if occurrence.get(public_name) is None:
                    occurrence[public_name] = row.get(column_name)
            occurrence["videoId"] = occurrence.get("videoId") or video_id
            occurrence["position"] = occurrence.get(
                "position", len(current_occurrences),
            )
            current_occurrences.append(occurrence)
        flush_video()
        batch_completed = {
            source_key for source_key, _ in batch if source_key in completed
        }
        if len(batch_completed) != len(batch):
            missing = sorted(set(source_key for source_key, _ in batch) - completed)
            raise RuntimeError(
                "parent video sources have no all-range occurrences: "
                + ", ".join(missing[:3])
            )
        if len(completed) % 1_000 < len(batch):
            print(
                "PG_SNAPSHOT_PARENT_VIDEO_SOURCES "
                f"complete={len(completed)} total={len(ordered)}",
                flush=True,
            )
        video_rows = None
        video_by_id = None
        current_occurrences = []
        gc.collect()
    if len(completed) != len(ordered):
        raise RuntimeError("parent video source bulk export is incomplete")
    if len(completed) % 1_000:
        print(
            "PG_SNAPSHOT_PARENT_VIDEO_SOURCES "
            f"complete={len(completed)} total={len(ordered)}",
            flush=True,
        )
    return completed


class SnapshotPageBuilder:
    def __init__(self, connection: Any):
        self.connection = connection
        self.runtime = None
        self.generic_runtime = None
        self.parent = None
        self.overlay_ids: tuple[str, ...] = ()
        self.authoritative_ids: tuple[str, ...] = ()
        self.authoritative_records = None
        # One builder owns one repeatable-read snapshot and one active
        # revision.  Reuse exact affected-group scalars across metric/scope
        # combinations without leaking state into online requests or later
        # releases.
        self.reconciliation_counts: dict[
            tuple[str, str, str, str, str], tuple[int, int, int]
        ] = {}
        self.snapshot_reset_changes: dict[
            tuple[str, str, str, tuple[str, ...]], list[dict[str, Any]]
        ] = {}
        self.snapshot_original_group_counts: dict[
            tuple[str, str, str, tuple[str, ...]], Mapping[tuple[str, str, str], int]
        ] = {}
        # Physical source/detail consistency is immutable within this one
        # repeatable-read snapshot.  Cache only the two verified integers per
        # parent source; online requests do not receive this cache.
        self.snapshot_vtuber_source_totals: dict[
            tuple[str, str, str], tuple[int, int]
        ] = {}

        runtime_probe = getattr(adapter, "_runtime_projection_revision", None)
        if callable(runtime_probe):
            self.runtime = runtime_probe(connection)
        if self.runtime:
            return
        generic_probe = getattr(adapter, "_generic_runtime_projection_revision", None)
        if not callable(generic_probe):
            return
        self.generic_runtime = generic_probe(connection)
        if not self.generic_runtime:
            return
        revision_id, revision = self.generic_runtime
        self.parent = adapter._generic_parent_runtime_revision(
            connection,
            revision_id,
            revision,
        )
        if not self.parent:
            raise RuntimeError("active incremental revision has no full runtime parent")
        self.overlay_ids = tuple(
            adapter._overlay_revision_ids(connection, revision_id, self.parent[0])
        )
        self.authoritative_ids = tuple(
            adapter._authoritative_7d_overlay_ids(connection, self.overlay_ids)
        )

    def prepare_source_scope(
        self,
        sqlite_connection: sqlite3.Connection,
        source_keys: Iterable[str],
    ) -> SnapshotSourceScope | None:
        if not self.generic_runtime or not self.parent or not self.overlay_ids:
            return None
        return build_snapshot_source_scope(
            self.connection,
            sqlite_connection,
            overlay_revision_ids=self.overlay_ids,
            source_revision_ids=(*self.overlay_ids, self.parent[0]),
            requested_keys=source_keys,
        )

    def source_payload(
        self,
        source_key: str,
        query: Mapping[str, Any],
        video_scope: Sequence[str] | None,
    ) -> Mapping[str, Any]:
        return adapter.source_payload(
            self.connection,
            source_key,
            query,
            snapshot_context=self,
            snapshot_video_scope=video_scope,
        )

    def build_combo(
        self,
        range_id: str,
        view: str,
        metric: str,
        scope_key: str = "all",
    ) -> Callable[[int], Mapping[str, Any]]:
        if not self.generic_runtime:
            return lambda page: adapter.rankings_payload(
                self.connection,
                ranking_query(range_id, view, metric, page, scope_key),
            )

        revision_id, revision = self.generic_runtime
        if range_id == "7d" and self.authoritative_ids:
            if self.authoritative_records is None:
                self.authoritative_records = tuple(
                    adapter._authoritative_7d_records(self.connection, self.overlay_ids)
                )
            records = self.authoritative_records
            return lambda page: adapter.rankings_payload_from_records(
                records,
                ranking_query(range_id, view, metric, page, scope_key),
            )

        first_query = ranking_query(range_id, view, metric, 1, scope_key)
        options = adapter._query_options(first_query)
        prepared = adapter._prepare_generic_overlay_rankings(
            self.connection,
            revision_id,
            self.parent,
            options,
            reconciliation_counts=self.reconciliation_counts,
            snapshot_reset_changes=self.snapshot_reset_changes,
            snapshot_original_group_counts=self.snapshot_original_group_counts,
            snapshot_vtuber_source_totals=self.snapshot_vtuber_source_totals,
        )

        def render(page: int) -> Mapping[str, Any]:
            response = adapter._render_generic_overlay_rankings(
                self.connection,
                revision_id,
                prepared,
                ranking_query(range_id, view, metric, page, scope_key),
                preview_hydration_limit=adapter.MAX_RANKING_PREVIEW_VIDEOS,
            )
            return adapter._project_generic_overlay_video_records(
                self.connection,
                self.overlay_ids,
                response,
                view=view,
            )

        return render


def begin_snapshot(connection: Any) -> None:
    connection.autocommit = False
    cursor = connection.cursor()
    try:
        cursor.execute("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
    finally:
        cursor.close()


def materialize(
    output_root: Path,
    meta_output: Path,
    snapshot_output: Path,
    expected_revision: str,
) -> dict[str, Any]:
    output_root.mkdir(parents=True, exist_ok=True)
    if any(output_root.iterdir()):
        raise RuntimeError(f"output directory is not empty: {output_root}")
    if meta_output.exists():
        raise FileExistsError(meta_output)
    if snapshot_output.exists():
        raise FileExistsError(snapshot_output)
    meta_output.parent.mkdir(parents=True, exist_ok=True)

    connection = adapter.connect_from_env()
    writer: CanonicalSnapshotWriter | None = None
    snapshot_finished = False
    try:
        begin_snapshot(connection)
        before = canonical_meta(adapter.meta_payload(connection))
        if before["active_revision_id"] != expected_revision:
            raise RuntimeError(
                "active revision changed before snapshot: "
                f"expected={expected_revision} actual={before['active_revision_id']}"
            )
        print(
            f"PG_SNAPSHOT_BEGIN revision={before['active_revision_id']} "
            f"content={before['content_sha256']}",
            flush=True,
        )

        builder = SnapshotPageBuilder(connection)
        writer = CanonicalSnapshotWriter(snapshot_output)
        written = 0
        static_page_cache_drop_attempts = 0
        static_page_cache_drop_count = 0
        scope_counts: dict[str, int] = {}
        source_keys: dict[str, set[str]] = {range_id: set() for range_id in RANGES}
        scoped_source_keys: dict[str, set[str]] = {range_id: set() for range_id in RANGES}
        for range_id in RANGES:
            for view in VIEWS:
                for metric in METRICS:
                    for scope_key, _niche, _hidden in SCOPES:
                        render = builder.build_combo(range_id, view, metric, scope_key)
                        first = dict(render(1))
                        total, page_count = validate_page(
                            first,
                            range_id=range_id,
                            view=view,
                            metric=metric,
                            page=1,
                        )
                        if scope_key == "all" and total <= 0:
                            raise RuntimeError(
                                f"required ranking series missing or empty: "
                                f"{range_id}/{view}/{metric}"
                            )
                        db_metric = "count" if metric == "occurrences" else metric
                        series_key = f"{range_id}/{view}/{db_metric}/{scope_key}"
                        scope_counts[series_key] = total
                        target_dir = output_root / "rankings" / range_id / view / metric
                        if scope_key == "all":
                            target_dir.mkdir(parents=True, exist_ok=True)
                        for page in range(1, page_count + 1):
                            payload = first if page == 1 else dict(render(page))
                            validate_page(
                                payload,
                                range_id=range_id,
                                view=view,
                                metric=metric,
                                page=page,
                                expected_total=total,
                            )
                            records = payload.get("records")
                            if not isinstance(records, list):
                                raise RuntimeError(
                                    f"ranking records are invalid: {series_key}/{page}"
                                )
                            for index, raw in enumerate(records, start=1):
                                if not isinstance(raw, Mapping):
                                    raise RuntimeError(
                                        f"ranking record is not an object: "
                                        f"{series_key}/{page}/{index}"
                                    )
                            compact_records = adapter.compact_ranking_payloads(
                                [dict(record) for record in records],
                                view,
                            )
                            if len(compact_records) != len(records):
                                raise RuntimeError(
                                    f"ranking compact projection is invalid: {series_key}/{page}"
                                )
                            for index, (raw, compact_raw) in enumerate(
                                zip(records, compact_records),
                                start=1,
                            ):
                                if not isinstance(compact_raw, Mapping):
                                    raise RuntimeError(
                                        f"compact ranking record is not an object: {series_key}/{page}/{index}"
                                    )
                                expected_rank = (page - 1) * PAGE_SIZE + index
                                writer.add_ranking(_ranking_row(
                                    raw,
                                    payload_record=compact_raw,
                                    range_id=range_id,
                                    view=view,
                                    metric=metric,
                                    scope_key=scope_key,
                                    expected_rank=expected_rank,
                                ))
                                detail_key = _text(raw.get("sourceDetailKey"))
                                if detail_key:
                                    scoped_source_keys[range_id].add(detail_key)
                                    if scope_key == "all":
                                        source_keys[range_id].add(detail_key)
                            if scope_key == "all":
                                compact_payload = dict(payload)
                                compact_payload["records"] = compact_records
                                compact_payload["compact"] = True
                                target = target_dir / f"page-{page:04d}.json"
                                static_page_cache_drop_attempts += 1
                                static_page_cache_drop_count += int(
                                    _write_json_file_and_drop_cache(
                                        target,
                                        compact_payload,
                                    )
                                )
                                written += 1
                                if written % 25 == 0:
                                    print(
                                        f"PG_SNAPSHOT_WRITTEN files={written} "
                                        f"page_cache_drops={static_page_cache_drop_count}/"
                                        f"{static_page_cache_drop_attempts}",
                                        flush=True,
                                    )
                                compact_payload = None
                            del compact_records
                        print(
                            f"PG_SNAPSHOT_COMBO {range_id}/{view}/{metric}/{scope_key} "
                            f"total={total} pages={page_count}",
                            flush=True,
                        )
                        # The render closure owns the page-independent aggregate,
                        # which can contain tens of thousands of Python objects.
                        # Drop every page-local reference before trimming the
                        # allocator so the next one of 96 combinations cannot
                        # accumulate idle heap or push a shared VPS into swap.
                        render = None
                        first = None
                        payload = None
                        records = None
                        compact_payload = None
                        raw = None
                        compact_raw = None
                        _release_ranking_combo_memory(
                            range_id=range_id,
                            view=view,
                            metric=metric,
                            scope_key=scope_key,
                        )

        for range_id in RANGES:
            missing = sorted(scoped_source_keys[range_id] - source_keys[range_id])
            if missing:
                raise RuntimeError(
                    f"filtered ranking introduced unknown source keys for {range_id}: "
                    + ", ".join(missing[:10])
                )
            if not source_keys[range_id]:
                raise RuntimeError(f"ranking snapshot has no canonical source keys for {range_id}")
        scoped_source_keys.clear()
        _release_materializer_memory(writer, builder, phase="rankings")
        bulk_exported_ranges: set[str] = set()
        if (
            getattr(builder, "authoritative_ids", ())
            and getattr(builder, "authoritative_records", None) is not None
            and source_keys["7d"]
        ):
            export_sources_from_records(
                writer,
                records=getattr(builder, "authoritative_records"),
                range_id="7d",
                source_keys=source_keys["7d"],
            )
            bulk_exported_ranges.add("7d")
        _release_materializer_memory(
            writer,
            builder,
            phase="authoritative-sources",
            drop_authoritative=True,
        )

        prepare_source_scope = getattr(builder, "prepare_source_scope", None)
        source_scope = (
            prepare_source_scope(writer.connection, source_keys["all"])
            if callable(prepare_source_scope)
            else None
        )
        source_scope_stats = source_scope.stats() if source_scope is not None else {
            "videos": 0, "pairs": 0, "sources": 0, "targets": 0,
        }
        bulk_exported_source_keys: dict[str, set[str]] = {
            range_id: set() for range_id in RANGES
        }
        if source_scope is not None and getattr(builder, "parent", None):
            parent_video_sources = source_scope.unaffected_parent_video_sources()
            if parent_video_sources:
                exported_parent_videos = export_unaffected_parent_video_sources(
                    connection,
                    writer,
                    parent_revision_id=builder.parent[0],
                    sources=parent_video_sources,
                )
                if not exported_parent_videos.issubset(source_keys["all"]):
                    raise RuntimeError(
                        "parent video bulk export introduced an unknown source key"
                    )
                bulk_exported_source_keys["all"].update(
                    exported_parent_videos,
                )
            parent_video_sources = ()
        _release_materializer_memory(writer, builder, phase="source-scope")
        scoped_payload_loader = getattr(builder, "source_payload", None)
        for range_id in RANGES:
            if range_id in bulk_exported_ranges:
                continue
            pending_source_keys = sorted(
                source_keys[range_id] - bulk_exported_source_keys[range_id]
            )
            for index, source_key in enumerate(pending_source_keys, start=1):
                video_scope = (
                    source_scope.videos_for_source(source_key)
                    if source_scope is not None and range_id == "all"
                    else None
                )
                export_source(
                    connection,
                    writer,
                    range_id=range_id,
                    source_key=source_key,
                    payload_loader=(
                        lambda key, query, current_scope=video_scope: builder.source_payload(
                            key, query, current_scope,
                        )
                        if callable(scoped_payload_loader)
                        else adapter.source_payload(connection, key, query)
                    ),
                )
                del video_scope
                if index % 25 == 0:
                    print(
                        f"PG_SNAPSHOT_SOURCES range={range_id} "
                        f"complete={index} total={len(pending_source_keys)}",
                        flush=True,
                    )
                    _release_materializer_memory(
                        writer,
                        builder,
                        phase=f"sources-{range_id}-{index}",
                    )
            if len(pending_source_keys) % 25:
                print(
                    f"PG_SNAPSHOT_SOURCES range={range_id} "
                    f"complete={len(pending_source_keys)} "
                    f"total={len(pending_source_keys)}",
                    flush=True,
                )
            pending_source_keys = []

        after = canonical_meta(adapter.meta_payload(connection))
        for name in ("active_revision_id", "content_sha256", "source_commit_sha"):
            if after[name] != before[name]:
                raise RuntimeError(f"snapshot meta changed inside transaction: {name}")

        range_rows = writer.connection.execute("""
            SELECT range_id,count(*),coalesce(sum(occurrence_count),0)
            FROM (
              SELECT detail.range_id,detail.source_key,count(occurrence.position) AS occurrence_count
              FROM source_details AS detail
              LEFT JOIN source_occurrences AS occurrence
                ON occurrence.range_id=detail.range_id
               AND occurrence.source_key=detail.source_key
              GROUP BY detail.range_id,detail.source_key
            )
            GROUP BY range_id ORDER BY range_id
        """).fetchall()
        range_stats = {
            str(row[0]): {"details": int(row[1]), "occurrences": int(row[2])}
            for row in range_rows
        }
        for range_id in RANGES:
            stats = range_stats.get(range_id)
            if not stats or stats["details"] <= 0 or stats["occurrences"] <= 0:
                raise RuntimeError(f"canonical source range is absent or empty: {range_id}")

        writer.add_meta({
            **before,
            "canonical_source_key": "copied-from-source-details",
            "ranking_scope_counts_json": _json_text(scope_counts),
            "ranking_scope_series": len(scope_counts),
            "source_ranges_json": _json_text(range_stats),
            "source_overlay_scope_json": _json_text(source_scope_stats),
        })
        snapshot_stats = writer.finish()
        snapshot_finished = True
        marker = {
            **before,
            "page_files": written,
            "ranking_scope_series": len(scope_counts),
            "ranking_scope_counts": scope_counts,
            "source_ranges": range_stats,
            "source_overlay_scope": source_scope_stats,
            **snapshot_stats,
        }
        meta_output.write_text(
            json.dumps(marker, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )
        connection.rollback()
        print(
            f"PG_SNAPSHOT_DONE files={written} ranking_rows={snapshot_stats['ranking_rows']} "
            f"source_details={snapshot_stats['source_details']} "
            f"source_occurrences={snapshot_stats['source_occurrences']} "
            f"revision={expected_revision}",
            flush=True,
        )
        return marker
    except BaseException:
        if writer is not None and not snapshot_finished:
            writer.abort()
        snapshot_output.unlink(missing_ok=True)
        meta_output.unlink(missing_ok=True)
        try:
            connection.rollback()
        except Exception:
            pass
        raise
    finally:
        connection.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--meta-output", required=True, type=Path)
    parser.add_argument("--snapshot-output", required=True, type=Path)
    parser.add_argument("--expected-revision", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    materialize(
        args.output,
        args.meta_output,
        args.snapshot_output,
        args.expected_revision,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
